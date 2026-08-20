/**
 * PanelMutations — the write pipeline: authorize → rate-limit → validate → call
 * the domain service → audit. The GuildConfigService here is a recorder, because
 * what these tests assert is what reaches it (and what never does), not what it
 * then writes; that belongs to @sbr/guild-config.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_CHANNEL_SLOTS,
  err,
  hypixelFailure,
  ok,
  type CommunityService,
  type GuildConfigService,
  type IdentityService,
  type MemberRole,
  type MilestoneDefinitionDTO,
  type MilestoneDefinitionService,
  type TicketConfigService,
  type TicketSettingsDTO,
  type WordlistError,
  type WordlistRuleDTO,
  type WordlistService,
  type ModerationService,
  type Result,
  type XpService,
  type XpSourcePolicyDTO,
} from "@sbr/shared-types";
import type { AnalyticsService, CommandUsageDTO } from "@sbr/shared-types";
import { DEFAULT_POLICY, SCREENING_POLICY_KEY, serializePolicy } from "@sbr/screening";
import { ROLE_POLICY_SETTING_KEY } from "@sbr/guild-config";
import type { Logger } from "@sbr/observability";
import type { PanelSession, RoleResolver } from "./access.js";
import type { PermissionExceptionStore, RolesInsight } from "./reads.js";
import type { EventEffects, TicketEffects } from "./mutations.js";
import {
  MANUAL_JOB_COOLDOWN_MS,
  MUTATION_COOLDOWN_MS,
  PanelMutations,
  type ConfigAuditEntry,
  type HypixelGuildLookup,
  type JobTrigger,
  type MutationLimiter,
} from "./mutations.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

const roles = (map: Record<string, MemberRole>): RoleResolver => ({
  async getRole(_g, id) { return map[id] ?? "MEMBER"; },
});

const session = (over: Partial<PanelSession> = {}): PanelSession => ({
  discordId: "111",
  manageableGuildIds: ["g1"],
  csrfToken: "t",
  ...over,
});

interface Recorded {
  calls: { method: string; args: readonly unknown[] }[];
  audits: ConfigAuditEntry[];
  usage: CommandUsageDTO[];
  limited: string[];
}

/** A config service that records what it was asked to do and answers `result`. */
/**
 * The dry run's roster, and the refusal list it can clear.
 *
 * Empty by default: most of these tests are about what the mutation refuses to
 * do, and a preview over nobody still has to answer honestly rather than throw.
 */
function rolesInsightRecorder(
  recorded: Recorded,
  previewMembers?: RolesInsight["previewMembers"],
): RolesInsight {
  return {
    previewMembers:
      previewMembers ??
      (async () => ({ members: [], total: 0 })),
    async pendingDirty() { return 0; },
    async refusals() { return []; },
    async clearRefusals(guildId) { recorded.calls.push({ method: "clearRefusals", args: [guildId] }); },
  };
}

function configRecorder(
  recorded: Recorded,
  result: Result<void> = ok(undefined),
  settings: Readonly<Record<string, unknown>> = {},
): GuildConfigService {
  const record = (method: string) => async (...args: unknown[]): Promise<Result<void>> => {
    recorded.calls.push({ method, args });
    return result;
  };
  const partial: Partial<GuildConfigService> = {
    getSetting: (async (guildId: string, key: string) => {
      recorded.calls.push({ method: "getSetting", args: [guildId, key] });
      return settings[key] ?? null;
    }) as GuildConfigService["getSetting"],
    setChannel: record("setChannel") as GuildConfigService["setChannel"],
    setFeature: record("setFeature") as GuildConfigService["setFeature"],
    setBridgeSuspended: record("setBridgeSuspended") as GuildConfigService["setBridgeSuspended"],
    setRecruitment: record("setRecruitment") as GuildConfigService["setRecruitment"],
    setRoleMapping: record("setRoleMapping") as GuildConfigService["setRoleMapping"],
    setRoleBinding: record("setRoleBinding") as GuildConfigService["setRoleBinding"],
    setSetting: record("setSetting") as GuildConfigService["setSetting"],
    setHypixelGuild: record("setHypixelGuild") as GuildConfigService["setHypixelGuild"],
  };
  return partial as GuildConfigService;
}

/** The Hypixel id the lookup resolves to; distinct from any id a test types in. */
const RESOLVED_GUILD_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

/**
 * The four answers the link flow distinguishes: a hit, a definitive miss, an
 * outage that answers with a state, and an outage that throws. The last two are
 * the same event on two code paths, which is the reason both are here.
 */
type LookupOutcome = "found" | "missing" | "disabled" | "throws";

function hypixelRecorder(recorded: Recorded, outcome: LookupOutcome): HypixelGuildLookup {
  return {
    async getGuild(id, by) {
      recorded.calls.push({ method: "getGuild", args: [id, by] });
      if (outcome === "throws") {
        // Shaped like the real one: `isUpstreamUnavailable` matches on `name`.
        const error = new Error("nothing cached to fall back on");
        error.name = "HypixelUnavailableError";
        throw error;
      }
      if (outcome === "missing") return hypixelFailure("MISSING_PROFILE");
      if (outcome === "disabled") return hypixelFailure("API_DISABLED");
      return ok({
        data: { id: RESOLVED_GUILD_ID, name: "SkyBlock Royalty" },
        freshness: "LIVE",
        fetchedAt: "2026-08-07T12:00:00.000Z",
        source: "LIVE",
      });
    },
  };
}

/**
 * The three action services, recorded the same way.
 *
 * Typed as partials and cast: these tests exercise the pipeline in front of the
 * services, and stubbing every unrelated method (events, LFG, auctions) would
 * bury the two lines that matter under a page of `async () => {}`.
 */
function actionRecorders(recorded: Recorded, result: Result<unknown> = ok(undefined)) {
  const record = (method: string) => async (...args: unknown[]): Promise<Result<unknown>> => {
    recorded.calls.push({ method, args });
    return result;
  };
  const moderation = { applyAction: record("applyAction") } as unknown as ModerationService;
  const community = {
    decideApplication: record("decideApplication"),
    closeTicket: record("closeTicket"),
    setMemberRole: record("setMemberRole"),
    createEvent: record("createEvent"),
    cancelEvent: record("cancelEvent"),
    updateEvent: record("updateEvent"),
    completeEvent: record("completeEvent"),
    markAttendance: record("markAttendance"),
    // The one method here that has to answer with something rather than record:
    // every event mutation re-reads the event to check it belongs to this guild,
    // and `evt_other` is the id that does not.
    async getEvent(eventId: string) {
      recorded.calls.push({ method: "getEvent", args: [eventId] });
      if (eventId === "evt_gone") return ok(null);
      return ok({ id: eventId, guildId: eventId === "evt_other" ? "g2" : "g1" });
    },
  } as unknown as CommunityService;
  const identity = { unlink: record("unlink") } as unknown as IdentityService;
  return { moderation, community, identity };
}

/**
 * XP, recorded the same way — but note it is *not* a Result service: its
 * methods return values and throw on failure, which is exactly the difference
 * the mutation layer has to absorb before the shared pipeline sees it.
 */
function xpRecorder(recorded: Recorded, throws = false): XpService {
  const record = (method: string) => async (...args: unknown[]): Promise<unknown> => {
    recorded.calls.push({ method, args });
    if (throws) throw new Error("xp store unavailable");
    return null;
  };
  return {
    setSourcePolicy: record("setSourcePolicy"),
    adjust: record("adjust"),
  } as unknown as XpService;
}

/**
 * Milestone definitions, recorded the same way. `remove` answers `removed` so a
 * key with no stored row can be told apart from one that had one.
 */
function milestoneRecorder(recorded: Recorded, removed = true): MilestoneDefinitionService {
  return {
    async list() { return []; },
    async upsert(guildId, input) {
      recorded.calls.push({ method: "upsertMilestone", args: [guildId, input] });
      return { ...input, id: "d1", guildId, source: "GUILD" } as MilestoneDefinitionDTO;
    },
    async remove(guildId, key) {
      recorded.calls.push({ method: "removeMilestone", args: [guildId, key] });
      return removed;
    },
  };
}

/** Ticket configuration, recorded the same way as milestone definitions. */
function ticketRecorder(recorded: Recorded, removed = true): TicketConfigService {
  const settings: TicketSettingsDTO = {
    guildId: "g1",
    archiveEnabled: true,
    logChannelId: null,
    blocklistRoleIds: [],
    primaryColor: "INFO",
    successColor: "SUCCESS",
    errorColor: "DANGER",
    footer: null,
    staleAfterMinutes: null,
    autoCloseAfterMinutes: 720,
    closeButton: true,
    claimButton: true,
    workingHours: {},
    updatedAt: null,
  };
  return {
    async getSettings() { return settings; },
    async saveSettings(guildId, input) {
      recorded.calls.push({ method: "saveTicketSettings", args: [guildId, input] });
      return { ...settings, ...input, guildId, updatedAt: "2026-08-14T12:00:00.000Z" };
    },
    async listCategories() { return []; },
    async upsertCategory(guildId, input) {
      recorded.calls.push({ method: "upsertTicketCategory", args: [guildId, input] });
      return { ...input, id: "c1", guildId };
    },
    async removeCategory(guildId, key) {
      recorded.calls.push({ method: "removeTicketCategory", args: [guildId, key] });
      return removed;
    },
    async listPanels(guildId) {
      return [
        {
          id: "p1",
          guildId,
          name: "Support",
          channelId: "123456789012345678",
          messageId: null,
          title: "Need a hand?",
          description: null,
          image: null,
          thumbnail: null,
          style: "BUTTONS",
          categoryKeys: ["support"],
          updatedAt: null,
        },
        // The second panel has never been given a channel, which is what
        // `publish` has to refuse.
        {
          id: "p2",
          guildId,
          name: "Appeals",
          channelId: null,
          messageId: null,
          title: "Appeal a punishment",
          description: null,
          image: null,
          thumbnail: null,
          style: "SELECT",
          categoryKeys: ["appeal"],
          updatedAt: null,
        },
      ];
    },
    async upsertPanel(guildId, input, id) {
      recorded.calls.push({ method: "upsertTicketPanel", args: [guildId, input, id ?? null] });
      return { ...input, id: id ?? "p1", guildId, messageId: null, updatedAt: null };
    },
    async removePanel(guildId, id) {
      recorded.calls.push({ method: "removeTicketPanel", args: [guildId, id] });
      return removed;
    },
    async setPostedMessage() {},
    async listTags() { return []; },
    async upsertTag(guildId, input) {
      recorded.calls.push({ method: "upsertTicketTag", args: [guildId, input] });
      return { ...input, id: "tag1", guildId };
    },
    async removeTag(guildId, name) {
      recorded.calls.push({ method: "removeTicketTag", args: [guildId, name] });
      return removed;
    },
  };
}

/** The bot on the other end of a publish or a transcript re-send. */
function ticketEffectsRecorder(recorded: Recorded, throws = false): TicketEffects {
  return {
    async publishPanel(guildId, panelId, actorDiscordId) {
      if (throws) throw new Error("the bridge is not connected");
      recorded.calls.push({ method: "publishPanel", args: [guildId, panelId, actorDiscordId] });
    },
    async resendTranscript(guildId, ticketId, actorDiscordId) {
      if (throws) throw new Error("the bridge is not connected");
      recorded.calls.push({ method: "resendTranscript", args: [guildId, ticketId, actorDiscordId] });
    },
  };
}

/** The board publisher, recorded like the ticket one it is modelled on. */
function eventEffectsRecorder(recorded: Recorded, throws = false): EventEffects {
  return {
    async publishBoard(guildId, eventId, actorDiscordId) {
      if (throws) throw new Error("the bridge is not connected");
      recorded.calls.push({ method: "publishBoard", args: [guildId, eventId, actorDiscordId] });
    },
  };
}

/**
 * The chat filter, recorded the same way. `refuse` stands in for the service's
 * own validation — an unparseable regex or a pattern that already exists — which
 * this layer has to turn into something the form can show.
 */
function wordlistRecorder(
  recorded: Recorded,
  over: { refuse?: WordlistError; missing?: boolean } = {},
): WordlistService {
  return {
    async list() { return ok([]); },
    async add(input) {
      recorded.calls.push({ method: "addWordlistRule", args: [input] });
      if (over.refuse) return err(over.refuse);
      return ok({ ...input, id: "w1", severity: input.severity ?? 1, enabled: true } as WordlistRuleDTO);
    },
    async update(guildId, id, patch) {
      recorded.calls.push({ method: "updateWordlistRule", args: [guildId, id, patch] });
      if (over.refuse) return err(over.refuse);
      if (over.missing === true) return ok(null);
      return ok({ id, guildId, pattern: "x", matchType: "SUBSTRING", action: "BLOCK", severity: 1, enabled: true });
    },
    async remove(guildId, ref) {
      recorded.calls.push({ method: "removeWordlistRule", args: [guildId, ref] });
      return ok(over.missing === true ? null : ({ id: ref } as WordlistRuleDTO));
    },
    async test() { return ok({ text: "", matched: [], action: "ALLOW", replacement: null }); },
  };
}

/**
 * Two runnable names, so "not on the list" can be tested against a list that is
 * not empty — an empty allow-list would reject everything for the wrong reason.
 */
function jobsRecorder(recorded: Recorded, throws: boolean): JobTrigger {
  return {
    runnable: ["guild-scan", "xp-aggregate"],
    async trigger(request) {
      recorded.calls.push({ method: "triggerJob", args: [request] });
      if (throws) throw new Error("redis is down");
    },
  };
}

/** The per-subject exception store, recording rather than persisting. */
function exceptionRecorder(recorded: Recorded, removed: boolean): PermissionExceptionStore {
  return {
    async list() { return []; },
    async set(guildId, subjectType, subjectId, capability, allow) {
      recorded.calls.push({ method: "setException", args: [guildId, subjectType, subjectId, capability, allow] });
    },
    async remove(guildId, id) {
      recorded.calls.push({ method: "removeException", args: [guildId, id] });
      return removed;
    },
  };
}

