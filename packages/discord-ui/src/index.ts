import {
  isAgentJobResult,
  isRuntestResult,
  type JobDto,
  type JobStatus,
  type JobType,
} from "@dca/core";
import { agentJobEmbedParts, agentJobHeadline } from "./agent-job.ts";
import { runtestEmbedParts, runtestWord } from "./runtest.ts";

export * from "./agent-job.ts";
export * from "./runtest.ts";

/** Subset of Discord's APIEmbed; discord.js accepts these plain objects directly. */
export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

export const COLORS = {
  green: 0x2ecc71,
  red: 0xe74c3c,
  yellow: 0xf1c40f,
  grey: 0x95a5a6,
  blue: 0x3498db,
} as const;

export const STATUS_EMOJI: Record<JobStatus, string> = {
  queued: "⏳",
  preparing: "🟦",
  running: "🟦",
  finalizing: "🟦",
  succeeded: "🟩",
  partial: "🟨",
  failed: "🟥",
  cancelled: "⬜",
};

const STATUS_COLOR: Record<JobStatus, number> = {
  queued: COLORS.grey,
  preparing: COLORS.blue,
  running: COLORS.blue,
  finalizing: COLORS.blue,
  succeeded: COLORS.green,
  partial: COLORS.yellow,
  failed: COLORS.red,
  cancelled: COLORS.grey,
};

/** Forum tag names. Status tags collapse in-flight states into `running`. */
export const TYPE_TAGS: Record<JobType, string> = {
  task: "task",
  bugreport: "bugreport",
  runtest: "runtest",
};

export const STATUS_TAGS = [
  "queued",
  "running",
  "passed",
  "failed",
  "partial",
  "cancelled",
] as const;
export type StatusTag = (typeof STATUS_TAGS)[number];

export const ALL_TAG_NAMES: string[] = [...Object.values(TYPE_TAGS), ...STATUS_TAGS];

