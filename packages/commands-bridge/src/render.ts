/**
 * User-facing rendering. Maps typed fallback states to honest messages and
 * formats networth respecting exact-vs-estimate and staleness.
 */
import { describeAge, padInlineRow, stalenessFooter } from "@sbr/shared-types";
import type {
  AccessoryReportDTO,
  AccessorySuggestionDTO,
  AchievementsDTO,
  AdviceDTO,
  AuctionListingDTO,
  AuctionsDTO,
  BazaarQuoteDTO,
  DungeonsDTO,
  EmbedView,
  GuildRosterDTO,
  HypixelFailureState,
  HypixelResult,
  LeaderboardEntryDTO,
  LeaderboardPageDTO,
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

export function renderFailure(state: HypixelFailureState): string {
  switch (state) {
    case "NOT_LINKED":
      return "You're not linked yet — use /link <ign>.";
    case "MISSING_PROFILE":
      return "No Skyblock profile found for that player.";
    case "RATE_LIMITED":
      return "Hypixel is rate-limiting us right now — try again in a moment.";
    case "API_DISABLED":
      return "That data is turned off in the player's Hypixel API settings.";
  }
}

export function renderLinkError(error: LinkError): string {
  switch (error.kind) {
    case "IGN_NOT_FOUND":
      return "That IGN doesn't exist.";
    case "SOCIAL_UNSET":
      return "Set your Discord in-game first (Hypixel → social menu), then run /link again.";
    case "SOCIAL_MISMATCH":
      return "Your Hypixel Discord link doesn't match your Discord account.";
    case "ALREADY_OWNED":
      return "That Minecraft account is already linked to another member.";
  }
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
    title: `${ign} — networth`,
    description:
      data.total === null
        ? "Unknown — the profile's API settings hide the data this needs."
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
  return statEmbed(`${ign} — profile`, result, (p) => ({
    description: `**${profileLabel(p)}**`,
    // SkyBlock Level leads: it is the number a member quotes about themselves,
    // and the one that moves whatever they happen to be playing. Weight stays,
    // one column over, as a figure rather than as the headline.
    fields: padInlineRow([
      { name: "SkyBlock Level", value: formatLevel(p.skyblockLevel), inline: true },
      { name: "Skill average", value: formatLevel(p.skillAverage), inline: true },
      { name: "Catacombs", value: formatLevel(p.catacombsLevel), inline: true },
      { name: "Weight", value: weightText(p.senitherWeight), inline: true },
    ]),
    color: "INFO",
  }));
}

/** The profile list behind `/profile` with no arguments. */
export function renderProfileListEmbed(
  ign: string,
  result: HypixelResult<readonly ProfileSummaryDTO[]>,
): EmbedView {
  return statEmbed(`${ign} — profiles`, result, (list) => {
    if (list.length === 0) {
      return { description: "No Skyblock profiles on this account.", color: "NEUTRAL" };
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
  return statEmbed(`${ign} — skills`, result, (s) => {
    if (s.apiDisabled) {
      return {
        description: "This profile's skill API is turned off, so none of it is readable.",
        color: "NEUTRAL",
      };
    }
    const wanted = only?.toLowerCase();
    const shown = wanted ? s.skills.filter((k) => k.name.toLowerCase() === wanted) : s.skills;
    if (shown.length === 0) {
      return { description: `No skill called "${only ?? ""}".`, color: "NEUTRAL" };
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
  if (highest === 0) return "No recorded kills.";
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
  return statEmbed(`${ign} — slayers`, result, (s) => {
    const wanted = only?.toLowerCase();
    const shown = wanted ? s.bosses.filter((b) => b.boss === wanted) : s.bosses;
    if (shown.length === 0) {
      return {
        description: wanted
          ? `No ${only ?? ""} slayer data on this profile.`
          : "No slayer data on this profile.",
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
  return statEmbed(`${ign} — dungeons`, result, (d) => {
    if (!d.played) {
      return { description: "This player has never entered a dungeon.", color: "NEUTRAL" };
    }
    const fields = [
      { name: "Catacombs", value: formatLevel(d.catacombsLevel), inline: true },
      { name: "Class average", value: formatLevel(d.classAverage), inline: true },
      { name: "Selected", value: d.selectedClass ?? "—", inline: true },
      ...d.classes.map((c) => ({ name: c.name, value: `${c.level}`, inline: true })),
    ];

    // Where the next Catacombs level actually is. Shown only below the cap,
    // where "0 XP to go" would be a misleading way to say "finished".
    if (d.catacombsProgress !== null && d.catacombsXpToNext !== null) {
      fields.push({
        name: "Progress",
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
    title: `${ign} — stats`,
    description: `Profile **${profileLabel(p)}**`,
    // Padded: how many fields this card carries depends on whether standing and
    // a staff record were available, so the row can end short in three different
    // ways and none of them is a reason to leave a field stranded.
    fields: padInlineRow([
      { name: "SkyBlock Level", value: formatLevel(p.skyblockLevel), inline: true },
      { name: "Skill average", value: formatLevel(p.skillAverage), inline: true },
      {
        name: "Catacombs",
        value: formatLevel(dungeons.ok ? dungeons.value.data.catacombsLevel : null),
        inline: true,
      },
      { name: "Weight", value: weightText(p.senitherWeight), inline: true },
      { name: "Networth", value: nw, inline: true },
      {
        name: "Slayer xp",
        value: slayers.ok ? formatNumber(slayers.value.data.totalExperience) : "—",
        inline: true,
      },
      // Appended rather than interleaved: the Hypixel numbers describe an
      // account, these two describe a guild member, and keeping them at the end
      // means the card reads the same whether or not standing was available.
      ...(standing
        ? [
            {
              name: "Guild standing",
              value: `Level ${standing.level} · ${formatNumber(standing.totalXp)} XP${
                standing.rank === null ? "" : ` · #${standing.rank}`
              }`,
              inline: true,
            },
            {
              name: "Tenure",
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
  return { name: "Your record", value: lines.join("\n"), inline: false };
}

// ── Standing (COMMANDS.md §18) ──────────────────────────────────────────────

/**
 * How each XP source is named to a member. Deliberately in the member's terms
 * rather than the enum's: nobody earns "GUILD_CHAT_MESSAGE", they talk in guild
 * chat. `MANUAL` says "staff adjustment" because pretending an adjustment was
 * earned is exactly the kind of thing that makes people distrust the number.
 */
const XP_SOURCE_LABELS: Readonly<Record<XpSource, string>> = {
  GEXP: "Guild XP",
  DISCORD_MESSAGE: "Discord chat",
  GUILD_CHAT_MESSAGE: "Guild chat",
  TENURE: "Tenure",
  COMMAND_USAGE: "Command use",
  EVENT: "Events",
  MILESTONE: "Milestones",
  MANUAL: "Staff adjustment",
};

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
      ? "Nothing yet."
      : earned.map(([source, amount]) => `${XP_SOURCE_LABELS[source]} — ${formatNumber(amount)}`).join("\n");

  const bar = xpProgressBar(standing.intoLevel, standing.levelSpan);
  const toNext = Math.max(0, standing.levelSpan - standing.intoLevel);

  return {
    title: `${name} — standing`,
    description: `**Level ${standing.level}** · ${formatNumber(standing.totalXp)} XP\n${bar} ${formatNumber(
      standing.intoLevel,
    )}/${formatNumber(standing.levelSpan)} · ${formatNumber(toNext)} to level ${standing.level + 1}`,
    fields: [
      { name: "Rank", value: standing.rank === null ? "—" : `#${standing.rank}`, inline: true },
      {
        name: "Tenure",
        value: standing.tenureDays === 0 ? "—" : `${formatNumber(standing.tenureDays)} days`,
        inline: true,
      },
      {
        name: "Last earned",
        value: standing.lastAwardAt === null ? "—" : describeAge(standing.lastAwardAt.toISOString()),
        inline: true,
      },
      { name: "Where it came from", value: breakdown, inline: false },
    ],
    // Not a staleness footer: standing is recomputed on a cadence rather than
    // fetched, so what a member needs to know is that today is still counting,
    // not how old some upstream read was.
    footer: "XP is totalled a few times a day — today's activity may not be in yet.",
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
      ? "Nobody is ranked here yet."
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
    title: `${spec.label} — guild leaderboard`,
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
  const embed = statEmbed(`${ign} — accessories`, result, (r) => {
    if (r.apiDisabled) {
      return {
        description:
          "Couldn't read this profile's talisman bag — the inventory API is off, so ownership is unknown.",
        color: "NEUTRAL",
      };
    }

    const fields = [
      {
        name: "Magical power",
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
  return statEmbed(`${ign} — ${title}`, result, (a) => {
    if (a.items.length === 0) {
      return { description: "No suggestions — nothing obvious to improve.", color: "SUCCESS" };
    }
    return {
      description: a.generic
        ? "Couldn't read this profile, so this is general advice rather than advice about you."
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
 * `/milestones` — the guild's achievements and where this member stands.
 *
 * Shows the earned and the next-closest together, because the question behind
 * the command is "what have I done and what's next", and a list of past
 * achievements alone answers only half of it.
 */
export function renderAchievementsEmbed(ign: string, data: AchievementsDTO): EmbedView {
  if (!data.configured) {
    return {
      title: `${ign} — achievements`,
      // "Off", not "none": a member reading an empty list would conclude they
      // had achieved nothing, which is a different and untrue claim.
      description: "Achievements aren't switched on here.",
      color: "NEUTRAL",
    };
  }
  if (data.totalCount === 0) {
    return {
      title: `${ign} — achievements`,
      description: "This guild hasn't set up any achievements yet.",
      color: "NEUTRAL",
    };
  }

  const earned = data.earned.slice(0, 5).map((a) => ({
    name: `✅ ${a.label}`,
    value: `${formatMetric(a.metric, a.threshold)} · <t:${Math.floor(Date.parse(a.achievedAt ?? "") / 1000)}:R>${
      a.xpReward > 0 ? ` · +${formatNumber(a.xpReward)} XP` : ""
    }`,
    inline: false,
  }));

  const upcoming = data.upcoming.slice(0, 5).map((a) => ({
    name: `▫️ ${a.label}`,
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

  return {
    title: `${ign} — achievements`,
    description:
      `**${data.earnedCount}/${data.totalCount}** earned` +
      (data.xpEarned > 0 ? ` · **${formatNumber(data.xpEarned)}** guild XP from achievements` : ""),
    fields: [
      ...(earned.length > 0
        ? earned
        : [{ name: "Nothing earned yet", value: "The closest ones are below.", inline: false }]),
      ...(upcoming.length > 0
        ? [{ name: "​", value: "**Up next**", inline: false }, ...upcoming]
        : []),
    ],
    footer: measured,
    color: data.earnedCount > 0 ? "SUCCESS" : "INFO",
  };
}

export function renderProgressEmbed(ign: string, series: ProgressSeriesDTO): EmbedView {
  if (series.points.length === 0) {
    return {
      title: `${ign} — ${series.metric}`,
      description: `No snapshots in the last ${series.rangeDays} days.`,
      color: "NEUTRAL",
    };
  }
  const fmt = (v: number | null): string =>
    v === null ? "—" : series.metric === "networth" ? formatCoins(v) : formatLevel(v);

  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  return {
    title: `${ign} — ${series.metric}`,
    description:
      series.change === null
        ? "Only one reading so far — come back after the next snapshot."
        : `**${series.change >= 0 ? "+" : "−"}${fmt(Math.abs(series.change))}** over ${series.rangeDays} days`,
    fields: [
      { name: first?.date ?? "start", value: fmt(first?.value ?? null), inline: true },
      { name: last?.date ?? "now", value: fmt(last?.value ?? null), inline: true },
      { name: "Snapshots", value: `${series.points.length}`, inline: true },
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
  return statEmbed(`Auctions — ${subject}`, result, (data) => {
    if (data.listings.length === 0) {
      return { description: `No active auctions for ${subject}.`, color: "NEUTRAL" };
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
      description: online === 0 ? "Nobody is online right now." : headline,
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
  return roster.guildName ? `${roster.guildName} — online now` : "Online now";
}

/** Discord rejects an embed field value over 1024 characters outright. */
function truncateField(value: string): string {
  const LIMIT = 1024;
  if (value.length <= LIMIT) return value;
  const head = value.slice(0, LIMIT - 2);
  const seam = head.lastIndexOf(", ");
  return `${seam > LIMIT / 2 ? head.slice(0, seam) : head}…`;
}
