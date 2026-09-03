/**
 * Packaged wordlists: the rules a guild should not have to write itself.
 *
 * Every guild that installs this platform writes the same first twenty filter
 * rules — free-Nitro scams, gift-card bait, IP-logger domains, unsolicited
 * invites. Making each of them do that by hand is how a server ends up with
 * three near-miss variants of one scam pattern and a gap where the fourth
 * should be.
 *
 * **What is deliberately not shipped here: slur lists.** They are the one
 * category where a packaged answer would be worse than none. Which words a
 * community treats as a slur is specific to its language, its region and its
 * membership; a list written here would be simultaneously too aggressive for
 * some guilds and full of holes for others, and every guild that enabled it
 * would stop looking. The JSON import exists so a guild can bring the list its
 * own moderators agree on.
 *
 * Everything here is a pattern, not a word, and every pack is off until an
 * admin turns it on. Nothing about installing this platform changes what a
 * guild filters.
 *
 * A pack is layered *under* the guild's own rules rather than copied into them:
 * enabling a pack adds no rows, updating this file updates every guild that had
 * it on, and a guild that turns a pack off gets its own list back untouched.
 * The alternative — seeding rows at install — makes the pack unfixable the
 * moment a scam changes shape, because by then it is a thousand guilds' data.
 */
import type { WordAction, WordMatchType, WordlistRuleDTO } from "@sbr/shared-types";

/** The `GuildSetting` key holding which packs are on. */
export const WORDLIST_PACKS_SETTING_KEY = "moderation.wordlist-packs";

/** One rule inside a pack. `key` is stable across releases; the pattern may change. */
export interface PackRule {
  /** Stable within its pack. Suppression is keyed on it, so it must not be reused. */
  readonly key: string;
  readonly pattern: string;
  readonly matchType: WordMatchType;
  readonly action: WordAction;
  readonly severity: number;
  /** Why this rule exists, shown beside it on the panel. */
  readonly note: string;
}

export interface WordlistPack {
  readonly id: string;
  readonly name: string;
  /** What enabling this pack will start catching, in one sentence. */
  readonly description: string;
  readonly rules: readonly PackRule[];
}

/**
 * Scam bait. Every one of these is a phrase that has no innocent use in a
 * game-guild Discord, which is the bar a packaged rule has to clear: a pack
 * an admin has to audit line by line before trusting is not saving them
 * anything.
 */
const SCAMS: WordlistPack = {
  id: "scams",
  name: "Scam bait",
  description: "Free-Nitro, gift-card and steam-gift phrases, and the domains that carry them.",
  rules: [
    {
      key: "free-nitro",
      pattern: "*free* nitro*",
      matchType: "WILDCARD",
      action: "BLOCK",
      severity: 5,
      note: "The oldest Discord scam there is.",
    },
    {
      key: "nitro-giveaway-dm",
      pattern: "\\bnitro\\b.{0,40}\\b(giveaway|claim|steam)\\b",
      matchType: "REGEX",
      action: "BLOCK",
      severity: 5,
      note: "Nitro paired with a claim or a Steam handoff.",
    },
    {
      key: "gift-card",
      pattern: "\\b(free|claim)\\b.{0,30}\\bgift ?card\\b",
      matchType: "REGEX",
      action: "BLOCK",
      severity: 5,
      note: "Gift-card bait.",
    },
    {
      key: "steam-trade-scam",
      pattern: "steamcommunity\\.(?!com\\b)",
      matchType: "REGEX",
      action: "BLOCK",
      severity: 5,
      note: "Lookalike Steam domains — steamcommunity.ru and friends.",
    },
    {
      key: "discord-lookalike",
      pattern: "\\b(discocrd|dlscord|discrod|discordapp\\.(?!com\\b))",
      matchType: "REGEX",
      action: "BLOCK",
      severity: 5,
      note: "Typosquatted Discord domains.",
    },
    {
      key: "crypto-doubling",
      pattern: "\\b(double|2x|10x)\\b.{0,20}\\b(btc|eth|bitcoin|crypto)\\b",
      matchType: "REGEX",
      action: "BLOCK",
      severity: 5,
      note: "Send one coin, receive two. Nobody ever receives two.",
    },
  ],
};

/**
 * Links that take a member somewhere they did not mean to go.
 *
 * `FLAG` rather than `BLOCK` throughout, and deliberately: a shortener is not
 * proof of anything, and a filter that silently eats every bit.ly teaches
 * members the server is broken. Staff see it and decide.
 */
const LINKS: WordlistPack = {
  id: "links",
  name: "Risky links",
  description: "IP loggers, URL shorteners and unsolicited server invites — flagged, not blocked.",
  rules: [
    {
      key: "ip-logger",
      pattern: "\\b(grabify|iplogger|blasze|yip\\.su|2no\\.co|iplis\\.ru)\\b",
      matchType: "REGEX",
      action: "BLOCK",
      severity: 5,
      note: "Known IP-logging services. These have no other use.",
    },
    {
      key: "shortener",
      pattern: "\\b(bit\\.ly|tinyurl\\.com|goo\\.gl|t\\.co|is\\.gd|cutt\\.ly)\\b",
      matchType: "REGEX",
      action: "FLAG",
      severity: 2,
      note: "Shorteners hide where a link goes.",
    },
    {
      key: "discord-invite",
      pattern: "\\b(discord\\.gg|discord\\.com/invite|discordapp\\.com/invite)/",
      matchType: "REGEX",
      action: "FLAG",
      severity: 2,
      note: "Server invites. Flagged so staff can allow the ones they meant to.",
    },
  ],
};

