import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CreateJobResponse } from "@dca/core";
import { attachments, createDb, type DbHandle, jobs, llmCalls, monthSpendUsd } from "@dca/db";
import { runMigrations } from "@dca/db/migrate";
import { GitHubApiError, type GitHubClient, type RepoAccess } from "@dca/github";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const TOKEN = "test-internal-token-0123456789abcdef";
const OWNER = `api-test-${Date.now()}`;
const USER = "111111111111111111";

describe.skipIf(!DATABASE_URL)("api (integration)", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dir: string;
  let access: RepoAccess;
  let capUsd: number;

  let githubStatus: number | null = null;
  const unused = async () => {
    throw new Error("not used by the api");
  };
  const github: GitHubClient = {
    getAuthenticatedUser: unused,
    getIssue: unused,
    createPullRequest: unused,
    createCommitStatus: unused,
    upsertIssueComment: unused,
    checkRepoAccess: async () => {
      if (githubStatus) throw new GitHubApiError(githubStatus, "boom");
      return access;
    },
  };
  const fakeFetch = (async () => new Response("npm ERR! boom", { status: 200 })) as typeof fetch;

  const post = (url: string, payload?: object) =>
    app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${TOKEN}` } });
  const get = (url: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });

  beforeAll(async () => {
    await runMigrations(DATABASE_URL as string);
    handle = createDb(DATABASE_URL as string);
    dir = await mkdtemp(path.join(tmpdir(), "dca-attachments-"));
    app = buildApp({
      db: handle.db,
      github,
      internalToken: TOKEN,
      attachmentsDir: dir,
      get monthlyLlmCapUsd() {
        return capUsd;
      },
      fetch: fakeFetch,
    });
  });

  beforeEach(() => {
    access = { ok: true, defaultBranch: "main", private: false };
    capUsd = 1000;
    githubStatus = null;
  });

  afterAll(async () => {
    await app.close();
    await handle.db.delete(jobs).where(like(jobs.repo, `${OWNER}/%`));
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects requests without the internal token", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/jobs" });
    expect(res.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("creates a task job with attachments and returns its position", async () => {
    const res = await post("/internal/jobs", {
      type: "task",
      repo: `${OWNER}/app`,
      input: { description: "add rate limiting" },
      requestedByDiscordId: USER,
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/1/2/build.log",
          filename: "build.log",
          contentType: "text/plain; charset=utf-8",
          size: 13,
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<CreateJobResponse>();
    expect(body.job.shortId).toMatch(/^TASK-\d{4,}$/);
    expect(body.job.status).toBe("queued");
    expect(body.position).toBeGreaterThanOrEqual(1);

    const [stored] = await handle.db
      .select()
      .from(attachments)
      .where(eq(attachments.jobId, body.job.id));
    expect(stored?.kind).toBe("log");
    expect(await readFile(stored?.path ?? "", "utf8")).toBe("npm ERR! boom");

    const detail = await get(`/internal/jobs/${body.job.shortId.toLowerCase()}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().events.map((event: { type: string }) => event.type)).toEqual(["created"]);
  });

  it("validates repo format, description and repo access", async () => {
    const base = { type: "task", input: { description: "x" }, requestedByDiscordId: USER };
    expect((await post("/internal/jobs", { ...base, repo: "just-a-name" })).json().error.code).toBe(
      "invalid_repo",
    );
    expect(
      (await post("/internal/jobs", { ...base, repo: `${OWNER}/app`, input: {} })).json().error
        .code,
    ).toBe("invalid_request");

    access = { ok: false, reason: "not_found" };
    const res = await post("/internal/jobs", { ...base, repo: `${OWNER}/app` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("repo_not_accessible");
  });

  it("explains GitHub token failures", async () => {
    githubStatus = 401;
    const res = await post("/internal/jobs", {
      type: "runtest",
      repo: `${OWNER}/app`,
      requestedByDiscordId: USER,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain("GITHUB_BOT_TOKEN");
  });

  it("rejects non-Discord attachment URLs", async () => {
    const res = await post("/internal/jobs", {
      type: "bugreport",
      repo: `${OWNER}/app`,
      input: { description: "crash" },
      requestedByDiscordId: USER,
      attachments: [{ url: "https://169.254.169.254/latest", filename: "a.png", size: 1 }],
    });
    expect(res.json().error.code).toBe("attachment_rejected");
  });

  it("enforces the monthly spend cap using the profile's max cost", async () => {
    const [seed] = await handle.db
      .insert(jobs)
      .values({
        shortId: `SEED-${Date.now()}`,
        type: "runtest",
        repo: `${OWNER}/seed`,
        requestedByDiscordId: USER,
        profileId: "runtest",
        profileVersion: 1,
        status: "succeeded",
      })
      .returning();
    await handle.db
      .insert(llmCalls)
      .values({ jobId: seed?.id ?? "", step: 1, provider: "test", model: "test", costUsd: 9 });

    // $1 of headroom: task (max $2) is refused, runtest (max $0.30) is accepted.
    capUsd = (await monthSpendUsd(handle.db)) + 1;

    const task = await post("/internal/jobs", {
      type: "task",
      repo: `${OWNER}/app`,
      input: { description: "x" },
      requestedByDiscordId: USER,
    });
    expect(task.statusCode).toBe(402);

    const runtest = await post("/internal/jobs", {
      type: "runtest",
      repo: `${OWNER}/app`,
      requestedByDiscordId: USER,
    });
    expect(runtest.statusCode).toBe(201);
  });

  it("cancels queued jobs immediately and refuses finished ones", async () => {
    const created = (
      await post("/internal/jobs", {
        type: "runtest",
        repo: `${OWNER}/app`,
        requestedByDiscordId: USER,
      })
    ).json<CreateJobResponse>();

    const first = await post(`/internal/jobs/${created.job.shortId}/cancel`);
    expect(first.json()).toMatchObject({ outcome: "cancelled", job: { status: "cancelled" } });

    const second = await post(`/internal/jobs/${created.job.shortId}/cancel`);
    expect(second.statusCode).toBe(409);
    expect((await post("/internal/jobs/TASK-99999999/cancel")).statusCode).toBe(404);
  });

  it("lists jobs with filters", async () => {
    const res = await get("/internal/jobs?limit=5&type=runtest");
    expect(res.statusCode).toBe(200);
    const { jobs: listed } = res.json<{ jobs: { type: string }[] }>();
    expect(listed.length).toBeLessThanOrEqual(5);
    expect(listed.every((job) => job.type === "runtest")).toBe(true);
  });
});
