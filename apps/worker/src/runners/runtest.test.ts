import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Job } from "@dca/db";
import type { StepModel, StepRequest, StepResponse } from "@dca/llm";
import { DockerSandboxProvider } from "@dca/sandbox";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../agent-runtime.ts";
import type { RunContext } from "../runner.ts";
import { fakeGitHub } from "../test-helpers.ts";
import { type RuntestResult, RuntestRunner, runtestComment, summarizeTests } from "./runtest.ts";

const ENABLED = process.env.SANDBOX_TESTS === "1";
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

describe("runtestComment", () => {
  it("renders failures and the likely cause as markdown", () => {
    const comment = runtestComment(
      { shortId: "TEST-0009" },
      {
        kind: "runtest",
        outcome: "failed",
        summary: "1 passed · 1 failed",
        ref: "#3",
        commit: "0123456789abcdef",
        stack: "node",
        installCommand: "npm ci",
        testCommand: "npm test",
        exitCode: 1,
        tests: {
          passed: 1,
          failed: 1,
          skipped: 0,
          durationMs: 5,
          source: "junit",
          failures: [{ name: "divides", message: "expected 2\n```inject```" }],
        },
        durationMs: 1,
        notes: [],
        logTail: "",
        analysis: { likelyCause: "10 / 4 is 2.5", confidence: "high", relevantFiles: [] },
        analysisNote: null,
        model: "anthropic:claude-haiku-4-5",
      },
    );
    expect(comment).toContain("### ❌ Tests failed · 1 passed · 1 failed");
    expect(comment).toContain("Commit `0123456` · `npm test`");
    expect(comment).toContain("**divides**");
    expect(comment).not.toContain("```inject```");
    expect(comment).toContain("**Likely cause** (high confidence): 10 / 4 is 2.5");
  });
});

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
  const github = fakeGitHub();
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

  const runFixture = (fixture: string, agent?: AgentRuntime) => {
    const runner = new RuntestRunner({
      agent,
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

  it("explains failures with an agent that reads the repo inside the sandbox", async () => {
    const requests: StepRequest[] = [];
    const toolOutputs: string[] = [];
    const reply = (toolCalls: StepResponse["toolCalls"]): StepResponse => ({
      model: "anthropic:claude-haiku-4-5",
      text: "",
      toolCalls,
      finishReason: "tool-calls",
      usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.001,
      priced: true,
      latencyMs: 1,
      responseMessages: [
        {
          role: "assistant",
          content: toolCalls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: c.id,
            toolName: c.name,
            input: c.input,
          })),
        },
      ],
    });
    const model: StepModel = {
      spec: "anthropic:claude-haiku-4-5",
      async step(request) {
        requests.push(request);
        return requests.length === 1
          ? reply([{ id: "r1", name: "read_file", input: { path: "math.test.mjs" } }])
          : reply([
              {
                id: "f1",
                name: "finish",
                input: {
                  likelyCause: "The divides test expects 10 / 4 to be 2, but it is 2.5.",
                  confidence: "high",
                  relevantFiles: ["math.test.mjs:5"],
                },
              },
            ]);
      },
    };
    const agent: AgentRuntime = {
      modelsFor: () => [model],
      hooksFor: () => ({
        onToolCall: async ({ output }) => {
          toolOutputs.push(output);
        },
      }),
    };

    const outcome = await runFixture("node-mixed", agent);
    const result = outcome.result as RuntestResult;
    expect(outcome).toMatchObject({
      status: "succeeded",
      iterations: 2,
      modelUsed: "anthropic:claude-haiku-4-5",
    });
    expect(outcome.costUsd).toBeCloseTo(0.002);
    expect(result.analysis).toMatchObject({
      confidence: "high",
      relevantFiles: ["math.test.mjs:5"],
    });
    expect(result.analysisNote).toBeNull();
    expect(toolOutputs[0]).toContain('test("divides"');
    const prompt = String(requests[0]?.messages[0]?.content);
    expect(prompt).toContain("divides");
    expect(prompt).toContain("<log>");
  });

  it("does not analyse passing runs", async () => {
    const agent: AgentRuntime = {
      modelsFor: () => {
        throw new Error("should not be called");
      },
      hooksFor: () => ({}),
    };
    const outcome = await runFixture("python-pass", agent);
    expect((outcome.result as RuntestResult).analysis).toBeNull();
    expect(outcome.costUsd).toBe(0);
  });

  it("runs a python unittest suite in a venv", async () => {
    const outcome = await runFixture("python-pass");
    const result = outcome.result as RuntestResult;
    expect(outcome.status, result.logTail).toBe("succeeded");
    // .python-version pins 3.11: the venv must use the interpreter baked into the image, offline.
    expect(result.logTail).not.toContain("error");
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
