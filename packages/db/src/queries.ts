import { formatShortId, type JobDto, type JobStatus, type JobType, sourcesFor } from "@dca/core";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql, sum } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  type Job,
  type JobEvent,
  jobCounters,
  jobEvents,
  jobs,
  llmCalls,
  type NewJob,
  toolCalls,
} from "./schema.ts";

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

export type CreateJobInput = Omit<
  NewJob,
  "shortId" | "status" | "createdAt" | "workerId" | "heartbeatAt"
>;

/**
 * Inserts a job with a fresh short ID and a `created` event in one transaction.
 * Inserting the row is also what enqueues it: workers claim `queued` rows directly.
 */
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

export type TransitionPatch = Partial<
  Pick<
    NewJob,
    | "error"
    | "result"
    | "prUrl"
    | "modelUsed"
    | "startedAt"
    | "finishedAt"
    | "iterations"
    | "costUsd"
    | "workerId"
  >
>;

/**
 * Moves a job to `to` only if its current status allows it (checked in SQL, so
 * concurrent workers/cancels cannot race past the state machine). Returns the
 * updated job, or null if the transition was not allowed.
 */
export async function transitionJob(
  db: Db,
  jobId: string,
  to: JobStatus,
  patch: TransitionPatch = {},
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

/** Claims the oldest queued job for a worker (safe with many concurrent workers). */
export async function claimNextJob(db: Db, workerId: string): Promise<Job | null> {
  return db.transaction(async (tx) => {
    const next = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.status, "queued"))
      .orderBy(asc(jobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const now = new Date();
    const [job] = await tx
      .update(jobs)
      .set({ status: "preparing", workerId, startedAt: now, heartbeatAt: now })
      // `= (subquery)`, not `IN (subquery)`: with IN, Postgres may re-run the LIMIT 1
      // SKIP LOCKED subquery and claim several rows, orphaning all but the first.
      .where(sql`${jobs.id} = (${next})`)
      .returning();
    if (!job) return null;
    await tx
      .insert(jobEvents)
      .values({ jobId: job.id, type: "status.preparing", payload: { workerId } });
    return job;
  });
}

export async function heartbeatJobs(db: Db, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await db.update(jobs).set({ heartbeatAt: new Date() }).where(inArray(jobs.id, jobIds));
}

/** Fails active jobs whose worker stopped heartbeating. Returns the reaped jobs. */
export async function reapStaleJobs(db: Db, staleBefore: Date): Promise<Job[]> {
  const stale = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["preparing", "running", "finalizing"]),
        lt(jobs.heartbeatAt, staleBefore),
      ),
    );
  const reaped: Job[] = [];
  for (const { id } of stale) {
    const job = await transitionJob(db, id, "failed", {
      error: "worker_lost",
      finishedAt: new Date(),
    });
    if (job) reaped.push(job);
  }
  return reaped;
}

export type CancelOutcome =
  | { kind: "cancelled"; job: Job }
  | { kind: "requested"; job: Job }
  | { kind: "not_cancellable"; job: Job }
  | { kind: "not_found" };

/** Queued jobs are cancelled immediately; running ones are flagged for the worker to stop. */
export async function requestCancel(db: Db, shortId: string): Promise<CancelOutcome> {
  const job = await getJobByShortId(db, shortId);
  if (!job) return { kind: "not_found" };

  if (job.status === "queued") {
    const cancelled = await transitionJob(db, job.id, "cancelled", { finishedAt: new Date() });
    if (cancelled) return { kind: "cancelled", job: cancelled };
  }

  const [flagged] = await db
    .update(jobs)
    .set({ cancelRequestedAt: sql`coalesce(${jobs.cancelRequestedAt}, now())` })
    .where(and(eq(jobs.id, job.id), inArray(jobs.status, ["preparing", "running"])))
    .returning();
  if (flagged) return { kind: "requested", job: flagged };

  return { kind: "not_cancellable", job: (await getJobByShortId(db, shortId)) ?? job };
}

export async function isCancelRequested(db: Db, jobId: string): Promise<boolean> {
  const [row] = await db
    .select({ at: jobs.cancelRequestedAt })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  return Boolean(row?.at);
}

export async function getJobByShortId(db: Db, shortId: string): Promise<Job | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.shortId, shortId));
  return job ?? null;
}

