/**
 * The admin bot's internal control API.
 *
 * The panel has no gateway connection, so it cannot know what a Discord server's
 * channels, roles or members are called — which is why every configuration field
 * used to be a snowflake pasted in by hand. This process is the only one holding
 * a gateway cache, so it answers those questions here, and it is also the only
 * one that can make a panel-issued ban actually reach Discord.
 *
 * Security posture: bound to loopback, bearer-token authenticated, and the token
 * is compared in constant time. There is no session, no CSRF and no cookie —
 * this is a machine-to-machine socket that must never be exposed publicly. The
 * API answers "list every member of this server", so treat the token as a
 * credential of the same weight as the bot token itself.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  ChannelType,
  DiscordAPIError,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type Role,
} from "discord.js";
import { containerMessage } from "@sbr/discord-kit";
import type { EmbedView } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import {
  describeRefusal,
  refuseRole,
  type BotFacts,
  type RoleFacts,
  type RoleRefusal,
} from "./role-preflight.js";

/** Loopback only. A LAN bind would hand the member list to the whole subnet. */
const BIND_HOST = "127.0.0.1";

/** Bodies here are tiny (an enforce request); anything larger is a mistake. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Member fetches are the expensive call — a large server is thousands of rows
 * over the REST API. Every keystroke in a picker would otherwise re-fetch it, so
 * the roster is held briefly in process. The panel caches on top of this; the
 * two together mean a typing operator costs zero Discord calls.
 */
const MEMBER_CACHE_MS = 60_000;

/** Guard rail on picker responses, so one request can't serialise 100k members. */
const MAX_ROWS = 200;

/**
 * A member gaining or losing more than this in one call is a bug in the caller,
 * not a guild with a lot of roles - the reconciler sends a diff, not a roster.
 */
const MAX_ROLES_PER_CALL = 25;

export interface InternalApiDeps {
  /** Live gateway client. Supplied only once ready — see `startInternalApi`. */
  readonly client: Client;
  /** Platform guild id → Discord snowflake, so callers never map ids themselves. */
  readonly toDiscordGuildId: (internalGuildId: string) => Promise<string | null>;
  readonly token: string;
  readonly port: number;
  readonly logger: Logger;
}

interface ChannelRow {
  readonly id: string;
  readonly name: string;
  readonly type: "text" | "voice" | "forum" | "announcement" | "stage" | "category" | "other";
  readonly parentName: string | null;
}

interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly position: number;
  readonly managed: boolean;
  /**
   * Whether a rule may hand this role out. Computed here rather than in the
   * panel because the answer depends on the bot's own position in the
   * hierarchy, which only this process can see.
   */
  readonly assignable: boolean;
  /** Why not, in a sentence, or null when it is assignable. */
  readonly blockedReason: string | null;
}

/** One role the caller asked for and did not get, and why. */
interface RefusedRole {
  readonly roleId: string;
  readonly reason: RoleRefusal;
  readonly detail: string;
}

interface RoleApplyResult {
  readonly ok: boolean;
  /**
   * False when the user is not in the server at all. Not an error - people
   * leave - but the caller must not record a grant for somebody who was never
   * given anything.
   */
  readonly memberPresent: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly refused: readonly RefusedRole[];
  readonly error?: string;
}

interface MemberRow {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly nick: string | null;
  readonly avatarHash: string | null;
  readonly roleIds: readonly string[];
  readonly joinedAt: string | null;
  readonly bot: boolean;
}

interface CachedRoster {
  readonly rows: readonly MemberRow[];
  readonly at: number;
}

/** Discord's numeric channel types, reduced to the handful a picker cares about. */
function channelKind(type: ChannelType): ChannelRow["type"] {
  switch (type) {
    case ChannelType.GuildText:
      return "text";
    case ChannelType.GuildVoice:
      return "voice";
    case ChannelType.GuildForum:
      return "forum";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildStageVoice:
      return "stage";
    case ChannelType.GuildCategory:
      return "category";
    default:
      return "other";
  }
}

