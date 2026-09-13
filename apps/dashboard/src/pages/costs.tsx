import { useState } from "react";
import { api, type CostReport } from "../api.ts";
import { BarList, ColumnChart, Meter } from "../components/charts.tsx";
import { StatusBadge } from "../components/status.tsx";
import { fillDays, shortModel, usd } from "../format.ts";
import { useResource } from "../hooks.ts";
import { navigate, useTitle } from "../router.tsx";

const RANGES = [7, 30, 90] as const;

function TableToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="link-button table-toggle"
      aria-pressed={open}
      onClick={onToggle}
    >
      {open ? "Chart view" : "Table view"}
    </button>
  );
}

function Tiles({ report }: { report: CostReport }) {
  const total = report.jobCounts.reduce((sum, row) => sum + row.count, 0);
  const count = (status: string) =>
    report.jobCounts.find((row) => row.status === status)?.count ?? 0;
  const finished = count("succeeded") + count("partial") + count("failed");
  const periodSpend = report.byDay.reduce((sum, row) => sum + row.costUsd, 0);
  const paidJobs = report.byType.reduce((sum, row) => sum + row.jobs, 0);
  return (
    <div className="tiles">
      <div className="tile">
        <div className="tile-label">Spend, last {report.days} days</div>
        <div className="tile-value">{usd(periodSpend)}</div>
      </div>
      <div className="tile">
        <div className="tile-label">Jobs</div>
        <div className="tile-value">{total}</div>
        <div className="tile-sub">
          {count("failed")} failed · {count("cancelled")} cancelled
        </div>
      </div>
      <div className="tile">
        <div className="tile-label">Success rate</div>
        <div className="tile-value">
          {finished ? `${Math.round((count("succeeded") / finished) * 100)}%` : "—"}
        </div>
        <div className="tile-sub">of {finished} finished jobs</div>
      </div>
      <div className="tile">
        <div className="tile-label">Average LLM cost per job</div>
        <div className="tile-value">{paidJobs ? usd(periodSpend / paidJobs) : "—"}</div>
        <div className="tile-sub">
          {paidJobs} {paidJobs === 1 ? "job" : "jobs"} used a model
        </div>
      </div>
    </div>
  );
}

