/**
 * Auto-warn escalation: what happens when warnings keep arriving.
 *
 * A warning is only worth issuing if the third one means something different
 * from the first. Left to staff memory, it doesn't: nobody counts back through
 * an audit log before typing `/warn`, so a member can collect warnings
 * indefinitely and the ladder exists only in the head of whichever staffer
 * happens to be online. This module turns that into a rule the platform applies
 * the moment the warning lands.
 *
 * Three decisions are worth stating, because each has a wrong-looking
 * alternative:
 *
 * - **A rung fires on the warning that reaches it, not on every warning past
 *   it.** A member at four warnings against rungs of 3 and 5 is not re-muted by
 *   warning number four. Since a count only ever climbs by one per warning, an
 *   exact match fires each rung exactly once.
 * - **Warnings age out.** Counting a member's whole history means one bad week
 *   two years ago sits between them and a ban forever. The window is what makes
 *   the ladder a description of current behaviour.
 * - **Guild rungs are layered over the defaults by warn count**, the same way
 *   milestone definitions and ticket types layer: a guild that wants its own
 *   3-warning rung replaces that one and keeps the rest, rather than having to
 *   restate a whole ladder to change one line.
 */
import type { ModActionType, ModerationActionDTO } from "@sbr/shared-types";

/** The subset of actions an escalation may apply. Both are reversible. */
export type EscalationAction = Extract<ModActionType, "MUTE" | "BAN">;

export interface EscalationRung {
  /** The warning count, within the window, that triggers this rung. */
  readonly warns: number;
  readonly action: EscalationAction;
  /** Null means permanent — only meaningful for a BAN; a mute must be timed. */
  readonly durationSeconds: number | null;
  readonly source: "DEFAULT" | "GUILD";
}

/** How far back warnings count, unless a guild says otherwise. */
export const DEFAULT_ESCALATION_WINDOW_DAYS = 90;

/** The `GuildSetting` key the guild's ladder is stored under. */
export const ESCALATION_SETTING_KEY = "moderation.escalation";

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * The platform's opinion, for a guild that has never configured one.
 *
 * Deliberately slow at the bottom and deliberately not permanent at the top: a
 * ban a bot decided on should still be a ban a staffer can look at afterwards,
 * so the top rung is a week rather than forever.
 */
export const DEFAULT_LADDER: readonly EscalationRung[] = [
  { warns: 3, action: "MUTE", durationSeconds: HOUR, source: "DEFAULT" },
  { warns: 5, action: "MUTE", durationSeconds: DAY, source: "DEFAULT" },
  { warns: 7, action: "BAN", durationSeconds: 7 * DAY, source: "DEFAULT" },
];

/** A guild's stored policy, as it comes back out of the settings KV. */
export interface EscalationPolicy {
  readonly enabled: boolean;
  readonly windowDays: number;
  readonly rungs: readonly EscalationRung[];
}

