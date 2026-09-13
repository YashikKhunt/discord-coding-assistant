import { useEffect, useId, useRef, useState } from "react";
import { niceTicks, usd } from "../format.ts";

/**
 * Single-series charts only (one hue, validated for both themes). Values are always reachable
 * without hovering: through the axis, value labels, or the table view.
 */

interface ColumnDatum {
  key: string;
  label: string;
  value: number;
}

export function ColumnChart({
  data,
  height = 180,
  format = (value: number) => usd(value),
  title,
}: {
  data: ColumnDatum[];
  height?: number;
  format?: (value: number) => string;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const container = useRef<HTMLDivElement>(null);
  // Draw at the real pixel width so axis text keeps its size instead of scaling with the SVG.
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(320, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const pad = { top: 10, right: 8, bottom: 26, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const { max, ticks } = niceTicks(Math.max(0, ...data.map((d) => d.value)));
  const band = plotW / Math.max(1, data.length);
  const barW = Math.min(24, Math.max(3, band - 6));
  const y = (value: number) => pad.top + plotH - (value / max) * plotH;
  const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(plotW / 72)));
  const hovered = hover === null ? null : data[hover];

  return (
    <div className="chart" ref={container}>
      <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-labelledby={titleId}>
        <title id={titleId}>{title}</title>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className={tick === 0 ? "baseline" : "gridline"}
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className="tick" x={pad.left - 8} y={y(tick) + 4} textAnchor="end">
              {format(tick).replace(/\.00$/, "")}
            </text>
          </g>
        ))}
        {data.map((datum, i) => {
          const x = pad.left + band * i + (band - barW) / 2;
          const top = y(datum.value);
          const h = Math.max(0, pad.top + plotH - top);
          const r = Math.min(4, h, barW / 2);
          // Rounded data-end, square at the baseline.
          const path =
            h === 0
              ? ""
              : `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`;
          return (
            <g key={datum.key}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: focusable SVG data marks drive the hover/focus tooltip; values are also in the table view */}
              <rect
                className="hit"
                x={pad.left + band * i}
                y={pad.top}
                width={band}
                height={plotH}
                tabIndex={0}
                aria-label={`${datum.label}: ${format(datum.value)}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
              {path && (
                <path
                  className="bar"
                  d={path}
                  style={{ opacity: hover === null || hover === i ? 1 : 0.55 }}
                />
              )}
              {i % labelEvery === 0 && (
                <text
                  className="tick"
                  x={pad.left + band * i + band / 2}
                  y={height - 6}
                  textAnchor="middle"
                >
                  {datum.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <div
          className="tooltip"
          style={{
            left: `${((pad.left + band * hover + band / 2) / width) * 100}%`,
            top: `${(y(hovered.value) / height) * 100}%`,
          }}
        >
          <strong className="num">{format(hovered.value)}</strong>
          <span className="muted">{hovered.label}</span>
        </div>
      )}
    </div>
  );
}

export function BarList({
  rows,
  format = (value: number) => usd(value),
  sub,
}: {
  rows: { key: string; label: string; value: number; detail?: string }[];
  format?: (value: number) => string;
  sub?: string;
}) {
  const max = Math.max(0, ...rows.map((row) => row.value));
  if (rows.length === 0) return <p className="muted">No spend in this period.</p>;
  return (
    <ul className="barlist" aria-label={sub}>
      {rows.map((row) => (
        <li className="barlist-row" key={row.key}>
          <span className="mono" title={row.label}>
            {row.label}
            {row.detail && <span className="muted"> · {row.detail}</span>}
          </span>
          <div className="barlist-track">
            <div
              className="barlist-fill"
              style={{ width: `${max ? (row.value / max) * 100 : 0}%` }}
            />
          </div>
          <span className="num right" style={{ textAlign: "right" }}>
            {format(row.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? value / max : 0;
  const tone = ratio >= 1 ? "critical" : ratio >= 0.8 ? "warning" : "";
  return (
    // biome-ignore lint/a11y/useSemanticElements: native <meter> cannot be styled consistently across browsers
    <div
      className={`meter ${tone}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(4))}
    >
      <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
    </div>
  );
}
