/**
 * The recommendation engine behind `/nextupgrade` and `/whatnext`.
 *
 * Everything here is a pure function over already-parsed DTOs, which is what
 * makes it testable without Hypixel: given a profile shape, the same advice
 * comes out every time. Pricing is *not* done here — a suggestion names an item
 * id and the command layer prices it, so the engine stays free of network I/O
 * and the advice is identical whether or not the bazaar sweep is warm.
 *
 * The bar for including a suggestion is that a real player would act on it. A
 * list of twenty things is not advice; the callers take the top handful.
 */
import type {
  AdviceItemDTO,
  AdvicePriority,
  DungeonsDTO,
  NetworthDTO,
  SkillsDTO,
  SlayersDTO,
} from "@sbr/shared-types";
import type { AccessoryReport } from "@sbr/skyblock-parse";

/** A suggestion before pricing: `itemId` is what the command layer looks up. */
export interface Suggestion {
  readonly title: string;
  readonly detail: string;
  readonly priority: AdvicePriority;
  readonly category: string;
  readonly itemId: string | null;
}

export type UpgradeFocus = "dps" | "ehp" | "farming" | "mining" | "dungeons" | "slayer" | "general";

export interface ProfileFacts {
  readonly skills: SkillsDTO | null;
  readonly slayers: SlayersDTO | null;
  readonly dungeons: DungeonsDTO | null;
  readonly networth: NetworthDTO | null;
  readonly accessories: AccessoryReport | null;
  readonly senitherWeight: number | null;
}

function skillLevel(skills: SkillsDTO | null, name: string): number | null {
  return skills?.skills.find((s) => s.name === name)?.level ?? null;
}

function slayerTier(slayers: SlayersDTO | null, boss: string): number | null {
  const found = slayers?.bosses.find((b) => b.boss.toLowerCase() === boss.toLowerCase());
  return found ? found.tier : null;
}

/**
 * Advice that holds for anyone, used when the profile is unreadable. It is
 * returned with `generic: true` so the embed can say the numbers are missing
 * instead of implying it inspected the account.
 */
export const GENERIC_ADVICE: readonly Suggestion[] = [
  {
    title: "Turn your API settings on",
    detail:
      "Skyblock Menu → Settings → API Settings, enable inventory, skills and collections. Without them no tool — including this one — can see your profile.",
    priority: "HIGH",
    category: "Setup",
    itemId: null,
  },
  {
    title: "Push Combat and the slayers together",
    detail: "Combat level gates most damage scaling, and slayer levels gate the weapons worth using it on.",
    priority: "MEDIUM",
    category: "Combat",
    itemId: null,
  },
  {
    title: "Fill out your accessory bag",
    detail: "Magical power scales every stat you already have; cheap talismans are usually the best coins-per-power you can spend.",
    priority: "MEDIUM",
    category: "Accessories",
    itemId: null,
  },
];

/** Accessory suggestions common to every focus — magical power helps all of them. */
function accessorySuggestions(acc: AccessoryReport | null, limit: number): Suggestion[] {
  if (!acc || acc.apiDisabled) return [];
  const out: Suggestion[] = [];

  for (const r of acc.redundant.slice(0, 2)) {
    out.push({
      title: `Sell your ${r.name}`,
      detail: "You hold a strictly better accessory from the same family, so this one contributes no magical power.",
      priority: "LOW",
      category: "Accessories",
      itemId: r.id,
    });
  }
  for (const u of acc.upgradeable.slice(0, limit)) {
    out.push({
      title: `Upgrade ${u.have.name} → ${u.to.name}`,
      detail: u.to.why,
      priority: "MEDIUM",
      category: "Accessories",
      itemId: u.to.id,
    });
  }
  for (const m of acc.missing.slice(0, limit)) {
    out.push({
      title: `Get the ${m.name}`,
      detail: m.why,
      priority: m.id === "HEGEMONY_ARTIFACT" ? "HIGH" : "LOW",
      category: "Accessories",
      itemId: m.id,
    });
  }
  return out;
}

function dpsSuggestions(f: ProfileFacts): Suggestion[] {
  const out: Suggestion[] = [];
  const combat = skillLevel(f.skills, "Combat");
  const eman = slayerTier(f.slayers, "enderman");
  const zombie = slayerTier(f.slayers, "zombie");

  if (combat !== null && combat < 24) {
    out.push({
      title: `Combat ${combat} → 24`,
      detail: "Combat is a flat multiplier on every weapon you will ever hold; nothing else you buy matters as much below 24.",
      priority: "HIGH",
      category: "Skills",
      itemId: null,
    });
  }
  if (eman !== null && eman < 5) {
    out.push({
      title: `Enderman slayer ${eman} → ${Math.min(5, eman + 1)}`,
      detail: "Eman drops carry the whole late-game damage curve — Judgement Core, Summoning Ring, and the Aspect of the Void line.",
      priority: eman < 3 ? "HIGH" : "MEDIUM",
      category: "Slayer",
      itemId: null,
    });
  }
  if (zombie !== null && zombie < 5) {
    out.push({
      title: `Revenant slayer ${zombie} → ${Math.min(5, zombie + 1)}`,
      detail: "Rev 5 gates the Reaper Falchion and Scythe Blade, both large damage steps for their price.",
      priority: "MEDIUM",
      category: "Slayer",
      itemId: null,
    });
  }
  if ((combat ?? 0) >= 24) {
    out.push({
      title: "Move to a Hyperion or a Terminator",
      detail: "Past Combat 24 the weapon, not the skill, is the ceiling. Price both — the cheaper one is usually the right call.",
      priority: "MEDIUM",
      category: "Gear",
      itemId: "HYPERION",
    });
  }
  return out;
}

