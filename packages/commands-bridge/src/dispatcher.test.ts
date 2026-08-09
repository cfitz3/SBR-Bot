import assert from "node:assert/strict";
import { test } from "node:test";
import {
  err,
  hypixelFailure,
  noArgs,
  ok,
  recordArgs,
  type DataEnvelope,
  type IdentityService,
  type LinkError,
  type LinkedIdentityDTO,
  type MilestoneDTO,
  type AccessoryReportDTO,
  type AdviceDTO,
  type AnalyticsService,
  type AuctionsDTO,
  type BazaarQuoteDTO,
  type CommunityService,
  type EventDTO,
  type LFGPostDTO,
  type TicketDTO,
  type LowestBinDTO,
  type MarketService,
  type GuildConfigService,
  type GuildRosterDTO,
  type GuildRosterSource,
  type DungeonsDTO,
  type NetworthDTO,
  type PermGroupDTO,
  type PermService,
  type PlayerLookup,
  type PricingService,
  type ProfileSummaryDTO,
  type ProgressionService,
  type ProgressSeriesDTO,
  type SkillsDTO,
  type SlayersDTO,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { CommandDispatcher } from "./dispatcher.js";
import { buildBridgeRegistry } from "./handlers.js";
import { communityButtonReplies, parseRsvpState } from "./handlers-community.js";
import { InMemoryCooldownGate } from "./cooldown.js";
import type { CapabilityChecker, CommandContext, UsageSink } from "./types.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

const linkedDto: LinkedIdentityDTO = {
  discordId: "111",
  minecraftUuid: "uuid-aria",
  ign: "Aria",
  status: "VERIFIED",
  primary: true,
  verifiedAt: "t",
};

function identity(over: Partial<IdentityService> = {}): IdentityService {
  return {
    async resolveByDiscordId() { return ok(linkedDto); },
    async linkByIgn() { return ok(linkedDto); },
    async unlink() { return ok(undefined); },
    async hasCapability() { return true; },
    ...over,
  };
}

/** Wrap a payload in a LIVE envelope — the shape every progression read returns. */
function live<T>(data: T) {
  return ok<DataEnvelope<T>>({ data, freshness: "LIVE", source: "LIVE", fetchedAt: "t" });
}

const summary: ProfileSummaryDTO = {
  profileId: "prof-1",
  cuteName: "Mango",
  gameMode: "NORMAL",
  skillAverage: 42.5,
  catacombsLevel: 36,
  senitherWeight: 8_120,
};

function progression(over: Partial<ProgressionService> = {}): ProgressionService {
  return {
    async getProfileSummary() { return live(summary); },
    async listProfiles() { return live([summary]); },
    async getSkills() {
      return live<SkillsDTO>({
        skills: [
          { name: "Mining", level: 50, maxLevel: 60, experience: 55_172_425, xpToNext: 4_300_000, progress: 0 },
          { name: "Combat", level: 35, maxLevel: 60, experience: 1_000, xpToNext: 500, progress: 0.5 },
        ],
        average: 42.5,
        apiDisabled: false,
      });
    },
    async getSlayers() {
      return live<SlayersDTO>({
        bosses: [{ boss: "zombie", experience: 400_000, tier: 8, maxTier: 9, kills: { "5": 120 } }],
        totalExperience: 400_000,
      });
    },
    async getDungeons() {
      return live<DungeonsDTO>({
        catacombsLevel: 36,
        catacombsExperience: 4_000_000,
        selectedClass: "berserk",
        classAverage: 30,
        classes: [{ name: "berserk", level: 35, experience: 3_000_000 }],
        floors: [{ floor: "7", completions: 210, fastestSPlusMs: 220_000 }],
        masterFloors: [],
        played: true,
      });
    },
    async getNetworth() {
      const env: DataEnvelope<NetworthDTO> = {
        data: { total: 8_200_000_000, exact: false, missing: ["inventory"], breakdown: {} },
        freshness: "LIVE",
        source: "LIVE",
        fetchedAt: "t",
      };
      return ok(env);
    },
    async getMilestones() {
      return ok<readonly MilestoneDTO[]>([
        {
          id: "m1",
          minecraftUuid: "uuid-aria",
          type: "SKILL_LEVEL",
          metric: "skillAverage",
          thresholdValue: 40,
          achievedAt: new Date("2026-01-02T00:00:00Z").toISOString(),
        },
      ]);
    },
    async getProgress(_uuid, metric, rangeDays) {
      return ok<ProgressSeriesDTO>({
        metric,
        rangeDays,
        points: [
          { date: "2026-01-01", value: 1_000_000_000 },
          { date: "2026-01-31", value: 3_000_000_000 },
        ],
        change: 2_000_000_000,
      });
    },
    async setSelectedProfile() { return ok(summary); },
    async getAccessories() {
      return live<AccessoryReportDTO>({
        magicalPower: 610,
        tuning: "strength 90",
        owned: [
          { id: "SPEED_TALISMAN", name: "Speed Talisman", rarity: "COMMON", magicalPower: 3, recombobulated: false },
        ],
        missing: [
          {
            id: "WOLF_RING",
            name: "Wolf Ring",
            rarity: "RARE",
            why: "Cheap magical power",
            replaces: null,
            estimatedCost: 1_500_000,
          },
        ],
        upgradeable: [
          {
            id: "SPEED_RING",
            name: "Speed Ring",
            rarity: "UNCOMMON",
            why: "Next tier of a talisman you already hold",
            replaces: "Speed Talisman",
            estimatedCost: 900_000,
          },
        ],
        redundant: [],
        apiDisabled: false,
        note: "Notable accessories only.",
      });
    },
    async getUpgradeAdvice(_uuid, focus) {
      return live<AdviceDTO>({
        focus,
        items: [
          {
            title: "Buy a Hyperion",
            detail: "Biggest single damage jump available to you",
            priority: "HIGH",
            category: "Gear",
            estimatedCost: 1_200_000_000,
          },
        ],
        generic: false,
      });
    },
    async getNextSteps(_uuid, goal) {
      return live<AdviceDTO>({
        focus: goal,
        items: [
          {
            title: "Push Catacombs to 30",
            detail: "Your dungeons lag your skills",
            priority: "HIGH",
            category: "Dungeons",
            estimatedCost: null,
          },
        ],
        generic: false,
      });
    },
    ...over,
  };
}

/** Resolves any IGN — tests that need a miss override this. */
const players: PlayerLookup = {
  async resolveIgn(ign) { return { uuid: `uuid-${ign.toLowerCase()}`, ign }; },
};

/**
 * Deps a given test doesn't exercise. They exist so `HandlerDeps` stays a single
 * concrete shape rather than a per-command union; a test overrides only the
 * service it is actually asserting on.
 */
const pricing: PricingService = { async getPrice() { return hypixelFailure("MISSING_PROFILE"); } };
/** A market with one known item, so resolution and misses are both exercisable. */
const market = (over: Partial<MarketService> = {}): MarketService => ({
  async getBazaarQuote(itemId) {
    return live<BazaarQuoteDTO>({
      itemId,
      displayName: "Enchanted Diamond",
      instantBuy: 1_500,
      instantSell: 1_200,
      buyVolume: 400_000,
      sellVolume: 380_000,
      spread: 300,
    });
  },
  async getLowestBin(itemId) {
    return live<LowestBinDTO>({ itemId, displayName: "Hyperion", price: 900_000_000, listings: 4 });
  },
  async getPlayerAuctions() {
    return live<AuctionsDTO>({
      listings: [
        { auctionId: "a1", itemName: "Hyperion", price: 950_000_000, bin: true, endsAt: null },
      ],
    });
  },
  async getItemAuctions() {
    return live<AuctionsDTO>({ listings: [] });
  },
  async searchItems(query) {
    return [{ itemId: "HYPERION", displayName: "Hyperion" }].filter((m) =>
      m.displayName.toLowerCase().includes(query.toLowerCase()),
    );
  },
  async resolveItemId(query) {
    return query.toLowerCase() === "hyperion" ? "HYPERION" : null;
  },
  ...over,
});

const anEvent: EventDTO = {
  id: "e1", guildId: "g1", title: "F7 carries", status: "SCHEDULED",
  startsAt: "2026-09-01T18:00:00.000Z", capacity: 4, rsvpCount: 2,
  description: "Bring a good hyp", type: "DUNGEON", endsAt: null, hostDiscordId: "111",
};

const aPost: LFGPostDTO = {
  id: "p1", guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", details: "cata 30+",
  slotsTotal: 5, slotsFilled: 2, status: "OPEN", expiresAt: null,
  createdAt: "2026-08-01T00:00:00.000Z", members: ["111", "222"],
};

const aTicket: TicketDTO = {
  id: "t1", guildId: "g1", openerDiscordId: "111", assigneeDiscordId: null, category: "SUPPORT",
  status: "OPEN", subject: "can't link", closeReason: null,
  createdAt: "2026-08-01T00:00:00.000Z", closedAt: null,
};

function community(over: Partial<CommunityService> = {}): CommunityService {
  const base: Partial<CommunityService> = {
    async listUpcomingEvents() { return ok([anEvent]); },
    async listMembers() { return ok([]); },
    async listApplications() { return ok([]); },
    async setMemberRole() { return err(new Error("not used here")); },
    async createEvent(input) { return ok({ ...anEvent, title: input.title, id: "new" }); },
    async getEvent() { return ok(anEvent); },
    async cancelEvent() { return ok({ ...anEvent, status: "CANCELLED" }); },
    async rsvp(_id, _who, state) { return ok({ state, waitlisted: false, event: anEvent }); },
    async getAttendance() {
      return ok({
        event: anEvent,
        going: [{ discordId: "111", state: "GOING", respondedAt: "2026-08-01T00:00:00.000Z" }],
        maybe: [],
        declined: [],
        waitlist: [],
      });
    },
    async createLfg(input) { return ok({ ...aPost, activity: input.activity, slotsTotal: input.slotsTotal, slotsFilled: 1, members: ["111"] }); },
    async listLfg() { return ok([aPost]); },
    async joinLfg() { return ok({ ...aPost, slotsFilled: 3, members: [...aPost.members, "333"] }); },
    async leaveLfg() { return ok({ ...aPost, slotsFilled: 1, members: ["111"] }); },
    async openTicket(input) { return ok({ ...aTicket, category: input.category }); },
    async closeTicket() { return ok({ ...aTicket, status: "CLOSED", closeReason: "sorted" }); },
    async listTickets() { return ok([aTicket]); },
    async getApplication() { return ok(null); },
    async decideApplication() { return err({ kind: "NOT_FOUND" }); },
    ...over,
  };
  return base as CommunityService;
}
/**
 * A perm the dispatcher tests can render. Two seats of five so "full" and
 * "empty" are both a deliberate override rather than the default.
 */
const aPerm: PermGroupDTO = {
  id: "pm1",
  guildId: "g1",
  ownerDiscordId: "111",
  name: "F7 core",
  activity: "DUNGEONS",
  status: "ACTIVE",
  isDefault: false,
  notes: null,
  capacity: 5,
  createdAt: "2026-08-01T00:00:00.000Z",
  members: [
    { ign: "Alpha", role: "healer", slot: 0, discordId: "111", uuid: "u-alpha", inGuild: true, catacombsLevel: 42, skillAverage: 51.25 },
    { ign: "Beta", role: "berserk", slot: 1, discordId: null, uuid: null, inGuild: null, catacombsLevel: null, skillAverage: null },
  ],
};

function perms(over: Partial<PermService> = {}): PermService {
  const base: PermService = {
    async createPerm(input) { return ok({ ...aPerm, name: input.name, members: [] }); },
    async getPerm() { return ok(aPerm); },
    async listPerms() { return ok([aPerm]); },
    async addToRoster() { return ok(aPerm); },
    async removeFromRoster() { return ok({ ...aPerm, members: [aPerm.members[0]!] }); },
    async disbandPerm() { return ok({ ...aPerm, status: "DISBANDED" }); },
    async setDefaultPerm() { return ok({ ...aPerm, isDefault: true }); },
    async defaultPermFor() { return ok(aPerm); },
  };
  return { ...base, ...over };
}

const guildConfig: GuildConfigService = {
  async get() { return ok(null); },
  async isFeatureEnabled() { return true; },
  async getChannel() { return null; },
  async getSetting() { return null; },
  async setSetting() { return ok(undefined); },
  async setChannel() { return ok(undefined); },
  async setFeature() { return ok(undefined); },
  async setBridgeSuspended() { return ok(undefined); },
  async setRecruitment() { return ok(undefined); },
  async setRoleMapping() { return ok(undefined); },
};
const analytics: AnalyticsService = { async capture() {}, async emit() {} };

const allowAll: CapabilityChecker = { async can() { return true; } };
const denyAll: CapabilityChecker = { async can() { return false; } };

function makeDispatcher(over: {
  identity?: IdentityService;
  progression?: ProgressionService;
  players?: PlayerLookup;
  pricing?: PricingService;
  market?: MarketService;
  capabilities?: CapabilityChecker;
  community?: CommunityService;
  perms?: PermService;
  roster?: GuildRosterSource;
  usage?: UsageSink;
  now?: () => number;
} = {}) {
  return new CommandDispatcher({
    registry: buildBridgeRegistry(),
    cooldowns: new InMemoryCooldownGate(over.now),
    capabilities: over.capabilities ?? allowAll,
    handlerDeps: {
      identity: over.identity ?? identity(),
      progression: over.progression ?? progression(),
      players: over.players ?? players,
      pricing: over.pricing ?? pricing,
      market: over.market ?? market(),
      community: over.community ?? community(),
      perms: over.perms ?? perms(),
      ...(over.roster ? { roster: over.roster } : {}),
      config: guildConfig,
      analytics,
      logger: silent,
    },
    logger: silent,
    ...(over.usage ? { usage: over.usage } : {}),
    ...(over.now ? { now: over.now } : {}),
  });
}

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  guildId: "g1",
  userId: "111",
  surface: "BRIDGE_BOT",
  args: noArgs,
  ...over,
});

