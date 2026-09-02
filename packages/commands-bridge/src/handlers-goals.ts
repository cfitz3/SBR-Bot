/**
 * `/goal` — the targets a member sets for themselves.
 *
 * The tracking half of the progression pair: `/progress` says where they have
 * been, this says where they are going and, from the same snapshot history,
 * roughly when they will get there. Everything is scoped to the caller — there
 * is no way to set, read or clear somebody else's goal, for the same reason
 * `/remind` has no "remind someone else".
 *
 * A member has at most one goal per metric. That is the store's constraint
 * rather than a check here, and it is the honest model: "my networth goal" is
 * singular, and a list that only grew would become a chore to prune rather than
 * a thing to check.
 */
import { copy } from "@sbr/brand";
import type { ProgressMetric } from "@sbr/shared-types";
import { renderFailure, renderGoalsEmbed } from "./render.js";
import type { CommandHandler, CommandReply, CommandSpec } from "./types.js";

const C = copy.embed.card;

/** The four tracks `/progress` charts, and so the four a goal can name. */
const METRICS: readonly ProgressMetric[] = [
  "skyblockLevel",
  "networth",
  "skillAverage",
  "catacombsLevel",
];

/**
 * Nobody types `2000000000`.
 *
 * `2b`, `1.5m`, `40k` — the same shorthand `formatCoins` prints, read back. A
 * bare number is still a bare number, so `40` means forty rather than forty
 * thousand: guessing at a magnitude the member did not write is how a networth
 * goal quietly becomes a thousand times too small.
 */
export function parseTarget(input: string): number | null {
  const trimmed = input.trim().toLowerCase().replace(/[, _]/g, "");
  const match = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(trimmed);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const scale = { k: 1e3, m: 1e6, b: 1e9 }[match[2] ?? ""] ?? 1;
  return value * scale;
}

/** The metric a caller named, or null when it is not one of the four. */
function readMetric(raw: string | null): ProgressMetric | null {
  return METRICS.find((m) => m === raw) ?? null;
}

const goal: CommandHandler = async (ctx, deps): Promise<CommandReply> => {
  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) {
    return { ephemeral: true, text: renderFailure("NOT_LINKED") };
  }
  const { ign, minecraftUuid } = linked.value;
  const action = ctx.args.getString("action") ?? "list";
  const metric = readMetric(ctx.args.getString("metric"));

  if (action === "list") {
    // A read that fails — as a Result or as a thrown error — is reported as an
    // empty board rather than an error: the command is a status check, and
    // "nothing to show" degrades better than a stack trace for something the
    // member cannot act on anyway.
    const result = await deps.progression
      .listGoals(ctx.guildId, minecraftUuid)
      .catch(() => null);
    return {
      ephemeral: false,
      text: "",
      embed: renderGoalsEmbed(ign, result?.ok === true ? result.value : []),
    };
  }

  // Both writes name a metric; without one there is nothing to act on, and
  // guessing which of four the member meant would be worse than asking.
  if (metric === null) {
    return { ephemeral: true, text: `Pick a metric: ${METRICS.join(", ")}.` };
  }

  if (action === "clear") {
    const cleared = await deps.progression.clearGoal(ctx.guildId, minecraftUuid, metric);
    const template = cleared.ok && cleared.value ? C.goalCleared : C.goalNotSet;
    return { ephemeral: true, text: template.replace("{metric}", metric) };
  }

  const raw = ctx.args.getString("target");
  if (raw === null) {
    return { ephemeral: true, text: "Tell me what to aim for — `2b`, `250`, `45.5`." };
  }
  const target = parseTarget(raw);
  if (target === null) {
    return { ephemeral: true, text: copy.error.goal.BAD_TARGET };
  }

  const set = await deps.progression.setGoal(ctx.guildId, minecraftUuid, metric, target);
  if (!set.ok) {
    if (set.error.kind === "ALREADY_THERE") {
      return {
        ephemeral: true,
        text: copy.error.goal.ALREADY_THERE.replace("{current}", String(set.error.current)),
      };
    }
    return { ephemeral: true, text: copy.error.goal[set.error.kind] };
  }

  return {
    ephemeral: false,
    text: C.goalSet.replace("{metric}", metric).replace("{target}", raw.trim()),
    embed: renderGoalsEmbed(ign, [set.value]),
  };
};

export function goalSpecs(): CommandSpec[] {
  return [
    {
      name: "goal",
      category: "PROGRESS",
      description: "Set a progression target and track how it's going",
      options: [
        {
          name: "action",
          description: "List your goals, set one, or clear one (default list)",
          type: "string",
          choices: [
            { name: "List", value: "list" },
            { name: "Set", value: "set" },
            { name: "Clear", value: "clear" },
          ],
        },
        {
          name: "metric",
          description: "Which track to aim at",
          type: "string",
          choices: [
            { name: "SkyBlock Level", value: "skyblockLevel" },
            { name: "Networth", value: "networth" },
            { name: "Skill average", value: "skillAverage" },
            { name: "Catacombs", value: "catacombsLevel" },
          ],
        },
        {
          name: "target",
          description: "The number to reach — 2b, 250, 45.5",
          type: "string",
        },
      ],
      cooldownMs: 10_000,
      // Retired: merged into /progression, which shows a goal beside the chart of
      // the metric it aims at. A target read on its own, away from the trend
      // feeding it, was a number with nothing to judge it by; and setting one is
      // now a button on the card a member is already looking at rather than a
      // three-option command they have to recall. The spec stays so the handler
      // stays compiled and tested; this flag is what deregisters the command
      // from Discord and from the in-game router.
      enabled: false,
      // Linked-only in guild chat: every branch of this reads or writes the
      // caller's own progression, which an unlinked player does not have.
      inGame: "linked",
      handler: goal,
    },
  ];
}
