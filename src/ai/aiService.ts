// The single frontend entry point for local AI (Ollama + Qwen 3.5).
//
// Every call goes through a Tauri command in src-tauri/src/ai/commands.rs.
// The webview never talks to Ollama directly: all HTTP to Ollama happens in
// Rust, which keeps CORS out of the picture and lets Rust enforce the
// local-only, Qwen-3.5-only and size-limit rules. Do not add `fetch()` calls
// to Ollama anywhere in the frontend.
//
// Every method rejects with an `AiError` (see ./types.ts). Use `isAiError()`
// and `aiErrorMessage()` to inspect or display it.
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type {
  AiError,
  AiErrorKind,
  AiStatus,
  ConnectionStatus,
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  ModelSummary,
  PullEvent,
  PullSummary,
  StreamEvent,
} from "./types";

export type * from "./types";

/** Callbacks and cancellation for `generateStream`. */
export interface GenerateStreamOptions {
  /** Receives every stream event: started, delta, done, cancelled, error. */
  onEvent?: (event: StreamEvent) => void;
  /** Convenience: receives only the text of each delta event. */
  onDelta?: (content: string, thinking?: string) => void;
  /** Aborting it cancels the generation (the promise then rejects with kind "cancelled"). */
  signal?: AbortSignal;
}

/** Cancellation for the non-streaming `generate`. */
export interface GenerateOptions {
  /** Aborting it cancels the generation (the promise then rejects with kind "cancelled"). */
  signal?: AbortSignal;
}

/** Callbacks and cancellation for `pullModel`. */
export interface PullModelOptions {
  /** Receives every pull event: started, progress, done, cancelled, error. */
  onProgress: (event: PullEvent) => void;
  /** Aborting it cancels the download (Ollama resumes it next time). */
  signal?: AbortSignal;
  /** Optional id for `cancelGeneration`; generated with `crypto.randomUUID()` when omitted. */
  requestId?: string;
}

export interface AIService {
  /** Is Ollama reachable, which version, is it installed, is the base URL local. Never rejects for "unreachable". */
  checkConnection(): Promise<ConnectionStatus>;
  /** Everything the UI needs in one call: connection, configured/selected model, installed Qwen 3.5 models, hints. */
  status(): Promise<AiStatus>;
  /** All models installed in Ollama (not only Qwen 3.5); check `isQwen35` / `isCloud`. */
  listModels(): Promise<ModelSummary[]>;
  /** Details of one model; defaults to the selected model. */
  getModelInfo(model?: string): Promise<ModelInfo>;
  /** Selects an installed, local Qwen 3.5 model for requests that name none. Resolves to the selected tag. */
  selectModel(model: string): Promise<string>;
  /**
   * Downloads a Qwen 3.5 model (defaults to the selected model, initially
   * OLLAMA_MODEL). Only call this from an explicit user action: downloads are
   * several GB.
   */
  pullModel(model: string | undefined, options: PullModelOptions): Promise<PullSummary>;
  /** Generates a complete answer in one response. */
  generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResponse>;
  /** Generates an answer and streams it through `onEvent` / `onDelta`. Resolves to the full response. */
  generateStream(request: GenerateRequest, options?: GenerateStreamOptions): Promise<GenerateResponse>;
  /**
   * Cancels an active generation or download by request id. Resolves to
   * whether something was running. A cancel that arrives a moment before its
   * request starts still cancels it (Rust remembers it for a few seconds).
   */
  cancelGeneration(requestId: string): Promise<boolean>;
}

const AI_ERROR_KINDS: ReadonlySet<string> = new Set<AiErrorKind>([
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
]);

/** True when `error` has the shape of an `AiError`. */
export function isAiError(error: unknown): error is AiError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as AiError).kind === "string" &&
    AI_ERROR_KINDS.has((error as AiError).kind) &&
    typeof (error as AiError).message === "string"
  );
}

