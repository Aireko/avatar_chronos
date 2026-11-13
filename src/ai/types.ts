// TypeScript mirrors of the JSON shapes exchanged with the Rust AI module in
// src-tauri/src/ai/. Every field name is camelCase because the Rust types use
// `#[serde(rename_all = "camelCase")]`. Optional (`?`) fields are omitted by
// Rust when they are `None`.
//
// Keep this file in sync with src-tauri/src/ai/ when a shape changes.

/** Mirrors `ai::error::AiErrorKind` (serialized as snake_case strings). */
export type AiErrorKind =
  | "ollama_not_installed"
  | "ollama_unreachable"
  | "model_not_installed"
  | "unsupported_model"
  | "invalid_request"
  | "invalid_config"
  | "timeout"
  | "cancelled"
  | "insufficient_resources"
  | "inference_failed"
  | "pull_failed"
  | "busy"
  | "internal";

/** Mirrors `ai::error::AiError`: what every `ai_*` command rejects with. */
export interface AiError {
  kind: AiErrorKind;
  /** Human-readable description. Never contains prompt text. */
  message: string;
  /** Actionable next step for the user, when there is one. */
  hint?: string;
  /** HTTP status returned by Ollama, when the error came from an HTTP response. */
  status?: number;
}

/**
 * Mirrors `ai::types::GenerationOptions`. Rust maps these to Ollama's
 * snake_case option names (`top_p`, `num_predict`, ...).
 */
export interface GenerationOptions {
  /** 0..=2 */
  temperature?: number;
  /** 0..=1 */
  topP?: number;
  /** 1..=1000 */
  topK?: number;
  /** -1 (no limit) or 1..=32768. Thinking tokens count toward this limit. */
  numPredict?: number;
  /** Context window in tokens, 512..=262144. Changing it forces a model reload. */
  numCtx?: number;
  /** Any integer; makes sampling reproducible. */
  seed?: number;
  /** At most 8 entries, each at most 64 characters. */
  stop?: string[];
  /** 0..=2 */
  repeatPenalty?: number;
}

/** A JSON Schema object used to constrain structured output. */
export type JsonSchema = { [key: string]: unknown };

/** Mirrors `ai::types::GenerateRequest`. */
export interface GenerateRequest {
  /**
   * 1-64 characters of `[A-Za-z0-9_-]`. Needed to cancel the request. The
   * aiService generates one with `crypto.randomUUID()` when it is omitted.
   */
  requestId?: string;
  /** A Qwen 3.5 tag. Defaults to the selected model. Never substituted. */
  model?: string;
  system?: string;
  /** Must not be empty. `system` + `prompt` are limited to OLLAMA_MAX_PROMPT_BYTES. */
  prompt: string;
  options?: GenerationOptions;
  /**
   * Qwen 3.5 thinks by default when this is omitted. Pass `false` for
   * content-only answers (recommended together with `format`).
   */
  think?: boolean;
  /** `"json"` for free-form JSON, or a JSON Schema object to constrain the output. */
  format?: "json" | JsonSchema;
}

/** Mirrors `ai::types::GenerationStats`. Durations are milliseconds. */
export interface GenerationStats {
  totalDurationMs?: number;
  loadDurationMs?: number;
  promptTokens?: number;
  promptEvalDurationMs?: number;
  evalTokens?: number;
  evalDurationMs?: number;
  tokensPerSecond?: number;
}

/** Mirrors `ai::types::GenerateResponse`. */
export interface GenerateResponse {
  requestId: string;
  model: string;
  /** The answer. With `format`, a JSON string you parse yourself. */
  content: string;
  /** The model's reasoning, when thinking was on. Kept separate from `content`. */
  thinking?: string;
  /** `"stop"`, `"length"` (hit numPredict or the context size), ... */
  doneReason?: string;
  stats: GenerationStats;
}

/** Mirrors `ai::types::StreamEvent` (internally tagged by `type`). */
export type StreamEvent =
  | { type: "started"; requestId: string; model: string }
  | { type: "delta"; content: string; thinking?: string }
  | { type: "done"; response: GenerateResponse }
  | { type: "cancelled"; requestId: string }
  | { type: "error"; error: AiError };

/** Mirrors `ai::types::PullEvent` (internally tagged by `type`). */
export type PullEvent =
  | { type: "started"; requestId: string; model: string }
  | {
      type: "progress";
      status: string;
      digest?: string;
      /** Bytes. */
      total?: number;
      /** Bytes. */
      completed?: number;
      /** 0-100 for the current layer (digest), when known. */
      percent?: number;
    }
  | { type: "done"; model: string }
  | { type: "cancelled"; requestId: string }
  | { type: "error"; error: AiError };

/** Mirrors `ai::types::PullSummary`. */
export interface PullSummary {
  model: string;
  status: string;
}

/** Mirrors `ai::types::ConnectionStatus`. */
export interface ConnectionStatus {
  reachable: boolean;
  /** Ollama server version, when reachable. */
  version?: string;
  /** Whether the Ollama binary was found on this machine; `null` when unknown (remote base URL). */
  installed: boolean | null;
  baseUrl: string;
  /** `true` when the base URL points at this machine (loopback). */
  isLocal: boolean;
  error?: AiError;
}

/** Mirrors `ai::types::ModelSummary`: one entry of Ollama's installed models. */
export interface ModelSummary {
  name: string;
  sizeBytes: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  contextLength?: number;
  modifiedAt?: string;
  isQwen35: boolean;
  isCloud: boolean;
}

/** Mirrors `ai::types::ModelInfo`. */
export interface ModelInfo {
  name: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  contextLength?: number;
  /** e.g. `"completion"`, `"vision"`, `"tools"`, `"thinking"`. */
  capabilities: string[];
  supportsThinking: boolean;
}

/** Mirrors an entry of `ai::model::KNOWN_QWEN35_TAGS`. A hint for UI/docs only. */
export interface KnownQwen35Tag {
  tag: string;
  /** Approximate download size, e.g. `"~6.6 GB"`. */
  downloadSize: string;
  /** Rough memory guidance. */
  notes: string;
}

/** Mirrors `ai::types::AiStatus`. */
export interface AiStatus {
  connection: ConnectionStatus;
  /**
   * Present when an OLLAMA_* environment variable is invalid (kind
   * `invalid_config`; every other call then rejects with it), or when Ollama
   * lists the configured or selected model as a cloud model that runs on a
   * remote host (kind `unsupported_model`; generating with it is rejected).
   */
  configError?: AiError;
  /** From OLLAMA_MODEL, or the built-in default. */
  configuredModel: string;
  /** The model used when a request does not name one. In memory only. */
  selectedModel: string;
  /** `null` when Ollama is unreachable. */
  selectedModelInstalled: boolean | null;
  installedQwen35Models: ModelSummary[];
  /** Models currently loaded in memory by Ollama. */
  loadedModels: string[];
  activeGenerations: number;
  knownQwen35Tags: KnownQwen35Tag[];
  /**
   * Whether prompts stay on this machine: the Ollama server is on loopback
   * (same as `connection.isLocal`; `false` while the config is invalid).
   * Cloud models are rejected either way.
   */
  localOnly: boolean;
}
