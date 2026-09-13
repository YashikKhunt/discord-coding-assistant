import type { TestFailure, TestSummary } from "@dca/core";
import { XMLParser } from "fast-xml-parser";

export type { TestFailure, TestSummary } from "@dca/core";

const MAX_FAILURES = 50;
const MAX_MESSAGE = 1_000;

/** Strips ANSI colours and stack frames, keeping the assertion message. */
function firstLines(text: string, maxChars = MAX_MESSAGE): string {
  const trimmed = stripAnsi(text)
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (text: string) => text.replace(ANSI, "");

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

interface JUnitNode {
  "@_name"?: string;
  "@_classname"?: string;
  "@_file"?: string;
  "@_time"?: string;
  failure?: unknown;
  error?: unknown;
  skipped?: unknown;
  testcase?: JUnitNode | JUnitNode[];
  testsuite?: JUnitNode | JUnitNode[];
}

function nodeText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(nodeText).join("\n");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = typeof record["@_message"] === "string" ? record["@_message"] : "";
    const body = typeof record["#text"] === "string" ? record["#text"] : "";
    return [message, body].filter(Boolean).join("\n");
  }
  return String(value);
}

/** Parses JUnit XML as written by vitest, pytest, node:test and most CI reporters. */
export function parseJUnit(xml: string): TestSummary {
  const parser = new XMLParser({
    ignoreAttributes: false,
    allowBooleanAttributes: true,
    textNodeName: "#text",
    processEntities: true,
  });
  const doc = parser.parse(xml) as { testsuites?: JUnitNode; testsuite?: JUnitNode };
  const summary: TestSummary = {
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: null,
    failures: [],
    source: "junit",
  };

  const visitSuite = (suite: JUnitNode) => {
    for (const testcase of asArray(suite.testcase)) {
      // node:test nests testcases for subtests; count leaves only.
      if (testcase.testcase) {
        visitSuite(testcase);
        continue;
      }
      if (testcase.failure !== undefined || testcase.error !== undefined) {
        summary.failed++;
        if (summary.failures.length < MAX_FAILURES) {
          summary.failures.push({
            name: [testcase["@_classname"], testcase["@_name"]].filter(Boolean).join(" › "),
            file: testcase["@_file"] ?? suite["@_file"],
            message: firstLines(nodeText(testcase.failure ?? testcase.error)),
          });
        }
      } else if (testcase.skipped !== undefined) {
        summary.skipped++;
      } else {
        summary.passed++;
      }
    }
    for (const child of asArray(suite.testsuite)) visitSuite(child);
  };

  const roots = doc.testsuites ? [doc.testsuites] : asArray(doc.testsuite);
  for (const root of roots) visitSuite(root);

  // vitest puts the total on <testsuites>; pytest and node:test only on each <testsuite>.
  const seconds = (node: JUnitNode | undefined) =>
    node?.["@_time"] !== undefined && !Number.isNaN(Number(node["@_time"]))
      ? Number(node["@_time"])
      : null;
  const rootSeconds = roots.length === 1 ? seconds(roots[0]) : null;
  const suiteSeconds = roots
    .flatMap((root) => (doc.testsuites ? asArray(root.testsuite) : [root]))
    .map(seconds)
    .filter((value): value is number => value !== null);
  const total =
    rootSeconds ?? (suiteSeconds.length ? suiteSeconds.reduce((a, b) => a + b, 0) : null);
  if (total !== null) summary.durationMs = Math.round(total * 1000);
  return summary;
}

interface JestJson {
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests?: number;
  startTime?: number;
  testResults: {
    name: string;
    endTime?: number;
    message?: string;
    assertionResults: { fullName: string; status: string; failureMessages: string[] }[];
  }[];
}

export function parseJestJson(json: string): TestSummary {
  const data = JSON.parse(json) as JestJson;
  const failures: TestFailure[] = [];
  let lastEnd = 0;
  for (const file of data.testResults) {
    lastEnd = Math.max(lastEnd, file.endTime ?? 0);
    const failed = file.assertionResults.filter((assertion) => assertion.status === "failed");
    for (const assertion of failed) {
      if (failures.length >= MAX_FAILURES) break;
      failures.push({
        name: assertion.fullName,
        file: file.name,
        message: firstLines(assertion.failureMessages.join("\n")),
      });
    }
    // A test file that fails to load has no assertions but a message.
    if (failed.length === 0 && file.message && file.assertionResults.length === 0) {
      failures.push({
        name: "Test suite failed to run",
        file: file.name,
        message: firstLines(file.message),
      });
    }
  }
  return {
    passed: data.numPassedTests,
    failed: Math.max(data.numFailedTests, failures.length),
    skipped: data.numPendingTests + (data.numTodoTests ?? 0),
    durationMs: data.startTime && lastEnd ? lastEnd - data.startTime : null,
    failures,
    source: "jest-json",
  };
}

