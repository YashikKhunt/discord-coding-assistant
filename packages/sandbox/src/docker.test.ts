import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandboxProvider } from "./docker.ts";
import type { Sandbox } from "./types.ts";

const ENABLED = process.env.SANDBOX_TESTS === "1";
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "node:22-bookworm-slim";

describe.skipIf(!ENABLED)("DockerSandboxProvider (integration)", { timeout: 60_000 }, () => {
  const provider = new DockerSandboxProvider();
  let sandbox: Sandbox;
  let hostDir: string;

  beforeAll(async () => {
    sandbox = await provider.create({ jobId: "00000000-test", image: IMAGE });
    hostDir = await mkdtemp(path.join(tmpdir(), "dca-sbx-"));
    await mkdir(path.join(hostDir, "src"));
    await writeFile(path.join(hostDir, "src", "hello.txt"), "hello from host\n");
  }, 120_000);

  afterAll(async () => {
    await sandbox?.destroy();
    await rm(hostDir, { recursive: true, force: true });
  });

  it("runs as an unprivileged user with a read-only root and no network", async () => {
    const result = await sandbox.exec(
      "id -u; touch /etc/x 2>/dev/null && echo rootfs-writable || echo rootfs-readonly; " +
        "(getent hosts registry.npmjs.org >/dev/null && echo net) || echo no-net",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["1000", "rootfs-readonly", "no-net"]);
  });

  it("copies files in owned by the sandbox user and reads/writes files", async () => {
    await sandbox.copyIn(hostDir, sandbox.repoDir);
    const listing = await sandbox.exec("stat -c '%u %n' src/hello.txt && cat src/hello.txt");
    expect(listing.stdout).toBe("1000 src/hello.txt\nhello from host\n");

    await sandbox.writeFile(`${sandbox.repoDir}/out/result.txt`, "written");
    expect((await sandbox.readFile(`${sandbox.repoDir}/out/result.txt`))?.toString()).toBe(
      "written",
    );
    expect(await sandbox.readFile(`${sandbox.repoDir}/missing.txt`)).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")(
    "does not copy macOS AppleDouble files for extended attributes",
    async () => {
      execFileSync("xattr", ["-w", "com.dca.test", "1", path.join(hostDir, "src", "hello.txt")]);
      await sandbox.copyIn(hostDir, "/workspace/xattr-copy");
      const found = await sandbox.exec("find /workspace/xattr-copy -name '._*' | wc -l");
      expect(found.stdout.trim()).toBe("0");
    },
  );

  it("reports exit codes, env and stderr", async () => {
    const result = await sandbox.exec('echo "$GREETING" && echo oops >&2 && exit 3', {
      env: { GREETING: "hi" },
    });
    expect(result).toMatchObject({
      exitCode: 3,
      stdout: "hi\n",
      stderr: "oops\n",
      timedOut: false,
    });
  });

  it("kills commands that exceed their timeout", async () => {
    const result = await sandbox.exec("sleep 30", { timeoutMs: 1_000 });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
  });
});