test("unknown command replies helpfully", async () => {
  const r = await makeDispatcher().dispatch("frobnicate", ctx());
  assert.match(r.text, /Unknown command/);
});

test("help returns the command list", async () => {
  const r = await makeDispatcher().dispatch("help", ctx());
  assert.match(r.text, /\/link/);
});

test("networth is refused without RUN_COMMAND capability", async () => {
  const r = await makeDispatcher({ capabilities: denyAll }).dispatch("networth", ctx());
  assert.match(r.text, /don't have permission/);
});

test("cooldown blocks a rapid second invocation", async () => {
  const d = makeDispatcher();
  const first = await d.dispatch("networth", ctx());
  assert.match(first.text, /Networth/);
  const second = await d.dispatch("networth", ctx());
  assert.match(second.text, /Slow down/);
});

test("link success confirms the IGN", async () => {
  const r = await makeDispatcher().dispatch("link", ctx({ args: recordArgs({ ign: "Aria" }) }));
  assert.match(r.text, /Linked to Aria/);
});

test("link surfaces SOCIAL_UNSET guidance", async () => {
  const failing = identity({
    async linkByIgn() { return err<LinkError>({ kind: "SOCIAL_UNSET" }); },
  });
  const r = await makeDispatcher({ identity: failing }).dispatch("link", ctx({ args: recordArgs({ ign: "Aria" }) }));
  assert.match(r.text, /Set your Discord in-game/);
});

test("networth tells unlinked users to link first", async () => {
  const unlinked = identity({ async resolveByDiscordId() { return ok(null); } });
  const r = await makeDispatcher({ identity: unlinked }).dispatch("networth", ctx());
  assert.match(r.text, /not linked/);
});

test("networth renders an estimate for partial data", async () => {
  const r = await makeDispatcher().dispatch("networth", ctx());
  assert.match(r.text, /8\.20b/);
  assert.match(r.text, /est, some data hidden/);
});

test("networth marks stale data as cached", async () => {
  const stale = progression({
    async getNetworth() {
      return ok({
        data: { total: 1_000_000_000, exact: true, missing: [], breakdown: {} },
        freshness: "STALE",
        source: "CACHE",
        fetchedAt: "t",
      });
    },
  });
  const r = await makeDispatcher({ progression: stale }).dispatch("networth", ctx());
  assert.match(r.text, /\(cached\)/);
});

test("handler errors are caught and reported gracefully", async () => {
  const throwing = progression({ async getNetworth() { throw new Error("hypixel down"); } });
  const r = await makeDispatcher({ progression: throwing }).dispatch("networth", ctx());
  assert.match(r.text, /Something went wrong/);
});

test("an unreachable upstream degrades with its own message, not the generic one", async () => {
  const down = progression({
    async getNetworth() {
      // Shape-matched to the Hypixel client's error: the command layer
      // recognises it structurally rather than importing the data package.
      const error = new Error("Hypixel returned 500");
      error.name = "HypixelUnavailableError";
      throw error;
    },
  });
  const r = await makeDispatcher({ progression: down }).dispatch("networth", ctx());
  assert.match(r.text, /nothing cached to fall back on/);
  assert.doesNotMatch(r.text, /Something went wrong/);
});

test("networth carries an embed with the staleness footer", async () => {
  const r = await makeDispatcher().dispatch("networth", ctx());
  assert.ok(r.embed, "expected an embed");
  assert.match(r.embed?.footer ?? "", /as of/);
});

test("a cached-during-outage reading says so in the footer", async () => {
  const stale = progression({
    async getNetworth() {
      return ok({
        data: { total: 1_000_000_000, exact: true, missing: [], breakdown: {} },
        freshness: "STALE",
        source: "CACHE",
        fetchedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      });
    },
  });
  const r = await makeDispatcher({ progression: stale }).dispatch("networth", ctx());
  assert.match(r.embed?.footer ?? "", /cached data — as of 1h ago/);
});

test("hidden sections are named in the footer rather than folded into the total", async () => {
  const r = await makeDispatcher().dispatch("networth", ctx());
  assert.match(r.embed?.footer ?? "", /hidden: inventory/);
  assert.match(r.embed?.description ?? "", /estimate/);
});

// ── Stage 2: member lookups ─────────────────────────────────────────────────

test("stats renders the overview card", async () => {
  const r = await makeDispatcher().dispatch("stats", ctx());
  assert.match(r.embed?.title ?? "", /Aria — stats/);
  const fields = r.embed?.fields ?? [];
  assert.equal(fields.find((f) => f.name === "Skill average")?.value, "42.5");
  assert.equal(fields.find((f) => f.name === "Catacombs")?.value, "36");
  assert.match(fields.find((f) => f.name === "Networth")?.value ?? "", /8\.20b/);
});

test("stats survives one section failing", async () => {
  // Slayers unreadable, everything else fine: the card still renders and the
  // broken section reads "—" rather than blanking the reply.
  const partial = progression({ async getSlayers() { return hypixelFailure("API_DISABLED"); } });
  const r = await makeDispatcher({ progression: partial }).dispatch("stats", ctx());
  assert.equal((r.embed?.fields ?? []).find((f) => f.name === "Slayer xp")?.value, "—");
  assert.equal((r.embed?.fields ?? []).find((f) => f.name === "Skill average")?.value, "42.5");
});

test("a lookup for a named player resolves the IGN rather than the caller's link", async () => {
  const seen: string[] = [];
  const p = progression({
    async getProfileSummary(uuid) { seen.push(uuid); return live(summary); },
  });
  const r = await makeDispatcher({ progression: p }).dispatch(
    "stats",
    ctx({ args: recordArgs({ player: "Zed" }) }),
  );
  assert.match(r.embed?.title ?? "", /^Zed —/);
  assert.deepEqual(seen, ["uuid-zed"]);
});

test("a lookup for an unknown IGN says so", async () => {
  const missing: PlayerLookup = { async resolveIgn() { return null; } };
  const r = await makeDispatcher({ players: missing }).dispatch(
    "stats",
    ctx({ args: recordArgs({ player: "Nobody" }) }),
  );
  assert.match(r.text, /No Minecraft account called "Nobody"/);
});

test("skills lists every skill and can filter to one", async () => {
  const all = await makeDispatcher().dispatch("skills", ctx());
  assert.equal((all.embed?.fields ?? []).length, 2);

  const one = await makeDispatcher().dispatch(
    "skills",
    ctx({ args: recordArgs({ skill: "mining" }) }),
  );
  assert.equal((one.embed?.fields ?? []).length, 1);
  assert.equal(one.embed?.fields?.[0]?.name, "Mining");
});

test("a hidden skill reads as hidden, never as zero", async () => {
  const off = progression({
    async getSkills() {
      return live<SkillsDTO>({
        skills: [{ name: "Mining", level: null, maxLevel: 60, experience: null, xpToNext: null, progress: null }],
        average: null,
        apiDisabled: false,
      });
    },
  });
  const r = await makeDispatcher({ progression: off }).dispatch("skills", ctx());
  assert.equal(r.embed?.fields?.[0]?.value, "hidden");
});

test("a skills-API-off profile says so instead of showing an empty table", async () => {
  const off = progression({
    async getSkills() { return live<SkillsDTO>({ skills: [], average: null, apiDisabled: true }); },
  });
  const r = await makeDispatcher({ progression: off }).dispatch("skills", ctx());
  assert.match(r.embed?.description ?? "", /skill API is turned off/);
});

test("slayer shows tier out of max", async () => {
  const r = await makeDispatcher().dispatch("slayer", ctx());
  assert.match(r.embed?.fields?.[0]?.value ?? "", /Tier 8\/9/);
  assert.equal(r.embed?.fields?.[0]?.name, "Zombie");
});

test("dungeons reports the fastest S+ as a duration", async () => {
  const r = await makeDispatcher().dispatch("dungeons", ctx());
  const best = (r.embed?.fields ?? []).find((f) => f.name.startsWith("Fastest S+"));
  assert.equal(best?.value, "3m 40s");
});

test("dungeons distinguishes never-played from unreadable", async () => {
  const none = progression({
    async getDungeons() {
      return live<DungeonsDTO>({
        catacombsLevel: null, catacombsExperience: null, selectedClass: null,
        classAverage: null, classes: [], floors: [], masterFloors: [], played: false,
      });
    },
  });
  const r = await makeDispatcher({ progression: none }).dispatch("dungeons", ctx());
  assert.match(r.embed?.description ?? "", /never entered a dungeon/);
});

test("profile with no argument lists every profile on the account", async () => {
  const r = await makeDispatcher().dispatch("profile", ctx());
  assert.match(r.embed?.title ?? "", /Aria — profiles/);
  assert.equal(r.embed?.fields?.[0]?.name, "Mango");
});

test("setprofile confirms the new default", async () => {
  const r = await makeDispatcher().dispatch("setprofile", ctx({ args: recordArgs({ profile: "Mango" }) }));
  assert.match(r.text, /default to Mango/);
  assert.equal(r.ephemeral, true);
});

test("setprofile rejects a profile the account doesn't have", async () => {
  const p = progression({
    async setSelectedProfile() { return err({ kind: "NO_SUCH_PROFILE" as const }); },
  });
  const r = await makeDispatcher({ progression: p }).dispatch(
    "setprofile",
    ctx({ args: recordArgs({ profile: "Pineapple" }) }),
  );
  assert.match(r.text, /No profile called "Pineapple"/);
});

test("setprofile autocomplete suggests the caller's own profiles", async () => {
  const choices = await makeDispatcher().autocomplete(
    "setprofile",
    { name: "profile", value: "man" },
    { guildId: "g1", userId: "111" },
  );
  assert.deepEqual([...choices], [{ name: "Mango", value: "Mango" }]);
});

test("setprofile autocomplete is empty rather than throwing for an unlinked caller", async () => {
  const unlinked = identity({ async resolveByDiscordId() { return ok(null); } });
  const choices = await makeDispatcher({ identity: unlinked }).autocomplete(
    "setprofile",
    { name: "profile", value: "" },
    { guildId: "g1", userId: "111" },
  );
  assert.equal(choices.length, 0);
});

test("milestones with no history explains why rather than showing nothing", async () => {
  const empty = progression({ async getMilestones() { return ok([]); } });
  const r = await makeDispatcher({ progression: empty }).dispatch("milestones", ctx());
  assert.match(r.embed?.description ?? "", /once the daily snapshot/);
});

test("progress reports the change across the window", async () => {
  const r = await makeDispatcher().dispatch(
    "progress",
    ctx({ args: recordArgs({ metric: "networth", range: "30" }) }),
  );
  assert.match(r.embed?.description ?? "", /\+2\.00b/);
  assert.match(r.embed?.title ?? "", /networth/);
});

test("progress with a single reading refuses to imply zero change", async () => {
  const one = progression({
    async getProgress(_u, metric, rangeDays) {
      return ok<ProgressSeriesDTO>({
        metric, rangeDays,
        points: [{ date: "2026-01-01", value: 1_000_000_000 }],
        change: null,
      });
    },
  });
  const r = await makeDispatcher({ progression: one }).dispatch("progress", ctx());
  assert.match(r.embed?.description ?? "", /Only one reading/);
  assert.doesNotMatch(r.embed?.description ?? "", /\+0/);
});

test("verify with no ign re-checks the account already on file", async () => {
  const seen: string[] = [];
  const id = identity({
    async linkByIgn(_d, ign) { seen.push(ign); return ok(linkedDto); },
  });
  const r = await makeDispatcher({ identity: id }).dispatch("verify", ctx());
  assert.deepEqual(seen, ["Aria"]);
  assert.match(r.text, /Verified as Aria/);
});

test("unlink removes the caller's account", async () => {
  const r = await makeDispatcher().dispatch("unlink", ctx());
  assert.match(r.text, /Unlinked Aria/);
});

test("me is ephemeral and never accepts another player", async () => {
  const r = await makeDispatcher().dispatch("me", ctx({ args: recordArgs({ player: "Zed" }) }));
  assert.equal(r.ephemeral, true);
  assert.match(r.embed?.title ?? "", /Aria — stats/);
});

test("usage is captured for each dispatch", async () => {
  const captured: Array<{ command: string; success: boolean }> = [];
  const usage: UsageSink = { async capture(u) { captured.push({ command: u.command, success: u.success }); } };
  await makeDispatcher({ usage }).dispatch("help", ctx());
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.command, "help");
  assert.equal(captured[0]?.success, true);
});

