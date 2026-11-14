//! Rules for Ollama model names, and which ones this app accepts.
//!
//! The app only runs **local Qwen 3.5** models. A name is accepted when it is
//! well formed ([`validate_model_name`]), belongs to the `qwen3.5` repository
//! ([`is_qwen35`]) and is not a cloud tag ([`is_cloud`]). Cloud tags run on
//! ollama.com servers, so they are rejected everywhere: prompts must stay on
//! this machine. Nothing here ever substitutes one model for another.

use serde::Serialize;

use super::error::AiError;

/// The model used when `OLLAMA_MODEL` is not set. This is the single source of
/// truth for the default tag.
///
/// `qwen3.5:9b` is usually the Q4_K_M build (about 6.6-7.6 GB download,
/// depending on the platform) and suits a typical developer machine: an 8 GB
/// GPU at a moderate context, or 16 GB of RAM.
pub const DEFAULT_MODEL: &str = "qwen3.5:9b";

/// The Ollama repository name of the Qwen 3.5 family.
pub const QWEN35_REPOSITORY: &str = "qwen3.5";

/// Longest accepted model name, in characters.
pub const MAX_MODEL_NAME_LEN: usize = 200;

/// A verified Qwen 3.5 tag with rough sizing, for UI and docs hints only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownTag {
    /// The full Ollama tag, e.g. `qwen3.5:9b`.
    pub tag: &'static str,
    /// Approximate download size as shown on ollama.com.
    pub download_size: &'static str,
    /// Rough memory guidance (at an 8K-32K context) and when to pick it.
    pub notes: &'static str,
}

/// Qwen 3.5 tags verified on https://ollama.com/library/qwen3.5/tags.
///
/// Sizes and memory figures are approximate. This list is never used to pick
/// or substitute a model automatically.
pub const KNOWN_QWEN35_TAGS: &[KnownTag] = &[
    KnownTag {
        tag: "qwen3.5:0.8b",
        download_size: "~1.3 GB",
        notes: "Tiny; about 1.5-2.5 GB of memory. For quick tests only",
    },
    KnownTag {
        tag: "qwen3.5:2b",
        download_size: "~2.7 GB",
        notes: "Small; about 2.5-4 GB of memory. For 8 GB RAM without a GPU",
    },
    KnownTag {
        tag: "qwen3.5:4b",
        download_size: "~3.3 GB",
        notes: "Low-memory choice (12 GB RAM, or a 4-6 GB GPU); about 4-5.5 GB of memory",
    },
    KnownTag {
        tag: "qwen3.5:9b",
        download_size: "~6.6-7.6 GB",
        notes: "Default. About 7.5-9.5 GB of memory: an 8 GB GPU at small context, or 16 GB RAM",
    },
    KnownTag { tag: "qwen3.5:9b-q8_0", download_size: "~10 GB", notes: "Higher-quality 9b; about 11-13 GB of memory" },
    KnownTag {
        tag: "qwen3.5:27b",
        download_size: "~17 GB",
        notes: "Large; about 19-23 GB of memory (24 GB GPU or 40 GB RAM)",
    },
    KnownTag {
        tag: "qwen3.5:35b",
        download_size: "~22 GB",
        notes: "Mixture-of-experts (35b-a3b): fast, but needs about 24-27 GB of memory",
    },
];

/// Checks that `name` is 1..=200 characters of `[A-Za-z0-9._:/-]`.
///
/// Returns a short reason when it is not, for use in error messages.
pub fn validate_model_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("must not be empty".into());
    }
    if name.chars().count() > MAX_MODEL_NAME_LEN {
        return Err(format!("must be at most {MAX_MODEL_NAME_LEN} characters"));
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-');
    if !name.chars().all(allowed) {
        return Err("may only contain letters, digits and . _ : / -".into());
    }
    Ok(())
}

