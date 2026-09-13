import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { availableProviders, ModelConfigError, parseModelSpec } from "./models.ts";
import { costUsd, PRICES, priceFor } from "./pricing.ts";
import { createStepModel, isProviderOutage } from "./step.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: { total: input + cacheRead + cacheWrite, noCache: input, cacheRead, cacheWrite },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

describe("model specs and pricing", () => {
  it("parses provider:model specs", () => {
    expect(parseModelSpec("anthropic:claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      spec: "anthropic:claude-haiku-4-5",
    });
    expect(parseModelSpec("openrouter:qwen/qwen3-coder").modelId).toBe("qwen/qwen3-coder");
    expect(() => parseModelSpec("claude-haiku-4-5")).toThrow(ModelConfigError);
    expect(() => parseModelSpec("gemini:pro")).toThrow(ModelConfigError);
  });

  it("prices cached and uncached tokens", () => {
    const haiku = PRICES["anthropic:claude-haiku-4-5"];
    if (!haiku) throw new Error("missing price");
    // 1M uncached in ($1) + 1M out ($5) + 1M cache read ($0.10) + 1M cache write ($1.25)
    expect(
      costUsd(haiku, {
        inputTokens: 1e6,
        outputTokens: 1e6,
        cacheReadTokens: 1e6,
        cacheWriteTokens: 1e6,
      }),
    ).toBeCloseTo(7.35, 5);
    expect(priceFor("openai:unknown-model").known).toBe(false);
  });

  it("lists providers with keys", () => {
    expect(availableProviders({ ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "" })).toEqual([
      "anthropic",
    ]);
  });
});

describe("createStepModel", () => {
  it("returns tool calls without executing them, with usage and cost", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: {
        content: [
          { type: "text", text: "Reading the failing test." },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "read_file",
            input: JSON.stringify({ path: "src/a.ts" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: usage(1_000, 200, 5_000, 0),
        warnings: [],
      },
    });
    const model = createStepModel(parseModelSpec("anthropic:claude-haiku-4-5"), () => mock);

    const response = await model.step({
      system: "You analyse test failures.",
      messages: [{ role: "user", content: "Why did it fail?" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: z.object({ path: z.string() }),
        },
      ],
    });

    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "read_file", input: { path: "src/a.ts" }, invalidReason: undefined },
    ]);
    expect(response.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 0,
    });
    // $1/M * 1000 + $5/M * 200 + $0.10/M * 5000
    expect(response.costUsd).toBeCloseTo(0.0025, 6);
    expect(response.priced).toBe(true);
    expect(response.responseMessages.at(-1)?.role).toBe("assistant");

    const prompt = mock.doGenerateCalls[0]?.prompt ?? [];
    expect(prompt.at(-1)?.providerOptions?.anthropic).toMatchObject({
      cacheControl: { type: "ephemeral" },
    });
  });

  it("flags schema-invalid tool input instead of throwing", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: {
        content: [
          { type: "tool-call", toolCallId: "c", toolName: "read_file", input: '{"file": 1}' },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: usage(10, 10),
        warnings: [],
      },
    });
    const model = createStepModel(parseModelSpec("anthropic:claude-haiku-4-5"), () => mock);
    const response = await model.step({
      system: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [{ name: "read_file", description: "d", inputSchema: z.object({ path: z.string() }) }],
    });
    expect(response.toolCalls[0]?.invalidReason).toBeTruthy();
  });

  it("classifies provider outages", () => {
    const outage = new APICallError({
      message: "overloaded",
      url: "x",
      requestBodyValues: {},
      statusCode: 529,
      isRetryable: true,
    });
    const badRequest = new APICallError({
      message: "bad",
      url: "x",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    expect(isProviderOutage(outage)).toBe(true);
    expect(isProviderOutage(badRequest)).toBe(false);
    expect(isProviderOutage(new Error("boom"))).toBe(false);
  });
});
