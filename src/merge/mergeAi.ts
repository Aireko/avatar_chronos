// Asks the local model (through aiService, never directly) to suggest a resolution.
import { aiService } from "../ai/aiService";
import type { AiSuggestion, Confidence } from "./types";

const SCHEMA = {
  type: "object",
  properties: {
    resolution: { type: "string" },
    explanation: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["resolution", "explanation", "confidence"],
};

const SYSTEM =
  "You resolve one git merge conflict at a time. You are given the base version, 'ours' (the branch being merged into) " +
  "and 'theirs' (the branch being merged in) of the lines that conflict, and the function and file they come from. " +
  "Reply with the merged code that should replace the conflicting lines: keep the intent of both sides when they are " +
  "compatible, and when they are not, keep the safer behaviour and say so. The snippets may be only the changed lines " +
  "of a function, not the whole function: return the same kind of region, not a rewritten function. " +
  "Keep the original indentation and line endings style. No markdown fences, no conflict markers, no commentary " +
  "inside 'resolution'. An empty 'resolution' means the code should be removed. Put your reasoning in 'explanation' " +
  "in one or two sentences, and set 'confidence' to low when you are guessing.";

export interface SuggestInput {
  filePath: string;
  /** null for a region that isn't inside a function, or a whole file. */
  symbolName: string | null;
  oursBranch: string;
  theirsBranch: string;
  base: string;
  ours: string;
  theirs: string;
}

const block = (label: string, text: string) => `=== ${label} ===\n${text === "" ? "(empty)" : text}`;

/** Models sometimes wrap code in a fence even when told not to. */
function stripFence(text: string): string {
  const m = /^\s*```[A-Za-z0-9_+-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1] : text;
}

const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];

/** Turns the model's JSON answer into a suggestion, or throws a readable error. */
export function parseSuggestion(content: string): AiSuggestion {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error("The model's answer wasn't valid JSON. Try again, or resolve this one by hand.");
  }
  if (typeof data !== "object" || data === null) throw new Error("The model's answer had the wrong shape.");
  const { resolution, explanation, confidence } = data as Record<string, unknown>;
  if (typeof resolution !== "string") throw new Error("The model's answer had no resolution.");
  return {
    resolution: stripFence(resolution),
    explanation: typeof explanation === "string" ? explanation : "",
    confidence: CONFIDENCES.find((c) => c === confidence) ?? "low",
  };
}

/** Rejects with an AiError (see aiErrorMessage); with kind "cancelled" when `signal` aborts. */
export async function suggestResolution(input: SuggestInput, signal: AbortSignal): Promise<AiSuggestion> {
  const where = input.symbolName ? `function ${input.symbolName}` : "a region outside any function";
  const prompt = [
    `File: ${input.filePath}`,
    `Conflict in ${where}.`,
    block("BASE (common ancestor)", input.base),
    block(`OURS (${input.oursBranch})`, input.ours),
    block(`THEIRS (${input.theirsBranch})`, input.theirs),
  ].join("\n\n");

  const response = await aiService.generate(
    {
      system: SYSTEM,
      prompt,
      think: false,
      format: SCHEMA,
      options: { temperature: 0.1, numPredict: 2000 },
    },
    { signal },
  );
  if (response.doneReason === "length") {
    throw new Error("The model ran out of room before it finished. Resolve this one by hand.");
  }
  return parseSuggestion(response.content);
}