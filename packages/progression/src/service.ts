/**
 * ProgressionServiceImpl — composes the Skyblock profile read with networth
 * valuation. Fallback states from the profile provider propagate unchanged, and
 * the served freshness (LIVE/STALE) is preserved through to the DTO envelope.
 */
import {
  err,
  ok,
  type AccessoryReportDTO,
  type AchievementsDTO,
  type AdviceDTO,
  type AdviceItemDTO,
  type DataEnvelope,
  type DungeonsDTO,
  type HypixelResult,
  type NetworthDTO,
  type ProfileSummaryDTO,
  type ProgressionService,
  type MilestoneDTO,
  type ProgressMetric,
  type ProgressSeriesDTO,
  type GoalDTO,
  type GoalError,
  type GoalRepository,
  type StoredGoalDTO,
  type Result,
  type SkillsDTO,
  type SlayersDTO,
  type ProgressionRepository,
  type MilestoneDefinitionReader,
  type SelectProfileError,
} from "@sbr/shared-types";
import type { NetworthService } from "@sbr/pricing";
import type { Logger } from "@sbr/observability";
import type {
  CommunityMetricsSource,
  ProfileProvider,
  SkyblockProfileData,
  UpgradePriceSource,
} from "./ports.js";
import { bestiaryMilestone, parseDungeons, parseSkills, parseSlayers, skyblockLevel } from "./skyblock/parse.js";
import { senitherWeight } from "./skyblock/weight.js";
import { buildAchievements } from "./achievements.js";
import { analyseAccessories, CATALOG_NOTE, type AccessoryReport, type CatalogEntry } from "./skyblock/accessories.js";
import {
  buildNextSteps,
  buildUpgradeAdvice,
  GENERIC_ADVICE,
  priceSuggestions,
  type Goal,
  type ProfileFacts,
  type Suggestion,
  type UpgradeFocus,
} from "./skyblock/advice.js";

export interface ProgressionServiceDeps {
  readonly profiles: ProfileProvider;
  readonly networth: NetworthService;
  /** Optional: without it, `/milestones` and `/progress` report "no history yet". */
  readonly repo?: ProgressionRepository;
  /**
   * Optional: the guild's milestone definitions. Without it `/milestones` can
   * still list what a member has earned, but has nothing to measure them
   * against, so it reports achievements as switched off.
   */
  readonly definitions?: MilestoneDefinitionReader;
  /**
   * Optional: what this platform counts about the member itself. Without it,
   * community definitions (events attended, tenure, guild XP) show as
   * unmeasured rather than as zero — see `COMMUNITY_MILESTONE_METRICS`.
   */
  readonly community?: CommunityMetricsSource;
  /** Optional: without it, `/nextupgrade` suggestions arrive without price tags. */
  readonly prices?: UpgradePriceSource;
  /**
   * Optional: goal storage. Without it `/goal` reports the feature as not
   * installed rather than failing — the same shape every other optional port
   * takes here, and the reason `setGoal` has an `UNAVAILABLE` state at all.
   */
  readonly goals?: GoalRepository;
  readonly logger: Logger;
}

/**
 * The window a goal's pace is measured over.
 *
 * A fortnight, not the thirty days `/progress` defaults to: a projection is
 * about what the member is doing *now*, and a month-long average still carries
 * the week they were on holiday. Long enough that one idle weekend does not
 * read as having stopped.
 */
const GOAL_PACE_DAYS = 14;

/**
 * Ceiling on a target, and a deliberately loose one.
 *
 * It exists to catch the paste — a networth figure with the digits of a UUID
 * behind it — not to have an opinion about ambition. Anything under this is the
 * member's business; above it, the projection arithmetic starts losing
 * precision anyway.
 */
const MAX_TARGET = Number.MAX_SAFE_INTEGER;

/**
 * Change and pace over a series, from the readings that exist.
 *
 * Pace divides by the days actually spanned rather than by the requested range,
 * which is the difference between "8 levels in 4 days" and "8 levels in 30" for
 * a member the snapshot worker only started covering last week. Both are null
 * together: two readings on the same day show change but no rate, and a
 * division by zero there would surface as `Infinity` days to a target.
 */
