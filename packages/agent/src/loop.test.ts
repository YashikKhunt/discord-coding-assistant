import type { StepModel, StepRequest, StepResponse, StepToolCall } from "@dca/llm";
import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentTool, clipOutput, compactToolResults, runAgent } from "./loop.ts";

type Script = (request: StepRequest, call: number) => Partial<StepResponse> | Error;

function scripted(spec: string, script: Script): StepModel & { requests: StepRequest[] } {
  const requests: StepRequest[] = [];
  return {
    spec,
    requests,
    async step(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const out = script(request, requests.length);
      if (out instanceof Error) throw out;
      const toolCalls = out.toolCalls ?? [];
      return {
        model: spec,
        text: out.text ?? "",
        toolCalls,
        finishReason: toolCalls.length ? "tool-calls" : "stop",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: out.costUsd ?? 0.01,
        priced: true,
        latencyMs: 1,
        responseMessages: [
          {
            role: "assistant",
            content: toolCalls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            })),
          },
        ],
        ...out,
      };
    },
  };
}

const call = (name: string, input: unknown, id = `${name}-${Math.random()}`): StepToolCall => ({
  id,
  name,
  input,
});

const echo: AgentTool = {
  name: "echo",
  description: "echo",
  inputSchema: z.object({ text: z.string() }),
  async execute(input) {
    return { output: `echo:${(input as { text: string }).text}` };
  },
};

const finishSchema = z.object({ likelyCause: z.string() });
const base = {
  system: "sys",
  prompt: "go",
  tools: [echo],
  finishSchema,
  finishDescription: "done",
  signal: new AbortController().signal,
};
const limits = (overrides = {}) => ({
  maxIterations: 10,
  deadline: Date.now() + 60_000,
  maxUsd: 1,
  ...overrides,
});

