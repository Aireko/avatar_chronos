//! Configuration of the local AI integration, read from environment variables.
//!
//! | Variable                  | Default                  | Meaning                                        |
//! |---------------------------|--------------------------|------------------------------------------------|
//! | `OLLAMA_BASE_URL`         | `http://127.0.0.1:11434` | Ollama server; must be loopback unless remote is allowed |
//! | `OLLAMA_MODEL`            | [`DEFAULT_MODEL`]        | Qwen 3.5 tag to use (cloud tags are rejected)  |
//! | `OLLAMA_TIMEOUT`          | `120000`                 | Milliseconds, `1000..=3600000` (see [`AiConfig::timeout`]) |
//! | `OLLAMA_MAX_PROMPT_BYTES` | `262144`                 | Max system + prompt bytes, `1024..=8388608`    |
//! | `OLLAMA_ALLOW_REMOTE`     | `false`                  | `true`/`1` allows a non-loopback Ollama host   |
//!
//! Empty values count as unset. An invalid value is a [`ConfigError`] that names
//! the variable, the bad value and what is expected; nothing here panics.
//!
//! These are the app's own variables. Ollama's server reads different ones
//! (`OLLAMA_HOST` for its bind address, `OLLAMA_MODELS` for its model folder).

use std::fmt;
use std::net::IpAddr;
use std::time::Duration;

use url::{Host, Url};

use super::model::{self, DEFAULT_MODEL};

/// Ollama's default local address.
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:11434";
/// Default for `OLLAMA_TIMEOUT`, in milliseconds.
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// Default for `OLLAMA_MAX_PROMPT_BYTES` (256 KiB).
pub const DEFAULT_MAX_PROMPT_BYTES: usize = 262_144;

/// Accepted range for `OLLAMA_TIMEOUT`, in milliseconds.
const TIMEOUT_RANGE_MS: std::ops::RangeInclusive<u64> = 1_000..=3_600_000;
/// Accepted range for `OLLAMA_MAX_PROMPT_BYTES`.
const MAX_PROMPT_BYTES_RANGE: std::ops::RangeInclusive<usize> = 1_024..=8_388_608;

pub const ENV_BASE_URL: &str = "OLLAMA_BASE_URL";
pub const ENV_MODEL: &str = "OLLAMA_MODEL";
pub const ENV_TIMEOUT: &str = "OLLAMA_TIMEOUT";
pub const ENV_MAX_PROMPT_BYTES: &str = "OLLAMA_MAX_PROMPT_BYTES";
pub const ENV_ALLOW_REMOTE: &str = "OLLAMA_ALLOW_REMOTE";

/// Validated settings for talking to Ollama.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiConfig {
    /// Root URL of the Ollama server, always ending in `/`.
    pub base_url: Url,
    /// The model used when a request does not name one (until another is selected).
    pub model: String,
    /// Max wait for a non-streamed response. For streams: max wait for the
    /// first chunk (which covers a slow model load) and max gap between chunks.
    pub timeout: Duration,
    /// Max bytes of system prompt + prompt in one request.
    pub max_prompt_bytes: usize,
    /// Whether `base_url` may point to another machine.
    pub allow_remote: bool,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: Url::parse(DEFAULT_BASE_URL).expect("DEFAULT_BASE_URL is a valid URL"),
            model: DEFAULT_MODEL.to_owned(),
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            max_prompt_bytes: DEFAULT_MAX_PROMPT_BYTES,
            allow_remote: false,
        }
    }
}

impl AiConfig {
    /// Reads the configuration from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Reads the configuration through `lookup` (variable name -> value), so
    /// tests do not have to touch the process environment.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let get = |name: &str| lookup(name).map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
        let defaults = Self::default();

