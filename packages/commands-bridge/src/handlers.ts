/**
 * Member bot command handlers. Thin: resolve identity, call a domain service,
 * render. The registry wires these with capability + cooldown metadata, and the
 * Discord registration payload is derived from the same specs.
 */
import { copy, withCommandCopy } from "@sbr/brand";
import { categoryFor, flattenEmbed, LEADERBOARD_CATEGORIES, LEADERBOARD_LABELS } from "@sbr/shared-types";
import type { AdviceDTO, AuctionsDTO, HypixelResult, LinkActor, ProgressMetric } from "@sbr/shared-types";
import type {
  AutocompleteHandler,
  CommandContext,
  CommandHandler,
  CommandOptionSpec,
  CommandReply,
  CommandSpec,
  HandlerDeps,
} from "./types.js";
import { communitySpecs } from "./handlers-community.js";
import {
  networthComponents,
  renderNetworthCategoryEmbed,
  renderNetworthEmbed,
} from "./networth.js";
import { permSpecs } from "./handlers-perms.js";
import { healthSpecs } from "./handlers-health.js";
import { infoSpecs } from "./handlers-info.js";
import { levelAlertSpecs } from "./handlers-levels.js";
import { goalSpecs } from "./handlers-goals.js";
import { snapshotSpecs } from "./handlers-snapshot.js";
import { progressionSpecs } from "./progression.js";
import { buildHelp } from "./help.js";
import { reminderSpecs } from "./handlers-remind.js";
import { tagSpecs } from "./handlers-tags.js";
import { funSpecs } from "./fun.js";
import { DEFAULT_RANGE, marketReply } from "./market.js";
import {
  renderAccessoriesEmbed,
  renderAdviceEmbed,
  renderAuctionsEmbed,
  renderDungeonsEmbed,
  renderFailure,
  renderLeaderboardEmbed,
  renderLeaderboardLine,
  renderLinkError,
  renderAchievementsEmbed,
  renderNetworth,
  renderProfileEmbed,
  renderProfileListEmbed,
  renderProgressEmbed,
  renderRosterEmbed,
  renderSkillsEmbed,
  renderSlayersEmbed,
  renderProfileCardEmbed,
  renderStatsEmbed,
  formatCoins,
  formatLevel,
} from "./render.js";

const E = copy.error;

/** The player a lookup is about, once the `player` option has been resolved. */
interface Target {
  readonly uuid: string;
  readonly ign: string;
}

/**
 * The target of a lookup: the named IGN if one was given, otherwise the
 * caller's own linked account. Returns a message instead when neither is
 * available, so every handler reports the same two failures the same way.
 */
async function resolveTarget(
  ctx: CommandContext,
  deps: HandlerDeps,
): Promise<Target | { readonly problem: string }> {
  const named = ctx.args.getString("player");
  if (named) {
    const found = await deps.players.resolveIgn(named);
    return found ?? { problem: `No Minecraft account called "${named}".` };
  }
  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) {
    return { problem: renderFailure("NOT_LINKED") };
  }
  return { uuid: linked.value.minecraftUuid, ign: linked.value.ign };
}

/**
 * The registry, for the one command that has to read it.
 *
 * Memoised because the specs are static and `/help` is the cheapest command on
 * the surface — rebuilding fifty-odd of them per press would be the most
 * expensive thing it does. Built lazily rather than at module load so this is
 * not a cycle: `buildBridgeRegistry` is defined below and closes over nothing
 * that is not already initialised by the time a member types anything.
 */
let memoisedRegistry: readonly CommandSpec[] | null = null;
const allSpecs = (): readonly CommandSpec[] =>
  (memoisedRegistry ??= [...buildBridgeRegistry().values()]);

const help: CommandHandler = async (ctx, deps) => buildHelp(allSpecs(), ctx.userId, deps);

/**
 * Hypixel's social field holds a Discord *username*, so the verifier needs the
 * caller's handle as well as their id. The in-game surface has neither to give
 * — it knows an IGN — and omits it rather than inventing one.
 */
function linkActor(ctx: CommandContext): LinkActor {
  return ctx.username === undefined
    ? { discordId: ctx.userId }
    : { discordId: ctx.userId, username: ctx.username };
}

/**
 * `/link`, which now also repairs.
 *
 * `/verify` was the same call with a different verb: re-run the social check,
 * either against a named IGN or against the account already on file. Two names
 * for one action is one name too many at the exact moment a member is most
 * confused — the whole reason `/verify` existed was that linking had failed,
 * and "the command you just ran did not work, try this other one" is not a
 * repair path anybody finds. Omitting the IGN re-checks what is on file, which
 * is what `/verify` did with no argument.
 */
const link: CommandHandler = async (ctx, deps) => {
  const named = ctx.args.getString("ign");
  let ign = named;
  if (!ign) {
    const linked = await deps.identity.resolveByDiscordId(ctx.userId);
    if (!linked.ok || linked.value === null) {
      return { ephemeral: true, text: copy.embed.card.helpLinkSteps };
    }
    ign = linked.value.ign;
  }

  const result = await deps.identity.linkByIgn(linkActor(ctx), ign);
  if (!result.ok) return { ephemeral: true, text: renderLinkError(result.error) };
  // Re-checking an account already on file is a confirmation, not a new link,
  // and saying "linked" to somebody repairing one reads as though it had come
  // undone.
  // Three sentences, because there are three outcomes worth distinguishing: a
  // new link, a re-check that passed, and a link whose guild-gated roles are
  // still outstanding because Hypixel would not answer.
  const template = result.value.rolesPending
    ? copy.embed.card.linkPending
    : named
      ? copy.embed.card.linkDone
      : copy.embed.card.linkConfirmed;
  return { ephemeral: true, text: template.replace("{ign}", result.value.ign) };
};

/**
 * `/verify` re-runs the same social check as `/link`. With no argument it
 * re-checks the account already on file, which is the repair path for a link
 * that went stale (name change, social field cleared).
 */
const verify: CommandHandler = async (ctx, deps) => {
  let ign = ctx.args.getString("ign");
  if (!ign) {
    const linked = await deps.identity.resolveByDiscordId(ctx.userId);
    if (!linked.ok || linked.value === null) {
      return { ephemeral: true, text: "Nothing to verify — use /link <ign> first." };
    }
    ign = linked.value.ign;
  }
  const result = await deps.identity.linkByIgn(linkActor(ctx), ign);
  if (!result.ok) return { ephemeral: true, text: renderLinkError(result.error) };
  if (result.value.rolesPending) {
    return { ephemeral: true, text: copy.embed.card.linkPending.replace("{ign}", result.value.ign) };
  }
  return { ephemeral: true, text: `Verified as ${result.value.ign}. ✅` };
};

const unlink: CommandHandler = async (ctx, deps) => {
  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) {
    return { ephemeral: true, text: "You have no linked account." };
  }
  const result = await deps.identity.unlink(ctx.userId, linked.value.minecraftUuid);
  if (!result.ok) return { ephemeral: true, text: E.generic.saveFailed };
  return { ephemeral: true, text: `Unlinked ${linked.value.ign}.` };
};

const networth: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const profileArg = ctx.args.getString("profile") ?? undefined;
  const nw = await deps.progression.getNetworth(target.uuid, profileArg);
  return {
    ephemeral: false,
    // `text` stays populated: guild chat has no embeds, and it is the fallback
    // any surface can render. The dropdown has no equivalent there, which is
    // fine — the overview is the answer, the drill-down is an extra.
    text: `${target.ign}: ${renderNetworth(nw)}`,
    embed: renderNetworthEmbed(target.ign, nw, target.uuid),
    // Only when the read succeeded and there is something to open. A menu under
    // a failure card is a control that cannot do anything.
    ...(nw.ok
      ? { components: networthComponents(nw.value.data, target, profileArg) }
      : {}),
  };
};

/**
 * The category dropdown's reply, as a plain function.
 *
 * Kept here rather than in the transport for the same reason the community
 * buttons are: the app layer should only have to supply interaction plumbing,
 * and a test should be able to open a category without a Discord client.
 *
 * The read is fresh rather than carried in the customId. A menu outlives the
 * message it was posted under, and a breakdown encoded into a control would go
 * stale silently — the one failure mode a networth card cannot afford, because
 * nothing about a stale figure looks stale.
 */
export async function networthCategoryReply(
  target: { readonly uuid: string; readonly ign: string },
  profileId: string | undefined,
  category: string,
  deps: HandlerDeps,
): Promise<CommandReply> {
  const nw = await deps.progression.getNetworth(target.uuid, profileId);
  return {
    // Ephemeral: the overview is the shared message, and a drill-down per
    // presser posted into the channel would bury it.
    ephemeral: true,
    text: `${target.ign}: ${renderNetworth(nw)}`,
    embed: renderNetworthCategoryEmbed(target.ign, nw, category, target.uuid),
  };
}

const stats: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const profileArg = ctx.args.getString("profile") ?? undefined;
  // One profile fetch backs all four reads (the client caches the profile list),
  // so this is parallel without multiplying upstream calls.
  const [summary, slayers, dungeons, nw] = await Promise.all([
    deps.progression.getProfileSummary(target.uuid, profileArg),
    deps.progression.getSlayers(target.uuid, profileArg),
    deps.progression.getDungeons(target.uuid, profileArg),
    deps.progression.getNetworth(target.uuid, profileArg),
  ]);

  const text = summary.ok
    ? `${target.ign}: SA ${formatLevel(summary.value.data.skillAverage)}, cata ${formatLevel(
        summary.value.data.catacombsLevel,
      )}, nw ${nw.ok && nw.value.data.total !== null ? formatCoins(nw.value.data.total) : "—"}`
    : `${target.ign}: ${renderFailure(summary.error.state)}`;

  return {
    ephemeral: false,
    text,
    embed: renderStatsEmbed(target.ign, summary, slayers, dungeons, nw),
  };
};

