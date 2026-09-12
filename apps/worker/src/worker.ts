import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  claimNextJob,
  type Db,
  heartbeatJobs,
  isCancelRequested,
  type Job,
  reapStaleJobs,
  transitionJob,
} from "@dca/db";
import type { Logger } from "pino";
import { AbortedError, type JobRunner } from "./runner.ts";

export interface WorkerOptions {
  db: Db;
  runner: JobRunner;
  log: Logger;
  concurrency: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  cancelPollIntervalMs?: number;
}

interface ActiveJob {
  job: Job;
  controller: AbortController;
  done: Promise<void>;
}

export class Worker {
  readonly id = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  readonly #opts: Required<WorkerOptions>;
  readonly #active = new Map<string, ActiveJob>();
  #timers: NodeJS.Timeout[] = [];
  #stopping = false;
  #wake: (() => void) | null = null;

  constructor(options: WorkerOptions) {
    this.#opts = {
      pollIntervalMs: 2_000,
      heartbeatIntervalMs: 15_000,
      staleAfterMs: 90_000,
      cancelPollIntervalMs: 2_000,
      ...options,
    };
  }

  get activeCount(): number {
    return this.#active.size;
  }

  start(): Promise<void> {
    const { log, heartbeatIntervalMs, staleAfterMs } = this.#opts;
    log.info({ workerId: this.id, concurrency: this.#opts.concurrency }, "worker started");

    this.#timers.push(
      setInterval(() => {
        heartbeatJobs(this.#opts.db, [...this.#active.keys()]).catch((err) =>
          log.error({ err }, "heartbeat failed"),
        );
      }, heartbeatIntervalMs),
      setInterval(() => {
        this.#reap(staleAfterMs).catch((err) => log.error({ err }, "reaper failed"));
      }, staleAfterMs / 2),
    );
    return this.#loop();
  }

  /** Stops claiming, aborts running jobs after `graceMs`, and waits for them to settle. */
  async stop(graceMs = 30_000): Promise<void> {
    this.#stopping = true;
    this.#wake?.();
    for (const timer of this.#timers) clearInterval(timer);
    const pending = [...this.#active.values()];
    const timeout = setTimeout(() => {
      for (const active of pending) active.controller.abort();
    }, graceMs);
    await Promise.allSettled(pending.map((active) => active.done));
    clearTimeout(timeout);
    this.#opts.log.info({ workerId: this.id }, "worker stopped");
  }

  async #loop(): Promise<void> {
    const { db, log, concurrency, pollIntervalMs } = this.#opts;
    while (!this.#stopping) {
      let claimed: Job | null = null;
      if (this.#active.size < concurrency) {
        try {
          claimed = await claimNextJob(db, this.id);
        } catch (err) {
          log.error({ err }, "claim failed");
        }
      }
      if (claimed) {
        this.#launch(claimed);
        continue; // try to fill remaining slots immediately
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = null;
    }
  }

  #launch(job: Job): void {
    const controller = new AbortController();
    const active: ActiveJob = { job, controller, done: Promise.resolve() };
    active.done = this.#execute(job, controller).finally(() => {
      this.#active.delete(job.id);
      this.#wake?.();
    });
    this.#active.set(job.id, active);
  }

  async #execute(job: Job, controller: AbortController): Promise<void> {
    const { db, runner, cancelPollIntervalMs } = this.#opts;
    const log = this.#opts.log.child({ jobId: job.id, shortId: job.shortId });
    log.info({ type: job.type, repo: job.repo }, "job claimed");

    let cancelledByUser = false;
    const cancelPoll = setInterval(async () => {
      try {
        if (await isCancelRequested(db, job.id)) {
          cancelledByUser = true;
          controller.abort();
        }
      } catch (err) {
        log.warn({ err }, "cancel poll failed");
      }
    }, cancelPollIntervalMs);

    try {
      const outcome = await runner.run(job, {
        signal: controller.signal,
        log,
        markRunning: async () => {
          await transitionJob(db, job.id, "running");
        },
      });
      if (controller.signal.aborted) throw new AbortedError();

      const finalizing = await transitionJob(db, job.id, "finalizing", {
        iterations: outcome.iterations,
        costUsd: outcome.costUsd,
        modelUsed: outcome.modelUsed,
      });
      if (!finalizing) {
        log.warn("job left running state before finalizing; skipping result");
        return;
      }
      await transitionJob(db, job.id, outcome.status, {
        result: outcome.result,
        error: outcome.error,
        prUrl: outcome.prUrl,
        finishedAt: new Date(),
      });
      log.info({ status: outcome.status }, "job finished");
    } catch (err) {
      const finishedAt = new Date();
      if (err instanceof AbortedError || controller.signal.aborted) {
        const reason = cancelledByUser ? "Cancelled by user" : "Worker shutting down";
        await transitionJob(db, job.id, cancelledByUser ? "cancelled" : "failed", {
          error: reason,
          finishedAt,
        });
        log.info({ reason }, "job aborted");
      } else {
        log.error({ err }, "job failed");
        await transitionJob(db, job.id, "failed", {
          error: err instanceof Error ? err.message : String(err),
          finishedAt,
        });
      }
    } finally {
      clearInterval(cancelPoll);
    }
  }

  async #reap(staleAfterMs: number): Promise<void> {
    const reaped = await reapStaleJobs(this.#opts.db, new Date(Date.now() - staleAfterMs));
    for (const job of reaped) {
      this.#opts.log.warn({ shortId: job.shortId }, "reaped job from lost worker");
    }
  }
}
