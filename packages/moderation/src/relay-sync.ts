/**
 * Relay punishment sync: what a Discord moderation action does in guild chat.
 *
 * The two surfaces are one community. A member muted in Discord for what they
 * said keeps saying it in guild chat, and the staffer who muted them has to
 * remember to open Minecraft and do it again — which is exactly the kind of
 * second step that gets skipped at 2am. This module turns the mapping into
 * configuration: one row per Discord action, each naming the in-game command it
 * should produce.
 *
 * It is pure. Resolving a mapping is a string calculation over stored JSON, and
 * keeping it free of the bus, the identity lookup and the clock is what lets the
 * whole table be unit-tested and, later, previewed in the panel before anybody
 * arms it.
 *
 * Two decisions worth stating:
 *
 * - **A mapping never invents a punishment the Discord side did not carry.**
 *   `durationMode: "same"` means literally the same seconds; a fixed duration is
 *   opt-in per row. There is no "escalate in game" mode, because a member should
 *   be able to read their punishment off one number.
 * - **`g mute` with no duration is not expressible**, so a row that resolves to
 *   an unbounded mute produces no command at all rather than a permanent one.
 *   Hypixel requires a time argument; guessing one would be this module deciding
 *   a punishment length nobody configured.
 */
import type { ModActionType } from "@sbr/shared-types";

/** The Discord-side actions a mapping row can be written against. */
export type RelayDiscordAction = Extract<
  ModActionType,
  "WARN" | "MUTE" | "UNMUTE" | "KICK" | "BAN" | "UNBAN"
>;

/**
 * The in-game side. Deliberately a closed set of guild commands rather than a
 * free-text template: this string is handed to an account with guild-officer
 * permissions, and a configurable command line is a configurable way to demote
 * the whole guild.
 */
export type RelayGameAction = "none" | "g mute" | "g unmute" | "g kick";

export type RelayDurationMode = "same" | "fixed";

export interface RelaySyncRow {
  readonly discordAction: RelayDiscordAction;
  readonly gameAction: RelayGameAction;
  /** "same" mirrors the Discord duration; "fixed" always uses `fixedSeconds`. */
  readonly durationMode: RelayDurationMode;
  readonly fixedSeconds: number | null;
  readonly enabled: boolean;
}

export interface RelaySyncPolicy {
  /** The master switch. Off means no Discord action reaches guild chat at all. */
  readonly enabled: boolean;
  readonly rows: readonly RelaySyncRow[];
}

/** The `GuildSetting` key this policy is stored under. */
export const RELAY_SYNC_SETTING_KEY = "moderation.relay-sync";

export const RELAY_DISCORD_ACTIONS: readonly RelayDiscordAction[] = [
  "WARN",
  "MUTE",
  "UNMUTE",
  "KICK",
  "BAN",
  "UNBAN",
];

export const RELAY_GAME_ACTIONS: readonly RelayGameAction[] = ["none", "g mute", "g unmute", "g kick"];

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Hypixel refuses guild mutes longer than 30 days, so a longer one is clamped. */
export const MAX_GAME_MUTE_SECONDS = 30 * DAY;

/**
 * The platform's opinion, on by default.
 *
 * A warning maps to a short mute rather than nothing because a warning is the
 * one action with no in-game equivalent, and a member who is only ever warned in
 * Discord learns that guild chat is the place with no consequences. Ten minutes
 * is a pause, not a punishment.
 *
 * A Discord ban maps to a guild kick rather than to nothing: there is no guild
 * ban, and leaving a banned member in the guild roster is how somebody removed
 * from the community keeps their GEXP and their invite. `UNBAN` maps to nothing
 * because a kick cannot be undone by a command — re-inviting is a human decision.
 * `KICK` maps to nothing for the same reason a Discord kick is not a ban: it is
 * a "come back when you have calmed down", not an expulsion.
 */
