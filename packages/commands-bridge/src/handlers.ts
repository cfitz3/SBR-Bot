/**
 * Member bot command handlers. Thin: resolve identity, call a domain service,
 * render. The registry wires these with capability + cooldown metadata, and the
 * Discord registration payload is derived from the same specs.
 */
import { flattenEmbed } from "@sbr/shared-types";
import type { AdviceDTO, HypixelResult, LinkActor, ProgressMetric } from "@sbr/shared-types";
import type {
  AutocompleteHandler,
  CommandContext,
  CommandHandler,
  CommandSpec,
  HandlerDeps,
} from "./types.js";
import { communitySpecs } from "./handlers-community.js";
import {
  renderAccessoriesEmbed,
  renderAdviceEmbed,
  renderAuctionsEmbed,
  renderBazaarEmbed,
  renderDungeonsEmbed,
  renderFailure,
  renderLinkError,
  renderLowestBinEmbed,
  renderMilestonesEmbed,
  renderNetworth,
  renderNetworthEmbed,
  renderPriceEmbed,
  renderProfileEmbed,
  renderProfileListEmbed,
  renderProgressEmbed,
  renderRosterEmbed,
  renderSkillsEmbed,
  renderSlayersEmbed,
  renderStatsEmbed,
  formatCoins,
  formatLevel,
} from "./render.js";

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

const help: CommandHandler = async () => ({
  ephemeral: true,
  text: [
    "Account: /link /verify /unlink /me /profile /setprofile",
    "Stats: /stats /skills /slayer /dungeons /networth /progress /milestones",
    "Optimize: /missing /nextupgrade /whatnext",
    "Market: /price /bazaar /lowestbin /auctions",
    "Guild: /online",
    "Events: /events /create-event /rsvp /attendance",
    "Groups: /lfg /runs /joinrun /leaverun",
    "Help: /ticket /help",
  ].join("\n"),
});

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

const link: CommandHandler = async (ctx, deps) => {
  const ign = ctx.args.getString("ign");
  if (!ign) return { ephemeral: true, text: "Usage: /link <ign>" };

  const result = await deps.identity.linkByIgn(linkActor(ctx), ign);
  if (!result.ok) return { ephemeral: true, text: renderLinkError(result.error) };
  return { ephemeral: true, text: `Linked to ${result.value.ign}. ✅` };
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
  return { ephemeral: true, text: `Verified as ${result.value.ign}. ✅` };
};

const unlink: CommandHandler = async (ctx, deps) => {
  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) {
    return { ephemeral: true, text: "You have no linked account." };
  }
  const result = await deps.identity.unlink(ctx.userId, linked.value.minecraftUuid);
  if (!result.ok) return { ephemeral: true, text: "Couldn't unlink right now — try again shortly." };
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
    // any surface can render.
    text: `${target.ign}: ${renderNetworth(nw)}`,
    embed: renderNetworthEmbed(target.ign, nw),
  };
};

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

/** `/me` is `/stats` pinned to the caller — it never accepts a player. */
const me: CommandHandler = async (ctx, deps) => {
  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) {
    return { ephemeral: true, text: renderFailure("NOT_LINKED") };
  }
  const [summary, slayers, dungeons, nw] = await Promise.all([
    deps.progression.getProfileSummary(linked.value.minecraftUuid),
    deps.progression.getSlayers(linked.value.minecraftUuid),
    deps.progression.getDungeons(linked.value.minecraftUuid),
    deps.progression.getNetworth(linked.value.minecraftUuid),
  ]);
  return {
    ephemeral: true,
    text: `${linked.value.ign}: ${renderNetworth(nw)}`,
    embed: renderStatsEmbed(linked.value.ign, summary, slayers, dungeons, nw),
  };
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
  return { ephemeral: false, text, embed: renderSkillsEmbed(target.ign, result, only) };
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
  return { ephemeral: false, text, embed: renderSlayersEmbed(target.ign, result, only) };
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
          : "Can't change your profile right now — try again shortly.",
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

