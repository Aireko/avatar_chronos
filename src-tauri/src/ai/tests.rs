//! Tests of [`AiService`] end to end over HTTP.
//!
//! Every test named `mocked_*` runs against the MOCKED Ollama in
//! `test_support.rs`; none of them needs Ollama installed. The single
//! `real_ollama_*` test is `#[ignore]`d and talks to a real local Ollama only
//! when `OLLAMA_SMOKE_TEST=1` (it never pulls a model).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::config::AiConfig;
use super::error::AiErrorKind;
use super::service::AiService;
use super::test_support::{MockOllama, MockRequest, MockResponse, Step, line, pause, raw, unused_base_url};
use super::types::{GenerateRequest, GenerationOptions, PullEvent, StreamEvent};

/// Upper bound for any single awaited operation, so a bug fails instead of hanging.
const TEST_LIMIT: Duration = Duration::from_secs(10);

fn prompt(text: &str) -> GenerateRequest {
    GenerateRequest { prompt: text.into(), ..Default::default() }
}

fn with_id(id: &str, text: &str) -> GenerateRequest {
    GenerateRequest { request_id: Some(id.into()), ..prompt(text) }
}

fn installed() -> bool {
    true
}

fn not_installed() -> bool {
    false
}

fn service(mock: &MockOllama) -> AiService {
    AiService::with_install_probe(mock.config(), installed)
}

fn tags_body() -> Value {
    json!({ "models": [
        { "name": "qwen3.5:9b", "model": "qwen3.5:9b", "modified_at": "2026-11-13T04:53:56-06:00", "size": 6_550_825_550u64,
          "digest": "56671c2a", "details": { "family": "qwen35", "parameter_size": "9.0B", "quantization_level": "Q4_K_M", "context_length": 262_144 },
          "capabilities": ["completion", "vision", "tools", "thinking"] },
        { "name": "gemma3:1b", "model": "gemma3:1b", "size": 815_000_000u64, "details": { "family": "gemma3", "parameter_size": "1.0B" } },
        { "name": "qwen3.5:cloud", "model": "qwen3.5:cloud", "size": 384, "remote_model": "qwen3.5", "remote_host": "https://ollama.com", "details": {} },
        { "name": "qwen3.5:397b-cloud", "model": "qwen3.5:397b-cloud", "size": 384, "details": {} },
    ] })
}

/// A typical Ollama: version, tags (with qwen3.5:9b installed), ps, show.
fn standard_routes(request: &MockRequest) -> MockResponse {
    match request.path.as_str() {
        "/api/version" => MockResponse::json(200, json!({ "version": "0.40.16" })),
        "/api/tags" => MockResponse::json(200, tags_body()),
        "/api/ps" => {
            MockResponse::json(200, json!({ "models": [{ "name": "qwen3.5:9b", "size_vram": 1_661_783_243u64 }] }))
        }
        _ => MockResponse::text(404, "404 page not found"),
    }
}

fn done_line(extra: Value) -> Step {
    let mut done = json!({
        "model": "qwen3.5:9b", "message": { "role": "assistant", "content": "" }, "done": true, "done_reason": "stop",
        "total_duration": 5_130_446_700u64, "load_duration": 12_101_400u64, "prompt_eval_count": 19,
        "prompt_eval_duration": 1_398_479_000u64, "eval_count": 15, "eval_duration": 3_684_411_000u64,
    });
    if let (Value::Object(done), Value::Object(extra)) = (&mut done, extra) {
        done.extend(extra);
    }
    line(done)
}

fn delta_line(content: &str) -> Step {
    line(json!({ "model": "qwen3.5:9b", "message": { "role": "assistant", "content": content }, "done": false }))
}

/// Runs `generate_stream` in a task, forwarding events to the returned receiver.
fn spawn_stream(
    service: &AiService,
    request: GenerateRequest,
) -> (tokio::task::JoinHandle<Result<super::GenerateResponse, super::AiError>>, mpsc::UnboundedReceiver<StreamEvent>) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let service = service.clone();
    let task = tokio::spawn(async move {
        service
            .generate_stream(request, move |event| {
                let _ = sender.send(event);
            })
            .await
    });
    (task, receiver)
}

async fn next_event(events: &mut mpsc::UnboundedReceiver<StreamEvent>) -> StreamEvent {
    tokio::time::timeout(TEST_LIMIT, events.recv()).await.expect("event in time").expect("channel open")
}

fn collect_stream_events() -> (Arc<Mutex<Vec<StreamEvent>>>, impl FnMut(StreamEvent)) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    (events, move |event| sink.lock().unwrap().push(event))
}

// ---- connection ----

#[tokio::test]
async fn mocked_connection_success() {
    let mock = MockOllama::start(standard_routes).await;
    let status = service(&mock).check_connection().await.unwrap();
    assert!(status.reachable);
    assert_eq!(status.version.as_deref(), Some("0.40.16"));
    assert_eq!(status.installed, Some(true));
    assert!(status.is_local);
    assert_eq!(status.base_url, mock.base_url().as_str().trim_end_matches('/'));
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        json!({ "reachable": true, "version": "0.40.16", "installed": true, "baseUrl": status.base_url, "isLocal": true })
    );
    assert!(status.error.is_none());
    assert_eq!(mock.requests_to("/api/version")[0].method, "GET");
}

#[tokio::test]
async fn mocked_connection_failure_reports_not_installed_or_unreachable() {
    let config = AiConfig { base_url: unused_base_url().await, ..AiConfig::default() };

    let status = AiService::with_install_probe(config.clone(), not_installed).check_connection().await.unwrap();
    assert!(!status.reachable);
    assert_eq!(status.installed, Some(false));
    let error = status.error.unwrap();
    assert_eq!(error.kind, AiErrorKind::OllamaNotInstalled);
    assert!(error.hint.unwrap().contains("https://ollama.com/download"));

    let service = AiService::with_install_probe(config, installed);
    let status = service.check_connection().await.unwrap();
    assert_eq!(status.installed, Some(true));
    let error = status.error.unwrap();
    assert_eq!(error.kind, AiErrorKind::OllamaUnreachable);
    assert!(error.hint.unwrap().contains("ollama serve"));

    // Other calls classify the failure the same way.
    assert_eq!(service.list_models().await.unwrap_err().kind, AiErrorKind::OllamaUnreachable);
    assert_eq!(service.generate(prompt("hi")).await.unwrap_err().kind, AiErrorKind::OllamaUnreachable);

    let status = service.status().await;
    assert!(!status.connection.reachable);
    assert_eq!(status.selected_model_installed, None);
}

