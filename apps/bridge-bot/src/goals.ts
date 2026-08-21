/**
 * The goal watcher.
 *
 * A member sets a target with `/goal set`; nothing reads it again until this
 * sweep does. Each pass walks the unachieved rows, compares each against the
 * freshest snapshot of its metric, stamps the ones that arrived and posts about
 * them.
 *
 * It differs from the milestone announcer in one deliberate way: a goal is
 * marked achieved whether or not the announcement lands. The record of reaching
 * it lives on the row itself and the member can see it on their own `/goal`
 * card, so a guild with no `milestones` channel loses a post rather than the
 * fact — where a milestone, whose only record *is* the post, keeps its backlog
 * until somebody binds a channel.
 */
import { renderGoalAchievedEmbed } from "@sbr/commands-bridge";
import type { Logger } from "@sbr/observability";
import type { EmbedView, GoalRepository, ProgressMetric } from "@sbr/shared-types";

/** How many unachieved rows one pass will read. */
export const GOAL_SWEEP_BATCH = 200;
/**
 * How often the sweep runs. Snapshots are captured a few times a day, so a goal
 * cannot become true faster than that; hourly is already generous.
 */
export const GOAL_SWEEP_INTERVAL_MS = 60 * 60_000;

export interface GoalWatcherDeps {
  readonly goals: Pick<GoalRepository, "listUnachieved" | "markAchieved">;
  /** The freshest reading of one metric for one account, or null if none. */
  currentValue(minecraftUuid: string, metric: ProgressMetric): Promise<number | null>;
  /**
   * How the member is named on the card, looked up from the Discord id stored
   * with the goal. By id rather than by uuid because that is the link the
   * platform actually keeps: a uuid with no link has no name to print anyway.
   */
  ignFor(discordId: string): Promise<string | null>;
  /** The guild's `milestones` channel binding, or null when none is set. */
  getChannel(guildId: string): Promise<string | null>;
  post(channelId: string, embed: EmbedView, mentionDiscordId: string | null): Promise<boolean>;
  readonly log: Logger;
}

/** Drain one pass. Returns how many goals were newly marked achieved. */
export async function sweepGoalsOnce(
  deps: GoalWatcherDeps,
  limit: number = GOAL_SWEEP_BATCH,
): Promise<number> {
  const rows = await deps.goals.listUnachieved(limit);
  if (rows.length === 0) return 0;

  // Cached per pass: a guild's channel binding cannot change mid-sweep, and a
  // member with four goals is four rows off one name.
  const channels = new Map<string, string | null>();
  const names = new Map<string, string | null>();
  const reached: string[] = [];

  for (const row of rows) {
    const current = await deps
      .currentValue(row.minecraftUuid, row.metric)
      .catch(() => null);
    // No reading is not a failure — an account we have never snapshotted simply
    // has no evidence either way, and the row waits for the next pass.
    if (current === null || current < row.target) continue;

    reached.push(row.id);

    const discordId = row.discordId;
    if (discordId !== null && !names.has(discordId)) {
      names.set(discordId, await deps.ignFor(discordId).catch(() => null));
    }
    if (!channels.has(row.guildId)) {
      channels.set(row.guildId, await deps.getChannel(row.guildId).catch(() => null));
    }
    const channelId = channels.get(row.guildId) ?? null;
    if (channelId === null) continue;

    const ign = discordId === null ? null : (names.get(discordId) ?? null);
    // Unnamed is still postable, because the mention carries the identity when
    // the link does; a card that says "someone" with a ping on it reads fine.
    const posted = await deps
      .post(channelId, renderGoalAchievedEmbed(ign ?? "A member", row.metric, row.target), row.discordId)
      .catch(() => false);
    if (!posted) {
      deps.log.warn("goal announcement did not land", { id: row.id, channelId });
    }
  }

  if (reached.length === 0) return 0;
  const marked = await deps.goals.markAchieved(reached, new Date());
  return marked;
}

export interface GoalWatcherHandle {
  stop(): void;
}

/** The thin scheduler around the sweep. Same shape as the milestone announcer. */
export function startGoalWatcher(
  deps: GoalWatcherDeps,
  intervalMs: number = GOAL_SWEEP_INTERVAL_MS,
): GoalWatcherHandle {
  let running = false;
  const timer = setInterval(() => {
    // Overlapping passes would read the same unachieved rows and announce the
    // same goal twice, since the flag is only stamped at the end of a pass.
    if (running) return;
    running = true;
    void sweepGoalsOnce(deps)
      .then((count) => {
        if (count > 0) deps.log.info("goals reached", { count });
      })
      .catch((error: unknown) => {
        deps.log.error("goal sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
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