/** Allows everything unless the key is in `blocked` — the real gate is Redis. */
function limiter(recorded: Recorded, blocked: readonly string[] = []): MutationLimiter {
  return {
    async consume(key) {
      recorded.limited.push(key);
      return blocked.includes(key) ? { allowed: false, retryAfterMs: 1500 } : { allowed: true };
    },
  };
}

function make(
  over: {
    roleMap?: Record<string, MemberRole>;
    result?: Result<void>;
    blocked?: readonly string[];
    /** Leave XP unwired, as a deployment that runs without it does. */
    noXp?: boolean;
    xpThrows?: boolean;
    /** Same, for a deployment without milestone tracking. */
    noMilestones?: boolean;
    /** What `remove` reports back: false is "there was no row of yours". */
    milestoneRemoved?: boolean;
    /** Same, for a deployment without ticketing. */
    noTickets?: boolean;
    ticketRemoved?: boolean;
    /** Same, for a panel process with no bot on the other end of the bus. */
    noTicketEffects?: boolean;
    /** The bot refused the publish. */
    ticketEffectsThrow?: boolean;
    /** Same, for a panel process with no bot to draw the event board. */
    noEventEffects?: boolean;
    /** The bot refused the board publish. */
    eventEffectsThrow?: boolean;
    /** Same, for a deployment without the chat filter. */
    noWordlist?: boolean;
    /** What the filter service refuses with, when it refuses. */
    wordlistRefusal?: WordlistError;
    /** The rule id names nothing in this guild. */
    wordlistMissing?: boolean;
    /** Same, for a deployment with no Hypixel client wired in. */
    noHypixel?: boolean;
    /** What the guild lookup answers with. */
    lookup?: LookupOutcome;
    /** Stored `GuildSetting` rows the mutation reads back. */
    settings?: Readonly<Record<string, unknown>>;
    /** Same, for a deployment with no worker fleet on the other end of the bus. */
    noJobs?: boolean;
    /** Redis refused the publish. */
    jobsThrow?: boolean;
    /** Same, for a deployment with no per-subject exception store. */
    noExceptions?: boolean;
    /** What `remove` reports back: false is "another admin got there first". */
    exceptionRemoved?: boolean;
    /** Same, for a deployment with no roster to preview role changes against. */
    noRolesInsight?: boolean;
    /** The roster the dry run reads, when there is one. */
    previewMembers?: RolesInsight["previewMembers"];
  } = {},
) {
  const recorded: Recorded = { calls: [], audits: [], usage: [], limited: [] };
  const analytics: AnalyticsService = {
    async capture(u) { recorded.usage.push(u); },
    async emit() {},
  };
  const mutations = new PanelMutations({
    roles: roles(over.roleMap ?? { "111": "ADMIN" }),
    config: configRecorder(recorded, over.result ?? ok(undefined), over.settings ?? {}),
    ...actionRecorders(recorded, over.result ?? ok(undefined)),
    ...(over.noXp === true ? {} : { xp: xpRecorder(recorded, over.xpThrows === true) }),
    ...(over.noMilestones === true
      ? {}
      : { milestones: milestoneRecorder(recorded, over.milestoneRemoved ?? true) }),
    ...(over.noTickets === true
      ? {}
      : { tickets: ticketRecorder(recorded, over.ticketRemoved ?? true) }),
    ...(over.noTicketEffects === true
      ? {}
      : { ticketEffects: ticketEffectsRecorder(recorded, over.ticketEffectsThrow === true) }),
    ...(over.noEventEffects === true
      ? {}
      : { eventEffects: eventEffectsRecorder(recorded, over.eventEffectsThrow === true) }),
    ...(over.noWordlist === true
      ? {}
      : {
          wordlist: wordlistRecorder(recorded, {
            ...(over.wordlistRefusal ? { refuse: over.wordlistRefusal } : {}),
            ...(over.wordlistMissing === true ? { missing: true } : {}),
          }),
        }),
    ...(over.noHypixel === true ? {} : { hypixel: hypixelRecorder(recorded, over.lookup ?? "found") }),
    ...(over.noJobs === true ? {} : { jobs: jobsRecorder(recorded, over.jobsThrow === true) }),
    ...(over.noExceptions === true
      ? {}
      : { permissionExceptions: exceptionRecorder(recorded, over.exceptionRemoved ?? true) }),
    ...(over.noRolesInsight === true
      ? {}
      : { rolesInsight: rolesInsightRecorder(recorded, over.previewMembers) }),
    limiter: limiter(recorded, over.blocked ?? []),
    audit: { async record(entry) { recorded.audits.push(entry); } },
    analytics,
    logger: silent,
    now: () => new Date("2026-08-07T12:00:00.000Z"),
  });
  return { mutations, recorded };
}

// ── the happy path ──

test("an ADMIN setting a channel reaches the config service, the audit and usage", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setChannel(session(), "g1", "bridge", "123456789012345678");

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    { method: "setChannel", args: ["g1", "bridge", "123456789012345678"] },
  ]);
  assert.deepEqual(recorded.audits, [
    {
      guildId: "g1",
      actorDiscordId: "111",
      mutation: "config.channel",
      change: { slot: "bridge", channelId: "123456789012345678" },
      at: "2026-08-07T12:00:00.000Z",
    },
  ]);
  assert.equal(recorded.usage.length, 1);
  assert.equal(recorded.usage[0]?.surface, "WEB_PANEL");
  assert.equal(recorded.usage[0]?.command, "config.channel");
  assert.equal(recorded.usage[0]?.success, true);
});

test("null clears a channel slot rather than being rejected as a missing id", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.setChannel(session(), "g1", "log", null)).ok, true);
  assert.deepEqual(recorded.calls[0]?.args, ["g1", "log", null]);
});

test("every slot the platform defines is writable, not just the five legacy columns", async () => {
  const { mutations, recorded } = make();

  for (const slot of CONFIG_CHANNEL_SLOTS) {
    const result = await mutations.setChannel(session(), "g1", slot, "123456789012345678");
    assert.equal(result.ok, true, `${slot} was refused`);
  }

  assert.deepEqual(
    recorded.calls.map((c) => c.args[1]),
    [...CONFIG_CHANNEL_SLOTS],
  );
});

// ── linking a Hypixel guild ──

test("a 24-hex id is taken as an id and stored as the one Hypixel confirms", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setHypixelGuild(session(), "g1", "BBBBBBBBBBBBBBBBBBBBBBBB");

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.note : undefined, "Linked to SkyBlock Royalty.");
  assert.deepEqual(recorded.calls, [
    { method: "getGuild", args: ["BBBBBBBBBBBBBBBBBBBBBBBB", "id"] },
    { method: "setHypixelGuild", args: ["g1", RESOLVED_GUILD_ID] },
  ]);
  assert.deepEqual(recorded.audits[0]?.change, { hypixelGuildId: RESOLVED_GUILD_ID, verified: true });
});

test("anything that isn't a 24-hex id is looked up as a name", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setHypixelGuild(session(), "g1", "  SkyBlock Royalty  ");

  assert.equal(result.ok, true);
  // Trimmed before the lookup, and the resolved id — not the typed name — is
  // what gets stored: a name is a search key, never an identifier.
  assert.deepEqual(recorded.calls, [
    { method: "getGuild", args: ["SkyBlock Royalty", "name"] },
    { method: "setHypixelGuild", args: ["g1", RESOLVED_GUILD_ID] },
  ]);
});

test("a blank field unlinks without asking Hypixel anything", async () => {
  const { mutations, recorded } = make();

  for (const blank of ["", "   ", null]) {
    const result = await mutations.setHypixelGuild(session(), "g1", blank);
    assert.equal(result.ok, true, `${JSON.stringify(blank)} should unlink`);
  }

  assert.deepEqual(
    recorded.calls,
    [1, 2, 3].map(() => ({ method: "setHypixelGuild", args: ["g1", null] })),
  );
});

test("a guild Hypixel says does not exist is refused, not stored", async () => {
  const { mutations, recorded } = make({ lookup: "missing" });

  const result = await mutations.setHypixelGuild(session(), "g1", "BBBBBBBBBBBBBBBBBBBBBBBB");

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "INVALID_INPUT");
  assert.equal(recorded.calls.some((c) => c.method === "setHypixelGuild"), false);
});

for (const lookup of ["disabled", "throws"] as const) {
  test(`an id still links when Hypixel is unreachable (${lookup}), with a note saying so`, async () => {
    // The case this fallback exists for: onboarding must not be impossible
    // because the API key is dead. The id is the admin's to be right about.
    const { mutations, recorded } = make({ lookup });

    const result = await mutations.setHypixelGuild(session(), "g1", "BBBBBBBBBBBBBBBBBBBBBBBB");

    assert.equal(result.ok, true);
    assert.match(result.ok === true ? (result.note ?? "") : "", /wasn't reachable/);
    // Lowercased on the way in, so the same guild in two cases is one row.
    assert.deepEqual(recorded.calls[1], {
      method: "setHypixelGuild",
      args: ["g1", "bbbbbbbbbbbbbbbbbbbbbbbb"],
    });
    assert.deepEqual(recorded.audits[0]?.change, {
      hypixelGuildId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      verified: false,
    });
  });

  test(`a name is refused when Hypixel is unreachable (${lookup}), because there is no id to store`, async () => {
    const { mutations, recorded } = make({ lookup });

    const result = await mutations.setHypixelGuild(session(), "g1", "SkyBlock Royalty");

    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, "SERVICE_ERROR");
    assert.match(result.error?.detail ?? "", /24-character id/);
    assert.equal(recorded.calls.some((c) => c.method === "setHypixelGuild"), false);
  });
}

test("without a Hypixel client, linking refuses but unlinking still works", async () => {
  const { mutations, recorded } = make({ noHypixel: true });

  const refused = await mutations.setHypixelGuild(session(), "g1", "BBBBBBBBBBBBBBBBBBBBBBBB");
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.kind, "SERVICE_ERROR");

  // Unlinking needs nobody's confirmation, so it is not held hostage to a
  // dependency the write itself never touches.
  assert.equal((await mutations.setHypixelGuild(session(), "g1", "")).ok, true);
  assert.deepEqual(recorded.calls, [{ method: "setHypixelGuild", args: ["g1", null] }]);
});

test("an OFFICER cannot repoint the guild", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const result = await mutations.setHypixelGuild(session(), "g1", "BBBBBBBBBBBBBBBBBBBBBBBB");

  assert.equal(result.ok, false);
  assert.equal(result.access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

test("a setting is written under its key, and the audit records the key rather than the payload", async () => {
  const { mutations, recorded } = make();
  const value = { title: "Open a ticket", body: "Tell us what you need." };

  const result = await mutations.setSetting(session(), "g1", "tickets.panel", value);

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [{ method: "setSetting", args: ["g1", "tickets.panel", value] }]);
  assert.deepEqual(recorded.audits[0]?.change, { key: "tickets.panel", bytes: JSON.stringify(value).length });
});

test("null clears a setting; only an absent value is refused", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.setSetting(session(), "g1", "tickets.panel", null)).ok, true);
  assert.deepEqual(recorded.calls[0]?.args, ["g1", "tickets.panel", null]);

  const missing = await mutations.setSetting(session(), "g1", "tickets.panel", undefined);
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.kind, "INVALID_INPUT");
});

// ── the two gates ──

test("an unauthenticated write is denied without touching the config service", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setFeature(null, "g1", "lfg", true);

  assert.equal(result.ok, false);
  assert.equal(result.access.allowed, false);
  if (!result.access.allowed) assert.equal(result.access.reason, "NOT_AUTHENTICATED");
  assert.deepEqual(recorded.calls, []);
});

test("a guild outside the manageable set is denied even for an OWNER", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OWNER" } });

  const result = await mutations.setFeature(session({ manageableGuildIds: ["other"] }), "g1", "lfg", true);

  assert.equal(result.access.allowed, false);
  if (!result.access.allowed) assert.equal(result.access.reason, "NOT_MANAGEABLE");
  assert.deepEqual(recorded.calls, []);
});

test("config writes require ADMIN — an OFFICER is refused", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const result = await mutations.setFeature(session(), "g1", "lfg", true);

  assert.equal(result.access.allowed, false);
  if (!result.access.allowed) assert.equal(result.access.reason, "INSUFFICIENT_ROLE");
  assert.deepEqual(recorded.calls, []);
});

/** WEB_PANEL.md §2 puts bridge control at Officer, below the config pages. */
test("bridge suspend sits at OFFICER, not ADMIN", async () => {
  const officer = make({ roleMap: { "111": "OFFICER" } });
  assert.equal((await officer.mutations.setBridgeSuspended(session(), "g1", true)).ok, true);
  assert.deepEqual(officer.recorded.calls[0]?.args, ["g1", true]);

  const mod = make({ roleMap: { "111": "MODERATOR" } });
  const denied = await mod.mutations.setBridgeSuspended(session(), "g1", true);
  assert.equal(denied.access.allowed, false);
  assert.deepEqual(mod.recorded.calls, []);
});

// ── rate limiting ──

test("the limiter is keyed per user and mutation, and a block short-circuits the write", async () => {
  const { mutations, recorded } = make({ blocked: ["cd:web:config.feature:111"] });

  const result = await mutations.setFeature(session(), "g1", "lfg", true);

  assert.equal(result.ok, false);
  if (result.error) {
    assert.equal(result.error.kind, "RATE_LIMITED");
    assert.equal(result.error.retryAfterMs, 1500);
  }
  assert.deepEqual(recorded.limited, ["cd:web:config.feature:111"]);
  assert.deepEqual(recorded.calls, []);
  // A refused write is still usage: a burst of them is the pattern worth seeing.
  assert.equal(recorded.usage[0]?.success, false);
});

test("a different mutation by the same user is limited separately", async () => {
  const { mutations, recorded } = make({ blocked: ["cd:web:config.feature:111"] });

  assert.equal((await mutations.setBridgeSuspended(session(), "g1", false)).ok, true);
  assert.deepEqual(recorded.limited, ["cd:web:bridge.suspend:111"]);
});

