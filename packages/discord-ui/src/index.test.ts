import type { AgentJobResult, JobDto } from "@dca/core";
import { describe, expect, it } from "vitest";
import {
  ackContent,
  formatDuration,
  forumPostTitle,
  jobsListEmbed,
  resultContent,
  resultEmbed,
  resultFiles,
  statusTag,
  tagNamesFor,
} from "./index.ts";

const job = (overrides: Partial<JobDto> = {}): JobDto => ({
  id: "00000000-0000-0000-0000-000000000000",
  shortId: "TASK-0042",
  type: "task",
  status: "queued",
  repo: "yashik/my-api",
  ref: null,
  input: { description: "add rate limiting to the /api routes" },
  requestedByDiscordId: "111111111111111111",
  source: "discord",
  discordForumThreadId: null,
  result: null,
  prUrl: null,
  error: null,
  iterations: 0,
  costUsd: 0,
  cancelRequestedAt: null,
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-09-12T10:00:00.000Z",
  ...overrides,
});

describe("forum post title", () => {
  it("combines id, repo and summary within 100 chars", () => {
    expect(forumPostTitle(job())).toBe(
      "TASK-0042 · yashik/my-api · add rate limiting to the /api routes",
    );
    const long = forumPostTitle(job({ input: { description: "x".repeat(300) } }));
    expect(long).toHaveLength(100);
    expect(long.endsWith("…")).toBe(true);
  });

  it("describes runtest jobs by ref", () => {
    expect(
      forumPostTitle(job({ type: "runtest", shortId: "TEST-0001", ref: "#12", input: {} })),
    ).toBe("TEST-0001 · yashik/my-api · run tests @ #12");
  });
});

describe("tags", () => {
  it("collapses in-flight statuses into running", () => {
    expect(statusTag("preparing")).toBe("running");
    expect(statusTag("finalizing")).toBe("running");
    expect(statusTag("succeeded")).toBe("passed");
    expect(tagNamesFor(job({ type: "bugreport", status: "failed" }))).toEqual([
      "bugreport",
      "failed",
    ]);
  });
});

describe("messages", () => {
  it("builds the ack with position and thread link", () => {
    expect(ackContent(job(), 2, { guildId: "1", threadId: "2" })).toBe(
      "✅ **TASK-0042** queued · `yashik/my-api` · position 2\n→ https://discord.com/channels/1/2",
    );
  });

  it("builds result embeds with stats", () => {
    const embed = resultEmbed(
      job({
        status: "succeeded",
        result: { summary: "Stub run", model: "stub" },
        costUsd: 0.84,
        iterations: 14,
        startedAt: "2026-09-12T10:00:00.000Z",
        finishedAt: "2026-09-12T10:06:00.000Z",
        prUrl: "https://github.com/yashik/my-api/pull/18",
      }),
    );
    expect(embed.title).toBe("🟩 TASK-0042 · PR opened · https://github.com/yashik/my-api/pull/18");
    expect(embed.description).toBe("Stub run");
    expect(embed.footer?.text).toBe("stub · $0.84 · 14 steps · 6m");
  });

  it("lists jobs", () => {
    expect(jobsListEmbed([]).description).toBe("No jobs yet.");
    expect(jobsListEmbed([job()]).description).toContain("`TASK-0042` queued");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(38_000)).toBe("38s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
  });
});

