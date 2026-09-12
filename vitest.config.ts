import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    environment: "node",
    // Integration tests share one Postgres database and a single job queue.
    fileParallelism: false,
  },
});