/// Whether `name` is the official Qwen 3.5 library model, e.g. `qwen3.5:9b`,
/// `qwen3.5`, `library/qwen3.5:4b` or `registry.ollama.ai/library/qwen3.5:4b`
/// (case-insensitive).
///
/// Any other registry host or namespace (`someuser/qwen3.5:9b`,
/// `example.com/x/qwen3.5:9b`, `localhost:5000/qwen3.5:2b`) is rejected: such a
/// name can hold any weights, and pulling it would make Ollama contact that host.
pub fn is_qwen35(name: &str) -> bool {
    let local = strip_default_namespace(name);
    let repository = local.split_once(':').map_or(local, |(repository, _)| repository);
    !local.contains('/') && repository.eq_ignore_ascii_case(QWEN35_REPOSITORY)
}

/// Whether `name` is a cloud tag (`qwen3.5:cloud`, `qwen3.5:397b-cloud`, ...),
/// which runs on ollama.com instead of this machine.
pub fn is_cloud(name: &str) -> bool {
    split_name(name).1.is_some_and(|tag| tag.to_ascii_lowercase().ends_with("cloud"))
}

/// Checks that `name` is a well-formed, local Qwen 3.5 tag.
///
/// Malformed names are `invalid_request` errors for `field`; other families
/// and cloud tags are `unsupported_model`.
pub fn ensure_supported(name: &str, field: &str) -> Result<(), AiError> {
    validate_model_name(name).map_err(|problem| AiError::invalid_request(field, problem))?;
    if !is_qwen35(name) {
        return Err(AiError::unsupported_model(name, "this app only runs Qwen 3.5 models (qwen3.5:<size>)"));
    }
    if is_cloud(name) {
        return Err(AiError::unsupported_model(
            name,
            "cloud tags run on ollama.com, not on this machine, so they are not allowed",
        ));
    }
    Ok(())
}

/// Whether two names refer to the same model in Ollama's store. A missing tag
/// means `latest`, and the default registry prefix is ignored.
pub fn same_model(a: &str, b: &str) -> bool {
    let canonical = |name: &str| {
        let name = strip_default_namespace(name);
        let (repository, tag) = split_name(name);
        let prefix = &name[..name.len() - split_last_segment(name).len()];
        format!("{prefix}{repository}:{}", tag.unwrap_or("latest")).to_ascii_lowercase()
    };
    canonical(a) == canonical(b)
}

/// `name` without Ollama's default registry and namespace, compared
/// case-insensitively: `registry.ollama.ai/library/qwen3.5:9b` and
/// `library/qwen3.5:9b` become `qwen3.5:9b`. Other hosts and namespaces are kept.
/// [`is_qwen35`] and [`same_model`] share it so the two cannot drift apart.
fn strip_default_namespace(name: &str) -> &str {
    let name = strip_prefix_ignore_case(name, "registry.ollama.ai/");
    strip_prefix_ignore_case(name, "library/")
}

/// `name` without `prefix`, ignoring ASCII case (`str::strip_prefix` is case-sensitive).
fn strip_prefix_ignore_case<'a>(name: &'a str, prefix: &str) -> &'a str {
    match name.get(..prefix.len()) {
        Some(head) if head.eq_ignore_ascii_case(prefix) => &name[prefix.len()..],
        _ => name,
    }
}

/// Splits the last path segment of `name` into repository and optional tag:
/// `registry.ollama.ai/library/qwen3.5:9b` -> (`qwen3.5`, `Some("9b")`).
fn split_name(name: &str) -> (&str, Option<&str>) {
    let last = split_last_segment(name);
    match last.split_once(':') {
        Some((repository, tag)) => (repository, Some(tag)),
        None => (last, None),
    }
}

