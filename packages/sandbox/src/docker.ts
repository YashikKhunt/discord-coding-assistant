import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HeadTailBuffer } from "./output.ts";
import type {
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  ResourceLimits,
  Sandbox,
  SandboxProvider,
} from "./types.ts";

const LABEL = "dca.sandbox";
const WORKSPACE = "/workspace";
const REPO_DIR = `${WORKSPACE}/repo`;
const HOME_DIR = `${WORKSPACE}/home`;
const DEFAULT_LIMITS: ResourceLimits = { cpus: 2, memoryMb: 2048, pids: 512 };
const MAX_OUTPUT_BYTES = 200_000;

export interface DockerSandboxOptions {
  /** Applied to every sandbox unless `create` overrides them. */
  defaultLimits?: Partial<ResourceLimits>;
  /** `runc` locally, `runsc` (gVisor) on the VPS. */
  runtime?: "runc" | "runsc";
  /** Docker network for sandboxes. Use an `--internal` network that only reaches the egress proxy. */
  network?: string;
  /** Proxy URL injected as HTTP(S)_PROXY, e.g. `http://egress-proxy:3128`. */
  proxyUrl?: string;
  dockerBin?: string;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Runs the docker CLI. Using the CLI keeps us free of daemon API client dependencies. */
function docker(
  bin: string,
  args: string[],
  options: { stdin?: string | Buffer | NodeJS.ReadableStream; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    }
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 10_000) stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr });
    });
    const { stdin } = options;
    if (stdin && typeof stdin === "object" && "pipe" in stdin) {
      stdin.pipe(child.stdin);
    } else {
      child.stdin.end(stdin);
    }
  });
}