test("the cooldown is short enough to be invisible to a human editing settings", () => {
  assert.ok(MUTATION_COOLDOWN_MS <= 5_000);
});

// ── validation ──

test("junk input is refused before the config service or the audit sees it", async () => {
  const { mutations, recorded } = make();

  const cases = [
    await mutations.setChannel(session(), "g1", "nowhere", "123456789012345678"),
    await mutations.setChannel(session(), "g1", "bridge", "not-a-snowflake"),
    await mutations.setRoleMapping(session(), "g1", "SUPREME", null),
    await mutations.setFeature(session(), "g1", "Feature With Spaces", true),
    await mutations.setFeature(session(), "g1", "lfg", "yes"),
    await mutations.setBridgeSuspended(session(), "g1", "true"),
    await mutations.setRecruitment(session(), "g1", { open: "yes" }),
    await mutations.setSetting(session(), "g1", "Tickets Panel", {}),
    await mutations.setSetting(session(), "g1", "tickets..panel", {}),
    // A member roster's worth of JSON — a setting is a template, not a table.
    await mutations.setSetting(session(), "g1", "tickets.panel", { blob: "x".repeat(70_000) }),
  ];

  for (const [i, result] of cases.entries()) {
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

/**
 * Recruitment is one switch now. The tri-state weight and networth bars this
 * test used to guard are no longer requirements, so what matters is that a
 * threshold arriving from a panel tab opened before the deploy is dropped
 * rather than forwarded into the config write.
 */
test("recruitment sends the switch alone, ignoring a retired threshold", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.setRecruitment(session(), "g1", { open: true })).ok, true);
  assert.deepEqual(recorded.calls[0]?.args, ["g1", { open: true }]);

  const stale = make();
  await stale.mutations.setRecruitment(session(), "g1", { open: false, minWeight: 1_200, minNetworth: 5 });
  assert.deepEqual(stale.recorded.calls[0]?.args, ["g1", { open: false }]);
});

// ── moderation, recruitment, members ──

test("a moderator can act, and the action is attributed to the session, not the body", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "MODERATOR" } });

  const result = await mutations.applyModeration(session(), "g1", {
    type: "MUTE",
    targetDiscordId: "222222222222222222",
    // A caller-supplied actor must be ignored; the audit trail is only worth
    // anything if the name on it is the authenticated one.
    actorDiscordId: "999999999999999999",
    reason: "spam",
    durationSeconds: 3600,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "applyAction",
      args: [
        {
          guildId: "g1",
          type: "MUTE",
          actorDiscordId: "111",
          targetDiscordId: "222222222222222222",
          reason: "spam",
          durationSeconds: 3600,
        },
      ],
    },
  ]);
});

test("moderation input is checked before the service sees it", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "MODERATOR" } });
  const target = "222222222222222222";

  const cases = [
    await mutations.applyModeration(session(), "g1", { type: "ROLE_CHANGE", targetDiscordId: target, reason: "x" }),
    await mutations.applyModeration(session(), "g1", { type: "WARN", targetDiscordId: "nope", reason: "x" }),
    await mutations.applyModeration(session(), "g1", { type: "WARN", targetDiscordId: target, reason: "   " }),
    await mutations.applyModeration(session(), "g1", { type: "WARN", targetDiscordId: target, reason: "x".repeat(501) }),
    // A duration on an untimed action is a misunderstanding worth surfacing,
    // not something to silently drop.
    await mutations.applyModeration(session(), "g1", { type: "WARN", targetDiscordId: target, reason: "x", durationSeconds: 60 }),
    await mutations.applyModeration(session(), "g1", { type: "MUTE", targetDiscordId: target, reason: "x", durationSeconds: 0 }),
    await mutations.applyModeration(session(), "g1", { type: "MUTE", targetDiscordId: target, reason: "x", durationSeconds: 60_000_000_000 }),
  ];

  for (const [i, result] of cases.entries()) {
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls, []);
});

test("a rejection must carry a reason; an acceptance need not", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const bare = await mutations.decideApplication(session(), "g1", "app1", false, "");
  assert.equal(bare.error?.kind, "INVALID_INPUT");

  assert.equal((await mutations.decideApplication(session(), "g1", "app1", true, null)).ok, true);
  assert.deepEqual(recorded.calls[0]?.args, [
    { applicationId: "app1", reviewerDiscordId: "111", accept: true, reason: null },
  ]);
});

test("application decisions are Officer work, ticket closes are Staff work", async () => {
  const mod = make({ roleMap: { "111": "MODERATOR" } });
  assert.equal((await mod.mutations.decideApplication(session(), "g1", "app1", true, null)).access.allowed, false);
  assert.equal((await mod.mutations.closeTicket(session(), "g1", "t1", "handled")).ok, true);
});

test("role assignment is Admin-tier, refuses OWNER, and refuses self", async () => {
  const officer = make({ roleMap: { "111": "OFFICER" } });
  const denied = await officer.mutations.setMemberRole(session(), "g1", "222222222222222222", "MODERATOR");
  assert.equal(denied.access.allowed, false);

  const { mutations, recorded } = make();
  assert.equal(
    (await mutations.setMemberRole(session(), "g1", "222222222222222222", "OWNER")).error?.kind,
    "INVALID_INPUT",
  );
  // The session's own id — an admin demoting themselves out of this page.
  assert.equal((await mutations.setMemberRole(session(), "g1", "111", "MEMBER")).error?.kind, "INVALID_INPUT");
  assert.deepEqual(recorded.calls, []);

  assert.equal((await mutations.setMemberRole(session(), "g1", "222222222222222222", "ADMIN")).ok, true);
});

test("unlink names the account explicitly rather than guessing a primary", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });
  const uuid = "b876ec32-e396-476b-a115-8438d83c67d4";

  assert.equal((await mutations.unlinkMember(session(), "g1", "222222222222222222", "")).error?.kind, "INVALID_INPUT");
  assert.equal((await mutations.unlinkMember(session(), "g1", "222222222222222222", uuid)).ok, true);
  assert.deepEqual(recorded.calls[0], { method: "unlink", args: ["222222222222222222", uuid] });
});

// ── events ──

/**
 * The host is what `cancelEvent` later checks against, so it has to come from
 * the session: a body-supplied host would create events whose named host cannot
 * call them off, and whose real creator is nowhere on the record.
 */
test("an officer schedules an event hosted by themselves, not by the body", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const result = await mutations.createEvent(session(), "g1", {
    title: "  F7 carry night  ",
    type: "DUNGEON",
    startsAt: "2026-09-01T18:00:00.000Z",
    capacity: 5,
    description: "  bring pots  ",
    hostDiscordId: "999999999999999999",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "createEvent",
      args: [
        {
          guildId: "g1",
          title: "F7 carry night",
          startsAt: "2026-09-01T18:00:00.000Z",
          type: "DUNGEON",
          hostDiscordId: "111",
          description: "bring pots",
          capacity: 5,
        },
      ],
    },
  ]);
});

test("an event needs a title, a known type and a readable start time", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });
  const base = { title: "Run", type: "DUNGEON", startsAt: "2026-09-01T18:00:00.000Z" };

  const bad = async (over: Record<string, unknown>): Promise<string | undefined> =>
    (await mutations.createEvent(session(), "g1", { ...base, ...over })).error?.kind;

  assert.equal(await bad({ title: "   " }), "INVALID_INPUT");
  assert.equal(await bad({ type: "RAID" }), "INVALID_INPUT");
  assert.equal(await bad({ startsAt: "next tuesday" }), "INVALID_INPUT");
  assert.equal(await bad({ capacity: 0 }), "INVALID_INPUT");
  assert.equal(await bad({ capacity: 2.5 }), "INVALID_INPUT");
  // Nothing that fails validation may reach the service or the audit trail.
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

/** Blank optionals are null, not empty strings the database has to interpret. */
test("an event with no capacity or description sends nulls", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal(
    (await mutations.createEvent(session(), "g1", {
      title: "Meeting",
      type: "MEETING",
      startsAt: "2026-09-01T18:00:00.000Z",
    })).ok,
    true,
  );
  assert.deepEqual(recorded.calls[0]?.args, [
    {
      guildId: "g1",
      title: "Meeting",
      startsAt: "2026-09-01T18:00:00.000Z",
      type: "MEETING",
      hostDiscordId: "111",
      description: null,
      capacity: null,
    },
  ]);
});

test("cancelling passes the actor through, so the host check has something to compare", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.cancelEvent(session(), "g1", "not an id!")).error?.kind, "INVALID_INPUT");
  assert.equal((await mutations.cancelEvent(session(), "g1", "evt_1")).ok, true);
  assert.deepEqual(recorded.calls[0], { method: "cancelEvent", args: ["evt_1", "111"] });
});

/**
 * The panel edits on behalf of the guild, not of the host: reaching this
 * mutation already required the Officer tier, and an officer who cannot fix a
 * colleague's typo has to cancel and re-create the event to do it.
 */
test("an edit is sent as staff, with only the fields the form supplied", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const result = await mutations.updateEvent(session(), "g1", {
    eventId: "evt_1",
    title: "  F7 carry night  ",
    trackedMetrics: ["networth"],
    pollIntervalMinutes: 15,
    tracksProgression: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls[1], {
    method: "updateEvent",
    args: [
      {
        eventId: "evt_1",
        actorDiscordId: "111",
        isStaff: true,
        title: "F7 carry night",
        trackedMetrics: ["networth"],
        pollIntervalMinutes: 15,
        tracksProgression: true,
      },
    ],
  });
  // How the write was authorised is not what changed, and the trail records the
  // actor of its own accord.
  const change = recorded.audits[0]?.change as Record<string, unknown> | undefined;
  assert.equal(change?.["actorDiscordId"], undefined);
  assert.equal(change?.["isStaff"], undefined);
  assert.equal(change?.["title"], "F7 carry night");
});

test("an edit is refused a metric nothing captures, and a description nobody could read", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const bad = async (over: Record<string, unknown>): Promise<string | undefined> =>
    (await mutations.updateEvent(session(), "g1", { eventId: "evt_1", ...over })).error?.kind;

  assert.equal(await bad({ trackedMetrics: ["dungeonSecrets"] }), "INVALID_INPUT");
  assert.equal(await bad({ trackedMetrics: "networth" }), "INVALID_INPUT");
  assert.equal(await bad({ title: "   " }), "INVALID_INPUT");
  assert.equal(await bad({ startsAt: "next tuesday" }), "INVALID_INPUT");
  assert.equal(await bad({ capacity: 0 }), "INVALID_INPUT");
  assert.equal(await bad({ pollIntervalMinutes: 12.5 }), "INVALID_INPUT");
  assert.equal(await bad({ tracksProgression: "yes" }), "INVALID_INPUT");
  assert.deepEqual(recorded.calls.filter((c) => c.method === "updateEvent"), []);
});

/**
 * The service knows about events, not about which server is asking, so pasting
 * another guild's event id into this guild's page has to fail here or nowhere.
 */
test("an event belonging to another guild is not editable from this one", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.updateEvent(session(), "g1", { eventId: "evt_other", title: "x" })).error?.kind, "INVALID_INPUT");
  assert.equal((await mutations.completeEvent(session(), "g1", "evt_other")).error?.kind, "INVALID_INPUT");
  assert.equal((await mutations.publishEventBoard(session(), "g1", "evt_other")).error?.kind, "INVALID_INPUT");
  assert.equal(
    (await mutations.markAttendance(session(), "g1", { eventId: "evt_other", discordIds: [] })).error?.kind,
    "INVALID_INPUT",
  );
  assert.deepEqual(recorded.calls.filter((c) => c.method !== "getEvent"), []);
});

test("an event id naming nothing is refused rather than written to", async () => {
  const { mutations } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.updateEvent(session(), "g1", { eventId: "not an id!" })).error?.kind, "INVALID_INPUT");
  assert.equal((await mutations.updateEvent(session(), "g1", { eventId: "evt_gone" })).error?.kind, "INVALID_INPUT");
});

test("finishing an event is staff work too, and names the actor", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.completeEvent(session(), "g1", "evt_1")).ok, true);
  assert.deepEqual(recorded.calls[1], { method: "completeEvent", args: ["evt_1", "111", true] });
});

test("publishing the board hands the bot the event and the actor", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.publishEventBoard(session(), "g1", "evt_1")).ok, true);
  assert.deepEqual(recorded.calls[1], { method: "publishBoard", args: ["g1", "evt_1", "111"] });
});

/** A panel with no bot behind it says so, rather than reporting a phantom post. */
test("publishing with no bot connected is unavailable, not a success", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" }, noEventEffects: true });

  const result = await mutations.publishEventBoard(session(), "g1", "evt_1");
  assert.equal(result.error?.kind, "SERVICE_ERROR");
  assert.match(String(result.error?.detail), /No bot is connected/);
  assert.deepEqual(recorded.calls, []);
});

test("a bot that refuses the board reports the refusal", async () => {
  const { mutations } = make({ roleMap: { "111": "OFFICER" }, eventEffectsThrow: true });

  const result = await mutations.publishEventBoard(session(), "g1", "evt_1");
  assert.equal(result.error?.kind, "SERVICE_ERROR");
});

test("marking turnout passes the ticked ids as staff work", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const result = await mutations.markAttendance(session(), "g1", {
    eventId: "evt_1",
    discordIds: ["222222222222222222", "333333333333333333"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls[1], {
    method: "markAttendance",
    args: [
      {
        eventId: "evt_1",
        actorDiscordId: "111",
        isStaff: true,
        discordIds: ["222222222222222222", "333333333333333333"],
      },
    ],
  });
});

/**
 * The ids come from a page the operator can edit, so a body naming something
 * that is not a Discord id must not reach a table keyed by Discord ids.
 */
test("attendance refuses a body that is not a list of Discord ids", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const cases: readonly unknown[] = [
    "not an object",
    { eventId: "evt_1" },
    { eventId: "evt_1", discordIds: "222222222222222222" },
    { eventId: "evt_1", discordIds: [222222222222222222] },
    { eventId: "evt_1", discordIds: ["nope"] },
    { eventId: "not an id!", discordIds: [] },
  ];
  for (const body of cases) {
    assert.equal((await mutations.markAttendance(session(), "g1", body)).error?.kind, "INVALID_INPUT", String(body));
  }
  assert.deepEqual(recorded.calls.filter((c) => c.method === "markAttendance"), []);
});

