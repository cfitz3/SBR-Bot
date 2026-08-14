/**
 * Placeholder expansion for channel names and opening messages.
 *
 * Two rules run through everything here:
 *
 *   1. **An unknown placeholder is left alone.** Replacing `{foo}` with an empty
 *      string hides the typo; leaving it visible in the channel name is how an
 *      admin finds out they wrote one.
 *   2. **A statistic with no data renders as "—", never as 0.** `{avgResponseTime}`
 *      showing `0s` on a guild that has never answered a ticket is a lie the
 *      operator would act on.
 */

/** Everything a template may interpolate. */
export interface NamingContext {
  /** The ticket's per-guild sequence number. */
  readonly number: number;
  /** The opener's Discord username. */
  readonly username: string;
  /** The opener's server nickname, or their username when they have none. */
  readonly nickname: string;
  /** Mean feedback rating, 1–5. Null until anyone has rated. */
  readonly avgRating: number | null;
  /** Mean ms from open to first staff reply. Null until staff have answered. */
  readonly avgResponseTimeMs: number | null;
  /** Mean ms from open to close. Null until anything has closed. */
  readonly avgResolutionTimeMs: number | null;
}

/** What "we do not know" looks like everywhere in this module. */
export const UNKNOWN = "—";

/**
 * A coarse, human duration: "3m", "2h", "4d".
 *
 * Deliberately not precise. This is prose in an opening message, and "1h 47m
 * 12s" reads as a measurement rather than as an expectation.
 */
export function humanDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return UNKNOWN;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function values(ctx: NamingContext): Readonly<Record<string, string>> {
  const num = String(ctx.number);
  return {
    num,
    number: num,
    name: ctx.username,
    username: ctx.username,
    nick: ctx.nickname,
    nickname: ctx.nickname,
    avgRating: ctx.avgRating === null ? UNKNOWN : ctx.avgRating.toFixed(1),
    avgResponseTime: humanDuration(ctx.avgResponseTimeMs),
    avgResolutionTime: humanDuration(ctx.avgResolutionTimeMs),
  };
}

/** Every placeholder a template may use. Exported for the panel's field hint. */
export const PLACEHOLDERS: readonly string[] = [
  "num",
  "number",
  "name",
  "username",
  "nick",
  "nickname",
  "avgRating",
  "avgResponseTime",
  "avgResolutionTime",
];

/** Expand `{placeholder}` occurrences. Unknown names are left as written. */
export function expand(template: string, ctx: NamingContext): string {
  const map = values(ctx);
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => map[key] ?? whole);
}

/**
 * Expand a template into something Discord will accept as a channel name.
 *
 * Discord lowercases and mangles the name itself if we don't, so doing it here
 * means the stored `Ticket.channelId` and the name an admin sees in the panel
 * agree with what is actually in the sidebar. Anything that reduces to nothing
 * falls back to `ticket-<num>` rather than to an empty name Discord rejects.
 */
export function channelName(template: string, ctx: NamingContext): string {
  const raw = expand(template, ctx)
    .toLowerCase()
    .normalize("NFKD")
    // Emoji and accents survive in Discord channel names, but they make the
    // name unsearchable and inconsistent between clients. ASCII-ish is kinder.
    .replace(/[^a-z0-9-_ ]+/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = raw === "" ? `ticket-${ctx.number}` : raw;
  return name.length <= 100 ? name : name.slice(0, 100).replace(/-+$/, "");
}
