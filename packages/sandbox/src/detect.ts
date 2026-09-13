import { parse as parseToml } from "smol-toml";
import type { AgentConfig } from "./agent-config.ts";

export type Stack = "node" | "python";
export type ReportFormat = "junit" | "jest-json" | "none";

export interface RepoPlan {
  stack: Stack;
  install: string | null;
  test: string | null;
  /** Report path relative to the repo root. */
  testReport: string | null;
  reportFormat: ReportFormat;
  envFile: string | null;
  /** Extra PATH entries for install/test (e.g. the Python venv). */
  env: Record<string, string>;
  /** Human-readable notes about how the plan was derived. */
  notes: string[];
}

/** Snapshot of the repo files detection looks at; read by the caller from the checkout. */
export interface RepoFiles {
  exists(path: string): boolean;
  read(path: string): string | null;
}

export class DetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectionError";
  }
}

export const REPORT_DIR = ".agent-report";
const JUNIT = `${REPORT_DIR}/junit.xml`;
const JEST_JSON = `${REPORT_DIR}/jest.json`;
const PY_VENV = "/workspace/venv";

interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson<T>(files: RepoFiles, path: string): T | null {
  const text = files.read(path);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DetectionError(`${path} is not valid JSON`);
  }
}

/**
 * `test` runs the package's test script; `exec` runs a binary from its dependencies. Reporter
 * flags are never appended to `<pm> test`: pnpm/yarn forward a literal `--` to the script and
 * pnpm also claims flags like `--reporter` for itself.
 */
function nodePackageManager(files: RepoFiles, pkg: PackageJson) {
  const declared = pkg.packageManager?.split("@")[0];
  if (declared === "pnpm" || files.exists("pnpm-lock.yaml")) {
    return {
      pm: "pnpm",
      install: "corepack pnpm install --frozen-lockfile",
      test: "corepack pnpm test",
      exec: "corepack pnpm exec",
    };
  }
  if (declared === "yarn" || files.exists("yarn.lock")) {
    return {
      pm: "yarn",
      install: "corepack yarn install --immutable",
      test: "corepack yarn test",
      exec: "corepack yarn run",
    };
  }
  if (files.exists("bun.lockb") || files.exists("bun.lock")) {
    throw new DetectionError("Bun projects are not supported yet; add an .agent.yml");
  }
  const install =
    files.exists("package-lock.json") || files.exists("npm-shrinkwrap.json")
      ? "npm ci --no-audit --no-fund"
      : "npm install --no-audit --no-fund";
  return { pm: "npm", install, test: "npm test", exec: "npm exec --" };
}

const NPM_PLACEHOLDER_TEST = /no test specified/;

/** A single command with plain arguments: no shell operators, substitutions or env prefixes. */
export function isSimpleCommand(script: string): boolean {
  return /^[\w@./-]+(?:\s+[\w@./:=,+-]+)*$/.test(script.trim()) && !/^\S*=/.test(script.trim());
}

function detectNode(files: RepoFiles, notes: string[]): Omit<RepoPlan, "envFile"> {
  const pkg = readJson<PackageJson>(files, "package.json") ?? {};
  const { pm, install, test, exec } = nodePackageManager(files, pkg);
  notes.push(`node project using ${pm}`);

  const script = pkg.scripts?.test?.trim();
  const base = { stack: "node" as const, install, env: {}, notes };

  if (!script || NPM_PLACEHOLDER_TEST.test(script)) {
    notes.push("no test script in package.json");
    return { ...base, test: null, testReport: null, reportFormat: "none" };
  }

  const bin = script.split(/\s+/)[0];
  if (isSimpleCommand(script)) {
    if (bin === "vitest") {
      return {
        ...base,
        test: `${exec} ${script} --reporter=default --reporter=junit --outputFile.junit=${JUNIT}`,
        testReport: JUNIT,
        reportFormat: "junit",
      };
    }
    if (bin === "jest") {
      return {
        ...base,
        test: `${exec} ${script} --ci --json --outputFile=${JEST_JSON}`,
        testReport: JEST_JSON,
        reportFormat: "jest-json",
      };
    }
    if (bin === "node" && /\s--test\b/.test(script)) {
      return {
        ...base,
        test: `${script} --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${JUNIT}`,
        testReport: JUNIT,
        reportFormat: "junit",
      };
    }
  }
  notes.push("test script is not a single known runner command; results parsed from output");
  return { ...base, test, testReport: null, reportFormat: "none" };
}

const PY_TEST_GROUPS = ["test", "tests", "testing", "dev"];

interface Pyproject {
  project?: { "optional-dependencies"?: Record<string, unknown> };
  "dependency-groups"?: Record<string, unknown>;
  tool?: { pytest?: unknown };
}

function readPyproject(files: RepoFiles): Pyproject {
  const text = files.read("pyproject.toml");
  if (!text) return {};
  try {
    return parseToml(text) as Pyproject;
  } catch {
    throw new DetectionError("pyproject.toml is not valid TOML");
  }
}

export const SKIPPED_PACKAGE_MARKER = "dca-skipped-package:";

/**
 * Installs a requirements file in one resolution, and if that fails (e.g. a package that has
 * to download sources from a host the egress proxy blocks), retries package by package so one
 * unbuildable dependency does not stop the rest. Skipped packages are printed with a marker.
 */
