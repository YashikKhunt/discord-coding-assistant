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
}

export function isRuntestResult(value: unknown): value is RuntestResult {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "runtest"
  );
}