// ---- models ----

#[tokio::test]
async fn mocked_list_models_flags_qwen35_and_cloud() {
    let mock = MockOllama::start(standard_routes).await;
    let models = service(&mock).list_models().await.unwrap();
    let flags: Vec<(&str, bool, bool)> = models.iter().map(|m| (m.name.as_str(), m.is_qwen35, m.is_cloud)).collect();
    assert_eq!(
        flags,
        [
            ("qwen3.5:9b", true, false),
            ("gemma3:1b", false, false),
            ("qwen3.5:cloud", true, true),
            ("qwen3.5:397b-cloud", true, true)
        ]
    );
    let qwen = &models[0];
    assert_eq!(qwen.size_bytes, 6_550_825_550);
    assert_eq!(qwen.parameter_size.as_deref(), Some("9.0B"));
    assert_eq!(qwen.quantization.as_deref(), Some("Q4_K_M"));
    assert_eq!(qwen.family.as_deref(), Some("qwen35"));
    assert_eq!(qwen.context_length, Some(262_144));
    assert_eq!(
        serde_json::to_value(qwen).unwrap(),
        json!({ "name": "qwen3.5:9b", "sizeBytes": 6_550_825_550u64, "parameterSize": "9.0B", "quantization": "Q4_K_M",
                "family": "qwen35", "contextLength": 262_144, "modifiedAt": "2026-11-13T04:53:56-06:00", "isQwen35": true, "isCloud": false })
    );
}

#[tokio::test]
async fn mocked_status_lists_installed_local_qwen35_models() {
    let mock = MockOllama::start(standard_routes).await;
    let status = service(&mock).status().await;
    assert!(status.connection.reachable);
    assert!(status.config_error.is_none());
    assert_eq!(status.configured_model, "qwen3.5:9b");
    assert_eq!(status.selected_model, "qwen3.5:9b");
    assert_eq!(status.selected_model_installed, Some(true));
    let names: Vec<&str> = status.installed_qwen35_models.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, ["qwen3.5:9b"], "cloud tags and other families are filtered out");
    assert_eq!(status.loaded_models, ["qwen3.5:9b"]);
    assert_eq!(status.active_generations, 0);
    assert!(status.local_only);
    assert!(!status.known_qwen35_tags.is_empty());

    let value = serde_json::to_value(&status).unwrap();
    for key in [
        "connection",
        "configuredModel",
        "selectedModel",
        "selectedModelInstalled",
        "installedQwen35Models",
        "loadedModels",
        "activeGenerations",
        "knownQwen35Tags",
        "localOnly",
    ] {
        assert!(value.get(key).is_some(), "missing {key}");
    }
    assert!(value["knownQwen35Tags"][0].get("downloadSize").is_some());
}

#[tokio::test]
async fn mocked_status_detects_a_missing_model() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/tags" => MockResponse::json(200, json!({ "models": [{ "name": "qwen3.5:4b", "size": 1 }] })),
        _ => standard_routes(request),
    })
    .await;
    let status = service(&mock).status().await;
    assert_eq!(status.selected_model_installed, Some(false));
    assert_eq!(status.installed_qwen35_models.len(), 1);
    assert_eq!(serde_json::to_value(&status).unwrap()["selectedModelInstalled"], json!(false));
}

#[tokio::test]
async fn mocked_select_model_requires_installed_local_qwen35() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/tags" => MockResponse::json(200, json!({ "models": [
            { "name": "qwen3.5:9b", "size": 1 }, { "name": "qwen3.5:4b", "size": 1 }, { "name": "gemma3:1b", "size": 1 },
            { "name": "qwen3.5:cloud", "size": 1, "remote_host": "https://ollama.com" },
        ] })),
        _ => standard_routes(request),
    })
    .await;
    let service = service(&mock);

    assert_eq!(service.select_model("qwen3.5:4b".into()).await.unwrap(), "qwen3.5:4b");
    assert_eq!(service.selected_model(), "qwen3.5:4b");

    let tags_calls = mock.requests_to("/api/tags").len();
    for (name, kind) in [
        ("gemma3:1b", AiErrorKind::UnsupportedModel),
        ("qwen3.5:cloud", AiErrorKind::UnsupportedModel),
        ("qwen3.5:397b-cloud", AiErrorKind::UnsupportedModel),
        ("qwen3.5 9b", AiErrorKind::InvalidRequest),
        ("", AiErrorKind::InvalidRequest),
    ] {
        assert_eq!(service.select_model(name.into()).await.unwrap_err().kind, kind, "{name}");
    }
    assert_eq!(mock.requests_to("/api/tags").len(), tags_calls, "rejected names never reach Ollama");

    let missing = service.select_model("qwen3.5:27b".into()).await.unwrap_err();
    assert_eq!(missing.kind, AiErrorKind::ModelNotInstalled);
    assert!(missing.hint.unwrap().contains("ollama pull qwen3.5:27b"));
    assert_eq!(service.selected_model(), "qwen3.5:4b", "a failed selection changes nothing");
}

