/**
 * Analytics (WEB_PANEL.md §3.5).
 *
 * Six fixed cards — Messages, Engagement, Playtime, Guild experience, Top
 * members, Top commands — plus whatever series the rollups happened to contain.
 * The fixed cards read the daily counters directly, so they are populated on a
 * guild that has never had a rollup run; the rollup charts are additive, and
 * `shapeAnalytics` drops any metric with no events rather than drawing an empty
 * frame. Each card states its own "nothing yet" rather than the page having one
 * blank state for six unrelated questions.
 *
 * Nothing on this page sums Discord and in-game figures, and nothing prints a
 * zero where the answer is unknown — an unlinked member's GEXP is an em dash.
 *
 * The window controls live in module state rather than the URL: they are a
 * viewing preference, not a place, and putting them in the hash would mean
 * every period change pushes a history entry the back button then has to walk.
 * The CSV links carry the same window explicitly so a download always matches
 * what is on screen.
 */
import type { AnalyticsVM, MetricChart, RollupPeriod } from "@sbr/panel-core";
import { loadPage } from "../api.js";
import { barChart, lineChart, type BarRow } from "../chart.js";
import {
  badge,
  card,
  deniedState,
  emptyState,
  errorState,
  pageTitle,
  person,
  spinner,
  statTile,
  table,
} from "../components.js";
import { h, replace } from "../dom.js";
import { compactNumber, count, describeSpan, duration } from "../format.js";
import { icon } from "../icons.js";

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
        h(
          "a",
          { class: "export-link", href: `${base}?${query()}&format=csv`, download: true },
          icon("download"),
          "Export rollups (CSV)",
        ),
        h(
          "a",
          { class: "export-link", href: `${base}?${query()}&format=csv&table=commands`, download: true },
          icon("download"),
          "Export command stats (CSV)",
        ),
      ),
      card("Messages", messagesBody(data)),
      card("Engagement", engagementBody(data)),
      card("Playtime", playtimeBody(data)),
      card("Guild experience", gexpBody(data)),
      card("Top members", membersBody(data)),
      ...charts(data),
      card("Top commands", commandsBody(data)),
    ),
  );
}

/**
 * Two numbers, never their sum.
 *
 * Discord messages and guild-chat lines come from different populations on
 * different surfaces; a single "messages" tile would describe neither, the same
 * way a blended member count describes neither roster.
 */
function messagesBody(data: AnalyticsVM): HTMLElement {
  const m = data.messages;
  if (m.discordMessages + m.guildChatMessages + m.commandsUsed === 0) {
    return emptyState("No messages were counted in this window. Counting starts when the bots are in the server.");
  }
  const perDay = (total: number): string => `${count(Math.round(total / m.days))} / day`;
  return h(
    "div",
    { class: "tiles" },
    statTile("Discord", count(m.discordMessages), perDay(m.discordMessages)),
    statTile("Guild chat", count(m.guildChatMessages), perDay(m.guildChatMessages)),
    statTile("Commands", count(m.commandsUsed), perDay(m.commandsUsed)),
  );
}

function engagementBody(data: AnalyticsVM): HTMLElement {
  const m = data.messages;
  if (m.activeMembers === 0) return emptyState("Nobody has been counted as active in this window.");
  const spoke = m.discordMessages + m.guildChatMessages;
  return h(
    "div",
    { class: "tiles" },
    statTile("Active members", count(m.activeMembers), `said something in ${m.days} days`),
    statTile("Messages each", count(Math.round(spoke / m.activeMembers)), "per active member"),
    statTile("Tracked members", count(data.topMembers.length), "with any recorded activity"),
  );
}

/**
 * Playtime, labelled as the estimate it is.
 *
 * Neither surface measures time. The Discord figure is a sample count times the
 * scan interval, and the in-game figure counts days with any GEXP at all — so
 * both are stated in their own units with the method written underneath, rather
 * than converted into an authoritative-looking "hours played".
 */
function playtimeBody(data: AnalyticsVM): HTMLElement {
  const p = data.playtime;
  const discordTile =
    p.presenceSamples === 0
      ? statTile("Discord presence", "Not sampled", "no presence samples have been recorded yet")
      : statTile(
          "Discord presence",
          duration(p.presenceSamples * p.sampleIntervalMinutes * 60_000),
          `estimated from ${count(p.presenceSamples)} samples ${p.sampleIntervalMinutes} minutes apart`,
        );

  return h(
    "div",
    {},
    h("div", { class: "tiles" }, discordTile, statTile("In-game days active", count(p.gameActiveDays), "days with any GEXP earned")),
    h("p", { class: "note" }, "Both figures are estimates. Presence is sampled, not measured, and a day with GEXP says somebody played, not for how long."),
  );
}

function gexpBody(data: AnalyticsVM): HTMLElement {
  if (data.gexp.length === 0) {
    return emptyState("No guild experience has been recorded yet. It fills in once the guild scan has run.");
  }
  // Shaped into the same MetricChart the rollups produce so it draws through
  // the one chart renderer — a second drawing path for a second data source is
  // how two charts on one page end up disagreeing about what a gap means.
  const chart: MetricChart = {
    metric: "guild.gexp",
    label: "Guild experience",
    buckets: data.gexp.map((p) => `${p.day}T00:00:00.000Z`),
    series: [
      {
        key: "",
        label: "GEXP",
        points: data.gexp.map((p) => p.value),
        total: data.gexp.reduce((sum, p) => sum + p.value, 0),
      },
    ],
    total: data.gexp.reduce((sum, p) => sum + p.value, 0),
    truncated: false,
  };
  return lineChart(chart, "DAILY");
}

/**
 * One table for both surfaces.
 *
 * A Discord list beside an in-game list answers half the question twice; the
 * question is "who is carrying this guild", and somebody who only plays and
 * somebody who only talks both belong in the answer.
 */
function membersBody(data: AnalyticsVM): HTMLElement {
  if (data.topMembers.length === 0) return emptyState("No member activity has been recorded in this window.");

  const rows = data.topMembers.map((m) => {
    const name = m.ign ?? m.username ?? (m.discordId === null ? "Unknown" : `<@${m.discordId}>`);
    const note = m.uuid === null ? badge("Discord only", "warn") : m.discordId === null ? badge("In-game only", "warn") : null;
    return [
      person(name, note),
      count(m.discordMessages),
      count(m.guildChatMessages),
      // An unlinked member's GEXP is unknown, not zero — printing 0 here would
      // claim they earned none, which is a different and unfounded statement.
      m.gexp === null ? "—" : compactNumber(m.gexp),
      m.activeDays === null ? "—" : count(m.activeDays),
    ];
  });

  return table(["Member", "Discord", "Guild chat", "GEXP", "Days active"], rows);
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
