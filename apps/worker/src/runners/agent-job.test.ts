import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentJobResult } from "@dca/core";
import type { Job } from "@dca/db";
import { checkoutRepo, pushPatch } from "@dca/github";
import type { StepModel, StepRequest, StepResponse, StepToolCall } from "@dca/llm";
import { DockerSandboxProvider } from "@dca/sandbox";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../agent-runtime.ts";
import { fakeGitHub } from "../test-helpers.ts";
import { AgentJobRunner } from "./agent-job.ts";

const ENABLED = process.env.SANDBOX_TESTS === "1";

const CART = `export function applyDiscount(total, code) {
  const discounts = { SAVE10: 10, HALF: 50 };
  const percent = discounts[code] ?? 0;
  return total - percent;
}
`;
const CART_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount } from "../src/cart.js";

test("SAVE10 takes 10 percent off", () => {
  assert.equal(applyDiscount(200, "SAVE10"), 180);
});
`;

function scriptedModel(steps: StepToolCall[][]): StepModel & { requests: StepRequest[] } {
  const requests: StepRequest[] = [];
  return {
    spec: "anthropic:claude-sonnet-5",
    requests,
    async step(request) {
      requests.push(request);
      const toolCalls = steps[requests.length - 1] ?? [];
      const response: StepResponse = {
        model: "anthropic:claude-sonnet-5",
        text: "",
        toolCalls,
        finishReason: "tool-calls",
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.01,
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
      };
      return response;
    },
  };
}

describe.skipIf(!ENABLED)(
  "AgentJobRunner (sandbox + local git remote)",
  { timeout: 240_000 },
  () => {
    let root: string;
    let remote: string;
    let workspaces: string;
    const prs: { head: string; base: string; title: string; body: string; draft: boolean }[] = [];

    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "dca-agentjob-"));
      remote = path.join(root, "remote.git");
      workspaces = path.join(root, "workspaces");
      const seed = path.join(root, "seed");
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
      execFileSync("git", ["init", "-q", "-b", "main", seed]);
      await mkdir(path.join(seed, "src"));
      await mkdir(path.join(seed, "test"));
      await writeFile(
        path.join(seed, "package.json"),
        JSON.stringify({
          name: "cart",
          private: true,
          type: "module",
          scripts: { test: "node --test" },
        }),
      );
      await writeFile(path.join(seed, "src/cart.js"), CART);
      await writeFile(path.join(seed, "test/cart.test.js"), CART_TEST);
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: seed });
      git("add", ".");
      git("commit", "-qm", "base");
      git("push", "-q", remote, "main");
    }, 60_000);

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const job = (shortId: string): Job =>
      ({
        id: `00000000-0000-4000-8000-${shortId.replace(/\D/g, "").padStart(12, "0")}`,
        shortId,
        type: "bugreport",
        repo: "octo/cart",
        ref: null,
        input: {
          description: "SAVE10 subtracts 10 instead of 10%",
          steps: "applyDiscount(200, 'SAVE10')",
        },
        requestedByDiscordId: "111111111111111111",
      }) as Job;

    const runner = (
      model: StepModel,
      remoteUrl = remote,
      type: "task" | "bugreport" = "bugreport",
    ) =>
      new AgentJobRunner({
        type,
        sandbox: new DockerSandboxProvider(),
        github: fakeGitHub({
          getAuthenticatedUser: async () => ({ login: "DoomsCode-Y", id: 42 }),
          createPullRequest: async (_repo, pr) => {
            prs.push(pr);
            return { number: prs.length, url: `https://github.com/octo/cart/pull/${prs.length}` };
          },
        }),
        agent: { modelsFor: () => [model], hooksFor: () => ({}) } satisfies AgentRuntime,
        token: "local",
        workspacesDir: workspaces,
        images: { node: "dca-sandbox-node:latest", python: "dca-sandbox-python:latest" },
        listAttachments: async () => [],
        checkout: (options) => checkoutRepo({ ...options, remoteUrl }),
        push: (options) => pushPatch({ ...options, remoteUrl }),
      });

    const ctx = {
      signal: new AbortController().signal,
      log: pino({ level: "silent" }),
      markRunning: async () => {},
    };

    it("fixes the bug, verifies with tests, pushes a branch and opens a ready PR", async () => {
      const model = scriptedModel([
        [{ id: "1", name: "read_file", input: { path: "src/cart.js" } }],
        [
          {
            id: "2",
            name: "edit_file",
            input: {
              path: "src/cart.js",
              old_string: "return total - percent;",
              new_string: "return total - (total * percent) / 100;",
            },
          },
        ],
        [{ id: "3", name: "bash", input: { command: "node --test" } }],
        [
          {
            id: "4",
            name: "finish",
            input: {
              title: "Fix percentage discounts in applyDiscount",
              summary: "Discounts were subtracted as flat amounts; they are now percentages.",
              verification: "node --test passes",
              reproduced: true,
              complete: true,
            },
          },
        ],
      ]);

      const outcome = await runner(model).run(job("BUG-0001"), ctx);
      const result = outcome.result as AgentJobResult;

      expect(outcome.status, JSON.stringify(result, null, 2)).toBe("succeeded");
      expect(result).toMatchObject({
        outcome: "pr_opened",
        branch: "agent/bug-0001-fix-percentage-discounts-in-applydiscoun",
        prNumber: 1,
        filesChanged: 1,
        insertions: 1,
        deletions: 1,
        reproduced: true,
        tests: { passed: true, summary: "1 passed · 0 failed" },
      });
      expect(outcome.costUsd).toBeCloseTo(0.04);
      expect(prs[0]).toMatchObject({
        head: result.branch,
        base: "main",
        title: "Fix percentage discounts in applyDiscount",
        draft: false,
      });
      expect(prs[0]?.body).toContain("Bug reproduced before fix: yes");

      // The tool result from the bash step proves the fix was verified inside the sandbox.
      expect(JSON.stringify(model.requests[3]?.messages.at(-1))).toContain("pass 1");

      const verify = path.join(root, "verify");
      execFileSync("git", ["clone", "-q", "-b", result.branch ?? "", remote, verify]);
      expect(await readFile(path.join(verify, "src/cart.js"), "utf8")).toContain(
        "(total * percent) / 100",
      );
      const log = execFileSync("git", ["log", "-1", "--format=%an <%ae>%n%B"], {
        cwd: verify,
        encoding: "utf8",
      });
      expect(log).toContain("DoomsCode-Y <42+DoomsCode-Y@users.noreply.github.com>");
      expect(log).toContain("Job: BUG-0001");
      // Files produced by setup (npm install's package-lock.json), reports and .env never reach the branch.
      expect(execFileSync("git", ["ls-files"], { cwd: verify, encoding: "utf8" })).not.toMatch(
        /\.agent-report|\.env|package-lock\.json/,
      );
    });

    it("re-detects a test setup added by the agent and opens a ready PR", async () => {
      // A repo with no test script at all: the initial plan has no test command.
      const bare = path.join(root, "no-tests.git");
      const seed = path.join(root, "no-tests-seed");
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
      execFileSync("git", ["init", "-q", "-b", "main", seed]);
      await writeFile(
        path.join(seed, "package.json"),
        `${JSON.stringify({ name: "adder", private: true, type: "module" }, null, 2)}\n`,
      );
      await writeFile(path.join(seed, "add.js"), "export const add = (a, b) => a + b;\n");
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: seed });
      git("add", ".");
      git("commit", "-qm", "base");
      git("push", "-q", bare, "main");

      const model = scriptedModel([
        [
          {
            id: "1",
            name: "write_file",
            input: {
              path: "package.json",
              content: `${JSON.stringify({ name: "adder", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
            },
          },
          {
            id: "2",
            name: "write_file",
            input: {
              path: "add.test.js",
              content:
                'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "./add.js";\n\ntest("adds", () => assert.equal(add(2, 3), 5));\n',
            },
          },
        ],
        [
          {
            id: "3",
            name: "finish",
            input: {
              title: "Add tests for add",
              summary: "Adds node:test coverage.",
              verification: "node --test",
              complete: true,
            },
          },
        ],
      ]);
      const outcome = await runner(model, bare, "task").run(job("TASK-0005"), ctx);
      const result = outcome.result as AgentJobResult;
      expect(outcome.status, JSON.stringify(result, null, 2)).toBe("succeeded");
      expect(result).toMatchObject({
        outcome: "pr_opened",
        tests: {
          command: expect.stringContaining("node --test"),
          passed: true,
          summary: "1 passed · 0 failed",
        },
      });
      expect(prs.at(-1)).toMatchObject({ draft: false, title: "Add tests for add" });
      expect(prs.at(-1)?.body).not.toMatch(/\n\n- /);
    });

    it("blocks patches that touch CI workflows and pushes nothing", async () => {
      const before = prs.length;
      const model = scriptedModel([
        [
          {
            id: "1",
            name: "write_file",
            input: { path: ".github/workflows/deploy.yml", content: "on: push\njobs: {}\n" },
          },
        ],
        [
          {
            id: "2",
            name: "finish",
            input: {
              title: "Add deploy",
              summary: "x",
              verification: "",
              reproduced: false,
              complete: true,
            },
          },
        ],
      ]);
      const outcome = await runner(model).run(job("BUG-0002"), ctx);
      const result = outcome.result as AgentJobResult;
      expect(outcome.status).toBe("failed");
      expect(result.outcome).toBe("rejected");
      expect(result.violations).toEqual([".github/workflows/deploy.yml: modifies CI workflows"]);
      expect(prs.length).toBe(before);
      const branches = execFileSync("git", ["branch", "--list"], { cwd: remote, encoding: "utf8" });
      expect(branches).not.toContain("bug-0002");
    });

    it("opens a draft marked partial when the agent runs out of steps with changes", async () => {
      const steps: StepToolCall[][] = [
        [{ id: "1", name: "write_file", input: { path: "notes.md", content: "wip\n" } }],
        ...Array.from({ length: 40 }, (_, i) => [
          { id: `r${i}`, name: "read_file", input: { path: "src/cart.js" } },
        ]),
      ];
      const outcome = await runner(scriptedModel(steps)).run(job("BUG-0003"), ctx);
      const result = outcome.result as AgentJobResult;
      expect(outcome.status).toBe("partial");
      expect(result).toMatchObject({ outcome: "draft_pr", stopReason: "max_iterations" });
      expect(prs.at(-1)).toMatchObject({ draft: true });
      expect(prs.at(-1)?.title.startsWith("[partial] ")).toBe(true);
    });
  },
);