function paceOf(
  points: readonly { readonly date: string; readonly value: number | null }[],
): { readonly change: number | null; readonly perDay: number | null } {
  // Change needs two *readable* endpoints — a window whose ends are both
  // unknown has no measurable change, however many rows sit between them.
  const known = points.filter((p): p is { date: string; value: number } => p.value !== null);
  const first = known[0];
  const last = known[known.length - 1];
  if (known.length < 2 || !first || !last) return { change: null, perDay: null };

  const change = last.value - first.value;
  const days = (Date.parse(last.date) - Date.parse(first.date)) / (24 * 60 * 60_000);
  return { change, perDay: days > 0 ? change / days : null };
}

/** A stored goal plus what is known about it, in the shape a card reads. */
function toGoalView(row: StoredGoalDTO, current: number | null, perDay: number | null): GoalDTO {
  const start = row.startValue;
  // A bar needs both ends. No floor, no reading, or a target already below the
  // floor when it was set (a member asking to *lose* networth, which the store
  // does not forbid) all mean there is no honest fraction to draw.
  const span = start === null ? 0 : row.target - start;
  const progress =
    current === null || start === null || span <= 0
      ? null
      : Math.min(1, Math.max(0, (current - start) / span));

  const remaining = current === null ? null : row.target - current;
  const etaDays =
    remaining === null || remaining <= 0 || perDay === null || perDay <= 0
      ? null
      : Math.ceil(remaining / perDay);

  return {
    id: row.id,
    metric: row.metric,
    target: row.target,
    startValue: start,
    current,
    progress,
    perDay,
    etaDays,
    createdAt: row.createdAt,
    achievedAt: row.achievedAt,
  };
}

/**
 * How far back the achievements view reads recorded milestones. Generous
 * because the counts it reports are lifetime ones — a cap that truncated would
 * silently under-report a long-standing member's record.
 */
const ACHIEVEMENT_HISTORY_LIMIT = 500;

const FOCUSES: readonly UpgradeFocus[] = ["dps", "ehp", "farming", "mining", "dungeons", "slayer", "general"];
const GOALS: readonly Goal[] = ["weight", "networth", "dungeons", "slayer", "skills", "general"];

function asFocus(value: string): UpgradeFocus {
  const lower = value.toLowerCase();
  return FOCUSES.find((f) => f === lower) ?? "general";
}

function asGoal(value: string): Goal {
  const lower = value.toLowerCase();
  return GOALS.find((g) => g === lower) ?? "general";
}

function reEnvelope<A, B>(source: DataEnvelope<A>, data: B): DataEnvelope<B> {
  return { data, freshness: source.freshness, source: source.source, fetchedAt: source.fetchedAt };
}

export class ProgressionServiceImpl implements ProgressionService {
  private readonly profiles: ProfileProvider;
  private readonly networth: NetworthService;
  private readonly repo: ProgressionRepository | undefined;
  private readonly definitions: MilestoneDefinitionReader | undefined;
  private readonly community: CommunityMetricsSource | undefined;
  private readonly prices: UpgradePriceSource | undefined;
  private readonly goals: GoalRepository | undefined;
  private readonly log: Logger;

  constructor(deps: ProgressionServiceDeps) {
    this.profiles = deps.profiles;
    this.networth = deps.networth;
    this.repo = deps.repo;
    this.definitions = deps.definitions;
    this.community = deps.community;
    this.prices = deps.prices;
    this.goals = deps.goals;
    this.log = deps.logger.child({ service: "progression" });
  }

  /**
   * The profile a lookup should use: the one the caller named, else the member's
   * `/setprofile` choice, else whatever they have loaded in-game.
   */
  private async resolve(uuid: string, explicit?: string): Promise<HypixelResult<SkyblockProfileData>> {
    const chosen = explicit ?? (await this.repo?.getSelectedProfileId(uuid)) ?? undefined;
    return this.profiles.getSelectedProfile(uuid, chosen);
  }

  async getProfileSummary(uuid: string, profileId?: string): Promise<HypixelResult<ProfileSummaryDTO>> {
    const result = await this.resolve(uuid, profileId);
    if (!result.ok) return err(result.error);
    return ok(reEnvelope(result.value, toSummary(result.value.data)));
  }

  async listProfiles(uuid: string): Promise<HypixelResult<readonly ProfileSummaryDTO[]>> {
    const result = await this.profiles.listProfiles(uuid);
    if (!result.ok) return err(result.error);
    return ok(reEnvelope(result.value, result.value.data.map(toSummary)));
  }