#[tokio::test]
async fn mocked_model_info_and_missing_model() {
    let mock = MockOllama::start(|request: &MockRequest| {
        if request.path != "/api/show" {
            return standard_routes(request);
        }
        if request.json()["model"] == "qwen3.5:9b" {
            MockResponse::json(
                200,
                json!({
                    "details": { "family": "qwen35", "parameter_size": "9.0B", "quantization_level": "Q4_K_M" },
                    "model_info": { "general.architecture": "qwen35", "qwen35.context_length": 262_144 },
                    "capabilities": ["completion", "vision", "tools", "thinking"],
                    "thinking": { "values": [false, true], "default": true },
                }),
            )
        } else {
            MockResponse::json(
                404,
                json!({ "error": format!("model '{}' not found", request.json()["model"].as_str().unwrap()) }),
            )
        }
    })
    .await;
    let service = service(&mock);

    let info = service.get_model_info(None).await.unwrap();
    assert_eq!(info.name, "qwen3.5:9b");
    assert_eq!(info.context_length, Some(262_144));
    assert!(info.supports_thinking);
    assert_eq!(info.capabilities.len(), 4);
    assert_eq!(mock.requests_to("/api/show")[0].json(), json!({ "model": "qwen3.5:9b", "verbose": false }));

    let missing = service.get_model_info(Some("qwen3.5:27b".into())).await.unwrap_err();
    assert_eq!(missing.kind, AiErrorKind::ModelNotInstalled);
    assert_eq!(missing.status, Some(404));

    let shows = mock.requests_to("/api/show").len();
    for (name, kind) in [
        ("qwen3.5:cloud", AiErrorKind::UnsupportedModel),
        ("qwen3.5:397b-cloud", AiErrorKind::UnsupportedModel),
        ("gemma3:1b", AiErrorKind::UnsupportedModel),
        ("someuser/qwen3.5:9b", AiErrorKind::UnsupportedModel),
        ("bad name", AiErrorKind::InvalidRequest),
    ] {
        assert_eq!(service.get_model_info(Some(name.into())).await.unwrap_err().kind, kind, "{name}");
    }
    assert_eq!(mock.requests_to("/api/show").len(), shows, "rejected names never reach /api/show");
}

/// Tags where `qwen3.5:big` is a local-looking alias of a cloud model
/// (`ollama cp qwen3.5:397b-cloud qwen3.5:big`).
fn cloud_alias_routes(request: &MockRequest) -> MockResponse {
    match request.path.as_str() {
        "/api/tags" => MockResponse::json(200, json!({ "models": [
            { "name": "qwen3.5:9b", "size": 1 },
            { "name": "qwen3.5:big", "model": "qwen3.5:big", "size": 384, "remote_host": "https://ollama.com", "details": {} },
        ] })),
        "/api/chat" => MockResponse::json(200, json!({ "message": { "content": "sent to the cloud" }, "done": true })),
        _ => standard_routes(request),
    }
}

#[tokio::test]
async fn mocked_cloud_alias_is_rejected_as_an_explicit_model() {
    let mock = MockOllama::start(cloud_alias_routes).await;
    let service = service(&mock);
    let request = GenerateRequest { model: Some("qwen3.5:big".into()), ..prompt("x") };

    let error = service.generate(request.clone()).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::UnsupportedModel);
    assert!(error.message.contains("remote host"), "{}", error.message);

    let (events, sink) = collect_stream_events();
    let error = service.generate_stream(request, sink).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::UnsupportedModel);
    assert_eq!(events.lock().unwrap().as_slice(), [StreamEvent::Error { error }]);

    assert_eq!(service.select_model("qwen3.5:big".into()).await.unwrap_err().kind, AiErrorKind::UnsupportedModel);
    let summary = service.list_models().await.unwrap().into_iter().find(|m| m.name == "qwen3.5:big").unwrap();
    assert!(summary.is_cloud);

    assert!(mock.requests_to("/api/chat").is_empty(), "no prompt reached /api/chat");
    assert_eq!(service.registry_len(), 0);

    // The local model still works.
    assert_eq!(service.generate(prompt("x")).await.unwrap().content, "sent to the cloud");
}

#[tokio::test]
async fn mocked_cloud_alias_is_rejected_as_the_configured_model() {
    let mock = MockOllama::start(cloud_alias_routes).await;
    // OLLAMA_MODEL=qwen3.5:big passes the name-only config check.
    let config = AiConfig::from_lookup(|name| match name {
        "OLLAMA_BASE_URL" => Some(mock.base_url().to_string()),
        "OLLAMA_MODEL" => Some("qwen3.5:big".into()),
        _ => None,
    })
    .unwrap();
    let service = AiService::with_install_probe(config, installed);

    assert_eq!(service.generate(prompt("x")).await.unwrap_err().kind, AiErrorKind::UnsupportedModel);
    assert_eq!(service.generate_stream(prompt("x"), |_| {}).await.unwrap_err().kind, AiErrorKind::UnsupportedModel);
    assert!(mock.requests_to("/api/chat").is_empty(), "no prompt reached /api/chat");

    let status = service.status().await;
    assert_eq!(status.selected_model_installed, Some(false));
    let problem = status.config_error.unwrap();
    assert_eq!(problem.kind, AiErrorKind::UnsupportedModel);
    assert!(problem.message.contains("qwen3.5:big"));
}

#[tokio::test]
async fn mocked_redirects_are_not_followed() {
    let elsewhere = MockOllama::start(standard_routes).await;
    let target = format!("{}api/chat", elsewhere.base_url());
    let mock = MockOllama::start(move |request: &MockRequest| match request.path.as_str() {
        "/api/chat" => MockResponse::Redirect { status: 307, location: target.clone() },
        _ => standard_routes(request),
    })
    .await;

    let error = service(&mock).generate(prompt("secret code")).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::InferenceFailed);
    assert_eq!(error.status, Some(307));
    assert_eq!(mock.requests_to("/api/chat").len(), 1);
    assert!(elsewhere.requests().is_empty(), "the prompt was not sent to the redirect target");
}

// ---- pull ----

#[tokio::test]
async fn mocked_pull_streams_progress_until_success() {
    let mock = MockOllama::start(|_: &MockRequest| {
        MockResponse::ndjson(vec![
            line(json!({ "status": "pulling manifest" })),
            line(json!({ "status": "pulling 56671c2a", "digest": "sha256:56671c2a", "total": 200, "completed": 50 })),
            raw("{\"status\":\"pulling 56671c2a\",\"digest\":\"sha256:56671c2a\","),
            pause(20),
            raw("\"total\":200,\"completed\":200}\n{\"status\":\"verifying sha256 digest\"}\n"),
            line(json!({ "status": "writing manifest" })),
            line(json!({ "status": "success" })),
        ])
    })
    .await;
    let service = service(&mock);
    let mut events = Vec::new();
    let summary =
        service.pull_model(Some("qwen3.5:4b".into()), "pull-1".into(), |event| events.push(event)).await.unwrap();

    assert_eq!(summary.model, "qwen3.5:4b");
    assert_eq!(summary.status, "success");
    assert_eq!(mock.requests_to("/api/pull")[0].json(), json!({ "model": "qwen3.5:4b", "stream": true }));
    assert_eq!(events.first(), Some(&PullEvent::Started { request_id: "pull-1".into(), model: "qwen3.5:4b".into() }));
    assert_eq!(events.last(), Some(&PullEvent::Done { model: "qwen3.5:4b".into() }));
    let percents: Vec<Option<f64>> = events
        .iter()
        .filter_map(|event| match event {
            PullEvent::Progress { percent, .. } => Some(*percent),
            _ => None,
        })
        .collect();
    assert_eq!(percents, [None, Some(25.0), Some(100.0), None, None, None]);
    assert_eq!(service.registry_len(), 0);
}

#[tokio::test]
async fn mocked_pull_error_line_is_pull_failed() {
    let mock = MockOllama::start(|_: &MockRequest| {
        MockResponse::ndjson(vec![
            line(json!({ "status": "pulling manifest" })),
            line(json!({ "error": "pull model manifest: file does not exist" })),
        ])
    })
    .await;
    let mut events = Vec::new();
    let error = service(&mock)
        .pull_model(Some("qwen3.5:4b".into()), "pull-2".into(), |event| events.push(event))
        .await
        .unwrap_err();
    assert_eq!(error.kind, AiErrorKind::PullFailed);
    assert!(error.message.contains("file does not exist"));
    assert_eq!(events.last(), Some(&PullEvent::Error { error }));
}

#[tokio::test]
async fn mocked_pull_can_be_cancelled() {
    let mock = MockOllama::start(|_: &MockRequest| {
        MockResponse::ndjson(vec![line(json!({ "status": "pulling manifest" })), Step::Hold])
    })
    .await;
    let service = service(&mock);
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let task = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .pull_model(None, "pull-3".into(), move |event| {
                    let _ = sender.send(event);
                })
                .await
        })
    };
    // Wait for the first progress line, then cancel.
    loop {
        let event = tokio::time::timeout(TEST_LIMIT, receiver.recv()).await.unwrap().unwrap();
        if matches!(event, PullEvent::Progress { .. }) {
            break;
        }
    }
    assert!(service.cancel("pull-3"));
    let error = tokio::time::timeout(TEST_LIMIT, task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(error.kind, AiErrorKind::Cancelled);
    assert_eq!(receiver.recv().await, Some(PullEvent::Cancelled { request_id: "pull-3".into() }));
    assert_eq!(service.registry_len(), 0);
    assert!(mock.wait_for_disconnect(TEST_LIMIT).await, "cancelling closes the connection");
}

#[tokio::test]
async fn mocked_pull_only_accepts_local_qwen35_tags() {
    let mock = MockOllama::start(standard_routes).await;
    let service = service(&mock);
    for (name, kind) in [
        ("gemma3:1b", AiErrorKind::UnsupportedModel),
        ("qwen3.5:397b-cloud", AiErrorKind::UnsupportedModel),
        // Another namespace or registry host could make Ollama download anything from anywhere.
        ("someuser/qwen3.5:9b", AiErrorKind::UnsupportedModel),
        ("evil.example.com/x/qwen3.5:9b", AiErrorKind::UnsupportedModel),
        ("bad name", AiErrorKind::InvalidRequest),
    ] {
        let mut events = Vec::new();
        let error = service.pull_model(Some(name.into()), "p".into(), |event| events.push(event)).await.unwrap_err();
        assert_eq!(error.kind, kind, "{name}");
        assert!(matches!(events.as_slice(), [PullEvent::Error { .. }]));
    }
    let error = service.pull_model(None, "bad id!".into(), |_| {}).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::InvalidRequest);
    assert!(mock.requests_to("/api/pull").is_empty());
}

// ---- generation ----

#[tokio::test]
async fn mocked_generate_sends_the_right_body_and_maps_the_response() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/chat" => MockResponse::json(200, json!({
            "model": "qwen3.5:9b", "created_at": "2026-11-13T19:32:55Z",
            "message": { "role": "assistant", "content": "{\"ok\":true}", "thinking": "Let me think." },
            "done": true, "done_reason": "stop", "total_duration": 137_353_666_600u64, "load_duration": 75_711_318_500u64,
            "prompt_eval_count": 19, "prompt_eval_duration": 60_615_485_000u64, "eval_count": 4, "eval_duration": 907_249_000u64,
        })),
        _ => standard_routes(request),
    })
    .await;
    let request = GenerateRequest {
        request_id: Some("gen_1".into()),
        system: Some("You review code.".into()),
        prompt: "Say ok as JSON".into(),
        options: Some(GenerationOptions {
            temperature: Some(0.0),
            top_p: Some(0.9),
            top_k: Some(20),
            num_predict: Some(64),
            num_ctx: Some(8192),
            seed: Some(42),
            stop: Some(vec!["</end>".into()]),
            repeat_penalty: Some(1.1),
        }),
        think: Some(true),
        format: Some(json!("json")),
        ..Default::default()
    };
    let response = service(&mock).generate(request).await.unwrap();

    let chat = &mock.requests_to("/api/chat")[0];
    assert_eq!(chat.method, "POST");
    let body = chat.json();
    assert_eq!(
        body,
        json!({
            "model": "qwen3.5:9b",
            "messages": [ { "role": "system", "content": "You review code." }, { "role": "user", "content": "Say ok as JSON" } ],
            "stream": false,
            "options": { "temperature": 0.0, "top_p": 0.9, "top_k": 20, "num_predict": 64, "num_ctx": 8192, "seed": 42,
                         "stop": ["</end>"], "repeat_penalty": 1.1 },
            "think": true,
            "format": "json",
        })
    );
    assert!(body.get("keep_alive").is_none());

    assert_eq!(response.request_id, "gen_1");
    assert_eq!(response.model, "qwen3.5:9b");
    assert_eq!(response.content, "{\"ok\":true}");
    assert_eq!(response.thinking.as_deref(), Some("Let me think."));
    assert_eq!(response.done_reason.as_deref(), Some("stop"));
    assert_eq!(response.stats.total_duration_ms, Some(137_353));
    assert_eq!(response.stats.load_duration_ms, Some(75_711));
    assert_eq!(response.stats.prompt_tokens, Some(19));
    assert_eq!(response.stats.eval_tokens, Some(4));
    assert_eq!(response.stats.eval_duration_ms, Some(907));
    assert_eq!(response.stats.tokens_per_second, Some(4.41));
}

#[tokio::test]
async fn mocked_generate_minimal_body_and_schema_format() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/chat" => MockResponse::json(200, json!({ "message": { "content": "hi" }, "done": true })),
        _ => standard_routes(request),
    })
    .await;
    let service = service(&mock);
    let response = service.generate(prompt("hello")).await.unwrap();
    assert!(response.request_id.starts_with("gen-"), "an id is generated");
    assert_eq!(response.model, "qwen3.5:9b", "falls back to the requested model name");
    assert_eq!(
        mock.requests_to("/api/chat")[0].json(),
        json!({ "model": "qwen3.5:9b", "messages": [{ "role": "user", "content": "hello" }], "stream": false })
    );

    let schema = json!({ "type": "object", "properties": { "ok": { "type": "boolean" } } });
    let request = GenerateRequest { format: Some(schema.clone()), system: Some("  ".into()), ..prompt("x") };
    service.generate(request).await.unwrap();
    let body = mock.requests_to("/api/chat")[1].json();
    assert_eq!(body["format"], schema);
    assert_eq!(body["messages"].as_array().unwrap().len(), 1, "a blank system prompt is not sent");
}

#[tokio::test]
async fn mocked_stream_reassembles_lines_split_across_writes() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/chat" => MockResponse::ndjson(vec![
            line(json!({ "model": "qwen3.5:9b", "message": { "role": "assistant", "content": "", "thinking": "Hmm" }, "done": false })),
            raw("{\"model\":\"qwen3.5:9b\",\"message\":{\"role\":\"assistant\",\"content\":\"Hel"),
            pause(20),
            raw("lo\"},\"done\":false}\n{\"model\":\"qwen3.5:9b\",\"message\":{\"content\":\" wör"),
            pause(20),
            raw("ld\"},\"done\":false}\n"),
            delta_line("!"),
            done_line(json!({})),
        ]),
        _ => standard_routes(request),
    })
    .await;
    let (events, sink) = collect_stream_events();
    let response = service(&mock).generate_stream(with_id("s1", "greet"), sink).await.unwrap();

    assert_eq!(response.content, "Hello wörld!");
    assert_eq!(response.thinking.as_deref(), Some("Hmm"));
    assert_eq!(response.stats.eval_tokens, Some(15));
    assert_eq!(mock.requests_to("/api/chat")[0].json()["stream"], json!(true));

    let events = events.lock().unwrap().clone();
    assert_eq!(events[0], StreamEvent::Started { request_id: "s1".into(), model: "qwen3.5:9b".into() });
    assert_eq!(events[1], StreamEvent::Delta { content: String::new(), thinking: Some("Hmm".into()) });
    let deltas: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::Delta { content, .. } if !content.is_empty() => Some(content.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, ["Hello", " wörld", "!"]);
    assert_eq!(events.last(), Some(&StreamEvent::Done { response }));
}

#[tokio::test]
async fn mocked_stream_without_done_is_an_error() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/chat" => MockResponse::ndjson(vec![delta_line("partial")]),
        _ => standard_routes(request),
    })
    .await;
    let (events, sink) = collect_stream_events();
    let error = service(&mock).generate_stream(prompt("x"), sink).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::InferenceFailed);
    assert!(error.message.contains("ended unexpectedly"));
    assert_eq!(events.lock().unwrap().last(), Some(&StreamEvent::Error { error }));
}

#[tokio::test]
async fn mocked_mid_stream_error_lines() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/chat" if request.json()["messages"][0]["content"] == "oom" => MockResponse::ndjson(vec![
            delta_line("a"),
            line(json!({ "error": "llama runner process has terminated: CUDA error: out of memory" })),
        ]),
        "/api/chat" => MockResponse::ndjson(vec![
            delta_line("a"),
            line(json!({ "error": "an error was encountered while running the model" })),
            done_line(json!({})),
        ]),
        _ => standard_routes(request),
    })
    .await;
    let service = service(&mock);

    let (events, sink) = collect_stream_events();
    let error = service.generate_stream(prompt("x"), sink).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::InferenceFailed);
    assert!(error.message.contains("an error was encountered"));
    assert!(matches!(events.lock().unwrap().last(), Some(StreamEvent::Error { .. })));

    let error = service.generate_stream(prompt("oom"), |_| {}).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::InsufficientResources);
}

#[tokio::test]
async fn mocked_cancel_mid_stream() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/chat" => MockResponse::ndjson(vec![delta_line("first"), Step::Hold]),
        _ => standard_routes(request),
    })
    .await;
    let service = service(&mock);
    let (task, mut events) = spawn_stream(&service, with_id("cancel-me", "long story"));

    assert!(matches!(next_event(&mut events).await, StreamEvent::Started { .. }));
    assert_eq!(next_event(&mut events).await, StreamEvent::Delta { content: "first".into(), thinking: None });
    assert_eq!(service.active_generations(), 1);

    let cancelled_at = Instant::now();
    assert!(service.cancel("cancel-me"));
    let error = tokio::time::timeout(TEST_LIMIT, task).await.unwrap().unwrap().unwrap_err();
    assert!(cancelled_at.elapsed() < Duration::from_secs(1), "cancel is prompt");
    assert_eq!(error.kind, AiErrorKind::Cancelled);
    assert_eq!(next_event(&mut events).await, StreamEvent::Cancelled { request_id: "cancel-me".into() });
    assert_eq!(service.registry_len(), 0, "the registry is cleaned up");
    assert!(!service.cancel("cancel-me"), "a finished request cannot be cancelled");
    assert!(mock.wait_for_disconnect(TEST_LIMIT).await, "Ollama sees the connection close");
}

