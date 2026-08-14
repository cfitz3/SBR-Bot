/**
 * May this member open this ticket, and if not, why not?
 *
 * Every path returns a *reason*, never a bare boolean. A member told "you can't
 * open a ticket" with no explanation asks a staff member, which is exactly the
 * support load the ticket system exists to reduce — so the reason is the point
 * of the function, not a diagnostic bolted on beside it.
 *
 * Order is deliberate and is the same as the reference implementation's: the
 * most specific and least recoverable check runs first, so a blocked member is
 * told they are blocked rather than told the category is full.
 */
import type { TicketCategoryDTO, TicketSettingsDTO, TicketWorkingHoursDTO } from "@sbr/shared-types";

export type EligibilityReason =
  | "OK"
  | "BLOCKED"
  | "CATEGORY_DISABLED"
  | "MISSING_ROLE"
  | "MEMBER_LIMIT"
  | "TOTAL_LIMIT"
  | "COOLDOWN"
  | "CLOSED_HOURS";

export interface Eligibility {
  readonly allowed: boolean;
  readonly reason: EligibilityReason;
  /** Seconds until the member may try again. Only set for COOLDOWN. */
  readonly retryAfterSeconds: number | null;
  /** When staff are next open, ISO. Only set for CLOSED_HOURS, and null when the guild is never open. */
  readonly opensAt: string | null;
}

export interface EligibilityInput {
  readonly settings: TicketSettingsDTO;
  readonly category: TicketCategoryDTO;
  /** Every role the member holds, Discord snowflakes. */
  readonly memberRoleIds: readonly string[];
  /** The member's currently-open tickets in this category. */
  readonly memberOpenCount: number;
  /** Every currently-open ticket in this category, from anyone. */
  readonly categoryOpenCount: number;
  /** When this member last opened a ticket in this category, or null. */
  readonly lastOpenedAt: Date | null;
  readonly now: Date;
  /** IANA zone the guild's working hours are written in. */
  readonly timeZone: string;
}

function ok(): Eligibility {
  return { allowed: true, reason: "OK", retryAfterSeconds: null, opensAt: null };
}

function no(reason: EligibilityReason): Eligibility {
  return { allowed: false, reason, retryAfterSeconds: null, opensAt: null };
}

export function evaluateEligibility(input: EligibilityInput): Eligibility {
  const { settings, category, memberRoleIds } = input;
  const held = new Set(memberRoleIds);

  if (settings.blocklistRoleIds.some((r) => held.has(r))) return no("BLOCKED");
  if (!category.enabled) return no("CATEGORY_DISABLED");

  // "All", not "any" — the stricter of the two readings, and the reference
  // implementation's. A guild gating applications behind both "Verified" and
  // "Member" means both.
  if (category.requiredRoleIds.length > 0 && !category.requiredRoleIds.every((r) => held.has(r))) {
    return no("MISSING_ROLE");
  }

  if (input.memberOpenCount >= category.memberLimit) return no("MEMBER_LIMIT");
  if (input.categoryOpenCount >= category.totalLimit) return no("TOTAL_LIMIT");

  if (category.cooldownSeconds !== null && input.lastOpenedAt !== null) {
    const elapsed = (input.now.getTime() - input.lastOpenedAt.getTime()) / 1000;
    if (elapsed < category.cooldownSeconds) {
      return {
        allowed: false,
        reason: "COOLDOWN",
        retryAfterSeconds: Math.ceil(category.cooldownSeconds - elapsed),
        opensAt: null,
      };
    }
  }

  const hours = settings.workingHours;
  if (Object.keys(hours).length > 0 && !isOpen(hours, input.now, input.timeZone)) {
    return {
      allowed: false,
      reason: "CLOSED_HOURS",
      retryAfterSeconds: null,
      opensAt: nextOpening(hours, input.now, input.timeZone)?.toISOString() ?? null,
    };
  }

  return ok();
}

// ── working hours ───────────────────────────────────────────────────────────
//
// Held as `"0".."6"` → `{open, close}` in the guild's own timezone, because
// that is what an operator can reason about: "we answer tickets 9–5" is a local
// statement, and storing it in UTC would silently shift it twice a year.

interface LocalTime {
  readonly weekday: number;
  readonly minutes: number;
}

/**
 * The wall-clock weekday and minute-of-day in a given zone.
 *
 * Uses `Intl` rather than arithmetic on the epoch: offsets are not fixed per
 * zone, and hand-rolling DST is how this kind of code goes wrong in October.
 */
export function localTime(at: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = days.indexOf(get("weekday"));
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = Number(get("hour")) % 24;
  return { weekday: weekday === -1 ? 0 : weekday, minutes: hour * 60 + Number(get("minute")) };
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Whether staff are open right now. An unparseable window is treated as open. */
export function isOpen(hours: TicketWorkingHoursDTO, at: Date, timeZone: string): boolean {
  const { weekday, minutes } = localTime(at, timeZone);
  const day = hours[String(weekday)];
  if (day === undefined) return false;
  const open = toMinutes(day.open);
  const close = toMinutes(day.close);
  // A window nobody can parse should not lock members out of support. Failing
  // open is the safe direction here: the cost is a ticket arriving early.
  if (open === null || close === null) return true;
  // A window that wraps midnight ("22:00"–"02:00") is two ranges, not one.
  return close >= open ? minutes >= open && minutes < close : minutes >= open || minutes < close;
}

/**
 * When staff next open, or null if the schedule never opens.
 *
 * Walks the next seven days rather than solving it: seven iterations is cheap,
 * and the closed-form version would have to re-derive DST handling that `Intl`
 * already does correctly.
 */
export function nextOpening(hours: TicketWorkingHoursDTO, at: Date, timeZone: string): Date | null {
  const step = 15 * 60 * 1000;
  const limit = at.getTime() + 7 * 24 * 60 * 60 * 1000;
  for (let t = at.getTime(); t <= limit; t += step) {
    const when = new Date(t);
    if (isOpen(hours, when, timeZone)) return when;
  }
  return null;
}