        let allow_remote = match get(ENV_ALLOW_REMOTE) {
            Some(value) => parse_bool(ENV_ALLOW_REMOTE, &value)?,
            None => defaults.allow_remote,
        };
        let base_url = match get(ENV_BASE_URL) {
            Some(value) => parse_base_url(&value, allow_remote)?,
            None => defaults.base_url,
        };
        let model = match get(ENV_MODEL) {
            Some(value) => parse_model(value)?,
            None => defaults.model,
        };
        let timeout = match get(ENV_TIMEOUT) {
            Some(value) => {
                Duration::from_millis(parse_in_range(ENV_TIMEOUT, &value, TIMEOUT_RANGE_MS, "milliseconds")?)
            }
            None => defaults.timeout,
        };
        let max_prompt_bytes = match get(ENV_MAX_PROMPT_BYTES) {
            Some(value) => parse_in_range(ENV_MAX_PROMPT_BYTES, &value, MAX_PROMPT_BYTES_RANGE, "bytes")?,
            None => defaults.max_prompt_bytes,
        };

        Ok(Self { base_url, model, timeout, max_prompt_bytes, allow_remote })
    }

    /// Whether the Ollama server is on this machine (a loopback address).
    pub fn is_local(&self) -> bool {
        is_loopback(&self.base_url)
    }

    /// The base URL as shown to users, without the trailing `/`.
    pub fn base_url_display(&self) -> String {
        display_url(&self.base_url)
    }
}

/// The base URL to show while the configuration is invalid: the raw
/// `OLLAMA_BASE_URL` value if set (with any user name and password replaced
/// by `***`), else the default.
pub fn raw_base_url(lookup: impl Fn(&str) -> Option<String>) -> String {
    lookup(ENV_BASE_URL)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map_or_else(|| DEFAULT_BASE_URL.to_owned(), |value| redact_base_url(&value))
}

/// `value` with the user info (`user:password@`) of its authority replaced by
/// `***@`, so a credential never reaches logs or the UI. Works on strings
/// that are not valid URLs too (`user:pw@host` -> `***@host`).
pub fn redact_base_url(value: &str) -> String {
    let start = value.find("://").map_or(0, |index| index + 3);
    let authority_len = value[start..].find('/').unwrap_or(value.len() - start);
    match value[start..start + authority_len].rfind('@') {
        Some(at) => format!("{}***{}", &value[..start], &value[start + at..]),
        None => value.to_owned(),
    }
}

/// `url` without the trailing `/` that [`Url`] always adds to a bare origin.
pub fn display_url(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_owned()
}

/// An invalid environment variable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    /// The variable, e.g. `OLLAMA_TIMEOUT`.
    pub variable: &'static str,
    /// The value it was set to.
    pub value: String,
    /// What a valid value looks like.
    pub expected: String,
}

impl ConfigError {
    fn new(variable: &'static str, value: &str, expected: impl Into<String>) -> Self {
        Self { variable, value: value.to_owned(), expected: expected.into() }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} is set to {:?}, but {}", self.variable, self.value, self.expected)
    }
}

impl std::error::Error for ConfigError {}

/// Parses `true`/`1`/`false`/`0` (case-insensitive).
fn parse_bool(variable: &'static str, value: &str) -> Result<bool, ConfigError> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err(ConfigError::new(variable, value, "it must be true, 1, false or 0")),
    }
}

/// Parses an integer and checks it is within `range`.
fn parse_in_range<T>(
    variable: &'static str,
    value: &str,
    range: std::ops::RangeInclusive<T>,
    unit: &str,
) -> Result<T, ConfigError>
where
    T: std::str::FromStr + PartialOrd + fmt::Display,
{
    let expected = || format!("it must be a whole number of {unit} from {} to {}", range.start(), range.end());
    match value.parse::<T>() {
        Ok(parsed) if range.contains(&parsed) => Ok(parsed),
        _ => Err(ConfigError::new(variable, value, expected())),
    }
}

