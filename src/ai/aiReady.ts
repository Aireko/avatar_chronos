// Whether the local AI can run a prompt handed in by the app (e.g. "Explain this
// commit"). Pure, so it is tested without a DOM.
import type { AiError, AiStatus } from "./types";

/** Why a handed-in prompt can't run yet, or null when the model is ready. */
export function notReadyReason(status: AiStatus | undefined, statusError: AiError | undefined): string | null {
  if (statusError) return `Ollama could not be checked: ${statusError.message}`;
  if (!status) return "The local AI is still being checked.";
  if (status.configError) return status.configError.message;
  if (!status.connection.reachable) return "Ollama is not running. Start it, then choose Refresh and Generate.";
  if (status.selectedModelInstalled !== true) {
    return "The selected model is not installed yet. Download it above, then choose Generate.";
  }
  return null;
}
