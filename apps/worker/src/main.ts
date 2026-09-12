import { baseEnv, parseEnv, workerEnv } from "@dca/core";
import { createDb } from "@dca/db";
import { runMigrations } from "@dca/db/migrate";
import pino from "pino";
import { StubRunner } from "./runner.ts";
import { Worker } from "./worker.ts";

const env = parseEnv(baseEnv.extend(workerEnv.shape));
const log = pino({ level: env.LOG_LEVEL, base: { service: "worker" } });

await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL, { max: env.WORKER_CONCURRENCY + 4 });

const worker = new Worker({
  db,
  log,
  concurrency: env.WORKER_CONCURRENCY,
  runner: new StubRunner(),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log.info({ signal }, "shutting down");
    await worker.stop();
    await close();
    process.exit(0);
  });
}

await worker.start();
