import { type Sandbox, shellQuote } from "@dca/sandbox";
import { z } from "zod";
import type { AgentTool, ToolOutput } from "./loop.ts";

/**
 * Tools that act on the repository inside the sandbox. The sandbox is the security boundary;
 * path checks here only keep the model working inside the checkout.
 */

const relativePath = z.string().min(1).max(500).describe("Path relative to the repository root");

function resolveRepoPath(sandbox: Sandbox, path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`Path escapes the repository: ${path}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? `${sandbox.repoDir}/${parts.join("/")}` : sandbox.repoDir;
}

function defineTool<Schema extends z.ZodType>(definition: {
  name: string;
  description: string;
  inputSchema: Schema;
  execute: (input: z.infer<Schema>, signal: AbortSignal) => Promise<ToolOutput>;
}): AgentTool {
  return definition as AgentTool;
}

export interface SandboxToolOptions {
  env?: Record<string, string>;
  /** Default and maximum per-command timeout for `bash`. */
  commandTimeoutMs?: number;
}

export function readOnlyTools(sandbox: Sandbox, options: SandboxToolOptions = {}): AgentTool[] {
  const maxTimeout = options.commandTimeoutMs ?? 120_000;
  return [
    defineTool({
      name: "read_file",
      description:
        "Read a text file from the repository. Returns numbered lines. Use start_line/end_line for large files.",
      inputSchema: z.object({
        path: relativePath,
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      }),
      async execute({ path, start_line, end_line }) {
        const full = resolveRepoPath(sandbox, path);
        const start = start_line ?? 1;
        const end = end_line ?? start + 399;
        const result = await sandbox.exec(
          `test -f ${shellQuote(full)} || { echo "not a file: ${path.replaceAll('"', "")}" >&2; exit 2; }; awk -v s=${start} -v e=${end} 'NR>=s && NR<=e { printf "%6d  %s\\n", NR, $0 } NR>e { exit }' ${shellQuote(full)}`,
          { timeoutMs: 15_000 },
        );
        if (result.exitCode !== 0)
          return { output: result.output, exitCode: result.exitCode, isError: true };
        return { output: result.stdout || "(empty range)", exitCode: 0 };
      },
    }),
    defineTool({
      name: "list_files",
      description:
        "List repository files (respects .gitignore via ripgrep). Optionally filter with a glob like 'src/**/*.ts'.",
      inputSchema: z.object({ glob: z.string().max(200).optional() }),
      async execute({ glob }) {
        const filter = glob ? `--glob ${shellQuote(glob)}` : "";
        const result = await sandbox.exec(
          `rg --files --hidden --glob '!.git' ${filter} </dev/null | sort | head -500`,
          {
            timeoutMs: 20_000,
          },
        );
        return { output: result.stdout || "(no files)", exitCode: result.exitCode };
      },
    }),
    defineTool({
      name: "grep",
      description: "Search file contents with ripgrep. Returns matching lines with file:line.",
      inputSchema: z.object({
        pattern: z.string().min(1).max(500).describe("Rust regex"),
        glob: z.string().max(200).optional(),
      }),
      async execute({ pattern, glob }) {
        const filter = glob ? `--glob ${shellQuote(glob)}` : "";
        const result = await sandbox.exec(
          // </dev/null: with piped stdin (docker exec -i) rg would search stdin instead of the repo.
          `rg --line-number --no-heading --hidden --glob '!.git' --max-count 50 ${filter} -e ${shellQuote(pattern)} </dev/null | head -300`,
          { timeoutMs: 20_000 },
        );
        return { output: result.stdout || "(no matches)", exitCode: result.exitCode };
      },
    }),
    defineTool({
      name: "bash",
      description:
        "Run a shell command in the repository root inside the sandbox (no internet except package registries, no credentials). Use it to run tests, inspect git history, or try things.",
      inputSchema: z.object({
        command: z.string().min(1).max(4_000),
        timeout_seconds: z.number().int().min(1).max(600).optional(),
      }),
      async execute({ command, timeout_seconds }, signal) {
        if (signal.aborted) throw new Error("aborted");
        const timeoutMs = Math.min((timeout_seconds ?? 60) * 1000, maxTimeout);
        const result = await sandbox.exec(command, { env: options.env, timeoutMs });
        const suffix = result.timedOut ? `\n[timed out after ${timeoutMs / 1000}s]` : "";
        return {
          output: `${result.output}${suffix}\n[exit ${result.exitCode}]`,
          exitCode: result.exitCode,
          isError: result.exitCode !== 0,
        };
      },
    }),
  ];
}

export function writeTools(sandbox: Sandbox): AgentTool[] {
  return [
    defineTool({
      name: "write_file",
      description: "Create or overwrite a file with the given content.",
      inputSchema: z.object({ path: relativePath, content: z.string().max(500_000) }),
      async execute({ path, content }) {
        await sandbox.writeFile(resolveRepoPath(sandbox, path), content);
        return { output: `wrote ${path} (${content.length} chars)` };
      },
    }),
    defineTool({
      name: "edit_file",
      description:
        "Replace an exact, unique string in a file. Include enough surrounding context to make old_string unique.",
      inputSchema: z.object({
        path: relativePath,
        old_string: z.string().min(1),
        new_string: z.string(),
      }),
      async execute({ path, old_string, new_string }) {
        const full = resolveRepoPath(sandbox, path);
        const current = await sandbox.readFile(full);
        if (current === null) return { output: `File not found: ${path}`, isError: true };
        const text = current.toString("utf8");
        const count = text.split(old_string).length - 1;
        if (count !== 1) {
          return {
            output: `old_string must appear exactly once in ${path}; found ${count} occurrences`,
            isError: true,
          };
        }
        await sandbox.writeFile(
          full,
          text.replace(old_string, () => new_string),
        );
        return { output: `edited ${path}` };
      },
    }),
  ];
}

export { resolveRepoPath };
