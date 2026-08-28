/**
 * `/levelalerts` — the per-member opt-out for level-up announcements.
 *
 * A level-up is a ping aimed at one person in a public channel, so the person
 * it names is the one who gets to decide whether it happens. The XP is
 * unaffected either way: opting out silences the announcement, not the
 * progress, and `/me` still reports the level.
 *
 * Stored as a guild setting rather than a member column because it is a short
 * list of ids and a rare write — the guild's whole opt-out set is one document,
 * which is also how the announcer wants to read it (once per pass, not once per
 * row).
 */
import type { CommandHandler, CommandReply, CommandSpec } from "./types.js";
import type { GuildConfigService } from "@sbr/shared-types";

/** The guild setting holding the Discord ids that have opted out. */
export const LEVEL_OPT_OUT_KEY = "levels.optOut";

/**
 * The opted-out ids for a guild.
 *
 * Anything unreadable is treated as nobody having opted out rather than as an
 * error: the setting is written by us, but a hand-edited or half-migrated
 * document must not stop announcements for the whole guild.
 */
export async function readLevelOptOuts(
  config: Pick<GuildConfigService, "getSetting">,
  guildId: string,
): Promise<Set<string>> {
  const raw = await config.getSetting<unknown>(guildId, LEVEL_OPT_OUT_KEY).catch(() => null);
  if (!Array.isArray(raw)) return new Set<string>();
  return new Set(raw.filter((id): id is string => typeof id === "string"));
}

const levelalerts: CommandHandler = async (ctx, deps): Promise<CommandReply> => {
  const state = ctx.args.getString("state");
  const current = await readLevelOptOuts(deps.config, ctx.guildId);
  const optedOut = current.has(ctx.userId);

  // No argument is a question, not a change. Somebody typing the command to
  // find out where they stand should not be flipped by asking.
  if (state === null) {
    return {
      ephemeral: true,
      text: optedOut
        ? "Level-up announcements are off for you. `/levelalerts state:on` turns them back on."
        : "Level-up announcements are on for you. `/levelalerts state:off` turns them off.",
    };
  }

  const wantOn = state === "on";
  if (wantOn !== optedOut) {
    return {
      ephemeral: true,
      text: wantOn ? "They were already on — nothing changed." : "They were already off — nothing changed.",
    };
  }

  if (wantOn) current.delete(ctx.userId);
  else current.add(ctx.userId);

  const saved = await deps.config.setSetting(ctx.guildId, LEVEL_OPT_OUT_KEY, [...current]);
  if (!saved.ok) return { ephemeral: true, text: "I couldn't save that just now — try again shortly." };

  return {
    ephemeral: true,
    text: wantOn
      ? "Level-up announcements are on for you again."
      : "Level-up announcements are off for you. You'll still earn XP and levels.",
  };
};

export function levelAlertSpecs(): CommandSpec[] {
  return [
    {
      name: "levelalerts",
      category: "EXTRAS",
      description: "Turn your own level-up announcements on or off",
      options: [
        {
          name: "state",
          description: "Leave it blank to see where you stand",
          type: "string",
          choices: [
            { name: "on", value: "on" },
            { name: "off", value: "off" },
          ],
        },
      ],
      cooldownMs: 5_000,
      handler: levelalerts,
    },
  ];
}