/** Turns whatever an AI call rejected with into one readable line: message plus hint. */
export function aiErrorMessage(error: unknown): string {
  if (isAiError(error)) return error.hint ? `${error.message}. ${error.hint}` : error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Normalises any rejection (AiError, Tauri IPC error string, Error) into an AiError. */
function toAiError(error: unknown): AiError {
  if (isAiError(error)) return error;
  return { kind: "internal", message: error instanceof Error ? error.message : String(error) };
}

const NOT_IN_APP: AiError = {
  kind: "internal",
  message: "Local AI is only available inside the desktop app",
  hint: "Start the app with 'npm run tauri:dev' instead of opening the Vite page in a browser",
};

const CANCELLED: AiError = { kind: "cancelled", message: "The request was cancelled" };

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NOT_IN_APP;
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toAiError(error);
  }
}

function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Runs a command that registers `requestId` in Rust, and wires `signal` to
 * `ai_cancel`. The command and the cancel are separate IPC calls, so the
 * cancel can reach Rust before the request has registered. Rust remembers
 * such an early cancel for a few seconds and fails the request with
 * "cancelled" as soon as it starts, so one `ai_cancel` is enough.
 *
 * Callers check `isTauri()` before building `args`: the Channel constructor
 * needs the Tauri runtime and would otherwise throw a TypeError.
 */
async function runCancellable<T>(
  command: string,
  args: Record<string, unknown>,
  requestId: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) throw CANCELLED;
  const onAbort = () => void call<boolean>("ai_cancel", { requestId }).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await call<T>(command, args);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** A Channel that forwards every message to `onEvent`. Only call inside Tauri. */
function channelTo<E>(onEvent: (event: E) => void): Channel<E> {
  const channel = new Channel<E>();
  channel.onmessage = onEvent;
  return channel;
}

export const aiService: AIService = {
  checkConnection: () => call<ConnectionStatus>("ai_check_connection"),

  status: () => call<AiStatus>("ai_status"),

  listModels: () => call<ModelSummary[]>("ai_list_models"),

  getModelInfo: (model?: string) => call<ModelInfo>("ai_get_model_info", { model: model ?? null }),

  selectModel: (model: string) => call<string>("ai_select_model", { model }),

  // The methods below are `async` so that any synchronous failure (such as
  // crypto.randomUUID) becomes a rejected promise, never a thrown exception.
  // They check isTauri() first so callers get NOT_IN_APP, with its hint.

  async pullModel(model, { onProgress, signal, requestId }) {
    if (!isTauri()) throw NOT_IN_APP;
    const id = requestId ?? newRequestId();
    const args = { model: model ?? null, requestId: id, onProgress: channelTo<PullEvent>(onProgress) };
    return runCancellable<PullSummary>("ai_pull_model", args, id, signal);
  },

  async generate(request, options) {
    const signal = options?.signal;
    if (!signal) return call<GenerateResponse>("ai_generate", { request });
    if (!isTauri()) throw NOT_IN_APP;
    const id = request.requestId ?? newRequestId();
    const response = await runCancellable<GenerateResponse>(
      "ai_generate",
      { request: { ...request, requestId: id } },
      id,
      signal,
    );
    // An aborted call never resolves as a success, even if it finished first.
    if (signal.aborted) throw CANCELLED;
    return response;
  },

  async generateStream(request, options = {}) {
    if (!isTauri()) throw NOT_IN_APP;
    const { onEvent, onDelta, signal } = options;
    const id = request.requestId ?? newRequestId();
    const channel = channelTo<StreamEvent>((event) => {
      onEvent?.(event);
      if (event.type === "delta") onDelta?.(event.content, event.thinking);
    });
    const response = await runCancellable<GenerateResponse>(
      "ai_generate_stream",
      { request: { ...request, requestId: id }, onEvent: channel },
      id,
      signal,
    );
    if (signal?.aborted) throw CANCELLED;
    return response;
  },

  cancelGeneration: (requestId: string) => call<boolean>("ai_cancel", { requestId }),
};
