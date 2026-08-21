/**
 * User-facing rendering. Maps typed fallback states to honest messages and
 * formats networth respecting exact-vs-estimate and staleness.
 */
import { copy } from "@sbr/brand";
import { describeAge, padInlineRow, stalenessFooter, tierRank } from "@sbr/shared-types";
import type {
  AccessoryReportDTO,
  AccessorySuggestionDTO,
  AchievementCategory,
  AchievementDTO,
  AchievementsDTO,
  AchievementTier,
  AdviceDTO,
  AuctionListingDTO,
  AuctionsDTO,
  BazaarQuoteDTO,
  DungeonsDTO,
  EmbedView,
  EventPodiumDTO,
  GuildRosterDTO,
  HypixelFailureState,
  HypixelResult,
  LeaderboardEntryDTO,
  LeaderboardPageDTO,
  LeaderboardPositionDTO,
  LeaderboardValueFormat,
  LinkError,
  LowestBinDTO,
  MemberRecordDTO,
  NetworthDTO,
  PriceDTO,
  ProfileSummaryDTO,
  ProgressSeriesDTO,
  SkillsDTO,
  SlayersDTO,
  XpSource,
  XpStandingDTO,
} from "@sbr/shared-types";

/**
 * The shared embed vocabulary, read once.
 *
 * `C` is per-card copy — titles and the sentences a card prints when it has
 * nothing to show. `F` is field names, which exist as keys precisely because
 * half of them appear on three cards each and had already drifted apart once.
 */
const C = copy.embed.card;
const F = copy.embed.field;

/**
 * `{subject} — {noun}`: whose card, then what card.
 *
 * One template and a vocabulary rather than fifteen title literals, because
 * fifteen literals is fifteen chances for one of them to use a hyphen where the
 * rest use an em dash — which is exactly what a house style is for.
 */
function cardTitle(subject: string, noun: keyof typeof C.noun): string {
  return C.title.replace("{subject}", subject).replace("{noun}", C.noun[noun]);
}

/** The same shape, for the cards whose noun is data rather than vocabulary. */
function titleFor(subject: string, noun: string): string {
  return C.title.replace("{subject}", subject).replace("{noun}", noun);
}