  async getSkills(uuid: string, profileId?: string): Promise<HypixelResult<SkillsDTO>> {
    const result = await this.resolve(uuid, profileId);
    if (!result.ok) return err(result.error);
    return ok(reEnvelope(result.value, parseSkills(result.value.data.rawMember)));
  }

  async getSlayers(uuid: string, profileId?: string): Promise<HypixelResult<SlayersDTO>> {
    const result = await this.resolve(uuid, profileId);
    if (!result.ok) return err(result.error);
    return ok(reEnvelope(result.value, parseSlayers(result.value.data.rawMember)));
  }

  async getDungeons(uuid: string, profileId?: string): Promise<HypixelResult<DungeonsDTO>> {
    const result = await this.resolve(uuid, profileId);
    if (!result.ok) return err(result.error);
    return ok(reEnvelope(result.value, parseDungeons(result.value.data.rawMember)));
  }

  async getMilestones(uuid: string, limit = 10): Promise<Result<readonly MilestoneDTO[]>> {
    if (!this.repo) return ok([]);
    return ok(await this.repo.listMilestones(uuid, limit));
  }

  async getAchievements(uuid: string, guildId: string): Promise<Result<AchievementsDTO>> {
    // No definitions reader means the deployment has no achievements at all, and
    // the reply should say so rather than show an empty list, which reads as
    // "you have earned nothing".
    const configured = this.definitions !== undefined;
    if (!this.repo) return ok(buildAchievements([], [], null, { configured }));

    // Every recorded milestone, not a page: the totals and the earned list are
    // both over the member's whole history, and a member with more than this
    // many has out-achieved the definition set several times over.
    const [definitions, earned, snapshot, community] = await Promise.all([
      this.definitions?.list(guildId) ?? Promise.resolve([]),
      this.repo.listMilestones(uuid, ACHIEVEMENT_HISTORY_LIMIT),
      this.repo.latestSnapshot(uuid),
      // Absorbed: an unreadable community reading costs the community
      // definitions their progress bar, and costs the Hypixel ones nothing.
      this.community?.forAccount(guildId, uuid).catch(() => null) ?? Promise.resolve(null),
    ]);
    return ok(buildAchievements(definitions, earned, snapshot, { configured, community }));
  }

  async getProgress(
    uuid: string,
    metric: ProgressMetric,
    rangeDays: number,
  ): Promise<Result<ProgressSeriesDTO>> {
    const empty: ProgressSeriesDTO = { metric, rangeDays, points: [], change: null, perDay: null };
    if (!this.repo) return ok(empty);

    const since = new Date(Date.now() - rangeDays * 24 * 60 * 60_000);
    const rows = await this.repo.listSnapshots(uuid, since);
    if (rows.length === 0) return ok(empty);

    const points = rows.map((r) => ({ date: r.captureDate, value: r[metric] }));
    const { change, perDay } = paceOf(points);

    return ok({ metric, rangeDays, points, change, perDay });
  }

  async setGoal(
    guildId: string,
    uuid: string,
    metric: ProgressMetric,
    target: number,
  ): Promise<Result<GoalDTO, GoalError>> {
    if (!this.goals) return err({ kind: "UNAVAILABLE" });
    if (!Number.isFinite(target) || target <= 0 || target > MAX_TARGET) {
      return err({ kind: "BAD_TARGET" });
    }

    const current = await this.currentValue(uuid, metric);
    // Refusing a target already met is not pedantry: the bar would render full
    // on the day it was set, and the goal-checker would announce it as an
    // achievement within the hour. Both read as the platform being confused.
    if (current !== null && current >= target) return err({ kind: "ALREADY_THERE", current });

    const stored = await this.goals.setGoal({
      guildId,
      minecraftUuid: uuid,
      metric,
      target,
      // The floor the bar fills from. Null for a member with no snapshot yet:
      // their first one becomes the floor when the row is next read.
      startValue: current,
    });
    const [view] = await this.describeGoals([stored], uuid);
    return ok(view ?? toGoalView(stored, current, null));
  }

  async listGoals(guildId: string, uuid: string): Promise<Result<readonly GoalDTO[]>> {
    if (!this.goals) return ok([]);
    const rows = await this.goals.listGoals(guildId, uuid);
    if (rows.length === 0) return ok([]);
    return ok(await this.describeGoals(rows, uuid));
  }

