/**
 * Display formatting. No DOM, so it can be unit-tested like any other module in
 * the repo — `format.test.ts` installs the resolved copy first, the way
 * `main.ts` does for the browser.
 */
import { scope } from "./copy.js";

const t = scope("format");
const c = scope("common");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Thousands-separated, with a dash for "no value" so a column stays scannable. */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return c("dash");
  return value.toLocaleString(t("numberLocale"));
}

/**
 * A coarse "how long ago", biased to the largest useful unit.
 *
 * Deliberately not a live-updating clock: these pages describe job freshness in
 * minutes and hours, and a ticking "42 seconds ago" invites staff to read a
 * precision the underlying `lastSuccessAt` doesn't have.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return c("never");
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return c("unknown");

  const delta = now - then;
  if (delta < 0) return t("future");
  return t("ago").replace("{span}", describeSpan(delta));
}

/** A span of milliseconds as a rounded phrase — "3 minutes", "2 days". */
export function describeSpan(ms: number): string {
  if (ms < MINUTE) return t("lessThanAMinute");
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minuteOne", "minuteMany");
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hourOne", "hourMany");
  return plural(Math.floor(ms / DAY), "dayOne", "dayMany");
}

/** Job durations, which are milliseconds up to a few minutes. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return c("dash");
  if (ms < 1000) return t("durationMs").replace("{n}", String(Math.round(ms)));
  if (ms < 60_000) return t("durationSeconds").replace("{n}", (ms / 1000).toFixed(1));
  return t("durationMinutes")
    .replace("{m}", String(Math.floor(ms / 60_000)))
    .replace("{s}", String(Math.round((ms % 60_000) / 1000)));
}

/**
 * Big Skyblock figures at a glance — "1.2b", "340m", "8.5k".
 *
 * Networth runs to eleven digits, and a thousands-separated string of those is
 * something staff have to count digits on to read. Three significant figures is
 * as much precision as a screening decision ever uses; the exact number is on
 * the record for anyone who needs it.
 */
export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return c("dash");
  const sign = value < 0 ? "-" : "";
  const n = Math.abs(value);
  if (n < 1000) return `${sign}${Math.round(n)}`;
  const suffixes = [
    [1e9, t("suffixBillion")],
    [1e6, t("suffixMillion")],
    [1e3, t("suffixThousand")],
  ] as const;
  for (const [size, suffix] of suffixes) {
    if (n >= size) {
      const scaled = n / size;
      // One decimal below ten, none above: "9.4b" and "340m" are both three
      // characters of information, which is the point.
      return `${sign}${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)}${suffix}`;
    }
  }
  return `${sign}${Math.round(n)}`;
}

/** "12 of 40 (30%)" — the shape most of the Overview's ratios take. */
export function ratio(part: number, whole: number): string {
  if (whole <= 0) return count(part);
  return t("ratio")
    .replace("{part}", count(part))
    .replace("{whole}", count(whole))
    .replace("{percent}", String(Math.round((part / whole) * 100)));
}

/**
 * One and many are separate keys, not an "s" appended by code: English gets away
 * with that and most languages do not.
 */
function plural(n: number, one: "minuteOne" | "hourOne" | "dayOne", many: "minuteMany" | "hourMany" | "dayMany"): string {
  return t(n === 1 ? one : many).replace("{n}", String(n));
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
  if (!iso) return c("dash");
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return c("unknown");
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
  if (!iso) return c("dash");
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return c("unknown");

  const delta = then - now;
  if (Math.abs(delta) < MINUTE) return t("now");
  return delta > 0
    ? t("inSpan").replace("{span}", describeSpan(delta))
    : t("ago").replace("{span}", describeSpan(-delta));
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