function ehpSuggestions(f: ProfileFacts): Suggestion[] {
  const out: Suggestion[] = [];
  const cata = f.dungeons?.catacombsLevel ?? null;

  out.push({
    title: "Reforge accessories to health or defence",
    detail: "Effective health scales with both together; a tuning preset costs nothing and is reversible.",
    priority: "MEDIUM",
    category: "Accessories",
    itemId: null,
  });
  if (cata !== null && cata < 24) {
    out.push({
      title: `Catacombs ${cata} → 24`,
      detail: "Catacombs multiplies health and defence directly, and unlocks the dungeon armour worth wearing.",
      priority: "HIGH",
      category: "Dungeons",
      itemId: null,
    });
  }
  out.push({
    title: "Get a full Necron's or Storm's set",
    detail: "Dungeon armour scales with Catacombs, so it keeps growing long after a static set stops.",
    priority: "MEDIUM",
    category: "Gear",
    itemId: "POWER_WITHER_CHESTPLATE",
  });
  return out;
}

function skillFocus(
  f: ProfileFacts,
  skill: string,
  toolId: string,
  toolName: string,
  category: string,
): Suggestion[] {
  const out: Suggestion[] = [];
  const level = skillLevel(f.skills, skill);
  if (level !== null && level < 25) {
    out.push({
      title: `${skill} ${level} → 25`,
      detail: `Early ${skill.toLowerCase()} levels are fast and gate the tools worth using.`,
      priority: "HIGH",
      category,
      itemId: null,
    });
  }
  out.push({
    title: `Upgrade to a ${toolName}`,
    detail: `The tool is the multiplier on every hour you spend ${category.toLowerCase()}; price it before grinding further.`,
    priority: "MEDIUM",
    category,
    itemId: toolId,
  });
  return out;
}

function dungeonSuggestions(f: ProfileFacts): Suggestion[] {
  const out: Suggestion[] = [];
  const cata = f.dungeons?.catacombsLevel ?? null;
  if (f.dungeons && !f.dungeons.played) {
    out.push({
      title: "Run your first Catacombs floors",
      detail: "F1–F3 with a party costs nothing and Catacombs levels are the single largest stat block in the game.",
      priority: "HIGH",
      category: "Dungeons",
      itemId: null,
    });
    return out;
  }
  if (cata !== null && cata < 30) {
    out.push({
      title: `Catacombs ${cata} → 30`,
      detail: "Master mode and the best dungeon gear both open up around 30.",
      priority: "HIGH",
      category: "Dungeons",
      itemId: null,
    });
  }
  const classAvg = f.dungeons?.classAverage ?? null;
  if (classAvg !== null && cata !== null && classAvg + 5 < cata) {
    out.push({
      title: "Level your off-classes",
      detail: `Your class average (${classAvg.toFixed(1)}) trails Catacombs (${cata}); class levels are what parties actually check.`,
      priority: "MEDIUM",
      category: "Dungeons",
      itemId: null,
    });
  }
  return out;
}

function slayerSuggestions(f: ProfileFacts): Suggestion[] {
  const bosses: readonly { readonly key: string; readonly label: string; readonly why: string }[] = [
    { key: "zombie", label: "Revenant", why: "Gates the Reaper line and Undead Catalyst." },
    { key: "spider", label: "Tarantula", why: "Cheapest levels in the game and gates Scorpion Foil." },
    { key: "wolf", label: "Sven", why: "Gates Pooch Sword and the speed talismans worth holding." },
    { key: "enderman", label: "Voidgloom", why: "Every late-game damage item routes through here." },
  ];
  const out: Suggestion[] = [];
  for (const b of bosses) {
    const tier = slayerTier(f.slayers, b.key);
    if (tier === null || tier >= 5) continue;
    out.push({
      title: `${b.label} ${tier} → ${tier + 1}`,
      detail: b.why,
      priority: tier < 3 ? "HIGH" : "MEDIUM",
      category: "Slayer",
      itemId: null,
    });
  }
  return out;
}

