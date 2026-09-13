import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRepo } from "@dca/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseIssueRef } from "./index.ts";
import { checkPatch, parsePatch } from "./patch.ts";
import { branchSlug, PushError, pushPatch } from "./push.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });

const repo = parseRepo("octo/app");
if (!repo) throw new Error("fixture");

describe("patch guardrails (real git diffs)", () => {
  let root: string;
  let work: string;
  let base: string;

  /** Applies `change` to a fresh copy of the base commit and returns `git diff --binary`. */
  const diffOf = async (change: (dir: string) => Promise<void>) => {
    git(work, "reset", "-q", "--hard", base);
    git(work, "clean", "-qfdx");
    await change(work);
    git(work, "add", "-A");
    return git(work, "diff", "--cached", "--binary", base);
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dca-patch-"));
    work = path.join(root, "work");
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    await writeFile(path.join(work, "app.js"), "export const add = (a, b) => a - b;\n");
    await writeFile(path.join(work, "old-name.md"), "# docs\n".repeat(20));
    git(work, "add", ".");
    git(work, "commit", "-qm", "base");
    base = git(work, "rev-parse", "HEAD").trim();
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts an ordinary fix and counts lines, renames and binaries", async () => {
    const patch = await diffOf(async (dir) => {
      await writeFile(
        path.join(dir, "app.js"),
        "export const add = (a, b) => a + b;\n-- not a header\n",
      );
      git(dir, "mv", "old-name.md", "docs.md");
      await writeFile(path.join(dir, "logo.png"), Buffer.from([0, 1, 2, 3, 255]));
    });
    const { stats, violations } = checkPatch(patch);
    expect(violations).toEqual([]);
    expect(stats.files.map((f) => f.path).sort()).toEqual(["app.js", "docs.md", "logo.png"]);
    expect(stats.files.find((f) => f.path === "docs.md")?.oldPath).toBe("old-name.md");
    expect(stats.files.find((f) => f.path === "logo.png")?.binary).toBe(true);
    expect(stats.files.find((f) => f.path === "app.js")).toMatchObject({ added: 2, deleted: 1 });
  });

  it("rejects workflows, env files, agent config, symlinks and secrets", async () => {
    const patch = await diffOf(async (dir) => {
      execFileSync("mkdir", ["-p", path.join(dir, ".github/workflows")]);
      await writeFile(path.join(dir, ".github/workflows/ci.yml"), "on: push\n");
      await writeFile(path.join(dir, ".env"), "X=1\n");
      await writeFile(path.join(dir, ".env.example"), "X=\n");
      await writeFile(path.join(dir, ".agent.yml"), "image: node\n");
      await symlink("/etc/passwd", path.join(dir, "link"));
      await writeFile(
        path.join(dir, "config.js"),
        `export const token = "ghp_${"a".repeat(36)}";\nexport const key = "AKIA${"B".repeat(16)}";\n`,
      );
    });
    const { violations } = checkPatch(patch);
    expect(violations).toEqual(
      expect.arrayContaining([
        ".github/workflows/ci.yml: modifies CI workflows",
        ".env: adds or modifies an environment file",
        ".agent.yml: modifies the agent configuration",
        "link: creates a symbolic link",
        "config.js: added line looks like a GitHub token",
        "config.js: added line looks like a AWS access key",
      ]),
    );
    expect(violations.join("\n")).not.toContain(".env.example");
  });

  it("enforces size limits", async () => {
    const patch = await diffOf(async (dir) => {
      await writeFile(path.join(dir, "big.txt"), "line\n".repeat(50));
    });
    expect(checkPatch(patch, { maxFiles: 100, maxChangedLines: 10 }).violations).toEqual([
      "changes 50 lines (limit 10)",
    ]);
    expect(parsePatch("").files).toEqual([]);
  });
});

describe("pushPatch (local bare remote)", () => {
  let root: string;
  let remote: string;
  let base: string;
  let patch: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dca-push-"));
    remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    await writeFile(path.join(seed, "app.js"), "export const add = (a, b) => a - b;\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "base");
    git(seed, "push", "-q", remote, "main");
    base = git(seed, "rev-parse", "HEAD").trim();

    await writeFile(path.join(seed, "app.js"), "export const add = (a, b) => a + b;\n");
    // A hook in the working copy that produced the patch must never run on the host.
    await writeFile(path.join(seed, ".git/hooks/pre-commit"), "#!/bin/sh\ntouch /tmp/dca-pwned\n", {
      mode: 0o755,
    });
    patch = git(seed, "diff", "--binary", base);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applies the patch to a fresh clone and pushes a branch as the bot", async () => {
    const result = await pushPatch({
      repo,
      baseCommit: base,
      patch,
      branch: "agent/task-0042-fix-add",
      message: "Fix add\n\nJob: TASK-0042",
      author: { name: "DoomsCode-Y", email: "1+DoomsCode-Y@users.noreply.github.com" },
      token: "unused-for-local",
      dir: path.join(root, "clone-1"),
      remoteUrl: remote,
    });

    const verify = path.join(root, "verify");
    execFileSync("git", ["clone", "-q", "-b", "agent/task-0042-fix-add", remote, verify]);
    expect(await readFile(path.join(verify, "app.js"), "utf8")).toBe(
      "export const add = (a, b) => a + b;\n",
    );
    expect(git(verify, "log", "-1", "--format=%H|%an|%ae|%s").trim()).toBe(
      `${result.commit}|DoomsCode-Y|1+DoomsCode-Y@users.noreply.github.com|Fix add`,
    );
  });

  it("fails cleanly when the patch does not apply or the branch name is unsafe", async () => {
    await expect(
      pushPatch({
        repo,
        baseCommit: base,
        patch: patch.replace("a - b", "a * b"),
        branch: "agent/bad",
        message: "x",
        author: { name: "bot", email: "bot@example.com" },
        token: "t",
        dir: path.join(root, "clone-2"),
        remoteUrl: remote,
      }),
    ).rejects.toThrow(/git apply failed/);

    await expect(
      pushPatch({
        repo,
        baseCommit: base,
        patch,
        branch: "--force",
        message: "x",
        author: { name: "bot", email: "bot@example.com" },
        token: "t",
        dir: path.join(root, "clone-3"),
        remoteUrl: remote,
      }),
    ).rejects.toBeInstanceOf(PushError);
  });
});

describe("helpers", () => {
  it("slugs branch names", () => {
    expect(branchSlug("Add token-bucket rate limiting to /api routes!")).toBe(
      "add-token-bucket-rate-limiting-to-api-ro",
    );
    expect(branchSlug("🔥🔥")).toBe("change");
  });

  it("parses issue references for the same repo only", () => {
    expect(parseIssueRef("#12", repo)).toBe(12);
    expect(parseIssueRef("https://github.com/Octo/App/issues/7#x", repo)).toBe(7);
    expect(parseIssueRef("https://github.com/other/app/issues/7", repo)).toBeNull();
    expect(parseIssueRef("see issue", repo)).toBeNull();
  });
});