test("editing, finishing and publishing are all Officer work", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "MODERATOR" } });

  const edited = await mutations.updateEvent(session(), "g1", { eventId: "evt_1", title: "x" });
  const done = await mutations.completeEvent(session(), "g1", "evt_1");
  const published = await mutations.publishEventBoard(session(), "g1", "evt_1");
  const marked = await mutations.markAttendance(session(), "g1", { eventId: "evt_1", discordIds: [] });

  assert.equal(edited.access.allowed, false);
  assert.equal(done.access.allowed, false);
  assert.equal(published.access.allowed, false);
  assert.equal(marked.access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

test("events are Officer work — a moderator is refused both halves", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "MODERATOR" } });

  const created = await mutations.createEvent(session(), "g1", {
    title: "Run",
    type: "DUNGEON",
    startsAt: "2026-09-01T18:00:00.000Z",
  });
  const cancelled = await mutations.cancelEvent(session(), "g1", "evt_1");

  assert.equal(created.access.allowed, false);
  assert.equal(cancelled.access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── domain refusal ──

test("a refusal from the config service surfaces as SERVICE_ERROR and writes no audit", async () => {
  const { mutations, recorded } = make({ result: err({ kind: "NOT_CONFIGURED" }) as Result<void> });

  const result = await mutations.setFeature(session(), "g1", "lfg", true);

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "SERVICE_ERROR");
  assert.equal(result.error?.detail, "NOT_CONFIGURED");
  assert.deepEqual(recorded.audits, []);
  assert.equal(recorded.usage[0]?.success, false);
});

// ── screening policy ──
//
// The one mutation whose contents decide whether a stranger is admitted with
// nobody looking, so these tests are mostly about the ways a policy could be
// *quietly wrong*: a mistyped field that reads back as "no requirement", a coin
// threshold rounded off by a double, an auto-accept switch left on with
// screening disabled. Each of those would save successfully and then not do
// what the admin believed they had set.

/** A complete, valid payload — the shape the settings form sends. */
function policyBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...serializePolicy(DEFAULT_POLICY), ...over };
}

test("a complete policy is stored under the screening key", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setScreeningPolicy(session(), "g1", policyBody({ reviewAtRisk: 30 }));

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "setSetting",
      args: ["g1", SCREENING_POLICY_KEY, { ...serializePolicy(DEFAULT_POLICY), reviewAtRisk: 30 }],
    },
  ]);
});

test("a genuinely unknown screening field is refused rather than ignored", async () => {
  // The whole point of the strict write surface: a mistyped switch accepted
  // here would read back as its default, and nothing on the page would tell the
  // admin that apart from a working setting.
  const { mutations, recorded } = make();

  const result = await mutations.setScreeningPolicy(session(), "g1", policyBody({ denyOnScamer: true }));

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "INVALID_INPUT");
  assert.match(result.error?.detail ?? "", /denyOnScamer/);
  assert.deepEqual(recorded.calls, [], "nothing may be written when part of the payload is rejected");
});

test("a retired stat bar is accepted and dropped, not refused", async () => {
  // The other half of that rule. A panel tab opened before the bars were
  // removed still posts them; answering "unknown field: minCatacombs" would
  // read as a bug rather than as a setting that no longer exists — so the
  // field is discarded and the rest of the policy saves.
  const { mutations, recorded } = make();

  const result = await mutations.setScreeningPolicy(
    session(),
    "g1",
    policyBody({ minCatacombs: 40, minNetworth: "10000000000" }),
  );

  assert.equal(result.ok, true);
  const stored = recorded.calls[0]?.args[2] as Record<string, unknown>;
  assert.equal("minCatacombs" in stored, false);
  assert.equal("minNetworth" in stored, false);
});

test("auto-accept cannot be left on with screening disabled", async () => {
  // Otherwise the policy reads as "admit everyone without checking", which is
  // the one configuration no admin means to save.
  const { mutations } = make();

  const result = await mutations.setScreeningPolicy(
    session(),
    "g1",
    policyBody({ enabled: false, autoAccept: true }),
  );

  assert.equal(result.ok, false);
  assert.match(result.error?.detail ?? "", /autoAccept requires enabled/);
});

test("screening off with auto-accept off is a legitimate policy", async () => {
  const { mutations } = make();

  const result = await mutations.setScreeningPolicy(
    session(),
    "g1",
    policyBody({ enabled: false, autoAccept: false }),
  );

  assert.equal(result.ok, true);
});

test("a risk threshold outside the score's range is refused", async () => {
  const { mutations } = make();

  for (const bad of [-1, 101, 12.5, "50", null]) {
    const result = await mutations.setScreeningPolicy(session(), "g1", policyBody({ reviewAtRisk: bad }));
    assert.equal(result.ok, false, String(bad));
  }
});

test("a missing screening flag is refused rather than defaulted", async () => {
  // The form sends the whole policy every time. Quietly filling an absent field
  // from the defaults would turn a partial write into a silent rollback of
  // somebody else's edit.
  const { mutations } = make();
  const body = policyBody();
  delete body["denyOnScammer"];

  const result = await mutations.setScreeningPolicy(session(), "g1", body);

  assert.equal(result.ok, false);
  assert.match(result.error?.detail ?? "", /denyOnScammer/);
});

test("the screening audit records the policy in full", async () => {
  // Unlike config.setting, which logs only the key: a policy is numbers and
  // switches with nobody's words in it, and "who lowered the bar, and to what"
  // is the question this audit exists to answer.
  const { mutations, recorded } = make();

  await mutations.setScreeningPolicy(session(), "g1", policyBody({ autoAccept: true, reviewAtRisk: 35 }));

  assert.equal(recorded.audits.length, 1);
  assert.equal(recorded.audits[0]?.mutation, "config.screening");
  assert.equal(recorded.audits[0]?.actorDiscordId, "111");
  assert.equal(recorded.audits[0]?.change["autoAccept"], true);
  assert.equal(recorded.audits[0]?.change["reviewAtRisk"], 35);
});

test("an officer cannot change the entry bar", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const result = await mutations.setScreeningPolicy(session(), "g1", policyBody());

  assert.equal(result.access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── xp ──

const sourceBody = (over: Partial<XpSourcePolicyDTO> = {}): Record<string, unknown> => ({
  source: "DISCORD_MESSAGE",
  enabled: true,
  weight: 1.5,
  dailyCap: 200,
  cooldownSec: 60,
  minLength: 8,
  ...over,
});

test("a source policy reaches the XP service whole, and the audit records it in full", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setXpSource(session(), "g1", sourceBody());

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "setSourcePolicy",
      args: [
        "g1",
        { source: "DISCORD_MESSAGE", enabled: true, weight: 1.5, dailyCap: 200, cooldownSec: 60, minLength: 8 },
      ],
    },
  ]);
  assert.equal(recorded.audits[0]?.mutation, "xp.source");
  assert.equal(recorded.audits[0]?.change["weight"], 1.5);
});

test("null is an uncapped source, not a missing field", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.setXpSource(session(), "g1", sourceBody({ dailyCap: null }))).ok, true);
  assert.equal((recorded.calls[0]?.args[1] as XpSourcePolicyDTO).dailyCap, null);
});

test("a fractional weight is allowed but a fractional cooldown is not", async () => {
  const { mutations } = make();

  assert.equal((await mutations.setXpSource(session(), "g1", sourceBody({ weight: 0.01 }))).ok, true);
  const bad = await mutations.setXpSource(session(), "g1", sourceBody({ cooldownSec: 1.5 }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.kind, "INVALID_INPUT");
});

test("an out-of-range weight is refused before it reaches the service", async () => {
  // The realistic accident: a cap typed into the weight box. Ten thousand XP
  // per message would put one member permanently at the top of a ladder nobody
  // else could catch, and no later config change takes it back.
  const { mutations, recorded } = make();

  const result = await mutations.setXpSource(session(), "g1", sourceBody({ weight: 10_000 }));

  assert.equal(result.ok, false);
  assert.deepEqual(recorded.calls, []);
});

test("an unknown source name is refused rather than stored as a row nothing reads", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setXpSource(session(), "g1", sourceBody({ source: "VOICE" as never }));

  assert.equal(result.ok, false);
  assert.deepEqual(recorded.calls, []);
});

test("an adjustment carries the actor, and its reason reaches the ledger", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.adjustXp(session(), "g1", {
    discordId: "222222222222222222",
    amount: -250,
    reason: "  duplicate event payout  ",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    { method: "adjust", args: ["g1", "222222222222222222", -250, "duplicate event payout", "111"] },
  ]);
  assert.equal(recorded.audits[0]?.mutation, "xp.adjust");
  assert.equal(recorded.audits[0]?.change["amount"], -250);
});

test("an adjustment of zero, or without a reason, writes nothing", async () => {
  const { mutations, recorded } = make();
  const target = "222222222222222222";

  const zero = await mutations.adjustXp(session(), "g1", { discordId: target, amount: 0, reason: "x" });
  const unreasoned = await mutations.adjustXp(session(), "g1", { discordId: target, amount: 10, reason: "   " });

  assert.equal(zero.ok, false);
  assert.equal(unreasoned.ok, false);
  assert.deepEqual(recorded.calls, []);
});

test("a throwing XP service is reported as a service error, not an unhandled rejection", async () => {
  // XpService is not a Result service — it throws. If this layer let that
  // escape, the panel's write endpoint would answer 500 with a stack trace
  // where every other refusal answers with a sentence.
  const { mutations, recorded } = make({ xpThrows: true });

  const result = await mutations.setXpSource(session(), "g1", sourceBody());

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "SERVICE_ERROR");
  assert.deepEqual(recorded.audits, []);
});

test("with XP unwired, both writes refuse instead of crashing the request", async () => {
  const { mutations, recorded } = make({ noXp: true });

  const source = await mutations.setXpSource(session(), "g1", sourceBody());
  const adjust = await mutations.adjustXp(session(), "g1", {
    discordId: "222222222222222222", amount: 5, reason: "test",
  });

  assert.equal(source.ok, false);
  assert.equal(source.error?.kind, "SERVICE_ERROR");
  assert.equal(adjust.ok, false);
  assert.deepEqual(recorded.audits, []);
});

test("an officer can neither reweight XP nor adjust a balance", async () => {
  // Both are ADMIN because the page is: XP weights decide what the whole
  // guild's standing means, and an adjustment is the one award no counter can
  // explain afterwards.
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const source = await mutations.setXpSource(session(), "g1", sourceBody());
  const adjust = await mutations.adjustXp(session(), "g1", {
    discordId: "222222222222222222", amount: 5, reason: "test",
  });

  assert.equal(source.access.allowed, false);
  assert.equal(adjust.access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── milestones ──

const milestoneBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: "networth:1b",
  label: "1b networth",
  description: null,
  type: "NETWORTH_THRESHOLD",
  metric: "networth",
  threshold: 1_000_000_000,
  xpReward: 500,
  announce: true,
  enabled: true,
  ...over,
});

test("a definition reaches the milestone service whole, and the audit records it in full", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.upsertMilestone(session(), "g1", milestoneBody());

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "upsertMilestone",
      args: [
        "g1",
        {
          key: "networth:1b",
          label: "1b networth",
          description: null,
          type: "NETWORTH_THRESHOLD",
          metric: "networth",
          threshold: 1_000_000_000,
          xpReward: 500,
          announce: true,
          enabled: true,
        },
      ],
    },
  ]);
  assert.equal(recorded.audits[0]?.mutation, "milestone.upsert");
  assert.deepEqual(recorded.audits[0]?.change, {
    key: "networth:1b",
    label: "1b networth",
    description: null,
    type: "NETWORTH_THRESHOLD",
    metric: "networth",
    threshold: 1_000_000_000,
    xpReward: 500,
    announce: true,
    enabled: true,
  });
});

test("a definition that could never fire is refused before it reaches the store", async () => {
  const { mutations, recorded } = make();

  const cases: Record<string, unknown>[] = [
    { key: "Networth 1B" },              // keys are lowercase and punctuated, not prose
    { key: "" },
    { label: "   " },
    { label: "x".repeat(81) },
    { type: "SOMETHING_ELSE" },
    { metric: "bankBalance" },           // not a snapshot field the detector reads
    { threshold: 0 },
    { threshold: -5 },
    { threshold: "1000000000" },
    { xpReward: 2_000_000 },             // above MAX_MILESTONE_REWARD
    { xpReward: 1.5 },
    { xpReward: -1 },
    { announce: "yes" },
    { enabled: null },
    { tier: "MYTHIC" },                  // not a tier the renderer has a badge for
    { tier: 3 },
    { icon: "legendary" },               // an icon is a glyph, not a word
    { icon: 5 },
    { hidden: "yes" },
  ];

  for (const [i, over] of cases.entries()) {
    const result = await mutations.upsertMilestone(session(), "g1", milestoneBody(over));
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  // Nothing was stored, and nothing invalid was written to the trail either.
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

test("a description is optional but bounded", async () => {
  const { mutations } = make();

  assert.equal((await mutations.upsertMilestone(session(), "g1", milestoneBody({ description: "why" }))).ok, true);
  const long = await mutations.upsertMilestone(session(), "g1", milestoneBody({ description: "x".repeat(501) }));
  assert.equal(long.error?.kind, "INVALID_INPUT");
});

test("removing a key nobody stored is a success, reported as nothing removed", async () => {
  // The page lists built-in defaults next to stored rows, so "remove" on a
  // default is a reasonable thing to click. The end state the caller wanted —
  // no row of this guild's own — is already true.
  const { mutations, recorded } = make({ milestoneRemoved: false });

  const result = await mutations.removeMilestone(session(), "g1", "networth:1b");

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [{ method: "removeMilestone", args: ["g1", "networth:1b"] }]);
  assert.deepEqual(recorded.audits[0]?.change, { key: "networth:1b", removed: false });
});

test("a removal needs a key shaped like one", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.removeMilestone(session(), "g1", "")).error?.kind, "INVALID_INPUT");
  assert.equal((await mutations.removeMilestone(session(), "g1", 7)).error?.kind, "INVALID_INPUT");
  assert.deepEqual(recorded.calls, []);
});

