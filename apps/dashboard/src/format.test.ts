import { describe, expect, it } from "vitest";
import { compact, duration, fillDays, niceTicks, relativeTime, usd } from "./format.ts";

describe("format helpers", () => {
  it("formats money, counts and durations", () => {
    expect(usd(0.4061)).toBe("$0.41");
    expect(usd(0.004)).toBe("<$0.01");
    expect(usd(0)).toBe("$0.00");
    expect(compact(950)).toBe("950");
    expect(compact(41_426)).toBe("41K");
    expect(compact(2_441)).toBe("2.4K");
    expect(duration(166_000)).toBe("2m 46s");
    expect(duration(null)).toBe("—");
  });

  it("describes relative time", () => {
    const now = Date.parse("2026-09-13T15:00:00Z");
    expect(relativeTime("2026-09-13T14:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-09-13T14:41:00Z", now)).toBe("19m ago");
    expect(relativeTime("2026-09-12T15:00:00Z", now)).toBe("1d ago");
  });

  it("chooses clean axis ticks", () => {
    expect(niceTicks(0.37)).toEqual({ max: 0.4, ticks: [0, 0.1, 0.2, 0.3, 0.4] });
    expect(niceTicks(2)).toEqual({ max: 2, ticks: [0, 0.5, 1, 1.5, 2] });
    expect(niceTicks(0).max).toBe(1);
  });

  it("fills missing days with zero", () => {
    const filled = fillDays(
      [{ day: "2026-09-12", costUsd: 0.4 }],
      3,
      new Date("2026-09-13T10:00:00Z"),
    );
    expect(filled).toEqual([
      { day: "2026-09-11", costUsd: 0 },
      { day: "2026-09-12", costUsd: 0.4 },
      { day: "2026-09-13", costUsd: 0 },
    ]);
  });
});
