/**
 * `/progression` — one card for where a member has been, where they are going,
 * and the marker that pins today so tomorrow has something to measure against.
 *
 * This replaces `/progress`, `/goal` and `/snapshot`, which were three commands
 * around one loop. A member who wanted to know whether their Catacombs grind was
 * working had to chart it, then run a second command to see the target they set
 * for it, then remember a third to save the reading that makes next week's chart
 * possible. Nothing about that sequence was discoverable: `/progress` never
 * mentioned `/snapshot`, so the usual first experience of it was an empty chart
 * and no idea why.
 *
 * As one card the loop closes on itself. The chart is the card, the goal for the
 * charted metric sits under it, and the button that keeps the history going is
 * the same press that refreshes what you are looking at. The empty state stops
 * being a dead end and becomes the first step — "save a marker" is a button, not
 * a command name a member has to have already heard of.
 *
 * Ephemeral, and self-only. Every branch reads or writes the caller's own
 * progression, which is also why the old trio had no `player` option: there is
 * no such thing as looking at somebody else's goals.
 *
 * All the state a press needs — the metric and the window — rides in the custom
 * id, so a card from last week still works after a restart. Nothing is held in
 * process memory.
 */
import { copy } from "@sbr/brand";
import { card, facts, field, player, progressLine, sparkline } from "@sbr/embed-kit";
import { parseProgressionPolicy, PROGRESSION_SETTING_KEY } from "@sbr/guild-config";
import {
  METRIC_LABELS,
  SAVED_SNAPSHOT_LIMIT,
  type ActionRowView,
  type EmbedView,
  type GoalDTO,
  type ProgressMetric,
  type ProgressSeriesDTO,
  type SelectOptionView,
} from "@sbr/shared-types";
import { formatMetric, renderFailure } from "./render.js";
import type { CommandHandler, CommandReply, CommandSpec, HandlerDeps } from "./types.js";

const C = copy.embed.card;
const F = copy.embed.field;

/** The custom-id namespace. Short because the budget is 100 characters. */
export const PROGRESSION_NAMESPACE = "prg";

/**
 * The windows the card offers.
 *
 * Three, not a free number. A range option let a member ask for 217 days and get
 * the same picture as 90 — markers are capped at two dozen, so past a point the
 * window stops changing what is on screen and only changes the label. Week,
 * month, quarter are the three questions people actually ask.
 */
export const RANGES: readonly number[] = [7, 30, 90];
const DEFAULT_RANGE = 30;

function readRange(raw: string | number | undefined | null): number {
  const value = Number(raw);
  return RANGES.includes(value) ? value : DEFAULT_RANGE;
}

/**
 * The metrics this guild puts on the menu, and the one the card is showing.
 *
 * A metric the guild has since switched off falls back to the head of their list
 * rather than erroring: a card pressed from scrollback is not a bug report, and
 * the member's next press is on the current menu anyway.
 */
async function offered(guildId: string, deps: HandlerDeps): Promise<readonly ProgressMetric[]> {
  const stored = await deps.config.getSetting<unknown>(guildId, PROGRESSION_SETTING_KEY).catch(() => null);
  return parseProgressionPolicy(stored).metrics;
}

function chosen(metrics: readonly ProgressMetric[], requested: string | null): ProgressMetric | null {
  return metrics.find((m) => m === requested) ?? metrics[0] ?? null;
}

// ─────────────────────────────── The card ───────────────────────────────

interface CardInput {
  readonly ign: string;
  readonly uuid: string;
  readonly metric: ProgressMetric;
  readonly series: ProgressSeriesDTO;
  readonly goal: GoalDTO | null;
  readonly markers: number;
  /**
   * What the press that produced this card just did, if anything.
   *
   * It goes above the headline rather than into `text`, because a reply that
   * carries an embed drops its text (`replyOptions`) — a confirmation put there
   * would be written, returned, and never seen. It is not a field: it is about
   * the press, not about the member's progression, and it is gone by the next one.
   */
  readonly notice?: string | undefined;
}

/**
 * `+2.4/day`, or the phrase for "not enough history to say".
 *
 * Pace rather than a second total: the start and now values are already on the
 * card, and what a member plans against is the rate.
 */
function pace(metric: string, perDay: number | null): string {
  if (perDay === null) return C.goalNoPace;
  const sign = perDay >= 0 ? "+" : "−";
  return C.perDay.replace("{n}", `${sign}${formatMetric(metric, Math.abs(perDay))}`);
}

/** The metric as it reads mid-sentence — "no networth goal set". */
function phraseOf(metric: string): string {
  return (copy.embed.metricPhrase as Readonly<Record<string, string>>)[metric] ?? metric;
}

