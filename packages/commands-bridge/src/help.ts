/**
 * `/help` — the member surface, as a card, built from the registry.
 *
 * The old one was seven hand-written lines. It listed `/verify`, which is gone;
 * it never listed `/remind`, `/tag`, `/standing`, `/progression` or anything
 * else added after it was written; and it had no way to be wrong out loud,
 * because nothing checked it against the commands that actually exist. A help
 * list that lies is worse than none: a member who reads it and types something
 * unknown concludes the bot is broken.
 *
 * So this one reads `buildBridgeRegistry()`. A retired command cannot appear —
 * it is filtered by the same `enabled` flag that deregisters it from Discord —
 * and a new command appears the moment it declares a category, which
 * `help.test.ts` requires of every reachable spec.
 *
 * The grouping is six fields because the card budget is six, and the order is
 * the order a new member meets the platform: linking first, since nothing
 * personal answers until it is done.
 */
import { copy } from "@sbr/brand";
import { card } from "@sbr/embed-kit";
import { parseLinkHelp, LINK_HELP_SETTING_KEY, type LinkHelpPolicy } from "@sbr/guild-config";
import {
  HELP_CATEGORIES,
  type ActionRowView,
  type EmbedView,
  type HelpCategory,
} from "@sbr/shared-types";
import type { CommandReply, CommandSpec, HandlerDeps } from "./types.js";

const C = copy.embed.card;

/** Buttons on the help card. */
export const HELP_NAMESPACE = "help";

/** How many commands one category line shows before it says "and n more". */
const PER_LINE = 12;

const categoryLabel = (category: HelpCategory): string => C.helpCategory[category];

/**
 * The commands a caller can actually reach, grouped.
 *
 * Retired commands are dropped here rather than at the call site so every
 * consumer of this module gets the same list — the card, the in-game line and
 * the test that pins the grouping.
 */
export function groupCommands(
  specs: readonly CommandSpec[],
): ReadonlyMap<HelpCategory, readonly string[]> {
  const grouped = new Map<HelpCategory, string[]>();
  for (const spec of specs) {
    if (spec.enabled === false || spec.category === undefined) continue;
    const bucket = grouped.get(spec.category);
    if (bucket === undefined) grouped.set(spec.category, [spec.name]);
    else bucket.push(spec.name);
  }
  for (const bucket of grouped.values()) bucket.sort();
  return grouped;
}

function lineFor(names: readonly string[]): string {
  const shown = names.slice(0, PER_LINE).map((name) => `\`/${name}\``).join(" ");
  const rest = names.length - PER_LINE;
  return rest > 0 ? `${shown} ${C.helpMore.replace("{n}", String(rest))}` : shown;
}

export interface HelpInput {
  readonly specs: readonly CommandSpec[];
  /** The caller's linked IGN, or null. It decides which headline the card leads with. */
  readonly ign: string | null;
}

/**
 * The help card.
 *
 * The headline is the next step rather than a description of the card, because
 * the one thing a member reading `/help` for the first time needs is that
 * nothing here knows who they are until they link. Once they have linked, the
 * headline stops nagging and says so.
 */
export function renderHelpEmbed(input: HelpInput): EmbedView {
  const grouped = groupCommands(input.specs);
  return card({
    tone: "NEUTRAL",
    title: C.helpTitle,
    headline: input.ign === null ? C.helpUnlinked : C.helpLinked.replace("{ign}", input.ign),
    fields: HELP_CATEGORIES.map((category) => {
      const names = grouped.get(category) ?? [];
      return names.length === 0 ? null : { name: categoryLabel(category), value: lineFor(names) };
    }),
    footer: C.helpFooter,
  });
}

/**
 * One button, always present.
 *
 * Linking is where every new member gets stuck, and the reason is a Hypixel
 * setting three menus deep that no amount of embed text explains as well as
 * watching somebody do it. The button carries whatever the guild has configured
 * — usually a recording — so the answer to "how do I link" is a press rather
 * than a staffer retyping the same four steps in chat.
 */
export function helpComponents(): readonly ActionRowView[] {
  return [
    {
      buttons: [
        { customId: `${HELP_NAMESPACE}:link`, label: C.helpLinkButton, style: "PRIMARY" },
      ],
    },
  ];
}

export async function buildHelp(
  specs: readonly CommandSpec[],
  userId: string,
  deps: HandlerDeps,
): Promise<CommandReply> {
  // A failed identity read is not a reason to withhold the command list: the
  // link state only decides which sentence sits at the top.
  const linked = await deps.identity.resolveByDiscordId(userId).catch(() => null);
  const ign = linked !== null && linked.ok && linked.value !== null ? linked.value.ign : null;

  const grouped = groupCommands(specs);
  return {
    ephemeral: true,
    // Guild chat has no embeds and no buttons, so the flat line stays the whole
    // answer there — one category per line, which is what the old card was.
    text: HELP_CATEGORIES.filter((category) => (grouped.get(category) ?? []).length > 0)
      .map((category) => `${categoryLabel(category)}: ${(grouped.get(category) ?? []).map((n) => `/${n}`).join(" ")}`)
      .join("\n"),
    embed: renderHelpEmbed({ specs, ign }),
    components: helpComponents(),
  };
}

/**
 * The linking card.
 *
 * Split from the read below it so the gallery can draw it: a card built inside
 * an async handler is a card no style check ever sees, which is how the old
 * help text drifted in the first place.
 */
export function renderLinkHelpEmbed(configured: LinkHelpPolicy): EmbedView {
  return card({
    tone: "NEUTRAL",
    title: C.helpLinkTitle,
    headline:
      configured.body === null
        ? C.helpLinkSteps
        : `${C.helpLinkSteps}\n\n${configured.body}`,
    ...(configured.image === null ? {} : { imageUrl: configured.image }),
    footer: C.helpLinkFooter,
  });
}

/**
 * What the "How do I link?" button answers with.
 *
 * The steps are copy so they can be reworded centrally, and the guild's own
 * additions ride on top rather than replacing them: a server that uploads a
 * recording should not thereby delete the written instructions for the members
 * who cannot play it.
 */
export async function buildLinkHelp(guildId: string, deps: HandlerDeps): Promise<CommandReply> {
  const configured = parseLinkHelp(
    await deps.config.getSetting<unknown>(guildId, LINK_HELP_SETTING_KEY).catch(() => null),
  );

  return { ephemeral: true, text: C.helpLinkSteps, embed: renderLinkHelpEmbed(configured) };
}

export const helpButtonReplies = {
  link: buildLinkHelp,
} as const;
