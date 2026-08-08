/**
 * User-facing rendering. Maps typed fallback states to honest messages and
 * formats networth respecting exact-vs-estimate and staleness.
 */
import { describeAge, stalenessFooter } from "@sbr/shared-types";
import type {
  AccessoryReportDTO,
  AccessorySuggestionDTO,
  AdviceDTO,
  AuctionsDTO,
  BazaarQuoteDTO,
  DungeonsDTO,
  EmbedView,
  GuildRosterDTO,
  HypixelFailureState,
  HypixelResult,
  LinkError,
  LowestBinDTO,
  MilestoneDTO,
  NetworthDTO,
  PriceDTO,
  ProfileSummaryDTO,
  ProgressSeriesDTO,
  SkillsDTO,
  SlayersDTO,
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
    .slice(0, 6)
    .map(([name, value]) => ({ name, value: formatCoins(value), inline: true }));

  return {
    title: `${ign} — networth`,
    description:
      data.total === null
        ? "Unknown — the profile's API settings hide the data this needs."
        : `**${formatCoins(data.total)}**${data.exact ? "" : " (estimate — some data is hidden)"}`,
    ...(fields.length > 0 ? { fields } : {}),
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
    fields: [
      { name: "Skill average", value: formatLevel(p.skillAverage), inline: true },
      { name: "Catacombs", value: formatLevel(p.catacombsLevel), inline: true },
      { name: "Weight", value: weightText(p.senitherWeight), inline: true },
    ],
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
    return {
      description: `Skill average **${formatLevel(s.average)}**`,
      fields: shown.map((k) => ({
        name: k.name,
        // A hidden skill says so rather than showing a plausible-looking 0.
        value:
          k.level === null
            ? "hidden"
            : k.xpToNext === null
              ? `${k.level} (max)`
              : `${k.level} · ${formatNumber(Math.round(k.xpToNext))} xp to go`,
        inline: true,
      })),
      color: "SUCCESS",
    };
  });
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
    return {
      description: `Total slayer xp **${formatNumber(s.totalExperience)}**`,
      fields: shown.map((b) => ({
        name: `${b.boss.slice(0, 1).toUpperCase()}${b.boss.slice(1)}`,
        value: `Tier ${b.tier}/${b.maxTier} · ${formatNumber(b.experience)} xp`,
        inline: true,
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
): EmbedView {
  if (!profile.ok) {
    return { title: ign, description: renderFailure(profile.error.state), color: "NEUTRAL" };
  }
  const p = profile.value.data;
  const nw =
    networth.ok && networth.value.data.total !== null
      ? `${formatCoins(networth.value.data.total)}${networth.value.data.exact ? "" : "+"}`
      : "—";

  return {
    title: `${ign} — stats`,
    description: `Profile **${profileLabel(p)}**`,
    fields: [
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
    ],
    footer: stalenessFooter(profile.value),
    color: "INFO",
  };
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

export function renderMilestonesEmbed(ign: string, milestones: readonly MilestoneDTO[]): EmbedView {
  if (milestones.length === 0) {
    return {
      title: `${ign} — milestones`,
      // Distinguish "nothing achieved" from "we haven't snapshotted you yet".
      description:
        "No milestones recorded yet — these appear once the daily snapshot has seen you progress.",
      color: "NEUTRAL",
    };
  }
  return {
    title: `${ign} — milestones`,
    fields: milestones.slice(0, 10).map((m) => ({
      name: `${m.metric} ${formatNumber(m.thresholdValue)}`,
      value: `${m.type} · <t:${Math.floor(Date.parse(m.achievedAt) / 1000)}:R>`,
      inline: false,
    })),
    color: "SUCCESS",
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
export function renderAuctionsEmbed(
  subject: string,
  result: HypixelResult<AuctionsDTO>,
  now: number = Date.now(),
): EmbedView {
  return statEmbed(`Auctions — ${subject}`, result, (data) => {
    if (data.listings.length === 0) {
      return { description: `No active auctions for ${subject}.`, color: "NEUTRAL" };
    }
    return {
      fields: data.listings.slice(0, 10).map((l) => {
        const ends =
          l.endsAt === null
            ? ""
            : ` • ends in ${formatDuration(Math.max(0, new Date(l.endsAt).getTime() - now))}`;
        return {
          name: l.itemName ?? "Unknown item",
          value: `${coinsOrUnknown(l.price)}${l.bin ? " (BIN)" : " (auction)"}${ends}`,
          inline: false,
        };
      }),
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
    fields: roster.ranks.map((rank) => ({
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
