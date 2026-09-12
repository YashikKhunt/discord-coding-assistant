import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseRepo, type RuntestResult } from "@dca/core";
import type { Job } from "@dca/db";
import {
  CheckoutError,
  type CheckoutOptions,
  type CheckoutResult,
  checkoutRepo,
  type GitHubClient,
  resolveRef,
} from "@dca/github";
import { getProfile } from "@dca/profiles";
import {
  AgentConfigError,
  DetectionError,
  type ExecResult,
  HeadTailBuffer,
  parseAgentConfig,
  planRepo,
  REPORT_DIR,
  type RepoFiles,
  type RepoPlan,
  type Sandbox,
  type SandboxProvider,
  type Stack,
  shellQuote,
} from "@dca/sandbox";
import { parseJestJson, parseJUnit, parseOutput, type TestSummary } from "@dca/test-report";
import { AbortedError, type JobRunner, type RunContext, type RunOutcome } from "../runner.ts";

export type { RuntestResult };

export interface RuntestRunnerOptions {
  sandbox: SandboxProvider;
  github: GitHubClient;
  token: string;
  workspacesDir: string;
  images: Record<Stack, string>;
  checkout?: (options: CheckoutOptions) => Promise<CheckoutResult>;
}

const LOG_TAIL_BYTES = 24_000;
const MAX_CONFIG_FILE_BYTES = 1_000_000;

function hostRepoFiles(dir: string): RepoFiles {
  const resolve = (file: string) => {
    const full = path.resolve(dir, file);
    return full.startsWith(`${path.resolve(dir)}${path.sep}`) ? full : null;
  };
  return {
    exists: (file) => {
      const full = resolve(file);
      return full !== null && existsSync(full);
    },
    read: (file) => {
      const full = resolve(file);
      if (!full || !existsSync(full)) return null;
      const stat = statSync(full);
      return stat.isFile() && stat.size <= MAX_CONFIG_FILE_BYTES
        ? readFileSync(full, "utf8")
        : null;
    },
  };
}

export function summarizeTests(tests: TestSummary | null, exitCode: number | null): string {
  if (!tests) {
    return exitCode === 0
      ? "Tests passed (no machine-readable report)"
      : `Tests failed with exit code ${exitCode}`;
  }
  const parts = [`${tests.passed} passed`, `${tests.failed} failed`];
  if (tests.skipped) parts.push(`${tests.skipped} skipped`);
  if (exitCode !== 0 && tests.failed === 0) parts.push(`test command exited with code ${exitCode}`);
  return parts.join(" · ");
}

/** Deterministic `/runtest`: checkout → detect → install → test → parse. No LLM involved. */
export class RuntestRunner implements JobRunner {
  readonly #opts: RuntestRunnerOptions;

  constructor(options: RuntestRunnerOptions) {
    this.#opts = options;
  }

  async run(job: Job, ctx: RunContext): Promise<RunOutcome> {
    const started = Date.now();
    const deadline = started + getProfile("runtest").limits.maxMinutes * 60_000;
    const log = new HeadTailBuffer(LOG_TAIL_BYTES);
    const workdir = path.join(this.#opts.workspacesDir, job.id);
    const result: RuntestResult = {
      kind: "runtest",
      outcome: "error",
      summary: "",
      ref: job.ref ?? "",
      commit: null,
      stack: null,
      installCommand: null,
      testCommand: null,
      exitCode: null,
      tests: null,
      durationMs: 0,
      notes: [],
      logTail: "",
    };
    let sandbox: Sandbox | null = null;

    const fail = (message: string): RunOutcome => {
      result.summary = message;
      result.durationMs = Date.now() - started;
      result.logTail = log.toString();
      return { status: "failed", error: message, result, iterations: 0, costUsd: 0 };
    };
    const remaining = () => deadline - Date.now();

    try {
      const repo = parseRepo(job.repo);
      if (!repo) return fail(`Invalid repository ${job.repo}`);

      const access = await this.#opts.github.checkRepoAccess(repo);
      if (!access.ok) return fail(`Repository is no longer accessible (${access.reason})`);
      const ref = resolveRef(job.ref, access.defaultBranch);
      result.ref = job.ref?.trim() || access.defaultBranch;

      await rm(workdir, { recursive: true, force: true });
      await mkdir(path.dirname(workdir), { recursive: true });
      const checkout = await (this.#opts.checkout ?? checkoutRepo)({
        repo,
        ref,
        dir: workdir,
        token: this.#opts.token,
      });
      result.commit = checkout.commit;
      this.#throwIfAborted(ctx);

      const files = hostRepoFiles(workdir);
      const configSource = files.read(".agent.yml");
      const plan: RepoPlan = planRepo(files, configSource ? parseAgentConfig(configSource) : {});
      result.stack = plan.stack;
      result.installCommand = plan.install;
      result.testCommand = plan.test;
      result.notes = plan.notes;
      if (!plan.test) return fail("No test command found. Add a test script or an .agent.yml.");

      sandbox = await this.#opts.sandbox.create({
        jobId: job.id,
        image: this.#opts.images[plan.stack],
      });
      await sandbox.copyIn(workdir, sandbox.repoDir);
      await ctx.markRunning();

