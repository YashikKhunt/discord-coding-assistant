import {
  createDb,
  createJob,
  type DbHandle,
  getJobById,
  type Job,
  jobs,
  requestCancel,
} from "@dca/db";
import { runMigrations } from "@dca/db/migrate";
import { eq, like } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type JobRunner, type RunOutcome, sleep } from "./runner.ts";
import { Worker } from "./worker.ts";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const REPO_PREFIX = `worker-test-${Date.now()}`;
const log = pino({ level: "silent" });

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

describe.skipIf(!DATABASE_URL)("worker (integration)", () => {
  let handle: DbHandle;
  const workers: Worker[] = [];

  beforeAll(async () => {
    await runMigrations(DATABASE_URL as string);
    handle = createDb(DATABASE_URL as string);
    // Test database only: clear leftovers so this worker claims just its own jobs.
    await handle.db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.status, "queued"));
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop(0)));
  });

  afterAll(async () => {
    await handle.db.delete(jobs).where(like(jobs.repo, `${REPO_PREFIX}/%`));
    await handle.close();
  });

  const enqueue = (name: string) =>
    createJob(handle.db, {
      type: "runtest",
      repo: `${REPO_PREFIX}/${name}`,
      requestedByDiscordId: "111111111111111111",
      profileId: "runtest",
      profileVersion: 1,
    });

  const startWorker = (runner: JobRunner, concurrency = 2) => {
    const worker = new Worker({
      db: handle.db,
      runner,
      log,
      concurrency,
      pollIntervalMs: 20,
      cancelPollIntervalMs: 20,
    });
    workers.push(worker);
    void worker.start();
    return worker;
  };

  const settled = (job: Job) =>
    waitFor(async () => {
      const current = await getJobById(handle.db, job.id);
      return current && ["succeeded", "partial", "failed", "cancelled"].includes(current.status)
        ? current
        : null;
    });

  it("runs jobs to completion and respects concurrency", async () => {
    let running = 0;
    let maxRunning = 0;
    const runner: JobRunner = {
      async run(_job, ctx): Promise<RunOutcome> {
        await ctx.markRunning();
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(100, ctx.signal);
        running--;
        return { status: "succeeded", iterations: 3, costUsd: 0.12, result: { summary: "ok" } };
      },
    };
    const queued = await Promise.all([enqueue("a"), enqueue("b"), enqueue("c")]);
    startWorker(runner, 2);

    const finished = await Promise.all(queued.map(settled));
    expect(finished.map((job) => job.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(finished[0]).toMatchObject({ iterations: 3, costUsd: 0.12, result: { summary: "ok" } });
    expect(finished[0]?.finishedAt).toBeInstanceOf(Date);
    expect(maxRunning).toBe(2);
  });

  it("cancels a running job when the user requests it", async () => {
    const runner: JobRunner = {
      async run(_job, ctx) {
        await ctx.markRunning();
        await sleep(10_000, ctx.signal);
        return { status: "succeeded", iterations: 0, costUsd: 0 };
      },
    };
    const job = await enqueue("cancel-me");
    startWorker(runner);
    await waitFor(async () => (await getJobById(handle.db, job.id))?.status === "running");

    expect((await requestCancel(handle.db, job.shortId)).kind).toBe("requested");
    const final = await settled(job);
    expect(final.status).toBe("cancelled");
    expect(final.error).toBe("Cancelled by user");
  });

  it("records a failed outcome returned before the job started running", async () => {
    const job = await enqueue("setup-failure");
    startWorker({
      async run() {
        return {
          status: "failed",
          error: "Ref `nope` not found",
          result: { kind: "runtest", outcome: "error" },
          iterations: 0,
          costUsd: 0,
        };
      },
    });
    const final = await settled(job);
    expect(final).toMatchObject({
      status: "failed",
      error: "Ref `nope` not found",
      result: { kind: "runtest", outcome: "error" },
    });
  });

  it("marks jobs failed when the runner throws", async () => {
    const job = await enqueue("boom");
    startWorker({
      async run() {
        throw new Error("clone failed");
      },
    });
    const final = await settled(job);
    expect(final).toMatchObject({ status: "failed", error: "clone failed" });
  });
});