export const DEFAULT_RELAY_SYNC: RelaySyncPolicy = {
  enabled: true,
  rows: [
    { discordAction: "WARN", gameAction: "g mute", durationMode: "fixed", fixedSeconds: 10 * MINUTE, enabled: true },
    { discordAction: "MUTE", gameAction: "g mute", durationMode: "same", fixedSeconds: null, enabled: true },
    { discordAction: "UNMUTE", gameAction: "g unmute", durationMode: "same", fixedSeconds: null, enabled: true },
    { discordAction: "KICK", gameAction: "none", durationMode: "same", fixedSeconds: null, enabled: true },
    { discordAction: "BAN", gameAction: "g kick", durationMode: "same", fixedSeconds: null, enabled: true },
    { discordAction: "UNBAN", gameAction: "none", durationMode: "same", fixedSeconds: null, enabled: true },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiscordAction(value: unknown): value is RelayDiscordAction {
  return typeof value === "string" && (RELAY_DISCORD_ACTIONS as readonly string[]).includes(value);
}

function isGameAction(value: unknown): value is RelayGameAction {
  return typeof value === "string" && (RELAY_GAME_ACTIONS as readonly string[]).includes(value);
}

function parseRow(value: unknown): RelaySyncRow | null {
  if (!isRecord(value)) return null;
  const discordAction = value["discordAction"];
  const gameAction = value["gameAction"];
  if (!isDiscordAction(discordAction) || !isGameAction(gameAction)) return null;

  const durationMode: RelayDurationMode = value["durationMode"] === "fixed" ? "fixed" : "same";
  const fixedRaw = value["fixedSeconds"];
  const fixedSeconds =
    typeof fixedRaw === "number" && Number.isFinite(fixedRaw) && fixedRaw > 0
      ? Math.min(Math.floor(fixedRaw), MAX_GAME_MUTE_SECONDS)
      : null;

  // A fixed-duration row with no duration is not a row, it is a half-finished
  // edit. Dropping it falls back to the default for that action rather than
  // producing a mute of zero seconds.
  if (durationMode === "fixed" && fixedSeconds === null && gameAction === "g mute") return null;

  return {
    discordAction,
    gameAction,
    durationMode,
    fixedSeconds,
    enabled: value["enabled"] !== false,
  };
}

/**
 * Read a stored policy, falling back row by row.
 *
 * Unreadable rows are treated as absent rather than as an error, exactly as the
 * escalation ladder does: this is hand-editable JSON, and a guild whose row got
 * mangled should get the platform default for that one action, not a sync that
 * silently stops working.
 */
export function parseRelaySync(raw: unknown): RelaySyncPolicy {
  if (!isRecord(raw)) return DEFAULT_RELAY_SYNC;

  const enabled = typeof raw["enabled"] === "boolean" ? raw["enabled"] : DEFAULT_RELAY_SYNC.enabled;
  const rowsRaw = raw["rows"];
  const overrides = Array.isArray(rowsRaw)
    ? rowsRaw.map(parseRow).filter((r): r is RelaySyncRow => r !== null)
    : [];

  return { enabled, rows: resolveRows(overrides) };
}

/**
 * Layer guild rows over the defaults by action, the way the escalation ladder
 * layers by warn count: changing what a ban does in game should not require
 * restating what a warning does.
 */
export function resolveRows(overrides: readonly RelaySyncRow[]): readonly RelaySyncRow[] {
  const byAction = new Map(DEFAULT_RELAY_SYNC.rows.map((row) => [row.discordAction, row]));
  for (const row of overrides) byAction.set(row.discordAction, row);
  return RELAY_DISCORD_ACTIONS.map((action) => byAction.get(action)).filter(
    (row): row is RelaySyncRow => row !== undefined,
  );
}

export interface RelayCommandInput {
  readonly type: ModActionType;
  /** The target's in-game name. Null when they have no verified link. */
  readonly ign: string | null;
  readonly durationSeconds: number | null;
  /** Why the punishment was issued. Hypixel refuses a `/g kick` without one. */
  readonly reason: string;
}

/**
 * What to do with one action, in game.
 *
 * Three answers, not two, because "the mapping says send nothing" and "the
 * mapping says send something and we cannot build it" were both `null` before
 * and both landed on the case as `NOT_REQUIRED`. A ban whose target never
 * linked an account read exactly like a warning that was never meant to relay,
 * and the guild slot stayed filled with nobody the wiser.
 */
export type GameCommandPlan =
  /** Type this line in guild chat. */
  | { readonly kind: "send"; readonly command: string }
  /** Nothing was owed. Not a failure, and not worth alerting anyone about. */
  | { readonly kind: "skip"; readonly why: string }
  /** Something was owed and could not be built. The case must say so. */
  | { readonly kind: "blocked"; readonly why: string };

/** The longest reason Hypixel will carry on one command. */
export const MAX_GAME_REASON_LENGTH = 64;

/**
 * Everything outside the set Hypixel accepts on a guild command, including
 * newlines and the leading slash that would turn a reason into a command.
 */
const UNSENDABLE = /[^A-Za-z0-9 .,!?'()_-]+/g;

/**
 * Reduce a moderation reason to something typable in guild chat.
 *
 * Stripped rather than rejected: a Discord reason is free text up to 500
 * characters and routinely carries a link, an emoji or a case id, and refusing
 * the whole punishment over a curly quote would be worse than sending a
 * slightly plainer sentence. Null only when nothing at all survives — at which
 * point there is genuinely no reason to send, and `/g kick` needs one.
 */
export function sanitizeGameReason(raw: string): string | null {
  const cleaned = raw.replace(UNSENDABLE, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length <= MAX_GAME_REASON_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_GAME_REASON_LENGTH).trimEnd();
}

/** The guild-chat command this action should produce, and why, if it produces none. */
export function resolveGameCommand(policy: RelaySyncPolicy, input: RelayCommandInput): GameCommandPlan {
  if (!policy.enabled) return { kind: "skip", why: "relay sync is off for this guild" };
  if (!isDiscordAction(input.type)) {
    return { kind: "skip", why: "this action maps to no guild command" };
  }

  const row = policy.rows.find((r) => r.discordAction === input.type);
  if (row === undefined || !row.enabled || row.gameAction === "none") {
    return { kind: "skip", why: "this action maps to no guild command" };
  }

  // An unlinked target is a skip, not a failure. Nothing verified their
  // account, so the roles sync never gave them a guild slot either - there is
  // genuinely nothing in game to act on, and alerting staff on every ban of a
  // Discord-only member would bury the alerts that mean something.
  const ign = input.ign === null ? "" : input.ign.trim();
  if (ign.length === 0) {
    return { kind: "skip", why: "target has no linked Minecraft account, so nothing was sent in game" };
  }

  // Past here a command is owed, so every remaining gap is a failure to report
  // rather than a quiet no-op.

  if (row.gameAction === "g kick") {
    const reason = sanitizeGameReason(input.reason);
    if (reason === null) {
      return { kind: "blocked", why: "/g kick needs a reason and this one has nothing Hypixel accepts" };
    }
    return { kind: "send", command: `/g kick ${ign} ${reason}` };
  }

  // `/g mute` takes `<name> <time>` and nothing else. A reason appended here is
  // read as part of the duration argument, so it is deliberately left off.
  if (row.gameAction !== "g mute") return { kind: "send", command: `/${row.gameAction} ${ign}` };

  const seconds =
    row.durationMode === "fixed" ? row.fixedSeconds : (input.durationSeconds ?? row.fixedSeconds);
  if (seconds === null || seconds <= 0) {
    return { kind: "blocked", why: "an unbounded mute has no in-game equivalent and the row sets no fixed time" };
  }

  return { kind: "send", command: `/g mute ${ign} ${formatGameDuration(seconds)}` };
}

/**
 * Hypixel's duration argument: an integer and a unit, no compounds.
 *
 * Rounded to the nearest whole unit that does not overstate the punishment —
 * 90 minutes becomes `90m`, not `1h` — because the number a member is told and
 * the number they serve should be the same one.
 */
export function formatGameDuration(seconds: number): string {
  const clamped = Math.min(Math.max(Math.floor(seconds), 1), MAX_GAME_MUTE_SECONDS);
  if (clamped % DAY === 0) return `${clamped / DAY}d`;
  if (clamped % HOUR === 0) return `${clamped / HOUR}h`;
  if (clamped % MINUTE === 0) return `${clamped / MINUTE}m`;
  return `${clamped}s`;
}
