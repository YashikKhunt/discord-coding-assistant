import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  type Allowlist,
  type ApiErrorCode,
  isAllowed,
  JOB_STATUSES,
  JOB_TYPES,
  parseShortId,
} from "@dca/core";
import {
  costReport,
  createSession,
  deleteSession,
  getJobByShortId,
  getJobTrace,
  getSession,
  listJobsPage,
  queuePosition,
  requestCancel,
  toJobDto,
} from "@dca/db";
import { getProfile } from "@dca/profiles";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.ts";
import { submitJob } from "./app.ts";
import { type DiscordOAuth, DiscordOAuthError } from "./discord-oauth.ts";

export interface DashboardDeps {
  oauth: DiscordOAuth;
  allowlist: Allowlist;
  /** Public origin of the dashboard, e.g. https://agent.example.com */
  dashboardUrl: string;
  sessionSecret: string;
  /** Built UI (apps/dashboard/dist). Not served when missing (dev uses the Vite server). */
  distDir?: string;
  sessionTtlMs?: number;
}

const SESSION_COOKIE = "dca_session";
const STATE_COOKIE = "dca_oauth_state";
const MAX_TOOL_OUTPUT_CHARS = 20_000;

interface SessionUser {
  discordUserId: string;
  username: string;
  avatar: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    dashboardUser?: SessionUser;
  }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function sendError(reply: FastifyReply, status: number, code: ApiErrorCode, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

const STATUS_FOR: Partial<Record<ApiErrorCode, number>> = {
  invalid_request: 400,
  invalid_repo: 400,
  attachment_rejected: 400,
  spend_cap_reached: 402,
  repo_not_accessible: 403,
};

const listQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(JOB_TYPES).optional(),
  repo: z.string().max(140).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const createBody = z.object({
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
});

export function dashboardPlugin(deps: AppDeps, options: DashboardDeps) {
  const origin = new URL(options.dashboardUrl).origin;
  const secure = origin.startsWith("https://");
  const ttlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;

  return async (app: FastifyInstance) => {
    await app.register(fastifyCookie, { secret: options.sessionSecret });

    // --- OAuth ------------------------------------------------------------------------------

    app.get("/auth/discord/login", async (_request, reply) => {
      const state = randomBytes(24).toString("base64url");
      reply.setCookie(STATE_COOKIE, state, {
        path: "/auth",
        httpOnly: true,
        sameSite: "lax",
        secure,
        signed: true,
        maxAge: 600,
      });
      return reply.redirect(options.oauth.authorizeUrl(state));
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      "/auth/discord/callback",
      async (request, reply) => {
        const cookie = request.cookies[STATE_COOKIE];
        const unsigned = cookie ? request.unsignCookie(cookie) : null;
        reply.clearCookie(STATE_COOKIE, { path: "/auth" });

        const { code, state } = request.query;
        const expected = unsigned?.valid ? (unsigned.value ?? "") : "";
        const stateOk =
          Boolean(state) &&
          expected.length === (state ?? "").length &&
          timingSafeEqual(Buffer.from(expected), Buffer.from(state ?? ""));
        if (!code || !stateOk) return reply.redirect("/login?error=state");

        let identity: Awaited<ReturnType<DiscordOAuth["identify"]>>;
        try {
          identity = await options.oauth.identify(code);
        } catch (error) {
          request.log.warn({ err: error }, "discord login failed");
          return reply.redirect(
            `/login?error=${error instanceof DiscordOAuthError ? "discord" : "internal"}`,
          );
        }
        if (!isAllowed(options.allowlist, identity.id, identity.roles)) {
          request.log.warn({ discordUserId: identity.id }, "dashboard login refused");
          return reply.redirect("/login?error=forbidden");
        }

        const token = randomBytes(32).toString("base64url");
        await createSession(deps.db, {
          id: hashToken(token),
          discordUserId: identity.id,
          username: identity.globalName ?? identity.username,
          avatar: identity.avatar,
          expiresAt: new Date(Date.now() + ttlMs),
        });
        reply.setCookie(SESSION_COOKIE, token, {
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          secure,
          maxAge: Math.floor(ttlMs / 1000),
        });
        return reply.redirect("/");
      },
    );

    app.post("/auth/logout", async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) await deleteSession(deps.db, hashToken(token));
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { ok: true };
    });

    // --- API ------------------------------------------------------------------------------

    app.register(async (api) => {
      api.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          // Cookies are SameSite=Lax; also require our own origin for writes (CSRF defence).
          if (request.headers.origin !== origin) {
            return sendError(reply, 403, "unauthorized", "Cross-origin request refused");
          }
        }
        const token = request.cookies[SESSION_COOKIE];
        const session = token ? await getSession(deps.db, hashToken(token)) : null;
        if (!session) return sendError(reply, 401, "unauthorized", "Sign in with Discord");
        request.dashboardUser = {
          discordUserId: session.discordUserId,
          username: session.username,
          avatar: session.avatar,
        };
      });

      api.get("/api/me", async (request) => {
        const user = request.dashboardUser as SessionUser;
        return {
          id: user.discordUserId,
          username: user.username,
          avatarUrl: user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.discordUserId}/${user.avatar}.png?size=64`
            : null,
        };
      });

      api.get("/api/jobs", async (request) => {
        const query = listQuery.parse(request.query);
        const page = await listJobsPage(deps.db, query);
        return { jobs: page.jobs.map(toJobDto), nextBefore: page.nextBefore };
      });

      api.get<{ Params: { shortId: string } }>("/api/jobs/:shortId", async (request, reply) => {
        const parsed = parseShortId(request.params.shortId);
        const job = parsed ? await getJobByShortId(deps.db, parsed.shortId) : null;
        if (!job) return sendError(reply, 404, "not_found", "Job not found.");
        const trace = await getJobTrace(deps.db, job.id);
        return {
          job: toJobDto(job),
          position: await queuePosition(deps.db, job),
          limits: getProfile(job.type).limits,
          events: trace.events.map((event) => ({
            id: event.id,
            type: event.type,
            payload: event.payload,
            createdAt: event.createdAt.toISOString(),
          })),
          llmCalls: trace.llmCalls.map((call) => ({
            ...call,
            createdAt: call.createdAt.toISOString(),
          })),
          toolCalls: trace.toolCalls.map((call) => ({
            id: call.id,
            llmCallId: call.llmCallId,
            name: call.name,
            args: call.args,
            output:
              call.output && call.output.length > MAX_TOOL_OUTPUT_CHARS
                ? `${call.output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… [truncated]`
                : call.output,
            exitCode: call.exitCode,
            durationMs: call.durationMs,
            createdAt: call.createdAt.toISOString(),
          })),
          attachments: trace.attachments.map((file) => ({
            id: file.id,
            kind: file.kind,
            filename: file.filename,
            mime: file.mime,
            size: file.size,
          })),
        };
      });

      api.post("/api/jobs", async (request, reply) => {
        const body = createBody.parse(request.body);
        const user = request.dashboardUser as SessionUser;
        const submitted = await submitJob(deps, {
          ...body,
          requestedByDiscordId: user.discordUserId,
          source: "dashboard",
          attachments: [],
        });
        if (!submitted.ok) {
          return sendError(
            reply,
            STATUS_FOR[submitted.code] ?? 400,
            submitted.code,
            submitted.message,
          );
        }
        return reply.status(201).send(submitted.response);
      });

      api.post<{ Params: { shortId: string } }>(
        "/api/jobs/:shortId/cancel",
        async (request, reply) => {
          const parsed = parseShortId(request.params.shortId);
          const outcome = parsed ? await requestCancel(deps.db, parsed.shortId) : null;
          if (!outcome || outcome.kind === "not_found") {
            return sendError(reply, 404, "not_found", "Job not found.");
          }
          if (outcome.kind === "not_cancellable") {
            return sendError(
              reply,
              409,
              "not_cancellable",
              `${outcome.job.shortId} is ${outcome.job.status} and can no longer be cancelled.`,
            );
          }
          return { outcome: outcome.kind, job: toJobDto(outcome.job) };
        },
      );

      api.get("/api/costs", async (request) => {
        const { days } = z
          .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
          .parse(request.query);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const report = await costReport(deps.db, since);
        return {
          ...report,
          days,
          monthlyCapUsd: deps.monthlyLlmCapUsd,
          topJobs: report.topJobs.map((job) => ({
            ...job,
            createdAt: job.createdAt.toISOString(),
          })),
          profiles: JOB_TYPES.map((type) => ({ type, ...getProfile(type) })),
        };
      });
    });

    // --- UI -------------------------------------------------------------------------------

    const dist = options.distDir;
    if (dist && existsSync(path.join(dist, "index.html"))) {
      app.addHook("onSend", async (request, reply, payload) => {
        if (!request.url.startsWith("/api/") && !request.url.startsWith("/auth/")) {
          reply.header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
          );
          reply.header("X-Content-Type-Options", "nosniff");
          reply.header("Referrer-Policy", "same-origin");
        }
        return payload;
      });
      await app.register(fastifyStatic, { root: dist, wildcard: false, index: ["index.html"] });
      // Client-side routes (/jobs/TASK-0001, /costs, /login) all load the SPA shell.
      app.setNotFoundHandler((request, reply) => {
        const isPage =
          request.method === "GET" &&
          !request.url.startsWith("/api/") &&
          !request.url.startsWith("/auth/") &&
          (request.headers.accept ?? "").includes("text/html");
        if (isPage) return reply.sendFile("index.html");
        return sendError(reply, 404, "not_found", "Not found");
      });
    }
  };
}