test("with milestones unwired, both writes refuse instead of crashing the request", async () => {
  const { mutations, recorded } = make({ noMilestones: true });

  const upsert = await mutations.upsertMilestone(session(), "g1", milestoneBody());
  const remove = await mutations.removeMilestone(session(), "g1", "networth:1b");

  assert.equal(upsert.error?.kind, "SERVICE_ERROR");
  assert.equal(remove.error?.kind, "SERVICE_ERROR");
  assert.deepEqual(recorded.audits, []);
});

test("an officer cannot change what the guild recognises", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const upsert = await mutations.upsertMilestone(session(), "g1", milestoneBody());
  const remove = await mutations.removeMilestone(session(), "g1", "networth:1b");

  assert.equal(upsert.access.allowed, false);
  assert.equal(remove.access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── tickets ──

const categoryBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: "staff-app",
  name: "Staff application",
  description: "Apply to join the staff team.",
  emoji: null,
  position: 3,
  enabled: true,
  channelNameTemplate: "app-{num}",
  parentChannelId: null,
  staffRoleIds: [],
  requiredRoleIds: [],
  pingRoleIds: [],
  openingMessage: "Thanks for applying, {name}.",
  image: null,
  claiming: true,
  cooldownSeconds: null,
  memberLimit: 1,
  totalLimit: 50,
  slowModeSeconds: null,
  requireTopic: false,
  questions: [],
  ...over,
});

const panelBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: null,
  name: "Support",
  channelId: null,
  title: "Need a hand?",
  description: null,
  image: null,
  thumbnail: null,
  style: "BUTTONS",
  categoryKeys: ["support"],
  ...over,
});

const settingsBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  archiveEnabled: true,
  logChannelId: null,
  blocklistRoleIds: [],
  primaryColor: "INFO",
  successColor: "SUCCESS",
  errorColor: "DANGER",
  footer: null,
  staleAfterMinutes: null,
  autoCloseAfterMinutes: 720,
  closeButton: true,
  claimButton: true,
  workingHours: {},
  ...over,
});

test("a ticket category reaches the service whole, and the audit records it in full", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.upsertTicketCategory(session(), "g1", categoryBody());

  assert.equal(result.ok, true);
  assert.equal(recorded.calls.length, 1);
  assert.equal(recorded.calls[0]?.method, "upsertTicketCategory");
  const sent = recorded.calls[0]?.args[1] as Record<string, unknown>;
  assert.equal(sent["key"], "staff-app");
  assert.equal(sent["channelNameTemplate"], "app-{num}");
  assert.equal(sent["totalLimit"], 50);
  assert.equal(recorded.audits[0]?.mutation, "ticket.category.upsert");
  assert.equal((recorded.audits[0]?.change as Record<string, unknown>)["key"], "staff-app");
});

test("a category that could never be opened is refused before it reaches the store", async () => {
  const { mutations, recorded } = make();

  const cases: Record<string, unknown>[] = [
    { key: "Staff App" },                       // keys are lowercase and typable
    { key: "" },
    { name: "   " },
    { name: "x".repeat(81) },
    { description: "x".repeat(101) },           // Discord truncates a select option at 100
    { channelNameTemplate: "  " },
    { parentChannelId: "not-a-channel" },
    { staffRoleIds: "123456789012345678" },     // a list, not one id
    { staffRoleIds: ["nope"] },
    { staffRoleIds: Array.from({ length: 26 }, (_, i) => String(100000000000000000 + i)) },
    { openingMessage: "x".repeat(2001) },
    { image: "http://example.com/a.png" },      // https only
    { position: -1 },
    { position: 1.5 },
    { enabled: "yes" },
    { memberLimit: 0 },                         // "nobody may open one" is `enabled: false`
    { totalLimit: 51 },                         // Discord holds 50 channels in a category
    { slowModeSeconds: 21_601 },                // Discord's slow-mode ceiling is six hours
    { questions: [{ id: "why", label: "Why?", placeholder: null, style: "ESSAY", required: true, maxLength: null }] },
    {
      // Six inputs; a Discord modal takes five, so the sixth would vanish.
      questions: Array.from({ length: 6 }, (_, i) => ({
        id: `q${i}`,
        label: "Why?",
        placeholder: null,
        style: "SHORT",
        required: true,
        maxLength: null,
      })),
    },
  ];

  for (const [i, over] of cases.entries()) {
    const result = await mutations.upsertTicketCategory(session(), "g1", categoryBody(over));
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

test("duplicate staff roles are stored once, so nobody is pinged twice", async () => {
  const { mutations, recorded } = make();

  await mutations.upsertTicketCategory(
    session(),
    "g1",
    categoryBody({ staffRoleIds: ["123456789012345678", "123456789012345678"] }),
  );

  const input = recorded.calls[0]?.args[1] as { staffRoleIds: readonly string[] };
  assert.deepEqual(input.staffRoleIds, ["123456789012345678"]);
});

test("removing a category nobody stored is a success, reported as nothing removed", async () => {
  // Two admins on the same page is the ordinary case, and the second one
  // deserves the same "it's gone" as the first.
  const { mutations, recorded } = make({ ticketRemoved: false });

  const result = await mutations.removeTicketCategory(session(), "g1", "support");

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [{ method: "removeTicketCategory", args: ["g1", "support"] }]);
  assert.deepEqual(recorded.audits[0]?.change, { key: "support", removed: false });
});

test("a panel is held to the shape Discord will actually render", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.upsertTicketPanel(session(), "g1", panelBody())).ok, true);

  const cases: Record<string, unknown>[] = [
    { title: " " },
    { name: "" },
    { channelId: "here" },
    { style: "DROPDOWN" },
    { categoryKeys: [] },                                     // a panel with nothing on it
    { categoryKeys: ["support", "support"] },                 // order is content; no silent dedupe
    // Six buttons will not fit a Discord action row.
    { style: "BUTTONS", categoryKeys: ["a", "b", "c", "d", "e", "f"] },
    // 26 options will not fit a Discord select menu.
    { style: "SELECT", categoryKeys: Array.from({ length: 26 }, (_, i) => `c${i}`) },
    { image: "ftp://example.com/a.png" },
  ];
  for (const [i, over] of cases.entries()) {
    const result = await mutations.upsertTicketPanel(session(), "g1", panelBody(over));
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  // Five buttons and 25 options are exactly the caps, so both are accepted.
  assert.equal(
    (await mutations.upsertTicketPanel(session(), "g1", panelBody({ categoryKeys: ["a", "b", "c", "d", "e"] }))).ok,
    true,
  );
  assert.equal(
    (
      await mutations.upsertTicketPanel(
        session(),
        "g1",
        panelBody({ style: "SELECT", categoryKeys: Array.from({ length: 25 }, (_, i) => `c${i}`) }),
      )
    ).ok,
    true,
  );
  assert.equal(recorded.calls.length, 3);
});

test("publishing a panel with no channel is refused rather than reported as posted", async () => {
  const { mutations, recorded } = make();

  const posted = await mutations.publishTicketPanel(session(), "g1", "p1");
  assert.equal(posted.ok, true);
  assert.deepEqual(recorded.calls, [{ method: "publishPanel", args: ["g1", "p1", "111"] }]);

  const unrouted = await mutations.publishTicketPanel(session(), "g1", "p2");
  assert.equal(unrouted.error?.kind, "INVALID_INPUT");
  const missing = await mutations.publishTicketPanel(session(), "g1", "p9");
  assert.equal(missing.error?.kind, "INVALID_INPUT");
  assert.equal(recorded.calls.length, 1);
});

test("with no bot connected, publishing refuses instead of claiming success", async () => {
  // A panel that reports "published" with no message in the channel is the
  // exact failure this rebuild exists to remove.
  const { mutations, recorded } = make({ noTicketEffects: true });

  const result = await mutations.publishTicketPanel(session(), "g1", "p1");

  assert.equal(result.error?.kind, "SERVICE_ERROR");
  assert.deepEqual(recorded.calls, []);
});

test("a tag's auto-response pattern is compiled before it is stored", async () => {
  const { mutations, recorded } = make();

  const good = await mutations.upsertTicketTag(session(), "g1", {
    name: "refund",
    content: "Refunds take 3 days.",
    autoPattern: "refund|money back",
    enabled: true,
  });
  assert.equal(good.ok, true);

  // Unbalanced, so every message in a ticket channel would throw on it.
  const bad = await mutations.upsertTicketTag(session(), "g1", {
    name: "refund",
    content: "Refunds take 3 days.",
    autoPattern: "refund(",
    enabled: true,
  });
  assert.equal(bad.error?.kind, "INVALID_INPUT");
  assert.equal(recorded.calls.length, 1);
});

test("ticket settings keep null as a real answer rather than folding it into zero", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.saveTicketSettings(session(), "g1", settingsBody())).ok, true);
  const sent = recorded.calls[0]?.args[1] as Record<string, unknown>;
  // Null means "no stale clock". Zero would mark every ticket stale the moment
  // it was opened, which is a different thing entirely.
  assert.equal(sent["staleAfterMinutes"], null);

  const cases: Record<string, unknown>[] = [
    { primaryColor: "PURPLE" },
    { autoCloseAfterMinutes: null },            // this one has no "off"
    { autoCloseAfterMinutes: -1 },
    { logChannelId: "here" },
    { workingHours: { "7": { open: "09:00", close: "17:00" } } },   // there is no eighth day
    { workingHours: { "1": { open: "9am", close: "17:00" } } },
    { workingHours: [] },
  ];
  for (const [i, over] of cases.entries()) {
    const result = await mutations.saveTicketSettings(session(), "g1", settingsBody(over));
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.equal(recorded.calls.length, 1);
});

test("with tickets unwired, every write refuses instead of crashing the request", async () => {
  const { mutations, recorded } = make({ noTickets: true });

  assert.equal((await mutations.upsertTicketCategory(session(), "g1", categoryBody())).error?.kind, "SERVICE_ERROR");
  assert.equal((await mutations.removeTicketCategory(session(), "g1", "support")).error?.kind, "SERVICE_ERROR");
  assert.equal((await mutations.upsertTicketPanel(session(), "g1", panelBody())).error?.kind, "SERVICE_ERROR");
  assert.equal((await mutations.removeTicketPanel(session(), "g1", "p1")).error?.kind, "SERVICE_ERROR");
  assert.equal((await mutations.publishTicketPanel(session(), "g1", "p1")).error?.kind, "SERVICE_ERROR");
  assert.equal((await mutations.saveTicketSettings(session(), "g1", settingsBody())).error?.kind, "SERVICE_ERROR");
  assert.deepEqual(recorded.audits, []);
});

test("an officer cannot change what a member may open", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.upsertTicketCategory(session(), "g1", categoryBody())).access.allowed, false);
  assert.equal((await mutations.removeTicketCategory(session(), "g1", "support")).access.allowed, false);
  assert.equal((await mutations.upsertTicketPanel(session(), "g1", panelBody())).access.allowed, false);
  assert.equal((await mutations.publishTicketPanel(session(), "g1", "p1")).access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── the chat filter ──

const ruleBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: null,
  pattern: "free nitro",
  matchType: "SUBSTRING",
  action: "BLOCK",
  severity: 3,
  enabled: true,
  ...over,
});

test("a rule with no id is added, and one with an id is edited in place", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.upsertWordlistRule(session(), "g1", ruleBody())).ok, true);
  assert.equal(recorded.calls[0]?.method, "addWordlistRule");

  assert.equal((await mutations.upsertWordlistRule(session(), "g1", ruleBody({ id: "w1" }))).ok, true);
  assert.equal(recorded.calls[1]?.method, "updateWordlistRule");
  assert.deepEqual(recorded.calls[1]?.args.slice(0, 2), ["g1", "w1"]);
});

test("the audit records which rule changed and how, but never the pattern", async () => {
  // The list is by construction a collection of slurs and scam URLs; a trail
  // that reproduces every one of them is a second copy of exactly that.
  const { mutations, recorded } = make();

  await mutations.upsertWordlistRule(session(), "g1", ruleBody({ id: "w7", pattern: "a slur" }));

  const change = recorded.audits[0]?.change as Record<string, unknown>;
  assert.equal(recorded.audits[0]?.mutation, "wordlist.upsert");
  assert.deepEqual(change, {
    id: "w7",
    matchType: "SUBSTRING",
    action: "BLOCK",
    severity: 3,
    enabled: true,
    patternLength: 6,
  });
  assert.equal(JSON.stringify(recorded.audits).includes("a slur"), false);
});

test("an omitted note leaves the one a staffer typed into /wordlist-add alone", async () => {
  // The DTO doesn't carry the note, so the panel has never seen it. If omitted
  // meant "clear", every edit from this page would quietly delete it.
  const { mutations, recorded } = make();

  await mutations.upsertWordlistRule(session(), "g1", ruleBody({ id: "w1" }));
  assert.equal("note" in (recorded.calls[0]?.args[2] as Record<string, unknown>), false);

  await mutations.upsertWordlistRule(session(), "g1", ruleBody({ id: "w1", note: null }));
  assert.equal((recorded.calls[1]?.args[2] as Record<string, unknown>)["note"], null);
});