  async clearGoal(guildId: string, uuid: string, metric: ProgressMetric): Promise<Result<boolean>> {
    if (!this.goals) return ok(false);
    return ok(await this.goals.clearGoal(guildId, uuid, metric));
  }

  /**
   * Attach "how is it going" to stored rows.
   *
   * One snapshot window is read for the whole set rather than one per goal:
   * four goals are four metrics off the same rows, and asking the database four
   * times for the same fortnight to answer one command is how a cheap card
   * becomes an expensive one.
   */
  private async describeGoals(
    rows: readonly StoredGoalDTO[],
    uuid: string,
  ): Promise<readonly GoalDTO[]> {
    if (!this.repo) return rows.map((r) => toGoalView(r, null, null));

    const since = new Date(Date.now() - GOAL_PACE_DAYS * 24 * 60 * 60_000);
    const [history, latest] = await Promise.all([
      this.repo.listSnapshots(uuid, since).catch(() => []),
      this.repo.latestSnapshot(uuid).catch(() => null),
    ]);

    return rows.map((r) => {
      const pace = paceOf(history.map((h) => ({ date: h.captureDate, value: h[r.metric] })));
      return toGoalView(r, latest?.[r.metric] ?? null, pace.perDay);
    });
  }

  /** The freshest reading of one metric, or null if nothing has been captured. */
  private async currentValue(uuid: string, metric: ProgressMetric): Promise<number | null> {
    if (!this.repo) return null;
    const latest = await this.repo.latestSnapshot(uuid).catch(() => null);
    return latest?.[metric] ?? null;
  }

  async setSelectedProfile(
    uuid: string,
    profileId: string,
  ): Promise<Result<ProfileSummaryDTO, SelectProfileError>> {
    if (!this.repo) return err({ kind: "UNAVAILABLE" });

    const all = await this.profiles.listProfiles(uuid);
    if (!all.ok) return err({ kind: "UNAVAILABLE" });

    // Accept either the id or the cute name — a member types "Mango", not a cuid.
    const wanted = profileId.toLowerCase();
    const match = all.value.data.find(
      (p) => p.profileId.toLowerCase() === wanted || p.cuteName?.toLowerCase() === wanted,
    );
    if (!match) return err({ kind: "NO_SUCH_PROFILE" });

    const summary = toSummary(match);
    await this.repo.setSelectedProfile(uuid, summary);
    return ok(summary);
  }

  async getNetworth(uuid: string, profileId?: string): Promise<HypixelResult<NetworthDTO>> {
    const result = await this.resolve(uuid, profileId);
    if (!result.ok) return err(result.error);

    const profile = result.value.data;
    const nw = await this.networth.getNetworth({
      engineInput: profile.networthEngineInput,
      readableSections: profile.readableSections,
      requiredSections: profile.requiredSections,
    });

    // NetworthService returns an honest DTO even on internal failure (total null).
    const dto = nw.ok ? nw.value : { total: null, exact: false, missing: profile.requiredSections, breakdown: {}, topItems: {} };
    if (!dto.exact) {
      this.log.debug("networth served as estimate", { uuid, missing: dto.missing });
    }
    return ok(reEnvelope(result.value, dto));
  }

  async getAccessories(uuid: string, profileId?: string): Promise<HypixelResult<AccessoryReportDTO>> {
    const result = await this.resolve(uuid, profileId);
    if (!result.ok) return err(result.error);

    const report = analyseAccessories(result.value.data.rawMember);
    const [missing, upgradeable] = await Promise.all([
      this.priceEntries(report.missing.map((e) => ({ entry: e, replaces: null }))),
      this.priceEntries(report.upgradeable.map((u) => ({ entry: u.to, replaces: u.have.name }))),
    ]);

    return ok(
      reEnvelope(result.value, {
        magicalPower: report.magicalPower,
        tuning: report.tuning,
        owned: report.owned.map((o) => ({
          id: o.id,
          name: o.name,
          rarity: o.rarity,
          magicalPower: o.magicalPower,
          recombobulated: o.recombobulated,
        })),
        missing,
        upgradeable,
        redundant: report.redundant.map((e) => ({
          id: e.id,
          name: e.name,
          rarity: e.rarity,
          magicalPower: 0,
          recombobulated: false,
        })),
        apiDisabled: report.apiDisabled,
        note: CATALOG_NOTE,
      } satisfies AccessoryReportDTO),
    );
  }

