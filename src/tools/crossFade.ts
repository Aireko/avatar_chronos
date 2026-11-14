// A whole-window cross-fade for changes that repaint everything at once, like
// switching between the paper and blackboard themes.
//
// It uses the browser's View Transitions API: the old frame is captured as a
// single image and faded into the new one by the compositor, so the app itself
// is only re-rendered once. Elements with their own colour transitions (buttons,
// fields, tabs) would otherwise fade a second time inside the new frame, starting
// from the old theme's colours, so while the fade runs the root carries
// data-cross-fading and tools.css switches every transition off.
// Where the API is missing, the user prefers reduced motion, or the window is hidden
// (say the system theme flips while the app is minimised), the change simply applies
// at once. The fade's timing lives in tools.css (::view-transition-old/new(root)).

/** Set on the root element while a cross-fade runs. */
export const CROSS_FADING_ATTR = "data-cross-fading";

/** Longest a cross-fade may keep transitions off, in case `finished` never settles. */
const MAX_FADE_MS = 1000;

/**
 * The latest fade started on each root. A second theme switch mid-fade skips the first
 * transition, whose clean-up must not switch transitions back on under the second one.
 */
const latestFade = new WeakMap<object, number>();
let fadeSeq = 0;

/** The parts of `window`/`document` this module uses, so tests can pass fakes. */
export interface CrossFadeEnv {
  startViewTransition?: ((update: () => void) => unknown) | null;
  reducedMotion?: boolean;
  /** Nobody can see the window, so there is nothing to fade (the browser would skip it anyway). */
  hidden?: boolean;
  /** Where the "fading now" flag goes (the <html> element in the app). */
  root?: Pick<Element, "setAttribute" | "removeAttribute"> | null;
}

function browserEnv(): CrossFadeEnv {
  if (typeof document === "undefined" || typeof window === "undefined") return {};
  const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
  let reducedMotion = false;
  try {
    reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    reducedMotion = false;
  }
  return {
    startViewTransition: typeof doc.startViewTransition === "function" ? doc.startViewTransition.bind(doc) : null,
    reducedMotion,
    hidden: document.visibilityState === "hidden",
    root: document.documentElement,
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === "function";
}

/** Swallows a promise's rejection (a skipped transition rejects `ready`/`finished`). */
function quiet(value: unknown) {
  if (value && typeof (value as Promise<unknown>).catch === "function") (value as Promise<unknown>).catch(() => {});
}

/**
 * Runs `update` (which must change the DOM synchronously, e.g. through React's
 * flushSync) inside a cross-fade when one is possible. `update` always runs
 * exactly once. Returns true when a cross-fade was started.
 */
export function crossFade(update: () => void, env: CrossFadeEnv = browserEnv()): boolean {
  if (env.reducedMotion || env.hidden || typeof env.startViewTransition !== "function") {
    update();
    return false;
  }

  const root = env.root ?? null;
  const fade = ++fadeSeq;
  if (root) latestFade.set(root, fade);
  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    if (root && latestFade.get(root) === fade) root.removeAttribute(CROSS_FADING_ATTR);
  };
  // Until the transition says when it is finished, clear the flag right after the update.
  let waitForFinish = false;
  let ran = false;
  const once = () => {
    if (ran) return;
    ran = true;
    try {
      update();
    } finally {
      if (!waitForFinish) clear();
    }
  };

  root?.setAttribute(CROSS_FADING_ATTR, "");
  try {
    const transition = env.startViewTransition(once) as
      | { ready?: unknown; finished?: unknown; updateCallbackDone?: unknown }
      | undefined;
    quiet(transition?.ready);
    quiet(transition?.updateCallbackDone);
    const finished = transition?.finished;
    if (isThenable(finished) && !ran) {
      waitForFinish = true;
      finished.then(clear, clear);
      globalThis.setTimeout?.(clear, MAX_FADE_MS);
    } else {
      quiet(finished);
      if (ran) clear();
      // Otherwise `once` clears the flag when the browser runs the update.
    }
    return true;
  } catch {
    // The browser refused to start one: still apply the change.
    once();
    clear();
    return false;
  }
}
