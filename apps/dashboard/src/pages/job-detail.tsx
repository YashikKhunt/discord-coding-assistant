import type { AgentJobResult, RuntestResult } from "@dca/core";
import { useState } from "react";
import { ApiError, api, type JobDetail, type LlmCall, type ToolCall } from "../api.ts";
import { Meter } from "../components/charts.tsx";
import { Markdown } from "../components/markdown.tsx";
import { isActive, StatusBadge } from "../components/status.tsx";
import { between, compact, duration, relativeTime, shortModel, usd } from "../format.ts";
import { useResource } from "../hooks.ts";
import { Link, useTitle } from "../router.tsx";

function argsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const record = args as Record<string, unknown>;
  const primary = record.command ?? record.path ?? record.pattern ?? record.glob;
  if (typeof primary === "string") return primary.replace(/\s+/g, " ");
  if (Object.keys(record).length === 0) return "(no arguments)";
  return JSON.stringify(args);
}

function ToolRow({ call }: { call: ToolCall }) {
  const failed = call.exitCode !== null && call.exitCode !== 0;
  const hasEdit = call.name === "edit_file" || call.name === "write_file";
  return (
    <details className="tool">
      <summary>
        <span className="tool-name">{call.name}</span>
        <span className="tool-args" title={argsPreview(call.args)}>
          {argsPreview(call.args)}
        </span>
        <span className="tool-meta">
          {call.exitCode !== null && (
            <span className={failed ? "exit-bad" : ""}>exit {call.exitCode}</span>
          )}
          <span>{duration(call.durationMs)}</span>
        </span>
      </summary>
      {hasEdit && <pre>{JSON.stringify(call.args, null, 2)}</pre>}
      <pre>{call.output || "(no output)"}</pre>
    </details>
  );
}

