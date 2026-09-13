import type { AgentJobResult, JobDto } from "@dca/core";

export interface AgentJobEmbedParts {
  title: string;
  url?: string;
  description: string;
  color: number;
  fields: { name: string; value: string; inline?: boolean }[];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function agentJobHeadline(job: Pick<JobDto, "status">, result: AgentJobResult): string {
  switch (result.outcome) {
    case "pr_opened":
      return `PR #${result.prNumber} ready for review`;
    case "draft_pr":
      return job.status === "partial"
        ? `draft PR #${result.prNumber} · stopped early`
        : `draft PR #${result.prNumber}`;
    case "no_changes":
      return "no changes made";
    case "rejected":
      return "changes blocked by safety checks";
    case "error":
      return job.status === "cancelled" ? "cancelled" : "failed";
  }
}

const STYLE: Record<AgentJobResult["outcome"], { emoji: string; color: number }> = {
  pr_opened: { emoji: "🟩", color: 0x2ecc71 },
  draft_pr: { emoji: "🟨", color: 0xf1c40f },
  no_changes: { emoji: "⬜", color: 0x95a5a6 },
  rejected: { emoji: "🟥", color: 0xe74c3c },
  error: { emoji: "🟥", color: 0xe74c3c },
};

export function agentJobEmbedParts(
  job: Pick<JobDto, "shortId" | "status" | "error">,
  result: AgentJobResult,
): AgentJobEmbedParts {
  const style = STYLE[result.outcome];
  const lines: string[] = [];
  if (result.title) lines.push(`**${clip(result.title, 200)}**`);
  if (result.summary) lines.push(clip(result.summary, 1_800));
  if (result.outcome === "error" && job.error && job.error !== result.summary) {
    lines.push(`**Error:** ${clip(job.error, 500)}`);
  }
  if (result.violations.length) {
    lines.push(
      "**Blocked because:**",
      ...result.violations.slice(0, 8).map((v) => `• ${clip(v, 200)}`),
    );
  }
  if (result.notes.length)
    lines.push("", ...result.notes.slice(0, 6).map((note) => `_${clip(note, 200)}_`));

  const fields: AgentJobEmbedParts["fields"] = [];
  if (result.filesChanged) {
    fields.push({
      name: "Files changed",
      value: `${result.filesChanged} (+${result.insertions} −${result.deletions})`,
      inline: true,
    });
  }
  if (result.tests.command || result.tests.summary !== "not run") {
    const icon = result.tests.passed === true ? "✅" : result.tests.passed === false ? "❌" : "➖";
    fields.push({
      name: "Tests",
      value: `${icon} ${clip(result.tests.summary, 200)}`,
      inline: true,
    });
  }
  if (result.reproduced !== null) {
    fields.push({ name: "Reproduced", value: result.reproduced ? "yes" : "no", inline: true });
  }
  if (result.branch && result.prUrl) {
    fields.push({ name: "Branch", value: `\`${clip(result.branch, 200)}\`` });
  }

  return {
    title: clip(`${style.emoji} ${job.shortId} · ${agentJobHeadline(job, result)}`, 256),
    url: result.prUrl ?? undefined,
    description: clip(lines.join("\n"), 4_000),
    color: style.color,
    fields,
  };
}
