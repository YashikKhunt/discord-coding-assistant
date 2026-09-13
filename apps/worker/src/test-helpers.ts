import type { GitHubClient } from "@dca/github";

/** GitHub client for tests: every call fails unless overridden. */
export function fakeGitHub(overrides: Partial<GitHubClient> = {}): GitHubClient {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected GitHub call: ${name}`);
  };
  return {
    checkRepoAccess: async () => ({ ok: true, defaultBranch: "main", private: false }),
    getAuthenticatedUser: unexpected("getAuthenticatedUser"),
    getIssue: unexpected("getIssue"),
    createPullRequest: unexpected("createPullRequest"),
    createCommitStatus: unexpected("createCommitStatus"),
    upsertIssueComment: unexpected("upsertIssueComment"),
    ...overrides,
  };
}