/**
 * `/me` — the caller's own card.
 *
 * Was `/stats` pinned to the caller. It is its own card now, because the
 * question it answers is different: `/stats` describes a Hypixel account, and
 * this describes a member of this guild — standing, achievements, event
 * podiums, board positions and their record with staff, none of which is
 * knowable about an IGN somebody else typed.
 */
const me: CommandHandler = async (ctx, deps) => {
  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) {
    return { ephemeral: true, text: renderFailure("NOT_LINKED") };
  }
  const uuid = linked.value.minecraftUuid;
  // Nine reads, each absorbing its own failure. A card is worth more with seven
  // sections on it than with none, and the sections that did not arrive are
  // absent rather than zeroed — see `renderProfileCardEmbed`.
  const [summary, slayers, dungeons, nw, standingRow, record, achievements, podium, positions] =
    await Promise.all([
      deps.progression.getProfileSummary(uuid),
      deps.progression.getSlayers(uuid),
      deps.progression.getDungeons(uuid),
      deps.progression.getNetworth(uuid),
      // `/me` is the one lookup that knows the account and the person are the
      // same, so it is the one that can show both. Absorbed on failure: a stats
      // card is still worth sending without the guild half.
      deps.xp?.standing(ctx.guildId, ctx.userId).catch(() => null) ?? null,
      // Same argument, and the same absorption — a member's own record is only
      // ever readable here because the id is the caller's own.
      deps.record?.forMember(ctx.guildId, ctx.userId).catch(() => null) ?? null,
      // Guild-scoped: what this guild recognises, and how far this member is
      // through it. Not the same question `/milestones` asks in full.
      deps.progression.getAchievements(uuid, ctx.guildId).catch(() => null),
      deps.podiums?.forMember(ctx.guildId, ctx.userId).catch(() => null) ?? null,
      // The default four categories. `/leaderboard` is where the whole catalog
      // lives; a card that listed nine ranks is one nobody reads any of.
      deps.leaderboards?.positions(ctx.guildId, ctx.userId).catch(() => null) ?? null,
    ]);
  return {
    ephemeral: true,
    text: `${linked.value.ign}: ${renderNetworth(nw)}`,
    embed: renderProfileCardEmbed(linked.value.ign, {
      uuid,
      profile: summary,
      slayers,
      dungeons,
      networth: nw,
      standing: standingRow,
      record: record !== null && record.ok ? record.value : null,
      achievements: achievements !== null && achievements.ok ? achievements.value : null,
      podium: podium !== null && podium.ok ? podium.value : null,
      positions,
    }),
  };
};

/**
 * `/leaderboard` — one category, one page.
 *
 * Every category is DB-local: snapshots, counters, balances and join dates. The
 * command makes no Hypixel call at all, which is why it can afford a short
 * cooldown and a public reply where `/stats` cannot.
 */
const leaderboard: CommandHandler = async (ctx, deps) => {
  if (deps.leaderboards === undefined) {
    return { ephemeral: true, text: "Leaderboards aren't switched on here." };
  }

  const raw = ctx.args.getString("category") ?? "xp";
  const category = categoryFor(raw);
  if (category === null) {
    // Names the whole catalog rather than guessing: a member who typed
    // something close wants to see the list, not a board they didn't ask for.
    return {
      ephemeral: true,
      text: `No leaderboard called "${raw}". Try: ${LEADERBOARD_CATEGORIES.join(", ")}.`,
    };
  }

  const days = ctx.args.getNumber("days");
  const page = await deps.leaderboards.page({
    guildId: ctx.guildId,
    category,
    discordId: ctx.userId,
    page: ctx.args.getNumber("page") ?? 1,
    ...(days === null ? {} : { windowDays: days }),
  });

  return { ephemeral: false, text: renderLeaderboardLine(page), embed: renderLeaderboardEmbed(page) };
};

const skills: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const result = await deps.progression.getSkills(
    target.uuid,
    ctx.args.getString("profile") ?? undefined,
  );
  const only = ctx.args.getString("skill") ?? undefined;
  const text = result.ok
    ? `${target.ign}: skill average ${formatLevel(result.value.data.average)}`
    : `${target.ign}: ${renderFailure(result.error.state)}`;
  return { ephemeral: false, text, embed: renderSkillsEmbed(target.ign, result, only, target.uuid) };
};

