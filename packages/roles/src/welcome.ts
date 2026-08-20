/**
 * Welcome, farewell and guild-join messages: the stored shape, and the
 * renderer.
 *
 * The renderer interpolates; it does not execute. The token set is closed and
 * enumerated, an unknown token renders literally, and nothing a token expands to
 * can become a mention the author did not write — a welcome message is composed
 * once by one admin and then read by the whole server every time somebody joins,
 * which makes it the highest-leverage piece of text on the platform and the one
 * least worth being clever with.
 *
 * Parsing follows the automod convention: tolerant on read so a malformed blob
 * degrades to "not configured" instead of throwing on a hot path, strict on
 * write so a typo cannot save and then read back as silence.
 */

import { isConfigChannelSlot, type ConfigChannelSlot } from "@sbr/shared-types";

export const WELCOME_SETTING_KEY = "discord.welcome";

/** Discord's own ceiling for message content; embeds allow more, text does not. */
export const MAX_TEMPLATE_LENGTH = 1_500;

/** Plain text, or the guild's branded embed. */
export const WELCOME_MODES = ["TEXT", "EMBED"] as const;
export type WelcomeMode = (typeof WELCOME_MODES)[number];

/**
 * Every token the renderer knows.
 *
 * Closed on purpose. Adding one is a deliberate act with a test; anything not
 * on this list renders as the literal characters the author typed, which is
 * the behaviour that makes a typo look like a typo rather than like an outage.
 */
export const WELCOME_TOKENS = [
  "user",
  "username",
  "server",
  "memberCount",
  "ign",
  "guildRank",
  "level",
] as const;
export type WelcomeToken = (typeof WELCOME_TOKENS)[number];

/** What a token expands to. Absent values render as an empty string. */
export type WelcomeTokenValues = Partial<Record<WelcomeToken, string>>;

/** The message posted when somebody joins the Discord server. */
export interface JoinMessage {
  readonly enabled: boolean;
  /** Which configured channel the post goes to. */
  readonly channelSlot: ConfigChannelSlot;
  readonly mode: WelcomeMode;
  readonly text: string;
  /** Sent to the joiner directly as well, if set. A closed DM is not an error. */
  readonly dm: string | null;
  /** Tidy up after N seconds, for servers that treat the channel as a doormat. */
  readonly deleteAfterSeconds: number | null;
}

/** The message posted when somebody leaves. No DM: they are gone. */
export interface LeaveMessage {
  readonly enabled: boolean;
  readonly channelSlot: ConfigChannelSlot;
  readonly text: string;
}

/** The in-game side — a different audience, a different channel, one engine. */
export interface GuildJoinMessage {
  readonly enabled: boolean;
  readonly channelSlot: ConfigChannelSlot;
  readonly text: string;
}

export interface WelcomePolicy {
  readonly join: JoinMessage;
  readonly leave: LeaveMessage;
  readonly guildJoin: GuildJoinMessage;
}

/** The slot a fresh install posts to until somebody says otherwise. */
export const WELCOME_CHANNEL_SLOT: ConfigChannelSlot = "welcome";

export const DEFAULT_WELCOME: WelcomePolicy = {
  join: {
    enabled: false,
    channelSlot: WELCOME_CHANNEL_SLOT,
    mode: "EMBED",
    text: "Welcome {user} to {server} — you're member #{memberCount}.",
    dm: null,
    deleteAfterSeconds: null,
  },
  leave: { enabled: false, channelSlot: WELCOME_CHANNEL_SLOT, text: "{username} left." },
  guildJoin: { enabled: false, channelSlot: "bridge", text: "{ign} joined the guild." },
};

// ─────────────────────────────── rendering ───────────────────────────────

/**
 * Anything that could turn text into a broadcast.
 *
 * `@everyone` and `@here` are neutered by inserting a zero-width space after
 * the `@`, which reads identically and pings nobody. Doing it in the renderer
 * rather than relying on `allowedMentions` alone is belt and braces: the
 * caller sets both, and neither one is the only thing standing between an
 * admin's typo and eight hundred notifications.
 */
const BROADCAST = /@(everyone|here)/g;

/** `{token}` — no whitespace, no nesting, no expressions. */
const TOKEN = /\{([a-zA-Z]+)\}/g;

const KNOWN = new Set<string>(WELCOME_TOKENS);

/**
 * Interpolates a template.
 *
 * Substitution happens in one pass over the source, so a value that itself
 * contains something token-shaped — a nickname of `{user}`, which people do
 * choose — is never re-scanned and cannot expand a second time.
 */
export function renderTemplate(template: string, values: WelcomeTokenValues): string {
  const rendered = template.replace(TOKEN, (whole, name: string) =>
    KNOWN.has(name) ? values[name as WelcomeToken] ?? "" : whole,
  );
  return rendered.replace(BROADCAST, "@​$1");
}

/** The tokens a template actually uses, for a panel preview or a warning. */
export function tokensUsed(template: string): readonly WelcomeToken[] {
  const found = new Set<WelcomeToken>();
  for (const match of template.matchAll(TOKEN)) {
    const name = match[1];
    if (name !== undefined && KNOWN.has(name)) found.add(name as WelcomeToken);
  }
  return [...found];
}

// ──────────────────────────────── parsing ────────────────────────────────

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.slice(0, MAX_TEMPLATE_LENGTH) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A slot nothing can bind would render the message unpostable, so an unknown
 * one reads as the default rather than as a channel that will never resolve.
 */
function slot(value: unknown, fallback: ConfigChannelSlot): ConfigChannelSlot {
  return isConfigChannelSlot(value) ? value : fallback;
}

function seconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const whole = Math.floor(value);
  // A minimum of five seconds, because "delete after 0" is a message nobody
  // ever sees and looks exactly like the feature being broken.
  if (whole < 5) return null;
  return Math.min(whole, 24 * 60 * 60);
}

/** Tolerant. Anything unreadable falls back to the default for that field. */
export function parseWelcome(raw: unknown): WelcomePolicy {
  const root = record(raw);
  const join = record(root["join"]);
  const leave = record(root["leave"]);
  const guildJoin = record(root["guildJoin"]);
  const dm = join["dm"];
  const mode = join["mode"];

  return {
    join: {
      enabled: bool(join["enabled"], DEFAULT_WELCOME.join.enabled),
      channelSlot: slot(join["channelSlot"], DEFAULT_WELCOME.join.channelSlot),
      mode: WELCOME_MODES.includes(mode as WelcomeMode) ? (mode as WelcomeMode) : DEFAULT_WELCOME.join.mode,
      text: str(join["text"], DEFAULT_WELCOME.join.text),
      dm: typeof dm === "string" && dm.trim().length > 0 ? dm.slice(0, MAX_TEMPLATE_LENGTH) : null,
      deleteAfterSeconds: seconds(join["deleteAfterSeconds"]),
    },
    leave: {
      enabled: bool(leave["enabled"], DEFAULT_WELCOME.leave.enabled),
      channelSlot: slot(leave["channelSlot"], DEFAULT_WELCOME.leave.channelSlot),
      text: str(leave["text"], DEFAULT_WELCOME.leave.text),
    },
    guildJoin: {
      enabled: bool(guildJoin["enabled"], DEFAULT_WELCOME.guildJoin.enabled),
      channelSlot: slot(guildJoin["channelSlot"], DEFAULT_WELCOME.guildJoin.channelSlot),
      text: str(guildJoin["text"], DEFAULT_WELCOME.guildJoin.text),
    },
  };
}

const SECTIONS = ["join", "leave", "guildJoin"] as const;
const FIELDS: Readonly<Record<(typeof SECTIONS)[number], readonly string[]>> = {
  join: ["enabled", "channelSlot", "mode", "text", "dm", "deleteAfterSeconds"],
  leave: ["enabled", "channelSlot", "text"],
  guildJoin: ["enabled", "channelSlot", "text"],
};

/**
 * Strict, panel-facing. Returns the first problem in words an admin can act on,
 * or null when the blob is safe to store.
 *
 * Unknown keys are rejected rather than dropped: a misspelled `chanelSlot` that
 * saved cleanly would read back as the default and be indistinguishable from a
 * setting that simply is not doing anything.
 */
export function validateWelcome(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "Welcome settings must be an object.";
  const root = raw as Record<string, unknown>;

  for (const key of Object.keys(root)) {
    if (key !== "version" && !SECTIONS.includes(key as (typeof SECTIONS)[number])) {
      return `Unknown welcome section "${key}".`;
    }
  }

  for (const section of SECTIONS) {
    const value = root[section];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `"${section}" must be an object.`;
    }
    const body = value as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (!FIELDS[section].includes(key)) return `Unknown field "${key}" in "${section}".`;
    }
    if (body["enabled"] !== undefined && typeof body["enabled"] !== "boolean") {
      return `"${section}.enabled" must be true or false.`;
    }
    const problem = checkTemplate(section, body["text"]);
    if (problem !== null) return problem;
    // Checked against the real slot list, not merely "is a string": a slot
    // nothing can bind is a message that will never post, and finding that out
    // at save time beats finding it out from a silent channel.
    if (body["channelSlot"] !== undefined && !isConfigChannelSlot(body["channelSlot"])) {
      return `"${section}.channelSlot" must name a configured channel slot.`;
    }
  }

  const join = record(root["join"]);
  if (join["mode"] !== undefined && !WELCOME_MODES.includes(join["mode"] as WelcomeMode)) {
    return `"join.mode" must be TEXT or EMBED.`;
  }
  if (join["dm"] !== undefined && join["dm"] !== null) {
    const problem = checkTemplate("join.dm", join["dm"]);
    if (problem !== null) return problem;
  }
  const after = join["deleteAfterSeconds"];
  if (after !== undefined && after !== null) {
    if (typeof after !== "number" || !Number.isInteger(after) || after < 5 || after > 24 * 60 * 60) {
      return `"join.deleteAfterSeconds" must be between 5 and 86400, or empty.`;
    }
  }

  // Enabling a section with nothing to say is the one combination that fails
  // silently at runtime, so it is worth refusing at the point of saving.
  for (const section of SECTIONS) {
    const body = record(root[section]);
    if (body["enabled"] === true && typeof body["text"] === "string" && body["text"].trim().length === 0) {
      return `"${section}" is switched on but has no message.`;
    }
  }
  return null;
}

function checkTemplate(label: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return `"${label}" must be text.`;
  if (value.length > MAX_TEMPLATE_LENGTH) {
    return `"${label}" is longer than ${String(MAX_TEMPLATE_LENGTH)} characters.`;
  }
  // Named rather than silently dropped: the author meant something by it, and
  // "{membercount} renders literally" is a surprise worth having at save time.
  for (const match of value.matchAll(TOKEN)) {
    const name = match[1];
    if (name !== undefined && !KNOWN.has(name)) {
      return `"${label}" uses an unknown token {${name}}. Known tokens: ${WELCOME_TOKENS.map((t) => `{${t}}`).join(", ")}.`;
    }
  }
  return null;
}
