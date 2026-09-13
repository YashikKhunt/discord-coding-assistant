import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDb,
  type DbHandle,
  jobs,
  recordLlmCall,
  recordToolCall,
  transitionJob,
} from "@dca/db";
import { runMigrations } from "@dca/db/migrate";
import type { GitHubClient } from "@dca/github";
import { like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import type { DiscordIdentity, DiscordOAuth } from "./discord-oauth.ts";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:3000";
const OWNER = `dash-test-${Date.now()}`;
const ALLOWED = "222222222222222222";
const ROLE_MEMBER = "333333333333333333";
const STRANGER = "444444444444444444";

describe.skipIf(!DATABASE_URL)("dashboard (integration)", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dir: string;
  const identities = new Map<string, DiscordIdentity>();

  const oauth: DiscordOAuth = {
    authorizeUrl: (state) => `https://discord.com/oauth2/authorize?state=${state}`,
    async identify(code) {
      const identity = identities.get(code);
      if (!identity) throw new Error("bad code");
      return identity;
    },
  };
  const unused = async () => {
    throw new Error("unused");
  };
  const github: GitHubClient = {
    checkRepoAccess: async () => ({ ok: true, defaultBranch: "main", private: false }),
    getAuthenticatedUser: unused,
    getIssue: unused,
    createPullRequest: unused,
    createCommitStatus: unused,
    upsertIssueComment: unused,
  };

  beforeAll(async () => {
    await runMigrations(DATABASE_URL as string);
    handle = createDb(DATABASE_URL as string);
    dir = await mkdtemp(path.join(tmpdir(), "dca-dash-"));
    identities.set("code-allowed", {
      id: ALLOWED,
      username: "yashik",
      globalName: "Yashik",
      avatar: "abc",
      roles: [],
      inGuild: true,
    });
    identities.set("code-role", {
      id: "555555555555555555",
      username: "teammate",
      globalName: null,
      avatar: null,
      roles: [ROLE_MEMBER],
      inGuild: true,
    });
    identities.set("code-stranger", {
      id: STRANGER,
      username: "stranger",
      globalName: null,
      avatar: null,
      roles: [],
      inGuild: false,
    });
    app = buildApp({
      db: handle.db,
      github,
      internalToken: "internal-token-0123456789abcdef",
      attachmentsDir: dir,
      monthlyLlmCapUsd: 1000,
      dashboard: {
        oauth,
        allowlist: { userIds: [ALLOWED], roleIds: [ROLE_MEMBER] },
        dashboardUrl: ORIGIN,
        sessionSecret: "session-secret-0123456789abcdefghijkl",
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await handle.db.delete(jobs).where(like(jobs.repo, `${OWNER}/%`));
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  });

  const cookieHeader = (setCookie: string | string[] | undefined) =>
    ([] as string[])
      .concat(setCookie ?? [])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

  /** Runs the OAuth dance and returns the session cookie header. */
  async function signIn(
    code: string,
  ): Promise<{ status: number; location: string; cookie: string }> {
    const login = await app.inject({ method: "GET", url: "/auth/discord/login" });
    const state = new URL(login.headers.location as string).searchParams.get("state");
    const callback = await app.inject({
      method: "GET",
      url: `/auth/discord/callback?code=${code}&state=${state}`,
      headers: { cookie: cookieHeader(login.headers["set-cookie"]) },
    });
    return {
      status: callback.statusCode,
      location: String(callback.headers.location),
      cookie: cookieHeader(callback.headers["set-cookie"])
        .split("; ")
        .filter((c) => c.startsWith("dca_session="))
        .join("; "),
    };
  }

  it("signs in allowlisted users by id or role and exposes their profile", async () => {
    const byId = await signIn("code-allowed");
    expect(byId).toMatchObject({ status: 302, location: "/" });
    expect(byId.cookie).toMatch(/^dca_session=/);

    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: byId.cookie },
    });
    expect(me.json()).toEqual({
      id: ALLOWED,
      username: "Yashik",
      avatarUrl: `https://cdn.discordapp.com/avatars/${ALLOWED}/abc.png?size=64`,
    });

    const byRole = await signIn("code-role");
    expect(byRole.location).toBe("/");
  });

  it("refuses users outside the allowlist, tampered state and missing sessions", async () => {
    const stranger = await signIn("code-stranger");
    expect(stranger).toMatchObject({ location: "/login?error=forbidden", cookie: "" });

    const login = await app.inject({ method: "GET", url: "/auth/discord/login" });
    const forged = await app.inject({
      method: "GET",
      url: "/auth/discord/callback?code=code-allowed&state=forged",
      headers: { cookie: cookieHeader(login.headers["set-cookie"]) },
    });
    expect(forged.headers.location).toBe("/login?error=state");

    expect((await app.inject({ method: "GET", url: "/api/jobs" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/jobs",
          headers: { cookie: "dca_session=nope" },
        })
      ).statusCode,
    ).toBe(401);
    // Internal routes still require the bot token, even with a dashboard session.
    const { cookie } = await signIn("code-allowed");
    expect(
      (await app.inject({ method: "GET", url: "/internal/jobs", headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it("creates jobs as the signed-in user and rejects cross-origin writes", async () => {
    const { cookie } = await signIn("code-allowed");
    const payload = { type: "task", repo: `${OWNER}/app`, input: { description: "add a readme" } };

    const crossSite = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload,
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(crossSite.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload,
      headers: { cookie, origin: ORIGIN },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().job).toMatchObject({
      requestedByDiscordId: ALLOWED,
      source: "dashboard",
      status: "queued",
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { ...payload, repo: "not-a-repo" },
      headers: { cookie, origin: ORIGIN },
    });
    expect(invalid.json().error.code).toBe("invalid_repo");

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/jobs/${created.json().job.shortId}/cancel`,
      headers: { cookie, origin: ORIGIN },
    });
    expect(cancelled.json()).toMatchObject({ outcome: "cancelled" });
  });

  it("returns job traces, paginated lists and cost reports", async () => {
    const { cookie } = await signIn("code-allowed");
    const post = (description: string) =>
      app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: { type: "bugreport", repo: `${OWNER}/traced`, input: { description } },
        headers: { cookie, origin: ORIGIN },
      });
    const first = (await post("first")).json().job;
    await post("second");
    await post("third");

    await transitionJob(handle.db, first.id, "preparing");
    const llmCallId = await recordLlmCall(handle.db, {
      jobId: first.id,
      step: 1,
      provider: "anthropic",
      model: "anthropic:claude-sonnet-5",
      inputTokens: 1200,
      outputTokens: 80,
      cachedTokens: 0,
      costUsd: 0.25,
      latencyMs: 900,
      response: { text: "", toolCalls: [] },
    });
    await recordToolCall(handle.db, {
      jobId: first.id,
      llmCallId,
      name: "bash",
      args: { command: "npm test" },
      output: "x".repeat(30_000),
      exitCode: 1,
      durationMs: 1500,
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/jobs/${first.shortId}`,
      headers: { cookie },
    });
    const body = detail.json();
    expect(body.events.map((e: { type: string }) => e.type)).toEqual([
      "created",
      "status.preparing",
    ]);
    expect(body.llmCalls).toMatchObject([
      { step: 1, costUsd: 0.25, model: "anthropic:claude-sonnet-5" },
    ]);
    expect(body.toolCalls[0]).toMatchObject({ name: "bash", llmCallId, exitCode: 1 });
    expect(body.toolCalls[0].output).toContain("[truncated]");
    expect(body.limits).toMatchObject({ maxIterations: 30, maxUsd: 1.5 });

    const page1 = await app.inject({
      method: "GET",
      url: `/api/jobs?repo=${OWNER}/traced&limit=2`,
      headers: { cookie },
    });
    expect(page1.json().jobs).toHaveLength(2);
    const page2 = await app.inject({
      method: "GET",
      url: `/api/jobs?repo=${OWNER}/traced&limit=2&before=${encodeURIComponent(page1.json().nextBefore)}`,
      headers: { cookie },
    });
    expect(page2.json()).toMatchObject({ nextBefore: null });
    expect(page2.json().jobs.map((j: { shortId: string }) => j.shortId)).toEqual([first.shortId]);

    const costs = (
      await app.inject({ method: "GET", url: "/api/costs?days=7", headers: { cookie } })
    ).json();
    expect(costs.monthlyCapUsd).toBe(1000);
    expect(costs.monthSpendUsd).toBeGreaterThanOrEqual(0.25);
    expect(costs.byModel).toEqual(
      expect.arrayContaining([expect.objectContaining({ model: "anthropic:claude-sonnet-5" })]),
    );
    expect(costs.topJobs.some((job: { shortId: string }) => job.shortId === first.shortId)).toBe(
      true,
    );
    expect(costs.profiles.map((p: { type: string }) => p.type)).toEqual([
      "task",
      "bugreport",
      "runtest",
    ]);
  });

  it("serves the built UI with a SPA fallback and security headers", async () => {
    const dist = await mkdtemp(path.join(tmpdir(), "dca-dist-"));
    await writeFile(path.join(dist, "index.html"), "<!doctype html><div id=root></div>");
    const ui = buildApp({
      db: handle.db,
      github,
      internalToken: "internal-token-0123456789abcdef",
      attachmentsDir: dir,
      monthlyLlmCapUsd: 1000,
      dashboard: {
        oauth,
        allowlist: { userIds: [ALLOWED], roleIds: [] },
        dashboardUrl: ORIGIN,
        sessionSecret: "session-secret-0123456789abcdefghijkl",
        distDir: dist,
      },
    });
    try {
      const page = await ui.inject({
        method: "GET",
        url: "/jobs/TASK-0001",
        headers: { accept: "text/html" },
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("<div id=root>");
      expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(page.headers["x-content-type-options"]).toBe("nosniff");

      const missingApi = await ui.inject({
        method: "GET",
        url: "/api/nope",
        headers: { accept: "text/html" },
      });
      // Unknown API paths stay JSON 404s; only page navigations get the SPA shell.
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.json().error.code).toBe("not_found");
      const missingAsset = await ui.inject({ method: "GET", url: "/assets/missing.js" });
      expect(missingAsset.statusCode).toBe(404);
    } finally {
      await ui.close();
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("logs out by deleting the session", async () => {
    const { cookie } = await signIn("code-allowed");
    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie, origin: ORIGIN },
    });
    expect(logout.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).statusCode,
    ).toBe(401);
  });
});
