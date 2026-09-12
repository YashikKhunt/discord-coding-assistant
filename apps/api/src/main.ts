import { apiEnv, baseEnv, githubEnv, llmEnv, parseEnv, workerEnv } from "@dca/core";
import { createDb } from "@dca/db";
import { runMigrations } from "@dca/db/migrate";
import { createGitHubClient } from "@dca/github";
import { buildApp } from "./app.ts";

const env = parseEnv(
  baseEnv
    .extend(apiEnv.shape)
    .extend(githubEnv.shape)
    .extend(llmEnv.pick({ MONTHLY_LLM_CAP_USD: true }).shape)
    .extend(workerEnv.pick({ ATTACHMENTS_DIR: true }).shape),
);

await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL);

const app = buildApp({
  db,
  github: createGitHubClient(env.GITHUB_BOT_TOKEN),
  internalToken: env.INTERNAL_API_TOKEN,
  attachmentsDir: env.ATTACHMENTS_DIR,
  monthlyLlmCapUsd: env.MONTHLY_LLM_CAP_USD,
  logger: { level: env.LOG_LEVEL },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await close();
    process.exit(0);
  });
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });
