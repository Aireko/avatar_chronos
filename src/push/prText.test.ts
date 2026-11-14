import { describe, expect, it } from "vitest";
import { bodyFromMessage, titleFromMessage } from "./prText";

describe("titleFromMessage", () => {
  it("uses the first line of the commit message", () => {
    expect(titleFromMessage("Fix parser\n\nLonger text", "feature/x")).toBe("Fix parser");
  });
  it("falls back to the branch name", () => {
    expect(titleFromMessage("   ", "feature/add-login_page")).toBe("add login page");
  });
  it("caps very long titles", () => {
    expect(titleFromMessage("a".repeat(300), "x")).toHaveLength(120);
  });
});

describe("bodyFromMessage", () => {
  it("is everything after the first line", () => {
    expect(bodyFromMessage("Fix parser\n\nLonger text\nmore")).toBe("Longer text\nmore");
  });
  it("is empty for a one-line message", () => {
    expect(bodyFromMessage("Fix parser")).toBe("");
  });
});