// Minimal test panel for the local AI integration (Ollama + Qwen 3.5).
// It exercises every aiService call; it is not the product UI.
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { aiErrorMessage, aiService, isAiError } from "./aiService";
import { usePaneReturn, useBusySignal } from "./panelHooks";
import type { AiError, AiStatus, GenerateResponse, GenerationStats, PullEvent } from "./types";
import "./AiPanel.css";

/** How long "Copied" stays on the copy button: the same hold as the commit ticket's copy
 *  stamp and the editor's "Saved" (CommitDetails, CodeEditor) and the People panel. */
const COPIED_MS = 1400;

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

interface AiPanelProps {
  /** Told when a model download or a generation starts (true) and when the last one stops (false). */
  onBusyChange?: (busy: boolean) => void;
}

export default function AiPanel({ onBusyChange }: AiPanelProps = {}) {
  const panelRef = useRef<HTMLElement>(null);
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
  // The streamed answer follows its newest line unless the reader scrolled up.
  const outputRef = useRef<HTMLPreElement>(null);
  const stickToEnd = useRef(true);
  // The copy button says "Copied" (or that it failed) for a moment, in place.
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<number | undefined>(undefined);

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
      window.clearTimeout(copyTimer.current);
    };
  }, [refresh]);

  useBusySignal(pulling || generating, onBusyChange);

  useEffect(() => {
    const el = outputRef.current;
    if (el && generating && stickToEnd.current) el.scrollTop = el.scrollHeight;
  }, [output, generating]);

  // The drawer hides this panel (display: none) while another tool is shown; the answer
  // can keep streaming meanwhile. Back on screen, a followed answer shows its newest line.
  usePaneReturn(panelRef, () => {
    const el = outputRef.current;
    if (el && stickToEnd.current) el.scrollTop = el.scrollHeight;
  });

  function onOutputScroll() {
    const el = outputRef.current;
    // A hidden box reads all zeros; that says nothing about where the reader is.
    if (el && el.clientHeight > 0) stickToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  async function onCopy() {
    let next: "copied" | "failed" = "copied";
    try {
      await navigator.clipboard.writeText(output);
    } catch {
      next = "failed";
    }
    setCopyState(next);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState("idle"), COPIED_MS);
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
          if (!event || event.type !== "progress") return;
          setPullProgress((prev) => {
            const layers = { ...(prev?.layers ?? {}) };
            const { digest, total, completed } = event;
            if (typeof digest === "string" && digest && typeof total === "number" && Number.isFinite(total)) {
              layers[digest] = { total, completed: typeof completed === "number" && Number.isFinite(completed) ? completed : 0 };
            }
            return { status: typeof event.status === "string" ? event.status : (prev?.status ?? "downloading"), layers };
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

  async function onGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const controller = new AbortController();
    genAbort.current = controller;
    stickToEnd.current = true;
    window.clearTimeout(copyTimer.current);
    setCopyState("idle");
    setGenerating(true);
    setOutput("");
    setThinking("");
    setResult(undefined);
    setGenError(undefined);
    try {
      const response = await aiService.generateStream(
        { prompt, system: system.trim() ? system : undefined, think },
        {
          signal: controller.signal,
          onDelta: (content, thought) => {
            if (content) setOutput((text) => text + content);
            if (thought) setThinking((text) => text + thought);
          },
        },
      );
      // The final response is authoritative (it also covers any missed deltas).
      setOutput(response.content);
      setThinking(response.thinking ?? "");
      setResult(response);
    } catch (error) {
      setGenError(asAiError(error));
    } finally {
      genAbort.current = null;
      setGenerating(false);
    }
  }

  const connection = status?.connection;
  // No download while a config problem (e.g. the model is a cloud alias) is reported.
  const downloadTag =
    status && status.selectedModelInstalled === false && !status.configError ? status.selectedModel : undefined;
  const known = downloadTag
    ? status?.knownQwen35Tags.find((t) => t.tag === downloadTag || `qwen3.5:${t.tag}` === downloadTag)
    : undefined;
  const percent = pullProgress ? overallPercent(pullProgress) : undefined;
  const canGenerate = !!status?.connection.reachable && status.selectedModelInstalled === true && !generating;

  return (
    <section ref={panelRef} className="ai-panel" aria-labelledby="ai-panel-title">
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
        <h3 className="section-title">Test prompt</h3>
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
        {!generating && (result || output) && (
          <div className="ai-answer-bar">
            {result && <p className="ai-note ai-muted ai-stats">{formatStats(result.stats, result.doneReason)}</p>}
            {output && (
              <button
                type="button"
                className={`btn ai-small ai-copy${copyState === "idle" ? "" : ` is-${copyState}`}`}
                onClick={() => void onCopy()}
              >
                {/* All labels share one grid cell so the button keeps its width; the hidden ones are
                    visibility: hidden, which also keeps them out of the accessible name. */}
                <span className="ai-swap">
                  <span className={copyState === "idle" ? undefined : "is-off"}>Copy answer</span>
                  <span className={copyState === "copied" ? "ai-copied-label" : "is-off"}>Copied</span>
                  <span className={copyState === "failed" ? "ai-copy-failed-label" : "is-off"}>Couldn't copy</span>
                </span>
              </button>
            )}
          </div>
        )}
        <span className="ai-sr-only" role="status">
          {copyState === "copied" ? "Answer copied to the clipboard." : copyState === "failed" ? "Couldn't copy the answer." : ""}
        </span>
        {genError?.kind === "cancelled" && <p className="ai-note ai-muted">Stopped.</p>}
        {genError && genError.kind !== "cancelled" && <ErrorBox error={genError} />}
      </form>
    </section>
  );
}
