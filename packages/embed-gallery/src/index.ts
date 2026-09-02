/**
 * @sbr/embed-gallery — every card this platform can send, rendered once.
 *
 * The gallery calls the *real* renderers over fixed data (`fixtures.ts`). That
 * is the whole point: a style check run against cards written for the check
 * would only ever prove the check agrees with itself. Here, a renderer that
 * starts shouting in its title, or joins with the wrong separator, or prints a
 * raw snowflake, fails `npm run embeds check` on the next run.
 *
 * Each card records which function drew it — taken from the function, not typed
 * out again — so `coverage.test.ts` can compare the gallery against the set of
 * renderers the command packages export and fail on one that was never listed.
 * An unlisted card is an unchecked card, and that is the failure this package
 * exists to prevent.
 */
import {
  renderApplicationEmbed,
  renderApplicationListEmbed,
  renderAuditPages,
  renderFilterTestEmbed,
  renderInfractionPages,
  renderSafetyStatusEmbed,
  renderWordlistEmbed,
} from "@sbr/commands-admin";
import {
  renderAccessoriesEmbed,
  renderAchievementsEmbed,
  renderAdviceEmbed,
  renderAttendanceEmbed,
  renderAuctionsEmbed,
  renderListingsEmbed,
  renderMarketEmbed,
  renderDungeonsEmbed,
  renderEventEmbed,
  renderEventBoardEmbed,
  renderEventReminderEmbed,
  renderEventsEmbed,
  renderLeaderboardEmbed,
  renderLfgEmbed,
  renderLfgListEmbed,
  renderLevelUpEmbed,
  renderMilestoneEmbed,
  renderNetworthCategoryEmbed,
  renderNetworthEmbed,
  renderPermEmbed,
  renderPermListEmbed,
  renderProfileEmbed,
  renderProfileListEmbed,
  renderGoalAchievedEmbed,
  renderHealthEmbed,
  renderGoalsEmbed,
  renderProgressEmbed,
  renderHelpEmbed,
  renderLinkHelpEmbed,
  renderProgressionEmbed,
  renderRosterEmbed,
  renderServerInfoEmbed,
  renderSkillsEmbed,
  renderSlayersEmbed,
  renderProfileCardEmbed,
  renderStatsEmbed,
  renderTicketEmbed,
  renderTicketListEmbed,
  renderWhoisEmbed,
} from "@sbr/commands-bridge";
import { renderTriggerPostEmbed } from "@sbr/triggers";
import type {
  BazaarQuoteDTO,
  DungeonsDTO,
  EmbedView,
  LowestBinDTO,
  NetworthDTO,
  ProfileSummaryDTO,
  SlayersDTO,
} from "@sbr/shared-types";

import * as f from "./fixtures.js";

export interface GalleryCard {
  /** Stable id, used by `npm run embeds check|preview`. Kebab-case, never prose. */
  readonly name: string;
  /** One line on what this card is for and why it is in the gallery. */
  readonly about: string;
  /** The renderer's own function name, so coverage is measured, not asserted. */
  readonly renderer: string;
  readonly view: EmbedView;
  /**
   * House-style rules this card breaks on purpose, by id.
   *
   * Per card, never per run: a waiver is a statement about one card, and one
   * switched off run-wide stops the check catching every other card that
   * breaks it by accident.
   */
  readonly ignore?: readonly string[];
}

const IGN = "Aria";
/** A real-shaped uuid, so the author head and thumbnail render rather than fall back. */
const UUID = "4d9a51f6a1b7482c9e0b1d3c5f7a9b2e";

/** One card from one renderer. The arguments are checked against its signature. */
function card<A extends readonly unknown[]>(
  name: string,
  about: string,
  render: (...args: A) => EmbedView,
  ...args: A
): GalleryCard {
  return { name, about, renderer: render.name, view: render(...args) };
}