export const DEFAULT_POLICY: EscalationPolicy = {
  enabled: true,
  windowDays: DEFAULT_ESCALATION_WINDOW_DAYS,
  rungs: DEFAULT_LADDER,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRung(value: unknown): EscalationRung | null {
  if (!isRecord(value)) return null;
  const warns = value["warns"];
  const action = value["action"];
  const duration = value["durationSeconds"];
  if (typeof warns !== "number" || !Number.isInteger(warns) || warns < 1) return null;
  if (action !== "MUTE" && action !== "BAN") return null;
  const durationSeconds =
    duration === null || duration === undefined ? null : typeof duration === "number" && duration > 0 ? duration : NaN;
  if (Number.isNaN(durationSeconds)) return null;
  // A mute with no end is not a thing the mute path will accept, and silently
  // storing one would produce a rung that fails every time it fires.
  if (action === "MUTE" && durationSeconds === null) return null;
  return { warns, action, durationSeconds, source: "GUILD" };
}

/**
 * Read a stored policy, falling back rung by rung.
 *
 * Anything unreadable is treated as absent rather than as an error: the setting
 * is hand-editable JSON, and a guild whose policy row got mangled should get the
 * platform default ladder, not an escalation path that silently stops working.
 */
export function parsePolicy(raw: unknown): EscalationPolicy {
  if (!isRecord(raw)) return DEFAULT_POLICY;

  const enabled = typeof raw["enabled"] === "boolean" ? raw["enabled"] : DEFAULT_POLICY.enabled;
  const windowRaw = raw["windowDays"];
  const windowDays =
    typeof windowRaw === "number" && Number.isFinite(windowRaw) && windowRaw > 0
      ? Math.min(Math.floor(windowRaw), 365)
      : DEFAULT_ESCALATION_WINDOW_DAYS;

  const rungsRaw = raw["rungs"];
  const overrides = Array.isArray(rungsRaw)
    ? rungsRaw.map(parseRung).filter((r): r is EscalationRung => r !== null)
    : [];

  return { enabled, windowDays, rungs: resolveLadder(overrides) };
}

/**
 * Layer guild rungs over the built-in ones, keyed by warn count.
 *
 * A guild rung with a count that matches a default replaces it; one with a new
 * count is added. There is no way to *remove* a default rung here, which is on
 * purpose for now — `enabled: false` turns the whole ladder off, and a policy
 * that could half-delete itself is a harder thing to reason about than one that
 * is either the defaults, your edits, or nothing.
 */
export function resolveLadder(overrides: readonly EscalationRung[]): readonly EscalationRung[] {
  const byWarns = new Map<number, EscalationRung>();
  for (const rung of DEFAULT_LADDER) byWarns.set(rung.warns, rung);
  for (const rung of overrides) byWarns.set(rung.warns, { ...rung, source: "GUILD" });
  return [...byWarns.values()].sort((a, b) => a.warns - b.warns);
}

/**
 * How many warnings this member has collected inside the window.
 *
 * Takes the rows rather than fetching them so the counting rule is testable
 * without a store, and so the caller decides how far back to query.
 */
export function countWarnsInWindow(
  actions: readonly Pick<ModerationActionDTO, "type" | "createdAt">[],
  windowDays: number,
  now: Date = new Date(),
): number {
  const cutoff = now.getTime() - windowDays * DAY * 1000;
  let count = 0;
  for (const action of actions) {
    if (action.type !== "WARN") continue;
    if (Date.parse(action.createdAt) >= cutoff) count += 1;
  }
  return count;
}

/**
 * The rung this warning count lands on, or null if it lands between rungs.
 *
 * Exact match rather than "highest rung at or below": see the module note — a
 * fourth warning must not re-fire the third-warning mute.
 */
export function rungFor(ladder: readonly EscalationRung[], warnCount: number): EscalationRung | null {
  return ladder.find((rung) => rung.warns === warnCount) ?? null;
}

const ESCALATION_REASON_PREFIX = "Automatic escalation:";

/** The audit reason an auto-escalation writes. Staff read this in `/audit`. */
export function escalationReason(warnCount: number, windowDays: number): string {
  return `${ESCALATION_REASON_PREFIX} ${warnCount} warning${warnCount === 1 ? "" : "s"} in ${windowDays} days`;
}

/**
 * Whether a logged action was the ladder's doing rather than a staffer's.
 *
 * Read off the reason because that is the only thing distinguishing the two —
 * an escalation is a real action by the warning staffer, deliberately, so there
 * is no separate actor to check. Kept beside the writer so the two strings
 * cannot drift apart.
 */
export function isEscalation(reason: string): boolean {
  return reason.startsWith(ESCALATION_REASON_PREFIX);
}

/** One line of "here is your ladder", for a config readout. */
export function describeRung(rung: EscalationRung): string {
  const how =
    rung.durationSeconds === null
      ? "permanently"
      : rung.durationSeconds % DAY === 0
        ? `for ${rung.durationSeconds / DAY}d`
        : `for ${Math.round(rung.durationSeconds / HOUR)}h`;
  return `${rung.warns} warnings → ${rung.action.toLowerCase()} ${how}`;
}
