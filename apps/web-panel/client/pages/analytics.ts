/**
 * Analytics (WEB_PANEL.md §3.5).
 *
 * The chart list is whatever the server found in the rollups — see
 * `shapeAnalytics`. Today that is usually just `command.used`, so the page is
 * written to look deliberate with one chart rather than to look broken with
 * three empty ones.
 *
 * The window controls live in module state rather than the URL: they are a
 * viewing preference, not a place, and putting them in the hash would mean
 * every period change pushes a history entry the back button then has to walk.
 * The CSV links carry the same window explicitly so a download always matches
 * what is on screen.
 */
import type { AnalyticsVM, RollupPeriod } from "@sbr/panel-core";
import { loadPage } from "../api.js";
import { barChart, lineChart, type BarRow } from "../chart.js";
import { card, deniedState, emptyState, errorState, pageTitle, spinner } from "../components.js";
import { h, replace } from "../dom.js";
import { count, describeSpan, duration } from "../format.js";

const PERIODS: readonly RollupPeriod[] = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY"];

/**
 * Range choices, paired with the period they read well at. An hourly year is
 * ~8,760 buckets and gets trimmed server-side; offering it anyway (with the
 * trim explained on the page) is friendlier than hiding the option and leaving
 * the reader wondering why the range list changed.
 */
const RANGES: readonly { days: number; label: string }[] = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

const state: { period: RollupPeriod; days: number } = { period: "DAILY", days: 30 };

function query(): string {
  return `period=${state.period}&days=${state.days}`;
}

export async function renderAnalytics(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading analytics…"));

  const base = `/api/guilds/${encodeURIComponent(guildId)}/analytics`;
  const result = await loadPage<AnalyticsVM>(`${base}?${query()}`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderAnalytics(host, guildId)));
  }

  const data = result.data;
  const rerender = (): void => void renderAnalytics(host, guildId);
  const spanMs = Date.parse(data.until) - Date.parse(data.since);

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Analytics", `${data.period.toLowerCase()} buckets over the last ${describeSpan(spanMs)}`),
      controls(rerender),
      // One <a download> per table rather than a format switch on the page:
      // the browser's own download machinery already handles the transfer, and
      // the link is a plain GET carrying the session cookie.
      h(
        "div",
        { class: "export-row" },
        h("a", { class: "export-link", href: `${base}?${query()}&format=csv`, download: true }, "Export rollups (CSV)"),
        h(
          "a",
          { class: "export-link", href: `${base}?${query()}&format=csv&table=commands`, download: true },
          "Export command stats (CSV)",
        ),
      ),
      ...charts(data),
      card("Top commands", commandsBody(data)),
    ),
  );
}

function controls(rerender: () => void): HTMLElement {
  const period = h(
    "select",
    {
      class: "control",
      "aria-label": "Bucket size",
      onchange: (ev: Event) => {
        state.period = (ev.target as HTMLSelectElement).value as RollupPeriod;
        rerender();
      },
    },
    ...PERIODS.map((p) => h("option", { value: p, selected: p === state.period }, p.toLowerCase())),
  );

  const range = h(
    "select",
    {
      class: "control",
      "aria-label": "Time range",
      onchange: (ev: Event) => {
        state.days = Number((ev.target as HTMLSelectElement).value);
        rerender();
      },
    },
    ...RANGES.map((r) => h("option", { value: r.days, selected: r.days === state.days }, r.label)),
  );

  return h(
    "div",
    { class: "controls" },
    h("label", { class: "control-label" }, "Range", range),
    h("label", { class: "control-label" }, "Bucket", period),
  );
}

function charts(data: AnalyticsVM): HTMLElement[] {
  if (data.charts.length === 0) {
    return [
      card(
        "Activity",
        emptyState(
          "No events were recorded in this window. Analytics fill in as the bots are used — try a wider range.",
        ),
      ),
    ];
  }

  return data.charts.map((chart) =>
    card(
      chart.label,
      h(
        "div",
        {},
        lineChart(chart, data.period),
        chart.truncated
          ? h("p", { class: "note" }, "Older buckets were trimmed to keep the chart readable. The CSV export is complete.")
          : null,
      ),
    ),
  );
}

function commandsBody(data: AnalyticsVM): HTMLElement {
  if (data.topCommands.length === 0) {
    return emptyState("No commands have been used in this window.");
  }

  const rows: BarRow[] = data.topCommands.map((stat) => {
    // Failures and latency go in the note rather than a second bar: they answer
    // a different question ("is it working?") than the bar does ("is it used?").
    const failures = stat.count - stat.successCount;
    const parts = [`${stat.count > 0 ? Math.round((stat.successCount / stat.count) * 100) : 100}% ok`];
    if (failures > 0) parts.push(`${count(failures)} failed`);
    if (stat.avgLatencyMs !== null) parts.push(`~${duration(stat.avgLatencyMs)}`);
    return { label: stat.command, value: stat.count, note: parts.join(" · ") };
  });

  return barChart(rows);
}
