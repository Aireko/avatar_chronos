// Turns what the Rust AI commands answered into the shapes in ./types.ts, so a
// partial or null answer (a command that failed half-way) never crashes the AI
// panel while it renders. Malformed top-level answers reject with an AiError,
// which the panel shows in its error box.
import { bool, isRecord, list, num, oneOf, optNum, optStr, str, strings } from "./coerce";
import type {
  AiError,
  AiErrorKind,
  AiStatus,
  ConnectionStatus,
  GenerateResponse,
  GenerationStats,
  KnownQwen35Tag,
  ModelSummary,
} from "./types";

const KINDS: readonly AiErrorKind[] = [
  "ollama_not_installed",
  "ollama_unreachable",
  "model_not_installed",
  "unsupported_model",
  "invalid_request",
  "invalid_config",
  "timeout",
  "cancelled",
  "insufficient_resources",
  "inference_failed",
  "pull_failed",
  "busy",
  "internal",
];

/** The error for an answer that does not have the expected shape. */
export function malformed(what: string): AiError {
  return {
    kind: "internal",
    message: `The app returned an unexpected answer for ${what}`,
    hint: "Try again; if it keeps happening, restart the app",
  };
}

/** An AiError nested in an answer: undefined when absent, a generic error when unreadable. */
export function normalizeAiError(value: unknown): AiError | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return { kind: "internal", message: typeof value === "string" ? value : "Unknown error" };
  return {
    kind: oneOf(value.kind, KINDS, "internal"),
    message: str(value.message, "Unknown error"),
    hint: optStr(value.hint),
    status: optNum(value.status),
  };
}

function normalizeConnection(value: unknown): ConnectionStatus {
  if (!isRecord(value)) throw malformed("the Ollama connection");
  return {
    reachable: bool(value.reachable),
    version: optStr(value.version),
    installed: typeof value.installed === "boolean" ? value.installed : null,
    baseUrl: str(value.baseUrl, "(unknown)"),
    // Unknown counts as not local: the panel then warns rather than promising privacy.
    isLocal: bool(value.isLocal),
    error: normalizeAiError(value.error),
  };
}

function normalizeModel(value: unknown): ModelSummary | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name) return undefined;
  return {
    name: value.name,
    sizeBytes: Math.max(0, num(value.sizeBytes)),
    parameterSize: optStr(value.parameterSize),
    quantization: optStr(value.quantization),
    family: optStr(value.family),
    contextLength: optNum(value.contextLength),
    modifiedAt: optStr(value.modifiedAt),
    isQwen35: bool(value.isQwen35),
    isCloud: bool(value.isCloud),
  };
}

function normalizeKnownTag(value: unknown): KnownQwen35Tag | undefined {
  if (!isRecord(value) || typeof value.tag !== "string") return undefined;
  return { tag: value.tag, downloadSize: str(value.downloadSize), notes: str(value.notes) };
}

/** `ai_status`'s answer, with every list and field the panel reads present and typed. */
export function normalizeAiStatus(value: unknown): AiStatus {
  if (!isRecord(value)) throw malformed("the AI status");
  return {
    connection: normalizeConnection(value.connection),
    configError: normalizeAiError(value.configError),
    configuredModel: str(value.configuredModel),
    selectedModel: str(value.selectedModel),
    selectedModelInstalled: typeof value.selectedModelInstalled === "boolean" ? value.selectedModelInstalled : null,
    installedQwen35Models: list(value.installedQwen35Models, normalizeModel),
    loadedModels: strings(value.loadedModels),
    activeGenerations: num(value.activeGenerations),
    knownQwen35Tags: list(value.knownQwen35Tags, normalizeKnownTag),
    localOnly: bool(value.localOnly),
  };
}

/** Generation statistics: only finite numbers survive (so `toFixed` is always safe). */
export function normalizeStats(value: unknown): GenerationStats {
  if (!isRecord(value)) return {};
  return {
    totalDurationMs: optNum(value.totalDurationMs),
    loadDurationMs: optNum(value.loadDurationMs),
    promptTokens: optNum(value.promptTokens),
    promptEvalDurationMs: optNum(value.promptEvalDurationMs),
    evalTokens: optNum(value.evalTokens),
    evalDurationMs: optNum(value.evalDurationMs),
    tokensPerSecond: optNum(value.tokensPerSecond),
  };
}

export function normalizeGenerateResponse(value: unknown): GenerateResponse {
  if (!isRecord(value)) throw malformed("the generated answer");
  return {
    requestId: str(value.requestId),
    model: str(value.model),
    content: str(value.content),
    thinking: optStr(value.thinking),
    doneReason: optStr(value.doneReason),
    stats: normalizeStats(value.stats),
  };
}