/** The goal for the charted metric, as a bar with a hedged ETA. */
function goalValue(metric: ProgressMetric, goal: GoalDTO | null): string {
  if (goal === null) return C.progressionNoGoal.replace("{metric}", phraseOf(metric));

  const bar = goal.progress === null ? "" : `${progressLine(goal.progress)}\n`;
  const when =
    goal.achievedAt !== null
      ? C.goalDone
      : goal.etaDays === null
        ? C.goalNoPace
        : C.goalEta.replace("{n}", String(goal.etaDays));
  return `${bar}${F.target} ${formatMetric(metric, goal.target)} · ${when}`;
}

export function renderProgressionEmbed(input: CardInput): EmbedView {
  const { ign, uuid, metric, series, goal, markers, notice } = input;
  const fmt = (v: number | null): string => (v === null ? "—" : formatMetric(metric, v));
  const points = series.points;
  const first = points[0];
  const last = points[points.length - 1];

  const reading =
    points.length === 0
      ? C.progressionUntracked
      : series.change === null
        ? C.oneSnapshot
        : `**${series.change >= 0 ? "+" : "−"}${fmt(Math.abs(series.change))}** over ${series.rangeDays} days`;
  const headline = notice === undefined ? reading : `${notice}

${reading}`;

  // A member's own name for a marker beats the date they made it: "before
  // dungeon grind" says what the number means and 2026-08-21 does not.
  const nameOf = (index: 0 | 1): string => {
    const point = index === 0 ? first : last;
    if (point === undefined) return index === 0 ? "start" : "now";
    return point.label ?? point.date.slice(0, 10);
  };

  const chart = sparkline(points.map((p) => p.value));
  // The chart and the two ends it spans, together: a ramp with no numbers beside
  // it is decoration, and the numbers without the ramp lose the shape of the
  // month between them.
  const trend =
    chart === ""
      ? ""
      : [
          "`" + chart + "`",
          facts([
            { label: nameOf(0), value: fmt(first?.value ?? null) },
            { label: nameOf(1), value: fmt(last?.value ?? null) },
          ]),
        ].join("\n");

  return card({
    // The metric, not the member — identity is the author row.
    title: METRIC_LABELS[metric],
    subject: player(ign, uuid),
    headline,
    fields: [
      field(F.trend, trend),
      field(F.pace, pace(metric, series.perDay), true),
      field(F.snapshots, `${markers} of ${SAVED_SNAPSHOT_LIMIT}`, true),
      field(F.goal, goalValue(metric, goal)),
    ],
    footer: C.progressionFooter,
    // The card is built from stored markers rather than a fetch, so there is no
    // envelope to take a freshness reading from.
    timestamp: new Date().toISOString(),
    // Amber only when a tracked number went backwards. No history at all is
    // neutral: a member who has not started has not gone wrong.
    tone: points.length === 0 ? "NEUTRAL" : series.change !== null && series.change < 0 ? "WARNING" : "SUCCESS",
  });
}

// ───────────────────────────── The controls ─────────────────────────────

/**
 * Metric menu, window buttons, and the three writes.
 *
 * The select carries the window in its id and each button carries the metric, so
 * every control round-trips the whole state of the card. That is what lets a
 * press rebuild the card exactly as the member was looking at it, plus the one
 * thing they changed.
 */
export function progressionComponents(
  metric: ProgressMetric,
  range: number,
  metrics: readonly ProgressMetric[],
  hasGoal: boolean,
  tracking: boolean,
): readonly ActionRowView[] {
  const options: SelectOptionView[] = metrics.map((m) => ({
    label: METRIC_LABELS[m],
    value: m,
    default: m === metric,
  }));

  return [
    {
      buttons: [],
      select: {
        customId: `${PROGRESSION_NAMESPACE}:metric:${range}`,
        placeholder: METRIC_LABELS[metric],
        options,
      },
    },
    {
      buttons: RANGES.map((days) => ({
        label: `${days}d`,
        style: days === range ? ("PRIMARY" as const) : ("SECONDARY" as const),
        customId: `${PROGRESSION_NAMESPACE}:range:${metric}:${days}`,
        // The window you are already looking at is not a place to go.
        disabled: days === range,
      })),
    },
    {
      buttons: [
        {
          // The first press is the one that needs explaining; after that the
          // member knows what a marker is, and the shorter label is the honest one.
          label: tracking ? "Save marker" : "Begin tracking",
          style: "SUCCESS" as const,
          customId: `${PROGRESSION_NAMESPACE}:save:${metric}:${range}`,
        },
        {
          label: hasGoal ? "Change goal" : "Set goal",
          style: "PRIMARY" as const,
          customId: `${PROGRESSION_NAMESPACE}:goal:${metric}:${range}`,
        },
        {
          label: "Clear goal",
          style: "SECONDARY" as const,
          customId: `${PROGRESSION_NAMESPACE}:clear:${metric}:${range}`,
          disabled: !hasGoal,
        },
      ],
    },
  ];
}

