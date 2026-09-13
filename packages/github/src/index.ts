export * from "./checkout.ts";
export * from "./patch.ts";
export * from "./push.ts";

import type { RepoRef } from "@dca/core";

export type RepoAccess =
  | { ok: true; defaultBranch: string; private: boolean }
  | { ok: false; reason: "not_found" | "no_push_permission" | "archived" };

export interface PullRequestRef {
  number: number;
  url: string;
}

export interface IssueDetails {
  number: number;
  title: string;
  body: string;
  url: string;
  isPullRequest: boolean;
}

export type CommitState = "pending" | "success" | "failure" | "error";

export interface GitHubClient {
  checkRepoAccess(repo: RepoRef): Promise<RepoAccess>;
  getAuthenticatedUser(): Promise<{ login: string; id: number }>;
  getIssue(repo: RepoRef, number: number): Promise<IssueDetails | null>;
  createPullRequest(
    repo: RepoRef,
    pr: { head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<PullRequestRef>;
  createCommitStatus(
    repo: RepoRef,
    sha: string,
    status: { state: CommitState; context: string; description: string; targetUrl?: string },
  ): Promise<void>;
  /** Creates a comment, or updates the existing one that contains `marker`. */
  upsertIssueComment(repo: RepoRef, number: number, marker: string, body: string): Promise<void>;
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

const repoPath = (repo: RepoRef) =>
  `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

export function createGitHubClient(
  token: string,
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): GitHubClient {
  const baseUrl = options.baseUrl ?? "https://api.github.com";
  const doFetch = options.fetch ?? fetch;

  async function request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: T | null }> {
    const method = init.method ?? "GET";
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "discord-coding-assistant",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 404 && method === "GET") return { status: 404, body: null };
    if (!res.ok) {
      let detail = "";
      try {
        const error = (await res.json()) as { message?: string; errors?: { message?: string }[] };
        detail = [error.message, ...(error.errors ?? []).map((e) => e.message)]
          .filter(Boolean)
          .join("; ");
      } catch {
        // Non-JSON error body.
      }
      throw new GitHubApiError(
        res.status,
        `GitHub ${method} ${path} failed with ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as T) : null };
  }

  return {
    async checkRepoAccess(repo) {
      const { body } = await request<RepoResponse>(repoPath(repo));
      if (!body) return { ok: false, reason: "not_found" };
      if (body.archived) return { ok: false, reason: "archived" };
      if (!body.permissions?.push) return { ok: false, reason: "no_push_permission" };
      return { ok: true, defaultBranch: body.default_branch, private: body.private };
    },

    async getAuthenticatedUser() {
      const { body } = await request<{ login: string; id: number }>("/user");
      if (!body) throw new GitHubApiError(404, "Authenticated user not found");
      return { login: body.login, id: body.id };
    },

    async getIssue(repo, number) {
      const { body } = await request<{
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        pull_request?: unknown;
      }>(`${repoPath(repo)}/issues/${number}`);
      if (!body) return null;
      return {
        number: body.number,
        title: body.title,
        body: body.body ?? "",
        url: body.html_url,
        isPullRequest: body.pull_request !== undefined,
      };
    },

    async createPullRequest(repo, pr) {
      const { body } = await request<{ number: number; html_url: string }>(
        `${repoPath(repo)}/pulls`,
        { method: "POST", body: pr },
      );
      if (!body) throw new GitHubApiError(500, "GitHub returned no pull request");
      return { number: body.number, url: body.html_url };
    },

    async createCommitStatus(repo, sha, status) {
      await request(`${repoPath(repo)}/statuses/${encodeURIComponent(sha)}`, {
        method: "POST",
        body: {
          state: status.state,
          context: status.context,
          description: status.description.slice(0, 140),
          target_url: status.targetUrl,
        },
      });
    },

    async upsertIssueComment(repo, number, marker, body) {
      const { body: comments } = await request<{ id: number; body: string }[]>(
        `${repoPath(repo)}/issues/${number}/comments?per_page=100`,
      );
      const existing = comments?.find((comment) => comment.body.includes(marker));
      const content = `${marker}\n${body}`;
      if (existing) {
        await request(`${repoPath(repo)}/issues/comments/${existing.id}`, {
          method: "PATCH",
          body: { body: content },
        });
      } else {
        await request(`${repoPath(repo)}/issues/${number}/comments`, {
          method: "POST",
          body: { body: content },
        });
      }
    },
  };
}

/** Accepts `#12`, `12`, or an issue/PR URL in the same repository. */
export function parseIssueRef(input: string, repo: RepoRef): number | null {
  const value = input.trim();
  const short = /^#?(\d+)$/.exec(value);
  if (short) return Number(short[1]);
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i.exec(
    value,
  );
  if (!url) return null;
  const [, owner = "", name = "", number = ""] = url;
  return owner.toLowerCase() === repo.owner.toLowerCase() &&
    name.toLowerCase() === repo.name.toLowerCase()
    ? Number(number)
    : null;
}