export async function getJobById(db: Db, id: string): Promise<Job | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  return job ?? null;
}

export interface ListJobsFilter {
  limit?: number;
  status?: JobStatus;
  type?: JobType;
  requestedByDiscordId?: string;
}

export async function listJobs(db: Db, filter: ListJobsFilter = {}): Promise<Job[]> {
  const conditions = [
    filter.status ? eq(jobs.status, filter.status) : undefined,
    filter.type ? eq(jobs.type, filter.type) : undefined,
    filter.requestedByDiscordId
      ? eq(jobs.requestedByDiscordId, filter.requestedByDiscordId)
      : undefined,
  ].filter((condition) => condition !== undefined);
  return db
    .select()
    .from(jobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(jobs.createdAt))
    .limit(Math.min(filter.limit ?? 10, 100));
}

/** 1-based position among queued jobs, or null if the job is no longer queued. */
export async function queuePosition(db: Db, job: Pick<Job, "status" | "createdAt">) {
  if (job.status !== "queued") return null;
  const [row] = await db
    .select({ ahead: count() })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), lt(jobs.createdAt, job.createdAt)));
  return (row?.ahead ?? 0) + 1;
}

export function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function monthSpendUsd(db: Db, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sum(llmCalls.costUsd) })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, startOfMonthUtc(now)));
  return Number(row?.total ?? 0);
}

export async function listJobEvents(db: Db, jobId: string): Promise<JobEvent[]> {
  return db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(asc(jobEvents.id));
}

export interface PendingEvent {
  event: JobEvent;
  job: Job;
}

/** Oldest events not yet delivered to Discord (outbox). */
export async function fetchPendingEvents(db: Db, limit = 50): Promise<PendingEvent[]> {
  const rows = await db
    .select({ event: jobEvents, job: jobs })
    .from(jobEvents)
    .innerJoin(jobs, eq(jobEvents.jobId, jobs.id))
    .where(isNull(jobEvents.notifiedAt))
    .orderBy(asc(jobEvents.id))
    .limit(limit);
  return rows;
}

export async function markEventsNotified(db: Db, eventIds: number[]): Promise<void> {
  if (eventIds.length === 0) return;
  await db.update(jobEvents).set({ notifiedAt: new Date() }).where(inArray(jobEvents.id, eventIds));
}

export async function setDiscordThread(
  db: Db,
  jobId: string,
  ids: { threadId?: string; ackMessageId?: string },
): Promise<void> {
  await db
    .update(jobs)
    .set({
      ...(ids.threadId ? { discordForumThreadId: ids.threadId } : {}),
      ...(ids.ackMessageId ? { discordAckMessageId: ids.ackMessageId } : {}),
    })
    .where(eq(jobs.id, jobId));
}

export function toJobDto(job: Job): JobDto {
  return {
    id: job.id,
    shortId: job.shortId,
    type: job.type,
    status: job.status,
    repo: job.repo,
    ref: job.ref,
    input: { ...job.input },
    requestedByDiscordId: job.requestedByDiscordId,
    source: job.source,
    discordForumThreadId: job.discordForumThreadId,
    result: job.result,
    prUrl: job.prUrl,
    error: job.error,
    iterations: job.iterations,
    costUsd: job.costUsd,
    cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}

export interface LlmCallInput {
  jobId: string;
  step: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  request?: unknown;
  response?: unknown;
}

/** Records a model call and adds its cost to the job in one transaction. */
export async function recordLlmCall(db: Db, input: LlmCallInput): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(llmCalls).values(input).returning({ id: llmCalls.id });
    await tx
      .update(jobs)
      .set({
        costUsd: sql`${jobs.costUsd} + ${input.costUsd}`,
        iterations: sql`greatest(${jobs.iterations}, ${input.step})`,
      })
      .where(eq(jobs.id, input.jobId));
    if (!row) throw new Error("Failed to record llm call");
    return row.id;
  });
}

export interface ToolCallInput {
  jobId: string;
  llmCallId: number | null;
  name: string;
  args: unknown;
  output: string;
  exitCode: number | null;
  durationMs: number;
}

export async function recordToolCall(db: Db, input: ToolCallInput): Promise<void> {
  await db.insert(toolCalls).values({ ...input, args: input.args ?? {} });
}
