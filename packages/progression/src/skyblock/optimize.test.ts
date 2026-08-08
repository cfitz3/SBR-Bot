/**
 * Tests for the `/missing`, `/nextupgrade` and `/whatnext` machinery: the NBT
 * bag reader, the accessory analysis, and the advice engine. All three are pure
 * over their inputs, so none of this needs Hypixel.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { analyseAccessories, CATALOG } from "./accessories.js";
import { readBag } from "./nbt.js";
import { buildNextSteps, buildUpgradeAdvice, GENERIC_ADVICE, priceSuggestions, type ProfileFacts } from "./advice.js";

// ── a tiny NBT writer, so the reader is tested against real bytes ──

function str(s: string): Buffer {
  const body = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length);
  return Buffer.concat([len, body]);
}

function named(type: number, name: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), str(name), payload]);
}

function compound(...children: Buffer[]): Buffer {
  return Buffer.concat([...children, Buffer.from([0])]);
}

function i32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

function item(id: string, opts: { count?: number; recomb?: boolean; display?: string } = {}): Buffer {
  const extras = [named(8, "id", str(id))];
  if (opts.recomb) extras.push(named(3, "rarity_upgrades", i32(1)));
  const tagChildren = [named(10, "ExtraAttributes", compound(...extras))];
  if (opts.display) {
    tagChildren.push(named(10, "display", compound(named(8, "Name", str(opts.display)))));
  }
  return compound(named(1, "Count", Buffer.from([opts.count ?? 1])), named(10, "tag", compound(...tagChildren)));
}

/** Build the `{ data }` blob Hypixel would send for a bag holding these items. */
function bag(...items: Buffer[]): { data: string } {
  const list = Buffer.concat([Buffer.from([10]), i32(items.length), ...items]);
  const root = compound(named(9, "i", list));
  const full = Buffer.concat([Buffer.from([10]), str(""), root]);
  return { data: gzipSync(full).toString("base64") };
}

// ── nbt ──

test("reads item ids, counts and display names out of a bag", () => {
  const items = readBag(bag(item("SPEED_TALISMAN"), item("HEGEMONY_ARTIFACT", { count: 2, display: "§6Hegemony" })));
  assert.ok(items);
  assert.deepEqual(
    items.map((i) => i.id),
    ["SPEED_TALISMAN", "HEGEMONY_ARTIFACT"],
  );
  assert.equal(items[1]?.count, 2);
  assert.equal(items[1]?.name, "Hegemony", "colour codes must be stripped for the embed");
});

test("recombobulation is read from rarity_upgrades", () => {
  const items = readBag(bag(item("BAT_RING", { recomb: true })));
  assert.equal(items?.[0]?.recombobulated, true);
});

test("slots with no item id are skipped rather than counted", () => {
  const list = Buffer.concat([Buffer.from([10]), i32(2), compound(), item("SPEED_RING")]);
  const root = compound(named(9, "i", list));
  const blob = { data: gzipSync(Buffer.concat([Buffer.from([10]), str(""), root])).toString("base64") };
  assert.equal(readBag(blob)?.length, 1);
});

test("an unreadable blob is null, not an empty bag", () => {
  // The distinction is the whole point: empty means "owns nothing", null means
  // "we couldn't look", and only the second is honest about a hidden API.
  assert.equal(readBag(null), null);
  assert.equal(readBag({ data: "" }), null);
  assert.equal(readBag({ data: "not-actually-gzip" }), null);
});

// ── accessories ──

function member(...items: Buffer[]): unknown {
  return { inventory: { bag_contents: { talisman_bag: bag(...items) } } };
}

test("magical power sums the owned accessories by rarity", () => {
  // Speed Talisman (COMMON, 3) + Candy Ring (RARE, 8).
  const report = analyseAccessories(member(item("SPEED_TALISMAN"), item("CANDY_RING")));
  assert.equal(report.magicalPower, 11);
  assert.equal(report.apiDisabled, false);
});

test("recombobulating lifts an accessory one rarity", () => {
  const plain = analyseAccessories(member(item("CANDY_RING")));
  const recomb = analyseAccessories(member(item("CANDY_RING", { recomb: true })));
  assert.equal(plain.magicalPower, 8, "RARE");
  assert.equal(recomb.magicalPower, 12, "RARE recombobulated counts as EPIC");
});

test("Hegemony counts double, as the game gives it", () => {
  const report = analyseAccessories(member(item("HEGEMONY_ARTIFACT")));
  assert.equal(report.magicalPower, 32, "LEGENDARY 16, doubled");
});

test("a lower family tier held beside a higher one is redundant, not additive", () => {
  const report = analyseAccessories(member(item("BAT_TALISMAN"), item("BAT_ARTIFACT")));
  assert.equal(report.magicalPower, 12, "only the Artifact counts");
  assert.deepEqual(
    report.redundant.map((r) => r.id),
    ["BAT_TALISMAN"],
  );
});

test("a held lower tier is reported as upgradeable, not as missing", () => {
  const report = analyseAccessories(member(item("SPEED_TALISMAN")));
  const upgrades = report.upgradeable.map((u) => u.to.id);
  assert.ok(upgrades.includes("SPEED_RING"), "the next tier is an upgrade");
  assert.equal(
    report.missing.some((m) => m.id === "SPEED_RING"),
    false,
    "an upgrade must not also be listed as a gap",
  );
});

test("owning the top of a family suppresses its lower tiers entirely", () => {
  const report = analyseAccessories(member(item("SPEED_ARTIFACT")));
  const speed = [...report.missing, ...report.upgradeable.map((u) => u.to)].filter((e) => e.family === "SPEED");
  assert.deepEqual(speed, [], "nothing left to suggest in a completed family");
});

