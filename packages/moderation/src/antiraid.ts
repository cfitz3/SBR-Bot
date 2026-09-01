/**
 * Anti-raid: what the posture actually *does* once it is on.
 *
 * Before this module, `/antiraid-on` stored a flag and a sensitivity and
 * nothing anywhere read either of them. The posture was reported by `/safety`,
 * displayed on a card, expired by the sweep — and gated nothing. A raid arrived
 * at a server whose defence had been switched on and was let through, because
 * "HIGH sensitivity" was a string in Redis.
 *
 * The shape follows `automod.ts` deliberately, and for the same three reasons:
 *
 * **It is pure.** Everything time-dependent — how many members joined in the
 * last minute, how old this account is — arrives as a number the caller has
 * already read. The clock, Redis and the gateway stay out of the decision,
 * which is what lets the panel's dry-run box call *this* function rather than a
 * description of it.
 *
 * **It decides, it does not punish.** A decision is handed back to the caller,
 * which routes a kick or a ban through `ModerationServiceImpl.applyAction` like
 * any other action, so the audit trail, escalation and the in-game relay apply
 * without this file knowing they exist.
 *
 * **Sensitivity is a preset, not a mode.** LOW/MEDIUM/HIGH pick a starting set
 * of numbers, which a guild may then edit on the panel. Keeping sensitivity as
 * an opaque mode is what made it possible for it to mean nothing for so long:
 * there was no configuration to be wrong, so nobody noticed it was absent.
 */
import type { RaidSensitivity } from "@sbr/shared-types";

/** The `GuildSetting` key the rules are stored under. */
export const ANTIRAID_SETTING_KEY = "moderation.antiraid";

/**
 * What a gated join gets.
 *
 * `FLAG` records and notifies without touching the member — the setting a guild
 * should start on, and the reason the type exists at all. It is also what makes
 * the dry run honest: an operator can leave a new configuration on `FLAG` for a
 * week and read what it *would* have done to real arrivals.
 */
export type RaidJoinAction = "ALLOW" | "FLAG" | "KICK" | "BAN";

export const RAID_JOIN_ACTIONS: readonly RaidJoinAction[] = ["ALLOW", "FLAG", "KICK", "BAN"];

export interface AntiRaidRules {
  /**
   * Whether the posture may engage at all.
   *
   * Separate from `autoEngage`: off means `/antiraid on` still works and still
   * gates joins, it just never turns itself on. A guild that wants the manual
   * switch and nothing automatic sets `autoEngage: false`; a guild that wants
   * the whole feature dormant sets this.
   */
  readonly enabled: boolean;
  /** Joins inside the window that count as a raid, for `autoEngage`. */
  readonly burst: { readonly joins: number; readonly windowSeconds: number };
  /** Engage the posture by itself on a burst, rather than waiting for a human. */
  readonly autoEngage: boolean;
  /**
   * Accounts younger than this are gated while the posture is on.
   *
   * Hours rather than days because the number that matters during a raid is
   * small: throwaway accounts made for the raid are minutes old, and a guild
   * asking for "at least a week" is asking a different question — screening's.
   */
  readonly minAccountAgeHours: number;
  /** Gate accounts still on Discord's default avatar. */
  readonly requireAvatar: boolean;
  /** What a gated join gets while the posture is on. */
  readonly joinAction: RaidJoinAction;
  /**
   * Lift the posture by itself after this many minutes. Null keeps it on until
   * a human lifts it, which is the right default for a manual switch and the
   * wrong one for an automatic engage — hence a number, not a boolean.
   */
  readonly autoLiftMinutes: number | null;
  /** Also lock the server down when the posture engages. */
  readonly lockdownOnEngage: boolean;
}

/**
 * The presets behind the three sensitivities.
 *
 * These are the "sane defaults" the overhaul was asked to keep, written down
 * for the first time. The gradient is deliberately in the *thresholds* and not
 * in the action: every preset flags rather than kicks, because a defence whose
 * default is to remove people is one bad threshold away from removing a school
 * class that all joined at lunchtime. A guild that wants a kick chooses it.
 */
export function defaultRules(sensitivity: RaidSensitivity): AntiRaidRules {
  const base = {
    enabled: true,
    autoEngage: true,
    requireAvatar: false,
    joinAction: "FLAG" as RaidJoinAction,
    lockdownOnEngage: false,
  };
  switch (sensitivity) {
    case "LOW":
      return {
        ...base,
        burst: { joins: 15, windowSeconds: 60 },
        minAccountAgeHours: 24,
        autoLiftMinutes: 30,
      };
    case "HIGH":
      return {
        ...base,
        burst: { joins: 5, windowSeconds: 60 },
        minAccountAgeHours: 24 * 7,
        requireAvatar: true,
        autoLiftMinutes: 120,
        lockdownOnEngage: true,
      };
    case "MEDIUM":
    default:
      return {
        ...base,
        burst: { joins: 8, windowSeconds: 60 },
        minAccountAgeHours: 24 * 2,
        autoLiftMinutes: 60,
      };
  }
}

