import type { JobDto, JobStatus, JobType } from "@dca/core";

export type { JobDto, JobStatus, JobType };

export interface Me {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface JobEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LlmCall {
  id: number;
  step: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  response: { text?: string; cacheWriteTokens?: number } | null;
  createdAt: string;
}

export interface ToolCall {
  id: number;
  llmCallId: number | null;
  name: string;
  args: unknown;
  output: string | null;
  exitCode: number | null;
  durationMs: number;
  createdAt: string;
}

export interface JobDetail {
  job: JobDto;
  position: number | null;
  limits: { maxIterations: number; maxMinutes: number; maxUsd: number };
  events: JobEvent[];
  llmCalls: LlmCall[];
  toolCalls: ToolCall[];
  attachments: { id: string; kind: string; filename: string; mime: string; size: number }[];
}

export interface CostReport {
  days: number;
  monthSpendUsd: number;
  monthlyCapUsd: number;
  byDay: { day: string; costUsd: number }[];
  byType: { type: JobType; costUsd: number; jobs: number }[];
  byModel: { model: string; costUsd: number; calls: number }[];
  topJobs: {
    shortId: string;
    type: JobType;
    repo: string;
    status: JobStatus;
    costUsd: number;
    createdAt: string;
  }[];
  jobCounts: { status: JobStatus; count: number }[];
  profiles: {
    type: JobType;
    limits: { maxIterations: number; maxMinutes: number; maxUsd: number };
    model: { primary: string; fallback?: string };
  }[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = (json as { error?: { code?: string; message?: string } }).error;
    if (res.status === 401 && !location.pathname.startsWith("/login")) {
      location.assign("/login");
    }
    throw new ApiError(res.status, error?.code ?? "internal", error?.message ?? res.statusText);
  }
  return json as T;
}

export const api = {
  me: () => request<Me>("GET", "/api/me"),
  jobs: (params: {
    status?: string;
    type?: string;
    repo?: string;
    before?: string;
    limit?: number;
  }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return request<{ jobs: JobDto[]; nextBefore: string | null }>("GET", `/api/jobs?${query}`);
  },
  job: (shortId: string) => request<JobDetail>("GET", `/api/jobs/${encodeURIComponent(shortId)}`),
  createJob: (body: {
    type: JobType;
    repo: string;
    ref?: string;
    input: Record<string, string | undefined>;
  }) => request<{ job: JobDto; position: number | null }>("POST", "/api/jobs", body),
  cancel: (shortId: string) =>
    request<{ outcome: string; job: JobDto }>(
      "POST",
      `/api/jobs/${encodeURIComponent(shortId)}/cancel`,
    ),
  costs: (days: number) => request<CostReport>("GET", `/api/costs?days=${days}`),
  logout: () => request<{ ok: boolean }>("POST", "/auth/logout"),
};