const slayer: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const result = await deps.progression.getSlayers(
    target.uuid,
    ctx.args.getString("profile") ?? undefined,
  );
  const only = ctx.args.getString("boss") ?? undefined;
  const text = result.ok
    ? `${target.ign}: ${result.value.data.totalExperience.toLocaleString("en-US")} slayer xp`
    : `${target.ign}: ${renderFailure(result.error.state)}`;
  return { ephemeral: false, text, embed: renderSlayersEmbed(target.ign, result, only, target.uuid) };
};

const dungeons: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const result = await deps.progression.getDungeons(
    target.uuid,
    ctx.args.getString("profile") ?? undefined,
  );
  const text = result.ok
    ? `${target.ign}: catacombs ${formatLevel(result.value.data.catacombsLevel)}`
    : `${target.ign}: ${renderFailure(result.error.state)}`;
  return { ephemeral: false, text, embed: renderDungeonsEmbed(target.ign, result) };
};

/**
 * `/profile` with a `profile` argument shows that one; without, it lists every
 * profile on the account so the member can see what `/setprofile` accepts.
 */
const profile: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const named = ctx.args.getString("profile");
  if (named) {
    const one = await deps.progression.getProfileSummary(target.uuid, named);
    const text = one.ok
      ? `${target.ign} — ${one.value.data.cuteName ?? one.value.data.profileId}`
      : `${target.ign}: ${renderFailure(one.error.state)}`;
    return { ephemeral: false, text, embed: renderProfileEmbed(target.ign, one) };
  }

  const all = await deps.progression.listProfiles(target.uuid);
  const text = all.ok
    ? `${target.ign}: ${all.value.data.length} profile(s)`
    : `${target.ign}: ${renderFailure(all.error.state)}`;
  return { ephemeral: false, text, embed: renderProfileListEmbed(target.ign, all) };
};

const setprofile: CommandHandler = async (ctx, deps) => {
  const wanted = ctx.args.getString("profile");
  if (!wanted) return { ephemeral: true, text: "Usage: /setprofile <profile>" };

  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) {
    return { ephemeral: true, text: renderFailure("NOT_LINKED") };
  }
  const result = await deps.progression.setSelectedProfile(linked.value.minecraftUuid, wanted);
  if (!result.ok) {
    return {
      ephemeral: true,
      text:
        result.error.kind === "NO_SUCH_PROFILE"
          ? `No profile called "${wanted}" on your account.`
          : E.generic.saveFailed,
    };
  }
  return {
    ephemeral: true,
    text: `Your lookups now default to ${result.value.cuteName ?? result.value.profileId}.`,
  };
};

/**
 * Suggest the caller's own profiles by cute name. Everything here degrades to
 * an empty list rather than throwing: Discord gives autocomplete three seconds
 * and shows nothing on error, so a silent empty list is the honest outcome of
 * "not linked" and "Hypixel is down" alike.
 */
const setprofileAutocomplete: AutocompleteHandler = async (focused, ctx, deps) => {
  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) return [];

  const all = await deps.progression.listProfiles(linked.value.minecraftUuid);
  if (!all.ok) return [];

  const typed = focused.value.trim().toLowerCase();
  return all.value.data
    .map((p) => ({ name: p.cuteName ?? p.profileId, value: p.cuteName ?? p.profileId }))
    .filter((c) => typed === "" || c.name.toLowerCase().includes(typed));
};

/**
 * `/milestones` — the guild's achievements with the member's standing against
 * them, not a bare list of what they crossed. Public rather than ephemeral:
 * achievements are the thing the guild celebrates, and announcing them is the
 * point (see the announcer in DOMAIN_MODEL.md §Milestones).
 */
const milestones: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const result = await deps.progression.getAchievements(target.uuid, ctx.guildId);
  if (!result.ok) {
    return { ephemeral: true, text: E.generic.loadFailed };
  }
  const data = result.value;
  const next = data.upcoming[0];
  return {
    ephemeral: false,
    // The text line is the whole reply on the in-game surface, so it carries the
    // headline and the nearest target rather than deferring to the embed.
    text: data.configured
      ? `${target.ign}: ${data.earnedCount}/${data.totalCount} achievements` +
        (next ? ` · next: ${next.label}` : "")
      : "Achievements aren't switched on here.",
    embed: renderAchievementsEmbed(target.ign, data),
  };
};

/**
 * `/missing` — notable accessories the player doesn't hold, plus the ones they
 * hold that a better family member already supersedes.
 */
const missing: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const result = await deps.progression.getAccessories(
    target.uuid,
    ctx.args.getString("profile") ?? undefined,
  );
  const text = result.ok
    ? `${target.ign}: ${result.value.data.magicalPower === null ? "bag unreadable" : `${result.value.data.magicalPower} MP`}, ${result.value.data.missing.length} missing`
    : `${target.ign}: ${renderFailure(result.error.state)}`;
  return { ephemeral: false, text, embed: renderAccessoriesEmbed(target.ign, result) };
};

