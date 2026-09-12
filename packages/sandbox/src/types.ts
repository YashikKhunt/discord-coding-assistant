export interface ResourceLimits {
  cpus: number;
  memoryMb: number;
  pids: number;
}

export interface CreateSandboxOptions {
  jobId: string;
  image: string;
  limits?: Partial<ResourceLimits>;
  /** Extra environment for every exec (e.g. proxy settings). */
  env?: Record<string, string>;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: string | Buffer;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in arrival order (truncated head+tail). */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export interface Sandbox {
  readonly id: string;
  /** Repository checkout location inside the sandbox. */
  readonly repoDir: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer | null>;
  writeFile(path: string, data: string | Buffer): Promise<void>;
  /** Copies a host directory's contents into `sandboxDir`, owned by the sandbox user. */
  copyIn(hostDir: string, sandboxDir: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  create(options: CreateSandboxOptions): Promise<Sandbox>;
  /** Removes sandboxes left behind by crashed workers. Returns how many were removed. */
  reapOrphans(olderThanMs: number): Promise<number>;
}
