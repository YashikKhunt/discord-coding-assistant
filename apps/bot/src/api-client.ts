import type {
  ApiErrorBody,
  ApiErrorCode,
  CreateJobRequest,
  CreateJobResponse,
  JobDto,
} from "@dca/core";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface ApiClient {
  createJob(request: CreateJobRequest): Promise<CreateJobResponse>;
  getJob(shortId: string): Promise<{ job: JobDto; position: number | null }>;
  listJobs(query: { limit?: number; status?: string }): Promise<{ jobs: JobDto[] }>;
  cancelJob(shortId: string): Promise<{ outcome: "cancelled" | "requested"; job: JobDto }>;
}

export function createApiClient(baseUrl: string, token: string, doFetch = fetch): ApiClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const error = (json as Partial<ApiErrorBody>).error;
      throw new ApiError(res.status, error?.code ?? "internal", error?.message ?? res.statusText);
    }
    return json as T;
  }

  return {
    createJob: (request) => call("POST", "/jobs", request),
    getJob: (shortId) => call("GET", `/jobs/${encodeURIComponent(shortId)}`),
    listJobs: ({ limit, status }) => {
      const params = new URLSearchParams();
      if (limit) params.set("limit", String(limit));
      if (status) params.set("status", status);
      return call("GET", `/jobs?${params}`);
    },
    cancelJob: (shortId) => call("POST", `/jobs/${encodeURIComponent(shortId)}/cancel`),
  };
}
