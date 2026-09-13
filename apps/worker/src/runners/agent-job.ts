import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { type AgentStopReason, readOnlyTools, runAgent, writeTools } from "@dca/agent";
import { type AgentJobResult, parseRepo, type RepoRef } from "@dca/core";
import type { Attachment, Job } from "@dca/db";
import {
  applyPatchToWorktree,
  branchSlug,
  CheckoutError,
  type CheckoutOptions,
  type CheckoutResult,
  checkoutRepo,
  checkPatch,
  type GitHubClient,
  PushError,
  type PushPatchOptions,
  parseIssueRef,
  pushPatch,
  resolveRef,
} from "@dca/github";
import { BUGREPORT_SYSTEM, getProfile, TASK_SYSTEM } from "@dca/profiles";
import {
  AgentConfigError,
  DetectionError,
  parseAgentConfig,
  planRepo,
  REPORT_DIR,
  type RepoPlan,
  type Sandbox,
  type SandboxProvider,
  type Stack,
  shellQuote,
  skippedPackages,
} from "@dca/sandbox";
import { noTestsCollected, parseJestJson, parseJUnit, parseOutput } from "@dca/test-report";
import type { UserContent } from "ai";
import { z } from "zod";
import type { AgentRuntime } from "../agent-runtime.ts";
import { AbortedError, type JobRunner, type RunContext, type RunOutcome } from "../runner.ts";
import { hostRepoFiles, summarizeTests } from "./runtest.ts";

type AgentJobType = "task" | "bugreport";

export interface AgentJobRunnerOptions {
  type: AgentJobType;
  sandbox: SandboxProvider;
  github: GitHubClient;
  agent: AgentRuntime;
  token: string;
  workspacesDir: string;
  images: Record<Stack, string>;
  listAttachments: (jobId: string) => Promise<Attachment[]>;
  checkout?: (options: CheckoutOptions) => Promise<CheckoutResult>;
  push?: (options: PushPatchOptions) => Promise<{ commit: string }>;
}

const finishSchemas = {
  task: z.object({
    title: z.string().min(1).max(100).describe("Pull request title, imperative mood"),
    summary: z.string().min(1).max(3_000).describe("What changed and why"),
    verification: z.string().max(1_500).describe("How the change was verified"),
    complete: z.boolean().describe("false if the work is unfinished; explain what is left"),
  }),
  bugreport: z.object({
    title: z.string().min(1).max(100).describe('Pull request title, e.g. "Fix ..."'),
    summary: z.string().min(1).max(3_000).describe("Root cause and the fix"),
    verification: z.string().max(1_500).describe("How the fix was verified"),
    reproduced: z.boolean().describe("Whether the bug was reproduced before fixing"),
    complete: z.boolean().describe("false if the work is unfinished; explain what is left"),
  }),
};

type FinishResult =
  | z.infer<(typeof finishSchemas)["bugreport"]>
  | z.infer<(typeof finishSchemas)["task"]>;

const INSTALL_TIMEOUT_MS = 8 * 60_000;
const DEPENDENCY_MANIFEST =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|uv\.lock|setup\.py|setup\.cfg)$/;
const MIN_AGENT_MS = 60_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ATTACHMENTS_DIR = "/workspace/attachments";

const STOP_NOTES: Partial<Record<AgentStopReason, string>> = {
  max_iterations: "The agent reached its step limit before finishing.",
  timeout: "The agent ran out of time before finishing.",
  budget: "The agent reached its cost limit before finishing.",
  no_tool_call: "The agent stopped without calling finish.",
};

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

/** `/task` and `/bugreport`: agent edits in the sandbox, host applies the patch and opens a PR. */
export class AgentJobRunner implements JobRunner {
  readonly #opts: AgentJobRunnerOptions;

  constructor(options: AgentJobRunnerOptions) {
    this.#opts = options;
  }

