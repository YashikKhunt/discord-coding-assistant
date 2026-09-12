import { describe, expect, it } from "vitest";
import { baseEnv, ConfigError, discordEnv, parseEnv, workerEnv } from "./config.ts";

describe("parseEnv", () => {
  it("applies defaults and coercion", () => {
    const env = parseEnv(baseEnv.extend(workerEnv.shape), {
      DATABASE_URL: "postgres://u:p@localhost:5432/dca",
      WORKER_CONCURRENCY: "3",
    });
    expect(env.WORKER_CONCURRENCY).toBe(3);
    expect(env.SANDBOX_RUNTIME).toBe("runc");
    expect(env.RETENTION_DAYS).toBe(30);
  });

  it("splits allowlists", () => {
    const env = parseEnv(discordEnv, {
      DISCORD_TOKEN: "x",
      DISCORD_APP_ID: "123456789012345678",
      DISCORD_GUILD_ID: "123456789012345678",
      DISCORD_CREATE_JOB_CHANNEL_ID: "123456789012345678",
      DISCORD_RESPONSES_FORUM_ID: "123456789012345678",
      ALLOWED_USER_IDS: "111111111111111111, 222222222222222222,",
    });
    expect(env.ALLOWED_USER_IDS).toEqual(["111111111111111111", "222222222222222222"]);
    expect(env.ALLOWED_ROLE_IDS).toEqual([]);
  });

  it("reports all issues together", () => {
    try {
      parseEnv(discordEnv, { DISCORD_APP_ID: "nope" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { issues } = error as ConfigError;
      expect(issues.length).toBeGreaterThanOrEqual(4);
      expect(issues.some((issue) => issue.startsWith("DISCORD_APP_ID"))).toBe(true);
    }
  });
});