/** The one-line form both advice commands collapse to for guild chat. */
function adviceText(ign: string, result: HypixelResult<AdviceDTO>): string {
  if (!result.ok) return `${ign}: ${renderFailure(result.error.state)}`;
  const first = result.value.data.items[0];
  return first ? `${ign}: ${first.title}` : `${ign}: nothing obvious to improve.`;
}

const nextupgrade: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const result = await deps.progression.getUpgradeAdvice(
    target.uuid,
    ctx.args.getString("focus") ?? "general",
    ctx.args.getString("profile") ?? undefined,
  );
  return {
    ephemeral: false,
    text: adviceText(target.ign, result),
    embed: renderAdviceEmbed(target.ign, "next upgrade", result),
  };
};

const whatnext: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const result = await deps.progression.getNextSteps(
    target.uuid,
    ctx.args.getString("goal") ?? "general",
    ctx.args.getString("profile") ?? undefined,
  );
  return {
    ephemeral: false,
    text: adviceText(target.ign, result),
    embed: renderAdviceEmbed(target.ign, "what next", result),
  };
};

const METRICS: readonly ProgressMetric[] = [
  "skyblockLevel",
  "networth",
  "skillAverage",
  "catacombsLevel",
];

const progress: CommandHandler = async (ctx, deps) => {
  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) {
    return { ephemeral: true, text: renderFailure("NOT_LINKED") };
  }
  const raw = ctx.args.getString("metric");
  // An unrecognised metric falls back to networth rather than erroring — the
  // option is choice-constrained at the Discord layer, so this only guards the
  // in-game and test paths.
  const metric = METRICS.find((m) => m === raw) ?? "networth";
  const range = ctx.args.getNumber("range") ?? 30;

  const result = await deps.progression.getProgress(linked.value.minecraftUuid, metric, range);
  const series = result.ok
    ? result.value
    : { metric, rangeDays: range, points: [] as const, change: null, perDay: null };

  return {
    ephemeral: false,
    text: `${linked.value.ign}: ${metric} over ${range}d — ${
      series.change === null ? "not enough history" : `${series.change >= 0 ? "+" : ""}${series.change}`
    }`,
    embed: renderProgressEmbed(linked.value.ign, series),
  };
};

/** Shared `player`/`profile` options — every lookup command accepts both. */
/**
 * Turn what the member typed into a canonical item id.
 *
 * Autocomplete already sends an id, but the option is free text — someone can
 * type "hyperion" and submit before a suggestion lands — so every economy
 * handler resolves through the catalog rather than trusting the raw string.
 */
async function resolveItem(
  ctx: CommandContext,
  deps: HandlerDeps,
): Promise<string | { readonly problem: string }> {
  const typed = ctx.args.getString("item");
  if (!typed) return { problem: "Which item? Pass `item:` — suggestions appear as you type." };

  const itemId = await deps.market.resolveItemId(typed);
  return itemId ?? { problem: `No Skyblock item matching "${typed}".` };
}

/** Shared by every economy command: the item catalog, filtered as you type. */
const itemAutocomplete: AutocompleteHandler = async (focused, _ctx, deps) => {
  const matches = await deps.market.searchItems(focused.value, 25);
  return matches.map((m) => ({ name: m.displayName, value: m.itemId }));
};

const ITEM_OPTION = {
  name: "item",
  description: "Item name or id",
  type: "string" as const,
  required: true,
  autocomplete: true,
};

/**
 * `/price` — the market card.
 *
 * This used to be four commands. `/price` blended a valuation, `/bazaar` printed
 * the order book, `/lowestbin` printed one number and `/auctions item:` listed
 * the cheapest listings — four cards about one item, and no way to get from one
 * to the next except by typing the next one out. They are one card with buttons
 * now; `packages/commands-bridge/src/market.ts` explains the shape of it.
 *
 * The blended valuation is gone rather than moved. It averaged a bazaar price
 * and a BIN price into a number that was neither, and the two numbers it was
 * made of are both on the card, which is what somebody deciding whether to buy
 * actually needs.
 */
const price: CommandHandler = async (ctx, deps) => {
  const itemId = await resolveItem(ctx, deps);
  if (typeof itemId !== "string") return { ephemeral: true, text: itemId.problem };

  return marketReply(itemId, DEFAULT_RANGE, deps);
};

/**
 * The one-line form for in-game chat, where there is no embed. Unclaimed coins
 * lead: it is the only part of an auction summary that needs acting on.
 */
function auctionsText(ign: string, data: AuctionsDTO): string {
  const claim =
    data.claimValue === null ? "" : ` · ${formatCoins(data.claimValue)} to claim`;
  const back = data.expired.length > 0 ? ` · ${data.expired.length} expired` : "";
  return `${ign}: ${data.active.length} active${claim}${back}`;
}

