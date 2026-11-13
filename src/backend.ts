// Typed wrappers for the Tauri commands in src-tauri/src/lib.rs, each of which
// calls into the C backend in backend/.
import { invoke, isTauri } from "@tauri-apps/api/core";

/** Mirrors `ffi::Identicon` in src-tauri/src/ffi.rs. */
export interface Identicon {
  /** Width and height of the grid, in cells. */
  size: number;
  /** Row-major cells; `true` means filled. */
  cells: boolean[];
  /** Foreground hue in degrees, 0-359. */
  hue: number;
}

/** Mirrors `ffi::BackendError`: what a command rejects with when C reports an error. */
export interface BackendError {
  code: number;
  message: string;
}

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    return Promise.reject(
      new Error("The C backend is only available inside the app. Start it with `npm run tauri:dev`."),
    );
  }
  return invoke<T>(command, args);
}

export const backendVersion = () => call<string>("backend_version");
export const greet = (name: string) => call<string>("greet", { name });
export const identicon = (seed: string) => call<Identicon>("identicon", { seed });

function isBackendError(error: unknown): error is BackendError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as BackendError).code === "number" &&
    typeof (error as BackendError).message === "string"
  );
}

/** Turns whatever a command rejected with into a readable message. */
export function errorMessage(error: unknown): string {
  if (isBackendError(error)) return `${error.message} (C status ${error.code})`;
  if (error instanceof Error) return error.message;
  return String(error);
}