test("a rule the relay could not run is refused before it reaches the store", async () => {
  const { mutations, recorded } = make();

  const cases: Record<string, unknown>[] = [
    { pattern: "" },
    { pattern: "   " },
    { pattern: "x".repeat(201) },
    { matchType: "FUZZY" },
    { action: "DELETE" },
    { severity: 0 },
    { severity: 11 },
    { severity: 1.5 },
    { enabled: "yes" },
    { id: "not a valid id!" },
    { note: "x".repeat(501) },
  ];

  for (const [i, over] of cases.entries()) {
    const result = await mutations.upsertWordlistRule(session(), "g1", ruleBody(over));
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

test("the service's own refusals come back as something the form can show", async () => {
  const bad = make({ wordlistRefusal: { kind: "INVALID_PATTERN", detail: "Unterminated group" } });
  const refused = await bad.mutations.upsertWordlistRule(session(), "g1", ruleBody({ matchType: "REGEX" }));
  assert.equal(refused.error?.kind, "INVALID_INPUT");
  // The regex engine's own complaint, which is more use than a paraphrase.
  assert.equal(refused.error?.detail, "Unterminated group");

  const dupe = make({ wordlistRefusal: { kind: "DUPLICATE" } });
  const collided = await dupe.mutations.upsertWordlistRule(session(), "g1", ruleBody());
  assert.equal(collided.error?.kind, "INVALID_INPUT");
  assert.match(collided.error?.detail ?? "", /already has a rule/);
  assert.deepEqual(dupe.recorded.audits, []);
});

test("editing a rule id that names nothing here is refused rather than silently doing nothing", async () => {
  const { mutations, recorded } = make({ wordlistMissing: true });

  const result = await mutations.upsertWordlistRule(session(), "g1", ruleBody({ id: "w1" }));

  assert.equal(result.error?.kind, "INVALID_INPUT");
  assert.deepEqual(recorded.audits, []);
});

test("removing a rule that is already gone is a success, reported as nothing removed", async () => {
  const { mutations, recorded } = make({ wordlistMissing: true });

  const result = await mutations.deleteWordlistRule(session(), "g1", "w1");

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [{ method: "removeWordlistRule", args: ["g1", "w1"] }]);
  assert.deepEqual(recorded.audits[0]?.change, { id: "w1", removed: false });
});

test("with the filter unwired, every write refuses instead of crashing the request", async () => {
  const { mutations, recorded } = make({ noWordlist: true });

  assert.equal((await mutations.upsertWordlistRule(session(), "g1", ruleBody())).error?.kind, "SERVICE_ERROR");
  assert.equal((await mutations.deleteWordlistRule(session(), "g1", "w1")).error?.kind, "SERVICE_ERROR");
  assert.deepEqual(recorded.audits, []);
});

test("an officer cannot edit the filter", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.upsertWordlistRule(session(), "g1", ruleBody())).access.allowed, false);
  assert.equal((await mutations.deleteWordlistRule(session(), "g1", "w1")).access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── the escalation ladder ──

const ladderBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  windowDays: 90,
  rungs: [
    { warns: 5, action: "BAN", durationSeconds: null },
    { warns: 3, action: "MUTE", durationSeconds: 3600 },
  ],
  ...over,
});

test("a saved ladder reaches the settings key the warning path reads, in order", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setModerationDefaults(session(), "g1", ladderBody());

  assert.equal(result.ok, true);
  const [guildId, key, value] = recorded.calls[0]?.args as [string, string, Record<string, unknown>];
  assert.equal(guildId, "g1");
  assert.equal(key, "moderation.escalation");
  // Sorted on the way in, so a hand-read of the setting is a ladder in order.
  assert.deepEqual(value["rungs"], [
    { warns: 3, action: "MUTE", durationSeconds: 3600 },
    { warns: 5, action: "BAN", durationSeconds: null },
  ]);
  assert.equal(recorded.audits[0]?.mutation, "moderation.defaults");
});

test("a ladder that would half-work is refused rather than trimmed on the way back in", async () => {
  const { mutations, recorded } = make();

  const cases: Record<string, unknown>[] = [
    { enabled: "yes" },
    { windowDays: 0 },
    { windowDays: 366 },
    { windowDays: 7.5 },
    { rungs: "none" },
    { rungs: Array.from({ length: 11 }, (_, i) => ({ warns: i + 1, action: "BAN", durationSeconds: null })) },
    { rungs: [{ warns: 0, action: "BAN", durationSeconds: null }] },
    { rungs: [{ warns: 3, action: "KICK", durationSeconds: null }] },
    // A mute with no end: parsePolicy would drop this rung silently, leaving an
    // admin with a ladder whose third step never fires.
    { rungs: [{ warns: 3, action: "MUTE", durationSeconds: null }] },
    { rungs: [{ warns: 3, action: "MUTE", durationSeconds: 0 }] },
    // Two steps at one count: the later would win, which is not what was shown.
    {
      rungs: [
        { warns: 3, action: "MUTE", durationSeconds: 60 },
        { warns: 3, action: "BAN", durationSeconds: null },
      ],
    },
  ];

  for (const [i, over] of cases.entries()) {
    const result = await mutations.setModerationDefaults(session(), "g1", ladderBody(over));
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

test("an empty ladder with escalation off is a legitimate thing to save", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setModerationDefaults(session(), "g1", { enabled: false, windowDays: 30, rungs: [] });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.audits[0]?.change, { enabled: false, windowDays: 30, rungs: [] });
});

test("an officer cannot decide what a third warning does", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.setModerationDefaults(session(), "g1", ladderBody())).access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── the in-game punishment mapping ──

const relayBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  rows: [
    { discordAction: "MUTE", gameAction: "g mute", durationMode: "same", fixedSeconds: null, enabled: true },
    { discordAction: "BAN", gameAction: "g kick", durationMode: "same", fixedSeconds: null, enabled: true },
  ],
  ...over,
});

test("a saved mapping reaches the settings key the relay reads", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setRelaySync(session(), "g1", relayBody());

  assert.equal(result.ok, true);
  const [guildId, key, value] = recorded.calls[0]?.args as [string, string, Record<string, unknown>];
  assert.equal(guildId, "g1");
  assert.equal(key, "moderation.relay-sync");
  assert.equal((value["rows"] as unknown[]).length, 2);
  assert.equal(recorded.audits[0]?.mutation, "moderation.relay-sync");
});

test("a mapping that would misfire is refused rather than stored half-formed", async () => {
  const { mutations, recorded } = make();

  const cases: Record<string, unknown>[] = [
    { enabled: "yes" },
    { rows: "none" },
    { rows: [{ discordAction: "SHOUT", gameAction: "none", durationMode: "same", fixedSeconds: null, enabled: true }] },
    // The whole point of the closed list: an arbitrary command line here would
    // be typed by an account holding guild-officer permissions.
    { rows: [{ discordAction: "BAN", gameAction: "g demote everyone", durationMode: "same", fixedSeconds: null, enabled: true }] },
    { rows: [{ discordAction: "MUTE", gameAction: "g mute", durationMode: "forever", fixedSeconds: null, enabled: true }] },
    // Fixed with nothing fixed: parseRelaySync would drop the duration and the
    // row would simply never fire.
    { rows: [{ discordAction: "MUTE", gameAction: "g mute", durationMode: "fixed", fixedSeconds: null, enabled: true }] },
    { rows: [{ discordAction: "MUTE", gameAction: "g mute", durationMode: "fixed", fixedSeconds: 0, enabled: true }] },
    { rows: [{ discordAction: "MUTE", gameAction: "g mute", durationMode: "same", fixedSeconds: null, enabled: "on" }] },
    // One action mapped twice: the later would win, unannounced.
    {
      rows: [
        { discordAction: "BAN", gameAction: "g kick", durationMode: "same", fixedSeconds: null, enabled: true },
        { discordAction: "BAN", gameAction: "none", durationMode: "same", fixedSeconds: null, enabled: true },
      ],
    },
  ];

  for (const [i, over] of cases.entries()) {
    const result = await mutations.setRelaySync(session(), "g1", relayBody(over));
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

test("an officer cannot decide what a Discord ban does inside the game guild", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.setRelaySync(session(), "g1", relayBody())).access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── the automod test box ──

/**
 * A policy as it sits in the settings row: two rules, so precedence is visible
 * in the answer rather than assumed.
 */
const automodPolicy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  rules: [
    {
      id: "r-caps",
      name: "Shouting",
      enabled: true,
      surfaces: ["DISCORD", "GUILD_CHAT"],
      trigger: { kind: "caps", percent: 60, minLength: 8 },
      exempt: { roleIds: [], capability: null },
      action: { type: "FLAG", deleteMessage: false, durationSeconds: null },
    },
    {
      id: "r-invite",
      name: "No invites",
      enabled: true,
      surfaces: ["DISCORD"],
      trigger: { kind: "invites" },
      exempt: { roleIds: [], capability: null },
      action: { type: "MUTE", deleteMessage: true, durationSeconds: 600 },
    },
  ],
  ...over,
});

const testBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  text: "hello there everyone",
  surface: "DISCORD",
  ...over,
});

test("the test box reports the rule that fired and what it would have done", async () => {
  const { mutations, recorded } = make({
    roleMap: { "111": "MODERATOR" },
    settings: { "moderation.automod": automodPolicy() },
  });

  const result = await mutations.testAutomod(
    session(),
    "g1",
    testBody({ text: "JOIN NOW discord.gg/abcdef" }),
  );

  assert.equal(result.ok, true);
  // Both rules match; the mute outranks the flag, and the delete survives.
  assert.match(result.note ?? "", /Mute/);
  assert.match(result.note ?? "", /10m/);
  assert.match(result.note ?? "", /message deleted/);
  assert.match(result.note ?? "", /No invites/);
});

test("a message nothing objects to is reported as delivered, and nothing is written", async () => {
  const { mutations, recorded } = make({
    roleMap: { "111": "MODERATOR" },
    settings: { "moderation.automod": automodPolicy() },
  });

  const result = await mutations.testAutomod(session(), "g1", testBody());

  assert.equal(result.ok, true);
  assert.match(result.note ?? "", /No rule matched/);
  // Reads only: the settings lookup is the sole call, and no setSetting among them.
  assert.deepEqual(
    recorded.calls.filter((c) => c.method !== "getSetting" && c.method !== "list"),
    [],
  );
});

test("a switched-off policy still answers, and says so rather than pretending", async () => {
  const { mutations } = make({
    roleMap: { "111": "MODERATOR" },
    settings: { "moderation.automod": automodPolicy({ enabled: false }) },
  });

  const result = await mutations.testAutomod(
    session(),
    "g1",
    testBody({ text: "discord.gg/abcdef" }),
  );

  assert.equal(result.ok, true);
  assert.match(result.note ?? "", /switched off/);
});

test("a surface the rule does not cover does not fire on it", async () => {
  const { mutations } = make({
    roleMap: { "111": "MODERATOR" },
    settings: { "moderation.automod": automodPolicy() },
  });

  const result = await mutations.testAutomod(
    session(),
    "g1",
    testBody({ text: "discord.gg/abcdef", surface: "GUILD_CHAT" }),
  );

  assert.equal(result.ok, true);
  assert.match(result.note ?? "", /No rule matched/);
});

test("supplied counters stand in for the windows Redis would have counted", async () => {
  const spam = automodPolicy({
    rules: [
      {
        id: "r-spam",
        name: "Flooding",
        enabled: true,
        surfaces: ["DISCORD", "GUILD_CHAT"],
        trigger: { kind: "spam", messages: 5, windowSeconds: 10 },
        exempt: { roleIds: [], capability: null },
        action: { type: "WARN", deleteMessage: false, durationSeconds: null },
      },
    ],
  });
  const { mutations } = make({ roleMap: { "111": "MODERATOR" }, settings: { "moderation.automod": spam } });

  const quiet = await mutations.testAutomod(session(), "g1", testBody({ counters: { "r-spam": 2 } }));
  assert.equal(quiet.ok, true);
  assert.match(quiet.note ?? "", /No rule matched/);

  const loud = await mutations.testAutomod(session(), "g1", testBody({ counters: { "r-spam": 9 } }));
  assert.equal(loud.ok, true);
  assert.match(loud.note ?? "", /Warn/);
  assert.match(loud.note ?? "", /Flooding/);
});

test("the audit records the outcome and never the text that was tested", async () => {
  const { mutations, recorded } = make({
    roleMap: { "111": "MODERATOR" },
    settings: { "moderation.automod": automodPolicy() },
  });

  const secret = "JOIN NOW discord.gg/abcdef";
  await mutations.testAutomod(session(), "g1", testBody({ text: secret }));

  const entry = recorded.audits[0];
  assert.equal(entry?.mutation, "automod.test");
  const change = entry?.change as Record<string, unknown>;
  assert.equal(change["textLength"], secret.length);
  assert.equal(change["action"], "MUTE");
  assert.equal(change["deleted"], true);
  assert.deepEqual(change["rules"], ["r-invite"]);
  // Testing a slur rule means pasting the slur. The trail must not become the
  // permanent copy of what nobody wanted written down.
  assert.equal(JSON.stringify(entry).includes("discord.gg"), false);
});

test("a malformed test is refused rather than silently answered about something else", async () => {
  const { mutations, recorded } = make({
    roleMap: { "111": "MODERATOR" },
    settings: { "moderation.automod": automodPolicy() },
  });

  const cases: unknown[] = [
    "not an object",
    testBody({ text: "" }),
    testBody({ text: "   " }),
    testBody({ text: 42 }),
    testBody({ text: "x".repeat(2_001) }),
    testBody({ surface: "GAME" }),
    { text: "hi" },
    testBody({ mentionCount: -1 }),
    testBody({ mentionCount: 1.5 }),
    testBody({ mentionCount: 500 }),
    testBody({ counters: [] }),
    testBody({ counters: { "r-spam": "many" } }),
    testBody({ counters: { "r-spam": 99_999 } }),
  ];

  for (const [i, body] of cases.entries()) {
    const result = await mutations.testAutomod(session(), "g1", body);
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.audits, []);
});

test("a member cannot test the rules that police them", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "MEMBER" } });

  assert.equal((await mutations.testAutomod(session(), "g1", testBody())).access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── automod rules and cooldowns ──

/** A rule as the panel sends one: complete, because the mutation validates the result. */
const automodRuleBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "r-links",
  name: "No links",
  enabled: true,
  surfaces: ["DISCORD"],
  trigger: { kind: "links", allowlist: ["hypixel.net"] },
  exempt: { roleIds: [], capability: null },
  action: { type: "FLAG", deleteMessage: true, durationSeconds: null },
  ...over,
});

