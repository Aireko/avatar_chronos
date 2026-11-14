import { describe, expect, it } from "vitest";
import { notReadyReason } from "./aiReady";
import type { AiError, AiStatus } from "./types";

function status(over: Partial<AiStatus> = {}, reachable = true): AiStatus {
  return {
    connection: { reachable, installed: true, baseUrl: "http://127.0.0.1:11434", isLocal: true },
    configuredModel: "qwen3.5:4b",
    selectedModel: "qwen3.5:4b",
    selectedModelInstalled: true,
    installedQwen35Models: [],
    loadedModels: [],
    activeGenerations: 0,
    knownQwen35Tags: [],
    localOnly: true,
    ...over,
  };
}

const err = (message: string): AiError => ({ kind: "internal", message });

describe("notReadyReason", () => {
  it("is null when Ollama is reachable and the selected model is installed", () => {
    expect(notReadyReason(status(), undefined)).toBeNull();
  });

  it("reports a failed status check first", () => {
    expect(notReadyReason(status(), err("boom"))).toBe("Ollama could not be checked: boom");
    expect(notReadyReason(undefined, err("boom"))).toContain("boom");
  });

  it("is not ready while there is no status yet", () => {
    expect(notReadyReason(undefined, undefined)).toMatch(/still being checked/);
  });

  it("reports a config error", () => {
    expect(notReadyReason(status({ configError: err("OLLAMA_HOST is invalid") }), undefined)).toBe(
      "OLLAMA_HOST is invalid",
    );
  });

  it("reports an unreachable Ollama", () => {
    expect(notReadyReason(status({ selectedModelInstalled: null }, false), undefined)).toMatch(/not running/);
  });

  it("is not ready unless the selected model is known to be installed", () => {
    expect(notReadyReason(status({ selectedModelInstalled: false }), undefined)).toMatch(/not installed/);
    expect(notReadyReason(status({ selectedModelInstalled: null }), undefined)).toMatch(/not installed/);
    const missing = status();
    delete (missing as Partial<AiStatus>).selectedModelInstalled;
    expect(notReadyReason(missing, undefined)).toMatch(/not installed/);
  });
});