const milestones: CommandHandler = async (ctx, deps) => {
  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const result = await deps.progression.getMilestones(target.uuid, 10);
  const list = result.ok ? result.value : [];
  return {
    ephemeral: false,
    text: `${target.ign}: ${list.length} milestone(s) recorded`,
    embed: renderMilestonesEmbed(target.ign, list),
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
  "networth",
  "skillAverage",
  "catacombsLevel",
  "senitherWeight",
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
    : { metric, rangeDays: range, points: [] as const, change: null };

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

const price: CommandHandler = async (ctx, deps) => {
  const itemId = await resolveItem(ctx, deps);
  if (typeof itemId !== "string") return { ephemeral: true, text: itemId.problem };

  const result = await deps.pricing.getPrice(itemId);
  return {
    ephemeral: false,
    text: result.ok
      ? `${itemId}: ${result.value.data.estimatedValue === null ? "unknown" : formatCoins(result.value.data.estimatedValue)}`
      : renderFailure(result.error.state),
    embed: renderPriceEmbed(result),
  };
};

const bazaar: CommandHandler = async (ctx, deps) => {
  const itemId = await resolveItem(ctx, deps);
  if (typeof itemId !== "string") return { ephemeral: true, text: itemId.problem };

  const result = await deps.market.getBazaarQuote(itemId);
  return {
    ephemeral: false,
    text: result.ok
      ? `${itemId}: buy ${result.value.data.instantBuy === null ? "—" : formatCoins(result.value.data.instantBuy)} / sell ${result.value.data.instantSell === null ? "—" : formatCoins(result.value.data.instantSell)}`
      : // An item that simply isn't tradeable on the bazaar is not a failure of
        // ours, so it says so rather than reporting an outage.
        result.error.state === "MISSING_PROFILE"
        ? `${itemId} isn't sold on the bazaar — try /lowestbin.`
        : renderFailure(result.error.state),
    embed: renderBazaarEmbed(result),
  };
};

const lowestbin: CommandHandler = async (ctx, deps) => {
  const itemId = await resolveItem(ctx, deps);
  if (typeof itemId !== "string") return { ephemeral: true, text: itemId.problem };

  const result = await deps.market.getLowestBin(itemId);
  return {
    ephemeral: false,
    text: result.ok
      ? `${itemId}: ${result.value.data.price === null ? "no BIN listing" : formatCoins(result.value.data.price)}`
      : renderFailure(result.error.state),
    embed: renderLowestBinEmbed(result),
  };
};

/**
 * `/auctions` answers two questions with one command: an item's cheapest
 * listings, or a player's own. `item:` wins when both are given, because it is
 * the more specific ask.
 */
const auctions: CommandHandler = async (ctx, deps) => {
  if (ctx.args.getString("item")) {
    const itemId = await resolveItem(ctx, deps);
    if (typeof itemId !== "string") return { ephemeral: true, text: itemId.problem };

    const result = await deps.market.getItemAuctions(itemId);
    return {
      ephemeral: false,
      text: result.ok
        ? `${itemId}: ${result.value.data.listings.length} listing(s)`
        : renderFailure(result.error.state),
      embed: renderAuctionsEmbed(itemId, result),
    };
  }

  const target = await resolveTarget(ctx, deps);
  if ("problem" in target) return { ephemeral: true, text: target.problem };

  const result = await deps.market.getPlayerAuctions(target.uuid);
  return {
    ephemeral: false,
    text: result.ok
      ? `${target.ign}: ${result.value.data.listings.length} active auction(s)`
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
    return { ephemeral: true, text: "The in-game bridge isn't set up here, so I can't see who's online." };
  }

  const roster = await deps.roster.online();
  if (roster === null) {
    return {
      ephemeral: true,
      text: "The in-game bridge is offline right now, so I can't read the guild roster — try again shortly.",
    };
  }
  const embed = renderRosterEmbed(roster);
  // `text` stays populated as the documented fallback — Discord shows the embed
  // and ignores it, but the in-game and panel surfaces render from it.
  return { ephemeral: false, text: flattenEmbed(embed), embed };
};

const TARGET_OPTIONS = [
  { name: "player", description: "Minecraft username (defaults to you)", type: "string" as const },
  { name: "profile", description: "Skyblock profile name", type: "string" as const },
];

export function buildBridgeRegistry(): Map<string, CommandSpec> {
  const specs: CommandSpec[] = [
    {
      name: "help",
      description: "List member commands",
      cooldownMs: 3_000,
      inGame: true,
      handler: help,
    },
    {
      name: "link",
      description: "Link your Minecraft account (your Hypixel Discord social must match)",
      options: [
        { name: "ign", description: "Your Minecraft username", type: "string", required: true },
      ],
      cooldownMs: 10_000,
      handler: link,
    },
    {
      name: "verify",
      description: "Re-run the Hypixel social check to confirm or repair your link",
      options: [{ name: "ign", description: "Minecraft username", type: "string" }],
      cooldownMs: 10_000,
      handler: verify,
    },
    {
      name: "unlink",
      description: "Remove your linked Minecraft account",
      cooldownMs: 10_000,
      handler: unlink,
    },
    {
      name: "me",
      description: "Show your own profile summary",
      cooldownMs: 10_000,
      handler: me,
    },
    {
      name: "profile",
      description: "View a player's Skyblock profiles",
      options: TARGET_OPTIONS,
      cooldownMs: 10_000,
      inGame: true,
      handler: profile,
    },
    {
      name: "setprofile",
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
      description: "Broad stat overview for a player",
      options: TARGET_OPTIONS,
      capability: "RUN_COMMAND",
      cooldownMs: 15_000,
      inGame: true,
      handler: stats,
    },
    {
      name: "skills",
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
      name: "slayer",
      description: "Slayer XP, tiers and boss kills",
      options: [
        ...TARGET_OPTIONS,
        {
          name: "boss",
          description: "One slayer only",
          type: "string",
          choices: [
            { name: "Zombie", value: "zombie" },
            { name: "Spider", value: "spider" },
            { name: "Wolf", value: "wolf" },
            { name: "Enderman", value: "enderman" },
            { name: "Blaze", value: "blaze" },
            { name: "Vampire", value: "vampire" },
          ],
        },
      ],
      capability: "RUN_COMMAND",
      cooldownMs: 15_000,
      inGame: true,
      handler: slayer,
    },
    {
      name: "dungeons",
      description: "Catacombs level, classes and floor bests",
      options: TARGET_OPTIONS,
      capability: "RUN_COMMAND",
      cooldownMs: 15_000,
      inGame: true,
      handler: dungeons,
    },
    {
      name: "networth",
      description: "Networth estimate with a category breakdown",
      options: TARGET_OPTIONS,
      capability: "RUN_COMMAND",
      cooldownMs: 15_000,
      inGame: true,
      handler: networth,
    },
    {
      name: "online",
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
      description: "Thresholds a player has crossed",
      options: [TARGET_OPTIONS[0]!],
      cooldownMs: 15_000,
      handler: milestones,
    },
    {
      name: "progress",
      description: "Your progression over time",
      options: [
        {
          name: "metric",
          description: "What to chart",
          type: "string",
          choices: [
            { name: "Networth", value: "networth" },
            { name: "Skill average", value: "skillAverage" },
            { name: "Catacombs", value: "catacombsLevel" },
            { name: "Weight", value: "senitherWeight" },
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
      handler: progress,
    },
    {
      name: "missing",
      description: "Notable accessories a player is missing or could upgrade",
      options: TARGET_OPTIONS,
      capability: "RUN_COMMAND",
      cooldownMs: 30_000,
      handler: missing,
    },
    {
      name: "nextupgrade",
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
      handler: nextupgrade,
    },
    {
      name: "whatnext",
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
      handler: whatnext,
    },
    {
      name: "price",
      description: "Blended market value for an item",
      options: [ITEM_OPTION],
      cooldownMs: 5_000,
      inGame: true,
      handler: price,
      autocomplete: itemAutocomplete,
    },
    {
      name: "bazaar",
      description: "Bazaar order book for an item",
      options: [ITEM_OPTION],
      cooldownMs: 5_000,
      inGame: true,
      handler: bazaar,
      autocomplete: itemAutocomplete,
    },
    {
      name: "lowestbin",
      description: "Cheapest buy-it-now listing for an item",
      options: [ITEM_OPTION],
      cooldownMs: 5_000,
      inGame: true,
      handler: lowestbin,
      autocomplete: itemAutocomplete,
    },
    {
      name: "auctions",
      description: "Active auctions for an item, or a player's own listings",
      options: [
        { ...ITEM_OPTION, required: false },
        TARGET_OPTIONS[0]!,
      ],
      cooldownMs: 15_000,
      handler: auctions,
      autocomplete: itemAutocomplete,
    },
    ...communitySpecs(),
  ];
  return new Map(specs.map((s) => [s.name, s]));
}
