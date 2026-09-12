export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
}

// GitHub: owner 1-39 chars alphanumeric/hyphen (no leading hyphen); repo name letters, digits, . _ -
const REPO_RE = /^([a-z\d](?:[a-z\d-]{0,38}))\/([\w.-]{1,100})$/i;

/** Parses an exact `owner/repo`. Returns null for anything else (URLs, bare names, extra segments). */
export function parseRepo(input: string): RepoRef | null {
  const match = REPO_RE.exec(input.trim());
  if (!match) return null;
  const [, owner = "", name = ""] = match;
  if (name === "." || name === "..") return null;
  return { owner, name, fullName: `${owner}/${name}` };
}