/** A card that breaks a named rule for a reason, with the reason next to it. */
function except(base: GalleryCard, ...rules: readonly string[]): GalleryCard {
  return { ...base, ignore: rules };
}

/**
 * The paged renderers hand back an array. Every page is checked in its own
 * right — page two of a history is as sendable as page one, and just as capable
 * of being over Discord's limits.
 */
function paged<A extends readonly unknown[]>(
  name: string,
  about: string,
  render: (...args: A) => readonly EmbedView[],
  ...args: A
): readonly GalleryCard[] {
  const views = render(...args);
  return views.map((view, i) => ({
    name: views.length === 1 ? name : `${name}-${i + 1}`,
    about,
    renderer: render.name,
    view,
  }));
}

export const GALLERY: readonly GalleryCard[] = [
  // ── Progression ───────────────────────────────────────────────────────────
  card("profile", "`/profile` — one profile's headline numbers.", renderProfileEmbed, IGN, f.live(f.PROFILE)),
  card(
    "profile-list",
    "`/profile` with no argument — every profile on the account.",
    renderProfileListEmbed,
    IGN,
    f.live(f.PROFILE_LIST),
  ),
  card("profile-list-empty", "An account with no SkyBlock profiles at all.", renderProfileListEmbed, IGN, f.live([])),
  card(
    "profile-not-linked",
    "The failure card every Hypixel read can produce.",
    renderProfileEmbed,
    IGN,
    f.failed("NOT_LINKED"),
  ),
  card(
    "profile-rate-limited",
    "Upstream refused us, not the member's fault — the wording matters.",
    renderProfileEmbed,
    IGN,
    f.failed("RATE_LIMITED"),
  ),
  card(
    "skills",
    "`/skills` — ten skills as two lists, one hidden, both corrected caps in view.",
    renderSkillsEmbed,
    IGN,
    f.live(f.SKILLS),
    undefined,
    UUID,
  ),
  card(
    "skills-one",
    "`/skills skill:combat` — the filtered form, which is the only one with room for a bar.",
    renderSkillsEmbed,
    IGN,
    f.live(f.SKILLS),
    "combat",
    UUID,
  ),
  card(
    "skills-one-hidden",
    "One skill asked for by name that this profile does not expose.",
    renderSkillsEmbed,
    IGN,
    f.live(f.SKILLS),
    "alchemy",
    UUID,
  ),
  card(
    "skills-api-off",
    "The skill API is off: unknown, stated as unknown.",
    renderSkillsEmbed,
    IGN,
    f.live(f.SKILLS_OFF),
    undefined,
    UUID,
  ),
  card(
    "slayers",
    "`/slayers` — every boss carries its own per-tier kills, including the one never started.",
    renderSlayersEmbed,
    IGN,
    f.live(f.SLAYERS),
    undefined,
    UUID,
  ),
  card("slayers-one", "`/slayers boss:zombie`.", renderSlayersEmbed, IGN, f.live(f.SLAYERS), "zombie", UUID),
  card("dungeons", "`/dungeons` — classes, floors and master floors.", renderDungeonsEmbed, IGN, f.live(f.DUNGEONS)),
  card(
    "dungeons-unplayed",
    "Never entered the catacombs — nulls all the way down.",
    renderDungeonsEmbed,
    IGN,
    f.live(f.DUNGEONS_UNPLAYED),
  ),
  card(
    "networth",
    "`/networth` — every category as one column, with the hidden parts named.",
    renderNetworthEmbed,
    IGN,
    f.live(f.NETWORTH),
    f.UUID,
  ),
  card(
    "networth-stale",
    "The same card served from cache: the footer is the difference.",
    renderNetworthEmbed,
    IGN,
    f.stale(f.NETWORTH),
    f.UUID,
  ),
  card(
    "networth-category",
    "One category opened from the dropdown — the itemisation the overview no longer crams in.",
    renderNetworthCategoryEmbed,
    IGN,
    f.live(f.NETWORTH),
    "Storage",
    f.UUID,
  ),
  card(
    "networth-category-unitemised",
    "A category the valuation engine gave a total for but no items — the total is still true.",
    renderNetworthCategoryEmbed,
    IGN,
    f.live(f.NETWORTH),
    "Bank",
    f.UUID,
  ),
  card(
    "stats",
    "`/stats` — the composite card, every part readable.",
    renderStatsEmbed,
    IGN,
    f.live(f.PROFILE),
    f.live(f.SLAYERS),
    f.live(f.DUNGEONS),
    f.live(f.NETWORTH),
    f.STANDING,
  ),
  card(
    "profile-card",
    "`/me` — the member's own card, every section present, standing among them.",
    renderProfileCardEmbed,
    IGN,
    {
      profile: f.live(f.PROFILE),
      slayers: f.live(f.SLAYERS),
      dungeons: f.live(f.DUNGEONS),
      networth: f.live(f.NETWORTH),
      uuid: f.UUID,
      standing: f.STANDING,
      record: f.MEMBER_RECORD,
      achievements: f.ACHIEVEMENTS,
      podium: f.PODIUM,
      positions: f.POSITIONS,
    },
  ),
  card(
    "profile-card-lean",
    "`/me` on a deployment with XP, achievements and events all switched off.",
    renderProfileCardEmbed,
    IGN,
    {
      profile: f.live(f.PROFILE),
      slayers: f.live(f.SLAYERS),
      dungeons: f.live(f.DUNGEONS_UNPLAYED),
      networth: f.live(f.NETWORTH),
      // No uuid here on purpose: the author row has to read as a name when the
      // caller never resolved a head, and this is the card that shows it.
      achievements: f.ACHIEVEMENTS_OFF,
      podium: f.PODIUM_NO_MEDALS,
    },
  ),
  card(
    "profile-card-offline",
    "`/me` with Hypixel unreadable — the guild half of the card is still true.",
    renderProfileCardEmbed,
    IGN,
    {
      profile: f.failed<ProfileSummaryDTO>("RATE_LIMITED"),
      slayers: f.failed<SlayersDTO>("RATE_LIMITED"),
      dungeons: f.failed<DungeonsDTO>("RATE_LIMITED"),
      networth: f.failed<NetworthDTO>("RATE_LIMITED"),
      uuid: f.UUID,
      standing: f.STANDING,
      record: f.MEMBER_RECORD_CLEAN,
      achievements: f.ACHIEVEMENTS,
      podium: f.PODIUM,
      positions: f.POSITIONS,
    },
  ),
  card(
    "stats-partial",
    "`/stats` with two of four reads failed — the card still renders.",
    renderStatsEmbed,
    IGN,
    f.live(f.PROFILE),
    f.failed("API_DISABLED"),
    f.live(f.DUNGEONS_UNPLAYED),
    f.failed("RATE_LIMITED"),
    null,
  ),
  card(
    "accessories",
    "`/missing` — owned, missing, upgradeable, redundant.",
    renderAccessoriesEmbed,
    IGN,
    f.live(f.ACCESSORIES),
  ),
  card(
    "advice",
    "`/whatnext` — ranked suggestions from a readable profile.",
    renderAdviceEmbed,
    IGN,
    "next steps",
    f.live(f.ADVICE),
  ),
  card(
    "advice-generic",
    "Advice we could not personalise, labelled as such.",
    renderAdviceEmbed,
    IGN,
    "next steps",
    f.live(f.ADVICE_GENERIC),
  ),
  card("achievements", "`/milestones` — earned and upcoming.", renderAchievementsEmbed, IGN, f.ACHIEVEMENTS),
  card(
    "achievements-off",
    "Achievements switched off here — a different claim from 'you have none'.",
    renderAchievementsEmbed,
    IGN,
    f.ACHIEVEMENTS_OFF,
  ),
  card("progress", "`/progress` — a series with a gap in it.", renderProgressEmbed, IGN, f.PROGRESS),
  card("progression", "`/progression` — the trend, the pace and the goal on one card.", renderProgressionEmbed, {
    ign: IGN,
    uuid: f.UUID,
    metric: "networth",
    series: f.PROGRESS,
    goal: f.GOALS[0] ?? null,
    markers: f.PROGRESS.points.length,
  }),
  card(
    "progression-empty",
    "Before the first marker: an instruction, not an error, with the button that follows it.",
    renderProgressionEmbed,
    {
      ign: IGN,
      uuid: f.UUID,
      metric: "networth",
      series: { metric: "networth", rangeDays: 30, points: [], change: null, perDay: null },
      goal: null,
      markers: 0,
    },
  ),
  card(
    "progression-saved",
    "Straight after a save: what the press did, above what the member came to read.",
    renderProgressionEmbed,
    {
      ign: IGN,
      uuid: f.UUID,
      metric: "catacombsLevel",
      series: f.PROGRESS,
      goal: f.GOALS[1] ?? null,
      markers: f.PROGRESS.points.length,
      notice: "Marker saved — 5 of 24.",
    },
  ),
  card("help", "`/help` — the whole member surface, read off the registry.", renderHelpEmbed, {
    specs: f.HELP_SPECS,
    ign: null,
  }),
  card(
    "help-linked",
    "Once linked the headline stops nagging; the list is unchanged.",
    renderHelpEmbed,
    { specs: f.HELP_SPECS, ign: IGN },
  ),
  card(
    "help-link",
    "Behind the button: the platform's steps, this guild's note and its recording.",
    renderLinkHelpEmbed,
    f.LINK_HELP,
  ),
  card(
    "help-link-bare",
    "A guild that has configured nothing still gets the steps.",
    renderLinkHelpEmbed,
    { image: null, body: null },
  ),
  card(
    "starboard",
    "A trigger repost: who said it, what they said, and why it is here.",
    renderTriggerPostEmbed,
    f.STARBOARD,
  ),
  card(
    "starboard-bare",
    "An image with no caption — the card says so rather than rendering blank.",
    renderTriggerPostEmbed,
    f.STARBOARD_BARE,
  ),
  card("goals", "`/goal` — one target moving, one stalled.", renderGoalsEmbed, IGN, f.GOALS),
  card("goals-empty", "No goals set: an invitation, not an error.", renderGoalsEmbed, IGN, []),
  card(
    "goal-achieved",
    "The post when somebody arrives at a goal they set.",
    renderGoalAchievedEmbed,
    IGN,
    "networth",
    10_000_000_000,
  ),

  // ── Market ────────────────────────────────────────────────────────────────
  card(
    "market-auction",
    "`/price` for an auction item: lowest BIN, how many back it, and a week of it.",
    renderMarketEmbed,
    {
      itemId: "NECRON_HANDLE",
      bazaar: f.failed<BazaarQuoteDTO>("MISSING_PROFILE"),
      bin: f.live(f.LOWEST_BIN),
      history: f.HISTORY_WEEK,
      range: "WEEK" as const,
    },
  ),
  card("market-bazaar", "`/price` for a bazaar item: both sides, the spread and a day.", renderMarketEmbed, {
    itemId: "ENCHANTED_DIAMOND_BLOCK",
    bazaar: f.live(f.BAZAAR),
    bin: f.failed<LowestBinDTO>("MISSING_PROFILE"),
    history: f.HISTORY_DAY,
    range: "DAY" as const,
  }),
  card(
    "market-no-history",
    "Coflnet is down. The prices are ours, so they are still here.",
    renderMarketEmbed,
    {
      itemId: "NECRON_HANDLE",
      bazaar: f.failed<BazaarQuoteDTO>("MISSING_PROFILE"),
      bin: f.live(f.LOWEST_BIN),
      history: null,
      range: "WEEK" as const,
    },
  ),
  card("market-unpriced", "Nothing is being bought or sold: no price is not a price of zero.", renderMarketEmbed, {
    itemId: "PARTY_HAT_CRAB",
    bazaar: f.failed<BazaarQuoteDTO>("MISSING_PROFILE"),
    bin: f.live(f.LOWEST_BIN_NONE),
    history: f.HISTORY_EMPTY,
    range: "WEEK" as const,
  }),
  card(
    "market-listings",
    "The Listings button: what `/auctions item:` used to be.",
    renderListingsEmbed,
    "NECRON_HANDLE",
    "Necron's Handle",
    f.live(f.AUCTIONS),
  ),
  card("auctions", "`/auctions` — a player's running, sold and expired.", renderAuctionsEmbed, IGN, f.live(f.AUCTIONS), f.NOW),
  card("auctions-empty", "No listings at all.", renderAuctionsEmbed, IGN, f.live(f.AUCTIONS_EMPTY), f.NOW),

  // ── Guild ─────────────────────────────────────────────────────────────────
  card(
    "roster",
    "`/online` — the roster by rank, with how long each member has been playing.",
    renderRosterEmbed,
    f.ROSTER,
    f.PLAYING,
    f.NOW,
  ),
  card(
    "roster-no-playtime",
    "The same roster before the tracker has seen anybody arrive.",
    renderRosterEmbed,
    f.ROSTER,
    [],
    f.NOW,
  ),
  card("userinfo", "`/userinfo` — a member with more roles than fit.", renderUserInfoEmbed, f.DISCORD_USER),
  card(
    "userinfo-outsider",
    "An account Discord knows and this server does not.",
    renderUserInfoEmbed,
    f.DISCORD_USER_OUTSIDER,
  ),
  card("health", "`/health` — everything answering.", renderHealthEmbed, f.STATUS_OK),
  card(
    "serverinfo",
    "`/serverinfo` — the server's shape, and the week the platform counted.",
    renderServerInfoEmbed,
    f.DISCORD_GUILD,
    f.SERVER_WEEK,
  ),
  card(
    "serverinfo-quiet",
    "The same card on a week nobody spoke in — counted, and said so.",
    renderServerInfoEmbed,
    f.DISCORD_GUILD,
    f.SERVER_WEEK_QUIET,
  ),
  card(
    "serverinfo-uncounted",
    "A deployment keeping no counters: the Discord half, and no invented week.",
    renderServerInfoEmbed,
    f.DISCORD_GUILD,
    null,
  ),
  card(
    "health-degraded",
    "One named row slow, and one component the card is only allowed to count.",
    renderHealthEmbed,
    f.STATUS_DEGRADED,
  ),
  card("health-down", "The relay is gone; the bot answering is not.", renderHealthEmbed, f.STATUS_DOWN),
  card("serverinfo", "`/serverinfo` — the server at a glance.", renderServerInfoEmbed, f.DISCORD_GUILD),
  card(
    "leaderboard",
    "`/leaderboard` — ties, a mention label and a pinned viewer row.",
    renderLeaderboardEmbed,
    f.LEADERBOARD,
    f.NOW,
  ),
  card("leaderboard-empty", "A category nobody is ranked in yet.", renderLeaderboardEmbed, f.LEADERBOARD_EMPTY, f.NOW),

  // ── Community ─────────────────────────────────────────────────────────────
  card("events", "`/events` — the list, capped and uncapped.", renderEventsEmbed, f.EVENTS),
  card("events-empty", "Nothing scheduled.", renderEventsEmbed, []),
  card("event", "`/event` — one event, the card the RSVP buttons hang off.", renderEventEmbed, f.EVENT),
  card("event-reminder", "The bus-delivered \"starting soon\" notice.", renderEventReminderEmbed, f.EVENT_REMINDER),
  card("event-board", "The tracker board, edited in place while the event runs.", renderEventBoardEmbed, f.EVENT_BOARD),
  card("event-board-final", "The same message, one last edit into a result card.", renderEventBoardEmbed, f.EVENT_BOARD_FINAL),
  card("attendance", "Who turned up, then who said they were coming.", renderAttendanceEmbed, f.ATTENDANCE),
  card("lfg", "`/lfg` — a run looking for members.", renderLfgEmbed, f.LFG),
  card("lfg-list", "`/runs` — open and full.", renderLfgListEmbed, f.LFG_LIST),
  card("lfg-list-empty", "No runs open.", renderLfgListEmbed, []),
  card("perm", "`/perm` — a standing party and its roster.", renderPermEmbed, f.PERM),
  card("perm-list", "`/perms` — every party, disbanded included.", renderPermListEmbed, f.PERMS, false),
  card("perm-list-mine", "The same list addressed to its owner.", renderPermListEmbed, f.PERMS, true),
  card("ticket", "`/ticket` — one open ticket.", renderTicketEmbed, f.TICKET),
  card("ticket-list", "Open and closed together.", renderTicketListEmbed, f.TICKETS),
  card("ticket-list-empty", "No tickets.", renderTicketListEmbed, []),
  card(
    "milestone",
    "The announcement posted when a member crosses a threshold.",
    renderMilestoneEmbed,
    f.MILESTONE,
  ),
  card(
    "milestone-unlinked",
    "Crossed by somebody with no Discord link — no mention is possible.",
    renderMilestoneEmbed,
    f.MILESTONE_UNLINKED,
  ),
  card("level-up", "Posted in the `levels` channel when a member climbs a level.", renderLevelUpEmbed, f.LEVEL_UP),
  card(
    "level-up-jump",
    "Several levels at once, as a rebuild after a backfill can produce.",
    renderLevelUpEmbed,
    f.LEVEL_UP_JUMP,
  ),

  // ── Staff ─────────────────────────────────────────────────────────────────
  ...paged(
    "infractions",
    "`/history` — a member's record, paged.",
    renderInfractionPages,
    "100000000000000001",
    f.INFRACTIONS,
  ),
  ...paged("infractions-clean", "A member with nothing on record.", renderInfractionPages, "100000000000000009", []),
  ...paged("audit", "`/audit` — recent staff actions, one against an unlinked target.", renderAuditPages, f.AUDIT, {
    now: new Date(f.NOW),
  }),
  ...paged("audit-truncated", "The same log with more behind it than we showed.", renderAuditPages, f.AUDIT, {
    truncated: true,
    now: new Date(f.NOW),
  }),
  card("wordlist", "`/wordlist` — every match type, one disabled.", renderWordlistEmbed, f.WORDLIST),
  card("wordlist-empty", "No rules configured.", renderWordlistEmbed, []),
  card("filter-test-hit", "`/filter-test` on text that trips two rules.", renderFilterTestEmbed, f.FILTER_TEST_HIT),
  card("filter-test-clear", "The same command on text that trips none.", renderFilterTestEmbed, f.FILTER_TEST_CLEAR),
  card("safety-on", "`/safety` with a lockdown and anti-raid both live.", renderSafetyStatusEmbed, f.SAFETY_ON),
  card("safety-off", "Nothing in force — the ordinary state.", renderSafetyStatusEmbed, f.SAFETY_OFF),
  card("application", "One application under review.", renderApplicationEmbed, f.APPLICATION),
  card(
    "application-list",
    "The queue, including a never-submitted draft.",
    renderApplicationListEmbed,
    f.APPLICATIONS,
  ),
  card("application-list-empty", "Nobody has applied.", renderApplicationListEmbed, []),
];

/** Look one card up by name, for `npm run embeds preview <name>`. */
export function galleryCard(name: string): GalleryCard | undefined {
  return GALLERY.find((c) => c.name === name);
}

/** Every renderer the gallery actually exercises. */
export function coveredRenderers(): ReadonlySet<string> {
  return new Set(GALLERY.map((c) => c.renderer));
}

export { NOW as GALLERY_CLOCK } from "./fixtures.js";
