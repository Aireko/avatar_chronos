// A whole-window cross-fade for changes that repaint everything at once, like
// switching between the paper and blackboard themes.
//
// It uses the browser's View Transitions API: the old frame is captured as a
// single image and faded into the new one by the compositor, so the app itself
// is only re-rendered once (no per-element colour transitions). Where the API is
// missing, the user prefers reduced motion, or the window is hidden (say the system
// theme flips while the app is minimised), the change simply applies at once.
// The fade's timing lives in tools.css (::view-transition-old/new(root)).

/** The parts of `window`/`document` this module uses, so tests can pass fakes. */
export interface CrossFadeEnv {
  startViewTransition?: ((update: () => void) => unknown) | null;
  reducedMotion?: boolean;
  /** Nobody can see the window, so there is nothing to fade (the browser would skip it anyway). */
  hidden?: boolean;
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
  };
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
  let ran = false;
  const once = () => {
    if (ran) return;
    ran = true;
    update();
  };
  try {
    const transition = env.startViewTransition(once) as
      | { ready?: unknown; finished?: unknown; updateCallbackDone?: unknown }
      | undefined;
    quiet(transition?.ready);
    quiet(transition?.finished);
    quiet(transition?.updateCallbackDone);
    return true;
  } catch {
    // The browser refused to start one: still apply the change.
    once();
    return false;
  }
}
