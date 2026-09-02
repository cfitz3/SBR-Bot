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
import { scope } from "../copy.js";
import { h, replace } from "../dom.js";
import { compactNumber, count, describeSpan, duration } from "../format.js";
import { icon } from "../icons.js";

const t = scope("analytics");
const c = scope("common");

const PERIODS: readonly RollupPeriod[] = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY"];

/**
 * Range choices, paired with the period they read well at. An hourly year is
 * ~8,760 buckets and gets trimmed server-side; offering it anyway (with the
 * trim explained on the page) is friendlier than hiding the option and leaving
 * the reader wondering why the range list changed.
 *
 * The day counts are structure and the words are copy — a guild that writes
 * "1 week" for seven days changes the label, never the query.
 */
const RANGES = [
  { days: 1, key: "day" },
  { days: 7, key: "week" },
  { days: 30, key: "month" },
  { days: 90, key: "quarter" },
  { days: 365, key: "year" },
] as const;

const state: { period: RollupPeriod; days: number } = { period: "DAILY", days: 30 };

function query(): string {
  return `period=${state.period}&days=${state.days}`;
}

export async function renderAnalytics(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("analytics"));

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
      pageTitle(
        t("title"),
        t("subtitle").replace("{period}", data.period.toLowerCase()).replace("{span}", describeSpan(spanMs)),
      ),
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
          t("exportRollups"),
        ),
        h(
          "a",
          { class: "export-link", href: `${base}?${query()}&format=csv&table=commands`, download: true },
          icon("download"),
          t("exportCommands"),
        ),
      ),
      card(t("cardMessages"), messagesBody(data)),
      card(t("cardEngagement"), engagementBody(data)),
      card(t("cardPlaytime"), playtimeBody(data)),
      card(t("cardGexp"), gexpBody(data)),
      card(t("cardMembers"), membersBody(data)),
      ...charts(data),
      card(t("cardCommands"), commandsBody(data)),
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
    return emptyState("analyticsMessages");
  }
  const perDay = (total: number): string =>
    t("perDay").replace("{count}", count(Math.round(total / m.days)));
  return h(
    "div",
    { class: "tiles" },
    statTile(t("tileDiscord"), count(m.discordMessages), perDay(m.discordMessages)),
    statTile(t("tileGuildChat"), count(m.guildChatMessages), perDay(m.guildChatMessages)),
    statTile(t("tileCommands"), count(m.commandsUsed), perDay(m.commandsUsed)),
  );
}

function engagementBody(data: AnalyticsVM): HTMLElement {
  const m = data.messages;
  if (m.activeMembers === 0) return emptyState("analyticsEngagement");
  const spoke = m.discordMessages + m.guildChatMessages;
  return h(
    "div",
    { class: "tiles" },
    statTile(
      t("tileActive"),
      count(m.activeMembers),
      t("activeNote").replace("{days}", String(m.days)),
    ),
    statTile(t("tileEach"), count(Math.round(spoke / m.activeMembers)), t("eachNote")),
    statTile(t("tileTracked"), count(data.topMembers.length), t("trackedNote")),
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
      ? statTile(t("tilePresence"), t("presenceNone"), t("presenceNoneNote"))
      : statTile(
          t("tilePresence"),
          duration(p.presenceSamples * p.sampleIntervalMinutes * 60_000),
          t("presenceNote")
            .replace("{samples}", count(p.presenceSamples))
            .replace("{minutes}", String(p.sampleIntervalMinutes)),
        );

  return h(
    "div",
    {},
    h(
      "div",
      { class: "tiles" },
      discordTile,
      statTile(t("tileGameDays"), count(p.gameActiveDays), t("gameDaysNote")),
    ),
    h("p", { class: "note" }, t("playtimeNote")),
  );
}

function gexpBody(data: AnalyticsVM): HTMLElement {
  if (data.gexp.length === 0) {
    return emptyState("analyticsGexp");
  }
  // Shaped into the same MetricChart the rollups produce so it draws through
  // the one chart renderer — a second drawing path for a second data source is
  // how two charts on one page end up disagreeing about what a gap means.
  const chart: MetricChart = {
    metric: "guild.gexp",
    label: t("cardGexp"),
    buckets: data.gexp.map((p) => `${p.day}T00:00:00.000Z`),
    series: [
      {
        key: "",
        label: t("gexpSeries"),
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
  if (data.topMembers.length === 0) return emptyState("analyticsTopMembers");

  const rows = data.topMembers.map((m) => {
    const name = m.ign ?? m.username ?? (m.discordId === null ? t("unknownMember") : `<@${m.discordId}>`);
    const note =
      m.uuid === null
        ? badge(t("discordOnly"), "warn")
        : m.discordId === null
          ? badge(t("gameOnly"), "warn")
          : null;
    return [
      person(name, note),
      count(m.discordMessages),
      count(m.guildChatMessages),
      // An unlinked member's GEXP is unknown, not zero — printing 0 here would
      // claim they earned none, which is a different and unfounded statement.
      m.gexp === null ? c("dash") : compactNumber(m.gexp),
      m.activeDays === null ? c("dash") : count(m.activeDays),
    ];
  });

  return table(
    [
      t("colMember"),
      { label: t("colDiscord"), align: "num" },
      { label: t("colGuildChat"), align: "num" },
      { label: t("colGexp"), align: "num" },
      { label: t("colActiveDays"), align: "num" },
    ],
    rows,
  );
}

function controls(rerender: () => void): HTMLElement {
  const period = h(
    "select",
    {
      class: "control",
      "aria-label": t("bucketAria"),
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
      "aria-label": t("rangeAria"),
      onchange: (ev: Event) => {
        state.days = Number((ev.target as HTMLSelectElement).value);
        rerender();
      },
    },
    ...RANGES.map((r) =>
      h("option", { value: r.days, selected: r.days === state.days }, t("range")[r.key]),
    ),
  );

  return h(
    "div",
    { class: "controls" },
    h("label", { class: "control-label" }, t("rangeLabel"), range),
    h("label", { class: "control-label" }, t("bucketLabel"), period),
  );
}

function charts(data: AnalyticsVM): HTMLElement[] {
  if (data.charts.length === 0) {
    return [
      card(t("cardActivity"), emptyState("analyticsCharts")),
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
          ? h("p", { class: "note" }, t("truncated"))
          : null,
      ),
    ),
  );
}

function commandsBody(data: AnalyticsVM): HTMLElement {
  if (data.topCommands.length === 0) {
    return emptyState("analyticsCommands");
  }

  const rows: BarRow[] = data.topCommands.map((stat) => {
    // Failures and latency go in the note rather than a second bar: they answer
    // a different question ("is it working?") than the bar does ("is it used?").
    const failures = stat.count - stat.successCount;
    const ok = stat.count > 0 ? Math.round((stat.successCount / stat.count) * 100) : 100;
    const parts = [t("commandOk").replace("{pct}", String(ok))];
    if (failures > 0) parts.push(t("commandFailed").replace("{count}", count(failures)));
    if (stat.avgLatencyMs !== null) {
      parts.push(t("commandLatency").replace("{duration}", duration(stat.avgLatencyMs)));
    }
    return { label: stat.command, value: stat.count, note: parts.join(` ${c("dot")} `) };
  });

  return barChart(rows);
}