// ── Economy ─────────────────────────────────────────────────────────────────

test("price reports the blended estimate with both sources", async () => {
  const priced: PricingService = {
    async getPrice(itemId) {
      return live({
        itemId,
        bazaarInstantSell: 1_200,
        bazaarInstantBuy: 1_500,
        lowestBin: 1_400,
        estimatedValue: 1_400,
      });
    },
  };
  const r = await makeDispatcher({ pricing: priced }).dispatch(
    "price",
    ctx({ args: recordArgs({ item: "hyperion" }) }),
  );
  assert.match(r.embed?.description ?? "", /HYPERION/);
  const values = (r.embed?.fields ?? []).map((f) => f.value);
  assert.deepEqual(values, ["1.4k", "1.5k", "1.2k"]);
});

test("an unpriced item reads as unknown, never as zero", async () => {
  const r = await makeDispatcher().dispatch("price", ctx({ args: recordArgs({ item: "hyperion" }) }));
  // The default pricing stub fails, so the embed carries the failure message.
  assert.doesNotMatch(r.embed?.description ?? r.text, /\b0\b/);
});

test("an unknown item name is rejected before any upstream call", async () => {
  const r = await makeDispatcher().dispatch("price", ctx({ args: recordArgs({ item: "nonsense" }) }));
  assert.equal(r.ephemeral, true);
  assert.match(r.text, /No Skyblock item matching "nonsense"/);
});

