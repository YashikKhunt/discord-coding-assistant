import {
  isProviderOutage,
  type StepModel,
  type StepResponse,
  type StepToolCall,
  type ToolDefinition,
} from "@dca/llm";
import type { ModelMessage, UserModelMessage } from "ai";
import type { z } from "zod";

export interface AgentTool<Input = unknown> extends ToolDefinition {
  execute(input: Input, signal: AbortSignal): Promise<ToolOutput>;
}

export interface ToolOutput {
  output: string;
  exitCode?: number;
  isError?: boolean;
}

export interface AgentLimits {
  maxIterations: number;
  /** Absolute wall-clock deadline (ms since epoch). */
  deadline: number;
  maxUsd: number;
}

export interface LlmCallRecord {
  step: number;
  response: StepResponse;
}

export interface ToolCallRecord {
  step: number;
  llmCallId: number | null;
  call: StepToolCall;
  output: string;
  exitCode: number | null;
  durationMs: number;
}

export interface AgentHooks {
  /** Persist a model call; returns its id for linking tool calls. */
  onLlmCall?(record: LlmCallRecord): Promise<number | null>;
  onToolCall?(record: ToolCallRecord): Promise<void>;
  /** Return a reason to stop before the next model call (e.g. monthly spend cap reached). */
  beforeStep?(state: { step: number; costUsd: number }): Promise<string | null>;
}

export interface RunAgentOptions<Result> {
  models: StepModel[];
  system: string;
  prompt: UserModelMessage["content"];
  tools: AgentTool[];
  /** The model ends the run by calling `finish` with input matching this schema. */
  finishSchema: z.ZodType<Result>;
  finishDescription: string;
  limits: AgentLimits;
  signal: AbortSignal;
  hooks?: AgentHooks;
  /** Characters kept from each tool output (head + tail). */
  maxToolOutputChars?: number;
  /** When the last call's input exceeds this many tokens, older tool outputs are elided. */
  compactAboveInputTokens?: number;
}

export type AgentStopReason =
  | "finished"
  | "max_iterations"
  | "timeout"
  | "budget"
  | "aborted"
  | "no_tool_call"
  | "blocked";

export interface AgentOutcome<Result> {
  reason: AgentStopReason;
  result: Result | null;
  detail?: string;
  iterations: number;
  costUsd: number;
  modelUsed: string | null;
  lastText: string;
}

const FINISH = "finish";

