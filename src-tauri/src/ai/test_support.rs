//! MOCKED Ollama for tests: a tiny hand-rolled HTTP/1.1 server on 127.0.0.1.
//!
//! Each test describes how the server answers with a handler
//! `Fn(&MockRequest) -> MockResponse`. Streaming responses are a list of
//! [`Step`]s written as separate HTTP chunks with optional pauses, so tests can
//! split NDJSON lines across TCP writes, stall (idle timeouts), or hold the
//! connection open until the client disconnects (cancellation). The server
//! records every request and counts client disconnects.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use url::Url;

use super::config::AiConfig;

/// A request received by the mock.
#[derive(Debug, Clone)]
pub struct MockRequest {
    pub method: String,
    pub path: String,
    pub body: Vec<u8>,
}

impl MockRequest {
    /// The body parsed as JSON (`Null` when empty or invalid).
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

/// One step of a streamed (chunked) response.
#[derive(Debug, Clone)]
pub enum Step {
    /// Write these bytes as one HTTP chunk.
    Write(Vec<u8>),
    /// Wait before the next step.
    Sleep(Duration),
    /// Stop writing and keep the connection open until the client closes it.
    Hold,
}

/// An NDJSON line (the value plus `\n`) as one chunk.
pub fn line(value: Value) -> Step {
    let mut bytes = serde_json::to_vec(&value).expect("JSON value serializes");
    bytes.push(b'\n');
    Step::Write(bytes)
}

/// Arbitrary bytes as one chunk (e.g. half a line).
pub fn raw(text: &str) -> Step {
    Step::Write(text.as_bytes().to_vec())
}

/// A pause of `ms` milliseconds.
pub fn pause(ms: u64) -> Step {
    Step::Sleep(Duration::from_millis(ms))
}

/// How the mock answers one request.
#[derive(Debug, Clone)]
pub enum MockResponse {
    /// A complete response with a `Content-Length`.
    Fixed { status: u16, content_type: &'static str, body: Vec<u8> },
    /// A `200` NDJSON response with `Transfer-Encoding: chunked`.
    Stream(Vec<Step>),
    /// Read the request, then never answer (until the client gives up).
    Hang,
    /// An HTTP redirect (e.g. `307`) to `location`, with an empty body.
    Redirect { status: u16, location: String },
}

impl MockResponse {
    pub fn json(status: u16, value: Value) -> Self {
        let body = serde_json::to_vec(&value).expect("JSON value serializes");
        Self::Fixed { status, content_type: "application/json; charset=utf-8", body }
    }

    pub fn text(status: u16, text: &str) -> Self {
        Self::Fixed { status, content_type: "text/plain", body: text.as_bytes().to_vec() }
    }

    pub fn ndjson(steps: Vec<Step>) -> Self {
        Self::Stream(steps)
    }
}

type Handler = dyn Fn(&MockRequest) -> MockResponse + Send + Sync;

/// A running mock server. Stops when dropped.
pub struct MockOllama {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<MockRequest>>>,
    disconnects: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl MockOllama {
    /// Starts a server on a free loopback port.
    pub async fn start(handler: impl Fn(&MockRequest) -> MockResponse + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock server");
        let addr = listener.local_addr().expect("mock server address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let disconnects = Arc::new(AtomicUsize::new(0));
        let handler: Arc<Handler> = Arc::new(handler);
        let task = {
            let requests = Arc::clone(&requests);
            let disconnects = Arc::clone(&disconnects);
            tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else { return };
                    let (handler, requests, disconnects) =
                        (Arc::clone(&handler), Arc::clone(&requests), Arc::clone(&disconnects));
                    tokio::spawn(async move {
                        serve(socket, handler, requests, disconnects).await;
                    });
                }
            })
        };
        Self { addr, requests, disconnects, task }
    }

    /// `http://127.0.0.1:<port>/`
    pub fn base_url(&self) -> Url {
        Url::parse(&format!("http://{}/", self.addr)).expect("mock URL is valid")
    }

