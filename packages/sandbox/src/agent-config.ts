import { parse } from "yaml";
import { z } from "zod";

/** Optional `.agent.yml` in the target repository. Everything is optional; detection fills gaps. */
export const agentConfigSchema = z
  .object({
    image: z.enum(["node", "python"]).optional(),
    install: z.string().min(1).max(2000).optional(),
    test: z.string().min(1).max(2000).optional(),
    testReport: z
      .string()
      .regex(/^[\w./-]+$/, "must be a relative path")
      .refine((value) => !value.split("/").includes(".."), "must stay inside the repo")
      .optional(),
    envFile: z.string().max(200).optional(),
    network: z
      .object({
        extraHosts: z
          .array(z.string().regex(/^[\w.-]+$/))
          .max(20)
          .default([]),
      })
      .optional(),
    instructions: z.string().max(4000).optional(),
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

export function parseAgentConfig(source: string): AgentConfig {
  let raw: unknown;
  try {
    raw = parse(source) ?? {};
  } catch (error) {
    throw new AgentConfigError(`.agent.yml is not valid YAML: ${(error as Error).message}`);
  }
  const result = agentConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AgentConfigError(`.agent.yml is invalid: ${issues}`);
  }
  return result.data;
}
