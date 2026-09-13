/**
 * Inspection of agent-produced patches before anything leaves the sandbox. The patch is the
 * only artifact that crosses from untrusted code to the host, so it is checked here and then
 * applied to a fresh clone.
 */

export interface PatchFile {
  path: string;
  oldPath: string | null;
  added: number;
  deleted: number;
  binary: boolean;
  newMode: string | null;
}

export interface PatchStats {
  files: PatchFile[];
  insertions: number;
  deletions: number;
}

export interface PatchLimits {
  maxFiles: number;
  maxChangedLines: number;
}

export const DEFAULT_PATCH_LIMITS: PatchLimits = { maxFiles: 100, maxChangedLines: 5_000 };

function unquote(path: string): string {
  // git quotes paths with unusual characters: "a/some\"path"
  if (path.startsWith('"') && path.endsWith('"')) {
    return JSON.parse(
      path.replace(
        /\\([0-7]{3})/g,
        (_, oct) => `\\u00${Number.parseInt(oct, 8).toString(16).padStart(2, "0")}`,
      ),
    );
  }
  return path;
}

function stripPrefix(path: string): string {
  const clean = unquote(path);
  return clean.replace(/^[ab]\//, "");
}

export function parsePatch(patch: string): PatchStats {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(line);
    if (header) {
      current = {
        path: stripPrefix(header[2] ?? ""),
        oldPath: stripPrefix(header[1] ?? ""),
        added: 0,
        deleted: 0,
        binary: false,
        newMode: null,
      };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (inHunk) {
      // Inside a hunk every +/- line is content, even one whose text starts with "++" or "--".
      if (line.startsWith("+")) current.added++;
      else if (line.startsWith("-")) current.deleted++;
      continue;
    }
    if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
      current.path = stripPrefix(line.slice(4));
    } else if (line.startsWith("--- ") && line !== "--- /dev/null") {
      current.oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith("rename to ")) {
      current.path = unquote(line.slice(10));
    } else if (line.startsWith("rename from ")) {
      current.oldPath = unquote(line.slice(12));
    } else if (/^(new file mode|new mode) /.test(line)) {
      current.newMode = line.split(" ").at(-1) ?? null;
    } else if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
      current.binary = true;
    }
  }
  for (const file of files) {
    if (file.oldPath === file.path) file.oldPath = null;
  }
  return {
    files,
    insertions: files.reduce((sum, file) => sum + file.added, 0),
    deletions: files.reduce((sum, file) => sum + file.deleted, 0),
  };
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Discord bot token", /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/],
];

function forbiddenPathReason(path: string): string | null {
  const segments = path.split("/");
  if (segments.includes("..") || path.startsWith("/")) return "path escapes the repository";
  if (segments[0] === ".git" || segments.includes(".git")) return "modifies git internals";
  if (path.startsWith(".github/workflows/")) return "modifies CI workflows";
  if (path === ".agent.yml") return "modifies the agent configuration";
  const base = segments.at(-1) ?? "";
  if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) {
    return "adds or modifies an environment file";
  }
  return null;
}

/** Returns human-readable reasons the patch must not be pushed; empty when it is acceptable. */
export function checkPatch(
  patch: string,
  limits: PatchLimits = DEFAULT_PATCH_LIMITS,
): { stats: PatchStats; violations: string[] } {
  const stats = parsePatch(patch);
  const violations: string[] = [];

  for (const file of stats.files) {
    for (const path of [file.path, file.oldPath].filter((p): p is string => Boolean(p))) {
      const reason = forbiddenPathReason(path);
      if (reason) violations.push(`${path}: ${reason}`);
    }
    if (file.newMode === "120000") violations.push(`${file.path}: creates a symbolic link`);
    if (file.newMode === "160000") violations.push(`${file.path}: adds a submodule`);
  }

  if (stats.files.length > limits.maxFiles) {
    violations.push(`changes ${stats.files.length} files (limit ${limits.maxFiles})`);
  }
  const changed = stats.insertions + stats.deletions;
  if (changed > limits.maxChangedLines) {
    violations.push(`changes ${changed} lines (limit ${limits.maxChangedLines})`);
  }

  let file = "";
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = /^diff --git \S+ (?:b\/)?(.+)$/.exec(line);
    if (header) {
      file = header[1] ?? "";
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) inHunk = true;
    if (!inHunk || !line.startsWith("+")) continue;
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(line)) violations.push(`${file}: added line looks like a ${label}`);
    }
  }
  return { stats, violations: [...new Set(violations)] };
}
