import { DockerSandboxProvider, type Sandbox } from "@dca/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentTool } from "./loop.ts";
import { readOnlyTools, resolveRepoPath, writeTools } from "./tools.ts";

const ENABLED = process.env.SANDBOX_TESTS === "1";
const signal = new AbortController().signal;

describe("resolveRepoPath", () => {
  const sandbox = { repoDir: "/workspace/repo" } as Sandbox;
  it("keeps paths inside the repository", () => {
    expect(resolveRepoPath(sandbox, "src/a.ts")).toBe("/workspace/repo/src/a.ts");
    expect(resolveRepoPath(sandbox, "/src/./b/../a.ts")).toBe("/workspace/repo/src/a.ts");
    expect(() => resolveRepoPath(sandbox, "../../etc/passwd")).toThrow(/escapes/);
  });
});

describe.skipIf(!ENABLED)("sandbox tools (integration)", { timeout: 60_000 }, () => {
  let sandbox: Sandbox;
  let tools: Map<string, AgentTool>;
  const run = (name: string, input: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`missing ${name}`);
    return tool.execute(input, signal);
  };

  beforeAll(async () => {
    sandbox = await new DockerSandboxProvider().create({
      jobId: "00000000-tools",
      image: "dca-sandbox-node:latest",
    });
    tools = new Map([...readOnlyTools(sandbox), ...writeTools(sandbox)].map((t) => [t.name, t]));
    await sandbox.exec(
      "git init -q . && mkdir -p src && printf 'line one\\nline two\\n' > src/a.ts",
    );
  }, 120_000);

  afterAll(async () => {
    await sandbox?.destroy();
  });

  it("reads with line numbers, lists and greps", async () => {
    expect((await run("read_file", { path: "src/a.ts" })).output).toBe(
      "     1  line one\n     2  line two\n",
    );
    expect((await run("read_file", { path: "missing.ts" })).isError).toBe(true);
    expect((await run("list_files", {})).output).toContain("src/a.ts");
    expect((await run("grep", { pattern: "two" })).output).toBe("src/a.ts:2:line two\n");
  });

  it("edits only unique matches and writes files", async () => {
    expect(
      (await run("edit_file", { path: "src/a.ts", old_string: "line", new_string: "x" })).output,
    ).toContain("found 2 occurrences");
    await run("edit_file", { path: "src/a.ts", old_string: "line two", new_string: "line $& 2" });
    expect((await sandbox.readFile(`${sandbox.repoDir}/src/a.ts`))?.toString()).toBe(
      "line one\nline $& 2\n",
    );
    await run("write_file", { path: "new/dir/b.txt", content: "hello" });
    expect((await run("bash", { command: "cat new/dir/b.txt && exit 3" })).output).toBe(
      "hello\n[exit 3]",
    );
  });
});
