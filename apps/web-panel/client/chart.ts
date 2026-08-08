/**
 * Inline-SVG charts.
 *
 * Hand-drawn rather than pulled from a library: the panel needs a multi-series
 * line and a horizontal bar, both over data the server has already shaped into
 * aligned arrays. A charting library would be the single largest dependency in
 * the repo, and it would have to be inlined anyway to satisfy the panel's CSP.
 *
 * Both charts are drawn in a fixed user-space coordinate system and scaled by
 * the viewBox, so they stay sharp and legible at any container width without a
 * resize observer.
 */
import type { MetricChart } from "@sbr/panel-core";
import { h, s, style } from "./dom.js";
import { count } from "./format.js";

const W = 720;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 46 };

/**
 * Series colours. Fixed hues rather than theme variables because a line's
 * identity has to survive a theme switch, and because the legend swatch and the
 * line must agree exactly.
 */
const COLORS = ["#4b5bd7", "#1a9e6a", "#d1770b", "#b8397f", "#0e8fa8", "#8a6ad1"] as const;

function color(i: number): string {
  return COLORS[i % COLORS.length] ?? COLORS[0];
}

/** A y-axis top that lands on a round number, so the gridline labels read well. */
function niceMax(peak: number): number {
  if (peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= peak) return candidate;
  }
  return 10 * magnitude;
}

/** Bucket labels are dense; show a handful evenly spaced rather than all of them. */
function tickIndices(length: number, wanted = 6): number[] {
  if (length <= wanted) return Array.from({ length }, (_, i) => i);
  const stride = (length - 1) / (wanted - 1);
  return Array.from({ length: wanted }, (_, i) => Math.round(i * stride));
}

function bucketLabel(iso: string, period: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (period === "HOURLY") {
    return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  }
  if (period === "MONTHLY") {
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function lineChart(chart: MetricChart, period: string): HTMLElement {
  const buckets = chart.buckets;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const peak = Math.max(...chart.series.flatMap((series) => [...series.points]), 0);
  const max = niceMax(peak);

  // A single bucket has no span to interpolate across; centring it keeps the
  // point visible instead of pinning it to the axis.
  const x = (i: number): number =>
    buckets.length <= 1 ? PAD.left + plotW / 2 : PAD.left + (i / (buckets.length - 1)) * plotW;
  const y = (value: number): number => PAD.top + plotH - (value / max) * plotH;

  const gridlines = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const value = max * fraction;
    const yy = y(value);
    return s(
      "g",
      {},
      s("line", { x1: PAD.left, x2: W - PAD.right, y1: yy, y2: yy, class: "grid" }),
      s("text", { x: PAD.left - 8, y: yy + 4, class: "axis axis-y" }, count(Math.round(value))),
    );
  });

  const ticks = tickIndices(buckets.length).map((i) =>
    s("text", { x: x(i), y: H - 8, class: "axis axis-x" }, bucketLabel(buckets[i] ?? "", period)),
  );

  const lines = chart.series.map((series, i) => {
    const points = series.points.map((value, idx) => `${x(idx).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    return s("polyline", {
      points,
      fill: "none",
      stroke: color(i),
      "stroke-width": 2,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    });
  });

  // Screen readers get the summary; the drawing itself is decoration over data
  // that is also in the legend and the CSV.
  const label = `${chart.label}: ${count(chart.total)} total across ${buckets.length} buckets`;

  return h(
    "div",
    { class: "chart" },
    s(
      "svg",
      {
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: "none",
        class: "chart-svg",
        role: "img",
        "aria-label": label,
      },
      s("title", {}, label),
      ...gridlines,
      ...ticks,
      ...lines,
    ),
    legend(chart),
  );
}

function legend(chart: MetricChart): HTMLElement {
  return h(
    "ul",
    { class: "legend" },
    ...chart.series.map((series, i) =>
      h(
        "li",
        { class: "legend-item" },
        style(h("span", { class: "swatch" }), { background: color(i) }),
        h("span", { class: "legend-label" }, series.label),
        h("span", { class: "legend-total" }, count(series.total)),
      ),
    ),
  );
}

export interface BarRow {
  readonly label: string;
  readonly value: number;
  readonly note?: string;
}

/**
 * Horizontal bars, as HTML rather than SVG: the labels are the point of this
 * chart, and text wrapping and truncation are things CSS already does well.
 */
export function barChart(rows: readonly BarRow[]): HTMLElement {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return h(
    "div",
    { class: "bars" },
    ...rows.map((row) =>
      h(
        "div",
        { class: "bar-row" },
        h("span", { class: "bar-label" }, row.label),
        h(
          "span",
          { class: "bar-track" },
          // A floor of 1.5% keeps a bar with a count of 1 visible next to a bar
          // of 4,000 instead of collapsing to nothing.
          style(h("span", { class: "bar-fill" }), {
            width: `${Math.max((row.value / max) * 100, 1.5).toFixed(2)}%`,
          }),
        ),
        h("span", { class: "bar-value" }, count(row.value)),
        row.note ? h("span", { class: "bar-note" }, row.note) : null,
      ),
    ),
  );
}
