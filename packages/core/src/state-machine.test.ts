import { describe, expect, it } from "vitest";
import { isTerminal, JOB_STATUSES } from "./jobs.ts";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  sourcesFor,
} from "./state-machine.ts";

describe("job state machine", () => {
  it("follows the happy path", () => {
    expect(canTransition("queued", "preparing")).toBe(true);
    expect(canTransition("preparing", "running")).toBe(true);
    expect(canTransition("running", "finalizing")).toBe(true);
    expect(canTransition("finalizing", "succeeded")).toBe(true);
    expect(canTransition("finalizing", "partial")).toBe(true);
  });

  it("does not allow leaving terminal states", () => {
    for (const from of JOB_STATUSES.filter(isTerminal)) {
      for (const to of JOB_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("does not allow cancelling while finalizing (code may already be pushed)", () => {
    expect(canTransition("finalizing", "cancelled")).toBe(false);
  });

  it("throws a typed error on invalid transitions", () => {
    expect(() => assertTransition("queued", "succeeded")).toThrow(InvalidTransitionError);
  });

  it("lists valid sources for a target", () => {
    expect(sourcesFor("cancelled").sort()).toEqual(["preparing", "queued", "running"]);
  });
});
