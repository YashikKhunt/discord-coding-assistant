import type { JobDto } from "@dca/core";
import {
  createDb,
  createJob,
  type DbHandle,
  getJobById,
  jobEvents,
  jobs,
  toJobDto,
  transitionJob,
} from "@dca/db";
import { runMigrations } from "@dca/db/migrate";
import { and, eq, isNull, like } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ForumPublisher } from "./forum.ts";
import { Notifier } from "./notifier.ts";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const REPO_PREFIX = `notifier-test-${Date.now()}`;

class FakePublisher implements ForumPublisher {
  calls: string[] = [];
  failNextResult = false;
  #nextThread = 1;

  async createPost(job: JobDto) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.calls.push(`post:${job.shortId}`);
    return `thread-${this.#nextThread++}`;
  }
  async setTags(threadId: string, job: Pick<JobDto, "type" | "status" | "result">) {
    this.calls.push(`tags:${threadId}:${job.status}`);
  }
  async postResult(threadId: string, job: JobDto) {
    if (this.failNextResult) {
      this.failNextResult = false;
      throw new Error("discord 503");
    }
    this.calls.push(`result:${threadId}:${job.status}`);
  }
}

describe.skipIf(!DATABASE_URL)("notifier (integration)", () => {
  let handle: DbHandle;
  let publisher: FakePublisher;
  let notifier: Notifier;

  beforeAll(async () => {
    await runMigrations(DATABASE_URL as string);
    handle = createDb(DATABASE_URL as string);
  });

  beforeEach(async () => {
    // Test database only: start from an empty outbox.
    await handle.db
      .update(jobEvents)
      .set({ notifiedAt: new Date() })
      .where(isNull(jobEvents.notifiedAt));
    publisher = new FakePublisher();
    notifier = new Notifier(handle.db, publisher, pino({ level: "silent" }));
  });

  afterAll(async () => {
    await handle.db.delete(jobs).where(like(jobs.repo, `${REPO_PREFIX}/%`));
    await handle.close();
  });

  const enqueue = () =>
    createJob(handle.db, {
      type: "task",
      repo: `${REPO_PREFIX}/app`,
      input: { description: "do the thing" },
      requestedByDiscordId: "111111111111111111",
      profileId: "task",
      profileVersion: 1,
    });

  const pendingCount = async (jobId: string) =>
    (
      await handle.db
        .select()
        .from(jobEvents)
        .where(and(eq(jobEvents.jobId, jobId), isNull(jobEvents.notifiedAt)))
    ).length;

  it("creates one forum post even when the handler and notifier race", async () => {
    const job = await enqueue();
    const dto = toJobDto(job);
    const [a, b] = await Promise.all([notifier.ensurePost(dto), notifier.processOnce()]);
    expect(a).toBe("thread-1");
    expect(b).toBe(1);
    expect(publisher.calls.filter((call) => call.startsWith("post:"))).toHaveLength(1);
    expect((await getJobById(handle.db, job.id))?.discordForumThreadId).toBe("thread-1");
  });

  it("coalesces stale in-flight events and posts the final result once", async () => {
    const job = await enqueue();
    await transitionJob(handle.db, job.id, "preparing");
    await transitionJob(handle.db, job.id, "running");
    await transitionJob(handle.db, job.id, "finalizing");
    await transitionJob(handle.db, job.id, "succeeded", { result: { summary: "done" } });

    expect(await notifier.processOnce()).toBe(5);
    expect(publisher.calls).toEqual([
      `post:${job.shortId}`,
      "tags:thread-1:succeeded",
      "result:thread-1:succeeded",
    ]);
    expect(await pendingCount(job.id)).toBe(0);
    expect(await notifier.processOnce()).toBe(0);
  });

  it("retries failed deliveries on the next tick without skipping ahead", async () => {
    const job = await enqueue();
    await transitionJob(handle.db, job.id, "cancelled");
    publisher.failNextResult = true;

    expect(await notifier.processOnce()).toBe(1); // created delivered, cancelled failed
    expect(await pendingCount(job.id)).toBe(1);

    expect(await notifier.processOnce()).toBe(1);
    expect(publisher.calls.filter((call) => call.startsWith("result:"))).toEqual([
      "result:thread-1:cancelled",
    ]);
    expect(await pendingCount(job.id)).toBe(0);
  });
});
