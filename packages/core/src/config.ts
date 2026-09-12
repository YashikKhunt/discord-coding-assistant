import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake ID");

export const baseEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DATABASE_URL: z.url(),
});

export const apiEnv = z.object({
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default("127.0.0.1"),
  INTERNAL_API_TOKEN: z.string().min(24),
});

export const apiClientEnv = z.object({
  API_URL: z.url().default("http://127.0.0.1:4000"),
  INTERNAL_API_TOKEN: z.string().min(24),
});

export const discordEnv = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APP_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  DISCORD_CREATE_JOB_CHANNEL_ID: snowflake,
  DISCORD_RESPONSES_FORUM_ID: snowflake,
  ALLOWED_USER_IDS: csv,
  ALLOWED_ROLE_IDS: csv,
});

export const githubEnv = z.object({
  GITHUB_BOT_TOKEN: z.string().min(1),
  GITHUB_BOT_LOGIN: z.string().min(1),
});

export const llmEnv = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  MONTHLY_LLM_CAP_USD: z.coerce.number().positive().default(10),
});

export const workerEnv = z.object({
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  SANDBOX_PROVIDER: z.enum(["docker"]).default("docker"),
  SANDBOX_RUNTIME: z.enum(["runc", "runsc"]).default("runc"),
  /** Internal Docker network shared only with the egress proxy. Empty = no network at all. */
  SANDBOX_NETWORK: z.string().default(""),
  SANDBOX_PROXY_URL: z.string().default(""),
  SANDBOX_IMAGE_NODE: z.string().default("dca-sandbox-node:latest"),
  SANDBOX_IMAGE_PYTHON: z.string().default("dca-sandbox-python:latest"),
  ATTACHMENTS_DIR: z.string().default("./data/attachments"),
  WORKSPACES_DIR: z.string().default("./data/workspaces"),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export const dashboardEnv = z.object({
  DISCORD_OAUTH_CLIENT_SECRET: z.string().min(1),
  DASHBOARD_URL: z.url(),
  SESSION_SECRET: z.string().min(32),
});

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Validates env vars against a schema, reporting every problem at once. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return result.data;
}