#[tokio::test]
async fn mocked_non_streamed_generation_can_be_cancelled() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/chat" => MockResponse::Hang,
        _ => standard_routes(request),
    })
    .await;
    let service =
        AiService::with_install_probe(AiConfig { timeout: Duration::from_secs(30), ..mock.config() }, installed);
    let task = {
        let service = service.clone();
        tokio::spawn(async move { service.generate(with_id("g-cancel", "x")).await })
    };
    tokio::time::timeout(TEST_LIMIT, async {
        while service.registry_len() == 0 {
            assert!(!task.is_finished(), "generate finished before registering");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("request registered in time");
    assert!(service.cancel("g-cancel"));
    let error = tokio::time::timeout(TEST_LIMIT, task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(error.kind, AiErrorKind::Cancelled);
    assert_eq!(service.registry_len(), 0);
}

#[tokio::test]
async fn mocked_cancel_that_overtakes_its_request_still_cancels_it() {
    let mock = MockOllama::start(standard_routes).await;
    let service = service(&mock);

    // The cancel arrives first (ai_cancel and ai_generate are separate IPC calls).
    assert!(!service.cancel("early-1"), "nothing is running yet");
    let error = service.generate(with_id("early-1", "x")).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::Cancelled);

    assert!(!service.cancel("early-2"));
    let (events, sink) = collect_stream_events();
    let error = service.generate_stream(with_id("early-2", "x"), sink).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::Cancelled);
    assert_eq!(events.lock().unwrap().as_slice(), [StreamEvent::Cancelled { request_id: "early-2".into() }]);

    assert!(!service.cancel("early-3"));
    let error = service.pull_model(None, "early-3".into(), |_| {}).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::Cancelled);

    assert!(mock.requests_to("/api/chat").is_empty() && mock.requests_to("/api/pull").is_empty());
    assert_eq!(service.registry_len(), 0);
}

// ---- validation ----

#[tokio::test]
async fn mocked_invalid_requests_are_rejected_before_reaching_ollama() {
    let mock = MockOllama::start(standard_routes).await;
    let config = AiConfig { max_prompt_bytes: 1024, ..mock.config() };
    let service = AiService::with_install_probe(config, installed);
    let options = |options: GenerationOptions| GenerateRequest { options: Some(options), ..prompt("x") };

    let cases: Vec<(&str, GenerateRequest, &str)> = vec![
        ("empty prompt", prompt(""), "prompt"),
        ("blank prompt", prompt(" \n\t "), "prompt"),
        ("oversize prompt", prompt(&"a".repeat(1025)), "prompt"),
        (
            "oversize system + prompt",
            GenerateRequest { system: Some("s".repeat(1000)), ..prompt(&"a".repeat(30)) },
            "prompt",
        ),
        (
            "temperature",
            options(GenerationOptions { temperature: Some(2.5), ..Default::default() }),
            "options.temperature",
        ),
        (
            "temperature NaN",
            options(GenerationOptions { temperature: Some(f64::NAN), ..Default::default() }),
            "options.temperature",
        ),
        ("topP", options(GenerationOptions { top_p: Some(1.5), ..Default::default() }), "options.topP"),
        ("topK", options(GenerationOptions { top_k: Some(0), ..Default::default() }), "options.topK"),
        ("numPredict", options(GenerationOptions { num_predict: Some(0), ..Default::default() }), "options.numPredict"),
        (
            "numPredict big",
            options(GenerationOptions { num_predict: Some(40_000), ..Default::default() }),
            "options.numPredict",
        ),
        ("numCtx", options(GenerationOptions { num_ctx: Some(100), ..Default::default() }), "options.numCtx"),
        (
            "repeatPenalty",
            options(GenerationOptions { repeat_penalty: Some(-1.0), ..Default::default() }),
            "options.repeatPenalty",
        ),
        (
            "stop count",
            options(GenerationOptions { stop: Some(vec!["x".into(); 9]), ..Default::default() }),
            "options.stop",
        ),
        (
            "stop length",
            options(GenerationOptions { stop: Some(vec!["y".repeat(65)]), ..Default::default() }),
            "options.stop",
        ),
        ("request id chars", with_id("no spaces", "x"), "requestId"),
        ("request id empty", with_id("", "x"), "requestId"),
        ("request id long", with_id(&"a".repeat(65), "x"), "requestId"),
        ("format text", GenerateRequest { format: Some(json!("xml")), ..prompt("x") }, "format"),
        ("format array", GenerateRequest { format: Some(json!([1])), ..prompt("x") }, "format"),
        ("model name", GenerateRequest { model: Some("bad model".into()), ..prompt("x") }, "model"),
    ];
    for (name, request, field) in cases {
        let error = service.generate(request.clone()).await.unwrap_err();
        assert_eq!(error.kind, AiErrorKind::InvalidRequest, "{name}");
        assert!(error.message.contains(field), "{name}: {}", error.message);

        let (events, sink) = collect_stream_events();
        let error = service.generate_stream(request, sink).await.unwrap_err();
        assert_eq!(error.kind, AiErrorKind::InvalidRequest, "{name} (stream)");
        assert_eq!(events.lock().unwrap().as_slice(), [StreamEvent::Error { error }]);
    }

    for model in ["gemma3:1b", "qwen3.5:cloud", "qwen3.5:397b-cloud"] {
        let request = GenerateRequest { model: Some(model.into()), ..prompt("x") };
        assert_eq!(service.generate(request).await.unwrap_err().kind, AiErrorKind::UnsupportedModel, "{model}");
    }

    // Valid edge values pass validation.
    let edge = GenerationOptions {
        temperature: Some(2.0),
        top_p: Some(0.0),
        top_k: Some(1000),
        num_predict: Some(-1),
        num_ctx: Some(262_144),
        seed: Some(i64::MIN),
        stop: Some(vec!["z".repeat(64); 8]),
        repeat_penalty: Some(0.0),
    };
    assert!(
        super::service::validate_request(&GenerateRequest { options: Some(edge), ..prompt(&"a".repeat(1024)) }, 1024)
            .is_ok()
    );

    assert!(mock.requests_to("/api/chat").is_empty(), "no invalid request reached Ollama");
}

