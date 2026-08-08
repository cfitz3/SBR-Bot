/**
 * Transport-agnostic presentation types.
 *
 * The same command logic has to render three ways: a rich Discord embed, a
 * single ~256-character line in Minecraft guild chat, and plain JSON for the web
 * panel (COMMANDS.md §17). So handlers return a *view model* and each transport
 * renders it — a handler that built `EmbedBuilder` directly could only ever
 * serve Discord.
 *
 * Colours and button styles are semantic rather than hex/enum values for the
 * same reason: `DANGER` means something in guild chat too, `0xED4245` does not.
 */
import type { DataEnvelope } from "./common.js";

export type ViewColor = "NEUTRAL" | "INFO" | "SUCCESS" | "WARNING" | "DANGER";

export interface EmbedFieldView {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

export interface EmbedView {
  readonly title?: string;
  readonly description?: string;
  readonly fields?: readonly EmbedFieldView[];
  /** Usually the staleness note — see `stalenessFooter`. */
  readonly footer?: string;
  readonly color?: ViewColor;
  readonly thumbnailUrl?: string;
  readonly url?: string;
}

export type ButtonStyle = "PRIMARY" | "SECONDARY" | "SUCCESS" | "DANGER" | "LINK";

export interface ButtonView {
  readonly label: string;
  readonly style: ButtonStyle;
  /**
   * Routed by the transport's component router. Encode all the state the handler
   * needs (`rsvp:<eventId>:GOING`) rather than holding it in memory — buttons
   * outlive the process that sent them.
   */
  readonly customId?: string;
  /** LINK buttons carry a url instead of a customId. */
  readonly url?: string;
  readonly emoji?: string;
  readonly disabled?: boolean;
}

export interface ActionRowView {
  readonly buttons: readonly ButtonView[];
}

/** Render an embed down to one line, for guild chat and plain-text fallbacks. */
export function flattenEmbed(embed: EmbedView, maxLength = 256): string {
  const parts: string[] = [];
  if (embed.title) parts.push(embed.title);
  if (embed.description) parts.push(embed.description);
  for (const field of embed.fields ?? []) parts.push(`${field.name} ${field.value}`);

  const line = parts.join(" | ").replace(/\s+/g, " ").trim();
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
}

/** "4m", "2h", "3d" — compact enough for an embed footer or a chat line. */
export function describeAge(fetchedAt: string, now: number = Date.now()): string {
  const ms = now - Date.parse(fetchedAt);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The documented "as of Xm ago" note. STALE data says so explicitly — serving
 * old numbers silently is worse than serving them with a caveat.
 */
export function stalenessFooter<T>(envelope: DataEnvelope<T>, now: number = Date.now()): string {
  const age = describeAge(envelope.fetchedAt, now);
  if (envelope.freshness === "STALE") return `⚠ cached data — as of ${age}`;
  return envelope.source === "LIVE" ? `as of ${age}` : `cached — as of ${age}`;
}
