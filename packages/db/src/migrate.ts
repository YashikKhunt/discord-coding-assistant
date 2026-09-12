import { fileURLToPath } from "node:url";
import { baseEnv, parseEnv } from "@dca/core";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.ts";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await handle.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DATABASE_URL } = parseEnv(baseEnv.pick({ DATABASE_URL: true }));
  await runMigrations(DATABASE_URL);
  console.log("Migrations applied");
}