export function CostsPage() {
  useTitle("Costs");
  const [days, setDays] = useState<number>(30);
  const [dailyTable, setDailyTable] = useState(false);
  const { data, error } = useResource(() => api.costs(days), String(days), { refreshMs: 30_000 });

  const report = data;
  const daily = report ? fillDays(report.byDay, report.days) : [];
  const monthRatio = report ? report.monthSpendUsd / report.monthlyCapUsd : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">LLM spend · infrastructure not included</p>
          <h1>Costs</h1>
        </div>
      </div>

      <div className="filters">
        <fieldset className="segmented" aria-label="Date range">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={days === range}
              onClick={() => setDays(range)}
            >
              Last {range} days
            </button>
          ))}
        </fieldset>
      </div>

      {error && <div className="error-box">{error.message}</div>}
      {!report ? (
        <p className="muted">Loading…</p>
      ) : (
        <div style={{ opacity: data ? 1 : 0.5 }} className="stack">
          <div className="hero">
            <section className="card card-body">
              <h2>This month</h2>
              <div className="hero-figure">{usd(report.monthSpendUsd)}</div>
              <Meter
                value={report.monthSpendUsd}
                max={report.monthlyCapUsd}
                label="Monthly spend against cap"
              />
              <div className="meter-caption">
                <span>
                  {Math.round(monthRatio * 100)}% of the {usd(report.monthlyCapUsd, 0)} cap
                </span>
                <span>{usd(Math.max(0, report.monthlyCapUsd - report.monthSpendUsd))} left</span>
              </div>
              {monthRatio >= 0.8 && (
                <p className="secondary" style={{ margin: "12px 0 0", fontSize: 13 }}>
                  {monthRatio >= 1
                    ? "New jobs are refused until next month or until MONTHLY_LLM_CAP_USD is raised."
                    : "Close to the cap: jobs whose limit would exceed it are refused."}
                </p>
              )}
            </section>
            <Tiles report={report} />
          </div>

          <section className="card">
            <div className="card-head">
              <h2>Daily spend</h2>
              <TableToggle open={dailyTable} onToggle={() => setDailyTable((open) => !open)} />
            </div>
            <div className="card-body">
              {dailyTable ? (
                <div className="table-wrap" style={{ maxHeight: 280, overflowY: "auto" }}>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Day (UTC)</th>
                        <th className="right">Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...daily].reverse().map((row) => (
                        <tr key={row.day}>
                          <td className="mono">{row.day}</td>
                          <td className="right num">{usd(row.costUsd, 4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <ColumnChart
                  title={`Daily LLM spend, last ${report.days} days`}
                  data={daily.map((row) => ({
                    key: row.day,
                    label: new Date(`${row.day}T00:00:00Z`).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    }),
                    value: row.costUsd,
                  }))}
                />
              )}
            </div>
          </section>

          <div className="row-2" style={{ gap: 16 }}>
            <section className="card">
              <div className="card-head">
                <h2>By command</h2>
              </div>
              <div className="card-body">
                <BarList
                  sub="Spend by command"
                  rows={[...report.byType]
                    .sort((a, b) => b.costUsd - a.costUsd)
                    .map((row) => ({
                      key: row.type,
                      label: `/${row.type}`,
                      detail: `${row.jobs} ${row.jobs === 1 ? "job" : "jobs"}`,
                      value: row.costUsd,
                    }))}
                />
              </div>
            </section>
            <section className="card">
              <div className="card-head">
                <h2>By model</h2>
              </div>
              <div className="card-body">
                <BarList
                  sub="Spend by model"
                  rows={[...report.byModel]
                    .sort((a, b) => b.costUsd - a.costUsd)
                    .map((row) => ({
                      key: row.model,
                      label: shortModel(row.model),
                      detail: `${row.calls} ${row.calls === 1 ? "call" : "calls"}`,
                      value: row.costUsd,
                    }))}
                />
              </div>
            </section>
          </div>

          <section className="card">
            <div className="card-head">
              <h2>Most expensive jobs</h2>
            </div>
            <div className="table-wrap">
              {report.topJobs.length === 0 ? (
                <div className="empty">
                  <strong>No LLM spend yet</strong>
                  Jobs that call a model show up here.
                </div>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Repository</th>
                      <th>Status</th>
                      <th className="right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.topJobs.map((job) => (
                      <tr
                        key={job.shortId}
                        className="clickable"
                        onClick={() => navigate(`/jobs/${job.shortId}`)}
                      >
                        <td className="mono">{job.shortId}</td>
                        <td className="mono muted">{job.repo}</td>
                        <td>
                          <StatusBadge
                            job={{ status: job.status, result: null, cancelRequestedAt: null }}
                          />
                        </td>
                        <td className="right num">{usd(job.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Per-job limits</h2>
              <span className="muted">
                change models with MODEL_TASK, MODEL_BUGREPORT, MODEL_RUNTEST
              </span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Command</th>
                    <th>Model</th>
                    <th className="right">Steps</th>
                    <th className="right">Time</th>
                    <th className="right">Cost cap</th>
                  </tr>
                </thead>
                <tbody>
                  {report.profiles.map((profile) => (
                    <tr key={profile.type}>
                      <td className="mono">/{profile.type}</td>
                      <td className="mono">
                        {shortModel(profile.model.primary)}
                        {profile.model.fallback && (
                          <span className="muted"> → {shortModel(profile.model.fallback)}</span>
                        )}
                      </td>
                      <td className="right num">{profile.limits.maxIterations}</td>
                      <td className="right num">{profile.limits.maxMinutes}m</td>
                      <td className="right num">{usd(profile.limits.maxUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