/** What the guild gets before it has configured anything. */
export const DEFAULT_ANTIRAID: AntiRaidRules = defaultRules("MEDIUM");

const MAX_BURST_JOINS = 200;
const MAX_BURST_WINDOW_SECONDS = 3_600;
/** A year. Past this the question is screening's, not a raid defence's. */
const MAX_ACCOUNT_AGE_HOURS = 24 * 365;
const MAX_AUTO_LIFT_MINUTES = 24 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A whole number in range, or null when the stored value is unusable. */
function count(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value < min || value > max ? null : value;
}

/**
 * Stored JSON → rules, with the defaults underneath every field.
 *
 * Field-at-a-time rather than all-or-nothing: a guild that stored a burst
 * threshold before a later release added `requireAvatar` keeps its threshold
 * and gets the default for the new field, instead of silently reverting to the
 * preset because one key was missing.
 */
export function parseAntiRaid(raw: unknown, sensitivity: RaidSensitivity = "MEDIUM"): AntiRaidRules {
  const base = defaultRules(sensitivity);
  if (!isRecord(raw)) return base;

  const burstRaw = isRecord(raw["burst"]) ? raw["burst"] : {};
  const joins = count(burstRaw["joins"], 2, MAX_BURST_JOINS);
  const windowSeconds = count(burstRaw["windowSeconds"], 5, MAX_BURST_WINDOW_SECONDS);
  const minAccountAgeHours = count(raw["minAccountAgeHours"], 0, MAX_ACCOUNT_AGE_HOURS);
  const joinAction = raw["joinAction"];
  const autoLift = raw["autoLiftMinutes"];

  return {
    enabled: typeof raw["enabled"] === "boolean" ? raw["enabled"] : base.enabled,
    burst: {
      joins: joins ?? base.burst.joins,
      windowSeconds: windowSeconds ?? base.burst.windowSeconds,
    },
    autoEngage: typeof raw["autoEngage"] === "boolean" ? raw["autoEngage"] : base.autoEngage,
    minAccountAgeHours: minAccountAgeHours ?? base.minAccountAgeHours,
    requireAvatar: typeof raw["requireAvatar"] === "boolean" ? raw["requireAvatar"] : base.requireAvatar,
    joinAction:
      typeof joinAction === "string" && (RAID_JOIN_ACTIONS as readonly string[]).includes(joinAction)
        ? (joinAction as RaidJoinAction)
        : base.joinAction,
    // Null is a real answer here — "stays on until lifted" — so it is taken
    // before the range check rather than falling through to the default.
    autoLiftMinutes:
      autoLift === null ? null : (count(autoLift, 1, MAX_AUTO_LIFT_MINUTES) ?? base.autoLiftMinutes),
    lockdownOnEngage:
      typeof raw["lockdownOnEngage"] === "boolean" ? raw["lockdownOnEngage"] : base.lockdownOnEngage,
  };
}

/** What the caller has already read about an arriving member. */
export interface JoinContext {
  /** How old the Discord account is. Fractions are fine; raids arrive in minutes. */
  readonly accountAgeHours: number;
  readonly hasAvatar: boolean;
  /** Joins in the burst window, this one included. */
  readonly joinsInWindow: number;
  /** Whether the posture is currently on, however it got there. */
  readonly postureActive: boolean;
}

export interface JoinDecision {
  readonly action: RaidJoinAction;
  /** Why, in the order the rules were checked. Empty when nothing gated. */
  readonly reasons: readonly string[];
  /** Whether this join would engage the posture that is not yet on. */
  readonly engages: boolean;
}

export const ALLOW_JOIN: JoinDecision = { action: "ALLOW", reasons: [], engages: false };

/** Would this many joins in the window engage the posture? */
export function burstReached(rules: AntiRaidRules, joinsInWindow: number): boolean {
  return joinsInWindow >= rules.burst.joins;
}

function hours(value: number): string {
  if (value < 1) return `${String(Math.round(value * 60))}m`;
  if (value < 48) return `${String(Math.round(value))}h`;
  return `${String(Math.round(value / 24))}d`;
}