test("price without an item asks for one", async () => {
  const r = await makeDispatcher().dispatch("price", ctx());
  assert.equal(r.ephemeral, true);
  assert.match(r.text, /Which item/);
});

test("bazaar shows both sides of the book and the spread", async () => {
  const r = await makeDispatcher().dispatch("bazaar", ctx({ args: recordArgs({ item: "hyperion" }) }));
  const fields = r.embed?.fields ?? [];
  assert.equal(fields.find((f) => f.name === "Instant buy")?.value, "1.5k");
  assert.equal(fields.find((f) => f.name === "Instant sell")?.value, "1.2k");
  assert.equal(fields.find((f) => f.name === "Spread")?.value, "300");
});

test("an item that isn't on the bazaar says so rather than reporting an outage", async () => {
  const off = market({ async getBazaarQuote() { return hypixelFailure("MISSING_PROFILE"); } });
  const r = await makeDispatcher({ market: off }).dispatch(
    "bazaar",
    ctx({ args: recordArgs({ item: "hyperion" }) }),
  );
  assert.match(r.text, /isn't sold on the bazaar/);
});

test("lowestbin reports the cheapest listing and how many there were", async () => {
  const r = await makeDispatcher().dispatch("lowestbin", ctx({ args: recordArgs({ item: "hyperion" }) }));
  assert.match(r.embed?.description ?? "", /900\.00m/);
  assert.equal((r.embed?.fields ?? [])[0]?.value, "4");
});

test("a cold sweep cache is reported as no listing, not as free", async () => {
  const cold = market({
    async getLowestBin(itemId) {
      return live<LowestBinDTO>({ itemId, displayName: null, price: null, listings: 0 });
    },
  });
  const r = await makeDispatcher({ market: cold }).dispatch(
    "lowestbin",
    ctx({ args: recordArgs({ item: "hyperion" }) }),
  );
  assert.match(r.embed?.description ?? "", /No BIN listing/);
  assert.match(r.text, /no BIN listing/);
});

test("auctions with an item reads the sweep cache", async () => {
  const r = await makeDispatcher().dispatch("auctions", ctx({ args: recordArgs({ item: "hyperion" }) }));
  assert.match(r.embed?.title ?? "", /Auctions — HYPERION/);
  assert.match(r.embed?.description ?? "", /No active auctions/);
});

test("auctions without an item falls back to the caller's own listings", async () => {
  const r = await makeDispatcher().dispatch("auctions", ctx());
  assert.match(r.embed?.title ?? "", /Auctions — Aria/);
  assert.equal((r.embed?.fields ?? [])[0]?.name, "Hyperion");
  assert.match((r.embed?.fields ?? [])[0]?.value ?? "", /950\.00m \(BIN\)/);
});

test("item autocomplete offers display names against catalog ids", async () => {
  const choices = await makeDispatcher().autocomplete(
    "price",
    { name: "item", value: "hyper" },
    { guildId: "g1", userId: "111" },
  );
  assert.deepEqual(choices, [{ name: "Hyperion", value: "HYPERION" }]);
});

test("missing lists gaps and upgrades, and footers the catalog caveat", async () => {
  const r = await makeDispatcher().dispatch("missing", ctx());
  assert.match(r.embed?.title ?? "", /Aria — accessories/);
  assert.equal((r.embed?.fields ?? [])[0]?.value, "610", "magical power leads the card");
  const names = (r.embed?.fields ?? []).map((f) => f.name);
  assert.ok(names.some((n) => n.startsWith("Speed Ring")), "the upgrade is shown");
  assert.ok(names.some((n) => n.startsWith("Wolf Ring")), "the gap is shown");
  assert.match(r.embed?.footer ?? "", /Notable accessories only/);
});

test("an unreadable talisman bag says so instead of listing everything as missing", async () => {
  const blind = progression({
    async getAccessories() {
      return live<AccessoryReportDTO>({
        magicalPower: null,
        tuning: null,
        owned: [],
        missing: [],
        upgradeable: [],
        redundant: [],
        apiDisabled: true,
        note: "Notable accessories only.",
      });
    },
  });
  const r = await makeDispatcher({ progression: blind }).dispatch("missing", ctx());
  assert.match(r.embed?.description ?? "", /inventory API is off/);
  assert.match(r.text, /bag unreadable/, "the in-game line must not read as zero magical power");
});

test("nextupgrade passes the focus through and prices the suggestion", async () => {
  const r = await makeDispatcher().dispatch(
    "nextupgrade",
    ctx({ args: recordArgs({ focus: "dps" }) }),
  );
  assert.match(r.embed?.description ?? "", /dps/);
  assert.match((r.embed?.fields ?? [])[0]?.value ?? "", /~1\.20b/);
  assert.match(r.text, /Buy a Hyperion/, "guild chat gets the top suggestion as one line");
});

test("nextupgrade defaults to general advice when no focus is given", async () => {
  const r = await makeDispatcher().dispatch("nextupgrade", ctx());
  assert.match(r.embed?.description ?? "", /general/);
});

test("generic advice is labelled as general rather than passed off as personal", async () => {
  const degraded = progression({
    async getUpgradeAdvice(_uuid, focus) {
      return live<AdviceDTO>({
        focus,
        items: [
          {
            title: "Turn your API settings on",
            detail: "Nothing else can be measured until then",
            priority: "HIGH",
            category: "Setup",
            estimatedCost: null,
          },
        ],
        generic: true,
      });
    },
  });
  const r = await makeDispatcher({ progression: degraded }).dispatch("nextupgrade", ctx());
  assert.match(r.embed?.description ?? "", /general advice rather than advice about you/);
  assert.equal(r.embed?.color, "NEUTRAL");
});

test("whatnext passes the goal through", async () => {
  const r = await makeDispatcher().dispatch("whatnext", ctx({ args: recordArgs({ goal: "dungeons" }) }));
  assert.match(r.embed?.title ?? "", /what next/);
  assert.match(r.embed?.description ?? "", /dungeons/);
});

test("a suggestion with no price shows no cost tag rather than a zero", async () => {
  const r = await makeDispatcher().dispatch("whatnext", ctx());
  assert.equal((r.embed?.fields ?? [])[0]?.value, "Your dungeons lag your skills");
});

// ─────────────── Community (COMMANDS.md §6–§8) ───────────────

test("/events lists what's scheduled with an id to RSVP against", async () => {
  const r = await makeDispatcher().dispatch("events", ctx());
  assert.equal(r.embed?.title, "Upcoming events");
  assert.match(r.embed?.fields?.[0]?.name ?? "", /F7 carries/);
  assert.match(r.embed?.fields?.[0]?.value ?? "", /e1/);
});

test("/events says so plainly when nothing is scheduled", async () => {
  const empty = community({ async listUpcomingEvents() { return ok([]); } });
  const r = await makeDispatcher({ community: empty }).dispatch("events", ctx());
  assert.match(r.text, /Nothing scheduled/);
  assert.equal(r.embed?.color, "NEUTRAL");
});

test("/create-event attaches persistent RSVP buttons keyed by event id", async () => {
  const r = await makeDispatcher().dispatch(
    "create-event",
    ctx({ args: recordArgs({ title: "Kuudra t5", starts_at: "2026-09-01T18:00:00.000Z" }) }),
  );
  const ids = (r.components ?? [])[0]?.buttons.map((b) => b.customId);
  assert.deepEqual(ids, ["rsvp:new:GOING", "rsvp:new:MAYBE", "rsvp:new:NOT_GOING"]);
});

test("/create-event reports an unusable start time instead of creating anything", async () => {
  const rejecting = community({ async createEvent() { return err({ kind: "INVALID_TIME", detail: "that start time is in the past." }); } });
  const r = await makeDispatcher({ community: rejecting }).dispatch(
    "create-event",
    ctx({ args: recordArgs({ title: "x", starts_at: "2020-01-01T00:00:00.000Z" }) }),
  );
  assert.equal(r.ephemeral, true);
  assert.match(r.text, /in the past/);
});

test("/rsvp confirms the recorded response", async () => {
  const r = await makeDispatcher().dispatch("rsvp", ctx({ args: recordArgs({ event: "e1", response: "MAYBE" }) }));
  assert.match(r.text, /maybe for "F7 carries"/);
});

test("a full event tells the member they are on the waitlist, not that they are going", async () => {
  const full = community({
    async rsvp() { return ok({ state: "WAITLIST", waitlisted: true, event: anEvent }); },
  });
  const r = await makeDispatcher({ community: full }).dispatch("rsvp", ctx({ args: recordArgs({ event: "e1" }) }));
  assert.match(r.text, /is full — you're on the waitlist/);
});

test("/rsvp against a missing event explains rather than failing silently", async () => {
  const gone = community({ async rsvp() { return err({ kind: "NOT_FOUND" }); } });
  const r = await makeDispatcher({ community: gone }).dispatch("rsvp", ctx({ args: recordArgs({ event: "nope" }) }));
  assert.equal(r.ephemeral, true);
  assert.match(r.text, /couldn't find an event/);
});

test("/attendance breaks the roster into going, maybe, waitlist and declined", async () => {
  const r = await makeDispatcher().dispatch("attendance", ctx({ args: recordArgs({ event: "e1" }) }));
  const names = (r.embed?.fields ?? []).map((f) => f.name);
  assert.deepEqual(names, ["Going (1)", "Maybe (0)", "Waitlist (0)", "Declined (0)"]);
  assert.match(r.embed?.fields?.[0]?.value ?? "", /<@111>/);
});

test("/lfg opens a run with the author already holding a slot", async () => {
  const r = await makeDispatcher().dispatch("lfg", ctx({ args: recordArgs({ activity: "DUNGEONS", slots: "5" }) }));
  assert.match(r.text, /1\/5/);
  assert.equal((r.components ?? [])[0]?.buttons[0]?.customId, "run:p1:join");
});

test("/lfg refuses a party size the domain rejects", async () => {
  const strict = community({ async createLfg() { return err({ kind: "INVALID_SLOTS", detail: "slots has to be a whole number from 2 to 20." }); } });
  const r = await makeDispatcher({ community: strict }).dispatch("lfg", ctx({ args: recordArgs({ activity: "DUNGEONS", slots: "99" }) }));
  assert.match(r.text, /whole number from 2 to 20/);
});

test("/runs lists open posts", async () => {
  const r = await makeDispatcher().dispatch("runs", ctx());
  assert.equal(r.embed?.title, "Open runs");
  assert.match(r.embed?.fields?.[0]?.name ?? "", /dungeons — 2\/5/);
});

test("/joinrun reports the new slot count", async () => {
  const r = await makeDispatcher().dispatch("joinrun", ctx({ args: recordArgs({ id: "p1" }) }));
  assert.match(r.text, /Joined — 3\/5/);
});

test("joining a full run says it is full", async () => {
  const full = community({ async joinLfg() { return err({ kind: "FULL" }); } });
  const r = await makeDispatcher({ community: full }).dispatch("joinrun", ctx({ args: recordArgs({ id: "p1" }) }));
  assert.equal(r.ephemeral, true);
  assert.match(r.text, /run is full/);
});

test("the host is told why they can't leave their own run", async () => {
  const blocked = community({ async leaveLfg() { return err({ kind: "AUTHOR_CANNOT_LEAVE" }); } });
  const r = await makeDispatcher({ community: blocked }).dispatch("leaverun", ctx({ args: recordArgs({ id: "p1" }) }));
  assert.match(r.text, /you started this run/i);
});

test("a full run's join button is disabled rather than missing", async () => {
  const full = community({
    async joinLfg() { return ok({ ...aPost, slotsFilled: 5, members: ["111", "222", "333", "444", "555"], status: "FULL" }); },
  });
  const r = await makeDispatcher({ community: full }).dispatch("joinrun", ctx({ args: recordArgs({ id: "p1" }) }));
  const buttons = (r.components ?? [])[0]?.buttons ?? [];
  assert.equal(buttons[0]?.disabled, true);
  assert.equal(buttons[1]?.disabled, undefined);
});

test("/ticket opens a ticket privately", async () => {
  const r = await makeDispatcher().dispatch("ticket", ctx({ args: recordArgs({ category: "APPEAL" }) }));
  assert.equal(r.ephemeral, true);
  assert.match(r.text, /Opened ticket t1/);
  assert.match(r.embed?.fields?.[0]?.value ?? "", /appeal/);
});

test("/ticket action:list only ever shows the caller their own tickets", async () => {
  const seen: Array<string | undefined> = [];
  const scoped = community({
    async listTickets(_guildId, opener) { seen.push(opener); return ok([aTicket]); },
  });
  const r = await makeDispatcher({ community: scoped }).dispatch("ticket", ctx({ args: recordArgs({ action: "list" }) }));
  assert.deepEqual(seen, ["111"]);
  assert.equal(r.ephemeral, true);
});

test("/ticket action:close without an id asks for one", async () => {
  const r = await makeDispatcher().dispatch("ticket", ctx({ args: recordArgs({ action: "close" }) }));
  assert.match(r.text, /Which ticket/);
});

test("/ticket action:close confirms and shows the reason", async () => {
  const r = await makeDispatcher().dispatch("ticket", ctx({ args: recordArgs({ action: "close", id: "t1", reason: "sorted" }) }));
  assert.match(r.text, /Closed ticket t1/);
  assert.match((r.embed?.fields ?? []).map((f) => f.value).join(" "), /sorted/);
});

test("closing an already-closed ticket says so", async () => {
  const done = community({ async closeTicket() { return err({ kind: "ALREADY_CLOSED" }); } });
  const r = await makeDispatcher({ community: done }).dispatch("ticket", ctx({ args: recordArgs({ action: "close", id: "t1" }) }));
  assert.match(r.text, /already closed/);
});

// ─────────────────────────────── Perms ───────────────────────────────

test("/perm with no action shows the guild's perms", async () => {
  const r = await makeDispatcher().dispatch("perm", ctx({ args: noArgs }));
  assert.equal(r.embed?.title, "Guild perms");
  assert.match(r.text, /F7 core 2\/5/);
});

test("/perm action:info renders the roster with seats, stats and mentions", async () => {
  const r = await makeDispatcher().dispatch("perm", ctx({ args: recordArgs({ action: "info", perm: "F7 core" }) }));
  const fields = r.embed?.fields ?? [];
  assert.deepEqual(fields.map((f) => f.name), ["Owner", "healer", "berserk"]);
  assert.match(fields[1]!.value, /Alpha \(<@111>\) — cata 42 · sa 51\.3/);
  // Unlinked, unsnapshotted, unknown-cache seat: a bare name and nothing else.
  assert.equal(fields[2]!.value, "Beta");
});

test("a seat is only marked as having left when the cache actually says so", async () => {
  const gone = perms({
    async getPerm() {
      return ok({
        ...aPerm,
        members: [{ ...aPerm.members[0]!, inGuild: false }, aPerm.members[1]!],
      });
    },
  });
  const r = await makeDispatcher({ perms: gone }).dispatch("perm", ctx({ args: recordArgs({ action: "info", perm: "F7 core" }) }));
  const fields = r.embed?.fields ?? [];
  assert.match(fields[1]!.value, /left the guild/);
  // `inGuild: null` is "we don't know", and must not read as an accusation.
  assert.doesNotMatch(fields[2]!.value, /left the guild/);
});

test("/perm action:create reports the new perm and how to fill it", async () => {
  const r = await makeDispatcher().dispatch(
    "perm",
    ctx({ args: recordArgs({ action: "create", name: "Kuudra core", activity: "KUUDRA" }) }),
  );
  assert.match(r.text, /Created "Kuudra core"/);
  assert.match((r.embed?.fields ?? []).map((f) => f.value).join(" "), /Nobody yet/);
});

test("a name clash comes back as a sentence naming the taken name", async () => {
  const taken = perms({ async createPerm() { return err({ kind: "NAME_TAKEN", name: "F7 core" }); } });
  const r = await makeDispatcher({ perms: taken }).dispatch(
    "perm",
    ctx({ args: recordArgs({ action: "create", name: "f7 CORE" }) }),
  );
  assert.match(r.text, /"F7 core" is already the name/);
  assert.equal(r.ephemeral, true);
});

test("/perm action:roster-add confirms with the new roster size", async () => {
  const r = await makeDispatcher().dispatch(
    "perm",
    ctx({ args: recordArgs({ action: "roster-add", perm: "F7 core", ign: "Gamma", role: "tank" }) }),
  );
  assert.match(r.text, /Added Gamma — 2\/5/);
});

test("an unusable role lists the ones that would work", async () => {
  const strict = perms({
    async addToRoster() { return err({ kind: "INVALID_ROLE", allowed: ["healer", "mage", "tank"] }); },
  });
  const r = await makeDispatcher({ perms: strict }).dispatch(
    "perm",
    ctx({ args: recordArgs({ action: "roster-add", perm: "F7 core", ign: "Gamma", role: "cannoneer" }) }),
  );
  assert.match(r.text, /healer, mage, tank/);
});

test("a full perm says how many seats there are", async () => {
  const full = perms({ async addToRoster() { return err({ kind: "FULL", capacity: 5 }); } });
  const r = await makeDispatcher({ perms: full }).dispatch(
    "perm",
    ctx({ args: recordArgs({ action: "roster-add", perm: "F7 core", ign: "Gamma", role: "tank" }) }),
  );
  assert.match(r.text, /full — 5 seats/);
});

test("editing someone else's perm is refused with the rule, not a stack trace", async () => {
  const notMine = perms({ async removeFromRoster() { return err({ kind: "NOT_OWNER" }); } });
  const r = await makeDispatcher({ perms: notMine }).dispatch(
    "perm",
    ctx({ args: recordArgs({ action: "roster-remove", perm: "F7 core", ign: "Alpha", role: "healer" }) }),
  );
  assert.match(r.text, /Only the person who created that perm/);
});

test("every action that needs a perm asks for one rather than guessing", async () => {
  for (const action of ["roster-add", "roster-remove", "disband", "default"]) {
    const r = await makeDispatcher().dispatch("perm", ctx({ args: recordArgs({ action }) }));
    assert.match(r.text, /Which perm\?/, action);
  }
});

test("disbanding is ephemeral and says the name is reusable", async () => {
  const r = await makeDispatcher().dispatch("perm", ctx({ args: recordArgs({ action: "disband", perm: "F7 core" }) }));
  assert.equal(r.ephemeral, true);
  assert.match(r.text, /Disbanded "F7 core"\. The name is free again\./);
});

test("/perm action:default explains what it changed", async () => {
  const r = await makeDispatcher().dispatch("perm", ctx({ args: recordArgs({ action: "default", perm: "F7 core" }) }));
  assert.match(r.text, /now what \/lfg fills from for dungeons/);
});

/**
 * The actor's staff flag is derived from the capability check, not from the
 * caller — a surface that could pass `isStaff: true` itself would make the
 * owner-or-staff rule unenforceable.
 */
test("the staff flag reaching the perm service comes from the capability check", async () => {
  const seen: boolean[] = [];
  const record = perms({
    async disbandPerm(_g, _n, actor) { seen.push(actor.isStaff); return ok(aPerm); },
  });
  const args = recordArgs({ action: "disband", perm: "F7 core" });

  await makeDispatcher({ perms: record }).dispatch("perm", ctx({ args }));
  await makeDispatcher({
    perms: record,
    identity: identity({ async hasCapability() { return false; } }),
  }).dispatch("perm", ctx({ args }));

  assert.deepEqual(seen, [true, false]);
});

test("RSVP buttons route to the same reply as /rsvp", async () => {
  const deps = {
    identity: identity(), progression: progression(), players, pricing, market: market(),
    community: community(), perms: perms(), config: guildConfig, analytics, logger: silent,
  };
  const r = await communityButtonReplies.rsvp("e1", "111", "GOING", deps);
  assert.match(r.text, /Recorded: going for "F7 carries"/);
});

test("run buttons join and leave, and reject an unknown action", async () => {
  const deps = {
    identity: identity(), progression: progression(), players, pricing, market: market(),
    community: community(), perms: perms(), config: guildConfig, analytics, logger: silent,
  };
  assert.match((await communityButtonReplies.run("p1", "222", "join", deps)).text, /Joined — 3\/5/);
  assert.match((await communityButtonReplies.run("p1", "222", "leave", deps)).text, /Left — 1\/5/);
  assert.match((await communityButtonReplies.run("p1", "222", "detonate", deps)).text, /isn't valid any more/);
});

test("parseRsvpState only accepts real states", async () => {
  assert.equal(parseRsvpState("GOING"), "GOING");
  assert.equal(parseRsvpState("NOT_GOING"), "NOT_GOING");
  assert.equal(parseRsvpState("garbage"), null);
  assert.equal(parseRsvpState(undefined), null);
});

// ── /online ────────────────────────────────────────────────────────────────

const roster: GuildRosterDTO = {
  guildName: "SBR",
  ranks: [
    { rank: "Guild Master", members: ["Notch"] },
    { rank: "Member", members: ["Aria", "Bex"] },
  ],
  online: 3,
  total: 120,
  fetchedAt: new Date().toISOString(),
};

test("online lists the roster grouped by rank", async () => {
  const r = await makeDispatcher({ roster: { async online() { return roster; } } }).dispatch("online", ctx());
  assert.equal(r.ephemeral, false);
  assert.equal(r.embed?.title, "SBR — online now");
  assert.match(r.embed?.description ?? "", /3.*120/);
  assert.deepEqual(r.embed?.fields?.map((f) => f.name), ["Guild Master — 1", "Member — 2"]);
  assert.equal(r.embed?.fields?.[1]?.value, "Aria, Bex");
});

test("online says the bridge is down rather than showing an empty guild", async () => {
  const r = await makeDispatcher({ roster: { async online() { return null; } } }).dispatch("online", ctx());
  assert.match(r.text, /offline right now/);
  assert.equal(r.ephemeral, true);
  assert.equal(r.embed, undefined);
});

test("online distinguishes a deployment with no bridge at all", async () => {
  const r = await makeDispatcher().dispatch("online", ctx());
  assert.match(r.text, /isn't set up here/);
});

test("online reports an empty guild plainly", async () => {
  const empty: GuildRosterDTO = { ...roster, ranks: [], online: 0 };
  const r = await makeDispatcher({ roster: { async online() { return empty; } } }).dispatch("online", ctx());
  assert.match(r.embed?.description ?? "", /Nobody is online/);
});

test("online is not reachable from guild chat", () => {
  assert.equal(buildBridgeRegistry().get("online")?.inGame, undefined);
});
