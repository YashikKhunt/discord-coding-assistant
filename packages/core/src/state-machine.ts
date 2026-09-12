import type { JobStatus } from "./jobs.ts";

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["preparing", "cancelled", "failed"],
  preparing: ["running", "failed", "cancelled"],
  running: ["finalizing", "failed", "cancelled"],
  finalizing: ["succeeded", "partial", "failed"],
  succeeded: [],
  partial: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly from: JobStatus;
  readonly to: JobStatus;

  constructor(from: JobStatus, to: JobStatus) {
    super(`Invalid job transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Statuses from which a job may move to `to`. Used for guarded SQL updates. */
export function sourcesFor(to: JobStatus): JobStatus[] {
  return (Object.keys(TRANSITIONS) as JobStatus[]).filter((from) => canTransition(from, to));
}
