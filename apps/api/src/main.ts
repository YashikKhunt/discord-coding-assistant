import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiEnv,
  baseEnv,
  dashboardEnv,
  discordEnv,
  githubEnv,
  llmEnv,
  parseEnv,
  workerEnv,
} from "@dca/core";
import { createDb, deleteExpiredSessions } from "@dca/db";
import { runMigrations } from "@dca/db/migrate";
import { createGitHubClient } from "@dca/github";
import { buildApp } from "./app.ts";
import type { DashboardDeps } from "./dashboard.ts";
import { createDiscordOAuth } from "./discord-oauth.ts";

const env = parseEnv(
  baseEnv
    .extend(apiEnv.shape)
    .extend(githubEnv.shape)
    .extend(llmEnv.pick({ MONTHLY_LLM_CAP_USD: true }).shape)
    .extend(workerEnv.pick({ ATTACHMENTS_DIR: true }).shape),
);

await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL);

// The dashboard is optional: enabled once its OAuth settings are present.
let dashboard: DashboardDeps | undefined;
if (process.env.DISCORD_OAUTH_CLIENT_SECRET) {
  const dash = parseEnv(
    dashboardEnv.extend(
      discordEnv.pick({
        DISCORD_APP_ID: true,
        DISCORD_GUILD_ID: true,
        ALLOWED_USER_IDS: true,
        ALLOWED_ROLE_IDS: true,
      }).shape,
    ),
  );
  dashboard = {
    oauth: createDiscordOAuth({
      clientId: dash.DISCORD_APP_ID,
      clientSecret: dash.DISCORD_OAUTH_CLIENT_SECRET,
      redirectUri: new URL("/auth/discord/callback", dash.DASHBOARD_URL).toString(),
      guildId: dash.DISCORD_GUILD_ID,
    }),
    allowlist: { userIds: dash.ALLOWED_USER_IDS, roleIds: dash.ALLOWED_ROLE_IDS },
    dashboardUrl: dash.DASHBOARD_URL,
    sessionSecret: dash.SESSION_SECRET,
    // Relative paths are resolved from the repository root, whatever the working directory.
    distDir: path.resolve(
      fileURLToPath(new URL("../../../", import.meta.url)),
      dash.DASHBOARD_DIST,
    ),
  };
}

const app = buildApp({
  db,
  github: createGitHubClient(env.GITHUB_BOT_TOKEN),
  internalToken: env.INTERNAL_API_TOKEN,
  attachmentsDir: env.ATTACHMENTS_DIR,
  monthlyLlmCapUsd: env.MONTHLY_LLM_CAP_USD,
  logger: { level: env.LOG_LEVEL },
  dashboard,
});
app.log.info(
  { dashboard: Boolean(dashboard) },
  dashboard ? "dashboard enabled" : "dashboard disabled (no DISCORD_OAUTH_CLIENT_SECRET)",
);

const sessionCleanup = setInterval(() => {
  deleteExpiredSessions(db).catch((err) => app.log.warn({ err }, "session cleanup failed"));
}, 60 * 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    clearInterval(sessionCleanup);
    await app.close();
    await close();
    process.exit(0);
  });
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });
