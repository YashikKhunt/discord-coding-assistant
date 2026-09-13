import { describe, expect, it } from "vitest";
import { commandDefinitions } from "./definitions.ts";

describe("slash command definitions", () => {
  it("serialize to valid Discord payloads", () => {
    const payloads = commandDefinitions.map((command) => command.toJSON());
    expect(payloads.map((payload) => payload.name)).toEqual([
      "task",
      "bugreport",
      "runtest",
      "status",
      "cancel",
      "jobs",
    ]);
    const task = payloads[0];
    expect(task?.options?.map((option) => option.name)).toEqual([
      "repo",
      "description",
      "base",
      "attachment1",
      "attachment2",
      "attachment3",
    ]);
    const bugreport = payloads[1];
    expect(bugreport?.options?.map((option) => option.name)).toContain("base");
  });
});