#[tokio::test]
async fn mocked_error_messages_never_contain_the_prompt() {
    let mock = MockOllama::start(standard_routes).await;
    let config = AiConfig { max_prompt_bytes: 1024, ..mock.config() };
    let service = AiService::with_install_probe(config, installed);
    let secret = format!("TOP-SECRET-{}", "x".repeat(2000));
    let error = service.generate(prompt(&secret)).await.unwrap_err();
    let text = serde_json::to_string(&error).unwrap();
    assert!(!text.contains("TOP-SECRET"), "{text}");
}

#[tokio::test]
async fn mocked_duplicate_ids_and_concurrency_limit() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/chat" => MockResponse::ndjson(vec![delta_line("x"), Step::Hold]),
        _ => standard_routes(request),
    })
    .await;
    let service = service(&mock);
    let (first, mut first_events) = spawn_stream(&service, with_id("one", "x"));
    next_event(&mut first_events).await;

    let duplicate = service.generate(with_id("one", "x")).await.unwrap_err();
    assert_eq!(duplicate.kind, AiErrorKind::InvalidRequest);
    assert!(duplicate.message.contains("requestId"));

    let (second, mut second_events) = spawn_stream(&service, with_id("two", "x"));
    next_event(&mut second_events).await;
    assert_eq!(service.active_generations(), 2);

    let busy = service.generate(with_id("three", "x")).await.unwrap_err();
    assert_eq!(busy.kind, AiErrorKind::Busy);

    assert!(service.cancel("one") && service.cancel("two"));
    for task in [first, second] {
        assert_eq!(
            tokio::time::timeout(TEST_LIMIT, task).await.unwrap().unwrap().unwrap_err().kind,
            AiErrorKind::Cancelled
        );
    }
    assert_eq!(service.registry_len(), 0);
}

// ---- timeouts and Ollama errors ----

#[tokio::test]
async fn mocked_timeouts_are_reported_quickly() {
    let mock = MockOllama::start(|request: &MockRequest| match request.path.as_str() {
        "/api/chat" if request.json()["messages"][0]["content"] == "stall" => {
            MockResponse::ndjson(vec![delta_line("a"), pause(5_000), done_line(json!({}))])
        }
        "/api/tags" => standard_routes(request),
        _ => MockResponse::Hang,
    })
    .await;
    let config = AiConfig { timeout: Duration::from_millis(300), ..mock.config() };
    let service = AiService::with_install_probe(config, installed);

    let started = Instant::now();
    let error = service.generate(prompt("x")).await.unwrap_err();
    assert_eq!(error.kind, AiErrorKind::Timeout);
    assert!(error.message.contains("300 ms"), "{}", error.message);
    assert!(error.hint.unwrap().contains("OLLAMA_TIMEOUT"));

    // No first chunk.
    assert_eq!(service.generate_stream(prompt("x"), |_| {}).await.unwrap_err().kind, AiErrorKind::Timeout);
    // A gap between chunks longer than the timeout.
    let (events, sink) = collect_stream_events();
    assert_eq!(service.generate_stream(prompt("stall"), sink).await.unwrap_err().kind, AiErrorKind::Timeout);
    assert!(matches!(events.lock().unwrap().last(), Some(StreamEvent::Error { .. })));
    // A hung metadata call times out too. (The 5 s cap on metadata calls is
    // checked by a unit test in service.rs: with a 300 ms OLLAMA_TIMEOUT the
    // cap makes no difference here.)
    let status = service.check_connection().await.unwrap();
    assert_eq!(status.error.unwrap().kind, AiErrorKind::Timeout);

    assert!(started.elapsed() < Duration::from_secs(4), "took {:?}", started.elapsed());
    assert_eq!(service.registry_len(), 0);
}

#[tokio::test]
async fn mocked_ollama_error_responses_are_classified() {
    let mock = MockOllama::start(|request: &MockRequest| {
        if request.path != "/api/chat" {
            return standard_routes(request);
        }
        let prompt = request.json()["messages"][0]["content"].as_str().unwrap_or_default().to_owned();
        match prompt.as_str() {
            "404" => MockResponse::json(404, json!({ "error": "model 'qwen3.5:27b' not found" })),
            "memory" => MockResponse::json(
                500,
                json!({ "error": "model requires more system memory (19.1 GiB) than is available (12.0 GiB)" }),
            ),
            "busy" => MockResponse::json(
                503,
                json!({ "error": "server busy, please try again.  maximum pending requests exceeded" }),
            ),
            _ => MockResponse::json(500, json!({ "error": "llama runner process has terminated: exit status 2" })),
        }
    })
    .await;
    let service = service(&mock);
    let ask = |text: &str, model: &str| GenerateRequest { model: Some(model.into()), ..prompt(text) };

    let missing = service.generate(ask("404", "qwen3.5:27b")).await.unwrap_err();
    assert_eq!((missing.kind, missing.status), (AiErrorKind::ModelNotInstalled, Some(404)));
    assert!(missing.hint.unwrap().contains("ollama pull qwen3.5:27b"));
    assert_eq!(mock.requests_to("/api/chat").len(), 1, "no fallback to another model");

    let missing_stream = service.generate_stream(ask("404", "qwen3.5:27b"), |_| {}).await.unwrap_err();
    assert_eq!(missing_stream.kind, AiErrorKind::ModelNotInstalled);

    let memory = service.generate(ask("memory", "qwen3.5:9b")).await.unwrap_err();
    assert_eq!((memory.kind, memory.status), (AiErrorKind::InsufficientResources, Some(500)));
    assert!(memory.hint.unwrap().contains("smaller"));

    assert_eq!(service.generate(ask("busy", "qwen3.5:9b")).await.unwrap_err().kind, AiErrorKind::Busy);
    assert_eq!(service.generate(ask("crash", "qwen3.5:9b")).await.unwrap_err().kind, AiErrorKind::InferenceFailed);
}

