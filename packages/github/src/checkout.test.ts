import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRepo } from "@dca/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CheckoutError, checkoutRepo, resolveRef } from "./checkout.ts";

describe("resolveRef", () => {
  it("recognises pull requests", () => {
    for (const ref of ["#12", "12", "pull/12"]) {
      expect(resolveRef(ref, "main")).toEqual({
        kind: "pr",
        number: 12,
        refspec: "refs/pull/12/head",
      });
    }
  });

  it("defaults to the default branch and rejects unsafe refs", () => {
    expect(resolveRef(undefined, "main")).toEqual({ kind: "ref", refspec: "main" });
    expect(resolveRef("feature/auth", "main")).toEqual({ kind: "ref", refspec: "feature/auth" });
    expect(() => resolveRef("--upload-pack=evil", "main")).toThrow(CheckoutError);
    expect(() => resolveRef("a b", "main")).toThrow(CheckoutError);
    expect(() => resolveRef("main..dev", "main")).toThrow(CheckoutError);
  });
});

describe("checkoutRepo (local git)", () => {
  let root: string;
  let origin: string;
  let commit: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dca-checkout-"));
    origin = path.join(root, "origin");
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    await writeFile(path.join(origin, "README.md"), "hello\n");
    git(origin, "add", ".");
    git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    git(origin, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(origin, "README.md"), "feature\n");
    git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "feature");
    commit = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "-q", "main");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const repo = parseRepo("octo/app");
  if (!repo) throw new Error("fixture");

  it("checks out a branch without persisting credentials", async () => {
    const dir = path.join(root, "work-feature");
    const result = await checkoutRepo({
      repo,
      ref: resolveRef("feature", "main"),
      dir,
      token: "ghp_supersecret",
      remoteUrl: origin,
    });
    expect(result.commit).toBe(commit);
    expect(await readFile(path.join(dir, "README.md"), "utf8")).toBe("feature\n");
    expect(await readFile(path.join(dir, ".git", "config"), "utf8")).not.toMatch(
      /supersecret|extraheader/i,
    );
  });

  it("explains missing refs without leaking the token", async () => {
    const error = await checkoutRepo({
      repo,
      ref: resolveRef("nope", "main"),
      dir: path.join(root, "work-missing"),
      token: "ghp_supersecret",
      remoteUrl: origin,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CheckoutError);
    expect((error as Error).message).toMatch(/Ref `nope` not found/);
    expect((error as Error).message).not.toContain("supersecret");
  });
});
