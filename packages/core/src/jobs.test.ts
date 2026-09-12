import { describe, expect, it } from "vitest";
import { formatShortId, isTerminal, parseShortId } from "./jobs.ts";

describe("formatShortId", () => {
  it("pads and prefixes by type", () => {
    expect(formatShortId("task", 42)).toBe("TASK-0042");
    expect(formatShortId("bugreport", 7)).toBe("BUG-0007");
    expect(formatShortId("runtest", 12345)).toBe("TEST-12345");
  });

  it("rejects non-positive sequences", () => {
    expect(() => formatShortId("task", 0)).toThrow();
    expect(() => formatShortId("task", 1.5)).toThrow();
  });
});

describe("parseShortId", () => {
  it("accepts any casing and padding", () => {
    expect(parseShortId("task-42")).toEqual({ type: "task", n: 42, shortId: "TASK-0042" });
    expect(parseShortId(" BUG-0017 ")).toEqual({ type: "bugreport", n: 17, shortId: "BUG-0017" });
  });

  it("rejects unknown prefixes and junk", () => {
    expect(parseShortId("JOB-1")).toBeNull();
    expect(parseShortId("TASK-0")).toBeNull();
    expect(parseShortId("TASK42")).toBeNull();
    expect(parseShortId("")).toBeNull();
  });
});

describe("isTerminal", () => {
  it("classifies statuses", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("partial")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });
});