// ─────────────────────────────── Assembly ───────────────────────────────

/**
 * Build the whole reply — card and controls — for one member, metric and window.
 *
 * Every entry point lands here: the slash command, each button, the select and
 * the goal modal. One builder is what makes a press indistinguishable from
 * re-running the command, which is the property that lets the buttons replace
 * three commands rather than merely sit beside them.
 *
 * `notice` is prepended when a press did something worth confirming. It is text
 * rather than a field on the card because it is about the press, not about the
 * member's progression, and by the next press it is gone.
 */
export async function buildProgression(
  userId: string,
  guildId: string,
  requested: string | null,
  range: number,
  deps: HandlerDeps,
  notice?: string,
): Promise<CommandReply> {
  const linked = await deps.identity.resolveByDiscordId(userId);
  if (!linked.ok || linked.value === null) {
    return { ephemeral: true, text: renderFailure("NOT_LINKED") };
  }
  const { ign, minecraftUuid } = linked.value;

  const metrics = await offered(guildId, deps);
  const metric = chosen(metrics, requested);
  if (metric === null) return { ephemeral: true, text: C.progressionNoMetrics };

  // A failed read is an empty series rather than an error: the card is a status
  // check, and "nothing yet" is both the honest answer and the one a member can
  // act on with the button underneath it.
  const [series, goals] = await Promise.all([
    deps.progression.getProgress(minecraftUuid, metric, range).catch(() => null),
    deps.progression.listGoals(guildId, minecraftUuid).catch(() => null),
  ]);

  const resolved: ProgressSeriesDTO =
    series?.ok === true ? series.value : { metric, rangeDays: range, points: [], change: null, perDay: null };
  const list = goals?.ok === true ? goals.value : [];
  const goal = list.find((g) => g.metric === metric) ?? null;

  // The card carries the answer, but the in-game surface only receives text, so
  // the one line that used to be all of `/progress` stays as the reply body. A
  // notice from a press displaces it: having just pressed save, what the member
  // needs told is that it saved.
  const line =
    resolved.change === null
      ? `${ign}: ${METRIC_LABELS[metric]} — ${resolved.points.length === 0 ? "no markers yet" : "one marker so far"}`
      : `${ign}: ${METRIC_LABELS[metric]} over ${range}d — ${resolved.change >= 0 ? "+" : "−"}${formatMetric(metric, Math.abs(resolved.change))}`;

  return {
    ephemeral: true,
    text: notice ?? line,
    embed: renderProgressionEmbed({
      ign,
      uuid: minecraftUuid,
      metric,
      series: resolved,
      goal,
      markers: resolved.points.length,
      notice,
    }),
    components: progressionComponents(metric, range, metrics, goal !== null, resolved.points.length > 0),
  };
}

/**
 * Nobody types `2000000000`.
 *
 * `2b`, `1.5m`, `40k` — the same shorthand `formatCoins` prints, read back. A
 * bare number is still a bare number, so `40` means forty rather than forty
 * thousand: guessing at a magnitude the member did not write is how a networth
 * goal quietly becomes a thousand times too small.
 */
export function parseTarget(input: string): number | null {
  const trimmed = input.trim().toLowerCase().replace(/[, _]/g, "");
  const match = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(trimmed);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const scale = { k: 1e3, m: 1e6, b: 1e9 }[match[2] ?? ""] ?? 1;
  return value * scale;
}

// ─────────────────────────── Persistent controls ───────────────────────────

/**
 * The press half of the card. Plain functions rather than transport wiring, so
 * the app layer supplies only the interaction plumbing and a test can press a
 * button without a Discord client — the same split `communityButtonReplies` uses.
 */