test("a new rule is appended and the rules already stored are kept", async () => {
  const { mutations, recorded } = make({ settings: { "moderation.automod": automodPolicy() } });

  const result = await mutations.upsertAutomodRule(session(), "g1", automodRuleBody());

  assert.equal(result.ok, true);
  const [, key, value] = recorded.calls.find((c) => c.method === "setSetting")?.args as [
    string,
    string,
    { enabled: boolean; rules: { id: string }[] },
  ];
  assert.equal(key, "moderation.automod");
  assert.equal(value.enabled, true);
  assert.deepEqual(value.rules.map((r) => r.id), ["r-caps", "r-invite", "r-links"]);
  assert.match(result.note ?? "", /Added/);
});

test("editing a rule replaces that rule and nothing else", async () => {
  const { mutations, recorded } = make({ settings: { "moderation.automod": automodPolicy() } });

  const result = await mutations.upsertAutomodRule(
    session(),
    "g1",
    automodRuleBody({ id: "r-caps", name: "Shouting", trigger: { kind: "caps", percent: 80, minLength: 8 } }),
  );

  assert.equal(result.ok, true);
  const [, , value] = recorded.calls.find((c) => c.method === "setSetting")?.args as [
    string,
    string,
    { rules: { id: string; trigger: { percent?: number } }[] },
  ];
  // Same length and same order: an edit is not an append.
  assert.deepEqual(value.rules.map((r) => r.id), ["r-caps", "r-invite"]);
  assert.equal(value.rules[0]?.trigger.percent, 80);
  assert.match(result.note ?? "", /Updated/);
});

test("a rule that could not do what it says is refused rather than stored", async () => {
  const { mutations, recorded } = make({ settings: { "moderation.automod": automodPolicy() } });

  const cases: unknown[] = [
    "not an object",
    automodRuleBody({ id: "" }),
    automodRuleBody({ id: "spaces are not ids" }),
    automodRuleBody({ name: "" }),
    automodRuleBody({ name: "n".repeat(61) }),
    automodRuleBody({ enabled: "yes" }),
    automodRuleBody({ surfaces: [] }),
    automodRuleBody({ surfaces: ["GAME"] }),
    // A regex that does not compile would be dropped silently on the next read,
    // leaving a rule on screen that matches nothing.
    automodRuleBody({ trigger: { kind: "regex", pattern: "([a-z", flags: "i" } }),
    automodRuleBody({ trigger: { kind: "regex", pattern: "ok", flags: "zz" } }),
    automodRuleBody({ trigger: { kind: "spam", messages: 1, windowSeconds: 10 } }),
    automodRuleBody({ trigger: { kind: "spam", messages: 5, windowSeconds: 0 } }),
    // Below half, ordinary emphatic typing is "shouting".
    automodRuleBody({ trigger: { kind: "caps", percent: 20, minLength: 8 } }),
    automodRuleBody({ trigger: { kind: "mentions", max: 0 } }),
    automodRuleBody({ trigger: { kind: "nonsense" } }),
    automodRuleBody({ exempt: { roleIds: ["not-a-snowflake"], capability: null } }),
    automodRuleBody({ exempt: { roleIds: [], capability: "BECOME_ADMIN" } }),
    automodRuleBody({ action: { type: "DELETE", deleteMessage: true, durationSeconds: null } }),
    automodRuleBody({ action: { type: "FLAG", deleteMessage: "yes", durationSeconds: null } }),
    // A duration on an untimed action means the operator believes they
    // configured something timed, and they did not.
    automodRuleBody({ action: { type: "WARN", deleteMessage: false, durationSeconds: 60 } }),
    automodRuleBody({ action: { type: "MUTE", deleteMessage: false, durationSeconds: 0 } }),
    // Flag-only over the wordlist is what the chat filter already does.
    automodRuleBody({
      trigger: { kind: "wordlist" },
      action: { type: "FLAG", deleteMessage: false, durationSeconds: null },
    }),
  ];

  for (const [i, body] of cases.entries()) {
    const result = await mutations.upsertAutomodRule(session(), "g1", body);
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls.filter((c) => c.method === "setSetting"), []);
  assert.deepEqual(recorded.audits, []);
});

test("removing a rule leaves the others, and a rule that was never there is reported honestly", async () => {
  const present = make({ settings: { "moderation.automod": automodPolicy() } });
  const gone = make({ settings: { "moderation.automod": automodPolicy() } });

  const removed = await present.mutations.removeAutomodRule(session(), "g1", { id: "r-caps" });
  assert.equal(removed.ok, true);
  const [, , value] = present.recorded.calls.find((c) => c.method === "setSetting")?.args as [
    string,
    string,
    { rules: { id: string }[] },
  ];
  assert.deepEqual(value.rules.map((r) => r.id), ["r-invite"]);

  const missing = await gone.mutations.removeAutomodRule(session(), "g1", { id: "r-nothing" });
  assert.equal(missing.ok, true);
  assert.match(missing.note ?? "", /already gone/);
  // Nothing is written for a no-op: a settings write here would bump the row's
  // timestamp and invalidate every cache for a change that did not happen.
  assert.deepEqual(gone.recorded.calls.filter((c) => c.method === "setSetting"), []);
});

test("the master switch keeps the rules it switches off", async () => {
  const { mutations, recorded } = make({ settings: { "moderation.automod": automodPolicy() } });

  const result = await mutations.setAutomodEnabled(session(), "g1", { enabled: false });

  assert.equal(result.ok, true);
  const [, , value] = recorded.calls.find((c) => c.method === "setSetting")?.args as [
    string,
    string,
    { enabled: boolean; rules: unknown[] },
  ];
  assert.equal(value.enabled, false);
  assert.equal(value.rules.length, 2);
  assert.match(result.note ?? "", /kept/);

  const refused = await mutations.setAutomodEnabled(session(), "g1", { enabled: "off" });
  assert.equal(refused.error?.kind, "INVALID_INPUT");
});

test("an officer cannot write the rules that act without a person", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.upsertAutomodRule(session(), "g1", automodRuleBody())).access.allowed, false);
  assert.equal((await mutations.removeAutomodRule(session(), "g1", { id: "r-caps" })).access.allowed, false);
  assert.equal((await mutations.setAutomodEnabled(session(), "g1", { enabled: false })).access.allowed, false);
  assert.equal((await mutations.setCooldowns(session(), "g1", { relaySeconds: 5 })).access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

test("cooldowns are stored whole, and a blank default is not the same as zero", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setCooldowns(session(), "g1", {
    commandDefaultSeconds: null,
    relaySeconds: 3,
    perCommand: { networth: 30 },
  });

  assert.equal(result.ok, true);
  const [, key, value] = recorded.calls.find((c) => c.method === "setSetting")?.args as [
    string,
    string,
    { commandDefaultSeconds: number | null; relaySeconds: number; perCommand: Record<string, number> },
  ];
  assert.equal(key, "config.cooldowns");
  assert.equal(value.commandDefaultSeconds, null);
  assert.equal(value.relaySeconds, 3);
  assert.deepEqual(value.perCommand, { networth: 30 });
  assert.equal(recorded.audits[0]?.mutation, "config.cooldowns");
});

test("a cooldown nobody could wait out is refused", async () => {
  const { mutations, recorded } = make();

  const cases: unknown[] = [
    "not an object",
    { commandDefaultSeconds: -1 },
    { commandDefaultSeconds: 1.5 },
    { commandDefaultSeconds: 601 },
    { relaySeconds: 601 },
    { relaySeconds: "none" },
    { perCommand: [] },
    { perCommand: { "not a command": 5 } },
    { perCommand: { networth: 601 } },
    { perCommand: { networth: "slow" } },
  ];

  for (const [i, body] of cases.entries()) {
    const result = await mutations.setCooldowns(session(), "g1", body);
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

// ── health: running a job by hand ──

test("an ADMIN starting a job reaches the fleet, the audit and usage", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.runJob(session(), "g1", { jobName: "guild-scan" });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    { method: "triggerJob", args: [{ jobName: "guild-scan", guildId: "g1", actorDiscordId: "111" }] },
  ]);
  assert.equal(recorded.audits[0]?.mutation, "health.run-job");
  assert.deepEqual(recorded.audits[0]?.change, { jobName: "guild-scan" });
  assert.equal(recorded.usage[0]?.success, true);
  // The note must promise a request, not a run: the bus is fire-and-forget and
  // the last-run column is the only thing that can confirm the work happened.
  assert.match(result.note ?? "", /Requested/);
});

test("an OFFICER cannot start a job by hand", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const result = await mutations.runJob(session(), "g1", { jobName: "guild-scan" });

  assert.equal(result.ok, false);
  assert.equal(result.access.allowed, false);
  if (!result.access.allowed) assert.equal(result.access.reason, "INSUFFICIENT_ROLE");
  assert.deepEqual(recorded.calls, []);
});

test("a job name outside the allow-list is refused, and nothing is published", async () => {
  const { mutations, recorded } = make();

  for (const body of [null, "guild-scan", {}, { jobName: "" }, { jobName: 7 }, { jobName: "rm -rf" }] as unknown[]) {
    const result = await mutations.runJob(session(), "g1", body);
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, "INVALID_INPUT");
  }
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

test("a deployment with no worker bus says so rather than silently doing nothing", async () => {
  const { mutations, recorded } = make({ noJobs: true });

  const result = await mutations.runJob(session(), "g1", { jobName: "guild-scan" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "SERVICE_ERROR");
  assert.deepEqual(recorded.audits, []);
});

test("a publish that throws is reported, not swallowed as a success", async () => {
  const { mutations } = make({ jobsThrow: true });

  const result = await mutations.runJob(session(), "g1", { jobName: "guild-scan" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "SERVICE_ERROR");
  assert.match(result.error?.detail ?? "", /redis is down/);
});

/**
 * The second gate is keyed per job and per guild rather than per actor, so two
 * different admins cannot each start the same sweep inside the minute. That is
 * the whole point of it existing on top of the standard per-user limiter.
 */
test("the manual-run gate is per job and per guild, not per person", async () => {
  const { mutations, recorded } = make();
  await mutations.runJob(session(), "g1", { jobName: "guild-scan" });

  assert.ok(recorded.limited.includes("cd:web:job:g1:guild-scan"));
  assert.ok(recorded.limited.some((k) => k.includes("111")), "the standard per-user gate still runs");
  assert.ok(MANUAL_JOB_COOLDOWN_MS > MUTATION_COOLDOWN_MS);

  const second = make({
    roleMap: { "111": "ADMIN", "222": "ADMIN" },
    blocked: ["cd:web:job:g1:guild-scan"],
  });
  const result = await second.mutations.runJob(
    session({ discordId: "222" }),
    "g1",
    { jobName: "guild-scan" },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "RATE_LIMITED");
  assert.equal(result.error?.retryAfterMs, 1500);
  assert.deepEqual(second.recorded.calls, []);
});

// ── permissions ──

/**
 * The four dimensions write to two different places — bindings to their own
 * config method, the other three into one policy document — so these tests
 * assert *where* a change landed as much as whether it was accepted.
 */

test("an OFFICER cannot edit the permission model", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  for (const call of [
    mutations.setRoleBinding(session(), "g1", { role: "ADMIN", discordRoleIds: ["123456789012345678"] }),
    mutations.setRankMapping(session(), "g1", { rank: "Officer", role: "OFFICER" }),
    mutations.setCapabilityFloor(session(), "g1", { capability: "MENTION", role: "ADMIN" }),
    mutations.setCommandFloor(session(), "g1", { command: "warn", role: "OFFICER" }),
    mutations.setPermissionException(session(), "g1", {
      subjectType: "DISCORD_USER", subjectId: "222222222222222222", capability: "RELAY_MESSAGE", allow: false,
    }),
    mutations.removePermissionException(session(), "g1", { id: "e1" }),
  ]) {
    const result = await call;
    assert.equal(result.ok, false);
    assert.equal(result.access.allowed, false);
  }
  assert.deepEqual(recorded.calls, []);
});

test("binding a level writes the whole set of Discord roles at once", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setRoleBinding(session(), "g1", {
    role: "MODERATOR",
    // The duplicate is the point: the page can post one, and a set with a
    // repeat in it is a set, not a rejection.
    discordRoleIds: ["123456789012345678", "223456789012345678", "123456789012345678"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    { method: "setRoleBinding", args: ["g1", "MODERATOR", ["123456789012345678", "223456789012345678"]] },
  ]);
  assert.deepEqual(recorded.audits[0]?.change, {
    role: "MODERATOR",
    discordRoleIds: ["123456789012345678", "223456789012345678"],
  });
});

test("an empty list clears a binding rather than being rejected as missing", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.setRoleBinding(session(), "g1", { role: "ADMIN", discordRoleIds: [] })).ok, true);
  assert.deepEqual(recorded.calls[0]?.args, ["g1", "ADMIN", []]);
});

test("a binding to something that is not a Discord role id never reaches the config service", async () => {
  const { mutations, recorded } = make();

  for (const body of [
    { role: "WIZARD", discordRoleIds: ["123456789012345678"] },
    { role: "ADMIN", discordRoleIds: "123456789012345678" },
    { role: "ADMIN", discordRoleIds: ["not-a-snowflake"] },
  ]) {
    const result = await mutations.setRoleBinding(session(), "g1", body);
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.error?.kind, "INVALID_INPUT");
  }
  assert.deepEqual(recorded.calls, []);
});