describe("runAgent", () => {
  it("executes tools, feeds results back, and returns the finish result", async () => {
    const model = scripted("m", (_request, n) =>
      n === 1
        ? { toolCalls: [call("echo", { text: "hi" }, "c1")] }
        : { toolCalls: [call("finish", { likelyCause: "null check" })] },
    );
    const llm: number[] = [];
    const tools: string[] = [];
    const outcome = await runAgent({
      ...base,
      models: [model],
      limits: limits(),
      hooks: {
        onLlmCall: async ({ step }) => {
          llm.push(step);
          return step * 100;
        },
        onToolCall: async ({ call: c, output, llmCallId }) => {
          tools.push(`${c.name}:${output}:${llmCallId}`);
        },
      },
    });

    expect(outcome).toMatchObject({
      reason: "finished",
      result: { likelyCause: "null check" },
      iterations: 2,
      modelUsed: "m",
    });
    expect(outcome.costUsd).toBeCloseTo(0.02);
    expect(llm).toEqual([1, 2]);
    expect(tools).toEqual(["echo:echo:hi:100"]);
    const second = model.requests[1]?.messages ?? [];
    expect(second.at(-1)).toMatchObject({
      role: "tool",
      content: [{ toolCallId: "c1", output: { type: "text", value: "echo:hi" } }],
    });
  });

  it("returns errors for invalid input, unknown tools and bad finish payloads", async () => {
    const model = scripted("m", (_request, n) => {
      if (n === 1) {
        return {
          toolCalls: [
            { ...call("echo", {}), invalidReason: "text is required" },
            call("nope", {}),
            call("finish", { wrong: true }),
          ],
        };
      }
      return { toolCalls: [call("finish", { likelyCause: "x" })] };
    });
    const outcome = await runAgent({ ...base, models: [model], limits: limits() });
    expect(outcome.reason).toBe("finished");
    const results = model.requests[1]?.messages.at(-1);
    expect(JSON.stringify(results)).toContain("error-text");
    expect(JSON.stringify(results)).toContain("Unknown tool nope");
    expect(JSON.stringify(results)).toContain("Invalid finish input");
  });

  it("stops at the iteration limit and warns before the last step", async () => {
    const model = scripted("m", () => ({ toolCalls: [call("echo", { text: "loop" })] }));
    const outcome = await runAgent({
      ...base,
      models: [model],
      limits: limits({ maxIterations: 3 }),
    });
    expect(outcome).toMatchObject({ reason: "max_iterations", iterations: 3 });
    expect(JSON.stringify(model.requests[2]?.messages.at(-1))).toContain("one step left");
  });

  it("stops when the spend budget is used up", async () => {
    const model = scripted("m", () => ({ toolCalls: [call("echo", { text: "$" })], costUsd: 0.2 }));
    const outcome = await runAgent({ ...base, models: [model], limits: limits({ maxUsd: 0.5 }) });
    expect(outcome).toMatchObject({ reason: "budget", iterations: 3 });
    expect(outcome.costUsd).toBeCloseTo(0.6);
  });

  it("honours the deadline, abort signal and beforeStep blocks", async () => {
    const model = scripted("m", () => ({ toolCalls: [call("echo", { text: "t" })] }));
    expect(
      (await runAgent({ ...base, models: [model], limits: limits({ deadline: Date.now() - 1 }) }))
        .reason,
    ).toBe("timeout");

    const controller = new AbortController();
    controller.abort();
    expect(
      (await runAgent({ ...base, signal: controller.signal, models: [model], limits: limits() }))
        .reason,
    ).toBe("aborted");

    const blocked = await runAgent({
      ...base,
      models: [model],
      limits: limits(),
      hooks: { beforeStep: async ({ step }) => (step === 2 ? "monthly cap reached" : null) },
    });
    expect(blocked).toMatchObject({
      reason: "blocked",
      detail: "monthly cap reached",
      iterations: 1,
    });
  });

  it("falls back to the next model on provider outages only", async () => {
    const outage = new APICallError({
      message: "overloaded",
      url: "x",
      requestBodyValues: {},
      statusCode: 529,
      isRetryable: true,
    });
    const primary = scripted("primary", () => outage);
    const fallback = scripted("fallback", () => ({
      toolCalls: [call("finish", { likelyCause: "via fallback" })],
    }));
    const outcome = await runAgent({ ...base, models: [primary, fallback], limits: limits() });
    expect(outcome).toMatchObject({ reason: "finished", modelUsed: "fallback", iterations: 1 });

    const broken = scripted("primary", () => new Error("400 bad request"));
    await expect(
      runAgent({ ...base, models: [broken, fallback], limits: limits() }),
    ).rejects.toThrow("400 bad request");
  });

  it("nudges once when the model answers without tools", async () => {
    const model = scripted("m", (_request, n) =>
      n === 1 ? { text: "I think it is X" } : { text: "still no tools" },
    );
    const outcome = await runAgent({ ...base, models: [model], limits: limits() });
    expect(outcome).toMatchObject({
      reason: "no_tool_call",
      iterations: 2,
      lastText: "still no tools",
    });
  });
});

describe("context helpers", () => {
  it("clips long outputs keeping head and tail", () => {
    const clipped = clipOutput(`${"a".repeat(100)}${"b".repeat(100)}`, 20);
    expect(clipped.startsWith("a".repeat(10))).toBe(true);
    expect(clipped.endsWith("b".repeat(10))).toBe(true);
    expect(clipped).toContain("180 characters omitted");
  });

  it("elides all but the most recent tool results", () => {
    const tool = (value: string) => ({
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: value,
          toolName: "t",
          output: { type: "text" as const, value },
        },
      ],
    });
    const compacted = compactToolResults(
      [{ role: "user", content: "go" }, tool("one"), tool("two"), tool("three")],
      1,
    );
    expect(JSON.stringify(compacted)).not.toContain('"value":"one"');
    expect(JSON.stringify(compacted)).not.toContain('"value":"two"');
    expect(JSON.stringify(compacted)).toContain('"value":"three"');
  });
});