/**
 * `/auctions` — what a player has up.
 *
 * It used to answer two questions: an item's cheapest listings, or a player's
 * own. The first of those is now a button on the market card, next to the price
 * it is a list of, so this is the half that remains — and it is the half a
 * command is the right shape for, because it takes a player rather than an item.
 */
const auctions: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const result = await deps.market.getPlayerAuctions(target.uuid);
  return {
    ephemeral: false,
    text: result.ok
      ? auctionsText(target.ign, result.value.data)
      : renderFailure(result.error.state),
    embed: renderAuctionsEmbed(target.ign, result),
  };
};

/**
 * `/online` — the guild roster, read live from the in-game bridge.
 *
 * The two "no answer" cases are reported differently on purpose. No roster
 * source at all means this deployment has no Mineflayer session, which is a
 * permanent property of the install; a source that returns null means the
 * bridge is down *right now*, which is temporary and worth retrying. Collapsing
 * them into one message would leave a member unable to tell "never works here"
 * from "try again in a minute".
 */
const online: CommandHandler = async (_ctx, deps) => {
  if (!deps.roster) {
    return { ephemeral: true, text: E.bridge.notConfigured };
  }

  const roster = await deps.roster.online();
  if (roster === null) {
    return {
      ephemeral: true,
      text: E.bridge.offline,
    };
  }
  // Playtime is asked for separately and its absence is not an error: the
  // tracker is empty for the first minutes after a bridge restart, and a roster
  // without durations is still the answer to the question that was typed.
  const playing = deps.playtime ? await deps.playtime.playing() : [];
  const embed = renderRosterEmbed(roster, playing);
  // `text` stays populated as the documented fallback — Discord shows the embed
  // and ignores it, but the in-game and panel surfaces render from it.
  return { ephemeral: false, text: flattenEmbed(embed), embed };
};

const TARGET_OPTIONS = [
  { name: "player", description: "Minecraft username (defaults to you)", type: "string" as const },
  { name: "profile", description: "Skyblock profile name", type: "string" as const },
];

/** The one place the boss list is written down, so the choices cannot drift. */
const SLAYER_BOSS_OPTION: CommandOptionSpec = {
  name: "boss",
  description: "Narrow to one boss (every boss shows its tier breakdown either way)",
  type: "string",
  choices: [
    { name: "Zombie", value: "zombie" },
    { name: "Spider", value: "spider" },
    { name: "Wolf", value: "wolf" },
    { name: "Enderman", value: "enderman" },
    { name: "Blaze", value: "blaze" },
    { name: "Vampire", value: "vampire" },
  ],
};

