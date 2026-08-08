/**
 * Pure display formatting. No DOM, so it can be unit-tested like any other
 * module in the repo.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Thousands-separated, with a dash for "no value" so a column stays scannable. */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US");
}

/**
 * A coarse "how long ago", biased to the largest useful unit.
 *
 * Deliberately not a live-updating clock: these pages describe job freshness in
 * minutes and hours, and a ticking "42 seconds ago" invites staff to read a
 * precision the underlying `lastSuccessAt` doesn't have.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";

  const delta = now - then;
  if (delta < 0) return "in the future";
  return `${describeSpan(delta)} ago`;
}

/** A span of milliseconds as a rounded phrase — "3 minutes", "2 days". */
export function describeSpan(ms: number): string {
  if (ms < MINUTE) return "less than a minute";
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hour");
  return plural(Math.floor(ms / DAY), "day");
}

/** Job durations, which are milliseconds up to a few minutes. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** "12 of 40 (30%)" — the shape most of the Overview's ratios take. */
export function ratio(part: number, whole: number): string {
  if (whole <= 0) return count(part);
  return `${count(part)} of ${count(whole)} (${Math.round((part / whole) * 100)}%)`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Parse a moderation duration written the way staff say it out loud — "30m",
 * "2h", "7d", "90s" — into whole seconds.
 *
 * `null` means "no duration", which for MUTE/BAN is a permanent action; the
 * string `"invalid"` is the third case, kept distinct so a typo ("2 hrs") is
 * reported rather than silently treated as permanent.
 */
export function parseDurationSeconds(raw: string): number | null | "invalid" {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;

  const match = /^(\d+)\s*([smhdw])$/.exec(text);
  if (!match) return "invalid";

  const value = Number(match[1]);
  const unit = match[2] as "s" | "m" | "h" | "d" | "w";
  const seconds = value * { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }[unit];
  // The mutation layer's own ceiling. Checked here too so the message names the
  // limit instead of arriving as a generic INVALID_INPUT after a round trip.
  if (seconds <= 0 || seconds > 365 * 86_400) return "invalid";
  return seconds;
}

/**
 * An absolute date and time in the viewer's own zone.
 *
 * Events are the one place the panel shows a wall-clock time rather than "N
 * hours ago": staff schedule against a calendar, and "in 2 days" is not
 * something you can put in a Discord announcement.
 */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown";
  return at.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** How far off something is, in either direction — "in 3 hours", "2 days ago". */
export function countdown(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";

  const delta = then - now;
  if (Math.abs(delta) < MINUTE) return "now";
  return delta > 0 ? `in ${describeSpan(delta)}` : `${describeSpan(-delta)} ago`;
}

/**
 * Turn what a `datetime-local` input holds — local wall time, no zone — into the
 * instant it names.
 *
 * The conversion has to happen here rather than by sending the raw string: the
 * server would read a zone-less string as UTC, quietly moving every event by the
 * viewer's offset. `new Date(value)` on a zone-less local string is interpreted
 * in the browser's zone, which is exactly what the person typing meant.
 */
export function localInputToIso(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString();
}

/**
 * Job type ids are kebab-case in the database (`guild-roster-sync`). Staff read
 * these on the Health page, so they get title-cased on the way out.
 */
export function humanizeJob(job: string): string {
  return job
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
