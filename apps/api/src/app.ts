import { randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  type ApiErrorBody,
  type ApiErrorCode,
  type CreateJobResponse,
  createJobRequest,
  listJobsQuery,
  parseRepo,
  parseShortId,
} from "@dca/core";
import {
  attachments as attachmentsTable,
  createJob,
  type Db,
  getJobByShortId,
  listJobEvents,
  listJobs,
  monthSpendUsd,
  queuePosition,
  requestCancel,
  toJobDto,
} from "@dca/db";
import { GitHubApiError, type GitHubClient } from "@dca/github";
import { getProfile } from "@dca/profiles";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { AttachmentRejectedError, downloadAttachments, type Fetcher } from "./attachments.ts";
import { type DashboardDeps, dashboardPlugin } from "./dashboard.ts";

export interface AppDeps {
  dashboard?: DashboardDeps;
  db: Db;
  github: GitHubClient;
  internalToken: string;
  attachmentsDir: string;
  monthlyLlmCapUsd: number;
  fetch?: Fetcher;
  logger?: boolean | { level: string };
}

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  invalid_repo: 400,
  attachment_rejected: 400,
  unauthorized: 401,
  spend_cap_reached: 402,
  repo_not_accessible: 403,
  not_found: 404,
  not_cancellable: 409,
  internal: 500,
  github_error: 502,
};

function sendError(reply: FastifyReply, code: ApiErrorCode, message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(STATUS_BY_CODE[code]).send(body);
}

function tokensMatch(expected: string, header: string | undefined): boolean {
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

const REPO_ACCESS_MESSAGES = {
  not_found: "Repository not found, or the bot account is not a collaborator on it.",
  no_push_permission: "The bot account can see this repository but cannot push to it.",
  archived: "Repository is archived.",
} as const;

export type SubmitResult =
  | { ok: true; response: CreateJobResponse }
  | { ok: false; code: ApiErrorCode; message: string };

/** Validates and enqueues a job. Shared by the bot's internal route and the dashboard. */
export async function submitJob(
  deps: AppDeps,
  body: z.infer<typeof createJobRequest>,
): Promise<SubmitResult> {
  const repo = parseRepo(body.repo);
  if (!repo)
    return { ok: false, code: "invalid_repo", message: "Repository must be exactly `owner/repo`." };
  if (body.type !== "runtest" && !body.input.description?.trim()) {
    return { ok: false, code: "invalid_request", message: "A description is required." };
  }

  const access = await deps.github.checkRepoAccess(repo);
  if (!access.ok) {
    return { ok: false, code: "repo_not_accessible", message: REPO_ACCESS_MESSAGES[access.reason] };
  }

  const profile = getProfile(body.type);
  const spent = await monthSpendUsd(deps.db);
  if (spent + profile.limits.maxUsd > deps.monthlyLlmCapUsd) {
    return {
      ok: false,
      code: "spend_cap_reached",
      message: `Monthly LLM budget reached ($${spent.toFixed(2)} of $${deps.monthlyLlmCapUsd} used; this job may cost up to $${profile.limits.maxUsd}).`,
    };
  }

  const jobId = randomUUID();
  let stored: Awaited<ReturnType<typeof downloadAttachments>> = [];
  try {
    stored = await downloadAttachments(body.attachments, {
      dir: deps.attachmentsDir,
      jobId,
      fetch: deps.fetch,
    });
  } catch (error) {
    await rm(path.join(deps.attachmentsDir, jobId), { recursive: true, force: true });
    if (error instanceof AttachmentRejectedError) {
      return { ok: false, code: "attachment_rejected", message: error.message };
    }
    throw error;
  }

  const job = await createJob(deps.db, {
    id: jobId,
    type: body.type,
    repo: repo.fullName,
    ref: body.ref?.trim() || body.input.base?.trim() || null,
    input: body.input,
    requestedByDiscordId: body.requestedByDiscordId,
    source: body.source,
    profileId: profile.id,
    profileVersion: profile.version,
    modelPrimary: profile.model.primary,
  });
  if (stored.length) {
    await deps.db
      .insert(attachmentsTable)
      .values(stored.map((attachment) => ({ ...attachment, jobId: job.id })));
  }
  return {
    ok: true,
    response: { job: toJobDto(job), position: await queuePosition(deps.db, job) },
  };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      const message = error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return sendError(reply, "invalid_request", message);
    }
    if (error instanceof GitHubApiError) {
      request.log.error({ err: error }, "github request failed");
      const hint =
        error.status === 401 ? " The bot token is invalid or expired (GITHUB_BOT_TOKEN)." : "";
      return sendError(reply, "github_error", `GitHub returned ${error.status}.${hint}`);
    }
    request.log.error({ err: error }, "unhandled error");
    return sendError(reply, "internal", "Internal error");
  });

  app.get("/healthz", async () => ({ ok: true }));

  // Internal routes for the bot: bearer token only. Prefixed so they never collide with
  // dashboard pages like /jobs/TASK-0001 when the API serves the UI.
  app.register(
    async (internal) => {
      internal.addHook("onRequest", async (request, reply) => {
        if (!tokensMatch(deps.internalToken, request.headers.authorization)) {
          return sendError(reply, "unauthorized", "Missing or invalid internal token");
        }
      });

      internal.post("/jobs", async (request, reply) => {
        const body = createJobRequest.parse(request.body);
        const submitted = await submitJob(deps, body);
        if (!submitted.ok) return sendError(reply, submitted.code, submitted.message);
        return reply.status(201).send(submitted.response);
      });

      internal.get("/jobs", async (request) => {
        const query = listJobsQuery.parse(request.query);
        const jobs = await listJobs(deps.db, {
          limit: query.limit,
          status: query.status,
          type: query.type,
          requestedByDiscordId: query.requestedBy,
        });
        return { jobs: jobs.map(toJobDto) };
      });

      internal.get<{ Params: { shortId: string } }>("/jobs/:shortId", async (request, reply) => {
        const parsed = parseShortId(request.params.shortId);
        const job = parsed ? await getJobByShortId(deps.db, parsed.shortId) : null;
        if (!job) return sendError(reply, "not_found", "Job not found.");
        const events = await listJobEvents(deps.db, job.id);
        return {
          job: toJobDto(job),
          position: await queuePosition(deps.db, job),
          events: events.map((event) => ({
            id: event.id,
            type: event.type,
            payload: event.payload,
            createdAt: event.createdAt.toISOString(),
          })),
        };
      });

      internal.post<{ Params: { shortId: string } }>(
        "/jobs/:shortId/cancel",
        async (request, reply) => {
          const parsed = parseShortId(request.params.shortId);
          if (!parsed) return sendError(reply, "not_found", "Job not found.");
          const outcome = await requestCancel(deps.db, parsed.shortId);
          switch (outcome.kind) {
            case "not_found":
              return sendError(reply, "not_found", "Job not found.");
            case "not_cancellable":
              return sendError(
                reply,
                "not_cancellable",
                `${outcome.job.shortId} is ${outcome.job.status} and can no longer be cancelled.`,
              );
            default:
              return { outcome: outcome.kind, job: toJobDto(outcome.job) };
          }
        },
      );
    },
    { prefix: "/internal" },
  );

  if (deps.dashboard) app.register(dashboardPlugin(deps, deps.dashboard));

  return app;
}
