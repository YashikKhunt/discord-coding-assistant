import { apiClientEnv, baseEnv, discordEnv, parseEnv } from "@dca/core";
import { createDb } from "@dca/db";
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import pino from "pino";
import { createApiClient } from "./api-client.ts";
import { DiscordForumPublisher } from "./forum.ts";
import { handleCommand } from "./handlers.ts";
import { Notifier } from "./notifier.ts";

const env = parseEnv(baseEnv.extend(discordEnv.shape).extend(apiClientEnv.shape));
const log = pino({ level: env.LOG_LEVEL, base: { service: "bot" } });

if (env.ALLOWED_USER_IDS.length === 0 && env.ALLOWED_ROLE_IDS.length === 0) {
  log.warn("ALLOWED_USER_IDS and ALLOWED_ROLE_IDS are empty: nobody can use the bot");
}

const { db, close } = createDb(env.DATABASE_URL, { max: 4 });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const publisher = new DiscordForumPublisher(client, env.DISCORD_RESPONSES_FORUM_ID, log);
const notifier = new Notifier(db, publisher, log.child({ component: "notifier" }));

const deps = {
  api: createApiClient(env.API_URL, env.INTERNAL_API_TOKEN),
  db,
  notifier,
  allowlist: { userIds: env.ALLOWED_USER_IDS, roleIds: env.ALLOWED_ROLE_IDS },
  guildId: env.DISCORD_GUILD_ID,
  createJobChannelId: env.DISCORD_CREATE_JOB_CHANNEL_ID,
  log,
};

client.once(Events.ClientReady, async (ready) => {
  log.info({ user: ready.user.tag }, "discord connected");
  await publisher.ensureTags();
  notifier.start();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction, deps);
  } catch (err) {
    log.error({ err, command: interaction.commandName }, "interaction failed");
    const content = "Something went wrong. Check the bot logs.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content }).catch(() => {});
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.on(Events.Error, (err) => log.error({ err }, "discord client error"));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log.info({ signal }, "shutting down");
    await notifier.stop();
    await client.destroy();
    await close();
    process.exit(0);
  });
}

await client.login(env.DISCORD_TOKEN);