test("mapping an in-game rank reads the policy document and writes it back whole", async () => {
  const { mutations, recorded } = make({
    settings: { [ROLE_POLICY_SETTING_KEY]: { guildRanks: { "Guild Master": "OWNER" } } },
  });

  // Ranks are matched case-insensitively in game chat, so they are stored
  // folded — "  Officer  " and "officer" are one mapping, not two.
  const result = await mutations.setRankMapping(session(), "g1", { rank: "  Officer  ", role: "OFFICER" });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    { method: "getSetting", args: ["g1", ROLE_POLICY_SETTING_KEY] },
    {
      method: "setSetting",
      args: [
        "g1",
        ROLE_POLICY_SETTING_KEY,
        // The rank already there survives: this is a read-modify-write of one
        // document, not a replacement of it.
        { guildRanks: { "guild master": "OWNER", officer: "OFFICER" }, capabilities: {}, commands: {} },
      ],
    },
  ]);
});

test("a null role unmaps a rank instead of storing null as a level", async () => {
  const { mutations, recorded } = make({
    settings: { [ROLE_POLICY_SETTING_KEY]: { guildRanks: { Officer: "OFFICER", Member: "MEMBER" } } },
  });

  const result = await mutations.setRankMapping(session(), "g1", { rank: "Officer", role: null });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls[1]?.args[2], { guildRanks: { member: "MEMBER" }, capabilities: {}, commands: {} });
});

test("a blank rank name is refused before anything is read", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setRankMapping(session(), "g1", { rank: "   ", role: "OFFICER" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "INVALID_INPUT");
  assert.deepEqual(recorded.calls, []);
});

test("a capability floor lands in the policy beside whatever else it holds", async () => {
  const { mutations, recorded } = make({
    settings: { [ROLE_POLICY_SETTING_KEY]: { commands: { warn: "OFFICER" } } },
  });

  const result = await mutations.setCapabilityFloor(session(), "g1", { capability: "MENTION", role: "OFFICER" });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls[1]?.args[2], {
    guildRanks: {},
    capabilities: { MENTION: "OFFICER" },
    commands: { warn: "OFFICER" },
  });
});

/**
 * The reader fills every default in, so writing its result back verbatim would
 * freeze today's floors into the guild's document the first time anyone saved
 * anything — and a later change to a platform default would then skip every
 * guild that had ever touched the page.
 */
test("a floor set back to the platform default is stored as nothing at all", async () => {
  const { mutations, recorded } = make({
    settings: { [ROLE_POLICY_SETTING_KEY]: { capabilities: { MENTION: "OFFICER" } } },
  });

  const result = await mutations.setCapabilityFloor(session(), "g1", { capability: "MENTION", role: "MODERATOR" });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls[1]?.args[2], { guildRanks: {}, capabilities: {}, commands: {} });
});

/**
 * ADMIN is the capability that implies every other one, so a guild that could
 * hand it to MEMBER would have a permission model with one level in it. The
 * refusal comes from the shared validator, which is what the bots read with.
 */
test("the ADMIN capability cannot be dropped below the ADMIN level", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setCapabilityFloor(session(), "g1", { capability: "ADMIN", role: "MEMBER" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "INVALID_INPUT");
  assert.match(result.error?.detail ?? "", /ADMIN/);
  assert.ok(!recorded.calls.some((c) => c.method === "setSetting"));
});

test("a capability the platform does not define is refused", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setCapabilityFloor(session(), "g1", { capability: "FLY", role: "ADMIN" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "INVALID_INPUT");
  assert.deepEqual(recorded.calls, []);
});

test("a command override is stored lowercased under its own key", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setCommandFloor(session(), "g1", { command: " Warn ", role: "MODERATOR" });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls[1]?.args[2], {
    guildRanks: {},
    capabilities: {},
    commands: { warn: "MODERATOR" },
  });
  assert.deepEqual(recorded.audits[0]?.change, { command: "warn", role: "MODERATOR" });
});

/**
 * Clearing stores nothing rather than storing the handler's current floor: a
 * command whose compiled-in floor is later raised must not stay lowered by a
 * policy written against the old one.
 */
test("clearing a command override removes the key rather than pinning the default", async () => {
  const { mutations, recorded } = make({
    settings: { [ROLE_POLICY_SETTING_KEY]: { commands: { warn: "MEMBER" } } },
  });

  const result = await mutations.setCommandFloor(session(), "g1", { command: "warn", role: null });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls[1]?.args[2], { guildRanks: {}, capabilities: {}, commands: {} });
});

test("an exception names a subject, a capability and which way it points", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setPermissionException(session(), "g1", {
    subjectType: "DISCORD_USER",
    subjectId: "222222222222222222",
    capability: "RELAY_MESSAGE",
    allow: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    { method: "setException", args: ["g1", "DISCORD_USER", "222222222222222222", "RELAY_MESSAGE", false] },
  ]);
});

test("a rank subject is a name and a Discord subject is a snowflake, and neither takes the other's shape", async () => {
  const { mutations, recorded } = make();

  const rank = await mutations.setPermissionException(session(), "g1", {
    subjectType: "GUILD_RANK", subjectId: " Officer ", capability: "RELAY_MESSAGE", allow: true,
  });
  assert.equal(rank.ok, true);
  assert.deepEqual(recorded.calls[0]?.args, ["g1", "GUILD_RANK", "Officer", "RELAY_MESSAGE", true]);

  const role = await mutations.setPermissionException(session(), "g1", {
    subjectType: "DISCORD_ROLE", subjectId: "Officer", capability: "RELAY_MESSAGE", allow: true,
  });
  assert.equal(role.ok, false);
  assert.equal(role.error?.kind, "INVALID_INPUT");
  assert.equal(recorded.calls.length, 1);
});

/** A missing `allow` is not a deny: the strongest statement here is asked for. */
test("which way an exception points has to be said out loud", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setPermissionException(session(), "g1", {
    subjectType: "DISCORD_USER", subjectId: "222222222222222222", capability: "RELAY_MESSAGE",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "INVALID_INPUT");
  assert.deepEqual(recorded.calls, []);
});

test("a deployment without the exception store says so instead of failing obscurely", async () => {
  const { mutations } = make({ noExceptions: true });

  const set = await mutations.setPermissionException(session(), "g1", {
    subjectType: "DISCORD_USER", subjectId: "222222222222222222", capability: "RELAY_MESSAGE", allow: true,
  });
  const remove = await mutations.removePermissionException(session(), "g1", { id: "e1" });

  for (const result of [set, remove]) {
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, "SERVICE_ERROR");
    assert.match(result.error?.detail ?? "", /aren't available/);
  }
});

test("removing an exception another admin already removed is reported, not passed off as a deletion", async () => {
  const { mutations, recorded } = make({ exceptionRemoved: false });

  const result = await mutations.removePermissionException(session(), "g1", { id: "e1" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "INVALID_INPUT");
  assert.deepEqual(recorded.calls, [{ method: "removeException", args: ["g1", "e1"] }]);
  assert.deepEqual(recorded.audits, []);
});

test("presentation is optional, so an older panel cannot demote a tier by omission", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.upsertMilestone(session(), "g1", milestoneBody());

  assert.equal(result.ok, true);
  const stored = recorded.calls[0]?.args[1] as Record<string, unknown>;
  // Absent, not defaulted: the repository leaves the stored column alone, where
  // writing "BRONZE" here would quietly flatten a Platinum on every save.
  assert.ok(!("tier" in stored));
  assert.ok(!("icon" in stored));
  assert.ok(!("hidden" in stored));
});

test("tier, icon and hidden are stored when the panel sends them", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.upsertMilestone(
    session(),
    "g1",
    milestoneBody({ tier: "PLATINUM", icon: "💰", hidden: true }),
  );

  assert.equal(result.ok, true);
  const stored = recorded.calls[0]?.args[1] as Record<string, unknown>;
  assert.equal(stored["tier"], "PLATINUM");
  assert.equal(stored["icon"], "💰");
  assert.equal(stored["hidden"], true);
});

test("an icon of whitespace is no icon at all", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.upsertMilestone(session(), "g1", milestoneBody({ icon: "   " }));

  assert.equal(result.ok, true);
  assert.equal((recorded.calls[0]?.args[1] as Record<string, unknown>)["icon"], null);
});

// ── roles & welcome ──

const rolePolicy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  rules: [
    {
      key: "member",
      label: "Guild member",
      trigger: { kind: "IN_GUILD" },
      roleId: "555555555555555555",
      revokeWhenUnqualified: true,
      enabled: true,
    },
  ],
  ...over,
});

/** One member for the dry run: in the guild, holding nothing, owed nothing. */
const previewMember = (over: Record<string, unknown> = {}) => ({
  facts: {
    discordId: "1",
    inGuild: true,
    linked: false,
    guildRank: null,
    xpLevel: 0,
    achievementKeys: [] as readonly string[],
    eventsAttended: 0,
  },
  heldRoleIds: [] as readonly string[],
  ledger: [] as readonly { readonly ruleKey: string; readonly roleId: string }[],
  ...over,
});

test("an ADMIN saving auto-roles stores the normalised policy and counts the active rules", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.saveAutoRoles(session(), "g1", rolePolicy());

  assert.equal(result.ok, true);
  assert.match(result.ok === true ? (result.note ?? "") : "", /1 of 1 rule/);
  const call = recorded.calls.find((c) => c.method === "setSetting");
  assert.equal(call?.args[1], "roles.auto");
  const stored = call?.args[2] as { enabled: boolean; rules: readonly Record<string, unknown>[] };
  assert.equal(stored.enabled, true);
  assert.equal(stored.rules[0]?.["key"], "member");
});

test("a rule with no role never reaches the setting", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.saveAutoRoles(
    session(),
    "g1",
    rolePolicy({ rules: [{ key: "member", trigger: { kind: "IN_GUILD" } }] }),
  );

  assert.equal(result.ok, false);
  assert.equal(recorded.calls.some((c) => c.method === "setSetting"), false);
});

test("two rules sharing a key are refused: the ledger treats a key as an identity", async () => {
  const { mutations } = make();

  const result = await mutations.saveAutoRoles(
    session(),
    "g1",
    rolePolicy({
      rules: [
        { key: "member", trigger: { kind: "IN_GUILD" }, roleId: "1" },
        { key: "member", trigger: { kind: "LINKED" }, roleId: "2" },
      ],
    }),
  );

  assert.equal(result.ok, false);
});

test("a moderator may preview but not save", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "MODERATOR" } });

  const saved = await mutations.saveAutoRoles(session(), "g1", rolePolicy());
  assert.equal(saved.ok, false);

  const previewed = await mutations.previewAutoRoles(session(), "g1", rolePolicy());
  assert.equal(previewed.ok, true);
  assert.equal(recorded.calls.some((c) => c.method === "setSetting"), false);
});

test("the dry run counts what would happen and writes nothing", async () => {
  const { mutations, recorded } = make({
    async previewMembers() {
      return {
        members: [
          // Qualifies, holds nothing: one grant.
          previewMember(),
          // Qualifies and already holds it: no grant, and still no revoke.
          previewMember({
            facts: { ...previewMember().facts, discordId: "2" },
            heldRoleIds: ["555555555555555555"],
            ledger: [{ ruleKey: "member", roleId: "555555555555555555" }],
          }),
          // Left the guild, and we granted it: the one revoke.
          previewMember({
            facts: { ...previewMember().facts, discordId: "3", inGuild: false },
            heldRoleIds: ["555555555555555555"],
            ledger: [{ ruleKey: "member", roleId: "555555555555555555" }],
          }),
        ],
        total: 3,
      };
    },
  });

  const result = await mutations.previewAutoRoles(session(), "g1", rolePolicy());

  assert.equal(result.ok, true);
  assert.match(result.ok === true ? (result.note ?? "") : "", /1 role\(s\) would be granted and 1 revoked/);
  assert.match(result.ok === true ? (result.note ?? "") : "", /all 3 member\(s\)/);
  assert.equal(recorded.calls.some((c) => c.method === "setSetting"), false);
});

test("a policy that is switched off previews as no change rather than as a mass strip", async () => {
  const { mutations } = make({
    async previewMembers() {
      return { members: [previewMember({ heldRoleIds: ["555555555555555555"] })], total: 1 };
    },
  });

  const result = await mutations.previewAutoRoles(session(), "g1", rolePolicy({ enabled: false }));

  assert.equal(result.ok, true);
  assert.match(result.ok === true ? (result.note ?? "") : "", /switched off/);
});

test("without a roster the dry run refuses rather than reporting zeroes", async () => {
  const { mutations } = make({ noRolesInsight: true });

  const result = await mutations.previewAutoRoles(session(), "g1", rolePolicy());

  assert.equal(result.ok, false);
});

test("saving the welcome stores it and never puts the text in the audit trail", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.saveWelcome(session(), "g1", {
    join: { enabled: true, channelSlot: "welcome", mode: "EMBED", text: "Welcome {user}!" },
  });

  assert.equal(result.ok, true);
  const call = recorded.calls.find((c) => c.method === "setSetting");
  assert.equal(call?.args[1], "discord.welcome");
  const audit = recorded.audits.at(-1);
  assert.equal(JSON.stringify(audit?.change ?? {}).includes("Welcome {user}"), false);
});

test("a misspelled welcome field is refused rather than silently dropped", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.saveWelcome(session(), "g1", {
    join: { enabled: true, chanelSlot: "welcome", text: "hi" },
  });

  assert.equal(result.ok, false);
  assert.equal(recorded.calls.some((c) => c.method === "setSetting"), false);
});

test("a welcome pointed at a slot nothing can bind is refused", async () => {
  const { mutations } = make();

  const result = await mutations.saveWelcome(session(), "g1", {
    leave: { enabled: true, channelSlot: "nowhere", text: "bye" },
  });

  assert.equal(result.ok, false);
});

test("clearing the refusal list reaches the store, and says it may come back", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.clearRoleRefusals(session(), "g1");

  assert.equal(result.ok, true);
  assert.match(result.ok === true ? (result.note ?? "") : "", /recur/);
  assert.equal(recorded.calls.some((c) => c.method === "clearRefusals"), true);
});

test("with nothing recording refusals, clearing says so rather than pretending", async () => {
  const { mutations } = make({ noRolesInsight: true });

  assert.equal((await mutations.clearRoleRefusals(session(), "g1")).ok, false);
});
