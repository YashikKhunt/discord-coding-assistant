import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export const PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface ModelSpec {
  provider: ProviderName;
  modelId: string;
  /** Canonical `provider:model` string, used as the pricing key. */
  spec: string;
}

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

/** Parses `anthropic:claude-sonnet-5` or `openrouter:vendor/model`. */
export function parseModelSpec(spec: string): ModelSpec {
  const index = spec.indexOf(":");
  const provider = spec.slice(0, index) as ProviderName;
  const modelId = spec.slice(index + 1);
  if (index <= 0 || !modelId || !PROVIDERS.includes(provider)) {
    throw new ModelConfigError(
      `Invalid model "${spec}"; expected <${PROVIDERS.join("|")}>:<model-id>`,
    );
  }
  return { provider, modelId, spec: `${provider}:${modelId}` };
}

export interface ProviderKeys {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

export type ModelResolver = (spec: ModelSpec) => LanguageModel;

const KEY_FOR: Record<ProviderName, keyof ProviderKeys> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function availableProviders(keys: ProviderKeys): ProviderName[] {
  return PROVIDERS.filter((provider) => Boolean(keys[KEY_FOR[provider]]));
}

/** Builds provider clients lazily from explicit keys (never read from process.env implicitly). */
export function createModelResolver(keys: ProviderKeys): ModelResolver {
  const anthropic = keys.ANTHROPIC_API_KEY
    ? createAnthropic({ apiKey: keys.ANTHROPIC_API_KEY })
    : null;
  const openai = keys.OPENAI_API_KEY ? createOpenAI({ apiKey: keys.OPENAI_API_KEY }) : null;
  const openrouter = keys.OPENROUTER_API_KEY
    ? createOpenRouter({ apiKey: keys.OPENROUTER_API_KEY })
    : null;

  return ({ provider, modelId }) => {
    const missing = () =>
      new ModelConfigError(`${KEY_FOR[provider]} is not set; cannot use ${provider}:${modelId}`);
    switch (provider) {
      case "anthropic":
        if (!anthropic) throw missing();
        return anthropic(modelId);
      case "openai":
        if (!openai) throw missing();
        return openai(modelId);
      case "openrouter":
        if (!openrouter) throw missing();
        // Usage accounting makes OpenRouter report the real cost of each call.
        return openrouter(modelId, { usage: { include: true } });
    }
  };
}
