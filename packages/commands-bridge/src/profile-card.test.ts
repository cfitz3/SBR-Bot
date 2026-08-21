/**
 * `/me` rendering: what the card claims, and what it declines to claim.
 *
 * The arithmetic behind each section belongs to the package that produced it.
 * What is checked here is editorial: that a section which did not arrive is
 * *absent* rather than shown as a zero, and that one unreadable half of the
 * card does not take the other half down with it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AchievementsDTO,
  DungeonsDTO,
  EventPodiumDTO,
  HypixelResult,
  LeaderboardPositionDTO,
  MemberRecordDTO,
  NetworthDTO,
  ProfileSummaryDTO,
  SlayersDTO,
  XpStandingDTO,
} from "@sbr/shared-types";
import { renderProfileCardEmbed, type ProfileCardInput } from "./render.js";

function live<T>(data: T): HypixelResult<T> {
  return {
    ok: true,
    value: { data, freshness: "LIVE", fetchedAt: "2026-08-20T12:00:00.000Z", source: "LIVE" },
  };
}

function failed<T>(): HypixelResult<T> {
  return { ok: false, error: { state: "RATE_LIMITED" } };
}

const PROFILE: ProfileSummaryDTO = {
  profileId: "p1",
  cuteName: "Papaya",
  gameMode: "NORMAL",
  skyblockLevel: 287.6,
  skillAverage: 51.3,
  catacombsLevel: 42,
  slayerXp: 2_640_000,
  senitherWeight: 8420.5,
  bestiaryMilestone: 7,
};

const SLAYERS: SlayersDTO = { totalExperience: 2_640_000, bosses: [] };
const DUNGEONS: DungeonsDTO = {
  catacombsLevel: 42,
  catacombsExperience: 0,
  catacombsXpToNext: null,
  catacombsProgress: null,
  selectedClass: null,
  classAverage: null,
  classes: [],
  floors: [],
  masterFloors: [],
  played: true,
};
const NETWORTH: NetworthDTO = {
  total: 12_400_000_000,
  exact: true,
  missing: [],
  breakdown: {},
  topItems: {},
};

const STANDING: XpStandingDTO = {
  discordId: "111",
  totalXp: 42_000,
  level: 12,
  intoLevel: 100,
  levelSpan: 500,
  bySource: {},
  tenureDays: 240,
  lastAwardAt: null,
  rank: 4,
};

const PODIUM: EventPodiumDTO = {
  attended: 14,
  gold: 2,
  silver: 1,
  bronze: 0,
  recent: [
    {
      eventTitle: "Mining week",
      metric: "skill:mining",
      place: 1,
      delta: 4_000_000,
      at: "2026-08-01T00:00:00.000Z",
    },
  ],
};

const POSITIONS: readonly LeaderboardPositionDTO[] = [
  { category: "level", label: "SkyBlock Level", format: "level", rank: 3, value: 287.6, totalRanked: 42 },
  { category: "xp", label: "Guild XP", format: "count", rank: 6, value: 42_000, totalRanked: 51 },
];

const ACHIEVEMENTS: AchievementsDTO = {
  earned: [
    {
      key: "level:100",
      label: "SkyBlock Level 100",
      description: null,
      type: "SKYBLOCK_LEVEL",
      metric: "skyblockLevel",
      threshold: 100,
      xpReward: 0,
      current: 287,
      progress: 1,
      achievedAt: "2026-08-01T00:00:00.000Z",
      tier: "GOLD",
      icon: null,
      category: "PROGRESSION",
      hidden: false,
    },
  ],
  upcoming: [],
  earnedCount: 1,
  totalCount: 9,
  hiddenLocked: 0,
  xpEarned: 0,
  measuredAt: "2026-08-20T00:00:00.000Z",
  configured: true,
};

const RECORD: MemberRecordDTO = {
  warnings: 0,
  windowDays: 90,
  inForce: [],
  nextEscalation: null,
};

function input(over: Partial<ProfileCardInput> = {}): ProfileCardInput {
  return {
    profile: live(PROFILE),
    slayers: live(SLAYERS),
    dungeons: live(DUNGEONS),
    networth: live(NETWORTH),
    ...over,
  };
}

const names = (view: { fields?: readonly { name: string }[] }): string[] =>
  (view.fields ?? []).map((f) => f.name);

const field = (view: { fields?: readonly { name: string; value: string }[] }, name: string) =>
  (view.fields ?? []).find((f) => f.name === name);

// ── the Hypixel half ──

test("the headline names the SkyBlock level and profile", () => {
  const view = renderProfileCardEmbed("Alpha", input());
  assert.equal(view.title, "Alpha — profile");
  assert.match(view.description ?? "", /SkyBlock Level/);
});

test("an unreadable profile still renders the guild half", () => {
  const view = renderProfileCardEmbed(
    "Alpha",
    input({
      profile: failed<ProfileSummaryDTO>(),
      slayers: failed<SlayersDTO>(),
      dungeons: failed<DungeonsDTO>(),
      networth: failed<NetworthDTO>(),
      standing: STANDING,
      podium: PODIUM,
    }),
  );
  assert.ok(names(view).includes("Guild standing"));
  assert.ok(names(view).includes("Events"));
  // And says so rather than printing zeroes for the account.
  assert.equal(field(view, "Networth")?.value, "—");
});

// ── sections that are absent, not zeroed ──

test("no standing means no standing fields", () => {
  const view = renderProfileCardEmbed("Alpha", input());
  assert.ok(!names(view).includes("Guild standing"));
  assert.ok(!names(view).includes("Tenure"));
});

test("achievements switched off are omitted rather than shown as zero", () => {
  const view = renderProfileCardEmbed(
    "Alpha",
    input({ achievements: { ...ACHIEVEMENTS, configured: false } }),
  );
  assert.ok(!names(view).includes("Achievements"));
});

test("a guild that has defined no achievements gets no field", () => {
  const view = renderProfileCardEmbed("Alpha", input({ achievements: { ...ACHIEVEMENTS, totalCount: 0 } }));
  assert.ok(!names(view).includes("Achievements"));
});

test("an unread achievements section is absent", () => {
  const view = renderProfileCardEmbed("Alpha", input({ achievements: null }));
  assert.ok(!names(view).includes("Achievements"));
});

test("achievements name the tally and the tier breakdown", () => {
  const view = renderProfileCardEmbed("Alpha", input({ achievements: ACHIEVEMENTS }));
  const value = field(view, "Achievements")?.value ?? "";
  assert.match(value, /1\/9/);
  assert.match(value, /SkyBlock Level 100/);
});

test("a member with no medals and no attendance has no events field", () => {
  const view = renderProfileCardEmbed(
    "Alpha",
    input({ podium: { attended: 0, gold: 0, silver: 0, bronze: 0, recent: [] } }),
  );
  assert.ok(!names(view).includes("Events"));
});

test("attendance alone is worth a field", () => {
  const view = renderProfileCardEmbed(
    "Alpha",
    input({ podium: { attended: 3, gold: 0, silver: 0, bronze: 0, recent: [] } }),
  );
  assert.match(field(view, "Events")?.value ?? "", /3 attended/);
});

test("a medal tier nobody earned is left out of the tally", () => {
  const view = renderProfileCardEmbed("Alpha", input({ podium: PODIUM }));
  const value = field(view, "Events")?.value ?? "";
  assert.match(value, /🥇 2/);
  assert.match(value, /🥈 1/);
  assert.ok(!value.includes("🥉"));
});

test("a placing names the event and the metric in words", () => {
  const view = renderProfileCardEmbed("Alpha", input({ podium: PODIUM }));
  const value = field(view, "Events")?.value ?? "";
  assert.match(value, /Mining week/);
  assert.match(value, /Mining/);
  assert.ok(!value.includes("skill:mining"));
});

test("leaderboard positions are one field, absent when there are none", () => {
  assert.ok(!names(renderProfileCardEmbed("Alpha", input({ positions: [] }))).includes("Leaderboards"));
  const view = renderProfileCardEmbed("Alpha", input({ positions: POSITIONS }));
  const value = field(view, "Leaderboards")?.value ?? "";
  assert.match(value, /#3/);
  assert.match(value, /42/);
});

test("the standing row reads level, xp and rank together", () => {
  const view = renderProfileCardEmbed("Alpha", input({ standing: STANDING }));
  const value = field(view, "Guild standing")?.value ?? "";
  assert.match(value, /Level 12/);
  assert.match(value, /#4/);
  assert.match(field(view, "Tenure")?.value ?? "", /240/);
});

test("a clean record adds nothing — there is nothing to tell the member", () => {
  const view = renderProfileCardEmbed("Alpha", input({ record: RECORD }));
  assert.ok(!names(view).includes("Your record"));
});

test("a record with warnings on it is shown", () => {
  const view = renderProfileCardEmbed("Alpha", input({ record: { ...RECORD, warnings: 2 } }));
  assert.match(field(view, "Your record")?.value ?? "", /2 warnings/);
});
