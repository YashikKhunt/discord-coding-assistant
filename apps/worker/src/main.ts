import { baseEnv, githubEnv, llmEnv, parseEnv, workerEnv } from "@dca/core";
import { createDb } from "@dca/db";
import { runMigrations } from "@dca/db/migrate";
import { createGitHubClient } from "@dca/github";
import { availableProviders } from "@dca/llm";
import { DockerSandboxProvider, isDockerAvailable } from "@dca/sandbox";
import pino from "pino";
import { createAgentRuntime } from "./agent-runtime.ts";
import { StubRunner } from "./runner.ts";
import { RouterRunner } from "./runners/router.ts";
import { RuntestRunner } from "./runners/runtest.ts";
import { Worker } from "./worker.ts";

const env = parseEnv(baseEnv.extend(workerEnv.shape).extend(githubEnv.shape).extend(llmEnv.shape));
const log = pino({ level: env.LOG_LEVEL, base: { service: "worker" } });

if (!(await isDockerAvailable())) {
  log.fatal("Docker is not available; the worker needs it to run sandboxes");
  process.exit(1);
}

await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL, { max: env.WORKER_CONCURRENCY + 4 });

const sandbox = new DockerSandboxProvider({
  runtime: env.SANDBOX_RUNTIME,
  network: env.SANDBOX_NETWORK || undefined,
  proxyUrl: env.SANDBOX_PROXY_URL || undefined,
});
if (!env.SANDBOX_NETWORK) {
  log.warn("SANDBOX_NETWORK is empty: sandboxes have no network, dependency installs will fail");
}

const providers = availableProviders(env);
if (providers.length === 0) {
  log.warn("No LLM provider keys set: /runtest will skip failure analysis");
} else {
  log.info({ providers, monthlyCapUsd: env.MONTHLY_LLM_CAP_USD }, "LLM providers configured");
}
const agent = createAgentRuntime({ db, keys: env, monthlyCapUsd: env.MONTHLY_LLM_CAP_USD });

const worker = new Worker({
  db,
  log,
  concurrency: env.WORKER_CONCURRENCY,
  runner: new RouterRunner({
    runtest: new RuntestRunner({
      sandbox,
      github: createGitHubClient(env.GITHUB_BOT_TOKEN),
      token: env.GITHUB_BOT_TOKEN,
      workspacesDir: env.WORKSPACES_DIR,
      images: { node: env.SANDBOX_IMAGE_NODE, python: env.SANDBOX_IMAGE_PYTHON },
      agent,
    }),
    // Replaced by the agent runners in M3/M4.
    task: new StubRunner(),
    bugreport: new StubRunner(),
  }),
});

// Sandboxes outlive a crashed worker; remove any older than the longest job could run.
const reaper = setInterval(() => {
  sandbox
    .reapOrphans(45 * 60_000)
    .then((removed) => removed && log.warn({ removed }, "removed orphaned sandboxes"))
    .catch((err) => log.error({ err }, "sandbox reaper failed"));
}, 5 * 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log.info({ signal }, "shutting down");
    clearInterval(reaper);
    await worker.stop();
    await close();
    process.exit(0);
  });
}

await worker.start();
