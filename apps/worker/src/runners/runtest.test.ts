import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Job } from "@dca/db";
import type { GitHubClient } from "@dca/github";
import { DockerSandboxProvider } from "@dca/sandbox";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunContext } from "../runner.ts";
import { type RuntestResult, RuntestRunner, summarizeTests } from "./runtest.ts";

const ENABLED = process.env.SANDBOX_TESTS === "1";
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

describe("summarizeTests", () => {
  it("formats counts and handles missing reports", () => {
    expect(
      summarizeTests(
        { passed: 4, failed: 1, skipped: 2, durationMs: 10, failures: [], source: "junit" },
        1,
      ),
    ).toBe("4 passed · 1 failed · 2 skipped");
    expect(
      summarizeTests(
        { passed: 3, failed: 0, skipped: 0, durationMs: null, failures: [], source: "output" },
        2,
      ),
    ).toBe("3 passed · 0 failed · test command exited with code 2");
    expect(summarizeTests(null, 0)).toBe("Tests passed (no machine-readable report)");
    expect(summarizeTests(null, 2)).toBe("Tests failed with exit code 2");
  });
});

describe.skipIf(!ENABLED)("RuntestRunner (sandbox integration)", { timeout: 180_000 }, () => {
  let workspaces: string;
  const github: GitHubClient = {
    checkRepoAccess: async () => ({ ok: true, defaultBranch: "main", private: false }),
  };
  let running = 0;
  const ctx: RunContext = {
    signal: new AbortController().signal,
    log: pino({ level: "silent" }),
    markRunning: async () => {
      running++;
    },
  };

  beforeAll(async () => {
    workspaces = await mkdtemp(path.join(tmpdir(), "dca-runtest-"));
  });

  afterAll(async () => {
    await rm(workspaces, { recursive: true, force: true });
  });

  const runFixture = (fixture: string) => {
    const runner = new RuntestRunner({
      // No network: fixtures have no dependencies, which also proves installs stay offline.
      sandbox: new DockerSandboxProvider(),
      github,
      token: "unused",
      workspacesDir: workspaces,
      images: { node: "dca-sandbox-node:latest", python: "dca-sandbox-python:latest" },
      checkout: async ({ dir }) => {
        await cp(path.join(FIXTURES, fixture), dir, { recursive: true });
        return { commit: "0123456789abcdef" };
      },
    });
    const job = {
      id: `00000000-0000-4000-8000-${Date.now().toString().padStart(12, "0")}`,
      shortId: "TEST-0001",
      type: "runtest",
      repo: "octo/app",
      ref: null,
    } as Job;
    return runner.run(job, ctx);
  };

  it("runs a node:test suite and reports failures from the JUnit report", async () => {
    const outcome = await runFixture("node-mixed");
    const result = outcome.result as RuntestResult;
    expect(outcome.status).toBe("succeeded");
    expect(result).toMatchObject({
      outcome: "failed",
      stack: "node",
      ref: "main",
      commit: "0123456789abcdef",
      summary: "1 passed · 1 failed",
      tests: { passed: 1, failed: 1, source: "junit" },
    });
    expect(result.tests?.failures[0]?.name).toContain("divides");
    expect(result.logTail).toContain("$ node --test --test-reporter=spec");
    expect(running).toBeGreaterThan(0);
  });

  it("runs a python unittest suite in a venv", async () => {
    const outcome = await runFixture("python-pass");
    const result = outcome.result as RuntestResult;
    expect(outcome.status, result.logTail).toBe("succeeded");
    expect(result).toMatchObject({
      outcome: "passed",
      stack: "python",
      tests: { passed: 2, failed: 0, source: "output" },
    });
  });

  it("fails clearly when there is nothing to run", async () => {
    const outcome = await runFixture("no-tests");
    expect(outcome).toMatchObject({
      status: "failed",
      error: "No test command found. Add a test script or an .agent.yml.",
    });
  });
});
