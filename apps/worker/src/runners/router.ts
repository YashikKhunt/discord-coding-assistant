import type { JobType } from "@dca/core";
import type { Job } from "@dca/db";
import type { JobRunner, RunContext, RunOutcome } from "../runner.ts";

/** Dispatches each job to the runner for its type. */
export class RouterRunner implements JobRunner {
  readonly #runners: Record<JobType, JobRunner>;

  constructor(runners: Record<JobType, JobRunner>) {
    this.#runners = runners;
  }

  run(job: Job, ctx: RunContext): Promise<RunOutcome> {
    return this.#runners[job.type].run(job, ctx);
  }
}