export function clipOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n… [${text.length - maxChars} characters omitted] …\n${text.slice(-half)}`;
}

/** Replaces the output of all but the most recent tool results with a short placeholder. */
export function compactToolResults(messages: ModelMessage[], keepLast: number): ModelMessage[] {
  const toolIndexes = messages.flatMap((message, index) =>
    message.role === "tool" ? [index] : [],
  );
  const elide = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepLast)));
  return messages.map((message, index) => {
    if (!elide.has(index) || message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-result"
          ? {
              ...part,
              output: {
                type: "text" as const,
                value: "[older tool output elided to save context]",
              },
            }
          : part,
      ),
    };
  });
}

/**
 * Our own tool loop: one model call per iteration, tools executed here, hard limits on
 * iterations, wall-clock time and spend checked before every call.
 */
export async function runAgent<Result>(
  options: RunAgentOptions<Result>,
): Promise<AgentOutcome<Result>> {
  const {
    limits,
    signal,
    hooks,
    maxToolOutputChars = 12_000,
    compactAboveInputTokens = 120_000,
  } = options;
  if (options.models.length === 0) throw new Error("runAgent needs at least one model");

  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const definitions: ToolDefinition[] = [
    ...options.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    { name: FINISH, description: options.finishDescription, inputSchema: options.finishSchema },
  ];

  let messages: ModelMessage[] = [{ role: "user", content: options.prompt }];
  let modelIndex = 0;
  let costUsd = 0;
  let lastText = "";
  let modelUsed: string | null = null;
  let nudged = false;
  let iterations = 0;

  const outcome = (reason: AgentStopReason, result: Result | null = null, detail?: string) => ({
    reason,
    result,
    detail,
    iterations,
    costUsd,
    modelUsed,
    lastText,
  });

  while (true) {
    if (signal.aborted) return outcome("aborted");
    if (iterations >= limits.maxIterations) return outcome("max_iterations");
    if (Date.now() >= limits.deadline) return outcome("timeout");
    if (costUsd >= limits.maxUsd) return outcome("budget");
    const blocked = await hooks?.beforeStep?.({ step: iterations + 1, costUsd });
    if (blocked) return outcome("blocked", null, blocked);

    iterations++;
    const step = iterations;
    const isLast = step === limits.maxIterations;
    const timeLeft = limits.deadline - Date.now();
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1_000, timeLeft))]);

    let response: StepResponse;
    try {
      response = await (options.models[modelIndex] as StepModel).step({
        system: options.system,
        messages,
        tools: definitions,
        signal: callSignal,
      });
    } catch (error) {
      if (signal.aborted) return outcome("aborted");
      if (callSignal.aborted) return outcome("timeout");
      if (isProviderOutage(error) && modelIndex < options.models.length - 1) {
        modelIndex++;
        iterations--; // the failed call produced nothing; retry this step on the fallback model
        continue;
      }
      throw error;
    }

    costUsd += response.costUsd;
    modelUsed = response.model;
    if (response.text) lastText = response.text;
    const llmCallId = (await hooks?.onLlmCall?.({ step, response })) ?? null;
    messages = [...messages, ...response.responseMessages];

    if (response.toolCalls.length === 0) {
      if (nudged || isLast) return outcome("no_tool_call");
      nudged = true;
      messages.push({
        role: "user",
        content: `Continue using the tools. When you are done, call \`${FINISH}\` with your result.`,
      });
      continue;
    }

    const finishCall = response.toolCalls.find(
      (call) => call.name === FINISH && !call.invalidReason,
    );
    if (finishCall) {
      const parsed = options.finishSchema.safeParse(finishCall.input);
      if (parsed.success) return outcome("finished", parsed.data);
    }

    // Tool calls that already carry a result in the model's response must not get a second one:
    // providers reject a tool_use with more than one tool_result.
    const answered = new Set<string>();
    for (const message of response.responseMessages) {
      if (typeof message.content === "string") continue;
      for (const part of message.content) {
        if (part.type === "tool-result") answered.add(part.toolCallId);
      }
    }

    // Execute every call and return all results in one message so parallel calls stay paired.
    const results = [];
    for (const call of response.toolCalls) {
      if (answered.has(call.id)) continue;
      const started = Date.now();
      let result: ToolOutput;
      const tool = toolsByName.get(call.name);
      if (call.invalidReason) {
        const reason = call.invalidReason.startsWith("Invalid input")
          ? call.invalidReason
          : `Invalid input for ${call.name}: ${call.invalidReason}`;
        result = { output: `${reason}\nFix the arguments and call the tool again.`, isError: true };
      } else if (call.name === FINISH) {
        const parsed = options.finishSchema.safeParse(call.input);
        result = {
          output: parsed.success ? "ok" : `Invalid finish input: ${parsed.error.message}`,
          isError: !parsed.success,
        };
      } else if (!tool) {
        result = { output: `Unknown tool ${call.name}`, isError: true };
      } else {
        try {
          result = await tool.execute(call.input, callSignal);
        } catch (error) {
          if (signal.aborted) return outcome("aborted");
          result = { output: `Tool failed: ${(error as Error).message}`, isError: true };
        }
      }
      const output = clipOutput(result.output, maxToolOutputChars);
      await hooks?.onToolCall?.({
        step,
        llmCallId,
        call,
        output,
        exitCode: result.exitCode ?? null,
        durationMs: Date.now() - started,
      });
      results.push({
        type: "tool-result" as const,
        toolCallId: call.id,
        toolName: call.name,
        output: result.isError
          ? { type: "error-text" as const, value: output }
          : { type: "text" as const, value: output },
      });
    }
    if (results.length) messages.push({ role: "tool", content: results });

    const inputTokens =
      response.usage.inputTokens + response.usage.cacheReadTokens + response.usage.cacheWriteTokens;
    if (inputTokens > compactAboveInputTokens) messages = compactToolResults(messages, 4);

    if (step === limits.maxIterations - 1) {
      messages.push({
        role: "user",
        content: `You have one step left. Call \`${FINISH}\` now with your best result so far.`,
      });
    }
  }
}
