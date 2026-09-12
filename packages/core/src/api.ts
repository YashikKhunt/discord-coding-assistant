import { z } from "zod";
import { JOB_STATUSES, JOB_TYPES } from "./jobs.ts";

/** Wire contracts between api and its callers (bot, dashboard). */

export const attachmentInput = z.object({
  url: z.url(),
  filename: z.string().min(1).max(200),
  contentType: z.string().max(100).optional(),
  size: z.number().int().nonnegative(),
});
export type AttachmentInput = z.infer<typeof attachmentInput>;

export const createJobRequest = z.object({
  type: z.enum(JOB_TYPES),
  repo: z.string().min(3).max(140),
  ref: z.string().max(255).optional(),
  input: z
    .object({
      description: z.string().max(6000).optional(),
      steps: z.string().max(4000).optional(),
      expected: z.string().max(2000).optional(),
      issue: z.string().max(300).optional(),
      base: z.string().max(255).optional(),
    })
    .default({}),
  requestedByDiscordId: z.string().regex(/^\d{17,20}$/),
  source: z.enum(["discord", "dashboard"]).default("discord"),
  attachments: z.array(attachmentInput).max(3).default([]),
});
export type CreateJobRequest = z.input<typeof createJobRequest>;

export const listJobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(JOB_TYPES).optional(),
  requestedBy: z.string().optional(),
});

export interface JobDto {
  id: string;
  shortId: string;
  type: (typeof JOB_TYPES)[number];
  status: (typeof JOB_STATUSES)[number];
  repo: string;
  ref: string | null;
  input: Record<string, string | undefined>;
  requestedByDiscordId: string;
  source: "discord" | "dashboard";
  discordForumThreadId: string | null;
  result: Record<string, unknown> | null;
  prUrl: string | null;
  error: string | null;
  iterations: number;
  costUsd: number;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface CreateJobResponse {
  job: JobDto;
  position: number | null;
}

export type ApiErrorCode =
  | "invalid_request"
  | "invalid_repo"
  | "repo_not_accessible"
  | "spend_cap_reached"
  | "attachment_rejected"
  | "not_found"
  | "not_cancellable"
  | "unauthorized"
  | "github_error"
  | "internal";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
