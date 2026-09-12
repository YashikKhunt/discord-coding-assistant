import { discordEnv, parseEnv } from "@dca/core";
import { REST, Routes } from "discord.js";
import { commandDefinitions } from "./commands/definitions.ts";

const env = parseEnv(
  discordEnv.pick({ DISCORD_TOKEN: true, DISCORD_APP_ID: true, DISCORD_GUILD_ID: true }),
);

const rest = new REST().setToken(env.DISCORD_TOKEN);
const body = commandDefinitions.map((command) => command.toJSON());

// Guild commands update instantly (global commands can take up to an hour).
await rest.put(Routes.applicationGuildCommands(env.DISCORD_APP_ID, env.DISCORD_GUILD_ID), { body });
console.log(
  `Registered ${body.length} commands: ${body.map((command) => `/${command.name}`).join(" ")}`,
);