  async getUpgradeAdvice(uuid: string, focus: string, profileId?: string): Promise<HypixelResult<AdviceDTO>> {
    const result = await this.resolve(uuid, profileId);
    const resolvedFocus = asFocus(focus);
    // An unreadable profile is the documented degradation path, not a failure:
    // generic advice with `generic: true` beats an error nobody can act on.
    if (!result.ok) return ok(genericEnvelope(resolvedFocus));

    const facts = factsOf(result.value.data);
    const items = await this.price(buildUpgradeAdvice(facts, resolvedFocus));
    return ok(reEnvelope(result.value, { focus: resolvedFocus, items, generic: false }));
  }

  async getNextSteps(uuid: string, goal: string, profileId?: string): Promise<HypixelResult<AdviceDTO>> {
    const result = await this.resolve(uuid, profileId);
    const resolvedGoal = asGoal(goal);
    if (!result.ok) return ok(genericEnvelope(resolvedGoal));

    const facts = factsOf(result.value.data);
    const items = await this.price(buildNextSteps(facts, resolvedGoal));
    return ok(reEnvelope(result.value, { focus: resolvedGoal, items, generic: false }));
  }

  /** Look each suggestion's item up once; a pricing failure costs a tag, not the advice. */
  private async price(suggestions: readonly Suggestion[]): Promise<readonly AdviceItemDTO[]> {
    const ids = [...new Set(suggestions.map((s) => s.itemId).filter((id): id is string => id !== null))];
    const prices = new Map<string, number | null>();
    if (this.prices) {
      await Promise.all(
        ids.map(async (id) => {
          try {
            prices.set(id, await this.prices!.lowestBin(id));
          } catch (error) {
            this.log.debug("suggestion price lookup failed", { itemId: id, error: String(error) });
            prices.set(id, null);
          }
        }),
      );
    }
    return priceSuggestions(suggestions, prices);
  }

  private async priceEntries(
    entries: readonly { readonly entry: CatalogEntry; readonly replaces: string | null }[],
  ): Promise<AccessoryReportDTO["missing"]> {
    return Promise.all(
      entries.map(async (e) => ({
        id: e.entry.id,
        name: e.entry.name,
        rarity: e.entry.rarity,
        why: e.entry.why,
        replaces: e.replaces,
        estimatedCost: this.prices ? await this.prices.lowestBin(e.entry.id).catch(() => null) : null,
      })),
    );
  }
}

/** The degraded reply: honest generic advice, marked as such. */
function genericEnvelope(focus: string): DataEnvelope<AdviceDTO> {
  return {
    data: {
      focus,
      items: priceSuggestions(GENERIC_ADVICE, new Map()),
      generic: true,
    },
    freshness: "STALE",
    // Nothing was fetched, so CACHE is the least misleading provenance: STALE
    // is what the embed actually keys its "couldn't read your profile" note off.
    source: "CACHE",
    fetchedAt: new Date().toISOString(),
  };
}

function factsOf(profile: SkyblockProfileData): ProfileFacts {
  const skills = parseSkills(profile.rawMember);
  const slayers = parseSlayers(profile.rawMember);
  const dungeons = parseDungeons(profile.rawMember);
  const accessories: AccessoryReport = analyseAccessories(profile.rawMember);
  return {
    skills,
    slayers,
    dungeons,
    // Networth needs a priced valuation pass; the advice engine only uses it for
    // one line of flavour, which is not worth an extra round trip here.
    networth: null,
    accessories,
    senitherWeight: senitherWeight(skills, slayers, dungeons),
  };
}

function toSummary(p: SkyblockProfileData): ProfileSummaryDTO {
  const skills = parseSkills(p.rawMember);
  const slayers = parseSlayers(p.rawMember);
  const dungeons = parseDungeons(p.rawMember);
  return {
    profileId: p.profileId,
    cuteName: p.cuteName,
    gameMode: p.gameMode,
    skyblockLevel: skyblockLevel(p.rawMember),
    skillAverage: skills.average,
    catacombsLevel: dungeons.catacombsLevel,
    slayerXp: slayers.totalExperience,
    senitherWeight: senitherWeight(skills, slayers, dungeons),
    bestiaryMilestone: bestiaryMilestone(p.rawMember),
  };
}