/**
 * Constant-time bearer check. A plain `===` on a secret leaks its prefix through
 * timing; the length check before it is safe because length is not the secret.
 */
function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** Size-checked while streaming: content-length is a claim, not a guarantee. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Snowflakes from an untrusted body: strings only, deduplicated, capped. */
function ids(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (id !== "") seen.add(id);
  }
  return [...seen].slice(0, MAX_ROLES_PER_CALL);
}

/**
 * A short code where we recognise the failure, and Discord's own words where we
 * do not, since a human reads this in the panel. 10011 is an unknown role,
 * which after a preflight means it was deleted in the milliseconds since - the
 * next pass simply will not ask for it again.
 */
function describeError(error: unknown): string {
  if (error instanceof DiscordAPIError) {
    if (error.code === 10011) return "UNKNOWN_ROLE";
    if (error.code === 50013 || error.code === 50001) return "MISSING_PERMISSION";
    return error.message;
  }
  return error instanceof Error ? error.message : "FAILED";
}

/**
 * Discord's own limits on a scheduled event, applied here rather than trusted.
 *
 * An event title long enough to be rejected is a create that fails, and the
 * caller sees only a missing reminder link for a reason nobody would guess from
 * the panel. Truncating loses the tail of a title; refusing loses the feature.
 */
const EVENT_NAME_MAX = 100;
const EVENT_DESCRIPTION_MAX = 1000;
const EVENT_LOCATION_MAX = 100;

/** The platform's four statuses, in Discord's vocabulary. */
function eventStatus(status: string | null): GuildScheduledEventStatus | null {
  if (status === "SCHEDULED") return GuildScheduledEventStatus.Scheduled;
  if (status === "ACTIVE" || status === "LIVE") return GuildScheduledEventStatus.Active;
  if (status === "COMPLETED") return GuildScheduledEventStatus.Completed;
  if (status === "CANCELLED" || status === "CANCELED") return GuildScheduledEventStatus.Canceled;
  return null;
}

/**
 * The next status Discord will actually accept, or null to leave it alone.
 *
 * Scheduled events move one way — scheduled to active to completed, or
 * scheduled to cancelled — and Discord rejects anything else. Asking only for
 * transitions it allows keeps the ordinary path free of exceptions, which
 * matters because this runs on every redraw of every open event.
 */
