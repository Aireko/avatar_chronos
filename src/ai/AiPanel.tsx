// Minimal test panel for the local AI integration (Ollama + Qwen 3.5).
// It exercises every aiService call; it is not the product UI.
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { notReadyReason } from "./aiReady";
import { aiErrorMessage, aiService, isAiError } from "./aiService";
import type { AiError, AiStatus, GenerateResponse, GenerationStats, PullEvent } from "./types";
import "./AiPanel.css";

function asAiError(error: unknown): AiError {
  return isAiError(error) ? error : { kind: "internal", message: aiErrorMessage(error) };
}

function ErrorBox({ error }: { error: AiError }) {
  return (
    <div className="ai-error" role="alert">
      <strong className="ai-error-message">{error.message}</strong>
      <span className="ai-muted">
        {" "}
        ({error.kind}
        {error.status !== undefined ? `, HTTP ${error.status}` : ""})
      </span>
      {error.hint && <div className="ai-hint">{error.hint}</div>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function formatStats(stats: GenerationStats, doneReason?: string): string {
  const parts: string[] = [];
  if (stats.evalTokens !== undefined) parts.push(`${stats.evalTokens} tokens`);
  if (stats.tokensPerSecond !== undefined) parts.push(`${stats.tokensPerSecond.toFixed(1)} tok/s`);
  if (stats.promptTokens !== undefined) parts.push(`prompt ${stats.promptTokens} tokens`);
  if (stats.loadDurationMs !== undefined) parts.push(`load ${(stats.loadDurationMs / 1000).toFixed(1)} s`);
  if (stats.totalDurationMs !== undefined) parts.push(`total ${(stats.totalDurationMs / 1000).toFixed(1)} s`);
  if (doneReason) parts.push(`done: ${doneReason}`);
  return parts.join(" · ");
}

/** Download progress summed over all layers (digests) Ollama reports. */
interface PullProgress {
  status: string;
  layers: Record<string, { total: number; completed: number }>;
}

function overallPercent(progress: PullProgress): number | undefined {
  let total = 0;
  let completed = 0;
  for (const layer of Object.values(progress.layers)) {
    total += layer.total;
    completed += layer.completed;
  }
  return total > 0 ? Math.min(100, (completed / total) * 100) : undefined;
}

/**
 * A prompt handed in by the app (e.g. "Explain this commit"). Each new `id` is run once.
 * Without a `prompt` the app is still putting it together: the panel says so and waits.
 */
export interface AiRequest {
  id: number;
  prompt?: string;
  system?: string;
  /** What the request is about, for the status line, e.g. "commit 1a2b3c4". */
  subject?: string;
}

interface AiPanelProps {
  request?: AiRequest | null;
  /** Called once the panel has taken `request` (with its prompt) into its prompt box. */
  onRequestTaken?: (id: number) => void;
}

/** Matches the drawer's enter animation (.slide-panel ticket-in, 0.26s), so the scroll lands on settled layout. */
const DRAWER_ENTER_MS = 280;

/** The nearest ancestor that scrolls vertically (the drawer body). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

export default function AiPanel({ request = null, onRequestTaken }: AiPanelProps = {}) {
  const [status, setStatus] = useState<AiStatus>();
  const [statusError, setStatusError] = useState<AiError>();
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [choice, setChoice] = useState("");
  const [selectError, setSelectError] = useState<AiError>();

  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullProgress>();
  const [pullError, setPullError] = useState<AiError>();
  const pullAbort = useRef<AbortController | null>(null);

  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState("Explain in two sentences what a linked list is.");
  const [think, setThink] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [output, setOutput] = useState("");
  const [thinking, setThinking] = useState("");
  const [result, setResult] = useState<GenerateResponse>();
  const [genError, setGenError] = useState<AiError>();
  const genAbort = useRef<AbortController | null>(null);
  // A handed-in prompt waits here until the status check says whether it can run.
  const [pending, setPending] = useState<{ prompt: string; system: string } | null>(null);
  // Set when a handed-in prompt could not run; the reason shown is re-derived live.
  const [blocked, setBlocked] = useState(false);
  const takenRequest = useRef<number | null>(null);
  // The request whose run area was last brought into view and focused.
  const revealedRequest = useRef<number | null>(null);
  const runHead = useRef<HTMLHeadingElement>(null);
  // The app is still preparing a handed-in prompt (e.g. reading the commit's changes).
  const preparing = request !== null && request.prompt === undefined;
  // The streamed answer follows its newest line unless the reader scrolled up.
  const outputRef = useRef<HTMLPreElement>(null);
  const stickToEnd = useRef(true);

  const refresh = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const next = await aiService.status();
      setStatus(next);
      setStatusError(undefined);
      setChoice((current) =>
        current && next.installedQwen35Models.some((m) => m.name === current)
          ? current
          : (next.installedQwen35Models.find((m) => m.name === next.selectedModel)?.name ??
            next.installedQwen35Models[0]?.name ??
            ""),
      );
    } catch (error) {
      setStatusError(asAiError(error));
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      // Stop any running generation or download when the panel goes away.
      genAbort.current?.abort();
      pullAbort.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    const el = outputRef.current;
    if (el && generating && stickToEnd.current) el.scrollTop = el.scrollHeight;
  }, [output, generating]);

  function onOutputScroll() {
    const el = outputRef.current;
    if (el) stickToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  async function onSelect() {
    if (!choice) return;
    try {
      await aiService.selectModel(choice);
      setSelectError(undefined);
      await refresh();
    } catch (error) {
      setSelectError(asAiError(error));
    }
  }

  async function onDownload(tag: string) {
    const controller = new AbortController();
    pullAbort.current = controller;
    setPulling(true);
    setPullError(undefined);
    setPullProgress({ status: "starting", layers: {} });
    try {
      await aiService.pullModel(tag, {
        signal: controller.signal,
        onProgress: (event: PullEvent) => {
          if (event.type !== "progress") return;
          setPullProgress((prev) => {
            const layers = { ...(prev?.layers ?? {}) };
            if (event.digest && event.total !== undefined) {
              layers[event.digest] = { total: event.total, completed: event.completed ?? 0 };
            }
            return { status: event.status, layers };
          });
        },
      });
      setPullProgress(undefined);
      await refresh();
    } catch (error) {
      setPullError(asAiError(error));
    } finally {
      pullAbort.current = null;
      setPulling(false);
    }
  }

  async function generate(promptText: string, systemText: string) {
    // A handed-in prompt replaces an answer that is still streaming.
    genAbort.current?.abort();
    const controller = new AbortController();
    genAbort.current = controller;
    // A replaced run must not touch the newer run's output or flags.
    const current = () => genAbort.current === controller;
    stickToEnd.current = true;
    setBlocked(false);
    setGenerating(true);
    setOutput("");
    setThinking("");
    setResult(undefined);
    setGenError(undefined);
    try {
      const response = await aiService.generateStream(
        { prompt: promptText, system: systemText.trim() ? systemText : undefined, think },
        {
          signal: controller.signal,
          onDelta: (content, thought) => {
            if (!current()) return;
            if (content) setOutput((text) => text + content);
            if (thought) setThinking((text) => text + thought);
          },
        },
      );
      if (!current()) return;
      // The final response is authoritative (it also covers any missed deltas).
      setOutput(response.content);
      setThinking(response.thinking ?? "");
      setResult(response);
    } catch (error) {
      if (current()) setGenError(asAiError(error));
    } finally {
      if (current()) {
        genAbort.current = null;
        setGenerating(false);
      }
    }
  }

  function onGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void generate(prompt, system);
  }

  // A handed-in request: once per id, bring the run area (heading, status line, answer)
  // into view and move focus to it, after the drawer has slid in. The drawer opens
  // scrolled to the top, where the connection facts are, and the button that asked
  // (e.g. the ticket's "Explain this commit") is gone, so focus would drop to the page.
  const revealTimer = useRef<number | undefined>(undefined);
  // Unmount only. It also forgets the revealed id: StrictMode's trial unmount runs this
  // between the two runs of the effect below, and the second run must set the timer again.
  // (Not in the reveal effect's own cleanup: the app clears `request` soon after the
  // prompt is taken, which would cancel the timer before it fires.)
  useEffect(
    () => () => {
      window.clearTimeout(revealTimer.current);
      revealedRequest.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!request || revealedRequest.current === request.id) return;
    revealedRequest.current = request.id;
    // Don't offer the old prompt while the new one is being put together.
    if (request.prompt === undefined) {
      setPrompt("");
      setSystem("");
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    window.clearTimeout(revealTimer.current);
    revealTimer.current = window.setTimeout(
      () => {
        const head = runHead.current;
        if (!head) return;
        const box = scrollParent(head);
        if (box) {
          const top = box.scrollTop + head.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
          box.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
        }
        head.focus({ preventScroll: true });
      },
      reduce ? 0 : DRAWER_ENTER_MS,
    );
  }, [request]);

  // A prompt handed in by the app: fill the box once per request id, then run it
  // as soon as the status check says the model is ready.
  useEffect(() => {
    if (!request || request.prompt === undefined || takenRequest.current === request.id) return;
    takenRequest.current = request.id;
    setPrompt(request.prompt);
    setSystem(request.system ?? "");
    setBlocked(false);
    setPending({ prompt: request.prompt, system: request.system ?? "" });
    // Check again before running, so an Ollama that stopped since the drawer opened
    // shows up as the reason instead of as a failed run.
    void refresh();
    onRequestTaken?.(request.id);
  }, [request, onRequestTaken, refresh]);

  useEffect(() => {
    // Wait for the first (or a running) status check.
    if (!pending || loadingStatus || (!status && !statusError)) return;
    setPending(null);
    if (notReadyReason(status, statusError)) setBlocked(true);
    else void generate(pending.prompt, pending.system);
    // generate is recreated each render; this only reacts to the check finishing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, loadingStatus, status, statusError]);

  const connection = status?.connection;
  // No download while a config problem (e.g. the model is a cloud alias) is reported.
  const downloadTag =
    status && status.selectedModelInstalled === false && !status.configError ? status.selectedModel : undefined;
  const known = downloadTag
    ? status?.knownQwen35Tags.find((t) => t.tag === downloadTag || `qwen3.5:${t.tag}` === downloadTag)
    : undefined;
  const percent = pullProgress ? overallPercent(pullProgress) : undefined;
  const canGenerate =
    !!status?.connection.reachable && status.selectedModelInstalled === true && !generating && !preparing;
  // Re-derived from the live status, so the note goes away once the model is ready.
  const blockedReason = blocked && !generating ? notReadyReason(status, statusError) : null;

  return (
    <section className="ai-panel" aria-labelledby="ai-panel-title">
      {/* The drawer band already shows the tool title; keep the heading for screen readers. */}
      <h2 id="ai-panel-title" className="ai-sr-only">
        Local AI test panel
      </h2>
      {connection?.isLocal === true && (
        <p className="ai-privacy">Runs locally through Ollama — prompts and code never leave this machine.</p>
      )}
      {connection?.isLocal === false && (
        <p className="ai-privacy ai-remote" role="alert">
          Remote Ollama server: prompts and code are sent unencrypted (plain http) to <code>{connection.baseUrl}</code>.
        </p>
      )}

      <div className="ai-block">
        <div className="section-title ai-head">
          <h3>Connection</h3>
          <button type="button" className="btn ai-small" onClick={() => void refresh()} disabled={loadingStatus}>
            {loadingStatus ? "Checking..." : "Refresh"}
          </button>
        </div>
        {!connection && !statusError && loadingStatus && (
          <div className="ai-checking" role="status">
            <p className="working">
              <span className="working-dot" aria-hidden="true" />
              Looking for Ollama...
            </p>
            {/* Pencil lines where the facts will go, so the panel does not jump when they arrive. */}
            <div className="ai-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {statusError && <ErrorBox error={statusError} />}
        {connection && (
          <>
            <dl className="facts ai-facts" aria-busy={loadingStatus || undefined}>
              <dt>Status</dt>
              <dd>
                <span
                  // Re-stamped whenever the connection flips, so the change is noticed.
                  key={String(connection.reachable)}
                  className={connection.reachable ? "ai-status ai-ok" : "ai-status ai-bad"}
                >
                  {connection.reachable ? "Connected" : "Not connected"}
                </span>
              </dd>
              {connection.version && (
                <>
                  <dt>Ollama</dt>
                  <dd>{connection.version}</dd>
                </>
              )}
              <dt>Server</dt>
              <dd>
                <code>{connection.baseUrl}</code>
                {connection.isLocal ? " (local)" : " (remote)"}
              </dd>
            </dl>
            {connection.installed === false && <p className="ai-note ai-warn">Ollama not found on this machine.</p>}
            {connection.error && <ErrorBox error={connection.error} />}
          </>
        )}
        {status?.configError && <ErrorBox error={status.configError} />}
      </div>

      {status && (
        <div className="ai-block ai-reveal">
          <h3 className="section-title">Model</h3>
          <dl className="facts ai-facts">
            <dt>Configured</dt>
            <dd>
              <code>{status.configuredModel}</code>
            </dd>
            <dt>Selected</dt>
            <dd>
              <code>{status.selectedModel}</code>
              {status.selectedModelInstalled === true && <span className="ai-ok"> (installed)</span>}
              {status.selectedModelInstalled === false && <span className="ai-warn"> (not installed)</span>}
            </dd>
            {status.loadedModels.length > 0 && (
              <>
                <dt>In memory</dt>
                <dd>
                  <code>{status.loadedModels.join(", ")}</code>
                </dd>
              </>
            )}
          </dl>

          {status.installedQwen35Models.length > 0 ? (
            <div className="ai-row ai-picker">
              <select
                className="field ai-select"
                aria-label="Installed Qwen 3.5 models"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                {status.installedQwen35Models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} ({formatBytes(m.sizeBytes)}
                    {m.quantization ? `, ${m.quantization}` : ""})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn"
                onClick={() => void onSelect()}
                disabled={!choice || choice === status.selectedModel}
              >
                Select
              </button>
            </div>
          ) : (
            connection?.reachable && <p className="ai-note ai-muted">No Qwen 3.5 model is installed in Ollama yet.</p>
          )}
          {selectError && <ErrorBox error={selectError} />}

          {downloadTag && connection?.reachable && (
            <div className="ai-download">
              {!pulling && (
                <button type="button" className="btn ai-wrap" onClick={() => void onDownload(downloadTag)}>
                  {pullError ? "Retry download" : "Download"} {downloadTag}
                  {known ? ` (~${known.downloadSize.replace(/^~\s*/, "")})` : ""}
                </button>
              )}
              {known && !pulling && <span className="ai-muted ai-line"> {known.notes}</span>}
              {pulling && pullProgress && (
                <div className="ai-progress">
                  <progress max={100} value={percent} aria-label="Download progress" />
                  <span className="ai-progress-text">
                    {pullProgress.status}
                    {percent !== undefined && ` · ${percent.toFixed(1)}%`}
                  </span>
                  <button type="button" className="btn ai-small" onClick={() => pullAbort.current?.abort()}>
                    Cancel
                  </button>
                </div>
              )}
              {pullError?.kind === "cancelled" && <span className="ai-muted ai-line"> Download cancelled.</span>}
              {pullError && pullError.kind !== "cancelled" && <ErrorBox error={pullError} />}
            </div>
          )}
        </div>
      )}

      <form className="ai-block" onSubmit={onGenerate}>
        <h3 ref={runHead} className="section-title ai-run-head" tabIndex={-1}>
          Test prompt
        </h3>
        <details className="ai-system">
          <summary>System prompt (optional)</summary>
          <textarea
            className="ai-input"
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            rows={2}
            aria-label="System prompt"
          />
        </details>
        <textarea
          className="ai-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          aria-label="Prompt"
          placeholder={preparing ? "The prompt is being put together…" : undefined}
        />
        <div className="ai-row ai-run">
          <label className="ai-check">
            <input type="checkbox" checked={think} onChange={(e) => setThink(e.target.checked)} /> Think (show reasoning)
          </label>
          <button type="submit" className="btn primary" disabled={!canGenerate || !prompt.trim()}>
            {generating ? "Generating..." : "Generate"}
          </button>
          <button type="button" className="btn" onClick={() => genAbort.current?.abort()} disabled={!generating}>
            Stop
          </button>
        </div>
        {/* One live region that is always present, so each change in it is announced. */}
        <div className="ai-run-status" role="status">
          {preparing ? (
            <p className="working">
              <span className="working-dot" aria-hidden="true" />
              Preparing {request?.subject ?? "the prompt"} for the model…
            </p>
          ) : pending ? (
            <p className="working">
              <span className="working-dot" aria-hidden="true" />
              Checking the local AI before running…
            </p>
          ) : blockedReason ? (
            <p className="ai-note ai-warn">The prompt is ready but can't run yet. {blockedReason}</p>
          ) : generating ? (
            <span className="ai-sr-only">Generating the answer…</span>
          ) : result ? (
            <span className="ai-sr-only">The answer is ready.</span>
          ) : null}
        </div>

        {thinking && (
          <details className="ai-thinking">
            <summary>Thinking ({thinking.length} chars)</summary>
            <pre>{thinking}</pre>
          </details>
        )}
        {(output || generating) && (
          <pre
            ref={outputRef}
            className={generating ? "ai-output ai-streaming" : "ai-output"}
            onScroll={onOutputScroll}
            aria-busy={generating || undefined}
          >
            {output || <span className="ai-waiting">Waiting for the model...</span>}
            {generating && <span className="ai-caret" aria-hidden="true" />}
          </pre>
        )}
        {result && <p className="ai-note ai-muted ai-stats">{formatStats(result.stats, result.doneReason)}</p>}
        {genError?.kind === "cancelled" && <p className="ai-note ai-muted">Stopped.</p>}
        {genError && genError.kind !== "cancelled" && <ErrorBox error={genError} />}
      </form>
    </section>
  );
}
