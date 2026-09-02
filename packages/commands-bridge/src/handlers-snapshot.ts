/**
 * `/snapshot` — pin the member's current numbers so a later reading has
 * something to be measured against.
 *
 * This command exists because the platform deliberately does not keep a stat
 * history. One current reading per member is refreshed on a schedule, and the
 * row it displaces is kept only long enough to detect a milestone; nothing
 * accumulates (docs/HYPIXEL_COMPLIANCE.md §1). So a member who wants a chart
 * builds one on purpose, a marker at a time, and `/progress` draws whatever
 * they have chosen to keep.
 *
 * Saving costs no Hypixel request at all: the value pinned is the one the
 * refresh job already holds. That is what stops "let the member trigger it"
 * from becoming a way to poll on demand.
 *
 * Self-only, like `/goal` — there is no way to save a marker about somebody
 * else, and no argument that names a player.
 */
import { copy } from "@sbr/brand";
import { renderFailure } from "./render.js";
import type { CommandHandler, CommandReply, CommandSpec } from "./types.js";

const C = copy.embed.card;

const snapshot: CommandHandler = async (ctx, deps): Promise<CommandReply> => {
  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) {
    return { ephemeral: true, text: renderFailure("NOT_LINKED") };
  }

  const saved = await deps.progression.saveSnapshot(
    linked.value.minecraftUuid,
    ctx.userId,
    ctx.args.getString("label"),
  );

  if (!saved.ok) {
    if (saved.error.kind === "ALREADY_SAVED") {
      return { ephemeral: true, text: C.snapshotUnchanged };
    }
    const text = saved.error.kind === "NO_READING" ? C.snapshotNoReading : C.snapshotUnavailable;
    return { ephemeral: true, text };
  }

  const { label, savedCount, limit } = saved.value;
  // Public rather than ephemeral: a member saving a marker before a grind is a
  // small piece of guild chatter, and the reply is the receipt for it.
  const template = label === null ? C.snapshotSaved : C.snapshotSavedNamed;
  return {
    ephemeral: false,
    text: template
      .replace("{name}", label ?? "")
      .replace("{n}", String(savedCount))
      .replace("{limit}", String(limit)),
  };
};

export function snapshotSpecs(): CommandSpec[] {
  return [
    {
      name: "snapshot",
      category: "PROGRESS",
      description: "Save your current stats so /progress can chart the change",
      options: [
        {
          name: "label",
          description: 'What to call it — "before dungeon grind"',
          type: "string",
        },
      ],
      // Longer than `/goal`: each save spends one of a member's two dozen slots,
      // and a spammed one would push their own older markers off the end.
      cooldownMs: 60_000,
      // Retired: merged into /progression, which charts a metric, shows the goal
      // for it and saves the marker from one card. Saving was the step nobody
      // knew to take — it is now a button under the empty chart it fixes. The
      // spec stays so the handler stays compiled and tested; this flag is what
      // deregisters the command from Discord and from the in-game router.
      enabled: false,
      // Linked-only in guild chat: it saves the caller's own reading, which an
      // unlinked player does not have.
      inGame: "linked",
      handler: snapshot,
    },
  ];
}
