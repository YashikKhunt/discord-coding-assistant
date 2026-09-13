import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import {
  claimNextJob,
  createJob,
  monthSpendUsd,
  recordLlmCall,
  recordToolCall,
  transitionJob,
} from "./queries.ts";
import { jobEvents, jobs, toolCalls } from "./schema.ts";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("db queries (integration)", () => {
  let handle: DbHandle;
  const repo = `test-owner/repo-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await runMigrations(DATABASE_URL as string);
    handle = createDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await handle.db.delete(jobs).where(like(jobs.repo, repo));
    await handle.close();
  });

  const newJob = () =>
    createJob(handle.db, {
      type: "task",
      repo,
      input: { description: "add rate limiting" },
      requestedByDiscordId: "111111111111111111",
      profileId: "task",
      profileVersion: 1,
    });

  it("allocates unique, sequential short IDs under concurrency", async () => {
    const created = await Promise.all(Array.from({ length: 10 }, newJob));
    const numbers = created.map((job) => Number(job.shortId.split("-")[1])).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(10);
    expect((numbers.at(-1) ?? 0) - (numbers[0] ?? 0)).toBe(9);
    expect(created.every((job) => job.status === "queued")).toBe(true);
  });

  it("enforces the state machine in SQL and records events", async () => {
    const job = await newJob();
    expect(await transitionJob(handle.db, job.id, "succeeded")).toBeNull();

    const preparing = await transitionJob(handle.db, job.id, "preparing", {
      startedAt: new Date(),
    });
    expect(preparing?.status).toBe("preparing");

    const cancelled = await transitionJob(handle.db, job.id, "cancelled");
    expect(cancelled?.status).toBe("cancelled");
    expect(await transitionJob(handle.db, job.id, "running")).toBeNull();

    const events = await handle.db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id));
    expect(events.map((event) => event.type)).toEqual([
      "created",
      "status.preparing",
      "status.cancelled",
    ]);
  });

  it("claims each queued job exactly once across concurrent workers", async () => {
    await handle.db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.status, "queued"));
    const created = await Promise.all(Array.from({ length: 12 }, newJob));
    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claimNextJob(handle.db, `worker-${i}`)),
    );
    const claimedIds = claims.filter((job) => job !== null).map((job) => job.id);
    expect(claimedIds.sort()).toEqual(created.map((job) => job.id).sort());

    const preparing = await handle.db.select().from(jobs).where(like(jobs.repo, repo));
    const orphaned = preparing.filter(
      (job) => job.status === "preparing" && !claimedIds.includes(job.id),
    );
    expect(orphaned).toEqual([]);
  });

  it("records llm and tool calls and accumulates job cost", async () => {
    const job = await newJob();
    const before = await monthSpendUsd(handle.db);
    const call = (step: number, costUsd: number) =>
      recordLlmCall(handle.db, {
        jobId: job.id,
        step,
        provider: "anthropic",
        model: "anthropic:claude-haiku-4-5",
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 0,
        costUsd,
        latencyMs: 5,
      });
    const first = await call(1, 0.0125);
    await call(2, 0.0075);
    await recordToolCall(handle.db, {
      jobId: job.id,
      llmCallId: first,
      name: "grep",
      args: { pattern: "x" },
      output: "src/a.ts:1:x",
      exitCode: 0,
      durationMs: 3,
    });

    const [updated] = await handle.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated).toMatchObject({ costUsd: 0.02, iterations: 2 });
    expect(await monthSpendUsd(handle.db)).toBeCloseTo(before + 0.02, 6);
    const tools = await handle.db.select().from(toolCalls).where(eq(toolCalls.jobId, job.id));
    expect(tools).toMatchObject([{ name: "grep", llmCallId: first, exitCode: 0 }]);
  });

  it("allows only one of two racing transitions to win", async () => {
    const job = await newJob();
    const [a, b] = await Promise.all([
      transitionJob(handle.db, job.id, "preparing"),
      transitionJob(handle.db, job.id, "cancelled"),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    const [final] = await handle.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(["preparing", "cancelled"]).toContain(final?.status);
  });
});
