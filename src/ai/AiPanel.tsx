// Minimal test panel for the local AI integration (Ollama + Qwen 3.5).
// It exercises every aiService call; it is not the product UI.
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { aiErrorMessage, aiService, isAiError } from "./aiService";
import type { AiError, AiStatus, GenerateResponse, GenerationStats, PullEvent } from "./types";
import "./AiPanel.css";

function asAiError(error: unknown): AiError {
  return isAiError(error) ? error : { kind: "internal", message: aiErrorMessage(error) };
}

function ErrorBox({ error }: { error: AiError }) {
  return (
    <div className="ai-error" role="alert">
      <strong>{error.message}</strong>
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

export default function AiPanel() {
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

  async function onGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const controller = new AbortController();
    genAbort.current = controller;
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
    <section className="ai-panel" aria-labelledby="ai-panel-title">
      <h2 id="ai-panel-title">Local AI test panel</h2>
      {connection?.isLocal === true && (
        <p className="ai-privacy">Runs locally through Ollama — prompts and code never leave this machine.</p>
      )}
      {connection?.isLocal === false && (
        <p className="ai-privacy ai-remote" role="alert">
          Remote Ollama server: prompts and code are sent unencrypted (plain http) to <code>{connection.baseUrl}</code>.
        </p>
      )}

      <div className="ai-block">
        <div className="ai-row">
          <h3>Connection</h3>
          <button type="button" onClick={() => void refresh()} disabled={loadingStatus}>
            {loadingStatus ? "Checking..." : "Refresh"}
          </button>
        </div>
        {statusError && <ErrorBox error={statusError} />}
        {connection && (
          <>
            <p>
              <span className={connection.reachable ? "ai-ok" : "ai-bad"}>
                {connection.reachable ? "Connected" : "Not connected"}
              </span>
              {connection.version && ` · Ollama ${connection.version}`}
              {" · "}
              <code>{connection.baseUrl}</code>
              {connection.isLocal ? " (local)" : " (remote)"}
              {connection.installed === false && " · Ollama not found on this machine"}
            </p>
            {connection.error && <ErrorBox error={connection.error} />}
          </>
        )}
        {status?.configError && <ErrorBox error={status.configError} />}
      </div>

      {status && (
        <div className="ai-block">
          <h3>Model</h3>
          <p>
            Configured: <code>{status.configuredModel}</code> · Selected: <code>{status.selectedModel}</code>
            {status.selectedModelInstalled === true && " (installed)"}
            {status.selectedModelInstalled === false && " (not installed)"}
            {status.loadedModels.length > 0 && ` · Loaded in memory: ${status.loadedModels.join(", ")}`}
          </p>

          {status.installedQwen35Models.length > 0 ? (
            <div className="ai-row">
              <select aria-label="Installed Qwen 3.5 models" value={choice} onChange={(e) => setChoice(e.target.value)}>
                {status.installedQwen35Models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} ({formatBytes(m.sizeBytes)}
                    {m.quantization ? `, ${m.quantization}` : ""})
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void onSelect()} disabled={!choice || choice === status.selectedModel}>
                Select
              </button>
            </div>
          ) : (
            connection?.reachable && <p className="ai-muted">No Qwen 3.5 model is installed in Ollama yet.</p>
          )}
          {selectError && <ErrorBox error={selectError} />}

          {downloadTag && connection?.reachable && (
            <div className="ai-download">
              {!pulling && (
                <button type="button" onClick={() => void onDownload(downloadTag)}>
                  {pullError ? "Retry download" : "Download"} {downloadTag}
                  {known ? ` (~${known.downloadSize.replace(/^~\s*/, "")})` : ""}
                </button>
              )}
              {known && !pulling && <span className="ai-muted"> {known.notes}</span>}
              {pulling && pullProgress && (
                <div className="ai-progress">
                  <progress max={100} value={percent} aria-label="Download progress" />
                  <span>
                    {pullProgress.status}
                    {percent !== undefined && ` · ${percent.toFixed(1)}%`}
                  </span>
                  <button type="button" onClick={() => pullAbort.current?.abort()}>
                    Cancel
                  </button>
                </div>
              )}
              {pullError?.kind === "cancelled" && <span className="ai-muted"> Download cancelled.</span>}
              {pullError && pullError.kind !== "cancelled" && <ErrorBox error={pullError} />}
            </div>
          )}
        </div>
      )}

      <form className="ai-block" onSubmit={onGenerate}>
        <h3>Test prompt</h3>
        <details>
          <summary>System prompt (optional)</summary>
          <textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={2} aria-label="System prompt" />
        </details>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} aria-label="Prompt" />
        <div className="ai-row">
          <label>
            <input type="checkbox" checked={think} onChange={(e) => setThink(e.target.checked)} /> Think (show reasoning)
          </label>
          <button type="submit" disabled={!canGenerate || !prompt.trim()}>
            Generate
          </button>
          <button type="button" onClick={() => genAbort.current?.abort()} disabled={!generating}>
            Stop
          </button>
        </div>

        {thinking && (
          <details className="ai-thinking">
            <summary>Thinking ({thinking.length} chars)</summary>
            <pre>{thinking}</pre>
          </details>
        )}
        {(output || generating) && <pre className="ai-output">{output || "Waiting for the model..."}</pre>}
        {result && <p className="ai-muted">{formatStats(result.stats, result.doneReason)}</p>}
        {genError?.kind === "cancelled" && <p className="ai-muted">Stopped.</p>}
        {genError && genError.kind !== "cancelled" && <ErrorBox error={genError} />}
      </form>
    </section>
  );
}
