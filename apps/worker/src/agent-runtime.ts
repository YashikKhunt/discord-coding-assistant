import type { AgentHooks } from "@dca/agent";
import { type Db, monthSpendUsd, recordLlmCall, recordToolCall } from "@dca/db";
import {
  availableProviders,
  createModelResolver,
  createStepModel,
  type ModelResolver,
  type ProviderKeys,
  parseModelSpec,
  type StepModel,
} from "@dca/llm";
import type { Profile } from "@dca/profiles";

/** What runners need to run LLM agents: models for a profile and persistence/budget hooks. */
export interface AgentRuntime {
  /** Primary then fallback models whose provider keys are configured; empty if none are. */
  modelsFor(profile: Profile): StepModel[];
  hooksFor(jobId: string): AgentHooks;
}

export interface AgentRuntimeOptions {
  db: Db;
  keys: ProviderKeys;
  monthlyCapUsd: number;
  resolver?: ModelResolver;
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const resolver = options.resolver ?? createModelResolver(options.keys);
  const providers = new Set(availableProviders(options.keys));

  return {
    modelsFor(profile) {
      return [profile.model.primary, profile.model.fallback]
        .filter((spec): spec is string => Boolean(spec))
        .map(parseModelSpec)
        .filter((spec) => options.resolver !== undefined || providers.has(spec.provider))
        .map((spec) => createStepModel(spec, resolver));
    },

    hooksFor(jobId) {
      return {
        async beforeStep() {
          const spent = await monthSpendUsd(options.db);
          return spent >= options.monthlyCapUsd
            ? `Monthly LLM budget of $${options.monthlyCapUsd} reached ($${spent.toFixed(2)} spent)`
            : null;
        },
        async onLlmCall({ step, response }) {
          return recordLlmCall(options.db, {
            jobId,
            step,
            provider: response.model.split(":")[0] ?? "unknown",
            model: response.model,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cachedTokens: response.usage.cacheReadTokens,
            costUsd: response.costUsd,
            latencyMs: response.latencyMs,
            response: {
              text: response.text,
              finishReason: response.finishReason,
              toolCalls: response.toolCalls,
              cacheWriteTokens: response.usage.cacheWriteTokens,
              priced: response.priced,
            },
          });
        },
        async onToolCall({ llmCallId, call, output, exitCode, durationMs }) {
          await recordToolCall(options.db, {
            jobId,
            llmCallId,
            name: call.name,
            args: call.input,
            output,
            exitCode,
            durationMs,
          });
        },
      };
    },
  };
}
