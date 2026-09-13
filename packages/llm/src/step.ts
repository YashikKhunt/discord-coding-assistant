import { APICallError, generateText, isStepCount, type ModelMessage, type ToolSet, tool } from "ai";
import type { z } from "zod";
import type { ModelResolver, ModelSpec } from "./models.ts";
import { costUsd, priceFor, type TokenUsage } from "./pricing.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export interface StepRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export interface StepToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Set when the model produced input that failed schema validation or named an unknown tool. */
  invalidReason?: string;
}

export interface StepResponse {
  model: string;
  text: string;
  toolCalls: StepToolCall[];
  finishReason: string;
  usage: TokenUsage;
  costUsd: number;
  /** False when neither a price table entry nor provider-reported cost was available. */
  priced: boolean;
  latencyMs: number;
  /** Assistant messages to append to the conversation; tool results are the caller's job. */
  responseMessages: ModelMessage[];
}

/** One model call with tools exposed but not executed; the agent loop runs the tools. */
export interface StepModel {
  readonly spec: string;
  step(request: StepRequest): Promise<StepResponse>;
}

/** Errors worth retrying on a different model (rate limits, overload, provider outages). */
export function isProviderOutage(error: unknown): boolean {
  const cause = (error as { lastError?: unknown }).lastError ?? error;
  if (APICallError.isInstance(cause)) {
    return cause.isRetryable || (cause.statusCode !== undefined && cause.statusCode >= 500);
  }
  return false;
}

function withCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1] as ModelMessage;
  // Anthropic caches the whole prefix (tools, system, history) up to this marker; other
  // providers ignore the option.
  const marked = {
    ...last,
    providerOptions: {
      ...last.providerOptions,
      anthropic: { ...last.providerOptions?.anthropic, cacheControl: { type: "ephemeral" } },
    },
  } as ModelMessage;
  return [...messages.slice(0, -1), marked];
}

function reportedCost(providerMetadata: unknown): number | null {
  const cost = (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)
    ?.openrouter?.usage?.cost;
  return typeof cost === "number" ? cost : null;
}

export function createStepModel(spec: ModelSpec, resolve: ModelResolver): StepModel {
  return {
    spec: spec.spec,
    async step(request) {
      const model = resolve(spec);
      const tools: ToolSet = Object.fromEntries(
        request.tools.map((definition) => [
          definition.name,
          tool({ description: definition.description, inputSchema: definition.inputSchema }),
        ]),
      );
      const started = Date.now();
      const result = await generateText({
        model,
        system: request.system,
        messages: withCacheBreakpoint(request.messages),
        tools,
        stopWhen: isStepCount(1),
        maxOutputTokens: request.maxOutputTokens ?? 16_000,
        abortSignal: request.signal,
      });

      const cacheRead = result.usage.inputTokenDetails?.cacheReadTokens ?? 0;
      const cacheWrite = result.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
      const usage: TokenUsage = {
        inputTokens:
          result.usage.inputTokenDetails?.noCacheTokens ??
          Math.max(0, (result.usage.inputTokens ?? 0) - cacheRead - cacheWrite),
        outputTokens: result.usage.outputTokens ?? 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      };
      const { price, known } = priceFor(spec.spec);
      const reported = reportedCost(result.providerMetadata);

      const toolCalls: StepToolCall[] = result.toolCalls.map((call) => {
        const invalid = call as { invalid?: boolean; error?: unknown };
        return {
          id: call.toolCallId,
          name: call.toolName,
          input: call.input,
          invalidReason: invalid.invalid
            ? String((invalid.error as Error | undefined)?.message ?? "invalid tool input")
            : undefined,
        };
      });

      return {
        model: spec.spec,
        text: result.text,
        toolCalls,
        finishReason: result.finishReason,
        usage,
        costUsd: reported ?? costUsd(price, usage),
        priced: reported !== null || known,
        latencyMs: Date.now() - started,
        // For invalid tool input (bad JSON, schema mismatch, unknown tool) the SDK appends its own
        // `tool` message with an error result. The agent loop answers every tool call itself, so
        // keeping the SDK's copy would send two results for one call and the provider rejects
        // the next request ("each tool_use must have a single result").
        responseMessages: (result.responseMessages as ModelMessage[]).filter(
          (message) => message.role !== "tool",
        ),
      };
    },
  };
}
