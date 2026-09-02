/**
 * User-facing rendering. Maps typed fallback states to honest messages and
 * formats networth respecting exact-vs-estimate and staleness.
 */
import { copy, theme } from "@sbr/brand";
import {
  capMarker,
  card,
  facts,
  field,
  inlineFacts,
  isCapped,
  player,
  progressBar,
  progressLine,
  type CardSpec,
} from "@sbr/embed-kit";
import { describeAge, padInlineRow, staleness, tierRank } from "@sbr/shared-types";
import { card, field } from "@sbr/embed-kit";
import { describePlaytime } from "@sbr/playtime";
import type {
  LivePlaytimeDTO,
  AccessoryReportDTO,
  DataEnvelope,
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
  GoalDTO,
  ProgressPointDTO,
  ProgressSeriesDTO,
  SkillDTO,
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

/**
 * The freshness half of a card: an age Discord owns, and a caveat we own.
 *
 * Every stat card used to end in a hand-written "as of 4m ago", which was true
 * when the message was sent and false for as long as anyone scrolled back to it.
 * The age moves to `timestamp`, which is re-rendered on every read; the footer
 * keeps only what does not decay — that we served cached numbers, and which
 * sections of a profile we could not see into.
 */
function freshnessOf<T>(envelope: DataEnvelope<T>, note?: string): Pick<EmbedView, "timestamp" | "footer"> {
  const { timestamp, footer } = staleness(envelope);
  const parts = [footer, note].filter((part): part is string => part !== undefined && part !== "");
  return parts.length > 0 ? { timestamp, footer: parts.join(" • ") } : { timestamp };
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
  return { title, ...body(result.value.data), ...freshnessOf(result.value) };
}

/**
 * `statEmbed`, rebuilt on the card layer.
 *
 * Same job — unwrap a `HypixelResult`, render the failure honestly, route the
 * envelope's freshness into the timestamp — but the body returns a `CardSpec`
 * body rather than a raw embed, so identity lands in the author row and the
 * title is free to be the noun. The old one stays until every card that uses it
 * has moved; two of them have.
 */
function statCard<T>(
  noun: string,
  subject: ReturnType<typeof player>,
  result: HypixelResult<T>,
  body: (data: T) => Omit<CardSpec, "title" | "subject" | "freshness">,
): EmbedView {
  const title = sentenceCase(noun);
  if (!result.ok) {
    return card({
      title,
      subject,
      headline: renderFailure(result.error.state),
      tone: result.error.state === "RATE_LIMITED" ? "WARNING" : "NEUTRAL",
    });
  }
  return card({ title, subject, ...body(result.value.data), freshness: staleness(result.value) });
}

/**
 * The card nouns are lowercase because they were written to sit inside
 * `{subject} — {noun}`. On a card whose subject has moved to the author row the
 * noun *is* the title, and a lowercase title reads as a mistake. Capitalising
 * here keeps one vocabulary rather than a second, title-cased copy of it.
 */
function sentenceCase(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
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

/**
 * Skills, twelve of them, as three fields instead of twelve.
 *
 * Twelve inline fields is twice the field budget and, on a phone, a two-column
 * block where every second cell is a label. The reading is the same twelve
 * numbers; the grouping is what the game already uses — the skills that count
 * toward the average, and the cosmetic ones that do not — so the card answers
 * "why is my average that" without the reader doing the exclusion by hand.
 *
 * Asking for one skill still gets one skill, in full, with its bar.
 */
export function renderSkillsEmbed(
  ign: string,
  result: HypixelResult<SkillsDTO>,
  only?: string,
  uuid?: string | null,
): EmbedView {
  const subject = player(ign, uuid);
  return statCard(C.noun.skills, subject, result, (s) => {
    if (s.apiDisabled) {
      return { tone: "NEUTRAL", headline: C.skillsOff };
    }
    const wanted = only?.toLowerCase();
    const shown = wanted ? s.skills.filter((k) => k.name.toLowerCase() === wanted) : s.skills;
    if (shown.length === 0) {
      return { tone: "NEUTRAL", headline: C.noSuchSkill.replace("{name}", only ?? "") };
    }

    // Counted against the readable skills only: "3 maxed" out of a set half of
    // which is hidden would overstate what we can actually see.
    const readable = s.skills.filter((k) => k.level !== null);
    const capped = readable.filter((k) => isCapped(k.level, k.maxLevel));
    const headline =
      `Skill average **${formatLevel(s.average)}**` +
      (readable.length > 0 ? ` · **${capped.length}/${readable.length}** at cap` : "");

    // One skill asked for by name gets the full reading, bar included. It is
    // the only case where there is room for one, and the only case where the
    // question was about that skill rather than about the spread.
    if (wanted && shown.length === 1) {
      const k = shown[0]!;
      return {
        tone: "SUCCESS",
        headline,
        fields: [
          field(k.name, skillDetail(k)),
          k.progress === null ? null : field(F.progress, progressLine(k.progress)),
        ],
      };
    }

    const counted = shown.filter((k) => !COSMETIC_SKILLS.has(k.name));
    const cosmetic = shown.filter((k) => COSMETIC_SKILLS.has(k.name));
    return {
      tone: "SUCCESS",
      headline,
      fields: [
        field(F.skills, counted.map(skillLine).join("\n")),
        field(F.cosmeticSkills, cosmetic.map(skillLine).join("\n")),
        // The one number the list cannot show: which skill is closest to its
        // next level, which is the one worth an hour tonight.
        field(F.closest, closestToNext(shown)),
      ],
    };
  });
}

/**
 * Named here rather than imported from `@sbr/progression`: the exclusion is a
 * fact about how the game displays skills, the renderer is the display, and the
 * parser's copy of the set is about arithmetic. Both are allowed to be right.
 */
const COSMETIC_SKILLS = new Set(["Carpentry", "Runecrafting", "Social"]);

/** `Farming 60 ✦` — level, cap, and the one shared marker when they meet. */
function skillLine(k: SkillDTO): string {
  if (k.level === null) return `${k.name} ${theme.embed.style.unknown}`;
  const mark = capMarker(k.level, k.maxLevel);
  return `${k.name} **${k.level}**/${k.maxLevel}${mark === "" ? "" : ` ${mark}`}`;
}

/** The single-skill reading: level, cap, and how far the next one is. */
function skillDetail(k: SkillDTO): string {
  if (k.level === null) return C.skillHidden;
  const at = `**${k.level}**/${k.maxLevel}`;
  if (k.xpToNext === null) return `${at} — at cap`;
  return `${at} · ${formatNumber(Math.round(k.xpToNext))} xp to level ${k.level + 1}`;
}

/**
 * The readable, uncapped skill with the least XP left.
 *
 * Skills with a hidden level are not candidates — an unknown remaining XP is
 * not a small one — and neither are capped ones, where "0 to go" is true and
 * useless.
 */
function closestToNext(skills: readonly SkillDTO[]): string {
  const candidates = skills.filter(
    (k): k is SkillDTO & { xpToNext: number } =>
      k.level !== null && k.xpToNext !== null && !isCapped(k.level, k.maxLevel),
  );
  if (candidates.length === 0) return "";
  const best = candidates.reduce((a, b) => (b.xpToNext < a.xpToNext ? b : a));
  return `${best.name} **${(best.level ?? 0) + 1}** — ${formatNumber(Math.round(best.xpToNext))} xp to go`;
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
 *
 * The upper bound is the boss's own `maxTier` rather than the highest tier with
 * a recorded kill. Stopping at the highest kill made the list end wherever the
 * player had got to, so the tiers ahead of them — the ones the breakdown exists
 * to show — were the ones missing.
 */
function tierBreakdown(kills: Readonly<Record<string, number>>, maxTier: number): string {
  const parts: string[] = [];
  for (let tier = 1; tier <= Math.max(1, maxTier); tier += 1) {
    parts.push(`T${tier} ${formatNumber(kills[String(tier)] ?? 0)}`);
  }
  return parts.join(" · ");
}

function bossName(boss: string): string {
  return `${boss.slice(0, 1).toUpperCase()}${boss.slice(1)}`;
}

/**
 * Slayers, with the kills that a level alone does not report.
 *
 * The overview used to print `Tier 7/9 · 1,234,567 xp · 4,010 kills` per boss
 * and put the per-tier split behind asking for one boss by name — so the
 * question people actually have ("have I ever done a T5?") needed a second
 * command they had no reason to know about. Every boss now carries its own
 * breakdown; five short rows of five numbers is a list, not a wall.
 */
export function renderSlayersEmbed(
  ign: string,
  result: HypixelResult<SlayersDTO>,
  only?: string,
  uuid?: string | null,
): EmbedView {
  const subject = player(ign, uuid);
  return statCard(C.noun.slayers, subject, result, (s) => {
    const wanted = only?.toLowerCase();
    const shown = wanted ? s.bosses.filter((b) => b.boss === wanted) : s.bosses;
    if (shown.length === 0) {
      return {
        tone: "NEUTRAL",
        headline: wanted ? C.noSlayerDataFor.replace("{boss}", only ?? "") : C.noSlayerData,
      };
    }
    const highest = shown.reduce((a, b) => (b.tier > a.tier ? b : a));
    return {
      tone: "SUCCESS",
      headline:
        `Total slayer xp **${formatNumber(s.totalExperience)}**` +
        ` · highest ${bossName(highest.boss)} **${highest.tier}**`,
      fields: shown.map((b) =>
        field(
          `${bossName(b.boss)}${capMarker(b.tier, b.maxTier) === "" ? "" : ` ${capMarker(b.tier, b.maxTier)}`}`,
          `Tier **${b.tier}**/${b.maxTier} · ${formatNumber(b.experience)} xp · ${formatNumber(
            totalKills(b.kills),
          )} kills\n${tierBreakdown(b.kills, b.maxTier)}`,
        ),
      ),
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
        value: `${progressLine(d.catacombsProgress)}\n${formatNumber(d.catacombsXpToNext)} XP to next level`,
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
    ...freshnessOf(profile.value),
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
  /**
   * The member’s uuid, for the head icon and the render.
   *
   * Optional because a card without a face is still worth sending, and the one
   * caller that has the uuid — `/me`, which resolved the link to get here — is
   * not the only one that may ever build this.
   */
  readonly uuid?: string | null;
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
      : null;

  const headline = input.profile.ok
    ? `**SkyBlock Level ${formatLevel(input.profile.value.data.skyblockLevel)}** · Profile **${profileLabel(
        input.profile.value.data,
      )}**`
    : renderFailure(input.profile.error.state);

  // Five one-word numbers were five inline fields. On a phone they wrapped into
  // a ragged block that spent two thirds of its height on labels, and they
  // pushed the sections that are actually about this guild below the fold. As
  // one field they read as what they are: a list.
  const hypixel = facts([
    { label: F.skillAverage, value: p === null ? null : formatLevel(p.skillAverage) },
    { label: F.catacombs, value: input.dungeons.ok ? formatLevel(input.dungeons.value.data.catacombsLevel) : null },
    { label: F.weight, value: p === null ? null : weightText(p.senitherWeight) },
    { label: F.networth, value: nw },
    { label: F.slayerXp, value: input.slayers.ok ? formatNumber(input.slayers.value.data.totalExperience) : null },
  ]);

  const standing = standingField(input.standing ?? null);

  return card({
    // The title says what the card is. Who it is about is the author row, which
    // is where identity belongs and where the head icon can sit next to it.
    title: C.memberCard,
    subject: player(ign, input.uuid ?? null),
    headline,
    fields: [
      field(F.skyblock, hypixel, true),
      standing,
      achievementField(input.achievements ?? null),
      podiumField(input.podium ?? null),
      positionsField(input.positions ?? null),
      input.record === undefined || input.record === null ? null : renderMemberRecordField(input.record),
    ],
    // The standing caveat only when standing is on the card, and only in the
    // footer — it is the one note here that does not decay, which is the whole
    // rule for what a footer may hold.
    ...(standing === null ? {} : { footer: C.standingFooter }),
    ...(input.profile.ok ? { freshness: staleness(input.profile.value) } : {}),
    tone: input.profile.ok ? "INFO" : "NEUTRAL",
  });
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

  return { name: F.events, value: [`${tally}${attended}`, ...recent].join("\n"), inline: false };
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
  // Then the sentence-cased vocabulary the event board draws from, capitalised
  // for this position. Without it the widened event catalog reached a podium
  // line as "SlayerEnderman" — the camelCase fallback below is right for a key
  // nobody has named, and wrong for the fifteen that now have names.
  const phrase = (copy.embed.metricPhrase as Readonly<Record<string, string>>)[metric];
  if (phrase !== undefined) return phrase.charAt(0).toUpperCase() + phrase.slice(1);
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

// ── Standing, as a section of the member card (COMMANDS.md §18) ────────────

/** How each XP source is named to a member — the member’s word, not the enum’s. */
const XP_SOURCE_LABELS: Readonly<Record<XpSource, string>> = copy.embed.xpSource;

/**
 * Guild standing as one field: level, progress, position, and where it came from.
 *
 * This was `/standing`, a whole card of its own. It never had a card’s worth of
 * content — four small facts and a breakdown that is usually two lines — and it
 * asked a member to run a second command to see numbers that belong beside the
 * ones `/me` was already showing them. Folded in here it costs four lines and
 * saves a round trip.
 *
 * The breakdown survives the fold intact, because it is the part that mattered:
 * it lists only sources that actually paid and always states the total they add
 * up to, so a member who disagrees with their standing can point at the line
 * they think is wrong. That is the whole reason the ledger keeps raw values.
 *
 * Sources are collapsed onto one line rather than one per line. `/standing`
 * printed them stacked because it had a card to fill; inside a card that has
 * five other sections, five stacked lines would push the record off the fold.
 */
function standingField(standing: XpStandingDTO | null): CardField | null {
  if (standing === null) return null;

  const earned = (Object.entries(standing.bySource) as Array<[XpSource, number]>)
    .filter(([, amount]) => amount !== 0)
    .sort((a, b) => b[1] - a[1])
    .map(([source, amount]) => `${XP_SOURCE_LABELS[source]} ${formatNumber(amount)}`);

  // The bar is the shared one from the card layer. There were two ten-wide bars
  // in this codebase meaning the same thing, and a member could meet both in a
  // minute; the glyphs now come from the theme.
  const ratio = standing.levelSpan <= 0 ? 0 : standing.intoLevel / standing.levelSpan;
  const toNext = Math.max(0, standing.levelSpan - standing.intoLevel);

  const lines = [
    `**Level ${String(standing.level)}** · ${formatNumber(standing.totalXp)} XP${
      standing.rank === null ? "" : ` · #${String(standing.rank)}`
    }`,
    `${progressBar(ratio)} ${formatNumber(standing.intoLevel)}/${formatNumber(
      standing.levelSpan,
    )} · ${formatNumber(toNext)} to level ${String(standing.level + 1)}`,
    inlineFacts([
      { label: F.tenure, value: standing.tenureDays === 0 ? null : `${formatNumber(standing.tenureDays)} days` },
      {
        label: F.lastEarned,
        value: standing.lastAwardAt === null ? null : describeAge(standing.lastAwardAt.toISOString()),
      },
    ]),
    // Named rather than left bare: a row of numbers with no label reads as part
    // of the progress line above it.
    earned.length === 0 ? `${F.whereFrom}: ${C.noXpYet}` : `${F.whereFrom}: ${earned.join(" · ")}`,
  ];

  return { name: F.guildStanding, value: lines.join("\n"), inline: false };
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
        : `${progressLine(a.progress)} — ${formatMetric(a.metric, a.current ?? 0)} / ${formatMetric(a.metric, a.threshold)}`,
    inline: false,
  }));

  const measured =
    data.measuredAt === null
      ? "Not measured yet — your reading appears once the next refresh covers you."
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
  // A member's own name for a save beats the date they made it: "before dungeon
  // grind" says what the number means, and 2026-08-21 does not.
  const nameOf = (p: ProgressPointDTO | undefined, fallback: string): string =>
    p === undefined ? fallback : (p.label ?? p.date.slice(0, 10));
  return {
    title: titleFor(ign, series.metric),
    description:
      series.change === null
        ? C.oneSnapshot
        : `**${series.change >= 0 ? "+" : "−"}${fmt(Math.abs(series.change))}** over ${series.rangeDays} days`,
    fields: [
      { name: nameOf(first, "start"), value: fmt(first?.value ?? null), inline: true },
      { name: nameOf(last, "now"), value: fmt(last?.value ?? null), inline: true },
      // Pace, not another total: the two dates above already say where they
      // started and finished, and what a member actually wants from a month of
      // history is the rate they can plan against.
      { name: F.pace, value: renderPace(series.metric, series.perDay), inline: true },
      // Full width, and last: three inline fields fill a row exactly, and a
      // fourth would leave the count stranded on a line of its own.
      { name: F.snapshots, value: `${series.points.length}`, inline: false },
    ],
    color: series.change !== null && series.change < 0 ? "WARNING" : "SUCCESS",
  };
}

/** `+2.4/day`, or the "not enough history" phrase when there is no rate. */
function renderPace(metric: string, perDay: number | null): string {
  if (perDay === null) return C.goalNoPace;
  const sign = perDay >= 0 ? "+" : "−";
  return C.perDay.replace("{n}", `${sign}${formatMetric(metric, Math.abs(perDay))}`);
}

/**
 * `/goal` — every target this member is chasing, and how it is going.
 *
 * One field per goal rather than one card per goal: a member has at most four
 * (one per metric, enforced by the store), and four cards to say four numbers
 * would be four times the scrolling for the same information.
 */
export function renderGoalsEmbed(ign: string, goals: readonly GoalDTO[]): EmbedView {
  if (goals.length === 0) {
    return { title: cardTitle(ign, "goals"), description: C.noGoals, color: "NEUTRAL" };
  }

  return {
    title: cardTitle(ign, "goals"),
    fields: goals.map((g) => ({
      name: metricLabel(g.metric),
      value: goalLine(g),
      inline: false,
    })),
    footer: C.goalsFooter,
    // Amber only when nothing is moving: a member with one stalled goal and
    // three healthy ones is not in a warning state.
    color: goals.every((g) => g.achievedAt === null && (g.perDay ?? 0) <= 0) ? "WARNING" : "SUCCESS",
  };
}

/**
 * The post when somebody reaches a goal they set.
 *
 * Its own card rather than a `renderMilestoneEmbed` with a different noun: a
 * milestone is something the guild recognises, a goal is something the member
 * chose, and flattening the two would put "reached 250 SkyBlock Level" beside
 * "earned the guild's Dungeon Master badge" as if they carried the same weight.
 */
export function renderGoalAchievedEmbed(ign: string, metric: string, target: number): EmbedView {
  return {
    title: C.goalAchievedTitle,
    description: C.goalAchievedBody.replace("{ign}", ign)
      .replace("{target}", formatMetric(metric, target))
      .replace("{metric}", metricLabel(metric)),
    color: "SUCCESS",
  };
}

/** One goal's line: where they are, where they're going, and when. */
function goalLine(goal: GoalDTO): string {
  const target = formatMetric(goal.metric, goal.target);
  const current = goal.current === null ? "—" : formatMetric(goal.metric, goal.current);
  const bar = goal.progress === null ? "" : `${progressLine(goal.progress)} `;
  const eta =
    goal.achievedAt !== null
      ? C.goalDone
      : goal.etaDays === null
        ? C.goalNoPace
        : C.goalEta.replace("{n}", String(goal.etaDays));

  return `${bar}${current} / ${target} — ${eta}`;
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
 * `/online` — who is in the guild right now, and how long they have been there.
 *
 * The card answers two questions with one read. "Who is on" is the roster
 * Hypixel just printed; "how long have they been on" is the bridge's own
 * accumulated view of the evening, and it is the half that turns a list of
 * names into something worth looking at — a guild where six people arrived in
 * the last ten minutes is a different room from one where six have been going
 * for four hours.
 *
 * Durations are only ever printed for members the tracker knows. A name with
 * nothing after it means the bridge did not see them arrive, not that they just
 * got here; that is why the absent case is blank rather than "0m".
 */
export function renderRosterEmbed(
  roster: GuildRosterDTO,
  playing: readonly LivePlaytimeDTO[] = [],
  now: number = Date.now(),
): EmbedView {
  const listed = roster.ranks.reduce((n, r) => n + r.members.length, 0);
  const online = roster.online ?? listed;
  const at = new Date(now);
  const sessions = new Map(playing.map((p) => [p.ign.toLowerCase(), p]));

  const headline =
    roster.total === null ? `**${online}** online` : `**${online}** of ${formatNumber(roster.total)} members online`;

  if (listed === 0) {
    return card({
      tone: "NEUTRAL",
      title: rosterTitle(roster),
      headline: online === 0 ? C.nobodyOnline : headline,
      timestamp: roster.fetchedAt,
    });
  }

  return card({
    tone: "SUCCESS",
    title: rosterTitle(roster),
    headline: `${headline}${longestRun(playing, at)}`,
    // Ranks with nobody online are dropped rather than rendered as a rank with
    // an empty list: Discord rejects an embed field with an empty value and
    // fails the *whole* message, so one quiet rank would take `/online` down
    // for the entire guild. The rank still exists; nothing is claimed about it.
    fields: roster.ranks
      .filter((rank) => rank.members.length > 0)
      .map((rank) =>
        // The rank is the heading and the members are the reading. The count
        // used to live in the field name, where Discord bolds it and it reads
        // as part of the label — and where the same number is already the sum
        // in the headline.
        field(rank.rank, truncateField(rank.members.map((ign) => withPlaytime(ign, sessions, at)).join(", "))),
      ),
    timestamp: roster.fetchedAt,
  });
}

/** `Aria (42m)` when we know, `Aria` when we do not. */
function withPlaytime(ign: string, sessions: ReadonlyMap<string, LivePlaytimeDTO>, at: Date): string {
  const session = sessions.get(ign.toLowerCase());
  return session ? `${ign} (${describePlaytime(session.startedAt, at, session.estimated)})` : ign;
}

/**
 * The longest run of the evening, appended to the headline.
 *
 * One number rather than a second field: it is the one thing a reader takes
 * from the durations at a glance, and a rank list already carries the rest.
 * Silent when nothing is being tracked, which is every deployment without a
 * bridge and the first minutes after a restart.
 */
function longestRun(playing: readonly LivePlaytimeDTO[], at: Date): string {
  let best: LivePlaytimeDTO | null = null;
  for (const session of playing) {
    if (!best || session.startedAt < best.startedAt) best = session;
  }
  if (!best) return "";
  const run = describePlaytime(best.startedAt, at, best.estimated);
  return run === "just now" ? "" : ` — ${best.ign} longest, ${run}`;
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