const num = (value: string | undefined) => (value ? Number(value) : 0);

/** Best-effort summary from console output when no machine-readable report exists. */
export function parseOutput(output: string): TestSummary | null {
  const text = stripAnsi(output);
  const base = { failures: [], source: "output" as const };

  // pytest: "==== 2 failed, 40 passed, 1 skipped in 1.23s ===="
  const pytest = [...text.matchAll(/=+ (.*?) in ([\d.]+)s(?: \([^)]*\))? =+/g)].at(-1);
  if (pytest?.[1] && /passed|failed|error|skipped/.test(pytest[1])) {
    const part = (label: string) => num(new RegExp(`(\\d+) ${label}`).exec(pytest[1] ?? "")?.[1]);
    return {
      ...base,
      passed: part("passed"),
      failed: part("failed") + part("errors?"),
      skipped: part("skipped"),
      durationMs: Math.round(Number(pytest[2]) * 1000),
    };
  }

  // vitest: "Test Files  1 failed | 9 passed (10)" then "Tests  2 failed | 42 passed | 1 skipped (45)"
  const vitest = [...text.matchAll(/^\s*Tests\s+(.+\(\d+\))\s*$/gm)].at(-1)?.[1];
  if (vitest) {
    const part = (label: string) => num(new RegExp(`(\\d+) ${label}`).exec(vitest)?.[1]);
    const files = [...text.matchAll(/^\s*Test Files\s+(.+\(\d+\))\s*$/gm)].at(-1)?.[1] ?? "";
    const failed = part("failed");
    // Files that fail to import report no failed tests; count them so the run is not "0 failed".
    const unloaded = failed === 0 ? num(/(\d+) failed/.exec(files)?.[1]) : 0;
    return {
      ...base,
      passed: part("passed"),
      failed: failed + unloaded,
      skipped: part("skipped") + part("todo"),
      durationMs: null,
      failures: unloaded
        ? [{ name: `${unloaded} test file(s) failed to load`, message: "See the attached log." }]
        : [],
    };
  }

  // jest: "Tests:       2 failed, 42 passed, 44 total"
  const jest = [...text.matchAll(/^Tests:\s+(.+total)\s*$/gm)].at(-1)?.[1];
  if (jest) {
    const part = (label: string) => num(new RegExp(`(\\d+) ${label}`).exec(jest)?.[1]);
    return {
      ...base,
      passed: part("passed"),
      failed: part("failed"),
      skipped: part("skipped") + part("todo"),
      durationMs: null,
    };
  }

  // node:test spec/tap: "ℹ pass 42" / "# pass 42"
  const nodePass = /^[#ℹ] pass (\d+)$/m.exec(text);
  if (nodePass) {
    return {
      ...base,
      passed: num(nodePass[1]),
      failed: num(/^[#ℹ] fail (\d+)$/m.exec(text)?.[1]),
      skipped:
        num(/^[#ℹ] skipped (\d+)$/m.exec(text)?.[1]) + num(/^[#ℹ] todo (\d+)$/m.exec(text)?.[1]),
      durationMs: /^[#ℹ] duration_ms ([\d.]+)$/m.exec(text)
        ? Math.round(Number(/^[#ℹ] duration_ms ([\d.]+)$/m.exec(text)?.[1]))
        : null,
    };
  }

  // unittest: "Ran 12 tests in 0.034s" + "OK" / "FAILED (failures=1, errors=1, skipped=2)"
  const ran = /^Ran (\d+) tests? in ([\d.]+)s$/m.exec(text);
  if (ran) {
    const total = num(ran[1]);
    const failedLine = /^FAILED \((.*)\)$/m.exec(text)?.[1] ?? "";
    const okLine = /^OK(?: \((.*)\))?$/m.exec(text)?.[1] ?? "";
    const field = (label: string) =>
      num(new RegExp(`${label}=(\\d+)`).exec(`${failedLine} ${okLine}`)?.[1]);
    const failed = field("failures") + field("errors");
    const skipped = field("skipped");
    return {
      ...base,
      passed: total - failed - skipped - field("expected failures"),
      failed,
      skipped,
      durationMs: Math.round(Number(ran[2]) * 1000),
    };
  }
  return null;
}

/**
 * pytest and unittest exit with code 5 when no tests were collected. That means "no tests",
 * not "tests failed".
 */
export function noTestsCollected(exitCode: number | null, summary: TestSummary | null): boolean {
  if (exitCode !== 5) return false;
  return !summary || summary.passed + summary.failed + summary.skipped === 0;
}
