import type { AttachmentInput, CreateJobRequest, JobType } from "@dca/core";

/** Minimal view of slash-command options, so request building is testable without discord.js. */
export interface CommandOptions {
  getString(name: string): string | null;
  getAttachment(
    name: string,
  ): { url: string; name: string; contentType: string | null; size: number } | null;
}

const clean = (value: string | null) => value?.trim() || undefined;

export function buildCreateJobRequest(
  type: JobType,
  options: CommandOptions,
  requestedByDiscordId: string,
): CreateJobRequest {
  const attachments: AttachmentInput[] = [];
  for (let i = 1; i <= 3; i++) {
    const attachment = options.getAttachment(`attachment${i}`);
    if (!attachment) continue;
    attachments.push({
      url: attachment.url,
      filename: attachment.name,
      contentType: attachment.contentType ?? undefined,
      size: attachment.size,
    });
  }

  const repo = clean(options.getString("repo")) ?? "";
  switch (type) {
    case "task":
      return {
        type,
        repo,
        requestedByDiscordId,
        input: {
          description: clean(options.getString("description")),
          base: clean(options.getString("base")),
        },
        attachments,
      };
    case "bugreport":
      return {
        type,
        repo,
        requestedByDiscordId,
        input: {
          description: clean(options.getString("description")),
          steps: clean(options.getString("steps")),
          expected: clean(options.getString("expected")),
          issue: clean(options.getString("issue")),
        },
        attachments,
      };
    case "runtest":
      return { type, repo, requestedByDiscordId, ref: clean(options.getString("ref")), input: {} };
  }
}
