export function usd(value: number, digits = 2): string {
  if (value > 0 && value < 0.01 && digits === 2) return "<$0.01";
  return `$${value.toFixed(digits)}`;
}

export function compact(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000)
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function between(start: string | null, end: string | null, now = Date.now()): number | null {
  if (!start) return null;
  return (end ? new Date(end).getTime() : now) - new Date(start).getTime();
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Clean axis maximum and ticks: 0.37 → max 0.4, ticks 0/0.1/0.2/0.3/0.4. */
export function niceTicks(maxValue: number, count = 4): { max: number; ticks: number[] } {
  if (maxValue <= 0) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const rough = maxValue / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough;
  const max = Math.ceil(maxValue / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(Number(value.toFixed(6)));
  return { max, ticks };
}

export function shortModel(model: string | null | undefined): string {
  return model ? (model.split(":").pop() ?? model) : "—";
}

/** Fills missing days with zero so the time axis is continuous. */
export function fillDays(
  rows: { day: string; costUsd: number }[],
  days: number,
  today = new Date(),
) {
  const byDay = new Map(rows.map((row) => [row.day, row.costUsd]));
  const out: { day: string; costUsd: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i),
    );
    const key = date.toISOString().slice(0, 10);
    out.push({ day: key, costUsd: byDay.get(key) ?? 0 });
  }
  return out;
}