test("an unreadable bag reports unknown power and suggests nothing", () => {
  const report = analyseAccessories({ accessory_bag_storage: { tuning: { slot_0: { health: 40 } } } });
  assert.equal(report.apiDisabled, true);
  assert.equal(report.magicalPower, null, "unknown is null, never 0");
  assert.deepEqual(report.missing, []);
  assert.equal(report.tuning, "health 40", "tuning survives an unreadable bag");
});

test("every catalog entry has a reason a player can act on", () => {
  for (const entry of CATALOG) {
    assert.ok(entry.why.length > 10, `${entry.id} needs a real explanation`);
    if (entry.family) assert.ok(entry.tier !== undefined, `${entry.id} is in a family but has no tier`);
  }
});

// ── advice ──

const emptyFacts: ProfileFacts = {
  skills: null,
  slayers: null,
  dungeons: null,
  networth: null,
  accessories: null,
  senitherWeight: null,
};

function facts(over: Partial<ProfileFacts>): ProfileFacts {
  return { ...emptyFacts, ...over };
}

function skills(entries: Record<string, number>, average: number | null = 30) {
  return {
    skills: Object.entries(entries).map(([name, level]) => ({
      name,
      level,
      maxLevel: 60,
      experience: 0,
      xpToNext: null,
      progress: null,
    })),
    average,
    apiDisabled: false,
  };
}

test("low combat is the highest-priority dps advice", () => {
  const out = buildUpgradeAdvice(facts({ skills: skills({ Combat: 12 }) }), "dps");
  assert.equal(out[0]?.priority, "HIGH");
  assert.match(out[0]?.title ?? "", /Combat 12/);
});

test("past combat 24 the advice moves to the weapon, and names a priceable item", () => {
  const out = buildUpgradeAdvice(facts({ skills: skills({ Combat: 30 }) }), "dps");
  const weapon = out.find((s) => s.category === "Gear");
  assert.ok(weapon, "a maxed-combat account should be told to upgrade the weapon");
  assert.equal(weapon.itemId, "HYPERION", "the suggestion must name an item the command layer can price");
});

test("advice is capped, so the reply stays readable", () => {
  const rich = facts({
    skills: skills({ Combat: 5 }),
    accessories: analyseAccessories(member(item("SPEED_TALISMAN"))),
  });
  assert.ok(buildUpgradeAdvice(rich, "dps").length <= 8);
  assert.ok(buildNextSteps(rich, "general").length <= 8);
});

test("suggestions are ordered by priority", () => {
  const out = buildUpgradeAdvice(
    facts({ skills: skills({ Combat: 5 }), accessories: analyseAccessories(member(item("SPEED_TALISMAN"))) }),
    "dps",
  );
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  for (let i = 1; i < out.length; i += 1) {
    const prev = out[i - 1]?.priority ?? "LOW";
    const cur = out[i]?.priority ?? "LOW";
    assert.ok(rank[prev] <= rank[cur], "a LOW suggestion must not precede a HIGH one");
  }
});

test("an unrecognised focus falls back to general advice rather than an empty list", () => {
  const out = buildUpgradeAdvice(facts({ skills: skills({ Combat: 10 }) }), "general");
  assert.ok(out.length > 0);
});

test("whatnext names the weakest pillar", () => {
  const out = buildNextSteps(
    facts({
      skills: skills({ Combat: 40 }, 40),
      dungeons: {
        catacombsLevel: 5,
        catacombsExperience: 10,
        selectedClass: null,
        classAverage: 4,
        classes: [],
        floors: [],
        masterFloors: [],
        played: true,
      },
    }),
    "general",
  );
  assert.match(out[0]?.title ?? "", /Catacombs/, "catacombs 5 against skill average 40 is the gap to call out");
});

test("a member who has never entered dungeons is told to start there", () => {
  const out = buildNextSteps(
    facts({
      dungeons: {
        catacombsLevel: null,
        catacombsExperience: null,
        selectedClass: null,
        classAverage: null,
        classes: [],
        floors: [],
        masterFloors: [],
        played: false,
      },
    }),
    "dungeons",
  );
  assert.ok(out.some((s) => /first Catacombs/.test(s.title)));
});

test("hidden skills produce the API-settings advice, since nothing else can be trusted", () => {
  const out = buildNextSteps(facts({ skills: { skills: [], average: null, apiDisabled: true } }), "general");
  assert.match(out[0]?.title ?? "", /API settings/i);
});

test("generic advice leads with turning the API on", () => {
  assert.match(GENERIC_ADVICE[0]?.title ?? "", /API settings/i);
});

test("pricing attaches costs only where a suggestion names an item", () => {
  const priced = priceSuggestions(
    [
      { title: "a", detail: "d", priority: "HIGH", category: "Gear", itemId: "HYPERION" },
      { title: "b", detail: "d", priority: "LOW", category: "Skills", itemId: null },
    ],
    new Map([["HYPERION", 1_200_000_000]]),
  );
  assert.equal(priced[0]?.estimatedCost, 1_200_000_000);
  assert.equal(priced[1]?.estimatedCost, null);
});

test("an unpriced item leaves the cost null rather than showing zero", () => {
  const priced = priceSuggestions(
    [{ title: "a", detail: "d", priority: "HIGH", category: "Gear", itemId: "HYPERION" }],
    new Map(),
  );
  assert.equal(priced[0]?.estimatedCost, null, "a cold sweep must not read as 'free'");
});
