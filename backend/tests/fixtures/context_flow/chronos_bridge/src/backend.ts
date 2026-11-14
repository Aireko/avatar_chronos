import { invoke } from "@tauri-apps/api/core";

export function call<T>(command: string, args?: unknown): Promise<T> {
  return invoke<T>(command, args);
}

export const backendVersion = () => call<string>("backend_version");
export const directVersion = () => invoke<string>("backend_version");
export const exportGraph = () => call<number>("export_graph");