async function dockerOk(bin: string, args: string[], stdin?: string | Buffer) {
  const result = await docker(bin, args, { stdin });
  if (result.code !== 0) {
    throw new Error(`docker ${args[0]} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result;
}

/** Single-quotes a value for bash. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

class DockerSandbox implements Sandbox {
  readonly id: string;
  readonly repoDir = REPO_DIR;
  readonly #bin: string;
  readonly #volume: string;
  readonly #baseEnv: Record<string, string>;

  constructor(bin: string, id: string, volume: string, baseEnv: Record<string, string>) {
    this.#bin = bin;
    this.id = id;
    this.#volume = volume;
    this.#baseEnv = baseEnv;
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const env = { ...this.#baseEnv, ...options.env };
    const args = [
      "exec",
      "-i",
      "-w",
      options.cwd ?? REPO_DIR,
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      this.id,
      // `timeout` inside the container: killing `docker exec` on the host would not stop the process.
      "timeout",
      "--kill-after=5",
      String(seconds),
      "bash",
      "-c",
      command,
    ];

    return new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(this.#bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      const stdout = new HeadTailBuffer(MAX_OUTPUT_BYTES);
      const stderr = new HeadTailBuffer(MAX_OUTPUT_BYTES / 4);
      const output = new HeadTailBuffer(MAX_OUTPUT_BYTES);
      // Backstop in case the container is wedged and `timeout` never returns.
      const hostTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 15_000);

      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout.push(chunk);
        output.push(chunk);
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr.push(chunk);
        output.push(chunk);
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(hostTimer);
        const exitCode = code ?? (signal ? 137 : -1);
        resolve({
          exitCode,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          output: output.toString(),
          // GNU timeout exits 124 on timeout, 137 when it had to SIGKILL.
          timedOut: exitCode === 124 || (exitCode === 137 && Date.now() - started >= timeoutMs),
          durationMs: Date.now() - started,
        });
      });
      child.stdin.end(options.stdin);
    });
  }

  async readFile(path: string): Promise<Buffer | null> {
    const result = await docker(this.#bin, ["exec", this.id, "cat", "--", path]);
    return result.code === 0 ? result.stdout : null;
  }

  async writeFile(path: string, data: string | Buffer): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const script = `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(path)}`;
    await dockerOk(this.#bin, ["exec", "-i", this.id, "bash", "-c", script], data);
  }

  async copyIn(hostDir: string, sandboxDir: string): Promise<void> {
    // tar through `docker exec` so files are owned by the sandbox user (docker cp keeps host uids).
    // COPYFILE_DISABLE stops macOS tar from adding AppleDouble `._*` files for extended attributes.
    const tar = spawn("tar", ["-C", hostDir, "-cf", "-", "."], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const tarFailed = new Promise<never>((_, reject) => {
      tar.on("error", reject);
      tar.on("close", (code) => {
        if (code !== 0) reject(new Error(`tar exited with ${code}`));
      });
    });
    const extract = docker(
      this.#bin,
      [
        "exec",
        "-i",
        this.id,
        "bash",
        "-c",
        `mkdir -p ${shellQuote(sandboxDir)} && tar -C ${shellQuote(sandboxDir)} -xf - --no-same-owner`,
      ],
      { stdin: tar.stdout },
    );
    const result = await Promise.race([extract, tarFailed]);
    if (result.code !== 0) throw new Error(`copy into sandbox failed: ${result.stderr.trim()}`);
  }

  async destroy(): Promise<void> {
    await docker(this.#bin, ["rm", "-f", "-v", this.id]);
    await docker(this.#bin, ["volume", "rm", "-f", this.#volume]);
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly #opts: Required<Omit<DockerSandboxOptions, "network" | "proxyUrl" | "defaultLimits">> &
    Pick<DockerSandboxOptions, "network" | "proxyUrl" | "defaultLimits">;

  constructor(options: DockerSandboxOptions = {}) {
    this.#opts = { runtime: "runc", dockerBin: "docker", ...options };
  }

  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const { dockerBin: bin, runtime, network, proxyUrl } = this.#opts;
    const limits = { ...DEFAULT_LIMITS, ...this.#opts.defaultLimits, ...options.limits };
    const suffix = randomUUID().slice(0, 8);
    const name = `dca-sbx-${options.jobId.slice(0, 8)}-${suffix}`;
    const volume = `${name}-ws`;
    const labels = [`${LABEL}=1`, `dca.job=${options.jobId}`, `dca.created=${Date.now()}`];

    await dockerOk(bin, ["volume", "create", ...labels.flatMap((l) => ["--label", l]), volume]);
    // New volumes are root-owned. Prepare them in a throwaway container that runs only this
    // fixed command; the sandbox itself then starts without any capabilities.
    try {
      await dockerOk(bin, [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--mount",
        `type=volume,src=${volume},dst=${WORKSPACE}`,
        "--entrypoint",
        "sh",
        options.image,
        "-c",
        `mkdir -p ${REPO_DIR} ${HOME_DIR} && chown -R 1000:1000 ${WORKSPACE}`,
      ]);
    } catch (error) {
      await docker(bin, ["volume", "rm", "-f", volume]);
      throw error;
    }

    const proxyEnv: Record<string, string> = proxyUrl
      ? {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          NO_PROXY: "localhost,127.0.0.1",
          no_proxy: "localhost,127.0.0.1",
          // Node's built-in fetch (used by corepack) ignores the variables above without this,
          // and warns on every process start that the proxy agent is experimental.
          NODE_USE_ENV_PROXY: "1",
          NODE_OPTIONS: "--disable-warning=UNDICI-EHPA",
        }
      : {};
    const baseEnv: Record<string, string> = {
      HOME: HOME_DIR,
      CI: "true",
      TMPDIR: "/tmp",
      COREPACK_HOME: `${HOME_DIR}/.corepack`,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      npm_config_cache: `${HOME_DIR}/.npm`,
      UV_CACHE_DIR: `${HOME_DIR}/.cache/uv`,
      PIP_CACHE_DIR: `${HOME_DIR}/.cache/pip`,
      PYTHONDONTWRITEBYTECODE: "1",
      ...proxyEnv,
      ...options.env,
    };

    const args = [
      "run",
      "-d",
      "--name",
      name,
      ...labels.flatMap((l) => ["--label", l]),
      "--runtime",
      runtime,
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,size=1g",
      "--mount",
      `type=volume,src=${volume},dst=${WORKSPACE}`,
      "--cpus",
      String(limits.cpus),
      "--memory",
      `${limits.memoryMb}m`,
      "--memory-swap",
      `${limits.memoryMb}m`,
      "--pids-limit",
      String(limits.pids),
      "--network",
      network ?? "none",
      "--entrypoint",
      "sleep",
      options.image,
      "infinity",
    ];

    try {
      await dockerOk(bin, args);
    } catch (error) {
      await docker(bin, ["rm", "-f", name]);
      await docker(bin, ["volume", "rm", "-f", volume]);
      throw error;
    }

    return new DockerSandbox(bin, name, volume, baseEnv);
  }

  async reapOrphans(olderThanMs: number): Promise<number> {
    const { dockerBin: bin } = this.#opts;
    const list = await dockerOk(bin, [
      "ps",
      "-a",
      "--filter",
      `label=${LABEL}=1`,
      "--format",
      '{{.Names}} {{.Label "dca.created"}}',
    ]);
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const line of list.stdout.toString().split("\n")) {
      const [name, created] = line.trim().split(" ");
      if (!name || Number(created) > cutoff) continue;
      await docker(bin, ["rm", "-f", "-v", name]);
      await docker(bin, ["volume", "rm", "-f", `${name}-ws`]);
      removed++;
    }
    return removed;
  }
}

export async function isDockerAvailable(bin = "docker"): Promise<boolean> {
  try {
    return (
      (await docker(bin, ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 }))
        .code === 0
    );
  } catch {
    return false;
  }
}
