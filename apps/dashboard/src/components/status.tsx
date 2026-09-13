import type { JobDto, JobStatus } from "../api.ts";

type Tone = "good" | "warning" | "critical" | "active" | "neutral";

/** Status never relies on colour alone: every state has an icon and a word. */
const STATUS: Record<JobStatus, { tone: Tone; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  preparing: { tone: "active", label: "Preparing" },
  running: { tone: "active", label: "Running" },
  finalizing: { tone: "active", label: "Finalizing" },
  succeeded: { tone: "good", label: "Succeeded" },
  partial: { tone: "warning", label: "Partial" },
  failed: { tone: "critical", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

function Icon({ tone, status }: { tone: Tone; status: JobStatus }) {
  if (tone === "active") return <span className="pulse" aria-hidden="true" />;
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    "aria-hidden": true,
  } as const;
  switch (status) {
    case "succeeded":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.14" />
          <path
            d="M4.8 8.2l2.1 2.1 4.3-4.6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "partial":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" />
        </svg>
      );
    case "failed":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.14" />
          <path
            d="M5.5 5.5l5 5m0-5l-5 5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M4 12L12 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M8 4.8V8l2.2 1.4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

export function StatusBadge({
  job,
}: {
  job: Pick<JobDto, "status" | "result" | "cancelRequestedAt">;
}) {
  const base = STATUS[job.status];
  let { tone, label } = base;
  // A completed /runtest with failing tests is a failure from the reader's point of view.
  const result = job.result as { kind?: string; outcome?: string } | null;
  if (job.status === "succeeded" && result?.kind === "runtest" && result.outcome !== "passed") {
    tone = "critical";
    label = "Tests failed";
  }
  if (job.status === "succeeded" && result?.outcome === "draft_pr") {
    tone = "warning";
    label = "Draft PR";
  }
  if (job.cancelRequestedAt && tone === "active") label = "Cancelling";
  return (
    <span className={`status ${tone}`}>
      <Icon tone={tone} status={job.status} />
      {label}
    </span>
  );
}

export function isActive(status: JobStatus) {
  return (
    status === "queued" || status === "preparing" || status === "running" || status === "finalizing"
  );
}