describe("runtest results", () => {
  const runtest = (outcome: "passed" | "failed" | "error", overrides = {}) =>
    job({
      shortId: "TEST-0103",
      type: "runtest",
      status: outcome === "error" ? "failed" : "succeeded",
      finishedAt: "2026-09-12T10:01:12.000Z",
      result: {
        kind: "runtest",
        outcome,
        summary:
          outcome === "error"
            ? "Dependency install failed with exit code 1"
            : "42 passed · 2 failed · 1 skipped",
        ref: "feature/auth",
        commit: "a1b2c3d4e5f6",
        stack: "node",
        installCommand: "npm ci",
        testCommand: "npm test",
        exitCode: outcome === "passed" ? 0 : 1,
        tests:
          outcome === "error"
            ? null
            : {
                passed: 42,
                failed: outcome === "failed" ? 12 : 0,
                skipped: 1,
                durationMs: 38_000,
                source: "junit",
                failures:
                  outcome === "failed"
                    ? Array.from({ length: 12 }, (_, i) => ({
                        name: `auth › case ${i}`,
                        message: "Expected 401, received 500\n    extra\n    more\n    hidden",
                      }))
                    : [],
              },
        durationMs: 72_000,
        notes: [],
        logTail: "npm ERR! missing script\n",
        analysis: null,
        analysisNote: null,
        model: null,
        ...overrides,
      },
    });

  it("renders counts, up to 10 failures and a footer", () => {
    const embed = resultEmbed(runtest("failed"));
    expect(embed.title).toBe("🟥 TEST-0103 · yashik/my-api @ feature/auth (a1b2c3d)");
    expect(embed.fields?.map((field) => `${field.name}=${field.value}`)).toEqual([
      "Passed=42",
      "Failed=12",
      "Skipped=1",
    ]);
    expect(embed.description?.match(/❌/g)).toHaveLength(10);
    expect(embed.description).toContain("…and 2 more (see attached log)");
    expect(embed.description).not.toContain("hidden");
    expect(embed.footer?.text).toBe("node · exit 1 · 1m 12s");
  });

  it("adds the likely cause and model cost when analysis ran", () => {
    const failed = runtest("failed", {
      analysis: {
        likelyCause: "verifyToken throws on expired JWTs instead of returning null.",
        confidence: "high",
        suggestedFix: "Catch TokenExpiredError in verifyToken.",
        relevantFiles: ["src/auth/verify.ts:57"],
      },
      model: "anthropic:claude-haiku-4-5",
    });
    failed.costUsd = 0.04;
    const embed = resultEmbed(failed);
    expect(embed.description).toContain("**Likely cause** · high confidence");
    expect(embed.description).toContain("verifyToken throws on expired JWTs");
    expect(embed.description).toContain("`src/auth/verify.ts:57`");
    expect(embed.footer?.text).toBe("node · exit 1 · 1m 12s · claude-haiku-4-5 · $0.04");

    const skipped = resultEmbed(runtest("failed", { analysisNote: "Analysis ran out of time" }));
    expect(skipped.description).toContain("_Analysis ran out of time_");
  });

  it("tags failed test runs as failed and attaches the log", () => {
    expect(tagNamesFor(runtest("failed"))).toEqual(["runtest", "failed"]);
    expect(tagNamesFor(runtest("passed"))).toEqual(["runtest", "passed"]);
    expect(resultContent(runtest("failed"))).toBe("<@111111111111111111> TEST-0103 tests failed");
    expect(resultFiles(runtest("passed"))).toEqual([
      { name: "TEST-0103-log.txt", content: "npm ERR! missing script\n" },
    ]);
  });

  it("shows the reason and last output when tests could not run", () => {
    const embed = resultEmbed(runtest("error"));
    expect(embed.title?.startsWith("⬛")).toBe(true);
    expect(embed.description).toContain("Dependency install failed with exit code 1");
    expect(embed.description).toContain("npm ERR! missing script");
    expect(resultContent(runtest("error"))).toContain("could not run tests");
  });
});

describe("task and bugreport results", () => {
  const agentJob = (overrides: Partial<AgentJobResult> = {}, jobOverrides: Partial<JobDto> = {}) =>
    job({
      type: "bugreport",
      shortId: "BUG-0017",
      status: "succeeded",
      costUsd: 0.84,
      iterations: 14,
      startedAt: "2026-09-12T10:00:00.000Z",
      finishedAt: "2026-09-12T10:06:00.000Z",
      prUrl: "https://github.com/yashik/my-api/pull/18",
      result: {
        kind: "bugreport",
        outcome: "pr_opened",
        title: "Fix expired token returning 500",
        summary: "verifyToken threw on expired JWTs; it now returns null.",
        base: "main",
        commit: "abc",
        branch: "agent/bug-0017-fix-expired-token",
        prNumber: 18,
        prUrl: "https://github.com/yashik/my-api/pull/18",
        filesChanged: 2,
        insertions: 30,
        deletions: 4,
        tests: { command: "npm test", passed: true, summary: "44 passed · 0 failed" },
        reproduced: true,
        stopReason: "finished",
        violations: [],
        notes: [],
        model: "anthropic:claude-sonnet-5",
        ...overrides,
      },
      ...jobOverrides,
    });

  it("renders an opened PR with checks and stats", () => {
    const embed = resultEmbed(agentJob());
    expect(embed.title).toBe("🟩 BUG-0017 · PR #18 ready for review");
    expect(embed.url).toBe("https://github.com/yashik/my-api/pull/18");
    expect(embed.description).toContain("**Fix expired token returning 500**");
    expect(embed.fields?.map((f) => `${f.name}=${f.value}`)).toEqual([
      "Files changed=2 (+30 −4)",
      "Tests=✅ 44 passed · 0 failed",
      "Reproduced=yes",
      "Branch=`agent/bug-0017-fix-expired-token`",
    ]);
    expect(embed.footer?.text).toBe("claude-sonnet-5 · $0.84 · 14 steps · 6m");
    expect(resultContent(agentJob())).toBe(
      "<@111111111111111111> BUG-0017 PR #18 ready for review",
    );
  });

  it("renders partial drafts, blocked patches and no-op runs", () => {
    const partial = agentJob(
      { outcome: "draft_pr", notes: ["The agent reached its step limit before finishing."] },
      { status: "partial" },
    );
    expect(resultEmbed(partial).title).toBe("🟨 BUG-0017 · draft PR #18 · stopped early");
    expect(resultEmbed(partial).description).toContain("_The agent reached its step limit");
    expect(tagNamesFor(partial)).toEqual(["bugreport", "partial"]);

    const rejected = agentJob(
      {
        outcome: "rejected",
        prNumber: null,
        prUrl: null,
        violations: [".github/workflows/ci.yml: modifies CI workflows"],
      },
      { status: "failed", prUrl: null },
    );
    expect(resultEmbed(rejected).title).toBe("🟥 BUG-0017 · changes blocked by safety checks");
    expect(resultEmbed(rejected).description).toContain("• .github/workflows/ci.yml");

    const noop = agentJob({ outcome: "no_changes", prNumber: null, prUrl: null, filesChanged: 0 });
    expect(resultEmbed(noop).title).toBe("⬜ BUG-0017 · no changes made");
  });
});
