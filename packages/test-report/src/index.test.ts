import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { noTestsCollected, parseJestJson, parseJUnit, parseOutput } from "./index.ts";

// Fixtures are real reports: one passing, one failing, one skipped test (+ extras per runner).
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseJUnit", () => {
  it("parses node:test output, including top-level tests", () => {
    const summary = parseJUnit(fixture("node-junit.xml"));
    expect(summary).toMatchObject({ passed: 2, failed: 1, skipped: 1, source: "junit" });
    expect(summary.failures[0]?.name).toContain("subtracts wrongly");
    expect(summary.failures[0]?.message).toContain("2 !== 1");
    expect(summary.failures[0]?.file).toBe("/repo/math.test.mjs");
  });

  it("parses vitest output with duration", () => {
    const summary = parseJUnit(fixture("vitest-junit.xml"));
    expect(summary).toMatchObject({ passed: 2, failed: 1, skipped: 1 });
    expect(summary.failures[0]?.name).toBe("math.vitest.test.mjs › math > subtracts wrongly");
    expect(summary.durationMs).not.toBeNull();
  });

  it("parses pytest output, counting errors as failures", () => {
    const summary = parseJUnit(fixture("pytest-junit.xml"));
    expect(summary).toMatchObject({ passed: 1, failed: 2, skipped: 1 });
    expect(summary.durationMs).not.toBeNull();
    expect(summary.failures.map((failure) => failure.message).join("\n")).toMatch(/bad math/);
    expect(summary.failures.map((failure) => failure.message).join("\n")).toMatch(/boom/);
  });
});

describe("parseJestJson", () => {
  it("parses jest --json output", () => {
    const summary = parseJestJson(fixture("jest.json"));
    expect(summary).toMatchObject({ passed: 2, failed: 1, skipped: 1, source: "jest-json" });
    expect(summary.failures[0]?.name).toBe("math subtracts wrongly");
    expect(summary.failures[0]?.message).toContain("Expected value to strictly be equal to");
    expect(summary.failures[0]?.message).not.toMatch(/^\s+at /m);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("parseOutput", () => {
  it.each([
    ["pytest-out.txt", { passed: 1, failed: 2, skipped: 1 }],
    ["vitest-out.txt", { passed: 2, failed: 1, skipped: 1 }],
    ["jest-out.txt", { passed: 2, failed: 1, skipped: 1 }],
    ["node-out.txt", { passed: 2, failed: 1, skipped: 1 }],
    ["unittest-out.txt", { passed: 1, failed: 1, skipped: 1 }],
  ])("summarises %s", (name, expected) => {
    expect(parseOutput(fixture(name))).toMatchObject({ ...expected, source: "output" });
  });

  it("counts vitest files that failed to load", () => {
    const output = [
      " ❯ src/broken.test.ts (0 test)",
      " Test Files  2 failed | 9 passed (11)",
      "      Tests  31 passed | 18 skipped (49)",
    ].join("\n");
    expect(parseOutput(output)).toMatchObject({
      passed: 31,
      failed: 2,
      skipped: 18,
      failures: [{ name: "2 test file(s) failed to load" }],
    });
  });

  it("returns null for unrelated output", () => {
    expect(parseOutput("Compiling...\nDone.")).toBeNull();
  });
});

describe("noTestsCollected", () => {
  it("recognises exit code 5 with nothing run", () => {
    expect(noTestsCollected(5, null)).toBe(true);
    expect(noTestsCollected(5, parseOutput("Ran 0 tests in 0.000s\n\nNO TESTS RAN"))).toBe(true);
    expect(noTestsCollected(1, null)).toBe(false);
    expect(
      noTestsCollected(5, {
        passed: 1,
        failed: 0,
        skipped: 0,
        durationMs: 1,
        failures: [],
        source: "junit",
      }),
    ).toBe(false);
  });
});
