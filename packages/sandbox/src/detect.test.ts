import { describe, expect, it } from "vitest";
import { AgentConfigError, parseAgentConfig } from "./agent-config.ts";
import { DetectionError, planRepo, type RepoFiles, skippedPackages } from "./detect.ts";

function repo(files: Record<string, string>): RepoFiles {
  return {
    exists: (path) => path in files || Object.keys(files).some((f) => f.startsWith(`${path}/`)),
    read: (path) => files[path] ?? null,
  };
}

const pkg = (value: object) => JSON.stringify(value);

describe("planRepo: node", () => {
  it("uses pnpm with a vitest junit reporter", () => {
    const plan = planRepo(
      repo({
        "package.json": pkg({ scripts: { test: "vitest run" }, devDependencies: { vitest: "5" } }),
        "pnpm-lock.yaml": "",
        ".env.example": "PORT=3000",
      }),
    );
    expect(plan).toMatchObject({
      stack: "node",
      install: "corepack pnpm install --frozen-lockfile",
      test: "corepack pnpm exec vitest run --reporter=default --reporter=junit --outputFile.junit=.agent-report/junit.xml",
      testReport: ".agent-report/junit.xml",
      reportFormat: "junit",
      envFile: ".env.example",
    });
  });

  it("uses npm ci and jest json output", () => {
    const plan = planRepo(
      repo({ "package.json": pkg({ scripts: { test: "jest" } }), "package-lock.json": "{}" }),
    );
    expect(plan.install).toBe("npm ci --no-audit --no-fund");
    expect(plan.test).toBe("npm exec -- jest --ci --json --outputFile=.agent-report/jest.json");
    expect(plan.reportFormat).toBe("jest-json");
  });

  it("supports node --test and yarn", () => {
    const plan = planRepo(
      repo({ "package.json": pkg({ scripts: { test: "node --test" } }), "yarn.lock": "" }),
    );
    expect(plan.install).toBe("corepack yarn install --immutable");
    expect(plan.test).toMatch(/^node --test --test-reporter=spec/);
  });

  it("keeps the script's own flags and falls back for complex scripts", () => {
    expect(
      planRepo(
        repo({
          "package.json": pkg({ scripts: { test: "vitest run --config vitest.ci.ts" } }),
          "yarn.lock": "",
        }),
      ).test,
    ).toBe(
      "corepack yarn run vitest run --config vitest.ci.ts --reporter=default --reporter=junit --outputFile.junit=.agent-report/junit.xml",
    );

    for (const script of ["npm run build && vitest run", "NODE_ENV=test jest", "jest $(ls)"]) {
      const plan = planRepo(repo({ "package.json": pkg({ scripts: { test: script } }) }));
      expect(plan, script).toMatchObject({ test: "npm test", reportFormat: "none" });
    }
  });

  it("reports missing or placeholder test scripts", () => {
    const plan = planRepo(
      repo({
        "package.json": pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      }),
    );
    expect(plan.test).toBeNull();
    expect(plan.notes).toContain("no test script in package.json");
  });

  it("refuses bun projects", () => {
    expect(() => planRepo(repo({ "package.json": "{}", "bun.lockb": "" }))).toThrow(DetectionError);
  });
});

describe("planRepo: python", () => {
  it("uses uv sync with uv.lock and pytest junit", () => {
    const plan = planRepo(repo({ "pyproject.toml": "[tool.pytest.ini_options]", "uv.lock": "" }));
    expect(plan.stack).toBe("python");
    expect(plan.install).toContain("uv sync --frozen");
    expect(plan.test).toBe(
      "python -m pytest --junitxml=.agent-report/junit.xml -o junit_family=xunit1",
    );
    expect(plan.env.VIRTUAL_ENV).toBe("/workspace/venv");
  });

  it("installs only declared test extras and dependency groups", () => {
    const plan = planRepo(
      repo({
        "pyproject.toml": [
          "[project]",
          'name = "humanize"',
          "[project.optional-dependencies]",
          'tests = ["freezegun", "pytest"]',
          'docs = ["mkdocs"]',
          "[dependency-groups]",
          'dev = ["ruff"]',
        ].join("\n"),
        tests: "",
      }),
    );
    expect(plan.install).toBe(
      'PY=$(uv python find 2>/dev/null || command -v python3) && "$PY" -m venv /workspace/venv && uv pip install -e ".[tests]" --group dev && (python -c "import pytest" 2>/dev/null || uv pip install pytest)',
    );
    expect(plan.test).toContain("pytest");
  });

  it("rejects invalid pyproject files", () => {
    expect(() => planRepo(repo({ "pyproject.toml": "[project" }))).toThrow(/not valid TOML/);
  });

  it("installs requirements and falls back to unittest", () => {
    const plan = planRepo(repo({ "requirements.txt": "requests\n", "app/test_x.py": "" }));
    expect(plan.install).toBe(
      'PY=$(uv python find 2>/dev/null || command -v python3) && "$PY" -m venv /workspace/venv && { uv pip install -r requirements.txt || { grep -vE \'^[[:space:]]*(#|-|$)\' requirements.txt | sed -E \'s/[[:space:]]+#.*$//\' | while read -r req; do uv pip install "$req" || echo "dca-skipped-package: $req"; done; }; }',
    );
    expect(plan.test).toBe("python -m unittest discover -v");
    expect(plan.reportFormat).toBe("none");
  });
});

describe("skippedPackages", () => {
  it("extracts packages the resilient install skipped", () => {
    expect(
      skippedPackages(
        "ok\ndca-skipped-package: pytrec_eval-terrier==0.5.10\nmore\ndca-skipped-package: lxml==6.1.1\n",
      ),
    ).toEqual(["pytrec_eval-terrier==0.5.10", "lxml==6.1.1"]);
  });
});

describe("planRepo: .agent.yml", () => {
  it("overrides detection field by field", () => {
    const config = parseAgentConfig(`
image: python
install: make deps
test: make test
testReport: build/junit.xml
`);
    const plan = planRepo(repo({ "package.json": "{}", "requirements.txt": "" }), config);
    expect(plan).toMatchObject({
      stack: "python",
      install: "make deps",
      test: "make test",
      testReport: "build/junit.xml",
      reportFormat: "junit",
    });
  });

  it("fails clearly when nothing is detectable", () => {
    expect(() => planRepo(repo({ "README.md": "hi" }))).toThrow(/Could not detect/);
  });

  it("validates the config", () => {
    expect(() => parseAgentConfig("image: ruby")).toThrow(AgentConfigError);
    expect(() => parseAgentConfig("testReport: ../../etc/passwd")).toThrow(/inside the repo/);
    expect(() => parseAgentConfig("unknown: 1")).toThrow(AgentConfigError);
    expect(() => parseAgentConfig("image: [")).toThrow(/not valid YAML/);
    expect(parseAgentConfig("")).toEqual({});
  });
});
