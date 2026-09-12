import { isTerminal, JOB_STATUSES, type JobDto, type JobStatus } from "@dca/core";
import {
  type Db,
  fetchPendingEvents,
  getJobById,
  markEventsNotified,
  setDiscordThread,
  toJobDto,
} from "@dca/db";
import type { Logger } from "pino";
import type { ForumPublisher } from "./forum.ts";

const GIVE_UP_AFTER_MS = 60 * 60 * 1000;

function statusFromEvent(type: string): JobStatus | null {
  if (!type.startsWith("status.")) return null;
  const status = type.slice("status.".length);
  return (JOB_STATUSES as readonly string[]).includes(status) ? (status as JobStatus) : null;
}

/**
 * Delivers `job_events` to the Discord forum (transactional outbox). Events stay
 * un-notified until Discord accepts them, so outages only delay delivery.
 */
export class Notifier {
  readonly #db: Db;
  readonly #publisher: ForumPublisher;
  readonly #log: Logger;
  readonly #postLocks = new Map<string, Promise<string>>();
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;

  constructor(db: Db, publisher: ForumPublisher, log: Logger) {
    this.#db = db;
    this.#publisher = publisher;
    this.#log = log;
  }

  start(intervalMs = 2_000): void {
    const tick = () => {
      this.#running = this.processOnce()
        .then(() => {})
        .catch((err) => this.#log.error({ err }, "notifier tick failed"))
        .finally(() => {
          this.#running = null;
          if (this.#timer) this.#timer = setTimeout(tick, intervalMs);
        });
    };
    this.#timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  /**
   * Returns the job's forum thread, creating it at most once even when the command
   * handler and the notifier race for the same job.
   */
  ensurePost(job: JobDto): Promise<string> {
    if (job.discordForumThreadId) return Promise.resolve(job.discordForumThreadId);
    const inFlight = this.#postLocks.get(job.id);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const fresh = await getJobById(this.#db, job.id);
      if (fresh?.discordForumThreadId) return fresh.discordForumThreadId;
      const threadId = await this.#publisher.createPost(fresh ? toJobDto(fresh) : job);
      await setDiscordThread(this.#db, job.id, { threadId });
      return threadId;
    })().finally(() => this.#postLocks.delete(job.id));

    this.#postLocks.set(job.id, promise);
    return promise;
  }

  async processOnce(limit = 50): Promise<number> {
    const pending = await fetchPendingEvents(this.#db, limit);
    const blockedJobs = new Set<string>();
    let delivered = 0;

    for (const { event, job } of pending) {
      if (blockedJobs.has(job.id)) continue; // keep per-job ordering after a failure
      const dto = toJobDto(job);
      try {
        const threadId = await this.ensurePost(dto);
        const status = statusFromEvent(event.type);

        if (status && isTerminal(status)) {
          // Tags first: they are idempotent, so a retry after a failed post never double-posts.
          await this.#publisher.setTags(threadId, dto);
          await this.#publisher.postResult(threadId, dto);
        } else if (status && status === job.status) {
          // Only touch tags for the job's current state; stale in-flight events are coalesced.
          await this.#publisher.setTags(threadId, dto);
        }

        await markEventsNotified(this.#db, [event.id]);
        delivered++;
      } catch (err) {
        const ageMs = Date.now() - event.createdAt.getTime();
        if (ageMs > GIVE_UP_AFTER_MS) {
          this.#log.error({ err, eventId: event.id, shortId: job.shortId }, "dropping event");
          await markEventsNotified(this.#db, [event.id]);
        } else {
          this.#log.warn({ err, eventId: event.id, shortId: job.shortId }, "delivery failed");
          blockedJobs.add(job.id);
        }
      }
    }
    return delivered;
  }
}
