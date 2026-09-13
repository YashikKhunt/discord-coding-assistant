import type { JobDto, RuntestResult } from "@dca/core";

export interface RuntestEmbedParts {
  title: string;
  description: string;
  color: number;
  fields: { name: string; value: string; inline?: boolean }[];
  footer: string;
}

const MAX_FAILURES_SHOWN = 10;

const OUTCOME = {
  passed: { emoji: "🟩", color: 0x2ecc71, word: "tests passed" },
  failed: { emoji: "🟥", color: 0xe74c3c, word: "tests failed" },
  error: { emoji: "⬛", color: 0x95a5a6, word: "could not run tests" },
} as const;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function seconds(ms: number): string {
  const total = Math.round(ms / 1000);
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

function codeBlock(text: string, max: number): string {
  const safe = text.replaceAll("```", "ʼʼʼ");
  return `\`\`\`\n${clip(safe, max)}\n\`\`\``;
}

export function runtestWord(result: RuntestResult): string {
  return OUTCOME[result.outcome].word;
}

export function runtestEmbedParts(job: JobDto, result: RuntestResult): RuntestEmbedParts {
  const style = OUTCOME[result.outcome];
  const sha = result.commit ? ` (${result.commit.slice(0, 7)})` : "";
  const title = clip(`${style.emoji} ${job.shortId} · ${job.repo} @ ${result.ref}${sha}`, 256);

  const fields: RuntestEmbedParts["fields"] = [];
  const lines: string[] = [];

  if (result.tests) {
    fields.push(
      { name: "Passed", value: String(result.tests.passed), inline: true },
      { name: "Failed", value: String(result.tests.failed), inline: true },
      { name: "Skipped", value: String(result.tests.skipped), inline: true },
    );
    const failures = result.tests.failures.slice(0, MAX_FAILURES_SHOWN);
    for (const failure of failures) {
      const firstLines = failure.message.split("\n").slice(0, 3).join("\n");
      lines.push(`❌ **${clip(failure.name, 180)}**`, codeBlock(firstLines, 300));
    }
    const hidden = result.tests.failed - failures.length;
    if (hidden > 0) lines.push(`…and ${hidden} more (see attached log)`);
  } else {
    lines.push(result.summary);
  }

  if (result.analysis) {
    const { likelyCause, confidence, suggestedFix, relevantFiles } = result.analysis;
    lines.push("", `**Likely cause** · ${confidence} confidence`, clip(likelyCause, 700));
    if (suggestedFix) lines.push(`**Suggested fix:** ${clip(suggestedFix, 500)}`);
    if (relevantFiles.length) {
      lines.push(
        relevantFiles
          .slice(0, 5)
          .map((file) => `\`${clip(file, 120)}\``)
          .join(" · "),
      );
    }
  } else if (result.analysisNote && result.outcome === "failed") {
    lines.push("", `_${clip(result.analysisNote, 200)}_`);
  }

  if (result.outcome === "error" && result.tests) lines.unshift(result.summary);
  if (result.outcome === "error" && result.logTail) {
    lines.push("**Last output**", codeBlock(result.logTail.slice(-1200), 1200));
  }

  const footer = [
    result.stack,
    result.exitCode === null ? null : `exit ${result.exitCode}`,
    seconds(result.durationMs),
    result.tests?.source === "output" ? "parsed from output" : null,
    result.model ? `${result.model.split(":").pop()} · $${job.costUsd.toFixed(2)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    title,
    description: clip(lines.join("\n") || result.summary, 4000),
    color: style.color,
    fields,
    footer,
  };
}