/** One decimal is enough for a level; two would imply precision we don't have. */
export function formatLevel(n: number | null): string {
  return n === null ? "—" : Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** `1h 23m 45s`, for dungeon clear times. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatCoins(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

/**
 * A lookup rather than a switch: the same four sentences reach a member through
 * a slash command, through guild chat and through the panel, and the exhaustive
 * key means a fifth upstream state is a type error here instead of a card that
 * renders `undefined`.
 */
export function renderFailure(state: HypixelFailureState): string {
  return copy.error.hypixel[state];
}

export function renderLinkError(error: LinkError): string {
  return copy.error.link[error.kind];
}

export function renderNetworth(result: HypixelResult<NetworthDTO>): string {
  if (!result.ok) return renderFailure(result.error.state);

  const { data, freshness } = result.value;
  const stale = freshness === "STALE" ? " (cached)" : "";

  if (data.total === null) {
    return `Networth: unknown — data is hidden.${stale}`;
  }
  const qualifier = data.exact ? "" : " (est, some data hidden)";
  return `Networth: ${formatCoins(data.total)}${qualifier}${stale}`;
}

/** Categories shown. Six fits two clean rows of three in a Discord embed. */
const NETWORTH_CATEGORIES = 6;

/** `personal_vault` / `personalBank` → "Personal Vault" / "Personal Bank". */
function categoryLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * The embed form of a networth reading. The footer carries the documented
 * "as of Xm ago" note, which is the only place a viewer can tell a live figure
 * from one served out of cache during an outage.
 */
export function renderNetworthEmbed(ign: string, result: HypixelResult<NetworthDTO>): EmbedView {
  if (!result.ok) {
    return {
      title: ign,
      description: renderFailure(result.error.state),
      color: result.error.state === "RATE_LIMITED" ? "WARNING" : "NEUTRAL",
    };
  }

  const { data } = result.value;
  const fields = Object.entries(data.breakdown)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((a, b) => b[1] - a[1])
    .slice(0, NETWORTH_CATEGORIES)
    .map(([name, value]) => {
      // The share is what makes a breakdown actionable: "3.1b" means little
      // without knowing it is most of the account.
      const share =
        data.total !== null && data.total > 0 ? ` — ${Math.round((value / data.total) * 100)}%` : "";
      const top = (data.topItems[name] ?? [])
        .map((item) => `• ${item.name} **${formatCoins(item.price)}**`)
        .join("\n");
      return {
        name: `${categoryLabel(name)}${share}`,
        value: top.length > 0 ? `${formatCoins(value)}\n${top}` : formatCoins(value),
        inline: true,
      };
    });

  return {
    title: cardTitle(ign, "networth"),
    description:
      data.total === null
        ? C.networthHidden
        : `**${formatCoins(data.total)}**${data.exact ? "" : " (estimate — some data is hidden)"}`,
    // Padded because the category count is data — a profile with four scoring
    // categories would otherwise leave the fourth stretched alone on its own row.
    ...(fields.length > 0 ? { fields: padInlineRow(fields) } : {}),
    // Missing sections are named rather than silently folded into the total.
    ...(data.missing.length > 0
      ? { footer: `${stalenessFooter(result.value)} • hidden: ${data.missing.join(", ")}` }
      : { footer: stalenessFooter(result.value) }),
    color: data.exact ? "SUCCESS" : "INFO",
  };
}

// ── Member lookups (COMMANDS.md §3) ─────────────────────────────────────────

/**
 * Shared shell for a stat embed: title, staleness footer, and the failure form.
 * Every lookup renders through this so an outage looks the same everywhere and
 * the "as of" note can't be forgotten on one command.
 */
function statEmbed<T>(
  title: string,
  result: HypixelResult<T>,
  body: (data: T) => Omit<EmbedView, "title" | "footer">,
): EmbedView {
  if (!result.ok) {
    return {
      title,
      description: renderFailure(result.error.state),
      color: result.error.state === "RATE_LIMITED" ? "WARNING" : "NEUTRAL",
    };
  }
  return { title, ...body(result.value.data), footer: stalenessFooter(result.value) };
}

function weightText(weight: number | null): string {
  return weight === null ? "—" : formatNumber(Math.round(weight));
}

function profileLabel(p: ProfileSummaryDTO): string {
  const name = p.cuteName ?? p.profileId;
  return p.gameMode === "NORMAL" ? name : `${name} · ${p.gameMode}`;
}

export function renderProfileEmbed(
  ign: string,
  result: HypixelResult<ProfileSummaryDTO>,
): EmbedView {
  return statEmbed(cardTitle(ign, "profile"), result, (p) => ({
    description: `**${profileLabel(p)}**`,
    // SkyBlock Level leads: it is the number a member quotes about themselves,
    // and the one that moves whatever they happen to be playing. Weight stays,
    // one column over, as a figure rather than as the headline.
    fields: padInlineRow([
      { name: F.skyblockLevel, value: formatLevel(p.skyblockLevel), inline: true },
      { name: F.skillAverage, value: formatLevel(p.skillAverage), inline: true },
      { name: F.catacombs, value: formatLevel(p.catacombsLevel), inline: true },
      { name: F.weight, value: weightText(p.senitherWeight), inline: true },
    ]),
    color: "INFO",
  }));
}

/** The profile list behind `/profile` with no arguments. */
export function renderProfileListEmbed(
  ign: string,
  result: HypixelResult<readonly ProfileSummaryDTO[]>,
): EmbedView {
  return statEmbed(cardTitle(ign, "profiles"), result, (list) => {
    if (list.length === 0) {
      return { description: C.noProfiles, color: "NEUTRAL" };
    }
    return {
      fields: list.map((p) => ({
        name: profileLabel(p),
        value: `SA ${formatLevel(p.skillAverage)} · Cata ${formatLevel(p.catacombsLevel)} · ${weightText(p.senitherWeight)} weight`,
        inline: false,
      })),
      color: "INFO",
    };
  });
}

export function renderSkillsEmbed(
  ign: string,
  result: HypixelResult<SkillsDTO>,
  only?: string,
): EmbedView {
  return statEmbed(cardTitle(ign, "skills"), result, (s) => {
    if (s.apiDisabled) {
      return {
        description: C.skillsOff,
        color: "NEUTRAL",
      };
    }
    const wanted = only?.toLowerCase();
    const shown = wanted ? s.skills.filter((k) => k.name.toLowerCase() === wanted) : s.skills;
    if (shown.length === 0) {
      return { description: C.noSuchSkill.replace("{name}", only ?? ""), color: "NEUTRAL" };
    }
    // Counted against the readable skills only: "3 maxed" out of a set half of
    // which is hidden would overstate what we can actually see.
    const readable = s.skills.filter((k) => k.level !== null);
    const capped = readable.filter((k) => k.level !== null && k.level >= k.maxLevel);
    return {
      description:
        `Skill average **${formatLevel(s.average)}**` +
        (readable.length > 0 ? ` · **${capped.length}/${readable.length}** at cap` : ""),
      fields: shown.map((k) => ({
        // The cap belongs next to the level: a 50 means something different in
        // Alchemy (capped) than in Combat (ten levels to go), and the caps now
        // differ per skill and move between updates.
        name: k.level !== null && k.level >= k.maxLevel ? `${k.name} ✦` : k.name,
        // A hidden skill says so rather than showing a plausible-looking 0.
        value:
          k.level === null
            ? "hidden"
            : k.xpToNext === null
              ? `${k.level}/${k.maxLevel} (max)`
              : `${k.level}/${k.maxLevel} · ${formatNumber(Math.round(k.xpToNext))} xp to go`,
        inline: true,
      })),
      color: "SUCCESS",
    };
  });
}

function totalKills(kills: Readonly<Record<string, number>>): number {
  return Object.values(kills).reduce((sum, n) => sum + n, 0);
}

/**
 * Per-tier kill counts, lowest tier first.
 *
 * Tiers with no kills are listed as 0 rather than omitted: a gap in the list
 * would read as a tier that does not exist, and "you have never killed a T5" is
 * exactly the thing someone reads a slayer breakdown to find out.
 */
function tierBreakdown(kills: Readonly<Record<string, number>>): string {
  const tiers = Object.keys(kills)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const highest = tiers.length > 0 ? Math.max(...tiers) : 0;
  if (highest === 0) return C.noKills;
  const parts: string[] = [];
  for (let tier = 1; tier <= highest; tier += 1) {
    parts.push(`T${tier} ${formatNumber(kills[String(tier)] ?? 0)}`);
  }
  return parts.join(" · ");
}

export function renderSlayersEmbed(
  ign: string,
  result: HypixelResult<SlayersDTO>,
  only?: string,
): EmbedView {
  return statEmbed(cardTitle(ign, "slayers"), result, (s) => {
    const wanted = only?.toLowerCase();
    const shown = wanted ? s.bosses.filter((b) => b.boss === wanted) : s.bosses;
    if (shown.length === 0) {
      return {
        description: wanted ? C.noSlayerDataFor.replace("{boss}", only ?? "") : C.noSlayerData,
        color: "NEUTRAL",
      };
    }
    // One boss gets the full per-tier breakdown; the overview stays compact,
    // because five bosses x five tiers does not fit in an embed anyone reads.
    const detailed = shown.length === 1;
    return {
      description: `Total slayer xp **${formatNumber(s.totalExperience)}**`,
      fields: shown.map((b) => ({
        name: `${b.boss.slice(0, 1).toUpperCase()}${b.boss.slice(1)}`,
        value:
          `Tier ${b.tier}/${b.maxTier} · ${formatNumber(b.experience)} xp` +
          (detailed ? `
${tierBreakdown(b.kills)}` : ` · ${formatNumber(totalKills(b.kills))} kills`),
        inline: !detailed,
      })),
      color: "SUCCESS",
    };
  });
}

export function renderDungeonsEmbed(ign: string, result: HypixelResult<DungeonsDTO>): EmbedView {
  return statEmbed(cardTitle(ign, "dungeons"), result, (d) => {
    if (!d.played) {
      return { description: C.noDungeons, color: "NEUTRAL" };
    }
    const fields = [
      { name: F.catacombs, value: formatLevel(d.catacombsLevel), inline: true },
      { name: F.classAverage, value: formatLevel(d.classAverage), inline: true },
      { name: F.selected, value: d.selectedClass ?? "—", inline: true },
      ...d.classes.map((c) => ({ name: c.name, value: `${c.level}`, inline: true })),
    ];

    // Where the next Catacombs level actually is. Shown only below the cap,
    // where "0 XP to go" would be a misleading way to say "finished".
    if (d.catacombsProgress !== null && d.catacombsXpToNext !== null) {
      fields.push({
        name: F.progress,
        value: `${progressBar(d.catacombsProgress)}\n${formatNumber(d.catacombsXpToNext)} XP to next level`,
        inline: false,
      });
    }

    // Completions per floor — the answer to "what do they actually run", which
    // a single headline level can't give.
    for (const [label, prefix, list] of [
      ["Floor completions", "F", d.floors],
      ["Master mode", "M", d.masterFloors],
    ] as const) {
      const cleared = list.filter((f) => f.completions > 0);
      if (cleared.length === 0) continue;
      const total = cleared.reduce((sum, f) => sum + f.completions, 0);
      fields.push({
        name: `${label} (${formatNumber(total)})`,
        value: cleared.map((f) => `${prefix}${f.floor} **${formatNumber(f.completions)}**`).join(" · "),
        inline: false,
      });
    }

    // The highest floor with a recorded S+ is the one that says the most about
    // where a player actually runs.
    const best = [...d.floors, ...d.masterFloors]
      .filter((f) => f.fastestSPlusMs !== null)
      .sort((a, b) => Number(b.floor) - Number(a.floor))[0];
    if (best && best.fastestSPlusMs !== null) {
      fields.push({
        name: `Fastest S+ (${best.floor})`,
        value: formatDuration(best.fastestSPlusMs),
        inline: true,
      });
    }
    return { fields, color: "SUCCESS" };
  });
}

/**
 * `/stats` — the one-card overview. Each section degrades on its own: one
 * unreadable part shows "—" rather than blanking the whole card.
 */
export function renderStatsEmbed(
  ign: string,
  profile: HypixelResult<ProfileSummaryDTO>,
  slayers: HypixelResult<SlayersDTO>,
  dungeons: HypixelResult<DungeonsDTO>,
  networth: HypixelResult<NetworthDTO>,
  /**
   * Guild standing, for the surfaces that know whose card this is. Optional
   * because `/stats <player>` addresses an IGN and standing is keyed by Discord
   * id — only `/me` can be certain the two are the same person.
   */
  standing?: XpStandingDTO | null,
  /**
   * The caller's own record with staff. Same reason as `standing` for being
   * optional, and one more: it is only ever the caller's, so a card about
   * somebody else must not carry one.
   */
  record?: MemberRecordDTO | null,
): EmbedView {
  if (!profile.ok) {
    return { title: ign, description: renderFailure(profile.error.state), color: "NEUTRAL" };
  }
  const p = profile.value.data;
  const nw =
    networth.ok && networth.value.data.total !== null
      ? `${formatCoins(networth.value.data.total)}${networth.value.data.exact ? "" : "+"}`
      : "—";
  const recordField = record === undefined || record === null ? null : renderMemberRecordField(record);

  return {
    title: cardTitle(ign, "stats"),
    description: `Profile **${profileLabel(p)}**`,
    // Padded: how many fields this card carries depends on whether standing and
    // a staff record were available, so the row can end short in three different
    // ways and none of them is a reason to leave a field stranded.
    fields: padInlineRow([
      { name: F.skyblockLevel, value: formatLevel(p.skyblockLevel), inline: true },
      { name: F.skillAverage, value: formatLevel(p.skillAverage), inline: true },
      {
        name: F.catacombs,
        value: formatLevel(dungeons.ok ? dungeons.value.data.catacombsLevel : null),
        inline: true,
      },
      { name: F.weight, value: weightText(p.senitherWeight), inline: true },
      { name: F.networth, value: nw, inline: true },
      {
        name: F.slayerXp,
        value: slayers.ok ? formatNumber(slayers.value.data.totalExperience) : "—",
        inline: true,
      },
      // Appended rather than interleaved: the Hypixel numbers describe an
      // account, these two describe a guild member, and keeping them at the end
      // means the card reads the same whether or not standing was available.
      ...(standing
        ? [
            {
              name: F.guildStanding,
              value: `Level ${standing.level} · ${formatNumber(standing.totalXp)} XP${
                standing.rank === null ? "" : ` · #${standing.rank}`
              }`,
              inline: true,
            },
            {
              name: F.tenure,
              value: standing.tenureDays === 0 ? "—" : `${formatNumber(standing.tenureDays)} days`,
              inline: true,
            },
          ]
        : []),
      ...(recordField === null ? [] : [recordField]),
    ]),
    footer: stalenessFooter(profile.value),
    color: "INFO",
  };
}

/**
 * Everything `/me` knows about the caller, and each part optional.
 *
 * An object rather than nine positional arguments because every one of them can
 * be absent for its own reason — XP switched off, no achievements configured, a
 * deployment with no database behind the member bot — and a call site with four
 * `null`s in a row is one where the next `null` lands in the wrong slot.
 */
export interface ProfileCardInput {
  readonly profile: HypixelResult<ProfileSummaryDTO>;
  readonly slayers: HypixelResult<SlayersDTO>;
  readonly dungeons: HypixelResult<DungeonsDTO>;
  readonly networth: HypixelResult<NetworthDTO>;
  readonly standing?: XpStandingDTO | null;
  readonly record?: MemberRecordDTO | null;
  readonly achievements?: AchievementsDTO | null;
  readonly podium?: EventPodiumDTO | null;
  readonly positions?: readonly LeaderboardPositionDTO[] | null;
}

/** Latest unlocks named on the card. Three: it is a headline, not a history. */
const CARD_UNLOCKS = 3;

/** One field, built the way `padInlineRow` and the embed view expect it. */
interface CardField {
  readonly name: string;
  readonly value: string;
  readonly inline: boolean;
}

/**
 * `/me` — the member's own card.
 *
 * Distinct from `/stats` on purpose. `/stats <player>` describes a Hypixel
 * account and can be run against anybody; this describes a *member of this
 * guild*, and every section below the Hypixel row — standing, achievements,
 * podiums, ranks, record — is only ever true of the person who typed it.
 *
 * Each section is independently optional and independently absent. A section
 * whose data did not arrive is missing rather than zeroed: "0 achievements" and
 * "we could not read your achievements" are different claims, and only one of
 * them is ours to make.
 *
 * A failed Hypixel read does not blank the card. The guild half is still true,
 * and a member whose profile is briefly unreadable should still be told where
 * they stand.
 */
export function renderProfileCardEmbed(ign: string, input: ProfileCardInput): EmbedView {
  const p = input.profile.ok ? input.profile.value.data : null;
  const nw =
    input.networth.ok && input.networth.value.data.total !== null
      ? `${formatCoins(input.networth.value.data.total)}${input.networth.value.data.exact ? "" : "+"}`
      : "—";

  const headline = input.profile.ok
    ? `**SkyBlock Level ${formatLevel(input.profile.value.data.skyblockLevel)}** · Profile **${profileLabel(
        input.profile.value.data,
      )}**`
    : renderFailure(input.profile.error.state);

  const hypixelRow: CardField[] = [
    { name: F.skillAverage, value: formatLevel(p === null ? null : p.skillAverage), inline: true },
    {
      name: F.catacombs,
      value: formatLevel(input.dungeons.ok ? input.dungeons.value.data.catacombsLevel : null),
      inline: true,
    },
    { name: F.weight, value: p === null ? "—" : weightText(p.senitherWeight), inline: true },
    { name: F.networth, value: nw, inline: true },
    {
      name: F.slayerXp,
      value: input.slayers.ok ? formatNumber(input.slayers.value.data.totalExperience) : "—",
      inline: true,
    },
  ];

  const standing = input.standing ?? null;
  const standingRow: CardField[] =
    standing === null
      ? []
      : [
          {
            name: F.guildStanding,
            value: `Level ${standing.level} · ${formatNumber(standing.totalXp)} XP${
              standing.rank === null ? "" : ` · #${standing.rank}`
            }`,
            inline: true,
          },
          {
            name: F.tenure,
            value: standing.tenureDays === 0 ? "—" : `${formatNumber(standing.tenureDays)} days`,
            inline: true,
          },
        ];

  const sections = [
    achievementField(input.achievements ?? null),
    podiumField(input.podium ?? null),
    positionsField(input.positions ?? null),
    input.record === undefined || input.record === null ? null : renderMemberRecordField(input.record),
  ].filter((field): field is CardField => field !== null);

  return {
    title: `${ign} — profile`,
    description: headline,
    fields: [...padInlineRow([...hypixelRow, ...standingRow]), ...sections],
    ...(input.profile.ok ? { footer: stalenessFooter(input.profile.value) } : {}),
    color: input.profile.ok ? "INFO" : "NEUTRAL",
  };
}

/**
 * Achievements as one field: the tally, the tier breakdown, the latest few.
 *
 * Null in three different situations, and they are genuinely different: nothing
 * was read (the port is absent, or the read failed), the guild has achievements
 * switched off, or it has defined none. None of them means "you have earned
 * nothing", so none of them prints a zero.
 */
function achievementField(data: AchievementsDTO | null): CardField | null {
  if (data === null || !data.configured || data.totalCount === 0) return null;

  const byTier = new Map<AchievementTier, number>();
  for (const a of data.earned) byTier.set(a.tier, (byTier.get(a.tier) ?? 0) + 1);
  // Rarest first, and a tier nobody has earned is left out rather than shown as
  // a zero — the row is a record of what was done, not a checklist.
  const badges = (["PLATINUM", "GOLD", "SILVER", "BRONZE"] as const)
    .filter((tier) => (byTier.get(tier) ?? 0) > 0)
    .map((tier) => `${TIER_BADGE[tier]} ${String(byTier.get(tier) ?? 0)}`)
    .join(" · ");

  const latest = [...data.earned]
    .filter((a) => a.achievedAt !== null)
    .sort((a, b) => (b.achievedAt ?? "").localeCompare(a.achievedAt ?? ""))
    .slice(0, CARD_UNLOCKS)
    .map((a) => `${glyph(a)} **${a.label}** · <t:${Math.floor(Date.parse(a.achievedAt ?? "") / 1000)}:R>`);

  const lines = [
    `**${data.earnedCount}/${data.totalCount}** earned${badges === "" ? "" : ` — ${badges}`}`,
    ...latest,
  ];
  return { name: F.achievements, value: lines.join("\n"), inline: false };
}

/**
 * Event podiums. Absent for a member who has never placed and never attended,
 * rather than three zeroes — a card that shows everybody's empty medal rack
 * teaches readers to skip the section that would one day have something in it.
 */
function podiumField(data: EventPodiumDTO | null): CardField | null {
  if (data === null) return null;
  const medals = data.gold + data.silver + data.bronze;
  if (medals === 0 && data.attended === 0) return null;

  const tally = [
    data.gold > 0 ? `🥇 ${String(data.gold)}` : null,
    data.silver > 0 ? `🥈 ${String(data.silver)}` : null,
    data.bronze > 0 ? `🥉 ${String(data.bronze)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const attended =
    data.attended === 0 ? "" : `${tally === "" ? "" : " · "}${formatNumber(data.attended)} attended`;

  const recent = data.recent.map((placing) => {
    const when = placing.at === null ? "" : ` · <t:${Math.floor(Date.parse(placing.at) / 1000)}:R>`;
    const medal = placing.place === 1 ? "🥇" : placing.place === 2 ? "🥈" : "🥉";
    return `${medal} **${placing.eventTitle}** — ${metricLabel(placing.metric)}${when}`;
  });

  return { name: "Events", value: [`${tally}${attended}`, ...recent].join("\n"), inline: false };
}

/**
 * Where the member sits on the boards they are ranked on.
 *
 * One field rather than one per board, because the interesting thing is the
 * shape of it: a member who is top ten on three boards out of four should see
 * that at a glance instead of reading four rows to find out.
 */
function positionsField(positions: readonly LeaderboardPositionDTO[] | null): CardField | null {
  if (positions === null || positions.length === 0) return null;
  const value = positions
    .map((row) => `${row.label} **#${String(row.rank)}** of ${formatNumber(row.totalRanked)}`)
    .join(" · ");
  return { name: F.leaderboards, value, inline: false };
}

/**
 * A tracked metric's key as a member would say it. Deliberately forgiving:
 * events name their own metrics off the snapshot's own keys, so one we have
 * never seen is tidied and printed rather than dropped.
 */
function metricLabel(metric: string): string {
  // Read from the field vocabulary rather than restated: a metric printed on an
  // event podium and the same metric printed as a card field are the same thing
  // to a reader, and two lists is how they stop matching.
  const known: Readonly<Record<string, string>> = {
    catacombsLevel: F.catacombs,
    catacombs: F.catacombs,
    networth: F.networth,
    skillAverage: F.skillAverage,
    skyblockLevel: F.skyblockLevel,
    slayerXp: F.slayerXp,
    senitherWeight: F.weight,
  };
  const direct = known[metric];
  if (direct !== undefined) return direct;
  // `skill:mining` → `Mining`.
  const parts = metric.split(":");
  const tail = parts[parts.length - 1] ?? metric;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

/**
 * "Where do I stand with staff", as one field on the caller's own card.
 *
 * Null for a member with nothing against them. A field reading "0 warnings" on
 * every clean member's card would train everybody to skip past the section, and
 * the one time it says something would look the same as the times it does not.
 *
 * The reason staff typed is shown. It is the member's own punishment, they were
 * told it at the time, and a mute whose reason is a secret is one they can only
 * guess how to avoid repeating.
 */
export function renderMemberRecordField(
  record: MemberRecordDTO,
  now: Date = new Date(),
): { name: string; value: string; inline: boolean } | null {
  const lines: string[] = [];

  for (const punishment of record.inForce) {
    const verb = punishment.type === "MUTE" ? "Muted" : punishment.type === "BAN" ? "Banned" : punishment.type;
    const remaining =
      punishment.expiresAt === null
        ? ""
        : ` · ends in ${formatDuration(Math.max(0, Date.parse(punishment.expiresAt) - now.getTime()))}`;
    lines.push(`**${verb}**${remaining} — ${punishment.reason}`);
  }

  if (record.warnings > 0) {
    const window = `in the last ${record.windowDays} days`;
    const next =
      record.nextEscalation === null
        ? ""
        : ` · one more → ${record.nextEscalation.action.toLowerCase()}${
            record.nextEscalation.durationSeconds === null
              ? ""
              : ` for ${formatDuration(record.nextEscalation.durationSeconds * 1000)}`
          }`;
    lines.push(`${record.warnings} warning${record.warnings === 1 ? "" : "s"} ${window}${next}`);
  }

  if (lines.length === 0) return null;
  return { name: F.yourRecord, value: lines.join("\n"), inline: false };
}

// ── Standing (COMMANDS.md §18) ──────────────────────────────────────────────

/** How each XP source is named to a member — the member's word, not the enum's. */
const XP_SOURCE_LABELS: Readonly<Record<XpSource, string>> = copy.embed.xpSource;

/** `▰▰▰▱▱▱▱▱▱▱`. Built from the DTO's own numbers so this file needs no engine. */
function xpProgressBar(intoLevel: number, levelSpan: number, width = 10): string {
  const ratio = levelSpan <= 0 ? 0 : intoLevel / levelSpan;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/**
 * `/standing` — level, progress, and where the XP came from.
 *
 * The breakdown lists only sources that actually paid, and always states the
 * total it adds up to. A member who disagrees with their standing should be able
 * to point at the line they think is wrong, which is the whole reason the ledger
 * carries raw values in the first place.
 */
export function renderStandingEmbed(name: string, standing: XpStandingDTO): EmbedView {
  const earned = (Object.entries(standing.bySource) as Array<[XpSource, number]>)
    .filter(([, amount]) => amount !== 0)
    .sort((a, b) => b[1] - a[1]);

  const breakdown =
    earned.length === 0
      ? C.noXpYet
      : earned.map(([source, amount]) => `${XP_SOURCE_LABELS[source]} — ${formatNumber(amount)}`).join("\n");

  const bar = xpProgressBar(standing.intoLevel, standing.levelSpan);
  const toNext = Math.max(0, standing.levelSpan - standing.intoLevel);

  return {
    title: cardTitle(name, "standing"),
    description: `**Level ${standing.level}** · ${formatNumber(standing.totalXp)} XP\n${bar} ${formatNumber(
      standing.intoLevel,
    )}/${formatNumber(standing.levelSpan)} · ${formatNumber(toNext)} to level ${standing.level + 1}`,
    fields: [
      { name: F.rank, value: standing.rank === null ? "—" : `#${standing.rank}`, inline: true },
      {
        name: F.tenure,
        value: standing.tenureDays === 0 ? "—" : `${formatNumber(standing.tenureDays)} days`,
        inline: true,
      },
      {
        name: F.lastEarned,
        value: standing.lastAwardAt === null ? "—" : describeAge(standing.lastAwardAt.toISOString()),
        inline: true,
      },
      { name: F.whereFrom, value: breakdown, inline: false },
    ],
    // Not a staleness footer: standing is recomputed on a cadence rather than
    // fetched, so what a member needs to know is that today is still counting,
    // not how old some upstream read was.
    footer: C.standingFooter,
    color: "INFO",
  };
}

// ── Leaderboards (COMMANDS.md §19) ──────────────────────────────────────────

/** One ranked value, printed the way its category means it. */
function formatValue(value: number, format: LeaderboardValueFormat): string {
  switch (format) {
    case "coins":
      return formatCoins(value);
    case "level":
      return formatLevel(value);
    case "days":
      return `${formatNumber(value)}d`;
    case "count":
      return formatNumber(value);
  }
}

/**
 * `#1 Alice — 8.20b`. Medals for the top three because they are the only ranks
 * anyone reads at a glance; everything below is a number and reads better as
 * one.
 */
function leaderboardLine(entry: LeaderboardEntryDTO, format: LeaderboardValueFormat): string {
  const medal = entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : `\`#${entry.rank}\``;
  const name = entry.isViewer ? `**${entry.label}**` : entry.label;
  return `${medal} ${name} — ${formatValue(entry.value, format)}`;
}

/**
 * `/leaderboard` — one category, one page, and an honest footer.
 *
 * The footer is where most of the care goes. A wealth board is built from
 * snapshots that can be half a day old, an activity board covers a window, and
 * an XP board is only as current as the last aggregation. Printing a ranking
 * without saying which of those it is invites an argument the numbers cannot
 * settle.
 */
export function renderLeaderboardEmbed(page: LeaderboardPageDTO, now = Date.now()): EmbedView {
  const { spec } = page;

  const body =
    page.entries.length === 0
      ? C.nobodyRanked
      : page.entries.map((e) => leaderboardLine(e, spec.format)).join("\n");

  // Appended rather than merged into the list: the viewer's row is an answer to
  // a different question ("where am I"), and slotting it into the top ten would
  // misrepresent the ranking.
  const yours =
    page.viewer === null ? "" : `\n\nYou: \`#${page.viewer.rank}\` — ${formatValue(page.viewer.value, spec.format)}`;

  const parts: string[] = [];
  if (page.pageCount > 1) parts.push(`page ${page.page}/${page.pageCount}`);
  parts.push(`${formatNumber(page.totalRanked)} ranked`);
  if (page.windowDays !== null) parts.push(`last ${page.windowDays}d`);
  if (page.oldestReadingAt !== null) parts.push(`oldest reading ${describeAge(page.oldestReadingAt, now)}`);

  return {
    title: cardTitle(spec.label, "leaderboard"),
    description: `${spec.description}\n\n${body}${yours}`,
    footer: parts.join(" · "),
    color: "INFO",
  };
}

/**
 * The one-line form for guild chat: the top few and nothing else. Built here
 * rather than by flattening the embed, because a flattened description would
 * spend the 252-character budget on the category blurb before reaching a name.
 */
export function renderLeaderboardLine(page: LeaderboardPageDTO, top = 5): string {
  if (page.entries.length === 0) return `${page.spec.label}: nobody ranked yet`;
  const shown = page.entries
    .slice(0, top)
    .map((e) => `${e.rank}. ${e.label} ${formatValue(e.value, page.spec.format)}`)
    .join(" | ");
  return `${page.spec.label}: ${shown}`;
}

// ── Optimization (COMMANDS.md §5) ───────────────────────────────────────────

/** `12m` or `—`; a suggestion with no price shows the dash, never a zero. */
function costTag(cost: number | null): string {
  return cost === null ? "" : ` · ~${formatCoins(cost)}`;
}

function suggestionField(s: AccessorySuggestionDTO): { name: string; value: string; inline: boolean } {
  return {
    name: `${s.name} (${s.rarity.toLowerCase()})`,
    value: `${s.replaces === null ? "" : `replaces ${s.replaces} — `}${s.why}${costTag(s.estimatedCost)}`,
    inline: false,
  };
}

/**
 * `/missing` — what the member is short of, and what they hold that no longer
 * counts. An unreadable bag is reported as unreadable: the alternative is a
 * card that lists every accessory in the game as "missing", which is worse than
 * saying nothing.
 */
export function renderAccessoriesEmbed(
  ign: string,
  result: HypixelResult<AccessoryReportDTO>,
): EmbedView {
  const embed = statEmbed(cardTitle(ign, "accessories"), result, (r) => {
    if (r.apiDisabled) {
      return {
        description: C.bagUnreadable,
        color: "NEUTRAL",
      };
    }

    const fields = [
      {
        name: F.magicalPower,
        value: r.magicalPower === null ? "unknown" : formatNumber(r.magicalPower),
        inline: true,
      },
      { name: "Tuning", value: r.tuning ?? "—", inline: true },
      { name: "Owned", value: `${r.owned.length}`, inline: true },
      ...r.upgradeable.slice(0, 5).map(suggestionField),
      ...r.missing.slice(0, 8).map(suggestionField),
    ];

    if (r.redundant.length > 0) {
      // Worth surfacing: these occupy bag slots and contribute nothing, which
      // is not obvious in-game.
      fields.push({
        name: "Contributing nothing",
        value: r.redundant.map((a) => a.name).join(", "),
        inline: false,
      });
    }

    return {
      description:
        r.missing.length === 0 && r.upgradeable.length === 0
          ? "Nothing notable left to pick up — every catalogued accessory is at its best tier."
          : `${r.missing.length} to pick up, ${r.upgradeable.length} to upgrade.`,
      fields,
      color: "INFO",
    };
  });

  // The scope caveat rides in the footer beside the staleness note, so nobody
  // reads an empty "missing" list as "you own everything in the game".
  if (!result.ok) return embed;
  return { ...embed, footer: `${embed.footer ?? ""} • ${result.value.data.note}`.replace(/^ • /, "") };
}

const PRIORITY_MARK: Readonly<Record<string, string>> = { HIGH: "🔴", MEDIUM: "🟠", LOW: "🟡" };

/**
 * `/nextupgrade` and `/whatnext`. `generic` advice is labelled as such — it is
 * the same list anyone would get, and presenting it as personalized would be a
 * lie about what we could read.
 */
export function renderAdviceEmbed(
  ign: string,
  title: string,
  result: HypixelResult<AdviceDTO>,
): EmbedView {
  return statEmbed(titleFor(ign, title), result, (a) => {
    if (a.items.length === 0) {
      return { description: C.noAdvice, color: "SUCCESS" };
    }
    return {
      description: a.generic
        ? C.genericAdvice
        : `Focus: **${a.focus}**`,
      fields: a.items.map((i) => ({
        name: `${PRIORITY_MARK[i.priority] ?? ""} ${i.title}`.trim(),
        value: `${i.detail}${costTag(i.estimatedCost)}`,
        inline: false,
      })),
      color: a.generic ? "NEUTRAL" : "INFO",
    };
  });
}

/** Metric values read very differently: coins want `2.00b`, a level wants `40`. */
function formatMetric(metric: string, value: number): string {
  if (metric === "networth" || metric === "slayerXp") return formatCoins(value);
  if (metric === "senitherWeight") return formatNumber(Math.round(value));
  return formatLevel(value);
}

/** A ten-cell bar. Text, not an image: the in-game surface has to read it too. */
function progressBar(fraction: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${Math.round(fraction * 100)}%`;
}

/**
 * The badge for a tier. Editorial weight in one character, because a field name
 * has no room for the word and a member reading twelve earned achievements
 * wants to see at a glance which two were hard.
 */
const TIER_BADGE: Readonly<Record<AchievementTier, string>> = {
  BRONZE: "🥉",
  SILVER: "🥈",
  GOLD: "🥇",
  PLATINUM: "💎",
};

/** Headings, in the order a member reads them rather than alphabetically. */
const CATEGORY_LABEL: Readonly<Record<AchievementCategory, string>> = {
  PROGRESSION: "Progression",
  WEALTH: "Wealth",
  DUNGEONS: "Dungeons",
  SKILLS: "Skills",
  SLAYER: "Slayer",
  COMMUNITY: "Community",
  EVENTS: "Events",
};

const CATEGORY_ORDER: readonly AchievementCategory[] = [
  "PROGRESSION",
  "WEALTH",
  "DUNGEONS",
  "SKILLS",
  "SLAYER",
  "COMMUNITY",
  "EVENTS",
];

/** Six per category: a field is 1024 characters and this is a summary. */
const PER_CATEGORY = 6;
/** Four ahead — past that, "next" stops meaning anything. */
const UPCOMING_SHOWN = 4;

/** A definition's own emoji, or its tier's. Never both: two glyphs is noise. */
function glyph(a: AchievementDTO): string {
  return a.icon ?? TIER_BADGE[a.tier];
}

/**
 * `/milestones` — the guild's achievements and where this member stands.
 *
 * Earned is grouped by family and upcoming is ranked by nearness, because those
 * answer different questions: a record is read by category ("how are my dungeons
 * going") and a target is read by distance ("what can I get this week"). One
 * flat list answered neither well.
 *
 * Hidden achievements are counted and never named. That is the whole feature: a
 * number tells a member there is more to find, and a name would be the thing
 * they were not supposed to have yet.
 */
export function renderAchievementsEmbed(ign: string, data: AchievementsDTO): EmbedView {
  if (!data.configured) {
    return {
      title: cardTitle(ign, "achievements"),
      // "Off", not "none": a member reading an empty list would conclude they
      // had achieved nothing, which is a different and untrue claim.
      description: C.achievementsOff,
      color: "NEUTRAL",
    };
  }
  if (data.totalCount === 0) {
    return {
      title: cardTitle(ign, "achievements"),
      description: C.achievementsNone,
      color: "NEUTRAL",
    };
  }

  const byCategory = new Map<AchievementCategory, AchievementDTO[]>();
  for (const a of data.earned) {
    const bucket = byCategory.get(a.category);
    if (bucket === undefined) byCategory.set(a.category, [a]);
    else bucket.push(a);
  }

  const earned = CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => {
    const all = byCategory.get(category) ?? [];
    // Rarest first within a family: the tier is the reason to group them at all,
    // and newest-first would bury a Platinum under three Bronzes.
    const sorted = [...all].sort(
      (a, b) => tierRank(b.tier) - tierRank(a.tier) || (b.achievedAt ?? "").localeCompare(a.achievedAt ?? ""),
    );
    const lines = sorted.slice(0, PER_CATEGORY).map((a) => {
      const when = a.achievedAt === null ? "" : ` · <t:${Math.floor(Date.parse(a.achievedAt) / 1000)}:R>`;
      const xp = a.xpReward > 0 ? ` · +${formatNumber(a.xpReward)} XP` : "";
      return `${glyph(a)} **${a.label}**${when}${xp}`;
    });
    if (sorted.length > PER_CATEGORY) lines.push(`…and ${sorted.length - PER_CATEGORY} more`);
    return { name: `${CATEGORY_LABEL[category]} (${all.length})`, value: lines.join("\n"), inline: false };
  });

  const upcoming = data.upcoming.slice(0, UPCOMING_SHOWN).map((a) => ({
    name: `${glyph(a)} ${a.label}`,
    value:
      a.progress === null
        ? // No snapshot for this metric yet — say so instead of drawing an empty
          // bar, which would read as "0%" and imply a measurement we don't have.
          `${formatMetric(a.metric, a.threshold)} · not measured yet`
        : `${progressBar(a.progress)} — ${formatMetric(a.metric, a.current ?? 0)} / ${formatMetric(a.metric, a.threshold)}`,
    inline: false,
  }));

  const measured =
    data.measuredAt === null
      ? "No snapshot yet — progress appears after the next daily capture."
      : `Measured <t:${Math.floor(Date.parse(data.measuredAt) / 1000)}:R>`;

  // Named in the description rather than a field, so it reads as a property of
  // the tally it sits under and not as a category of its own.
  const hidden =
    data.hiddenLocked === 0
      ? ""
      : `\n${data.hiddenLocked} hidden achievement${data.hiddenLocked === 1 ? "" : "s"} still to find.`;

  return {
    title: cardTitle(ign, "achievements"),
    description:
      `**${data.earnedCount}/${data.totalCount}** earned` +
      (data.xpEarned > 0 ? ` · **${formatNumber(data.xpEarned)}** guild XP from achievements` : "") +
      hidden,
    fields: [
      ...(earned.length > 0
        ? earned
        : [{ name: "Nothing earned yet", value: "The closest ones are below.", inline: false }]),
      ...(upcoming.length > 0 ? [{ name: "​", value: "**Up next**", inline: false }, ...upcoming] : []),
    ],
    footer: measured,
    color: data.earnedCount > 0 ? "SUCCESS" : "INFO",
  };
}

export function renderProgressEmbed(ign: string, series: ProgressSeriesDTO): EmbedView {
  if (series.points.length === 0) {
    return {
      title: titleFor(ign, series.metric),
      description: C.noSnapshots.replace("{n}", String(series.rangeDays)),
      color: "NEUTRAL",
    };
  }
  const fmt = (v: number | null): string =>
    v === null ? "—" : series.metric === "networth" ? formatCoins(v) : formatLevel(v);

  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  return {
    title: titleFor(ign, series.metric),
    description:
      series.change === null
        ? C.oneSnapshot
        : `**${series.change >= 0 ? "+" : "−"}${fmt(Math.abs(series.change))}** over ${series.rangeDays} days`,
    fields: [
      { name: first?.date ?? "start", value: fmt(first?.value ?? null), inline: true },
      { name: last?.date ?? "now", value: fmt(last?.value ?? null), inline: true },
      { name: F.snapshots, value: `${series.points.length}`, inline: true },
    ],
    color: series.change !== null && series.change < 0 ? "WARNING" : "SUCCESS",
  };
}

/** Coins, or an em dash — an unpriced item must never render as `0`. */
function coinsOrUnknown(n: number | null): string {
  return n === null ? "—" : formatCoins(n);
}

/** Prefer the catalog's pretty name, fall back to the raw id we were given. */
function itemLabel(itemId: string, displayName: string | null): string {
  return displayName ?? itemId;
}

/** `/price` — the blended valuation, with the sources it was blended from. */
export function renderPriceEmbed(result: HypixelResult<PriceDTO>): EmbedView {
  return statEmbed("Price", result, (data) => ({
    description: `**${data.itemId}** — ${coinsOrUnknown(data.estimatedValue)}`,
    fields: [
      { name: "Lowest BIN", value: coinsOrUnknown(data.lowestBin), inline: true },
      { name: "Bazaar buy", value: coinsOrUnknown(data.bazaarInstantBuy), inline: true },
      { name: "Bazaar sell", value: coinsOrUnknown(data.bazaarInstantSell), inline: true },
    ],
    color: data.estimatedValue === null ? "NEUTRAL" : "SUCCESS",
  }));
}

/** `/bazaar` — the order book, buy side and sell side kept distinct. */
export function renderBazaarEmbed(result: HypixelResult<BazaarQuoteDTO>): EmbedView {
  return statEmbed("Bazaar", result, (data) => ({
    description: `**${itemLabel(data.itemId, data.displayName)}**`,
    fields: [
      { name: "Instant buy", value: coinsOrUnknown(data.instantBuy), inline: true },
      { name: "Instant sell", value: coinsOrUnknown(data.instantSell), inline: true },
      { name: "Spread", value: coinsOrUnknown(data.spread), inline: true },
      {
        name: "Buy volume",
        value: data.buyVolume === null ? "—" : formatNumber(data.buyVolume),
        inline: true,
      },
      {
        name: "Sell volume",
        value: data.sellVolume === null ? "—" : formatNumber(data.sellVolume),
        inline: true,
      },
    ],
    color: "SUCCESS",
  }));
}

/** `/lowestbin` — a cold sweep cache says so rather than reporting no listings. */
export function renderLowestBinEmbed(result: HypixelResult<LowestBinDTO>): EmbedView {
  return statEmbed("Lowest BIN", result, (data) => {
    if (data.price === null) {
      return {
        description:
          `No BIN listing for **${itemLabel(data.itemId, data.displayName)}** in the last ` +
          `auction sweep. It may be unsold, or not yet covered by the sweep.`,
        color: "NEUTRAL",
      };
    }
    return {
      description: `**${itemLabel(data.itemId, data.displayName)}** — ${formatCoins(data.price)}`,
      fields: [{ name: "Listings", value: formatNumber(data.listings), inline: true }],
      color: "SUCCESS",
    };
  });
}

/**
 * `/auctions` — a player's own listings, or the cheapest listings for an item.
 * The two share a renderer because they answer the same shape of question.
 */
/** Rows per bucket. An embed field caps at 1024 characters; ten lines fits. */
const AUCTIONS_PER_BUCKET = 10;

export function renderAuctionsEmbed(
  subject: string,
  result: HypixelResult<AuctionsDTO>,
  now: number = Date.now(),
): EmbedView {
  return statEmbed(C.auctions.replace("{subject}", subject), result, (data) => {
    if (data.listings.length === 0) {
      return { description: C.noAuctions.replace("{subject}", subject), color: "NEUTRAL" };
    }

    const line = (l: AuctionListingDTO): string => {
      const ends =
        l.endsAt === null
          ? ""
          : ` • ends in ${formatDuration(Math.max(0, new Date(l.endsAt).getTime() - now))}`;
      return `${l.itemName ?? "Unknown item"} — ${coinsOrUnknown(l.price)}${l.bin ? " (BIN)" : " (auction)"}${ends}`;
    };

    const fields = [];
    // Ordered by what the seller should do next: collect the coins, take the
    // unsold items back, then watch what is still running.
    if (data.unclaimed.length > 0) {
      fields.push({
        name: `Sold, unclaimed (${data.unclaimed.length})`,
        value: data.unclaimed
          .slice(0, AUCTIONS_PER_BUCKET)
          .map((l) => `${l.itemName ?? "Unknown item"} — **${coinsOrUnknown(l.highestBid)}**`)
          .join("\n"),
        inline: false,
      });
    }
    if (data.expired.length > 0) {
      fields.push({
        name: `Expired, unsold (${data.expired.length})`,
        value: data.expired
          .slice(0, AUCTIONS_PER_BUCKET)
          .map((l) => l.itemName ?? "Unknown item")
          .join("\n"),
        inline: false,
      });
    }
    if (data.active.length > 0) {
      fields.push({
        name: `Active (${data.active.length})`,
        value: data.active.slice(0, AUCTIONS_PER_BUCKET).map(line).join("\n"),
        inline: false,
      });
    }

    return {
      ...(data.claimValue !== null
        ? { description: `**${formatCoins(data.claimValue)}** waiting to be claimed.` }
        : {}),
      fields,
      color: "SUCCESS",
    };
  });
}

/**
 * `/online` — who is in the guild right now, grouped by rank.
 *
 * Ranks keep the order Hypixel printed them in (highest first) rather than
 * being sorted here: that ordering is guild-specific and the roster is the only
 * place the bot ever learns it.
 *
 * The counts in the description come from Hypixel's own summary lines, so they
 * stay right even when the name list below them is clipped — an embed field
 * caps at 1024 characters and a large guild will exceed it.
 */
export function renderRosterEmbed(roster: GuildRosterDTO, now: number = Date.now()): EmbedView {
  const listed = roster.ranks.reduce((n, r) => n + r.members.length, 0);
  const online = roster.online ?? listed;

  const headline =
    roster.total === null ? `**${online}** online` : `**${online}** of ${formatNumber(roster.total)} members online`;

  if (listed === 0) {
    return {
      title: rosterTitle(roster),
      description: online === 0 ? C.nobodyOnline : headline,
      color: "NEUTRAL",
      footer: `as of ${describeAge(roster.fetchedAt, now)}`,
    };
  }

  return {
    title: rosterTitle(roster),
    description: headline,
    // Ranks with nobody online are dropped rather than rendered as a rank with
    // an empty list: Discord rejects an embed field with an empty value and
    // fails the *whole* message, so one quiet rank would take `/online` down
    // for the entire guild. The rank still exists; nothing is claimed about it.
    fields: roster.ranks
      .filter((rank) => rank.members.length > 0)
      .map((rank) => ({
        name: `${rank.rank} — ${rank.members.length}`,
        value: truncateField(rank.members.join(", ")),
        inline: false,
      })),
    color: "SUCCESS",
    footer: `as of ${describeAge(roster.fetchedAt, now)}`,
  };
}

function rosterTitle(roster: GuildRosterDTO): string {
  return roster.guildName ? C.roster.replace("{guild}", roster.guildName) : C.rosterUnnamed;
}

/** Discord rejects an embed field value over 1024 characters outright. */
function truncateField(value: string): string {
  const LIMIT = 1024;
  if (value.length <= LIMIT) return value;
  const head = value.slice(0, LIMIT - 2);
  const seam = head.lastIndexOf(", ");
  return `${seam > LIMIT / 2 ? head.slice(0, seam) : head}…`;
}
