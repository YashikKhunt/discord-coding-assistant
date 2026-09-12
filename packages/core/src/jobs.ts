export const JOB_TYPES = ["task", "bugreport", "runtest"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "queued",
  "preparing",
  "running",
  "finalizing",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export const JOB_ID_PREFIX: Record<JobType, string> = {
  task: "TASK",
  bugreport: "BUG",
  runtest: "TEST",
};

const PREFIX_TO_TYPE = new Map<string, JobType>(
  Object.entries(JOB_ID_PREFIX).map(([type, prefix]) => [prefix, type as JobType]),
);

/** Formats a user-facing job ID, e.g. `formatShortId("task", 42)` → `TASK-0042`. */
export function formatShortId(type: JobType, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Job sequence must be a positive integer, got ${n}`);
  }
  return `${JOB_ID_PREFIX[type]}-${String(n).padStart(4, "0")}`;
}

/** Parses user input like `task-42` or `TASK-0042`. Returns null when invalid. */
export function parseShortId(input: string): { type: JobType; n: number; shortId: string } | null {
  const match = /^([a-z]+)-(\d+)$/i.exec(input.trim());
  if (!match) return null;
  const [, rawPrefix = "", rawN = ""] = match;
  const type = PREFIX_TO_TYPE.get(rawPrefix.toUpperCase());
  const n = Number(rawN);
  if (!type || n < 1) return null;
  return { type, n, shortId: formatShortId(type, n) };
}