/**
 * One arriving member, against the rules.
 *
 * The posture gate comes first and nothing is checked behind it: outside a
 * raid, a two-hour-old account with no avatar is a new Discord user, and the
 * whole design of the feature is that it costs them nothing until the server is
 * actually under attack. `engages` is reported separately from `action` because
 * the join that trips the burst is itself subject to the rules once the posture
 * it triggered is on — the caller applies both, in that order.
 */
export function evaluateJoin(rules: AntiRaidRules, ctx: JoinContext): JoinDecision {
  if (!rules.enabled) return ALLOW_JOIN;

  const engages = !ctx.postureActive && rules.autoEngage && burstReached(rules, ctx.joinsInWindow);
  if (!ctx.postureActive && !engages) return ALLOW_JOIN;

  const reasons: string[] = [];
  if (ctx.accountAgeHours < rules.minAccountAgeHours) {
    reasons.push(
      `account is ${hours(ctx.accountAgeHours)} old, under the ${hours(rules.minAccountAgeHours)} minimum`,
    );
  }
  if (rules.requireAvatar && !ctx.hasAvatar) reasons.push("no profile picture set");

  if (reasons.length === 0) return { action: "ALLOW", reasons: [], engages };
  return { action: rules.joinAction, reasons, engages };
}

// ── the dry run ──────────────────────────────────────────────────────────────

/** One synthetic arrival in a simulated raid. */
export interface SimulatedJoin {
  readonly accountAgeHours: number;
  readonly hasAvatar: boolean;
}

export interface SimulatedOutcome {
  /** 1-based, so it reads as "the 6th member to arrive". */
  readonly at: number;
  readonly action: RaidJoinAction;
  readonly reasons: readonly string[];
}

export interface RaidSimulation {
  /** Which arrival engaged the posture, 1-based, or null if none did. */
  readonly engagedAt: number | null;
  readonly outcomes: readonly SimulatedOutcome[];
  /** How many of each action the run produced, `ALLOW` included. */
  readonly totals: Readonly<Record<RaidJoinAction, number>>;
}

/**
 * Replay a burst of arrivals through the rules and report what each one gets.
 *
 * Every join is treated as inside the burst window, which is what a raid is;
 * simulating the window's edges would model the clock rather than the rules,
 * and the question this harness answers is "are my numbers right", not "what
 * happens if they arrive slowly".
 *
 * `postureActive` lets an operator ask the other question — what the posture
 * does to ordinary arrivals once it is already on — which is the case that
 * actually catches people out, because it is the one that runs for an hour
 * after the raid is over.
 */
export function simulateRaid(
  rules: AntiRaidRules,
  joins: readonly SimulatedJoin[],
  postureActive = false,
): RaidSimulation {
  const totals: Record<RaidJoinAction, number> = { ALLOW: 0, FLAG: 0, KICK: 0, BAN: 0 };
  const outcomes: SimulatedOutcome[] = [];
  let active = postureActive;
  let engagedAt: number | null = null;

  for (const [index, join] of joins.entries()) {
    const decision = evaluateJoin(rules, {
      accountAgeHours: join.accountAgeHours,
      hasAvatar: join.hasAvatar,
      joinsInWindow: index + 1,
      postureActive: active,
    });
    if (decision.engages && engagedAt === null) {
      engagedAt = index + 1;
      active = true;
    }
    totals[decision.action] += 1;
    outcomes.push({ at: index + 1, action: decision.action, reasons: decision.reasons });
  }

  return { engagedAt, outcomes, totals };
}

/**
 * A sentence describing what the rules do, for the panel and the `/antiraid`
 * card. Written here rather than in either caller so the two cannot disagree
 * about what the same configuration means.
 */
export function describeRules(rules: AntiRaidRules): string {
  if (!rules.enabled) return "Anti-raid is switched off. Nothing gates a join.";
  const gate =
    rules.minAccountAgeHours === 0 && !rules.requireAvatar
      ? "no account is gated"
      : [
          rules.minAccountAgeHours === 0 ? null : `accounts under ${hours(rules.minAccountAgeHours)} old`,
          rules.requireAvatar ? "accounts with no profile picture" : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" and ");
  const trip = rules.autoEngage
    ? `${String(rules.burst.joins)} joins in ${String(rules.burst.windowSeconds)}s turns it on`
    : "it only turns on when staff switch it on";
  const lift =
    rules.autoLiftMinutes === null
      ? "it stays on until lifted"
      : `it lifts itself after ${String(rules.autoLiftMinutes)} minutes`;
  const action =
    rules.joinAction === "ALLOW"
      ? "and they are let in anyway"
      : `and they are ${rules.joinAction.toLowerCase() === "flag" ? "flagged for staff" : `${rules.joinAction.toLowerCase()}ed`}`;
  return `${trip}. While on, ${gate} ${action}. Then ${lift}.`;
}
