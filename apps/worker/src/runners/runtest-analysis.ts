import { readOnlyTools, runAgent } from "@dca/agent";
import type { RuntestAnalysis, RuntestResult } from "@dca/core";
import type { Job } from "@dca/db";
import { getProfile, RUNTEST_ANALYSIS_SYSTEM } from "@dca/profiles";
import type { RepoPlan, Sandbox } from "@dca/sandbox";
import { z } from "zod";
import type { AgentRuntime } from "../agent-runtime.ts";

const MIN_ANALYSIS_MS = 45_000;
const MAX_FAILURES_IN_PROMPT = 10;
const LOG_CHARS_IN_PROMPT = 6_000;

export const analysisSchema = z.object({
  likelyCause: z.string().min(1).max(1_000).describe("Root cause in at most three sentences"),
  confidence: z.enum(["low", "medium", "high"]),
  suggestedFix: z.string().max(1_000).optional().describe("Concrete fix, only if justified"),
  relevantFiles: z.array(z.string().max(300)).max(10).describe("file or file:line references"),
});

export interface AnalysisOutcome {
  analysis: RuntestAnalysis | null;
  note: string | null;
  model: string | null;
  iterations: number;
  costUsd: number;
}

export function buildAnalysisPrompt(job: Job, result: RuntestResult): string {
  const failures = (result.tests?.failures ?? [])
    .slice(0, MAX_FAILURES_IN_PROMPT)
    .map(
      (failure, i) =>
        `${i + 1}. ${failure.name}${failure.file ? ` (${failure.file})` : ""}\n${failure.message}`,
    )
    .join("\n\n");
  const log = result.logTail.slice(-LOG_CHARS_IN_PROMPT);
  return [
    `Repository: ${job.repo}`,
    `Ref: ${result.ref}${result.commit ? ` (commit ${result.commit})` : ""}`,
    `Test command: ${result.testCommand}`,
    `Result: ${result.summary} (exit code ${result.exitCode})`,
    "",
    failures
      ? `Failing tests:\n<failures>\n${failures}\n</failures>`
      : "No individual failures were reported.",
    "",
    `End of the test log:\n<log>\n${log}\n</log>`,
    "",
    "Find the most likely root cause of these failures, then call `finish`.",
  ].join("\n");
}

/** Runs a short, read-only agent in the same sandbox to explain failing tests. */
export async function analyzeFailures(options: {
  runtime: AgentRuntime;
  job: Job;
  sandbox: Sandbox;
  plan: RepoPlan;
  result: RuntestResult;
  deadline: number;
  signal: AbortSignal;
}): Promise<AnalysisOutcome> {
  const skipped = (note: string): AnalysisOutcome => ({
    analysis: null,
    note,
    model: null,
    iterations: 0,
    costUsd: 0,
  });

  const profile = getProfile("runtest");
  const models = options.runtime.modelsFor(profile);
  if (models.length === 0) return skipped("No LLM provider key configured for analysis");
  if (options.deadline - Date.now() < MIN_ANALYSIS_MS) {
    return skipped("Not enough time left in the 5 minute budget for analysis");
  }

  const outcome = await runAgent({
    models,
    system: RUNTEST_ANALYSIS_SYSTEM,
    prompt: buildAnalysisPrompt(options.job, options.result),
    tools: readOnlyTools(options.sandbox, { env: options.plan.env, commandTimeoutMs: 60_000 }),
    finishSchema: analysisSchema,
    finishDescription: "Report the root cause of the failing tests. Ends the investigation.",
    limits: {
      maxIterations: profile.limits.maxIterations,
      deadline: options.deadline,
      maxUsd: profile.limits.maxUsd,
    },
    signal: options.signal,
    hooks: options.runtime.hooksFor(options.job.id),
  });

  const notes: Record<string, string> = {
    max_iterations: `Analysis stopped after ${profile.limits.maxIterations} steps without a conclusion`,
    timeout: "Analysis ran out of time",
    budget: `Analysis reached its $${profile.limits.maxUsd} budget`,
    no_tool_call: "The model did not return a structured conclusion",
    blocked: outcome.detail ?? "Analysis was blocked",
  };
  return {
    analysis: outcome.result,
    note: outcome.reason === "finished" ? null : (notes[outcome.reason] ?? outcome.reason),
    model: outcome.modelUsed,
    iterations: outcome.iterations,
    costUsd: outcome.costUsd,
  };
}
