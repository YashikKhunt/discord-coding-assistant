import { createStepModel, parseModelSpec } from "@dca/llm";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentTool, runAgent } from "./loop.ts";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

// Regression for BUG-0001: the model sent `start_line: "375,477"` (a string) to read_file. The
// AI SDK added its own error tool-result for that call and the loop added a second one, so the
// provider rejected the next request with "each tool_use must have a single result".
describe("invalid tool input through the real AI SDK", () => {
  it("sends exactly one result per tool call and lets the model retry", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "toolu_bad",
              toolName: "read_file",
              input: JSON.stringify({ path: "chunker.py", start_line: "375,477" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          warnings: [],
        },
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "toolu_retry",
              toolName: "read_file",
              input: JSON.stringify({ path: "chunker.py", start_line: 375 }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          warnings: [],
        },
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "toolu_finish",
              toolName: "finish",
              input: JSON.stringify({ summary: "done" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          warnings: [],
        },
      ],
    });

    const reads: unknown[] = [];
    const readFile: AgentTool = {
      name: "read_file",
      description: "Read a file",
      inputSchema: z.object({ path: z.string(), start_line: z.number().int().optional() }),
      async execute(input) {
        reads.push(input);
        return { output: "375  def enforce_sequence(...):" };
      },
    };

    const outcome = await runAgent({
      models: [createStepModel(parseModelSpec("anthropic:claude-sonnet-5"), () => mock)],
      system: "sys",
      prompt: "investigate",
      tools: [readFile],
      finishSchema: z.object({ summary: z.string() }),
      finishDescription: "done",
      limits: { maxIterations: 10, deadline: Date.now() + 60_000, maxUsd: 1 },
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      reason: "finished",
      result: { summary: "done" },
      iterations: 3,
    });
    // The invalid call never reached the tool; the corrected retry did.
    expect(reads).toEqual([{ path: "chunker.py", start_line: 375 }]);

    for (const call of mock.doGenerateCalls.slice(1)) {
      const results = call.prompt.flatMap((message) =>
        message.role === "tool"
          ? message.content.filter((part) => part.type === "tool-result")
          : [],
      );
      const perCall = new Map<string, number>();
      for (const result of results) {
        perCall.set(result.toolCallId, (perCall.get(result.toolCallId) ?? 0) + 1);
      }
      expect(
        [...perCall.values()].every((count) => count === 1),
        JSON.stringify([...perCall]),
      ).toBe(true);
    }

    // The model is told what was wrong so it can fix its arguments.
    const secondPrompt = JSON.stringify(mock.doGenerateCalls[1]?.prompt);
    expect(secondPrompt).toContain("toolu_bad");
    expect(secondPrompt).toContain("start_line");
    expect(secondPrompt).toContain("Fix the arguments and call the tool again.");
  });
});
