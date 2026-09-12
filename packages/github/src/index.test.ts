import { parseRepo } from "@dca/core";
import { describe, expect, it } from "vitest";
import { createGitHubClient, GitHubApiError } from "./index.ts";

const repo = parseRepo("octo/app");
if (!repo) throw new Error("fixture");

function fakeFetch(status: number, body?: unknown): typeof fetch {
  return (async () =>
    new Response(body === undefined ? null : JSON.stringify(body), { status })) as typeof fetch;
}

describe("checkRepoAccess", () => {
  it("returns ok when the token can push", async () => {
    const client = createGitHubClient("t", {
      fetch: fakeFetch(200, {
        default_branch: "main",
        private: true,
        archived: false,
        permissions: { push: true },
      }),
    });
    expect(await client.checkRepoAccess(repo)).toEqual({
      ok: true,
      defaultBranch: "main",
      private: true,
    });
  });

  it("maps 404, read-only, and archived repos", async () => {
    expect(await createGitHubClient("t", { fetch: fakeFetch(404) }).checkRepoAccess(repo)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      await createGitHubClient("t", {
        fetch: fakeFetch(200, { default_branch: "main", private: false, archived: false }),
      }).checkRepoAccess(repo),
    ).toEqual({ ok: false, reason: "no_push_permission" });
    expect(
      await createGitHubClient("t", {
        fetch: fakeFetch(200, {
          default_branch: "main",
          private: false,
          archived: true,
          permissions: { push: true },
        }),
      }).checkRepoAccess(repo),
    ).toEqual({ ok: false, reason: "archived" });
  });

  it("throws on other errors", async () => {
    await expect(
      createGitHubClient("t", { fetch: fakeFetch(500) }).checkRepoAccess(repo),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});
