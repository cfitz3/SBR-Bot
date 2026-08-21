/**
 * The watchtower: the fleet's health, said out loud in Discord.
 *
 * The panel's Health page already shows all of this, but a page only helps
 * somebody who is looking at it. This is for the case the page cannot cover —
 * the web panel itself being the thing that is down, at three in the morning.
 *
 * It lives in the admin bot because it is automated, staff-facing work, and
 * because that bot is the one that already holds a gateway connection to the
 * staff server. (`SBR Bot`/`SBR Bridge` is the member-facing application; ops
 * chatter has no business there.)
 *
 * Two rules keep it quiet enough to be worth having:
 *
 *  - **Edge-triggered.** A post happens when the fleet's status *changes*, not
 *    every pass. A channel that says "still down" every minute is a channel
 *    people mute, and a muted alarm is worse than none.
 *  - **A grace pass.** A service must miss its beats on two consecutive checks
 *    before it counts as down. One missed beat is a restart, a GC pause, or a
 *    slow Redis — not an outage, and paging on it teaches people to ignore it.
 */
import type { Logger } from "@sbr/observability";
import type { HealthReportDTO } from "@sbr/shared-types";

/** The services expected to be beating. Absence from this list is not an alert. */
export const WATCHED_SERVICES = ["bridge-bot", "admin-bot", "workers", "web-panel"] as const;
export type WatchedService = (typeof WATCHED_SERVICES)[number];

/** How often the fleet is checked. */
export const WATCH_INTERVAL_MS = 60_000;
/**
 * How old a beat may be before its service is considered silent. Beats land
 * every 15s with a 45s TTL, so this is already three misses.
 */
export const BEAT_STALE_MS = 90_000;

export interface FleetBeat {
  readonly service: string;
  readonly instance: string;
  readonly at: string;
}

export type FleetStatus = "ok" | "degraded" | "down";

export interface FleetReport {
  readonly status: FleetStatus;
  /** Services that have not beaten recently enough, in `WATCHED_SERVICES` order. */
  readonly silent: readonly string[];
  /** Component checks that came back unhealthy, e.g. `db`, `redis`. */
  readonly unhealthy: readonly { readonly name: string; readonly status: string; readonly detail?: string }[];
}

export interface WatchtowerDeps {
  /** Every live heartbeat. Expired keys are simply absent. */
  listBeats(): Promise<readonly FleetBeat[]>;
  /** The infrastructure probes this process can run itself (db, redis). */
  health(): Promise<HealthReportDTO>;
  /** Where to post. Null means no alert channel is configured — stay silent. */
  channelId(): string | null;
  post(channelId: string, text: string): Promise<boolean>;
  readonly log: Logger;
  now?(): number;
}

/** Build the report for one moment. Pure apart from the two reads. */
export async function readFleet(deps: WatchtowerDeps): Promise<FleetReport> {
  const now = deps.now?.() ?? Date.now();
  const beats = await deps.listBeats().catch(() => [] as readonly FleetBeat[]);
  const freshest = new Map<string, number>();
  for (const beat of beats) {
    const at = Date.parse(beat.at);
    if (Number.isNaN(at)) continue;
    // Several instances of one service: the newest beat is the one that decides
    // whether the service is alive, not the oldest.
    freshest.set(beat.service, Math.max(freshest.get(beat.service) ?? 0, at));
  }

  const silent = WATCHED_SERVICES.filter((s) => now - (freshest.get(s) ?? 0) > BEAT_STALE_MS);

  const report = await deps
    .health()
    .catch((): HealthReportDTO => ({ status: "down", checkedAt: new Date(now).toISOString(), components: [] }));
  const unhealthy = report.components
    .filter((c) => c.status !== "ok")
    .map((c) => ({ name: c.name, status: c.status, ...(c.detail === undefined ? {} : { detail: c.detail }) }));

  // Infrastructure down outranks a silent service: a bot that cannot reach the
  // database is the cause, and a silent worker is usually the symptom.
  const status: FleetStatus =
    unhealthy.some((c) => c.status === "down") || silent.length > 1
      ? "down"
      : silent.length > 0 || unhealthy.length > 0
        ? "degraded"
        : "ok";

  return { status, silent, unhealthy };
}

export interface WatchtowerState {
  /** The last status that was posted about, or null before the first post. */
  last: FleetStatus | null;
  /** Consecutive non-ok readings, for the grace pass. */
  strikes: number;
}

/**
 * One pass. Returns the text posted, or null when nothing needed saying.
 *
 * The state object is passed in rather than closed over so a test can drive a
 * sequence of passes and assert on exactly which of them spoke.
 */
export async function watchOnce(
  deps: WatchtowerDeps,
  state: WatchtowerState,
): Promise<string | null> {
  const report = await readFleet(deps);

  if (report.status === "ok") {
    state.strikes = 0;
    // Recovery is worth a message; a run of healthy passes is not.
    if (state.last === null || state.last === "ok") {
      state.last = "ok";
      return null;
    }
    state.last = "ok";
    return await say(deps, "✅ **Fleet recovered** — everything is beating again.");
  }

  state.strikes += 1;
  // The grace pass: one bad reading is not an outage.
  if (state.strikes < 2) return null;
  // Already said, and nothing changed about what is wrong.
  if (state.last === report.status) return null;

  state.last = report.status;
  return await say(deps, describe(report));
}

/** Post, and report what was said. A missing channel is silence, not an error. */
async function say(deps: WatchtowerDeps, text: string): Promise<string | null> {
  const channelId = deps.channelId();
  if (channelId === null) return null;
  const ok = await deps.post(channelId, text).catch(() => false);
  if (!ok) {
    deps.log.warn("watchtower alert did not land", { channelId });
    return null;
  }
  return text;
}

function describe(report: FleetReport): string {
  const head = report.status === "down" ? "🔴 **Fleet down**" : "🟠 **Fleet degraded**";
  const lines: string[] = [];
  if (report.silent.length > 0) {
    lines.push(`Silent: ${report.silent.join(", ")}`);
  }
  for (const c of report.unhealthy) {
    lines.push(`${c.name}: ${c.status}${c.detail === undefined ? "" : ` — ${c.detail}`}`);
  }
  return `${head}\n${lines.join("\n").slice(0, 1500)}`;
}

export interface WatchtowerHandle {
  stop(): void;
}

export function startWatchtower(
  deps: WatchtowerDeps,
  intervalMs: number = WATCH_INTERVAL_MS,
): WatchtowerHandle {
  const state: WatchtowerState = { last: null, strikes: 0 };
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void watchOnce(deps, state)
      .catch((error: unknown) => {
        // Logged, not posted: the alert path is the thing that just failed.
        deps.log.error("watchtower pass failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
