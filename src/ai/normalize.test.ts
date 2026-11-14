import { describe, expect, it } from "vitest";
import { list, num, oneOf, optNum, str, strings } from "./coerce";
import { normalizeAiError, normalizeAiStatus, normalizeGenerateResponse, normalizeStats } from "./normalize";

describe("coerce", () => {
  it("keeps only values of the right type", () => {
    expect(str(3, "x")).toBe("x");
    expect(num(Number.NaN, 7)).toBe(7);
    expect(num(null)).toBe(0);
    expect(optNum(Infinity)).toBeUndefined();
    expect(strings(["a", 1, null, "b"])).toEqual(["a", "b"]);
    expect(list(null, () => 1)).toEqual([]);
    expect(oneOf("nope", ["a", "b"] as const, "a")).toBe("a");
  });
});

describe("normalizeAiStatus", () => {
  it("rejects with an AiError when the answer is not an object", () => {
    expect(() => normalizeAiStatus(null)).toThrowError();
    try {
      normalizeAiStatus(null);
    } catch (error) {
      expect(error).toMatchObject({ kind: "internal" });
    }
  });

  it("rejects an answer without a connection", () => {
    expect(() => normalizeAiStatus({ selectedModel: "qwen3.5:9b" })).toThrow();
  });

  it("fills every list and drops unreadable entries", () => {
    const status = normalizeAiStatus({
      connection: { reachable: true, baseUrl: "http://127.0.0.1:11434", isLocal: true, installed: "yes" },
      selectedModel: "qwen3.5:9b",
      installedQwen35Models: [null, { name: "qwen3.5:9b", sizeBytes: "big" }, { sizeBytes: 3 }],
      loadedModels: null,
      knownQwen35Tags: [{ tag: "9b" }, { downloadSize: "~1 GB" }],
    });
    expect(status.connection).toMatchObject({ reachable: true, isLocal: true, installed: null });
    expect(status.installedQwen35Models).toEqual([
      expect.objectContaining({ name: "qwen3.5:9b", sizeBytes: 0, isQwen35: false }),
    ]);
    expect(status.loadedModels).toEqual([]);
    expect(status.knownQwen35Tags).toEqual([{ tag: "9b", downloadSize: "", notes: "" }]);
    expect(status.selectedModelInstalled).toBeNull();
    expect(status.configuredModel).toBe("");
  });

  it("treats an unknown locality as not local", () => {
    expect(normalizeAiStatus({ connection: {} }).connection.isLocal).toBe(false);
  });
});

describe("normalizeAiError", () => {
  it("is undefined when absent and readable when malformed", () => {
    expect(normalizeAiError(undefined)).toBeUndefined();
    expect(normalizeAiError(null)).toBeUndefined();
    expect(normalizeAiError({})).toEqual({ kind: "internal", message: "Unknown error", hint: undefined, status: undefined });
    expect(normalizeAiError("boom")).toEqual({ kind: "internal", message: "boom" });
    expect(normalizeAiError({ kind: "timeout", message: "slow", status: 504 })).toMatchObject({ kind: "timeout", status: 504 });
  });
});

describe("normalizeGenerateResponse", () => {
  it("keeps only finite stats, so formatting them cannot throw", () => {
    const response = normalizeGenerateResponse({ content: "hi", stats: { tokensPerSecond: null, evalTokens: 12 } });
    expect(response.content).toBe("hi");
    expect(response.stats).toEqual(expect.objectContaining({ evalTokens: 12, tokensPerSecond: undefined }));
    expect(normalizeStats(null)).toEqual({});
  });

  it("rejects a null answer and defaults missing text", () => {
    expect(() => normalizeGenerateResponse(null)).toThrow();
    expect(normalizeGenerateResponse({}).content).toBe("");
  });
});