/**
 * Hypixel-specific: what gets a guild member banned from the game rather than
 * from the Discord.
 *
 * This pack is the reason packs are worth having at all. A general-purpose
 * Discord filter list knows nothing about account selling or cheat clients, and
 * these are exactly the messages a SkyBlock guild most needs caught — not
 * because they are offensive, but because a guild whose chat carries them
 * attracts Hypixel's attention.
 */
const HYPIXEL: WordlistPack = {
  id: "hypixel",
  name: "Hypixel risk",
  description: "Account selling, real-money trading and cheat clients — the things that end a guild.",
  rules: [
    {
      key: "account-selling",
      pattern: "\\b(selling|buying|wts|wtb)\\b.{0,25}\\b(account|acc|alt)s?\\b",
      matchType: "REGEX",
      action: "BLOCK",
      severity: 5,
      note: "Account trading is bannable on Hypixel.",
    },
    {
      key: "rmt",
      pattern: "\\b(irl|real) ?(money|cash)\\b.{0,25}\\b(coins?|trade|selling)\\b",
      matchType: "REGEX",
      action: "BLOCK",
      severity: 5,
      note: "Real-money trading of in-game currency.",
    },
    {
      key: "coin-selling",
      pattern: "\\bselling\\b.{0,20}\\b(coins?|bits?|mil|b)\\b.{0,20}\\b(paypal|cashapp|venmo)\\b",
      matchType: "REGEX",
      action: "BLOCK",
      severity: 5,
      note: "Coins for cash, named by its payment rail.",
    },
    {
      key: "cheat-clients",
      pattern: "\\b(vape|forgehax|wurst|impact client|aristois|autododge|macro bot)\\b",
      matchType: "REGEX",
      action: "FLAG",
      severity: 4,
      note: "Named cheat clients. Flagged, because some are discussed rather than used.",
    },
  ],
};

/** Every pack the platform ships, in the order the panel lists them. */
export const WORDLIST_PACKS: readonly WordlistPack[] = [SCAMS, LINKS, HYPIXEL];

export function findPack(id: string): WordlistPack | null {
  return WORDLIST_PACKS.find((p) => p.id === id) ?? null;
}

/**
 * Which packs a guild has on, and which individual rules it has turned off.
 *
 * Suppression is per-rule rather than per-pack because that is the shape of the
 * complaint: a guild wants Risky links but posts bit.ly internally, and the
 * choice between "keep a rule that fires on our own staff" and "lose the IP
 * loggers too" is not a choice anybody should have to make. Suppressing one
 * rule is how a guild extends a packaged list rather than forking it.
 */
export interface PackSelection {
  readonly enabled: readonly string[];
  /** Suppressed rules, as `packId:ruleKey`. */
  readonly suppressed: readonly string[];
}

/** Nothing on. What a guild has until an admin decides otherwise. */
export const NO_PACKS: PackSelection = { enabled: [], suppressed: [] };

/** The id a resolved pack rule carries, and the one suppression is keyed on. */
export function packRuleId(packId: string, ruleKey: string): string {
  return `pack:${packId}:${ruleKey}`;
}

/** True when an id belongs to a pack rather than to a row in the guild's table. */
export function isPackRuleId(id: string): boolean {
  return id.startsWith("pack:");
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Stored JSON → selection, dropping anything that no longer exists.
 *
 * A pack removed from a release leaves its id behind in every guild that had it
 * on. Filtering here rather than at every read means a retired pack goes quiet
 * instead of resolving to a rule that is not there.
 */
export function parsePackSelection(raw: unknown): PackSelection {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NO_PACKS;
  const row = raw as Record<string, unknown>;
  const enabled = strings(row["enabled"]).filter((id) => findPack(id) !== null);
  return { enabled, suppressed: strings(row["suppressed"]) };
}

/**
 * The pack rules in force, as the same DTO the guild's own rules use.
 *
 * Same shape on purpose: the evaluator, the relay and the test box should not
 * be able to tell a packaged rule from a typed one, because a filter that
 * behaved differently depending on where a rule came from would be a second
 * engine to keep in step. Only the panel knows the difference, and only so it
 * can refuse to let anyone edit a row this file owns.
 */
export function packRules(guildId: string, selection: PackSelection): readonly WordlistRuleDTO[] {
  const suppressed = new Set(selection.suppressed);
  const out: WordlistRuleDTO[] = [];
  for (const packId of selection.enabled) {
    const pack = findPack(packId);
    if (pack === null) continue;
    for (const rule of pack.rules) {
      if (suppressed.has(`${packId}:${rule.key}`)) continue;
      out.push({
        id: packRuleId(packId, rule.key),
        guildId,
        pattern: rule.pattern,
        matchType: rule.matchType,
        action: rule.action,
        severity: rule.severity,
        enabled: true,
      });
    }
  }
  return out;
}

/**
 * The guild's own rules and its packs, as one list.
 *
 * The guild's own rules come first. `evaluateText` decides the action by
 * severity of outcome rather than by position, so this is not a precedence
 * trick — it is what staff read. A hit list that opens with the rule somebody
 * in this guild actually typed explains itself; one that opens with four
 * shipped regexes sends them looking for a rule they cannot find in their own
 * table.
 */
export function resolveWordlist(
  guildId: string,
  own: readonly WordlistRuleDTO[],
  selection: PackSelection,
): readonly WordlistRuleDTO[] {
  return [...own, ...packRules(guildId, selection)];
}
