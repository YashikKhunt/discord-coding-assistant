export * from "./checkout.ts";

import type { RepoRef } from "@dca/core";

export type RepoAccess =
  | { ok: true; defaultBranch: string; private: boolean }
  | { ok: false; reason: "not_found" | "no_push_permission" | "archived" };

export interface GitHubClient {
  checkRepoAccess(repo: RepoRef): Promise<RepoAccess>;
}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

interface RepoResponse {
  default_branch: string;
  private: boolean;
  archived: boolean;
  permissions?: { push?: boolean };
}

export function createGitHubClient(
  token: string,
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): GitHubClient {
  const baseUrl = options.baseUrl ?? "https://api.github.com";
  const doFetch = options.fetch ?? fetch;

  async function request<T>(path: string): Promise<{ status: number; body: T | null }> {
    const res = await doFetch(`${baseUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "discord-coding-assistant",
      },
    });
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) {
      throw new GitHubApiError(res.status, `GitHub ${path} failed with ${res.status}`);
    }
    return { status: res.status, body: (await res.json()) as T };
  }

  return {
    async checkRepoAccess(repo) {
      const { body } = await request<RepoResponse>(
        `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
      );
      if (!body) return { ok: false, reason: "not_found" };
      if (body.archived) return { ok: false, reason: "archived" };
      if (!body.permissions?.push) return { ok: false, reason: "no_push_permission" };
      return { ok: true, defaultBranch: body.default_branch, private: body.private };
    },
  };
}