/// The text after the last `/` (registry hosts may contain `:port`).
fn split_last_segment(name: &str) -> &str {
    name.rsplit_once('/').map_or(name, |(_, last)| last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::error::AiErrorKind;

    #[test]
    fn default_model_is_a_supported_known_tag() {
        assert!(ensure_supported(DEFAULT_MODEL, "model").is_ok());
        assert!(KNOWN_QWEN35_TAGS.iter().any(|known| known.tag == DEFAULT_MODEL));
        for known in KNOWN_QWEN35_TAGS {
            assert!(ensure_supported(known.tag, "model").is_ok(), "{}", known.tag);
        }
    }

    #[test]
    fn validates_name_syntax() {
        assert!(validate_model_name("qwen3.5:9b").is_ok());
        assert!(validate_model_name("localhost:5000/library/qwen3.5:9b-q4_K_M").is_ok());
        assert!(validate_model_name("").is_err());
        assert!(validate_model_name("qwen3.5 9b").is_err());
        assert!(validate_model_name("qwen3.5:9b;rm").is_err());
        assert!(validate_model_name(&"a".repeat(MAX_MODEL_NAME_LEN)).is_ok());
        assert!(validate_model_name(&"a".repeat(MAX_MODEL_NAME_LEN + 1)).is_err());
    }

    #[test]
    fn detects_qwen35() {
        for name in [
            "qwen3.5:9b",
            "qwen3.5",
            "QWEN3.5:4B",
            "library/qwen3.5:4b",
            "registry.ollama.ai/library/qwen3.5:27b",
            "Registry.Ollama.AI/Library/qwen3.5:9b",
        ] {
            assert!(is_qwen35(name), "{name}");
        }
        for name in [
            "qwen3:8b",
            "qwen3.5-coder:7b",
            "qwen2.5:7b",
            "gemma3:1b",
            "qwen3.5x:1b",
            "qwen3.5/other:1b",
            // Other registries and namespaces can hold any weights.
            "localhost:5000/qwen3.5:2b",
            "someuser/qwen3.5:9b",
            "evil.example.com/x/qwen3.5:9b",
            "registry.ollama.ai/someuser/qwen3.5:9b",
            "library/someuser/qwen3.5:9b",
        ] {
            assert!(!is_qwen35(name), "{name}");
            assert_eq!(ensure_supported(name, "model").unwrap_err().kind, AiErrorKind::UnsupportedModel, "{name}");
        }
    }

    #[test]
    fn detects_cloud_tags() {
        assert!(is_cloud("qwen3.5:cloud"));
        assert!(is_cloud("qwen3.5:397b-cloud"));
        assert!(is_cloud("QWEN3.5:397B-CLOUD"));
        assert!(!is_cloud("qwen3.5:9b"));
        assert!(!is_cloud("qwen3.5"));
        assert!(!is_cloud("cloud"));
    }

    #[test]
    fn ensure_supported_classifies_failures() {
        assert_eq!(ensure_supported("", "model").unwrap_err().kind, AiErrorKind::InvalidRequest);
        assert_eq!(ensure_supported("gemma3:1b", "model").unwrap_err().kind, AiErrorKind::UnsupportedModel);
        let cloud = ensure_supported("qwen3.5:397b-cloud", "model").unwrap_err();
        assert_eq!(cloud.kind, AiErrorKind::UnsupportedModel);
        assert!(cloud.message.contains("cloud"));
    }

    #[test]
    fn compares_names_like_ollama() {
        assert!(same_model("qwen3.5", "qwen3.5:latest"));
        assert!(same_model("QWEN3.5:9B", "qwen3.5:9b"));
        assert!(same_model("registry.ollama.ai/library/qwen3.5:9b", "qwen3.5:9b"));
        assert!(same_model("Registry.Ollama.AI/library/qwen3.5:9b", "library/qwen3.5:9b"));
        assert!(!same_model("someuser/qwen3.5:9b", "qwen3.5:9b"));
        assert!(!same_model("qwen3.5:9b", "qwen3.5:4b"));
        assert!(!same_model("qwen3.5:9b", "qwen3.5:9b-q8_0"));
    }
}