    /// A config pointing at this server with a short (2 s) timeout.
    pub fn config(&self) -> AiConfig {
        AiConfig { base_url: self.base_url(), timeout: Duration::from_secs(2), ..AiConfig::default() }
    }

    /// Every request received so far.
    pub fn requests(&self) -> Vec<MockRequest> {
        self.requests.lock().unwrap().clone()
    }

    /// The requests received for `path`, e.g. `/api/chat`.
    pub fn requests_to(&self, path: &str) -> Vec<MockRequest> {
        self.requests().into_iter().filter(|request| request.path == path).collect()
    }

    /// Waits until a client has closed a held or streaming connection.
    pub async fn wait_for_disconnect(&self, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        while tokio::time::Instant::now() < deadline {
            if self.disconnects.load(Ordering::SeqCst) > 0 {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }
}

impl Drop for MockOllama {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A loopback URL where nothing listens (the port was just freed).
pub async fn unused_base_url() -> Url {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind probe");
    let addr = listener.local_addr().expect("probe address");
    drop(listener);
    Url::parse(&format!("http://{addr}/")).expect("URL is valid")
}

/// Handles one connection: one request, one response, then close.
async fn serve(
    mut socket: TcpStream,
    handler: Arc<Handler>,
    requests: Arc<Mutex<Vec<MockRequest>>>,
    disconnects: Arc<AtomicUsize>,
) {
    let Some(request) = read_request(&mut socket).await else { return };
    let response = handler(&request);
    requests.lock().unwrap().push(request);

    let disconnected = match response {
        MockResponse::Fixed { status, content_type, body } => {
            let head = format!(
                "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reason(status),
                body.len()
            );
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(&body).await;
            let _ = socket.shutdown().await;
            false
        }
        MockResponse::Redirect { status, location } => {
            let head = format!(
                "HTTP/1.1 {status} {}\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                reason(status)
            );
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.shutdown().await;
            false
        }
        MockResponse::Hang => wait_for_close(&mut socket).await,
        MockResponse::Stream(steps) => stream(&mut socket, steps).await,
    };
    if disconnected {
        disconnects.fetch_add(1, Ordering::SeqCst);
    }
}

/// Writes a chunked NDJSON response. Returns whether the client disconnected early.
async fn stream(socket: &mut TcpStream, steps: Vec<Step>) -> bool {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
    if socket.write_all(head.as_bytes()).await.is_err() {
        return true;
    }
    for step in steps {
        match step {
            Step::Write(bytes) => {
                let mut chunk = format!("{:x}\r\n", bytes.len()).into_bytes();
                chunk.extend_from_slice(&bytes);
                chunk.extend_from_slice(b"\r\n");
                if socket.write_all(&chunk).await.is_err() || socket.flush().await.is_err() {
                    return true;
                }
            }
            Step::Sleep(duration) => tokio::time::sleep(duration).await,
            Step::Hold => return wait_for_close(socket).await,
        }
    }
    let _ = socket.write_all(b"0\r\n\r\n").await;
    let _ = socket.shutdown().await;
    false
}

/// Blocks until the client closes the connection. Always returns `true`.
async fn wait_for_close(socket: &mut TcpStream) -> bool {
    let mut scratch = [0u8; 1024];
    loop {
        match socket.read(&mut scratch).await {
            Ok(0) | Err(_) => return true,
            Ok(_) => {}
        }
    }
}

/// Reads one HTTP/1.1 request (headers plus a `Content-Length` body).
async fn read_request(socket: &mut TcpStream) -> Option<MockRequest> {
    let mut buffer = Vec::new();
    let mut scratch = [0u8; 8192];
    let header_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        let read = socket.read(&mut scratch).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&scratch[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.lines();
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?.to_owned();
    let path = request_line.next()?.to_owned();
    let content_length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);

    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = socket.read(&mut scratch).await.ok()?;
        if read == 0 {
            return None;
        }
        body.extend_from_slice(&scratch[..read]);
    }
    body.truncate(content_length);
    Some(MockRequest { method, path, body })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}