// ---- configuration ----

#[tokio::test]
async fn mocked_invalid_config_makes_every_command_fail_with_invalid_config() {
    let service = AiService::from_lookup(|name| (name == "OLLAMA_TIMEOUT").then(|| "soon".to_owned()));
    let status = service.status().await;
    let config_error = status.config_error.clone().unwrap();
    assert_eq!(config_error.kind, AiErrorKind::InvalidConfig);
    assert!(config_error.message.contains("OLLAMA_TIMEOUT") && config_error.message.contains("soon"));
    assert!(config_error.hint.as_deref().unwrap().contains("OLLAMA_TIMEOUT"));
    assert!(!status.connection.reachable);
    assert!(!status.local_only);
    assert_eq!(status.connection.base_url, "http://127.0.0.1:11434");

    assert_eq!(service.check_connection().await.unwrap_err().kind, AiErrorKind::InvalidConfig);
    assert_eq!(service.list_models().await.unwrap_err().kind, AiErrorKind::InvalidConfig);
    assert_eq!(service.get_model_info(None).await.unwrap_err().kind, AiErrorKind::InvalidConfig);
    assert_eq!(service.select_model("qwen3.5:9b".into()).await.unwrap_err().kind, AiErrorKind::InvalidConfig);
    assert_eq!(service.generate(prompt("x")).await.unwrap_err().kind, AiErrorKind::InvalidConfig);
    assert_eq!(service.generate_stream(prompt("x"), |_| {}).await.unwrap_err().kind, AiErrorKind::InvalidConfig);
    assert_eq!(service.pull_model(None, "p".into(), |_| {}).await.unwrap_err().kind, AiErrorKind::InvalidConfig);
    assert!(!service.cancel("anything"));

    let remote = AiService::from_lookup(|name| (name == "OLLAMA_BASE_URL").then(|| "http://10.0.0.5:11434".to_owned()));
    let status = remote.status().await;
    assert_eq!(status.connection.base_url, "http://10.0.0.5:11434");
    assert!(status.config_error.unwrap().message.contains("OLLAMA_ALLOW_REMOTE"));
}

// ---- real Ollama (opt-in) ----

/// Talks to the real local Ollama with the configured model (default
/// `qwen3.5:9b`). Run with:
///
/// ```text
/// OLLAMA_SMOKE_TEST=1 cargo test --manifest-path src-tauri/Cargo.toml -- --ignored real_ollama --nocapture
/// ```
///
/// It never pulls a model: if the model is missing it fails with `model_not_installed`.
#[tokio::test]
#[ignore = "needs a running Ollama with the configured Qwen 3.5 model; set OLLAMA_SMOKE_TEST=1"]
async fn real_ollama_smoke_test() {
    if std::env::var("OLLAMA_SMOKE_TEST").as_deref() != Ok("1") {
        eprintln!("skipping: set OLLAMA_SMOKE_TEST=1 to run against the real Ollama");
        return;
    }
    let mut config = AiConfig::from_env().expect("valid OLLAMA_* configuration");
    if std::env::var("OLLAMA_TIMEOUT").map_or(true, |value| value.trim().is_empty()) {
        // A cold model load can take minutes; be generous unless told otherwise.
        config.timeout = Duration::from_secs(600);
    }
    let model = config.model.clone();
    let service = AiService::new(config);

    let connection = service.check_connection().await.unwrap();
    println!("connection: {}", serde_json::to_string(&connection).unwrap());
    assert!(connection.reachable, "Ollama is not reachable: {:?}", connection.error);

    let status = service.status().await;
    println!(
        "model: {model}, installed: {:?}, local qwen3.5 models: {:?}, loaded: {:?}",
        status.selected_model_installed,
        status.installed_qwen35_models.iter().map(|m| &m.name).collect::<Vec<_>>(),
        status.loaded_models
    );
    assert_eq!(status.selected_model_installed, Some(true), "run 'ollama pull {model}' first");

    let info = service.get_model_info(None).await.unwrap();
    println!("info: {}", serde_json::to_string(&info).unwrap());

    let options = GenerationOptions { num_predict: Some(32), temperature: Some(0.0), ..Default::default() };
    let request = GenerateRequest {
        prompt: "Reply with exactly one word: ready".into(),
        think: Some(false),
        options: Some(options.clone()),
        ..Default::default()
    };
    let started = Instant::now();
    let response = service.generate(request).await.unwrap();
    println!("generate ({:?}): {:?} stats={:?}", started.elapsed(), response.content, response.stats);
    assert!(!response.content.trim().is_empty());

    // Stream, then cancel after a few deltas.
    let request = GenerateRequest {
        request_id: Some("smoke-stream".into()),
        prompt: "Count from 1 to 200, separated by commas.".into(),
        think: Some(false),
        options: Some(GenerationOptions { num_predict: Some(400), ..options }),
        ..Default::default()
    };
    let (task, mut events) = spawn_stream(&service, request);
    let mut streamed = String::new();
    let mut deltas = 0;
    while deltas < 5 {
        match tokio::time::timeout(Duration::from_secs(600), events.recv()).await.unwrap().unwrap() {
            StreamEvent::Delta { content, .. } => {
                streamed.push_str(&content);
                deltas += 1;
            }
            StreamEvent::Started { .. } => {}
            other => panic!("unexpected event before cancel: {other:?}"),
        }
    }
    assert!(service.cancel("smoke-stream"));
    let error = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    println!("stream: {deltas} deltas {streamed:?}, then cancel -> {}", error.kind);
    assert_eq!(error.kind, AiErrorKind::Cancelled);
    assert_eq!(service.registry_len(), 0);
}
