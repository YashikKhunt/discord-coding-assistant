import { useEffect, useRef, useState } from "react";
import { api, type JobDto } from "../api.ts";
import { isActive, StatusBadge } from "../components/status.tsx";
import { between, duration, relativeTime, usd } from "../format.ts";
import { useResource } from "../hooks.ts";
import { Link, navigate, useLocation, useTitle } from "../router.tsx";

const STATUS_FILTERS = [
  ["", "All"],
  ["running", "Running"],
  ["queued", "Queued"],
  ["succeeded", "Succeeded"],
  ["partial", "Partial"],
  ["failed", "Failed"],
] as const;

const TYPE_FILTERS = [
  ["", "Any type"],
  ["task", "task"],
  ["bugreport", "bugreport"],
  ["runtest", "runtest"],
] as const;

function summaryOf(job: JobDto): string {
  if (job.type === "runtest") return `Run tests${job.ref ? ` @ ${job.ref}` : ""}`;
  const title = (job.result as { title?: string } | null)?.title;
  return title || job.input.description || "—";
}

export function JobsPage() {
  useTitle("Jobs");
  const url = useLocation();
  const status = url.searchParams.get("status") ?? "";
  const type = url.searchParams.get("type") ?? "";
  const [repo, setRepo] = useState(url.searchParams.get("repo") ?? "");
  const [older, setOlder] = useState<JobDto[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(url.search);
    if (value) params.set(key, value);
    else params.delete(key);
    navigate(`/?${params}`, { replace: true });
  };

  const repoParam = url.searchParams.get("repo") ?? "";
  const olderRef = useRef(older);
  olderRef.current = older;

  // A new filter starts a fresh list; background refreshes keep already-loaded older pages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the filters are the trigger, not inputs
  useEffect(() => {
    setOlder([]);
    setNextBefore(null);
  }, [status, type, repoParam]);

  const { data, error } = useResource(
    async () => {
      const page = await api.jobs({ status, type, repo: repoParam, limit: 25 });
      if (olderRef.current.length === 0) setNextBefore(page.nextBefore);
      return page.jobs;
    },
    `${status}|${type}|${repoParam}`,
    { refreshMs: (jobs) => (jobs?.some((job) => isActive(job.status)) ? 3_000 : 15_000) },
  );

  const loadMore = async () => {
    if (!nextBefore) return;
    const page = await api.jobs({ status, type, repo: repoParam, before: nextBefore, limit: 25 });
    setOlder((previous) => [...previous, ...page.jobs]);
    setNextBefore(page.nextBefore);
  };

  const jobs = [...(data ?? []), ...older];
  const running = (data ?? []).filter((job) => isActive(job.status)).length;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">{running ? `${running} active` : "idle"}</p>
          <h1>Jobs</h1>
        </div>
        <Link className="button primary" href="/new">
          New job
        </Link>
      </div>

      <div className="filters">
        <fieldset className="segmented" aria-label="Status">
          {STATUS_FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => setParam("status", value)}
            >
              {label}
            </button>
          ))}
        </fieldset>
        <select
          className="select"
          aria-label="Type"
          value={type}
          onChange={(e) => setParam("type", e.target.value)}
        >
          {TYPE_FILTERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setParam("repo", repo.trim());
          }}
        >
          <input
            className="input mono"
            placeholder="owner/repo"
            aria-label="Repository"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </form>
      </div>

      <div className="card">
        {error && <div className="error-box">{error.message}</div>}
        {data && jobs.length === 0 ? (
          <div className="empty">
            <strong>No jobs match</strong>
            Start one from Discord with /task, /bugreport or /runtest, or create one here.
          </div>
        ) : (
          <div className="table-wrap" style={{ opacity: data ? 1 : 0.5 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Request</th>
                  <th>Status</th>
                  <th className="right">Cost</th>
                  <th className="right">Duration</th>
                  <th className="right">Created</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    className="clickable"
                    onClick={() => navigate(`/jobs/${job.shortId}`)}
                  >
                    <td>
                      <Link
                        className="mono"
                        href={`/jobs/${job.shortId}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {job.shortId}
                      </Link>
                    </td>
                    <td>
                      <span className="row-title">{summaryOf(job)}</span>
                      <span className="muted mono">{job.repo}</span>
                    </td>
                    <td>
                      <StatusBadge job={job} />
                    </td>
                    <td className="right num">
                      {job.costUsd ? usd(job.costUsd) : <span className="muted">—</span>}
                    </td>
                    <td className="right num">
                      {duration(between(job.startedAt, job.finishedAt))}
                    </td>
                    <td className="right muted" title={new Date(job.createdAt).toLocaleString()}>
                      {relativeTime(job.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {nextBefore && (
        <div style={{ marginTop: 14, textAlign: "center" }}>
          <button type="button" className="button" onClick={loadMore}>
            Load older jobs
          </button>
        </div>
      )}
    </>
  );
}