/** `/nextupgrade` — ranked upgrades for one focus. */
export function buildUpgradeAdvice(f: ProfileFacts, focus: UpgradeFocus): readonly Suggestion[] {
  const byFocus: Record<UpgradeFocus, Suggestion[]> = {
    dps: dpsSuggestions(f),
    ehp: ehpSuggestions(f),
    farming: skillFocus(f, "Farming", "MELON_DICER_3", "Melon Dicer 3.0", "Farming"),
    mining: skillFocus(f, "Mining", "DIVAN_DRILL", "Divan's Drill", "Mining"),
    dungeons: dungeonSuggestions(f),
    slayer: slayerSuggestions(f),
    general: [...dpsSuggestions(f), ...dungeonSuggestions(f)],
  };
  const core = byFocus[focus];
  // Accessories help every focus, so they round out the list rather than
  // crowding out the focus-specific advice the member actually asked for.
  return [...core, ...accessorySuggestions(f.accessories, 2)].sort(byPriority).slice(0, 8);
}

const RANK: Readonly<Record<AdvicePriority, number>> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function byPriority(a: Suggestion, b: Suggestion): number {
  return RANK[a.priority] - RANK[b.priority];
}

export type Goal = "weight" | "networth" | "dungeons" | "slayer" | "skills" | "general";

/**
 * `/whatnext` — the broad "what should I do today" list. Unlike
 * `/nextupgrade` this deliberately spans domains: the point is to surface the
 * one neglected area, not to deepen the area the member already favours.
 */
export function buildNextSteps(f: ProfileFacts, goal: Goal): readonly Suggestion[] {
  const out: Suggestion[] = [];

  if (f.skills?.apiDisabled) {
    out.push(GENERIC_ADVICE[0] as Suggestion);
  }

  const avg = f.skills?.average ?? null;
  const cata = f.dungeons?.catacombsLevel ?? null;
  const slayerTotal = f.slayers?.totalExperience ?? null;

  // The headline heuristic: call out whichever pillar is furthest behind, since
  // that is where the next hour of play buys the most.
  const pillars: { readonly name: string; readonly score: number | null; readonly advice: Suggestion }[] = [
    {
      name: "Skills",
      score: avg,
      advice: {
        title: "Push your skill average",
        detail: avg === null ? "Skill data is hidden, so this is a guess." : `Skill average is ${avg.toFixed(1)}; the cheap skills (Foraging, Alchemy) move it fastest.`,
        priority: "HIGH",
        category: "Skills",
        itemId: null,
      },
    },
    {
      name: "Dungeons",
      // Catacombs and skill average are on comparable scales in practice, which
      // is what makes "furthest behind" meaningful across pillars.
      score: cata,
      advice: {
        title: "Run more Catacombs",
        detail: cata === null ? "No dungeon data on this profile." : `Catacombs ${cata} is your weakest pillar — floor runs are the fastest fix.`,
        priority: "HIGH",
        category: "Dungeons",
        itemId: null,
      },
    },
    {
      name: "Slayer",
      score: slayerTotal === null ? null : Math.min(60, Math.cbrt(slayerTotal) / 3),
      advice: {
        title: "Grind a slayer you have neglected",
        detail: "Slayer levels gate the gear the other two pillars assume you already own.",
        priority: "HIGH",
        category: "Slayer",
        itemId: null,
      },
    },
  ];

  const scored = pillars.filter((p): p is typeof p & { score: number } => p.score !== null);
  const weakest = scored.sort((a, b) => a.score - b.score)[0];
  if (weakest) out.push(weakest.advice);

  if (goal === "networth" || goal === "general") {
    const total = f.networth?.total ?? null;
    out.push({
      title: "Pick a money method and stay on it",
      detail:
        total === null
          ? "Networth is unreadable, so start with whatever method you already have the gear for."
          : `At ${Math.round(total).toLocaleString()} coins, the method that compounds is the one your best tool already supports.`,
      priority: "MEDIUM",
      category: "Economy",
      itemId: null,
    });
  }
  if (goal === "weight" || goal === "general") {
    out.push({
      title: "Weight follows slayer and catacombs",
      detail:
        f.senitherWeight === null
          ? "Weight can't be computed without skill data."
          : `Senither weight is ${Math.round(f.senitherWeight)}; slayer XP and Catacombs move it far more than skill levels do.`,
      priority: "MEDIUM",
      category: "Progression",
      itemId: null,
    });
  }
  if (goal === "slayer") out.push(...slayerSuggestions(f));
  if (goal === "dungeons") out.push(...dungeonSuggestions(f));
  if (goal === "skills" && avg !== null && avg < 40) {
    out.push({
      title: "Chase skill average 40",
      detail: "Below 40, every skill is still cheap; past it the grind steepens sharply.",
      priority: "MEDIUM",
      category: "Skills",
      itemId: null,
    });
  }

  out.push(...accessorySuggestions(f.accessories, 1));
  return out.sort(byPriority).slice(0, 8);
}

/** Attach prices the command layer looked up, dropping the internal `itemId`. */
export function priceSuggestions(
  suggestions: readonly Suggestion[],
  prices: ReadonlyMap<string, number | null>,
): readonly AdviceItemDTO[] {
  return suggestions.map((s) => ({
    title: s.title,
    detail: s.detail,
    priority: s.priority,
    category: s.category,
    estimatedCost: s.itemId ? (prices.get(s.itemId) ?? null) : null,
  }));
}
