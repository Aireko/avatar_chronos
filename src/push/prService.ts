// Frontend entry point for "Create pull request" (src-tauri/src/review/pr_create.rs).
// GitHub is reached only through the `gh` CLI in Rust, like PR Bug Check: no fetch() here.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { runShellCommand } from "../backend";
import { githubRepoFromRemote } from "../bugcheck/originRepo";
import { toBugCheckError, type BugCheckError } from "../bugcheck/bugCheckService";

export interface ExistingPr {
  number: number;
  title: string;
  url: string;
}

export interface PrCreateInfo {
  defaultBranch: string;
  existing: ExistingPr | null;
}

export interface CreatedPr {
  number: number;
  url: string;
}

export interface NewPrInput {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

const NOT_IN_APP: BugCheckError = {
  kind: "internal",
  message: "Creating pull requests is only available inside the desktop app",
  hint: "Start the app with 'npm run tauri:dev' instead of opening the Vite page in a browser",
};

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NOT_IN_APP;
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toBugCheckError(error);
  }
}

/** `owner/name` of the clone's `origin` remote, or undefined when it is not on github.com. */
export async function githubRepoOf(repoPath: string): Promise<string | undefined> {
  try {
    const result = await runShellCommand(repoPath, "git remote get-url origin");
    return result.ok ? githubRepoFromRemote(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** The repo's default branch and the open PR of `head`, if any. */
export const prInfo = (repo: string, head: string) => call<PrCreateInfo>("pr_create_info", { repo, head });

/** Opens a pull request from `head` into `base`. `head` must already be pushed. */
export const createPr = (input: NewPrInput) =>
  call<CreatedPr>("pr_create_open", {
    repo: input.repo,
    head: input.head,
    base: input.base,
    title: input.title,
    body: input.body,
    draft: input.draft,
  });