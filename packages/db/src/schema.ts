import { JOB_STATUSES, JOB_TYPES } from "@dca/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const jobType = pgEnum("job_type", JOB_TYPES);
export const jobStatus = pgEnum("job_status", JOB_STATUSES);
export const jobSource = pgEnum("job_source", ["discord", "dashboard"]);
export const attachmentKind = pgEnum("attachment_kind", ["image", "log", "other"]);

export interface JobInput {
  description?: string;
  steps?: string;
  expected?: string;
  issue?: string;
  base?: string;
}

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shortId: text("short_id").notNull().unique(),
    type: jobType("type").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    repo: text("repo").notNull(),
    ref: text("ref"),
    input: jsonb("input").$type<JobInput>().notNull().default({}),
    requestedByDiscordId: text("requested_by_discord_id").notNull(),
    source: jobSource("source").notNull().default("discord"),

    profileId: text("profile_id").notNull(),
    profileVersion: integer("profile_version").notNull(),
    modelPrimary: text("model_primary"),
    modelUsed: text("model_used"),

    discordForumThreadId: text("discord_forum_thread_id"),
    discordAckMessageId: text("discord_ack_message_id"),

    result: jsonb("result").$type<Record<string, unknown>>(),
    prUrl: text("pr_url"),
    error: text("error"),

    iterations: integer("iterations").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4, mode: "number" }).notNull().default(0),

    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    workerId: text("worker_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("jobs_status_created_at_idx").on(t.status, t.createdAt),
    index("jobs_created_at_idx").on(t.createdAt),
    index("jobs_repo_idx").on(t.repo),
  ],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    index("job_events_job_id_idx").on(t.jobId),
    index("job_events_unnotified_idx").on(t.id).where(sql`${t.notifiedAt} is null`),
  ],
);

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    step: integer("step").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6, mode: "number" }).notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    request: jsonb("request"),
    response: jsonb("response"),
    createdAt: createdAt(),
  },
  (t) => [
    index("llm_calls_job_id_idx").on(t.jobId),
    index("llm_calls_created_at_idx").on(t.createdAt),
  ],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    llmCallId: bigint("llm_call_id", { mode: "number" }).references(() => llmCalls.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    args: jsonb("args").notNull().default({}),
    output: text("output"),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("tool_calls_job_id_idx").on(t.jobId)],
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    kind: attachmentKind("kind").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    path: text("path").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("attachments_job_id_idx").on(t.jobId)],
);

export const jobCounters = pgTable("job_counters", {
  type: jobType("type").primaryKey(),
  lastValue: integer("last_value").notNull().default(0),
});

export const dashboardSessions = pgTable("dashboard_sessions", {
  id: text("id").primaryKey(),
  discordUserId: text("discord_user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
export type LlmCall = typeof llmCalls.$inferSelect;
export type ToolCall = typeof toolCalls.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
