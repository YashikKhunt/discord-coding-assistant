import type { JobDto } from "@dca/core";
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
    expect(embed.footer?.text).toBe("stub · $0.84 · 14 iterations · 6m");
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