export function statusTag(status: JobStatus): StatusTag {
  switch (status) {
    case "queued":
      return "queued";
    case "preparing":
    case "running":
    case "finalizing":
      return "running";
    case "succeeded":
      return "passed";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export function tagNamesFor(job: Pick<JobDto, "type" | "status" | "result">): string[] {
  // A completed /runtest whose tests failed is still a "failed" run from the user's view.
  if (
    job.status === "succeeded" &&
    isRuntestResult(job.result) &&
    job.result.outcome !== "passed"
  ) {
    return [TYPE_TAGS[job.type], "failed"];
  }
  return [TYPE_TAGS[job.type], statusTag(job.status)];
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function requestSummary(job: Pick<JobDto, "type" | "ref" | "input">): string {
  const text =
    job.type === "runtest" ? `run tests${job.ref ? ` @ ${job.ref}` : ""}` : job.input.description;
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Discord forum post titles are limited to 100 characters. */
export function forumPostTitle(job: Pick<JobDto, "shortId" | "repo" | "type" | "ref" | "input">) {
  return truncate(`${job.shortId} · ${job.repo} · ${requestSummary(job)}`, 100);
}

export function threadUrl(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

export function ackContent(
  job: Pick<JobDto, "shortId" | "repo">,
  position: number | null,
  thread?: { guildId: string; threadId: string },
): string {
  const where = position ? ` · position ${position}` : "";
  const link = thread ? `\n→ ${threadUrl(thread.guildId, thread.threadId)}` : "";
  return `✅ **${job.shortId}** queued · \`${job.repo}\`${where}${link}`;
}

export function forumPostEmbed(job: JobDto): Embed {
  const fields: Embed["fields"] = [
    { name: "Type", value: job.type, inline: true },
    { name: "Repo", value: `\`${job.repo}\``, inline: true },
    { name: "Requested by", value: `<@${job.requestedByDiscordId}>`, inline: true },
  ];
  if (job.ref) fields.push({ name: "Ref", value: `\`${job.ref}\``, inline: true });
  if (job.input.base) fields.push({ name: "Base", value: `\`${job.input.base}\``, inline: true });
  if (job.input.issue) fields.push({ name: "Issue", value: job.input.issue, inline: true });
  if (job.input.steps)
    fields.push({ name: "Steps to reproduce", value: truncate(job.input.steps, 1024) });
  if (job.input.expected)
    fields.push({ name: "Expected", value: truncate(job.input.expected, 1024) });

  return {
    title: `${job.shortId} · ${job.type}`,
    description: truncate(job.input.description ?? requestSummary(job), 4000),
    color: COLORS.grey,
    fields,
    footer: { text: `source: ${job.source}` },
    timestamp: job.createdAt,
  };
}

function durationMs(job: Pick<JobDto, "startedAt" | "finishedAt">): number | null {
  if (!job.startedAt || !job.finishedAt) return null;
  return new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
}

function shortModel(model: string | null): string | null {
  return model ? (model.split(":").pop() ?? model) : null;
}

function statsFooter(job: JobDto): string {
  const parts = [
    job.result?.model ? String(job.result.model) : null,
    formatUsd(job.costUsd),
    job.iterations ? `${job.iterations} steps` : null,
  ];
  const ms = durationMs(job);
  if (ms !== null) parts.push(formatDuration(ms));
  return parts.filter(Boolean).join(" · ");
}

const RESULT_HEADLINE: Partial<Record<JobStatus, string>> = {
  succeeded: "completed",
  partial: "stopped early — partial result",
  failed: "failed",
  cancelled: "cancelled",
};

export function resultEmbed(job: JobDto): Embed {
  if (isAgentJobResult(job.result)) {
    const parts = agentJobEmbedParts(job, job.result);
    return {
      ...parts,
      footer: {
        text: statsFooter({
          ...job,
          result: { ...job.result, model: shortModel(job.result.model) },
        }),
      },
      timestamp: job.finishedAt ?? undefined,
    };
  }
  if (isRuntestResult(job.result)) {
    const parts = runtestEmbedParts(job, job.result);
    return {
      title: parts.title,
      description: parts.description,
      color: parts.color,
      fields: parts.fields,
      footer: { text: parts.footer },
      timestamp: job.finishedAt ?? undefined,
    };
  }
  const summary =
    typeof job.result?.summary === "string" ? job.result.summary : (job.error ?? undefined);
  const headline = job.prUrl
    ? `PR opened · ${job.prUrl}`
    : (RESULT_HEADLINE[job.status] ?? job.status);
  return {
    title: truncate(`${STATUS_EMOJI[job.status]} ${job.shortId} · ${headline}`, 256),
    url: job.prUrl ?? undefined,
    description: summary ? truncate(summary, 4000) : undefined,
    color: STATUS_COLOR[job.status],
    footer: { text: statsFooter(job) },
    timestamp: job.finishedAt ?? undefined,
  };
}

export function resultContent(
  job: Pick<JobDto, "requestedByDiscordId" | "shortId" | "status" | "result">,
) {
  const word =
    isRuntestResult(job.result) && job.status !== "cancelled"
      ? runtestWord(job.result)
      : isAgentJobResult(job.result) && job.status !== "cancelled"
        ? agentJobHeadline(job, job.result)
        : (RESULT_HEADLINE[job.status] ?? job.status);
  return `<@${job.requestedByDiscordId}> ${job.shortId} ${word}`;
}

export interface ResultFile {
  name: string;
  content: string;
}

/** Files attached to the result message (e.g. the tail of the test log). */
export function resultFiles(job: Pick<JobDto, "shortId" | "result">): ResultFile[] {
  if (isRuntestResult(job.result) && job.result.logTail) {
    return [{ name: `${job.shortId}-log.txt`, content: job.result.logTail }];
  }
  return [];
}

export function statusEmbed(
  job: JobDto,
  options: { position?: number | null; guildId?: string } = {},
): Embed {
  const fields: Embed["fields"] = [
    { name: "Status", value: `${STATUS_EMOJI[job.status]} ${job.status}`, inline: true },
    { name: "Repo", value: `\`${job.repo}\``, inline: true },
    { name: "Cost", value: formatUsd(job.costUsd), inline: true },
  ];
  if (options.position) {
    fields.push({ name: "Queue position", value: String(options.position), inline: true });
  }
  if (
    job.cancelRequestedAt &&
    !["cancelled", "failed", "succeeded", "partial"].includes(job.status)
  ) {
    fields.push({ name: "Cancel", value: "requested", inline: true });
  }
  if (job.prUrl) fields.push({ name: "PR", value: job.prUrl });
  if (job.discordForumThreadId && options.guildId) {
    fields.push({ name: "Thread", value: threadUrl(options.guildId, job.discordForumThreadId) });
  }
  if (job.error) fields.push({ name: "Error", value: truncate(job.error, 1024) });
  return {
    title: `${job.shortId} · ${job.type}`,
    description: truncate(requestSummary(job), 1000) || undefined,
    color: STATUS_COLOR[job.status],
    fields,
    timestamp: job.createdAt,
  };
}

export function jobsListEmbed(jobs: JobDto[]): Embed {
  if (jobs.length === 0)
    return { title: "Recent jobs", description: "No jobs yet.", color: COLORS.grey };
  const lines = jobs.map(
    (job) =>
      `${STATUS_EMOJI[job.status]} \`${job.shortId}\` ${job.status} · \`${job.repo}\` · ${truncate(requestSummary(job), 60)}`,
  );
  return {
    title: "Recent jobs",
    description: truncate(lines.join("\n"), 4000),
    color: COLORS.blue,
  };
}