function Trace({ detail }: { detail: JobDetail }) {
  const toolsByCall = new Map<number | null, ToolCall[]>();
  for (const call of detail.toolCalls) {
    const list = toolsByCall.get(call.llmCallId) ?? [];
    list.push(call);
    toolsByCall.set(call.llmCallId, list);
  }
  const maxStepCost = Math.max(0, ...detail.llmCalls.map((call) => call.costUsd));

  if (detail.llmCalls.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        {detail.job.type === "runtest"
          ? "No model calls: tests ran without LLM analysis."
          : "No model calls recorded yet."}
      </p>
    );
  }

  return (
    <ol className="trace">
      {detail.llmCalls.map((call: LlmCall) => {
        const tools = toolsByCall.get(call.id) ?? [];
        const cachedShare =
          call.inputTokens + call.cachedTokens
            ? call.cachedTokens /
              (call.inputTokens + call.cachedTokens + (call.response?.cacheWriteTokens ?? 0))
            : 0;
        return (
          <li className="step" key={call.id}>
            <span className="step-node" aria-hidden="true" />
            <div className="step-head">
              <span className="step-n">step {call.step}</span>
              <span className="step-cost" title="Cost relative to the most expensive step">
                <span className="step-cost-bar">
                  <span
                    style={{ width: `${maxStepCost ? (call.costUsd / maxStepCost) * 100 : 0}%` }}
                  />
                </span>
                <span className="num">{usd(call.costUsd, 4)}</span>
              </span>
              <span className="muted num">
                {compact(
                  call.inputTokens + call.cachedTokens + (call.response?.cacheWriteTokens ?? 0),
                )}{" "}
                in
                {cachedShare > 0.05 ? ` (${Math.round(cachedShare * 100)}% cached)` : ""} ·{" "}
                {compact(call.outputTokens)} out
              </span>
              <span className="muted num">{duration(call.latencyMs)}</span>
            </div>
            {call.response?.text && <p className="step-text">{call.response.text}</p>}
            {tools.map((tool) => (
              <ToolRow key={tool.id} call={tool} />
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function ResultCard({ detail }: { detail: JobDetail }) {
  const { job } = detail;
  const result = job.result as (AgentJobResult | RuntestResult | { summary?: string }) | null;
  if (!result && !job.error) return null;
  const kind = (result as { kind?: string } | null)?.kind;

  return (
    <section className="card">
      <div className="result-banner">
        <h2>Result</h2>
        {job.prUrl && (
          <a className="button" href={job.prUrl} target="_blank" rel="noreferrer">
            Open pull request ↗
          </a>
        )}
      </div>
      <div className="card-body">
        {kind === "runtest" && <RuntestResultView result={result as RuntestResult} />}
        {(kind === "task" || kind === "bugreport") && (
          <AgentResultView result={result as AgentJobResult} />
        )}
        {!kind && (
          <p className="prose summary">
            {(result as { summary?: string } | null)?.summary ?? job.error}
          </p>
        )}
        {job.error && kind && (
          <div className="error-box" style={{ marginTop: 12 }}>
            {job.error}
          </div>
        )}
      </div>
    </section>
  );
}

function RuntestResultView({ result }: { result: RuntestResult }) {
  return (
    <>
      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile">
          <div className="tile-label">Passed</div>
          <div className="tile-value num">{result.tests?.passed ?? "—"}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Failed</div>
          <div className="tile-value num">{result.tests?.failed ?? "—"}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Skipped</div>
          <div className="tile-value num">{result.tests?.skipped ?? "—"}</div>
        </div>
      </div>
      <p className="summary" style={{ margin: 0 }}>
        {result.summary}
      </p>
      {result.analysis && (
        <div style={{ marginTop: 14 }}>
          <h2 style={{ marginBottom: 6 }}>
            Likely cause · {result.analysis.confidence} confidence
          </h2>
          <Markdown text={result.analysis.likelyCause} />
          {result.analysis.suggestedFix && (
            <p className="prose secondary" style={{ marginTop: 8 }}>
              <strong>Suggested fix:</strong> {result.analysis.suggestedFix}
            </p>
          )}
        </div>
      )}
      {(result.tests?.failures.length ?? 0) > 0 && (
        <div style={{ marginTop: 14 }}>
          <h2 style={{ marginBottom: 6 }}>Failing tests</h2>
          {result.tests?.failures.slice(0, 20).map((failure) => (
            <details className="tool" key={failure.name}>
              <summary>
                <span className="tool-name exit-bad">✕</span>
                <span className="tool-args">{failure.name}</span>
                <span className="tool-meta">{failure.file}</span>
              </summary>
              <pre>{failure.message}</pre>
            </details>
          ))}
        </div>
      )}
      {result.logTail && (
        <details className="tool" style={{ marginTop: 14 }}>
          <summary>
            <span className="tool-name">log</span>
            <span className="tool-args">{result.testCommand}</span>
            <span className="tool-meta">exit {result.exitCode ?? "—"}</span>
          </summary>
          <pre>{result.logTail}</pre>
        </details>
      )}
      {result.notes.length > 0 && (
        <ul className="notes">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function AgentResultView({ result }: { result: AgentJobResult }) {
  return (
    <>
      {result.title && <h2 style={{ fontSize: 16, marginBottom: 8 }}>{result.title}</h2>}
      <Markdown text={result.summary} />
      <div className="tiles" style={{ marginTop: 16 }}>
        <div className="tile">
          <div className="tile-label">Files changed</div>
          <div className="tile-value num">{result.filesChanged}</div>
          <div className="tile-sub num">
            +{result.insertions} −{result.deletions}
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Tests</div>
          <div className="tile-value" style={{ fontSize: 16, marginTop: 8 }}>
            {result.tests.passed === true
              ? "Passing"
              : result.tests.passed === false
                ? "Failing"
                : "Not confirmed"}
          </div>
          <div className="tile-sub">{result.tests.summary}</div>
        </div>
        {result.reproduced !== null && (
          <div className="tile">
            <div className="tile-label">Bug reproduced</div>
            <div className="tile-value" style={{ fontSize: 16, marginTop: 8 }}>
              {result.reproduced ? "Yes" : "No"}
            </div>
          </div>
        )}
      </div>
      {result.violations.length > 0 && (
        <div className="error-box" style={{ marginTop: 14 }}>
          <strong>Blocked by safety checks</strong>
          <ul className="notes" style={{ color: "inherit" }}>
            {result.violations.map((violation) => (
              <li key={violation}>{violation}</li>
            ))}
          </ul>
        </div>
      )}
      {result.notes.length > 0 && (
        <ul className="notes">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function JobDetailPage({ shortId }: { shortId: string }) {
  useTitle(shortId);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const { data, error, reload } = useResource(() => api.job(shortId), shortId, {
    refreshMs: (detail) => (detail && isActive(detail.job.status) ? 2_500 : null),
  });

  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="empty">
        <strong>{shortId} not found</strong>
        <Link href="/">Back to jobs</Link>
      </div>
    );
  }
  if (!data) return <p className="muted">{error ? error.message : "Loading…"}</p>;

  const { job, limits } = data;
  const elapsed = between(job.startedAt, job.finishedAt);
  const cancellable =
    ["queued", "preparing", "running"].includes(job.status) && !job.cancelRequestedAt;

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancel(job.shortId);
      await reload();
    } catch (err) {
      setCancelError((err as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">
            <Link href="/">jobs</Link> / {job.type}
          </p>
          <h1 className="mono" style={{ fontSize: 24 }}>
            {job.shortId}
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <StatusBadge job={job} />
          {cancellable && (
            <button type="button" className="button danger" onClick={cancel} disabled={cancelling}>
              {cancelling ? "Cancelling…" : "Cancel job"}
            </button>
          )}
        </div>
      </div>
      {cancelError && (
        <div className="error-box" style={{ marginBottom: 12 }}>
          {cancelError}
        </div>
      )}

      <div className="detail-grid">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>Request</h2>
              <span className="muted mono">{job.repo}</span>
            </div>
            <div className="card-body">
              {job.type === "runtest" ? (
                <p className="summary" style={{ margin: 0 }}>
                  Run the test suite{job.ref ? ` at ${job.ref}` : " on the default branch"}.
                </p>
              ) : (
                <Markdown text={job.input.description ?? ""} />
              )}
              {(job.input.steps || job.input.expected || job.input.issue) && (
                <dl className="kv" style={{ marginTop: 14 }}>
                  {job.input.steps && (
                    <>
                      <dt>Steps</dt>
                      <dd className="prose">{job.input.steps}</dd>
                    </>
                  )}
                  {job.input.expected && (
                    <>
                      <dt>Expected</dt>
                      <dd className="prose">{job.input.expected}</dd>
                    </>
                  )}
                  {job.input.issue && (
                    <>
                      <dt>Issue</dt>
                      <dd>{job.input.issue}</dd>
                    </>
                  )}
                </dl>
              )}
            </div>
          </section>

          <ResultCard detail={data} />

          <section className="card">
            <div className="card-head">
              <h2>Agent trace</h2>
              <span className="muted">
                {data.llmCalls.length} model calls · {data.toolCalls.length} tool calls
              </span>
            </div>
            <div className="card-body">
              <Trace detail={data} />
            </div>
          </section>
        </div>

        <aside className="stack">
          <section className="card">
            <div className="card-body">
              <dl className="kv">
                <dt>Repository</dt>
                <dd className="mono">{job.repo}</dd>
                <dt>Ref</dt>
                <dd className="mono">{job.ref ?? "default branch"}</dd>
                <dt>Source</dt>
                <dd>{job.source}</dd>
                <dt>Requested</dt>
                <dd title={new Date(job.createdAt).toLocaleString()}>
                  {relativeTime(job.createdAt)}
                </dd>
                <dt>Model</dt>
                <dd className="mono">
                  {shortModel((job.result as { model?: string } | null)?.model)}
                </dd>
                {data.position && (
                  <>
                    <dt>Queue</dt>
                    <dd>position {data.position}</dd>
                  </>
                )}
              </dl>
            </div>
          </section>

          <section className="card">
            <div className="card-body stack" style={{ gap: 14 }}>
              <div>
                <div className="budget-row" style={{ marginBottom: 6 }}>
                  <span>Cost</span>
                  <span className="num">
                    {usd(job.costUsd)} / {usd(limits.maxUsd)}
                  </span>
                </div>
                <Meter value={job.costUsd} max={limits.maxUsd} label="Cost against job budget" />
              </div>
              <div>
                <div className="budget-row" style={{ marginBottom: 6 }}>
                  <span>Steps</span>
                  <span className="num">
                    {job.iterations} / {limits.maxIterations}
                  </span>
                </div>
                <Meter
                  value={job.iterations}
                  max={limits.maxIterations}
                  label="Steps against limit"
                />
              </div>
              <div>
                <div className="budget-row" style={{ marginBottom: 6 }}>
                  <span>Time</span>
                  <span className="num">
                    {duration(elapsed)} / {limits.maxMinutes}m
                  </span>
                </div>
                <Meter
                  value={(elapsed ?? 0) / 60_000}
                  max={limits.maxMinutes}
                  label="Time against limit"
                />
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Timeline</h2>
            </div>
            <div className="card-body">
              <ul className="timeline">
                {data.events.map((event) => (
                  <li key={event.id}>
                    <span>{event.type.replace("status.", "")}</span>
                    <span className="muted num">
                      {new Date(event.createdAt).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