export const progressionButtonReplies = {
  /** `prg:metric:<range>`, with the chosen metric as the select's value. */
  async metric(
    value: string,
    range: string | undefined,
    userId: string,
    guildId: string,
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    return buildProgression(userId, guildId, value, readRange(range), deps);
  },

  /** `prg:range:<metric>:<days>` */
  async range(
    metric: string | undefined,
    days: string | undefined,
    userId: string,
    guildId: string,
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    return buildProgression(userId, guildId, metric ?? null, readRange(days), deps);
  },

  /**
   * `prg:save:<metric>:<range>` — pin the current reading.
   *
   * Costs no Hypixel request: the value saved is the one the refresh job already
   * holds. That is what stops "let the member press it" from becoming a way to
   * poll on demand (docs/HYPIXEL_COMPLIANCE.md §1).
   */
  async save(
    metric: string | undefined,
    range: string | undefined,
    userId: string,
    guildId: string,
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    const linked = await deps.identity.resolveByDiscordId(userId);
    if (!linked.ok || linked.value === null) {
      return { ephemeral: true, text: renderFailure("NOT_LINKED") };
    }
    const saved = await deps.progression.saveSnapshot(linked.value.minecraftUuid, userId, null);
    const notice = saved.ok
      ? C.snapshotSaved
          .replace("{n}", String(saved.value.savedCount))
          .replace("{limit}", String(saved.value.limit))
      : saved.error.kind === "ALREADY_SAVED"
        ? C.snapshotUnchanged
        : saved.error.kind === "NO_READING"
          ? C.snapshotNoReading
          : C.snapshotUnavailable;
    return buildProgression(userId, guildId, metric ?? null, readRange(range), deps, notice);
  },

  /** `prg:clear:<metric>:<range>` */
  async clear(
    metric: string | undefined,
    range: string | undefined,
    userId: string,
    guildId: string,
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    const linked = await deps.identity.resolveByDiscordId(userId);
    if (!linked.ok || linked.value === null) {
      return { ephemeral: true, text: renderFailure("NOT_LINKED") };
    }
    const target = chosen(await offered(guildId, deps), metric ?? null);
    if (target === null) return { ephemeral: true, text: C.progressionNoMetrics };

    const cleared = await deps.progression.clearGoal(guildId, linked.value.minecraftUuid, target);
    const template = cleared.ok && cleared.value ? C.goalCleared : C.goalNotSet;
    return buildProgression(
      userId,
      guildId,
      target,
      readRange(range),
      deps,
      template.replace("{metric}", phraseOf(target)),
    );
  },

  /**
   * The goal modal's submission — `prg:goal:<metric>:<range>` carrying the typed
   * target.
   *
   * A modal rather than a slash option, because the card is the surface now: a
   * member who has just read their pace should be able to aim at a number
   * without leaving the card to type a command whose options they would then
   * have to fill in again.
   */
  async setGoal(
    metric: string | undefined,
    range: string | undefined,
    raw: string,
    userId: string,
    guildId: string,
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    const linked = await deps.identity.resolveByDiscordId(userId);
    if (!linked.ok || linked.value === null) {
      return { ephemeral: true, text: renderFailure("NOT_LINKED") };
    }
    const target = chosen(await offered(guildId, deps), metric ?? null);
    if (target === null) return { ephemeral: true, text: C.progressionNoMetrics };

    const value = parseTarget(raw);
    if (value === null) {
      return buildProgression(userId, guildId, target, readRange(range), deps, copy.error.goal.BAD_TARGET);
    }

    const set = await deps.progression.setGoal(guildId, linked.value.minecraftUuid, target, value);
    const notice = set.ok
      ? C.goalSet.replace("{metric}", phraseOf(target)).replace("{target}", raw.trim())
      : set.error.kind === "ALREADY_THERE"
        ? copy.error.goal.ALREADY_THERE.replace("{current}", String(set.error.current))
        : copy.error.goal[set.error.kind];
    return buildProgression(userId, guildId, target, readRange(range), deps, notice);
  },
};

// ─────────────────────────────── Registry ───────────────────────────────

const progression: CommandHandler = async (ctx, deps): Promise<CommandReply> =>
  buildProgression(
    ctx.userId,
    ctx.guildId,
    ctx.args.getString("metric"),
    readRange(ctx.args.getString("range")),
    deps,
  );

export function progressionSpecs(): CommandSpec[] {
  return [
    {
      name: "progression",
      category: "PROGRESS",
      description: "Your progress over time, your goals, and the markers behind both",
      options: [
        {
          // Free text rather than a choice list: the offered set is a guild
          // setting, and a fixed list would either contradict it or force a
          // command re-registration every time somebody edits the page. The menu
          // on the card is the real chooser; this is the shortcut for a member
          // who already knows which metric they want.
          name: "metric",
          description: "Which number to chart — the card's menu lists what this server offers",
          type: "string",
        },
        {
          name: "range",
          description: "Days to look back (default 30)",
          // A choice list rather than a free number, and so a string option:
          // markers are capped at two dozen, so past a point a wider window
          // changes the label and not the picture.
          type: "string",
          choices: RANGES.map((d) => ({ name: `${d} days`, value: String(d) })),
        },
      ],
      cooldownMs: 15_000,
      // Linked-only in guild chat: every branch reads the caller's own
      // progression, which an unlinked player does not have.
      inGame: "linked",
      handler: progression,
    },
  ];
}
