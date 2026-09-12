import { type JobType, parseShortId } from "@dca/core";
import { type Db, setDiscordThread } from "@dca/db";
import { ackContent, jobsListEmbed, statusEmbed } from "@dca/discord-ui";
import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import type { Logger } from "pino";
import { type Allowlist, isAllowed } from "./access.ts";
import { type ApiClient, ApiError } from "./api-client.ts";
import { JOB_COMMANDS } from "./commands/definitions.ts";
import type { Notifier } from "./notifier.ts";
import { buildCreateJobRequest } from "./requests.ts";

export interface HandlerDeps {
  api: ApiClient;
  db: Db;
  notifier: Notifier;
  allowlist: Allowlist;
  guildId: string;
  createJobChannelId: string;
  log: Logger;
}

function memberRoleIds(interaction: ChatInputCommandInteraction): string[] {
  const roles = interaction.member?.roles;
  if (!roles) return [];
  return Array.isArray(roles) ? roles : [...roles.cache.keys()];
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong. Check the bot logs.";
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
): Promise<void> {
  const { commandName, user } = interaction;
  const log = deps.log.child({ command: commandName, userId: user.id });

  if (interaction.guildId !== deps.guildId) {
    await interaction.reply({
      content: "This bot is not configured for this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!isAllowed(deps.allowlist, user.id, memberRoleIds(interaction))) {
    await interaction.reply({
      content: "⛔ You are not allowed to use this bot.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (JOB_COMMANDS.has(commandName)) {
    if (interaction.channelId !== deps.createJobChannelId) {
      await interaction.reply({
        content: `Please use <#${deps.createJobChannelId}> for new jobs.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await createJob(interaction, commandName as JobType, deps, log);
    return;
  }

  switch (commandName) {
    case "status":
      return showStatus(interaction, deps);
    case "cancel":
      return cancelJob(interaction, deps);
    case "jobs":
      return listRecentJobs(interaction, deps);
    default:
      await interaction.reply({ content: "Unknown command.", flags: MessageFlags.Ephemeral });
  }
}

async function createJob(
  interaction: ChatInputCommandInteraction,
  type: JobType,
  deps: HandlerDeps,
  log: Logger,
): Promise<void> {
  await interaction.deferReply();
  try {
    const request = buildCreateJobRequest(type, interaction.options, interaction.user.id);
    const { job, position } = await deps.api.createJob(request);

    let threadId: string | undefined;
    try {
      threadId = await deps.notifier.ensurePost(job);
    } catch (err) {
      log.warn({ err, shortId: job.shortId }, "forum post failed; notifier will retry");
    }

    const reply = await interaction.editReply({
      content: ackContent(
        job,
        position,
        threadId ? { guildId: deps.guildId, threadId } : undefined,
      ),
      allowedMentions: { parse: [] },
    });
    await setDiscordThread(deps.db, job.id, { ackMessageId: reply.id });
    log.info({ shortId: job.shortId }, "job created");
  } catch (err) {
    if (!(err instanceof ApiError)) log.error({ err }, "create job failed");
    await interaction.editReply({ content: `❌ ${describeError(err)}` });
  }
}

async function resolveShortId(interaction: ChatInputCommandInteraction): Promise<string | null> {
  const raw = interaction.options.getString("job", true);
  const parsed = parseShortId(raw);
  if (!parsed) {
    await interaction.reply({
      content: `\`${raw}\` is not a job ID. Use something like \`TASK-0042\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return parsed.shortId;
}

async function showStatus(interaction: ChatInputCommandInteraction, deps: HandlerDeps) {
  const shortId = await resolveShortId(interaction);
  if (!shortId) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { job, position } = await deps.api.getJob(shortId);
    await interaction.editReply({
      embeds: [statusEmbed(job, { position, guildId: deps.guildId })],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${describeError(err)}` });
  }
}

async function cancelJob(interaction: ChatInputCommandInteraction, deps: HandlerDeps) {
  const shortId = await resolveShortId(interaction);
  if (!shortId) return;
  await interaction.deferReply();
  try {
    const { outcome, job } = await deps.api.cancelJob(shortId);
    const content =
      outcome === "cancelled"
        ? `⬜ **${job.shortId}** cancelled.`
        : `⏹️ Cancel requested for **${job.shortId}**; the worker will stop it shortly.`;
    await interaction.editReply({ content });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${describeError(err)}` });
  }
}

async function listRecentJobs(interaction: ChatInputCommandInteraction, deps: HandlerDeps) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { jobs } = await deps.api.listJobs({
      limit: interaction.options.getInteger("limit") ?? 10,
      status: interaction.options.getString("status") ?? undefined,
    });
    await interaction.editReply({ embeds: [jobsListEmbed(jobs)] });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${describeError(err)}` });
  }
}
