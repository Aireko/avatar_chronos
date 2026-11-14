// Which look the app uses: paper (light) or blackboard (dark).
//
// Until the user picks one with the toolbar switch, the app follows the system's
// light/dark setting, including when it changes while the app is open. Once they
// pick, that choice is saved and used on every later launch.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { crossFade } from "./crossFade";

export type Theme = "paper" | "board";

/** Why the theme changed: the system's light/dark setting moved, or the user picked one. */
export type ThemeCause = "system" | "pick";

/** localStorage key for the user's pick. index.html reads it too, before the app loads. */
export const THEME_KEY = "chronos.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The parts of `window` this module uses, so tests can pass fakes. */
export interface ThemeEnv {
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  matchMedia?: ((query: string) => Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">) | null;
}

function browserEnv(): ThemeEnv {
  if (typeof window === "undefined") return {};
  let storage: Storage | null = null;
  try {
    // Reading localStorage itself can throw when storage is blocked.
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return { storage, matchMedia: typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : null };
}

export function isTheme(value: unknown): value is Theme {
  return value === "paper" || value === "board";
}

/** The theme matching the system's light/dark setting. Paper when it can't be read. */
export function systemTheme(env: ThemeEnv = browserEnv()): Theme {
  try {
    return env.matchMedia?.(DARK_QUERY).matches ? "board" : "paper";
  } catch {
    return "paper";
  }
}

/** The theme the user picked earlier, or null if they never picked (or it can't be read). */
export function savedTheme(env: ThemeEnv = browserEnv()): Theme | null {
  try {
    const value = env.storage?.getItem(THEME_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remember the user's pick. Returns false if it couldn't be stored. */
export function saveTheme(theme: Theme, env: ThemeEnv = browserEnv()): boolean {
  try {
    if (!env.storage) return false;
    env.storage.setItem(THEME_KEY, theme);
    return true;
  } catch {
    // Storage full or blocked: the pick still applies for this session.
    return false;
  }
}

/** The theme to start with: the saved pick, otherwise the system setting. */
export function initialTheme(env: ThemeEnv = browserEnv()): Theme {
  return savedTheme(env) ?? systemTheme(env);
}

/**
 * Calls `onChange` with the new theme whenever the system's light/dark setting
 * changes. Returns a function that stops listening.
 */
export function watchSystemTheme(onChange: (theme: Theme) => void, env: ThemeEnv = browserEnv()): () => void {
  let query: ReturnType<NonNullable<ThemeEnv["matchMedia"]>>;
  try {
    if (!env.matchMedia) return () => {};
    query = env.matchMedia(DARK_QUERY);
  } catch {
    return () => {};
  }
  const listener = (e: MediaQueryListEvent) => onChange(e.matches ? "board" : "paper");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export interface ThemeController {
  /** The theme to show right now. */
  readonly theme: Theme;
  /** The user picked a theme: use it, remember it, and stop following the system. */
  choose(theme: Theme): void;
  /** Stop listening for system changes. */
  stop(): void;
}

/**
 * The theme rules, without React: start from the saved pick or the system setting,
 * follow the system until the user picks, then stick to (and save) the pick.
 * `onChange` is called whenever the theme to show changes, with what caused it.
 */
export function createThemeController(
  onChange: (theme: Theme, cause: ThemeCause) => void,
  env: ThemeEnv = browserEnv(),
): ThemeController {
  let picked = savedTheme(env) !== null;
  let current = initialTheme(env);
  const stop = watchSystemTheme((theme) => {
    if (picked || theme === current) return;
    current = theme;
    onChange(theme, "system");
  }, env);
  return {
    get theme() {
      return current;
    },
    choose(theme) {
      // Even if saving fails (storage blocked), keep the pick for this session.
      picked = true;
      saveTheme(theme, env);
      if (theme === current) return;
      current = theme;
      onChange(theme, "pick");
    },
    stop,
  };
}

/** Paint the page behind the app in the theme too (index.html sets it first on launch). */
function markDocument(theme: Theme) {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
}

/**
 * The current theme and a setter for the user's pick. The rules live in
 * createThemeController; this only connects them to React state.
 *
 * A system light/dark change cross-fades the window, like the toolbar switch does.
 * The user's own pick isn't faded here: the caller already wraps it in crossFade,
 * and a second, nested transition would cut the first one short.
 */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => initialTheme());
  const controller = useRef<ThemeController | null>(null);

  useEffect(() => {
    const c = createThemeController((next, cause) => {
      if (cause === "system") crossFade(() => flushSync(() => setTheme(next)));
      else setTheme(next);
    });
    controller.current = c;
    // Catch a system change that happened between the first render and now.
    setTheme(c.theme);
    return () => {
      c.stop();
      controller.current = null;
    };
  }, []);

  // A layout effect, so the page behind the app turns in the same commit as the app
  // (and lands in the cross-fade's "after" picture) rather than a frame later.
  useLayoutEffect(() => markDocument(theme), [theme]);

  const choose = useCallback((next: Theme) => {
    if (controller.current) controller.current.choose(next);
    else {
      saveTheme(next);
      setTheme(next);
    }
  }, []);

  return [theme, choose];
}
