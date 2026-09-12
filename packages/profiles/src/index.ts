import type { JobType } from "@dca/core";

export interface ProfileLimits {
  maxIterations: number;
  maxMinutes: number;
  maxUsd: number;
}

export interface Profile {
  id: JobType;
  version: number;
  model: { primary: string; fallback?: string };
  limits: ProfileLimits;
}

// Static until M3, when profiles move to YAML with prompts, tools and result schemas.
const PROFILES: Record<JobType, Profile> = {
  runtest: {
    id: "runtest",
    version: 1,
    model: { primary: "anthropic:claude-haiku-4-5" },
    limits: { maxIterations: 10, maxMinutes: 5, maxUsd: 0.3 },
  },
  bugreport: {
    id: "bugreport",
    version: 1,
    model: { primary: "anthropic:claude-sonnet-5" },
    limits: { maxIterations: 30, maxMinutes: 15, maxUsd: 1.5 },
  },
  task: {
    id: "task",
    version: 1,
    model: { primary: "anthropic:claude-sonnet-5" },
    limits: { maxIterations: 40, maxMinutes: 20, maxUsd: 2 },
  },
};

export function getProfile(type: JobType): Profile {
  return PROFILES[type];
}