/// Checks that `OLLAMA_MODEL` is a well-formed, local Qwen 3.5 tag.
fn parse_model(value: String) -> Result<String, ConfigError> {
    if let Err(problem) = model::validate_model_name(&value) {
        return Err(ConfigError::new(ENV_MODEL, &value, format!("a model name {problem}")));
    }
    if !model::is_qwen35(&value) {
        return Err(ConfigError::new(ENV_MODEL, &value, format!("it must be a Qwen 3.5 tag such as {DEFAULT_MODEL}")));
    }
    if model::is_cloud(&value) {
        return Err(ConfigError::new(
            ENV_MODEL,
            &value,
            "cloud tags run on ollama.com, not on this machine; use a local tag such as qwen3.5:9b",
        ));
    }
    Ok(value)
}

/// Parses and checks `OLLAMA_BASE_URL`. Errors show the value with any user
/// name and password redacted.
fn parse_base_url(value: &str, allow_remote: bool) -> Result<Url, ConfigError> {
    let shown = redact_base_url(value);
    let fail = |expected: &str| ConfigError::new(ENV_BASE_URL, &shown, expected);
    let url = Url::parse(value).map_err(|_| fail("it must be a URL such as http://127.0.0.1:11434"))?;
    match url.scheme() {
        "http" => {}
        "https" => {
            return Err(fail(
                "https is not supported: this app talks to Ollama over plain http (use http://host:port)",
            ));
        }
        _ => return Err(fail("it must start with http://")),
    }
    if url.host().is_none() {
        return Err(fail("it must include a host, such as http://127.0.0.1:11434"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(fail("it must not contain a user name or password"));
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(fail("it must not contain a path, query or fragment (only scheme, host and port)"));
    }
    if !allow_remote && !is_loopback(&url) {
        return Err(fail(
            "it must be a loopback address (localhost, 127.0.0.1 or ::1) so code stays on this machine; \
             set OLLAMA_ALLOW_REMOTE=true to use another host",
        ));
    }
    Ok(url)
}

/// Whether `url` points at this machine: `localhost`, `127.0.0.0/8` or `::1`.
fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => IpAddr::V6(ip).to_canonical().is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Builds the config from a fixed set of variables.
    fn config(vars: &[(&str, &str)]) -> Result<AiConfig, ConfigError> {
        let vars: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        AiConfig::from_lookup(|name| vars.get(name).cloned())
    }

    #[test]
    fn defaults_when_nothing_is_set() {
        let config = config(&[]).unwrap();
        assert_eq!(config, AiConfig::default());
        assert_eq!(config.base_url.as_str(), "http://127.0.0.1:11434/");
        assert_eq!(config.base_url_display(), "http://127.0.0.1:11434");
        assert_eq!(config.model, DEFAULT_MODEL);
        assert_eq!(config.timeout, Duration::from_secs(120));
        assert_eq!(config.max_prompt_bytes, 262_144);
        assert!(!config.allow_remote);
        assert!(config.is_local());
    }

    #[test]
    fn empty_values_count_as_unset() {
        let vars = [
            (ENV_BASE_URL, ""),
            (ENV_MODEL, "  "),
            (ENV_TIMEOUT, ""),
            (ENV_MAX_PROMPT_BYTES, ""),
            (ENV_ALLOW_REMOTE, ""),
        ];
        assert_eq!(config(&vars).unwrap(), AiConfig::default());
    }

    #[test]
    fn overrides_are_applied() {
        let config = config(&[
            (ENV_BASE_URL, "http://localhost:11500/"),
            (ENV_MODEL, "qwen3.5:4b"),
            (ENV_TIMEOUT, "5000"),
            (ENV_MAX_PROMPT_BYTES, "2048"),
        ])
        .unwrap();
        assert_eq!(config.base_url_display(), "http://localhost:11500");
        assert_eq!(config.model, "qwen3.5:4b");
        assert_eq!(config.timeout, Duration::from_secs(5));
        assert_eq!(config.max_prompt_bytes, 2048);
    }

    #[test]
    fn accepts_every_loopback_form() {
        for url in ["http://127.0.0.1:11434", "http://127.1.2.3:8080", "http://[::1]:11434", "http://LOCALHOST:11434"] {
            let config = config(&[(ENV_BASE_URL, url)]).unwrap_or_else(|err| panic!("{url}: {err}"));
            assert!(config.is_local(), "{url}");
        }
    }

    #[test]
    fn each_invalid_value_names_its_variable() {
        let cases: &[(&str, &str)] = &[
            (ENV_BASE_URL, "not a url"),
            (ENV_BASE_URL, "ftp://127.0.0.1:11434"),
            (ENV_BASE_URL, "https://127.0.0.1:11434"),
            (ENV_BASE_URL, "http://127.0.0.1:11434/api"),
            (ENV_BASE_URL, "http://127.0.0.1:11434/?x=1"),
            (ENV_MODEL, "gemma3:1b"),
            (ENV_MODEL, "qwen3.5:397b-cloud"),
            (ENV_MODEL, "qwen3.5 9b"),
            (ENV_TIMEOUT, "abc"),
            (ENV_TIMEOUT, "999"),
            (ENV_TIMEOUT, "3600001"),
            (ENV_TIMEOUT, "-5"),
            (ENV_MAX_PROMPT_BYTES, "1023"),
            (ENV_MAX_PROMPT_BYTES, "8388609"),
            (ENV_MAX_PROMPT_BYTES, "1.5"),
            (ENV_ALLOW_REMOTE, "yes please"),
        ];
        for (variable, value) in cases {
            let err = config(&[(variable, value)]).expect_err(value);
            assert_eq!(err.variable, *variable, "{value}");
            assert_eq!(err.value, *value);
            let text = err.to_string();
            assert!(text.starts_with(variable) && text.contains(value), "{text}");
        }
    }

    #[test]
    fn base_url_credentials_are_never_echoed() {
        let value = "http://user:secret@127.0.0.1:11434";
        let err = config(&[(ENV_BASE_URL, value)]).unwrap_err();
        let text = err.to_string();
        assert!(!text.contains("secret") && !text.contains("user:"), "{text}");
        assert!(text.contains("OLLAMA_BASE_URL") && text.contains("user name or password"), "{text}");
        assert_eq!(err.value, "http://***@127.0.0.1:11434");
        assert_eq!(raw_base_url(|_| Some(value.into())), "http://***@127.0.0.1:11434");

        // Values that are not valid URLs are redacted too; '@' outside the authority is kept.
        assert_eq!(redact_base_url("user:pw@host:11434"), "***@host:11434");
        assert_eq!(redact_base_url("http://a:b@c@127.0.0.1/x@y"), "http://***@127.0.0.1/x@y");
        assert_eq!(redact_base_url("http://127.0.0.1:11434/a@b"), "http://127.0.0.1:11434/a@b");
        assert_eq!(redact_base_url(DEFAULT_BASE_URL), DEFAULT_BASE_URL);
    }

    #[test]
    fn range_errors_say_what_is_expected() {
        let err = config(&[(ENV_TIMEOUT, "10")]).unwrap_err();
        assert!(err.expected.contains("1000 to 3600000"), "{}", err.expected);
    }

    #[test]
    fn remote_hosts_need_opt_in() {
        let err = config(&[(ENV_BASE_URL, "http://192.168.1.20:11434")]).unwrap_err();
        assert_eq!(err.variable, ENV_BASE_URL);
        assert!(err.expected.contains("OLLAMA_ALLOW_REMOTE"));
        assert!(config(&[(ENV_BASE_URL, "http://0.0.0.0:11434")]).is_err());

        for flag in ["true", "1", "TRUE"] {
            let config = config(&[(ENV_BASE_URL, "http://gpu-box.lan:11434"), (ENV_ALLOW_REMOTE, flag)]).unwrap();
            assert!(config.allow_remote);
            assert!(!config.is_local());
        }
        assert!(config(&[(ENV_BASE_URL, "http://gpu-box.lan:11434"), (ENV_ALLOW_REMOTE, "false")]).is_err());
    }

    #[test]
    fn raw_base_url_falls_back_to_default() {
        assert_eq!(raw_base_url(|_| None), DEFAULT_BASE_URL);
        assert_eq!(raw_base_url(|_| Some(" bad ".into())), "bad");
    }
}
