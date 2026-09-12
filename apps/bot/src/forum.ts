import type { JobDto } from "@dca/core";
import {
  ALL_TAG_NAMES,
  forumPostEmbed,
  forumPostTitle,
  resultContent,
  resultEmbed,
  tagNamesFor,
} from "@dca/discord-ui";
import { ChannelType, type Client, type ForumChannel, type ThreadChannel } from "discord.js";
import type { Logger } from "pino";

/** What the notifier needs from Discord. Implemented with discord.js below; faked in tests. */
export interface ForumPublisher {
  createPost(job: JobDto): Promise<string>;
  setTags(threadId: string, job: Pick<JobDto, "type" | "status">): Promise<void>;
  postResult(threadId: string, job: JobDto): Promise<void>;
}

export class DiscordForumPublisher implements ForumPublisher {
  readonly #client: Client;
  readonly #forumId: string;
  readonly #log: Logger;
  #tagIds = new Map<string, string>();

  constructor(client: Client, forumId: string, log: Logger) {
    this.#client = client;
    this.#forumId = forumId;
    this.#log = log;
  }

  /** Creates any missing type/status tags on the forum (needs Manage Channels once). */
  async ensureTags(): Promise<void> {
    const forum = await this.#forum();
    const existing = new Set(forum.availableTags.map((tag) => tag.name));
    const missing = ALL_TAG_NAMES.filter((name) => !existing.has(name));
    if (missing.length) {
      try {
        await forum.setAvailableTags(
          [...forum.availableTags, ...missing.map((name) => ({ name, moderated: true }))],
          "discord-coding-assistant job tags",
        );
        this.#log.info({ missing }, "created forum tags");
      } catch (err) {
        this.#log.error(
          { err, missing },
          "could not create forum tags; grant Manage Channels or create them manually",
        );
      }
    }
    const refreshed = await this.#forum(true);
    this.#tagIds = new Map(refreshed.availableTags.map((tag) => [tag.name, tag.id]));
  }

  async createPost(job: JobDto): Promise<string> {
    const forum = await this.#forum();
    const thread = await forum.threads.create({
      name: forumPostTitle(job),
      appliedTags: this.#tagIdsFor(job),
      message: { embeds: [forumPostEmbed(job)], allowedMentions: { parse: [] } },
    });
    return thread.id;
  }

  async setTags(threadId: string, job: Pick<JobDto, "type" | "status">): Promise<void> {
    const thread = await this.#thread(threadId);
    await thread.setAppliedTags(this.#tagIdsFor(job));
  }

  async postResult(threadId: string, job: JobDto): Promise<void> {
    const thread = await this.#thread(threadId);
    await thread.send({
      content: resultContent(job),
      embeds: [resultEmbed(job)],
      allowedMentions: { users: [job.requestedByDiscordId] },
    });
  }

  #tagIdsFor(job: Pick<JobDto, "type" | "status">): string[] {
    return tagNamesFor(job)
      .map((name) => this.#tagIds.get(name))
      .filter((id): id is string => Boolean(id));
  }

  async #forum(force = false): Promise<ForumChannel> {
    const channel = await this.#client.channels.fetch(this.#forumId, { force });
    if (channel?.type !== ChannelType.GuildForum) {
      throw new Error(`DISCORD_RESPONSES_FORUM_ID ${this.#forumId} is not a forum channel`);
    }
    return channel;
  }

  async #thread(threadId: string): Promise<ThreadChannel> {
    const channel = await this.#client.channels.fetch(threadId);
    if (!channel?.isThread()) throw new Error(`Thread ${threadId} not found`);
    return channel;
  }
}