export function buildBridgeRegistry(): Map<string, CommandSpec> {
  const specs: CommandSpec[] = [
    {
      name: "help",
      category: "ACCOUNT",
      description: "List member commands",
      cooldownMs: 3_000,
      inGame: true,
      handler: help,
    },
    {
      name: "link",
      category: "ACCOUNT",
      description: "Link your Minecraft account (your Hypixel Discord social must match)",
      // Optional since `/verify` folded in: no IGN re-checks the account on
      // file, which is the repair path.
      options: [{ name: "ign", description: "Your Minecraft username", type: "string" }],
      cooldownMs: 10_000,
      handler: link,
    },
    {
      name: "verify",
      category: "ACCOUNT",
      description: "Re-run the Hypixel social check to confirm or repair your link",
      options: [{ name: "ign", description: "Minecraft username", type: "string" }],
      cooldownMs: 10_000,
      // Retired: folded into `/link`, which now re-checks the account on file
      // when called without an IGN. Two commands for one call was one too many
      // at the moment a member is most confused — `/verify` existed because
      // `/link` had failed, and pointing a stuck member at a second command is
      // not a repair path anybody finds. The handler stays compiled and tested;
      // this flag is what deregisters it from Discord.
      enabled: false,
      handler: verify,
    },
    {
      name: "unlink",
      category: "ACCOUNT",
      description: "Remove your linked Minecraft account",
      cooldownMs: 10_000,
      handler: unlink,
    },
    {
      name: "me",
      category: "ACCOUNT",
      description: "Show your own profile summary",
      cooldownMs: 10_000,
      handler: me,
    },
    {
      name: "leaderboard",
      category: "GUILD",
      description: "Guild rankings — wealth, tenure, skills, activity and XP",
      options: [
        {
          name: "category",
          description: "Which board to show (defaults to guild XP)",
          type: "string",
          choices: LEADERBOARD_CATEGORIES.map((id) => ({
            name: LEADERBOARD_LABELS[id],
            value: id,
          })),
        },
        {
          name: "page",
          description: "Page of results",
          type: "number",
          minValue: 1,
          // Discord-only. Guild chat gets the top five on one line, and a second
          // positional would make `!top wealth 2` ambiguous with a category.
          inGamePositional: false,
        },
        {
          name: "days",
          description: "Window for the activity boards (default 30)",
          type: "number",
          minValue: 1,
          maxValue: 365,
          inGamePositional: false,
        },
      ],
      cooldownMs: 15_000,
      // A read-only view of the guild's own numbers, keyed by nothing the caller
      // has to prove — the viewer line is the only personalised part, and it is
      // simply absent for an unlinked speaker.
      inGame: true,
      handler: leaderboard,
    },
    {
      name: "profile",
      category: "ACCOUNT",
      description: "View a player's Skyblock profiles",
      options: TARGET_OPTIONS,
      cooldownMs: 10_000,
      inGame: true,
      handler: profile,
    },
    {
      name: "setprofile",
      category: "ACCOUNT",
      description: "Choose which Skyblock profile your lookups use",
      options: [
        {
          name: "profile",
          description: "Profile name",
          type: "string",
          required: true,
          autocomplete: true,
        },
      ],
      cooldownMs: 10_000,
      handler: setprofile,
      autocomplete: setprofileAutocomplete,
    },
    {
      name: "stats",
      category: "PROGRESS",
      description: "Broad stat overview for a player",
      options: TARGET_OPTIONS,
      capability: "RUN_COMMAND",
      cooldownMs: 15_000,
      inGame: true,
      // Retired: every number it printed is on a card that says more about it —
      // skills on /skills, slayer on /slayers, catacombs on /dungeons, the
      // headline figures on /profile. A summary of four better commands is a
      // fifth thing to learn, not a shortcut.
      enabled: false,
      handler: stats,
    },
    {
      name: "skills",
      category: "PROGRESS",
      description: "Skill levels and XP to next",
      options: [
        ...TARGET_OPTIONS,
        { name: "skill", description: "One skill only", type: "string" },
      ],
      capability: "RUN_COMMAND",
      cooldownMs: 15_000,
      inGame: true,
      handler: skills,
    },
    {
      name: "slayers",
      category: "PROGRESS",
      description: "Slayer XP, tiers and per-tier boss kills",
      options: [...TARGET_OPTIONS, SLAYER_BOSS_OPTION],
      capability: "RUN_COMMAND",
      cooldownMs: 15_000,
      inGame: true,
      handler: slayer,
    },
    {
      name: "dungeons",
      category: "PROGRESS",
      description: "Catacombs level, classes and floor bests",
      options: TARGET_OPTIONS,
      capability: "RUN_COMMAND",
      cooldownMs: 15_000,
      inGame: true,
      handler: dungeons,
    },
    {
      name: "networth",
      category: "PROGRESS",
      description: "Networth estimate with a category breakdown",
      options: TARGET_OPTIONS,
      capability: "RUN_COMMAND",
      cooldownMs: 15_000,
      inGame: true,
      handler: networth,
    },
    {
      name: "online",
      category: "GUILD",
      description: "Who's online in the guild right now",
      // Long compared with the other lookups: every invocation costs the bridge
      // account a `/g online`, and Hypixel rate-limits commands from a single
      // account hard enough that a spammed one silences the whole bridge. The
      // transport also serves repeats inside the window from cache.
      cooldownMs: 30_000,
      // Deliberately Discord-only. In-game the answer is `/g online`, which any
      // player can type themselves and which costs the bridge account nothing.
      handler: online,
    },
    {
      name: "milestones",
      category: "PROGRESS",
      description: "Thresholds a player has crossed",
      options: [TARGET_OPTIONS[0]!],
      cooldownMs: 15_000,
      handler: milestones,
    },
    {
      name: "progress",
      category: "PROGRESS",
      description: "Your progression over time",
      options: [
        {
          name: "metric",
          description: "What to chart",
          type: "string",
          choices: [
            { name: "SkyBlock Level", value: "skyblockLevel" },
            { name: "Networth", value: "networth" },
            { name: "Skill average", value: "skillAverage" },
            { name: "Catacombs", value: "catacombsLevel" },
          ],
        },
        {
          name: "range",
          description: "Days to look back (default 30)",
          type: "number",
          minValue: 1,
          maxValue: 365,
        },
      ],
      cooldownMs: 15_000,
      // Retired: merged into /progression. Charting, the goal for the charted
      // metric, and the save that makes next week's chart possible were three
      // commands around one loop, and none of them mentioned the other two — so
      // the usual first experience of this one was an empty chart and no idea
      // why. The spec stays so the handler stays compiled and tested; this flag
      // is what deregisters the command from Discord and the in-game router.
      enabled: false,
      inGame: "linked",
      handler: progress,
    },
    {
      name: "missing",
      category: "PROGRESS",
      description: "Notable accessories a player is missing or could upgrade",
      options: TARGET_OPTIONS,
      capability: "RUN_COMMAND",
      cooldownMs: 30_000,
      // Retired: the advice engine reads a live auction house the platform no
      // longer keeps warm, so its suggestions were confident and stale — worse
      // than no suggestion. Decision 2 of Phase 17 in
      // `~/.claude/plans/typed-dreaming-torvalds.md`. The engine
      // (`packages/progression/src/skyblock/advice.ts`) and this handler stay
      // compiled and tested; turning it back on is this one line.
      enabled: false,
      handler: missing,
    },
    {
      name: "nextupgrade",
      category: "PROGRESS",
      description: "The highest-value upgrade to buy next",
      options: [
        ...TARGET_OPTIONS,
        {
          name: "focus",
          description: "What to optimize for (default general)",
          type: "string",
          choices: [
            { name: "Damage", value: "dps" },
            { name: "Survivability", value: "ehp" },
            { name: "Farming", value: "farming" },
            { name: "Mining", value: "mining" },
            { name: "Dungeons", value: "dungeons" },
            { name: "Slayer", value: "slayer" },
            { name: "General", value: "general" },
          ],
        },
      ],
      capability: "RUN_COMMAND",
      cooldownMs: 30_000,
      // Retired: the advice engine reads a live auction house the platform no
      // longer keeps warm, so its suggestions were confident and stale — worse
      // than no suggestion. Decision 2 of Phase 17 in
      // `~/.claude/plans/typed-dreaming-torvalds.md`. The engine
      // (`packages/progression/src/skyblock/advice.ts`) and this handler stay
      // compiled and tested; turning it back on is this one line.
      enabled: false,
      handler: nextupgrade,
    },
    {
      name: "whatnext",
      category: "PROGRESS",
      description: "Suggested next steps for a player's progression",
      options: [
        ...TARGET_OPTIONS,
        {
          name: "goal",
          description: "What you're working towards (default general)",
          type: "string",
          choices: [
            { name: "Weight", value: "weight" },
            { name: "Networth", value: "networth" },
            { name: "Dungeons", value: "dungeons" },
            { name: "Slayer", value: "slayer" },
            { name: "Skills", value: "skills" },
            { name: "General", value: "general" },
          ],
        },
      ],
      capability: "RUN_COMMAND",
      cooldownMs: 30_000,
      // Retired: the advice engine reads a live auction house the platform no
      // longer keeps warm, so its suggestions were confident and stale — worse
      // than no suggestion. Decision 2 of Phase 17 in
      // `~/.claude/plans/typed-dreaming-torvalds.md`. The engine
      // (`packages/progression/src/skyblock/advice.ts`) and this handler stay
      // compiled and tested; turning it back on is this one line.
      enabled: false,
      handler: whatnext,
    },
    {
      name: "price",
      category: "MARKET",
      description: "What an item costs, what is moving, and what it has been doing",
      options: [ITEM_OPTION],
      cooldownMs: 5_000,
      inGame: true,
      handler: price,
      autocomplete: itemAutocomplete,
    },
    // Retired into `/price`, which shows the whole order book — instant buy,
    // instant sell, spread and both volumes — rather than the subset this
    // printed. Deregistered rather than deleted so the shape of what was here
    // stays readable, and `!bz` still routes to the card.
    {
      name: "bazaar",
      category: "MARKET",
      description: "Bazaar order book for an item",
      options: [ITEM_OPTION],
      cooldownMs: 5_000,
      enabled: false,
      handler: price,
      autocomplete: itemAutocomplete,
    },
    // Retired into `/price` for the same reason: the lowest BIN and the number
    // of listings behind it are both on the card, and one number without the
    // other was always the misleading half.
    {
      name: "lowestbin",
      category: "MARKET",
      description: "Cheapest buy-it-now listing for an item",
      options: [ITEM_OPTION],
      cooldownMs: 5_000,
      enabled: false,
      handler: price,
      autocomplete: itemAutocomplete,
    },
    // Narrowed, not removed: `item:` is gone because the cheapest listings are a
    // button on the market card, which is where somebody looking at a price
    // wants them. What is left is the question the card cannot answer — what a
    // *player* has up — so the option is dropped rather than the command.
    {
      name: "auctions",
      category: "MARKET",
      description: "A player's own auction listings",
      options: [TARGET_OPTIONS[0]!],
      cooldownMs: 15_000,
      handler: auctions,
    },
    ...communitySpecs(),
    ...healthSpecs(),
    ...infoSpecs(),
    ...levelAlertSpecs(),
    ...goalSpecs(),
    ...snapshotSpecs(),
    ...progressionSpecs(),
    ...reminderSpecs(),
    ...tagSpecs(),
    ...permSpecs(),
    ...funSpecs(),
  ];
  // The descriptions below are the fallback, not the answer: `withCommandCopy`
  // replaces them with whatever `brand/copy.ts` resolves to. This is the only
  // place the registry is built, so slash registration, `/help`, in-game `!help`
  // and the panel's command docs cannot end up quoting different words.
  return withCommandCopy(new Map(specs.map((s) => [s.name, s])));
}
