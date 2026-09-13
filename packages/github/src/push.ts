import { spawn } from "node:child_process";
import type { RepoRef } from "@dca/core";
import { CheckoutError, checkoutRepo } from "./checkout.ts";

export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushError";
  }
}

function git(
  args: string[],
  options: { cwd: string; env?: Record<string, string>; stdin?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      // Global and system git config are ignored so nothing from the host (or the repo) can
      // inject hooks, filters or credential helpers into this process.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: options.cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 10_000) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(options.stdin);
  });
}

export interface PushPatchOptions {
  repo: RepoRef;
  /** Commit the patch was produced against. */
  baseCommit: string;
  patch: string;
  branch: string;
  message: string;
  author: { name: string; email: string };
  token: string;
  /** Empty directory for the fresh clone. */
  dir: string;
  /** Override for tests (local bare repository). */
  remoteUrl?: string;
}

const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

/**
 * Applies a patch to a fresh clone of the base commit and pushes it as a new branch. The
 * sandbox's own working tree and .git are never used on the host: a hostile repository could
 * have planted hooks or filter drivers there.
 */
export async function pushPatch(options: PushPatchOptions): Promise<{ commit: string }> {
  if (!SAFE_BRANCH.test(options.branch) || options.branch.includes("..")) {
    throw new PushError(`Invalid branch name ${options.branch}`);
  }
  try {
    await checkoutRepo({
      repo: options.repo,
      ref: { kind: "ref", refspec: options.baseCommit },
      dir: options.dir,
      token: options.token,
      remoteUrl: options.remoteUrl,
    });
  } catch (error) {
    if (error instanceof CheckoutError) throw new PushError(error.message);
    throw error;
  }

  const basic = Buffer.from(`x-access-token:${options.token}`).toString("base64");
  const scrub = (text: string) => text.replaceAll(options.token, "***").replaceAll(basic, "***");
  const noHooks = ["-c", "core.hooksPath=/dev/null"];

  const apply = await git([...noHooks, "apply", "--index", "--whitespace=nowarn", "-"], {
    cwd: options.dir,
    stdin: options.patch,
  });
  if (apply.code !== 0)
    throw new PushError(`git apply failed: ${apply.stderr.trim().slice(0, 500)}`);

  const identity = {
    GIT_AUTHOR_NAME: options.author.name,
    GIT_AUTHOR_EMAIL: options.author.email,
    GIT_COMMITTER_NAME: options.author.name,
    GIT_COMMITTER_EMAIL: options.author.email,
  };
  const commit = await git([...noHooks, "commit", "-q", "--no-verify", "-F", "-"], {
    cwd: options.dir,
    env: identity,
    stdin: options.message,
  });
  if (commit.code !== 0)
    throw new PushError(`git commit failed: ${commit.stderr.trim().slice(0, 500)}`);

  const push = await git(
    [...noHooks, "push", "-q", "--no-verify", "origin", `HEAD:refs/heads/${options.branch}`],
    {
      cwd: options.dir,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      },
    },
  );
  if (push.code !== 0)
    throw new PushError(`git push failed: ${scrub(push.stderr.trim()).slice(0, 500)}`);

  const head = await git(["rev-parse", "HEAD"], { cwd: options.dir });
  return { commit: head.stdout.trim() };
}

export function branchSlug(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "change";
}
