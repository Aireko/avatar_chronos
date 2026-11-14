import { describe, expect, it } from "vitest";
import { initials } from "./initials";

describe("initials", () => {
  it("takes the first and last word of the name", () => {
    expect(initials("Ada Lovelace", "ada@example.com")).toBe("AL");
    expect(initials("Grace Brewster Murray Hopper", "")).toBe("GH");
  });

  it("uses one letter for a one-word name", () => {
    expect(initials("ada", "ada@example.com")).toBe("A");
  });

  it("skips punctuation and brackets", () => {
    expect(initials("dependabot[bot]", "")).toBe("DB");
    expect(initials("  (Bob)  ", "")).toBe("B");
  });

  it("keeps non-Latin letters and characters outside the BMP whole", () => {
    expect(initials("Émile Zola", "")).toBe("ÉZ");
    expect(initials("\u{1D49C}lice", "")).toBe("\u{1D49C}");
  });

  it("keeps combining marks with their letter and their word", () => {
    expect(initials("Émile Zola", "")).toBe("ÉZ");
    expect(initials("अमित", "")).toBe("अ");
  });

  it("falls back to the email, then to a question mark", () => {
    expect(initials("", "bob.ng@example.com")).toBe("B");
    expect(initials("", "")).toBe("?");
    expect(initials("--", "@example.com")).toBe("?");
  });
});