function nextEventStatus(
  current: GuildScheduledEventStatus,
  want: GuildScheduledEventStatus,
): GuildScheduledEventStatus.Active | GuildScheduledEventStatus.Completed | GuildScheduledEventStatus.Canceled | null {
  if (current === GuildScheduledEventStatus.Scheduled) {
    if (want === GuildScheduledEventStatus.Active) return GuildScheduledEventStatus.Active;
    if (want === GuildScheduledEventStatus.Canceled) return GuildScheduledEventStatus.Canceled;
    // A scheduled event that finished without ever being marked live is
    // cancelled, not completed: Discord has no scheduled-to-completed edge, and
    // something that never started is closer to called off than to run.
    if (want === GuildScheduledEventStatus.Completed) return GuildScheduledEventStatus.Canceled;
    return null;
  }
  if (current === GuildScheduledEventStatus.Active && want === GuildScheduledEventStatus.Completed) {
    return GuildScheduledEventStatus.Completed;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Substring match across every name a human might type: the picker's whole point
 * is that you type "general" rather than remembering 1103928…
 */
function matches(query: string, ...fields: readonly (string | null)[]): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  return fields.some((f) => f !== null && f.toLowerCase().includes(needle));
}

export class InternalApi {
  private readonly d: InternalApiDeps;
  private readonly log: Logger;
  private server: Server | null = null;
  private readonly rosters = new Map<string, CachedRoster>();

  constructor(deps: InternalApiDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "internal-api" });
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.log.error("internal api request failed", { error: String(error) });
        if (!res.headersSent) sendJson(res, 500, { error: "INTERNAL" });
      });
    });
    // Same slowloris guards the panel uses; this socket is loopback but the
    // process is long-lived and a stuck request would hold a handle forever.
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.d.port, BIND_HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.log.info("internal api listening", { host: BIND_HOST, port: this.d.port });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!tokenMatches(this.d.token, bearer(req))) {
      sendJson(res, 401, { error: "UNAUTHORIZED" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${BIND_HOST}`);
    const match = /^\/internal\/g\/([^/]+)\/([a-z-]+)$/.exec(url.pathname);
    if (!match) {
      sendJson(res, 404, { error: "NOT_FOUND" });
      return;
    }
    const [, rawGuildId, resource] = match;
    const guild = await this.guild(decodeURIComponent(rawGuildId ?? ""));
    if (!guild) {
      sendJson(res, 404, { error: "GUILD_NOT_FOUND" });
      return;
    }

    const method = req.method ?? "GET";
    if (method === "GET") {
      switch (resource) {
        case "channels":
          sendJson(res, 200, { channels: this.channels(guild, url.searchParams.get("q") ?? "") });
          return;
        case "roles":
          sendJson(res, 200, { roles: await this.roles(guild, url.searchParams.get("q") ?? "") });
          return;
        case "members":
          sendJson(res, 200, {
            members: await this.members(
              guild,
              url.searchParams.get("q") ?? "",
              url.searchParams.get("all") === "1",
            ),
          });
          return;
        case "member-roles":
          sendJson(res, 200, await this.memberRoles(guild, url.searchParams.get("userId") ?? ""));
          return;
        default:
          sendJson(res, 404, { error: "NOT_FOUND" });
          return;
      }
    }

    if (method === "POST") {
      const body = await readBody(req);
      switch (resource) {
        case "enforce":
          sendJson(res, 200, await this.enforce(guild, body));
          return;
        case "scheduled-event":
          sendJson(res, 200, await this.scheduledEvent(guild, body));
          return;
        case "roles":
          sendJson(res, 200, await this.applyRoles(guild, body));
          return;
        case "announce":
          sendJson(res, 200, await this.announce(guild, body));
          return;
        default:
          sendJson(res, 404, { error: "NOT_FOUND" });
          return;
      }
    }

    sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
  }

  /**
   * Callers pass the platform's own guild id, the same one the panel session
   * carries, so nothing outside this file has to know the Discord mapping.
   */
  private async guild(internalGuildId: string): Promise<Guild | null> {
    if (internalGuildId === "") return null;
    const discordGuildId = await this.d.toDiscordGuildId(internalGuildId);
    if (!discordGuildId) return null;
    try {
      return await this.d.client.guilds.fetch(discordGuildId);
    } catch {
      return null;
    }
  }

  private channels(guild: Guild, query: string): readonly ChannelRow[] {
    const rows: ChannelRow[] = [];
    for (const channel of guild.channels.cache.values()) {
      if (!channel) continue;
      const parentName = "parent" in channel ? (channel.parent?.name ?? null) : null;
      if (!matches(query, channel.name, parentName)) continue;
      rows.push({ id: channel.id, name: channel.name, type: channelKind(channel.type), parentName });
    }
    // Grouped by category then name, so the list reads like the Discord sidebar
    // rather than like an id-ordered dump.
    rows.sort((a, b) => (a.parentName ?? "").localeCompare(b.parentName ?? "") || a.name.localeCompare(b.name));
    return rows.slice(0, MAX_ROWS);
  }

  /**
   * What this bot can see and do, as the preflight needs it.
   *
   * `fetchMe` rather than `guild.members.me`, which is null until the member is
   * cached - and a null there would present as "the bot has no permissions",
   * greying out every role in the picker for no reason.
   */
  private async botFacts(guild: Guild): Promise<BotFacts> {
    try {
      const me = await guild.members.fetchMe();
      return {
        highestPosition: me.roles.highest.position,
        canManageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
      };
    } catch {
      // Unknown is treated as powerless: refusing to offer a role we might not
      // be able to grant is the recoverable half of that mistake.
      return { highestPosition: 0, canManageRoles: false };
    }
  }

  private facts(role: Role, guild: Guild): RoleFacts {
    return {
      id: role.id,
      name: role.name,
      position: role.position,
      managed: role.managed,
      isEveryone: role.id === guild.id,
      permissions: role.permissions.bitfield,
    };
  }

  private async roles(guild: Guild, query: string): Promise<readonly RoleRow[]> {
    const bot = await this.botFacts(guild);
    const rows: RoleRow[] = [];
    for (const role of guild.roles.cache.values()) {
      if (role.id === guild.id) continue; // @everyone is never a useful pick
      if (!matches(query, role.name)) continue;
      const facts = this.facts(role, guild);
      const refusal = refuseRole(facts, bot);
      rows.push({
        id: role.id,
        name: role.name,
        color: role.color,
        position: role.position,
        managed: role.managed,
        assignable: refusal === null,
        blockedReason: refusal === null ? null : describeRefusal(refusal, facts),
      });
    }
    // Highest first: the role someone is looking for is nearly always near the top.
    rows.sort((a, b) => b.position - a.position);
    return rows.slice(0, MAX_ROWS);
  }

  /**
   * What one member holds *right now*, straight off the gateway.
   *
   * Deliberately not the cached roster: this exists for callers whose mirrored
   * copy of the roster is the thing they have reason to doubt, and answering
   * them from a minute-old cache would be answering a different question. One
   * member is one fetch, which is why this is affordable where re-fetching the
   * whole roster would not be.
   *
   * `present: false` is an answer, not an error - people leave - and is kept
   * distinct from the failures above, which return no answer at all.
   */
  private async memberRoles(guild: Guild, userId: string): Promise<{
    ok: boolean;
    present: boolean;
    roleIds: readonly string[];
    error?: string;
  }> {
    if (userId === "") return { ok: false, present: false, roleIds: [], error: "INVALID_USER" };
    try {
      const member = await guild.members.fetch(userId);
      return { ok: true, present: true, roleIds: [...member.roles.cache.keys()] };
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === 10007) {
        return { ok: true, present: false, roleIds: [] };
      }
      return { ok: false, present: false, roleIds: [], error: describeError(error) };
    }
  }

  /**
   * `all` lifts the row cap, for the `discord-member-sync` job only.
   *
   * A picker showing 200 of 3,000 members is a truncated list someone types past;
   * a *sync* seeing 200 of 3,000 would record the other 2,800 as having left the
   * server. The two callers want genuinely different things, so the dangerous one
   * has to ask for it by name rather than inherit it by default.
   */
  private async members(guild: Guild, query: string, all = false): Promise<readonly MemberRow[]> {
    const roster = await this.roster(guild);
    const filtered = roster.filter((m) => matches(query, m.username, m.globalName, m.nick, m.id));
    return all ? filtered : filtered.slice(0, MAX_ROWS);
  }

  /**
   * The whole roster, cached briefly. `members.fetch()` needs the Server Members
   * privileged intent; without it Discord returns only the bot itself, which
   * presents as an almost-empty picker rather than an error — hence the warning.
   */
  private async roster(guild: Guild): Promise<readonly MemberRow[]> {
    const cached = this.rosters.get(guild.id);
    if (cached && Date.now() - cached.at < MEMBER_CACHE_MS) return cached.rows;

    const fetched = await guild.members.fetch();
    const rows: MemberRow[] = [...fetched.values()].map((m) => ({
      id: m.id,
      username: m.user.username,
      globalName: m.user.globalName,
      nick: m.nickname,
      avatarHash: m.user.avatar,
      roleIds: [...m.roles.cache.keys()],
      joinedAt: m.joinedAt?.toISOString() ?? null,
      bot: m.user.bot,
    }));
    rows.sort((a, b) => (a.nick ?? a.globalName ?? a.username).localeCompare(b.nick ?? b.globalName ?? b.username));

    if (rows.length <= 1 && guild.memberCount > 1) {
      this.log.warn("member fetch returned almost nothing — is the Server Members intent enabled?", {
        guildId: guild.id,
        fetched: rows.length,
        memberCount: guild.memberCount,
      });
    }
    this.rosters.set(guild.id, { rows, at: Date.now() });
    return rows;
  }

/**
   * Post a card into one of this server's channels on a caller's behalf.
   *
   * The panel needs this because it has no gateway: it can decide a member is
   * banned, write the case and mirror it for the relay, and then have nothing
   * to say about it in the guild's moderation log. That was the whole of the
   * "moderation actions never reach modlog" bug — not a broken renderer or an
   * unbound slot, but the one process that issues most of the actions being
   * physically unable to post.
   *
   * Deliberately dumb: the caller names the channel, because the caller is the
   * one holding the guild's channel-slot configuration and already resolves
   * slots for its own purposes. This end renders and sends, and answers whether
   * it landed so the caller can fall through to its next slot.
   *
   * Mentions are parsed off unconditionally. A moderation card names the member
   * it is about, and a log that pings somebody every time they are warned is a
   * log staff mute — and this route is reachable by any holder of the internal
   * token, so the guarantee belongs here rather than in each caller.
   */
  private async announce(guild: Guild, body: unknown): Promise<{ ok: boolean; error?: string }> {
    const b = (body ?? {}) as Record<string, unknown>;
    const channelId = str(b["channelId"]);
    const view = b["embed"];
    if (channelId === null) return { ok: false, error: "INVALID_CHANNEL" };
    if (typeof view !== "object" || view === null || Array.isArray(view)) {
      return { ok: false, error: "INVALID_EMBED" };
    }

    // Fetched through the guild rather than the client so a caller cannot use
    // one server's token grant to post into another server's channel.
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return { ok: false, error: "CHANNEL_NOT_FOUND" };

    try {
      await channel.send({
        ...containerMessage(view as EmbedView),
        allowedMentions: { parse: [] },
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof DiscordAPIError) {
        if (error.code === 50013 || error.code === 50001) return { ok: false, error: "MISSING_PERMISSION" };
        return { ok: false, error: error.message };
      }
      return { ok: false, error: error instanceof Error ? error.message : "FAILED" };
    }
  }

  /**
   * Panel-issued Discord enforcement. The panel records the action and mirrors
   * it for the relay itself; this is the half that actually removes someone.
   */
  private async enforce(guild: Guild, body: unknown): Promise<{ ok: boolean; error?: string }> {
    const b = (body ?? {}) as Record<string, unknown>;
    const type = str(b["type"]);
    const userId = str(b["userId"]);
    const reason = str(b["reason"]) ?? "No reason given";
    const seconds = typeof b["durationSeconds"] === "number" ? b["durationSeconds"] : null;
    if (userId === null) return { ok: false, error: "INVALID_USER" };

    try {
      switch (type) {
        case "KICK":
          await guild.members.kick(userId, reason);
          return { ok: true };
        case "BAN":
          await guild.members.ban(userId, { reason });
          return { ok: true };
        case "UNBAN":
          await guild.bans.remove(userId, reason);
          return { ok: true };
        case "TIMEOUT": {
          // Discord caps communication timeouts at 28 days; a longer mute is a
          // ban's job, so clamp rather than fail the whole action.
          const ms = Math.min((seconds ?? 0) * 1000, 28 * 24 * 60 * 60 * 1000);
          if (ms <= 0) return { ok: false, error: "INVALID_DURATION" };
          const member = await guild.members.fetch(userId);
          await member.timeout(ms, reason);
          return { ok: true };
        }
        case "UNTIMEOUT": {
          const member = await guild.members.fetch(userId);
          await member.timeout(null, reason);
          return { ok: true };
        }
        default:
          return { ok: false, error: "UNKNOWN_TYPE" };
      }
    } catch (error) {
      if (error instanceof DiscordAPIError) {
        // 10007 unknown member and 10026 unknown ban both mean "already in the
        // state you asked for", which is a success from the caller's point of view.
        if (error.code === 10007 || error.code === 10026) return { ok: true };
        if (error.code === 50013 || error.code === 50001) return { ok: false, error: "MISSING_PERMISSION" };
        return { ok: false, error: error.message };
      }
      return { ok: false, error: error instanceof Error ? error.message : "FAILED" };
    }
  }

  /**
   * Grant and revoke roles, having first decided that we are allowed to.
   *
   * Idempotent by construction: a role the member already holds is not added
   * again and one they do not hold is not removed, so a reconciler that runs
   * every few minutes costs Discord nothing on the passes where nothing
   * changed. The response reports what actually happened rather than what was
   * asked for, because the caller writes a ledger from it and a ledger of
   * intentions is worse than no ledger at all.
   */
  private async applyRoles(guild: Guild, body: unknown): Promise<RoleApplyResult> {
    const b = (body ?? {}) as Record<string, unknown>;
    const userId = str(b["userId"]);
    const reason = str(b["reason"]) ?? "Automatic role";
    const wantAdd = ids(b["add"]);
    const wantRemove = ids(b["remove"]);
    if (userId === null) {
      return { ok: false, memberPresent: false, added: [], removed: [], refused: [], error: "INVALID_USER" };
    }
    if (wantAdd.length === 0 && wantRemove.length === 0) {
      return { ok: true, memberPresent: true, added: [], removed: [], refused: [] };
    }

    let member;
    try {
      member = await guild.members.fetch(userId);
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === 10007) {
        // Left the server between the reconciler reading and this call. There
        // is nothing to do and nothing went wrong.
        return { ok: true, memberPresent: false, added: [], removed: [], refused: [] };
      }
      return {
        ok: false,
        memberPresent: false,
        added: [],
        removed: [],
        refused: [],
        error: describeError(error),
      };
    }

    const bot = await this.botFacts(guild);
    const refused: RefusedRole[] = [];
    const held = new Set(member.roles.cache.keys());

    const screen = (roleId: string, direction: "ADD" | "REMOVE"): boolean => {
      const role = guild.roles.cache.get(roleId) ?? null;
      const facts = role === null ? null : this.facts(role, guild);
      const refusal = refuseRole(facts, bot);
      // Removal is screened more loosely on purpose. Taking authority away is
      // never the dangerous direction, and a role that was harmless when it was
      // granted and has since been given Manage Roles is precisely the one we
      // most need to be able to revoke.
      if (refusal === "DANGEROUS_PERMISSION" && direction === "REMOVE") return true;
      if (refusal === null) return true;
      refused.push({ roleId, reason: refusal, detail: describeRefusal(refusal, facts) });
      return false;
    };

    const toAdd = wantAdd.filter((id) => !held.has(id) && screen(id, "ADD"));
    const toRemove = wantRemove.filter((id) => held.has(id) && screen(id, "REMOVE"));

    try {
      if (toAdd.length > 0) await member.roles.add(toAdd, reason);
      if (toRemove.length > 0) await member.roles.remove(toRemove, reason);
    } catch (error) {
      this.log.warn("role apply failed", {
        guildId: guild.id,
        userId,
        add: toAdd.length,
        remove: toRemove.length,
        error: describeError(error),
      });
      // Partial application is possible here - the add may have landed and the
      // remove failed. Nothing is claimed in that case: the caller records no
      // ledger rows, and the next reconcile sees the real state and finishes
      // the job. Over-reporting would leave a grant recorded that never
      // happened, which is the one error this ledger cannot heal from.
      return { ok: false, memberPresent: true, added: [], removed: [], refused, error: describeError(error) };
    }

    if (toAdd.length > 0 || toRemove.length > 0) {
      this.log.info("roles applied", { guildId: guild.id, userId, added: toAdd, removed: toRemove, reason });
    }
    return { ok: true, memberPresent: true, added: toAdd, removed: toRemove, refused };
  }

  /**
   * Mirrors a platform event onto Discord's own scheduled-events surface.
   *
   * Here rather than in the bridge bot because Discord wants `Manage Events`
   * for it, and the bridge bot deliberately holds none of the privileged
   * permissions — the same split that puts an automod timeout and a
   * self-service role grant on this side of the loopback hop.
   *
   * Create and edit are one route because the caller does not want to know
   * which it is doing: it has a row, it wants Discord to agree with the row,
   * and whether that means a POST or a PATCH is a detail of Discord's API. The
   * body carries `discordEventId` when there is already one to bring in line.
   *
   * The response always carries the `url`, because the link is what the caller
   * actually came for — the event message prints it so members can take the
   * reminder — and it is a valid link whether or not this call changed anything.
   */
  private async scheduledEvent(
    guild: Guild,
    body: unknown,
  ): Promise<{ ok: boolean; id?: string; url?: string; error?: string }> {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = str(b["name"]);
    const startsAt = str(b["startsAt"]);
    const endsAt = str(b["endsAt"]);
    const description = str(b["description"]);
    const existingId = str(b["discordEventId"]);
    const wanted = eventStatus(str(b["status"]));

    try {
      if (existingId !== null) return await this.editScheduledEvent(guild, existingId, b, wanted);
      if (name === null || startsAt === null) return { ok: false, error: "INVALID_INPUT" };

      const created = await guild.scheduledEvents.create({
        name: name.slice(0, EVENT_NAME_MAX),
        scheduledStartTime: startsAt,
        // EXTERNAL is the only entity type that doesn't require a voice channel,
        // and a Skyblock competition happens outside Discord by definition.
        ...(endsAt === null ? {} : { scheduledEndTime: endsAt }),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: (str(b["location"]) ?? "Hypixel Skyblock").slice(0, EVENT_LOCATION_MAX) },
        ...(description === null ? {} : { description: description.slice(0, EVENT_DESCRIPTION_MAX) }),
      });
      return { ok: true, id: created.id, url: created.url };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "FAILED" };
    }
  }

  /**
   * Bring an existing native event in line with the row it mirrors.
   *
   * A status move and a content revision are never sent together. Discord
   * refuses to change the times of an event that has already started and
   * refuses to touch a finished one at all, so the transition is asked for on
   * its own and the details are only revised while the event is still merely
   * scheduled. Anything else is left alone rather than attempted and logged.
   */
  private async editScheduledEvent(
    guild: Guild,
    discordEventId: string,
    b: Record<string, unknown>,
    wanted: GuildScheduledEventStatus | null,
  ): Promise<{ ok: boolean; id?: string; url?: string; error?: string }> {
    const existing = await guild.scheduledEvents.fetch(discordEventId).catch(() => null);
    // Gone means gone: an event a moderator deleted is not resurrected here,
    // because recreating it would undo a deliberate act on every redraw.
    if (existing === null) return { ok: false, error: "NOT_FOUND" };

    const next = wanted === null ? null : nextEventStatus(existing.status, wanted);
    const name = str(b["name"]);
    const startsAt = str(b["startsAt"]);
    const endsAt = str(b["endsAt"]);
    const description = str(b["description"]);

    if (next !== null) {
      await existing.edit({ status: next }).catch(() => undefined);
    } else if (existing.status === GuildScheduledEventStatus.Scheduled && name !== null && startsAt !== null) {
      await existing
        .edit({
          name: name.slice(0, EVENT_NAME_MAX),
          description: description === null ? "" : description.slice(0, EVENT_DESCRIPTION_MAX),
          scheduledStartTime: startsAt,
          ...(endsAt === null ? {} : { scheduledEndTime: endsAt }),
        })
        .catch(() => undefined);
    }

    // The link is what the caller came for, and it survives an edit Discord
    // declined — a finished event still has a page worth pointing at.
    return { ok: true, id: existing.id, url: existing.url };
  }

}

/**
 * Build and start the API, or explain why it stayed down. Returns null when no
 * token is configured — the panel treats that as "no directory available" and
 * falls back to raw-ID fields, which is the pre-picker behaviour.
 */
export async function startInternalApi(deps: InternalApiDeps): Promise<InternalApi | null> {
  if (deps.token === "") return null;
  const api = new InternalApi(deps);
  await api.start();
  return api;
}
