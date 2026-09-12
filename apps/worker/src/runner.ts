import type { Job } from "@dca/db";
import type { Logger } from "pino";

export interface RunContext {
  /** Aborted when the user cancels the job or the worker shuts down. */
  signal: AbortSignal;
  log: Logger;
  /** Call once setup is done (repo cloned, sandbox ready) to move the job to `running`. */
  markRunning: () => Promise<void>;
}

export interface RunOutcome {
  status: "succeeded" | "partial" | "failed";
  result?: Record<string, unknown>;
  error?: string;
  prUrl?: string;
  iterations: number;
  costUsd: number;
  modelUsed?: string;
}

export interface JobRunner {
  run(job: Job, ctx: RunContext): Promise<RunOutcome>;
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Placeholder runner for M1: pretends to work so the Discord round-trip can be exercised. */
export class StubRunner implements JobRunner {
  readonly #durationMs: number;

  constructor(options: { durationMs?: number } = {}) {
    this.#durationMs = options.durationMs ?? 5_000;
  }

  async run(job: Job, ctx: RunContext): Promise<RunOutcome> {
    await ctx.markRunning();
    await sleep(this.#durationMs, ctx.signal);
    ctx.log.info({ shortId: job.shortId }, "stub run finished");
    return {
      status: "succeeded",
      iterations: 1,
      costUsd: 0,
      modelUsed: "stub",
      result: {
        model: "stub",
        summary: `Stub worker received this ${job.type} for \`${job.repo}\`. The real agent arrives in M3/M4.`,
      },
    };
  }
}