  async run(job: Job, ctx: RunContext): Promise<RunOutcome> {
    const { type } = this.#opts;
    const profile = getProfile(type);
    const started = Date.now();
    const deadline = started + profile.limits.maxMinutes * 60_000;
    // Keep time for final tests and pushing after the agent stops.
    const finalizeReserveMs = Math.min(3 * 60_000, profile.limits.maxMinutes * 60_000 * 0.2);
    const workdir = path.join(this.#opts.workspacesDir, job.id);
    const pushDir = path.join(this.#opts.workspacesDir, `${job.id}-push`);

    const result: AgentJobResult = {
      kind: type,
      outcome: "error",
      title: "",
      summary: "",
      base: "",
      commit: null,
      branch: null,
      prNumber: null,
      prUrl: null,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      tests: { command: null, passed: null, summary: "not run" },
      reproduced: null,
      stopReason: "not_started",
      violations: [],
      notes: [],
      model: null,
    };
    let iterations = 0;
    let costUsd = 0;
    let sandbox: Sandbox | null = null;

    const done = (status: RunOutcome["status"], error?: string): RunOutcome => ({
      status,
      error,
      result,
      iterations,
      costUsd,
      modelUsed: result.model ?? undefined,
      prUrl: result.prUrl ?? undefined,
    });
    const fail = (message: string) => {
      result.summary ||= message;
      return done("failed", message);
    };
    const throwIfAborted = () => {
      if (ctx.signal.aborted) throw new AbortedError();
    };

    try {
      const repo = parseRepo(job.repo);
      if (!repo) return fail(`Invalid repository ${job.repo}`);
      const models = this.#opts.agent.modelsFor(profile);
      if (models.length === 0)
        return fail(`No LLM provider key configured for ${profile.model.primary}`);

      const access = await this.#opts.github.checkRepoAccess(repo);
      if (!access.ok) return fail(`Repository is no longer accessible (${access.reason})`);
      result.base =
        nonEmpty(job.input.base) ?? nonEmpty(job.ref ?? undefined) ?? access.defaultBranch;
      const baseRef = resolveRef(result.base, access.defaultBranch);
      if (baseRef.kind === "pr") return fail("The base must be a branch, not a pull request");

      await rm(workdir, { recursive: true, force: true });
      await mkdir(this.#opts.workspacesDir, { recursive: true });
      const checkout = await (this.#opts.checkout ?? checkoutRepo)({
        repo,
        ref: baseRef,
        dir: workdir,
        token: this.#opts.token,
      });
      result.commit = checkout.commit;
      throwIfAborted();

      const plan = this.#plan(workdir, result.notes);
      sandbox = await this.#opts.sandbox.create({
        jobId: job.id,
        image: this.#opts.images[plan?.stack ?? "node"],
      });
      await sandbox.copyIn(workdir, sandbox.repoDir);
      await ctx.markRunning();

      // Keep generated and dependency files out of the patch without touching tracked files.
      const excludes = [`${REPORT_DIR}/`, ".env", "node_modules/", ".venv/", "__pycache__/"];
      await sandbox.exec(
        `mkdir -p .git/info && printf '%s\\n' ${excludes.map(shellQuote).join(" ")} >> .git/info/exclude`,
        { timeoutMs: 10_000 },
      );
      if (plan?.envFile) {
        await sandbox.exec(`[ -e .env ] || cp -- ${shellQuote(plan.envFile)} .env`, {
          timeoutMs: 10_000,
        });
      }
      let installOk = true;
      if (plan?.install) {
        const install = await sandbox.exec(plan.install, {
          env: plan.env,
          timeoutMs: Math.min(
            INSTALL_TIMEOUT_MS,
            deadline - finalizeReserveMs - MIN_AGENT_MS - Date.now(),
          ),
        });
        const skipped = skippedPackages(install.output);
        if (skipped.length) {
          result.notes.push(`Could not install: ${skipped.join(", ")}.`);
        }
        if (install.exitCode !== 0) {
          installOk = false;
          ctx.log.warn(
            { exitCode: install.exitCode, output: install.output.slice(-2_000) },
            "dependency install failed",
          );
          result.notes.push(
            install.timedOut
              ? "Dependency install timed out; the agent worked without a full install."
              : `Dependency install failed (exit ${install.exitCode}); the agent worked without a full install.`,
          );
        }
      }
      throwIfAborted();

      // Snapshot the tree after setup (e.g. a lockfile written by `npm install`) so the patch
      // contains only the agent's edits. This commit exists only inside the sandbox.
      const baseline = await sandbox.exec(
        "git add -A && git -c user.name=sandbox -c user.email=sandbox@localhost -c core.hooksPath=/dev/null commit -q --no-verify --allow-empty -m 'sandbox baseline' && git rev-parse HEAD",
        { timeoutMs: 120_000 },
      );
      if (baseline.exitCode !== 0) {
        return fail(`Could not snapshot the workspace: ${baseline.output.slice(0, 300)}`);
      }
      const baselineCommit = baseline.stdout.trim().split("\n").at(-1) ?? "";

      const prompt = await this.#prompt(job, repo, sandbox, plan);
      const agentDeadline = deadline - finalizeReserveMs;
      if (agentDeadline - Date.now() < MIN_AGENT_MS)
        return fail("Not enough time left after setup to run the agent");

      const tools = [
        ...readOnlyTools(sandbox, { env: plan?.env, commandTimeoutMs: 5 * 60_000 }),
        ...writeTools(sandbox),
      ];
      const outcome = await runAgent<FinishResult>({
        models,
        system: type === "task" ? TASK_SYSTEM : BUGREPORT_SYSTEM,
        prompt,
        tools,
        finishSchema: finishSchemas[type] as z.ZodType<FinishResult>,
        finishDescription:
          "Call when the work is done (or you must stop). The system then exports your changes and opens a pull request.",
        limits: {
          maxIterations: profile.limits.maxIterations,
          deadline: agentDeadline,
          maxUsd: profile.limits.maxUsd,
        },
        signal: ctx.signal,
        hooks: this.#opts.agent.hooksFor(job.id),
      });
      iterations = outcome.iterations;
      costUsd = outcome.costUsd;
      result.model = outcome.modelUsed;
      result.stopReason = outcome.reason;
      if (outcome.reason === "aborted") throw new AbortedError();
      if (outcome.reason === "blocked") return fail(outcome.detail ?? "Agent was blocked");

      const finish = outcome.result;
      const complete = outcome.reason === "finished" && finish?.complete !== false;
      result.title = finish?.title ?? this.#fallbackTitle(job);
      result.summary = finish
        ? [finish.summary, finish.verification ? `**Verification:** ${finish.verification}` : ""]
            .filter(Boolean)
            .join("\n\n")
        : outcome.lastText || "The agent stopped before summarising its work.";
      if (finish && "reproduced" in finish) result.reproduced = finish.reproduced;
      const stopNote = STOP_NOTES[outcome.reason];
      if (stopNote) result.notes.push(stopNote);

      const baseCommit = checkout.commit;
      const patchFile = "/tmp/agent-changes.patch";
      const exported = await sandbox.exec(
        `git add -A && git diff --cached --binary --no-color ${shellQuote(baselineCommit)} > ${patchFile}`,
        { timeoutMs: 60_000 },
      );
      if (exported.exitCode !== 0) {
        return fail(`Could not export changes: ${exported.output.slice(0, 300)}`);
      }
      const patch = (await sandbox.readFile(patchFile))?.toString("utf8") ?? "";
      if (!patch.trim()) {
        result.outcome = "no_changes";
        return complete
          ? done("succeeded")
          : fail(`${stopNote ?? "The agent stopped"} No changes were made.`);
      }

      const { stats, violations } = checkPatch(patch);
      result.filesChanged = stats.files.length;
      result.insertions = stats.insertions;
      result.deletions = stats.deletions;
      if (violations.length) {
        result.outcome = "rejected";
        result.violations = violations;
        return fail(`Changes were blocked by safety checks: ${violations.slice(0, 3).join("; ")}`);
      }

      // Re-detect from the changed tree: the agent may have added a test setup or dependencies.
      const finalPlan = await this.#replan(workdir, patch, plan, result.notes);
      const manifestChanged = stats.files.some((file) => DEPENDENCY_MANIFEST.test(file.path));
      if (
        finalPlan?.install &&
        (!installOk || manifestChanged || finalPlan.install !== plan?.install)
      ) {
        const timeoutMs = Math.min(INSTALL_TIMEOUT_MS, deadline - Date.now() - 90_000);
        if (timeoutMs > 20_000) {
          const reinstall = await sandbox.exec(finalPlan.install, {
            env: finalPlan.env,
            timeoutMs,
          });
          const skippedAgain = skippedPackages(reinstall.output);
          if (skippedAgain.length) {
            result.notes.push(`Could not install: ${skippedAgain.join(", ")}.`);
          }
          if (reinstall.exitCode !== 0) {
            result.notes.push(
              `Dependency install before the final test run failed (exit ${reinstall.exitCode}).`,
            );
          }
        }
      }
      await this.#runFinalTests(sandbox, finalPlan, result, deadline);
      throwIfAborted();

      // Point of no return: from here the branch and PR exist even if the user cancels.
      const bot = await this.#opts.github.getAuthenticatedUser();
      result.branch = `agent/${job.shortId.toLowerCase()}-${branchSlug(result.title)}`;
      await rm(pushDir, { recursive: true, force: true });
      await (this.#opts.push ?? pushPatch)({
        repo,
        baseCommit,
        patch,
        branch: result.branch,
        message: `${result.title}\n\n${finish?.summary ?? ""}\n\nJob: ${job.shortId}`.trim(),
        author: { name: bot.login, email: `${bot.id}+${bot.login}@users.noreply.github.com` },
        token: this.#opts.token,
        dir: pushDir,
      });

      const ready = complete && result.tests.passed === true;
      if (!ready && complete) {
        result.notes.push(
          result.tests.passed === false
            ? "Opened as draft because tests are failing."
            : "Opened as draft because no test run confirmed the change.",
        );
      }
      const pr = await this.#opts.github.createPullRequest(repo, {
        head: result.branch,
        base: result.base,
        title: complete ? result.title : `[partial] ${result.title}`,
        body: this.#prBody(job, result, costUsd, complete),
        draft: !ready,
      });
      result.prNumber = pr.number;
      result.prUrl = pr.url;
      result.outcome = ready ? "pr_opened" : "draft_pr";
      return done(complete ? "succeeded" : "partial");
    } catch (error) {
      if (error instanceof AbortedError) throw error;
      if (
        error instanceof CheckoutError ||
        error instanceof PushError ||
        error instanceof DetectionError ||
        error instanceof AgentConfigError
      ) {
        return fail(error.message);
      }
      throw error;
    } finally {
      await sandbox?.destroy().catch((err) => ctx.log.warn({ err }, "sandbox destroy failed"));
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
      await rm(pushDir, { recursive: true, force: true }).catch(() => {});
      result.notes = [...new Set(result.notes)];
    }
  }

  #plan(workdir: string, notes: string[]): RepoPlan | null {
    const files = hostRepoFiles(workdir);
    try {
      const config = files.read(".agent.yml");
      return planRepo(files, config ? parseAgentConfig(config) : {});
    } catch (error) {
      if (error instanceof DetectionError || error instanceof AgentConfigError) {
        notes.push(`${error.message} The agent worked without automatic install/test commands.`);
        return null;
      }
      throw error;
    }
  }

  async #prompt(
    job: Job,
    repo: RepoRef,
    sandbox: Sandbox,
    plan: RepoPlan | null,
  ): Promise<UserContent> {
    const input = job.input;
    const lines: string[] = [
      `Repository: ${repo.fullName} (checked out at ${sandbox.repoDir}, base branch ${job.input.base ?? job.ref ?? "default"})`,
      plan
        ? `Detected ${plan.stack} project. Install: ${plan.install ?? "none"}. Tests: ${plan.test ?? "none found"}.`
        : "No install/test commands were detected.",
      "",
      this.#opts.type === "task" ? "## Requested change" : "## Bug report",
      `<request>\n${input.description ?? ""}\n</request>`,
    ];
    if (input.steps) lines.push("", "## Steps to reproduce", `<steps>\n${input.steps}\n</steps>`);
    if (input.expected)
      lines.push("", "## Expected behaviour", `<expected>\n${input.expected}\n</expected>`);

    if (input.issue) {
      const number = parseIssueRef(input.issue, repo);
      const issue = number
        ? await this.#opts.github.getIssue(repo, number).catch(() => null)
        : null;
      if (issue) {
        lines.push(
          "",
          `## Linked ${issue.isPullRequest ? "pull request" : "issue"} #${issue.number}: ${issue.title}`,
          `<issue>\n${issue.body.slice(0, 6_000)}\n</issue>`,
        );
      } else {
        lines.push("", `Linked issue reference (could not be loaded): ${input.issue}`);
      }
    }

    const images: UserContent = [];
    const attachments = await this.#opts.listAttachments(job.id);
    const files: string[] = [];
    for (const attachment of attachments) {
      const data = await readFile(attachment.path).catch(() => null);
      if (!data) continue;
      if (attachment.kind === "image" && data.byteLength <= MAX_IMAGE_BYTES) {
        images.push({ type: "image", image: data, mediaType: attachment.mime });
        files.push(`- ${attachment.filename} (image, shown below)`);
      } else {
        const target = `${ATTACHMENTS_DIR}/${path.basename(attachment.path)}`;
        await sandbox.writeFile(target, data);
        files.push(
          `- ${attachment.filename} → ${target} (read it with bash, e.g. \`tail -200 ${target}\`)`,
        );
      }
    }
    if (files.length) lines.push("", "## Attachments from the user", ...files);
    lines.push("", "Work on this now. Call `finish` when you are done.");

    return [{ type: "text", text: lines.join("\n") }, ...images];
  }

  async #runFinalTests(
    sandbox: Sandbox,
    plan: RepoPlan | null,
    result: AgentJobResult,
    deadline: number,
  ) {
    result.tests.command = plan?.test ?? null;
    if (!plan?.test) {
      result.tests.summary = "no test command detected";
      return;
    }
    const timeoutMs = deadline - Date.now() - 45_000;
    if (timeoutMs < 20_000) {
      result.tests.summary = "skipped: not enough time left";
      return;
    }
    await sandbox.exec(`rm -rf ${REPORT_DIR} && mkdir -p ${REPORT_DIR}`, { timeoutMs: 10_000 });
    const run = await sandbox.exec(plan.test, { env: plan.env, timeoutMs });
    if (run.timedOut) {
      result.tests.passed = false;
      result.tests.summary = "timed out";
      return;
    }
    let summary = null;
    if (plan.testReport && plan.reportFormat !== "none") {
      const report = await sandbox.readFile(`${sandbox.repoDir}/${plan.testReport}`);
      try {
        if (report?.byteLength) {
          summary =
            plan.reportFormat === "jest-json"
              ? parseJestJson(report.toString())
              : parseJUnit(report.toString());
        }
      } catch {
        summary = null;
      }
    }
    summary ??= parseOutput(run.output);
    if (noTestsCollected(run.exitCode, summary)) {
      result.tests.passed = null;
      result.tests.summary = "no tests were collected";
      return;
    }
    result.tests.passed = run.exitCode === 0 && (summary?.failed ?? 0) === 0;
    result.tests.summary = summarizeTests(summary, run.exitCode);
  }

  #fallbackTitle(job: Job): string {
    const text = (job.input.description ?? "").replace(/\s+/g, " ").trim();
    const prefix = this.#opts.type === "bugreport" ? "Fix: " : "";
    return `${prefix}${text.slice(0, 70)}` || job.shortId;
  }

  #prBody(job: Job, result: AgentJobResult, costUsd: number, complete: boolean): string {
    const tests = result.tests.command
      ? `\`${result.tests.command}\` → ${result.tests.summary}`
      : result.tests.summary;
    const checks = [
      `- Tests: ${tests}`,
      ...(result.reproduced === null
        ? []
        : [`- Bug reproduced before fix: ${result.reproduced ? "yes" : "no"}`]),
      ...result.notes.map((note) => `- ${note}`),
    ];
    return [
      ...(complete
        ? []
        : ["> ⚠️ **Partial work.** The agent stopped before finishing; review carefully.", ""]),
      result.summary,
      "",
      "### Checks",
      ...checks,
      "",
      "---",
      `🤖 Opened by the Discord coding agent for **${job.shortId}** (\`${job.type}\`, requested by Discord user ${job.requestedByDiscordId}).`,
      `Model: \`${result.model ?? "unknown"}\` · Cost: $${costUsd.toFixed(2)}`,
    ].join("\n");
  }

  async #replan(
    workdir: string,
    patch: string,
    original: RepoPlan | null,
    notes: string[],
  ): Promise<RepoPlan | null> {
    try {
      await applyPatchToWorktree(workdir, patch);
    } catch {
      notes.push("Could not re-inspect the changed files; used the original test command.");
      return original;
    }
    return this.#plan(workdir, []) ?? original;
  }
}