function requirementsInstall(file: string): string {
  // Braced so the fallback only covers this step, not earlier `&&` steps like venv creation.
  return [
    `{ uv pip install -r ${file}`,
    "||",
    `{ grep -vE '^[[:space:]]*(#|-|$)' ${file} | sed -E 's/[[:space:]]+#.*$//' | while read -r req; do`,
    `uv pip install "$req" || echo "${SKIPPED_PACKAGE_MARKER} $req"; done; }; }`,
  ].join(" ");
}

/** Packages reported as skipped by a Python install step. */
export function skippedPackages(output: string): string[] {
  return [...output.matchAll(new RegExp(`${SKIPPED_PACKAGE_MARKER} (.+)`, "g"))].map((m) =>
    (m[1] ?? "").trim(),
  );
}

function detectPython(files: RepoFiles, notes: string[]): Omit<RepoPlan, "envFile"> {
  const env = { VIRTUAL_ENV: PY_VENV, PATH: `${PY_VENV}/bin:/usr/local/bin:/usr/bin:/bin` };
  // Honour .python-version / requires-python when the image has that interpreter, else fall back
  // to the system Python. `-m venv` is offline and includes pip, so the agent's own `pip install`
  // lands in the same environment the tests use.
  const steps = [
    `PY=$(uv python find 2>/dev/null || command -v python3) && "$PY" -m venv ${PY_VENV}`,
  ];
  const pyproject = readPyproject(files);
  // uv only warns about unknown extras/groups, so install exactly the ones the project declares.
  const extras = PY_TEST_GROUPS.filter(
    (name) => name in (pyproject.project?.["optional-dependencies"] ?? {}),
  );
  const groups = PY_TEST_GROUPS.filter((name) => name in (pyproject["dependency-groups"] ?? {}));

  if (files.exists("uv.lock")) {
    notes.push("python project using uv.lock");
    steps.push("uv sync --frozen --all-extras --all-groups --active");
  } else {
    for (const req of ["requirements.txt", "requirements-dev.txt", "requirements-test.txt"]) {
      if (files.exists(req)) steps.push(requirementsInstall(req));
    }
    if (files.exists("pyproject.toml") || files.exists("setup.py")) {
      const target = extras.length ? `".[${extras.join(",")}]"` : ".";
      steps.push(
        [`uv pip install -e ${target}`, ...groups.map((group) => `--group ${group}`)].join(" "),
      );
    }
    notes.push(
      `python project installed into a venv with uv${extras.length ? ` (extras: ${extras.join(", ")})` : ""}${groups.length ? ` (groups: ${groups.join(", ")})` : ""}`,
    );
  }

  const usesPytest =
    pyproject.tool?.pytest !== undefined ||
    /pytest/.test(files.read("pyproject.toml") ?? "") ||
    files.exists("pytest.ini") ||
    files.exists("conftest.py") ||
    /pytest/.test(files.read("requirements-dev.txt") ?? "") ||
    /pytest/.test(files.read("requirements-test.txt") ?? "") ||
    /pytest/.test(files.read("requirements.txt") ?? "") ||
    files.exists("tests");

  if (usesPytest) {
    // Parenthesised: a bare `||` would also swallow failures of the earlier install steps.
    steps.push('(python -c "import pytest" 2>/dev/null || uv pip install pytest)');
    return {
      stack: "python",
      install: steps.join(" && "),
      test: `python -m pytest --junitxml=${JUNIT} -o junit_family=xunit1`,
      testReport: JUNIT,
      reportFormat: "junit",
      env,
      notes,
    };
  }
  notes.push("no pytest configuration found; using unittest");
  return {
    stack: "python",
    install: steps.join(" && "),
    test: "python -m unittest discover -v",
    testReport: null,
    reportFormat: "none",
    env,
    notes,
  };
}

/** Derives install/test commands from repo files, with `.agent.yml` overriding any field. */
export function planRepo(files: RepoFiles, config: AgentConfig = {}): RepoPlan {
  const notes: string[] = [];
  const hasNode = files.exists("package.json");
  const hasPython = ["pyproject.toml", "setup.py", "requirements.txt", "uv.lock"].some((path) =>
    files.exists(path),
  );

  let stack: Stack | undefined = config.image;
  if (!stack) {
    if (hasNode) stack = "node";
    else if (hasPython) stack = "python";
  }
  if (!stack) {
    throw new DetectionError(
      "Could not detect a Node or Python project. Add an .agent.yml with image, install and test.",
    );
  }
  if (hasNode && hasPython && !config.image) {
    notes.push("both package.json and Python files found; using node (set image in .agent.yml)");
  }

  const detected = stack === "node" ? detectNode(files, notes) : detectPython(files, notes);
  const envFile = config.envFile ?? (files.exists(".env.example") ? ".env.example" : null);

  if (config.test && !config.testReport) {
    notes.push(".agent.yml test command without testReport; results parsed from output");
  }
  if (config.install || config.test) notes.push("commands overridden by .agent.yml");
  if (config.network?.extraHosts?.length) {
    notes.push("network.extraHosts is not applied yet; hosts must be added to the proxy allowlist");
  }

  return {
    ...detected,
    install: config.install ?? detected.install,
    test: config.test ?? detected.test,
    testReport: config.test ? (config.testReport ?? null) : detected.testReport,
    reportFormat: config.test
      ? config.testReport?.endsWith(".json")
        ? "jest-json"
        : config.testReport
          ? "junit"
          : "none"
      : detected.reportFormat,
    envFile,
    notes,
  };
}
