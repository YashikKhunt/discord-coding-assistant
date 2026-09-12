import { spawn } from "node:child_process";
import type { RepoRef } from "@dca/core";

export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

export type ResolvedRef =
  | { kind: "pr"; number: number; refspec: string }
  | { kind: "ref"; refspec: string };

const SAFE_REF = /^[\w./-]+$/;

/** `#12`, `12` and `pull/12` mean PR 12; anything else is a branch, tag or commit SHA. */
export function resolveRef(ref: string | null | undefined, defaultBranch: string): ResolvedRef {
  const value = ref?.trim() || defaultBranch;
  const pr = /^(?:#|pull\/)?(\d+)$/.exec(value);
  if (pr) {
    const number = Number(pr[1]);
    return { kind: "pr", number, refspec: `refs/pull/${number}/head` };
  }
  if (!SAFE_REF.test(value) || value.startsWith("-") || value.includes("..")) {
    throw new CheckoutError(`Invalid ref \`${value}\``);
  }
  return { kind: "ref", refspec: value };
}

function run(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
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
  });
}

export interface CheckoutOptions {
  repo: RepoRef;
  ref: ResolvedRef;
  dir: string;
  token: string;
  /** Override for tests (e.g. a local bare repository path). */
  remoteUrl?: string;
}

export interface CheckoutResult {
  commit: string;
}

/**
 * Shallow-fetches one ref into `dir`. The token is passed through GIT_CONFIG_* env vars,
 * so it never lands in `.git/config` (which is later copied into the sandbox) or in argv.
 */
export async function checkoutRepo(options: CheckoutOptions): Promise<CheckoutResult> {
  const url = options.remoteUrl ?? `https://github.com/${options.repo.fullName}.git`;
  const basic = Buffer.from(`x-access-token:${options.token}`).toString("base64");
  const authEnv = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
  const scrub = (text: string) => text.replaceAll(options.token, "***").replaceAll(basic, "***");

  const steps: { args: string[]; env?: Record<string, string>; failure: string }[] = [
    { args: ["init", "-q", "-b", "agent-base", options.dir], failure: "git init failed" },
    { args: ["remote", "add", "origin", url], failure: "git remote add failed" },
    {
      args: ["fetch", "-q", "--depth", "1", "--no-tags", "origin", options.ref.refspec],
      env: authEnv,
      failure:
        options.ref.kind === "pr"
          ? `Pull request #${options.ref.number} not found`
          : `Ref \`${options.ref.refspec}\` not found`,
    },
    {
      args: ["-c", "core.hooksPath=/dev/null", "checkout", "-q", "--detach", "FETCH_HEAD"],
      failure: "git checkout failed",
    },
  ];

  for (const [index, step] of steps.entries()) {
    const result = await run(step.args, {
      cwd: index === 0 ? undefined : options.dir,
      env: step.env,
    });
    if (result.code !== 0) {
      throw new CheckoutError(`${step.failure}: ${scrub(result.stderr.trim()).slice(0, 500)}`);
    }
  }

  const head = await run(["rev-parse", "HEAD"], { cwd: options.dir });
  return { commit: head.stdout.trim() };
}
