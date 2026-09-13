/** Structured job results stored in `jobs.result` and rendered by the bot and dashboard. */

export interface TestFailure {
  name: string;
  file?: string;
  message: string;
}

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  /** null when the runner did not report a duration. */
  durationMs: number | null;
  failures: TestFailure[];
  source: "junit" | "jest-json" | "output";
}

export interface RuntestResult {
  [key: string]: unknown;
  kind: "runtest";
  /** `error` means the suite could not be run (checkout, install, timeout, crash). */
  outcome: "passed" | "failed" | "error";
  summary: string;
  ref: string;
  commit: string | null;
  stack: "node" | "python" | null;
  installCommand: string | null;
  testCommand: string | null;
  exitCode: number | null;
  tests: TestSummary | null;
  durationMs: number;
  notes: string[];
  logTail: string;
  /** LLM explanation of failing tests; null when tests passed or analysis was skipped. */
  analysis: RuntestAnalysis | null;
  /** Why analysis was skipped or stopped early, if it was. */
  analysisNote: string | null;
  /** `provider:model` that produced the analysis. */
  model: string | null;
}

export interface RuntestAnalysis {
  likelyCause: string;
  confidence: "low" | "medium" | "high";
  suggestedFix?: string;
  relevantFiles: string[];
}

export function isRuntestResult(value: unknown): value is RuntestResult {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "runtest"
  );
}

export interface AgentJobResult {
  [key: string]: unknown;
  kind: "task" | "bugreport";
  /**
   * `pr_opened`: ready for review; `draft_pr`: opened as draft (tests not passing, no tests, or
   * the run stopped early); `no_changes`: nothing to push; `rejected`: guardrails blocked the patch.
   */
  outcome: "pr_opened" | "draft_pr" | "no_changes" | "rejected" | "error";
  title: string;
  summary: string;
  base: string;
  commit: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  tests: { command: string | null; passed: boolean | null; summary: string };
  /** bugreport only: whether the agent reproduced the bug before fixing it. */
  reproduced: boolean | null;
  /** Why the agent stopped: finished, max_iterations, timeout, budget, ... */
  stopReason: string;
  violations: string[];
  notes: string[];
  model: string | null;
}

export function isAgentJobResult(value: unknown): value is AgentJobResult {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return kind === "task" || kind === "bugreport";
}
