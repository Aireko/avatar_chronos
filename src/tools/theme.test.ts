import { describe, expect, it } from "vitest";
import html from "../../index.html?raw";
import { THEME_KEY, createThemeController, initialTheme, saveTheme, savedTheme, systemTheme, watchSystemTheme, type ThemeEnv } from "./theme";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

function fakeMedia(dark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const list = {
    matches: dark,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => void listeners.add(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => void listeners.delete(l),
  };
  return {
    listeners,
    matchMedia: ((query: string) => {
      expect(query).toBe("(prefers-color-scheme: dark)");
      return list;
    }) as NonNullable<ThemeEnv["matchMedia"]>,
    flip(next: boolean) {
      list.matches = next;
      for (const l of listeners) l({ matches: next } as MediaQueryListEvent);
    },
  };
}

const throwing = () => {
  throw new Error("blocked");
};

describe("first launch follows the system", () => {
  it("uses blackboard when the system is dark", () => {
    expect(initialTheme({ storage: fakeStorage(), matchMedia: fakeMedia(true).matchMedia })).toBe("board");
  });

  it("uses paper when the system is light", () => {
    expect(initialTheme({ storage: fakeStorage(), matchMedia: fakeMedia(false).matchMedia })).toBe("paper");
  });

  it("falls back to paper when the system setting can't be read", () => {
    expect(systemTheme({ matchMedia: null })).toBe("paper");
    expect(systemTheme({ matchMedia: throwing })).toBe("paper");
    expect(initialTheme({})).toBe("paper");
  });
});

describe("the user's pick is remembered", () => {
  it("a saved pick wins over the system setting", () => {
    const storage = fakeStorage({ [THEME_KEY]: "paper" });
    expect(initialTheme({ storage, matchMedia: fakeMedia(true).matchMedia })).toBe("paper");
  });

  it("saving then relaunching gives back the same theme", () => {
    const storage = fakeStorage();
    const media = fakeMedia(false).matchMedia;
    expect(saveTheme("board", { storage })).toBe(true);
    expect(storage.data.get(THEME_KEY)).toBe("board");
    expect(initialTheme({ storage, matchMedia: media })).toBe("board");
  });

  it("ignores junk in storage and follows the system", () => {
    const storage = fakeStorage({ [THEME_KEY]: "neon" });
    expect(savedTheme({ storage })).toBeNull();
    expect(initialTheme({ storage, matchMedia: fakeMedia(true).matchMedia })).toBe("board");
  });

  it("survives blocked storage", () => {
    const blocked = { getItem: throwing, setItem: throwing };
    expect(savedTheme({ storage: blocked })).toBeNull();
    expect(saveTheme("board", { storage: blocked })).toBe(false);
    expect(saveTheme("board", { storage: null })).toBe(false);
    expect(initialTheme({ storage: blocked, matchMedia: fakeMedia(true).matchMedia })).toBe("board");
  });
});

describe("watching the system setting", () => {
  it("reports changes until stopped", () => {
    const media = fakeMedia(false);
    const seen: string[] = [];
    const stop = watchSystemTheme((t) => seen.push(t), { matchMedia: media.matchMedia });
    media.flip(true);
    media.flip(false);
    stop();
    media.flip(true);
    expect(seen).toEqual(["board", "paper"]);
    expect(media.listeners.size).toBe(0);
  });

  it("is a no-op when the system setting can't be watched", () => {
    expect(() => watchSystemTheme(() => {}, { matchMedia: null })()).not.toThrow();
    expect(() => watchSystemTheme(() => {}, { matchMedia: throwing })()).not.toThrow();
  });
});

describe("index.html picks the same theme before the app loads", () => {
  // The inline script can't import theme.ts, so check it uses the same key and query.
  it("reads the same storage key", () => {
    expect(html).toContain(`localStorage.getItem("${THEME_KEY}")`);
  });

  it("asks the same system question", () => {
    expect(html).toContain('matchMedia("(prefers-color-scheme: dark)")');
  });
});

describe("the controller behind useTheme", () => {
  it("follows the system until the user picks, then sticks to the pick across launches", () => {
    const storage = fakeStorage();
    const media = fakeMedia(true);
    const shown: string[] = [];
    const first = createThemeController((t) => shown.push(t), { storage, matchMedia: media.matchMedia });

    expect(first.theme).toBe("board"); // dark system on first launch
    media.flip(false);
    expect(first.theme).toBe("paper"); // still following the system
    first.choose("board");
    expect(storage.data.get(THEME_KEY)).toBe("board");
    media.flip(true);
    media.flip(false);
    expect(first.theme).toBe("board"); // the pick wins over later system changes
    expect(shown).toEqual(["paper", "board"]);
    first.stop();
    expect(media.listeners.size).toBe(0);

    // Quit and relaunch with a light system: the pick is still used.
    const second = createThemeController(() => {}, { storage, matchMedia: fakeMedia(false).matchMedia });
    expect(second.theme).toBe("board");
  });

  it("remembers a pick that matches the system, so later system changes don't override it", () => {
    const storage = fakeStorage();
    const media = fakeMedia(false);
    const c = createThemeController(() => {}, { storage, matchMedia: media.matchMedia });
    c.choose("paper");
    expect(storage.data.get(THEME_KEY)).toBe("paper");
    media.flip(true);
    expect(c.theme).toBe("paper");
  });

  it("starting from a saved pick ignores the system from the start", () => {
    const media = fakeMedia(false);
    const c = createThemeController(() => {}, { storage: fakeStorage({ [THEME_KEY]: "board" }), matchMedia: media.matchMedia });
    media.flip(true);
    media.flip(false);
    expect(c.theme).toBe("board");
  });

  it("keeps the pick for the session when storage is blocked", () => {
    const media = fakeMedia(false);
    const c = createThemeController(() => {}, { storage: { getItem: throwing, setItem: throwing }, matchMedia: media.matchMedia });
    c.choose("board");
    media.flip(false);
    expect(c.theme).toBe("board");
  });

  it("says whether a change came from the system or the user's pick", () => {
    // useTheme cross-fades only system changes; the toolbar switch fades the pick itself.
    const media = fakeMedia(false);
    const seen: string[] = [];
    const c = createThemeController((t, cause) => seen.push(`${cause}:${t}`), { storage: fakeStorage(), matchMedia: media.matchMedia });
    media.flip(true);
    c.choose("paper");
    c.choose("paper");
    expect(seen).toEqual(["system:board", "pick:paper"]);
  });
});