      if (plan.envFile) {
        await sandbox.exec(`[ -e .env ] || cp -- ${shellQuote(plan.envFile)} .env`, {
          timeoutMs: 10_000,
        });
      }

      if (plan.install) {
        const install = await this.#step(sandbox, plan.install, plan, log, remaining(), ctx);
        if (install.timedOut) return fail("Timed out while installing dependencies");
        if (install.exitCode !== 0) {
          return fail(`Dependency install failed with exit code ${install.exitCode}`);
        }
      }

      await sandbox.exec(`rm -rf ${REPORT_DIR} && mkdir -p ${REPORT_DIR}`, { timeoutMs: 10_000 });
      const test = await this.#step(sandbox, plan.test, plan, log, remaining(), ctx);
      result.exitCode = test.exitCode;
      if (test.timedOut) return fail("Timed out while running tests");

      result.tests = await this.#readReport(sandbox, plan, test);
      const ran = result.tests !== null || test.exitCode === 0;
      if (!ran && test.exitCode !== 1) {
        // Exit code 1 conventionally means "tests failed"; anything else without a report is a crash.
        return fail(`Test command exited with code ${test.exitCode} and produced no results`);
      }

      const failed = test.exitCode !== 0 || (result.tests?.failed ?? 0) > 0;
      result.outcome = failed ? "failed" : "passed";
      result.summary = summarizeTests(result.tests, test.exitCode);
      result.durationMs = Date.now() - started;
      result.logTail = log.toString();
      return { status: "succeeded", result, iterations: 0, costUsd: 0 };
    } catch (error) {
      if (error instanceof AbortedError) throw error;
      if (
        error instanceof CheckoutError ||
        error instanceof DetectionError ||
        error instanceof AgentConfigError
      ) {
        return fail(error.message);
      }
      throw error;
    } finally {
      await sandbox?.destroy().catch((err) => ctx.log.warn({ err }, "sandbox destroy failed"));
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  #throwIfAborted(ctx: RunContext) {
    if (ctx.signal.aborted) throw new AbortedError();
  }

  async #step(
    sandbox: Sandbox,
    command: string,
    plan: RepoPlan,
    log: HeadTailBuffer,
    timeoutMs: number,
    ctx: RunContext,
  ): Promise<ExecResult> {
    this.#throwIfAborted(ctx);
    if (timeoutMs <= 0) {
      return { exitCode: 124, stdout: "", stderr: "", output: "", timedOut: true, durationMs: 0 };
    }
    log.push(`$ ${command}\n`);
    ctx.log.info({ command }, "sandbox step");
    const result = await sandbox.exec(command, { env: plan.env, timeoutMs });
    log.push(result.output);
    log.push(
      `\n[exit ${result.exitCode}${result.timedOut ? ", timed out" : ""} in ${Math.round(result.durationMs / 1000)}s]\n\n`,
    );
    this.#throwIfAborted(ctx);
    return result;
  }

  async #readReport(
    sandbox: Sandbox,
    plan: RepoPlan,
    test: ExecResult,
  ): Promise<TestSummary | null> {
    if (plan.testReport && plan.reportFormat !== "none") {
      const report = await sandbox.readFile(`${sandbox.repoDir}/${plan.testReport}`);
      if (report && report.byteLength > 0) {
        try {
          return plan.reportFormat === "jest-json"
            ? parseJestJson(report.toString("utf8"))
            : parseJUnit(report.toString("utf8"));
        } catch {
          // Fall through to output parsing when the report is malformed.
        }
      }
    }
    return parseOutput(test.output);
  }
}
