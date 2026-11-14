import { describe, expect, it } from "vitest";
import { callsOffReason } from "./FunctionViewSwitch";

describe("callsOffReason", () => {
  it("allows the call map for a file the indexer reads, once there is a commit", () => {
    expect(callsOffReason(true, "src/App.tsx")).toBeNull();
    expect(callsOffReason(true, "backend/src/avatar.c")).toBeNull();
  });

  it("says why there is no call map", () => {
    expect(callsOffReason(false, "src/App.tsx")).toBe("The repository has no commits yet");
    expect(callsOffReason(true, "tool.py")).toBe("Call maps read C, Rust, JavaScript and TypeScript files");
  });

  it("puts the missing history first", () => {
    expect(callsOffReason(false, "tool.py")).toBe("The repository has no commits yet");
  });
});
