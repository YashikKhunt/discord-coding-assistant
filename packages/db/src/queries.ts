import { formatShortId, type JobStatus, type JobType, sourcesFor } from "@dca/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { type Job, jobCounters, jobEvents, jobs, type NewJob } from "./schema.ts";

type Executor = Pick<Db, "insert" | "update" | "select">;

/** Atomically allocates the next per-type sequence number and returns e.g. `TASK-0042`. */
export async function nextShortId(tx: Executor, type: JobType): Promise<string> {
  const [row] = await tx
    .insert(jobCounters)
    .values({ type, lastValue: 1 })
    .onConflictDoUpdate({
      target: jobCounters.type,
      set: { lastValue: sql`${jobCounters.lastValue} + 1` },
    })
    .returning({ value: jobCounters.lastValue });
  if (!row) throw new Error(`Failed to allocate job id for ${type}`);
  return formatShortId(type, row.value);
}

export type CreateJobInput = Omit<NewJob, "id" | "shortId" | "status" | "createdAt">;

/** Inserts a job with a fresh short ID and a `created` event in one transaction. */
export async function createJob(db: Db, input: CreateJobInput): Promise<Job> {
  return db.transaction(async (tx) => {
    const shortId = await nextShortId(tx, input.type);
    const [job] = await tx
      .insert(jobs)
      .values({ ...input, shortId })
      .returning();
    if (!job) throw new Error("Failed to insert job");
    await tx.insert(jobEvents).values({ jobId: job.id, type: "created", payload: { shortId } });
    return job;
  });
}

/**
 * Moves a job to `to` only if its current status allows it (checked in SQL, so
 * concurrent workers/cancels cannot race past the state machine). Returns the
 * updated job, or null if the transition was not allowed.
 */
export async function transitionJob(
  db: Db,
  jobId: string,
  to: JobStatus,
  patch: Partial<
    Pick<NewJob, "error" | "result" | "prUrl" | "modelUsed" | "startedAt" | "finishedAt">
  > = {},
): Promise<Job | null> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .update(jobs)
      .set({ ...patch, status: to })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, sourcesFor(to))))
      .returning();
    if (!job) return null;
    await tx
      .insert(jobEvents)
      .values({ jobId, type: `status.${to}`, payload: patch.error ? { error: patch.error } : {} });
    return job;
  });
}
