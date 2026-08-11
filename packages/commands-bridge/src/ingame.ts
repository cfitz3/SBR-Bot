/**
 * The in-game `!` command surface (COMMANDS.md §17).
 *
 * Guild chat is a hostile place to run commands from: there are no typed
 * options, no ephemeral replies, no proven Discord identity, a hard ~256-char
 * line limit, and Hypixel rate-limits the bridge account itself. So this module
 * is a *translation layer* over the existing `CommandDispatcher` rather than a
 * second command implementation — the same specs, the same handlers, the same
 * services. What it adds is:
 *
 *  - prefix parsing and positional → named argument mapping,
 *  - an allow-list: only specs carrying `inGame: true` are reachable, so no
 *    moderation, config, or linking command can be driven from chat,
 *  - identity by IGN → linked Discord id, with public lookups still working for
 *    unlinked players,
 *  - a stricter per-IGN cooldown on top of the dispatcher's per-user one,
 *  - collapsing a rich reply to a single truncated line.
 */
import type { CommandArgs, CommandSurface } from "@sbr/shared-types";
import { recordArgs } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { CommandDispatcher } from "./dispatcher.js";
import type { CommandReply, CommandSpec, CooldownGate } from "./types.js";

/** Default trigger. Overridable per guild (`GuildConfig.commandPrefix`). */
export const INGAME_PREFIX = "!";

/**
 * Minecraft's chat packet is capped at 256 characters. This is a hard protocol
 * limit, not a display one: 1.8 servers commonly kick a client that exceeds it,
 * which surfaces as an unexplained bridge disconnect rather than a clipped line.
 */
export const GAME_CHAT_LIMIT = 256;

/**
 * The transport sends replies as `/gc <line>`, so the line itself gets the
 * packet limit minus that prefix. Budgeting for it here rather than in the
 * transport keeps the one place that truncates also the one place that knows
 * the real ceiling — the previous split let a maximum-length reply become a
 * 260-character packet.
 */
export const INGAME_MAX_CHARS = GAME_CHAT_LIMIT - "/gc ".length;

/**
 * Nobody types `!lowestbin` twice. These are the short forms the docs specify
 * plus the obvious contractions; `weight` maps to `stats` because the stats
 * one-liner already ends in the Senither figure.
 */
const ALIASES: Readonly<Record<string, string>> = {
  nw: "networth",
  bz: "bazaar",
  lbin: "lowestbin",
  lb: "lowestbin",
  weight: "stats",
  // Not `lb` — that has meant `lowestbin` since long before the boards existed,
  // and quietly repointing a live shorthand is worse than having no shorthand.
  top: "leaderboard",
  leaderboards: "leaderboard",
  s: "stats",
  sk: "skills",
  sl: "slayers",
  dungs: "dungeons",
  cata: "dungeons",
  run: "runs",
  event: "events",
  h: "help",
  commands: "help",
  // Fun (COMMANDS.md §19). `8b` and `dice` are what chat shortens these to; the
  // rest are the names people reach for before they learn the real one.
  "8b": "8ball",
  eightball: "8ball",
  flip: "coinflip",
  cf: "coinflip",
  dice: "roll",
  quote: "guildquote",
  gq: "guildquote",
};

export interface ParsedInGameCommand {
  /** Canonical command name — aliases are already resolved. */
  readonly name: string;
  readonly tokens: readonly string[];
}

/**
 * Split a guild-chat line into a command and its positional tokens.
 *
 * Returns null for anything that isn't a command, including a bare prefix and
 * `!!!`-style punctuation: guild chat is full of exclamation marks, and a bot
 * that answers every one of them is worse than no bot.
 */
export function parseInGameCommand(line: string, prefix: string = INGAME_PREFIX): ParsedInGameCommand | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(prefix)) return null;

  const rest = trimmed.slice(prefix.length);
  // A space after the prefix means it was punctuation, not a trigger: "! stats"
  // is someone talking, "!stats" is someone asking.
  if (rest === "" || /^\s/.test(rest)) return null;

  const tokens = rest.split(/\s+/).filter((t) => t.length > 0);
  const head = tokens[0];
  if (head === undefined) return null;

  const name = head.toLowerCase();
  // A digit is allowed to lead because `!8ball` is a command people actually
  // type. The pattern's real job is rejecting punctuation — "!!!", "!?" and the
  // rest of what excitable chat produces — and an unrecognised name still ends
  // in silence, so being slightly more permissive here costs nothing.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;

  return { name: ALIASES[name] ?? name, tokens: tokens.slice(1) };
}

/**
 * Map positional tokens onto the spec's declared options.
 *
 * Options are consumed in declaration order, and the last one swallows whatever
 * is left so multi-word values work (`!price enchanted diamond block`). Boolean
 * and numeric coercion is `recordArgs`' job — a token that won't coerce reads as
 * absent, which handlers already treat as "not supplied".
 *
 * Options marked `inGamePositional: false` are skipped entirely. Without that,
 * adding a Discord-only option to a spec would silently re-map guild chat: every
 * declared option takes a token, so a new one in the middle shifts the free-text
 * value at the end onto the wrong field.
 */
export function positionalArgs(spec: CommandSpec, tokens: readonly string[]): CommandArgs {
  const options = (spec.options ?? []).filter((o) => o.inGamePositional !== false);
  const record: Record<string, string> = {};

  for (let i = 0; i < options.length && i < tokens.length; i += 1) {
    const option = options[i]!;
    const last = i === options.length - 1;
    const value = last ? tokens.slice(i).join(" ") : tokens[i]!;
    record[option.name] = value;
  }
  return recordArgs(record);
}

/** The required options a caller left out, for a usage hint. */
function missingRequired(spec: CommandSpec, args: CommandArgs): readonly string[] {
  return (spec.options ?? [])
    .filter((o) => o.required === true && args.getString(o.name) === null)
    .map((o) => o.name);
}

function usageHint(spec: CommandSpec, prefix: string): string {
  const shape = (spec.options ?? [])
    .filter((o) => o.inGamePositional !== false)
    .map((o) => (o.required === true ? `<${o.name}>` : `[${o.name}]`))
    .join(" ");
  return `Usage: ${prefix}${spec.name}${shape ? ` ${shape}` : ""}`;
}

/**
 * Collapse a reply to one guild-chat line.
 *
 * The embed is preferred over `text` when present because it carries the actual
 * numbers — `text` is often just a lead-in ("Here's Steve's profile:") that says
 * nothing on its own. Fields are joined with a pipe, matching the documented
 * `Player — Cata 42 | SA 45.3 | NW 8.2b` shape.
 */
export function toGameLine(reply: CommandReply, max: number = INGAME_MAX_CHARS): string {
  const embed = reply.embed ?? reply.pages?.[0];
  const parts: string[] = [];

  if (embed) {
    if (embed.title) parts.push(embed.title);
    const body = (embed.fields ?? [])
      .map((f) => `${f.name}: ${flatten(f.value)}`)
      .filter((s) => s.length > 0)
      .join(" | ");
    const lead = embed.description ? flatten(embed.description) : "";
    const tail = [lead, body].filter((s) => s.length > 0).join(" | ");
    if (tail) parts.push(tail);
    // The staleness footer is the one piece of an embed a player can act on, so
    // it survives the collapse even though it costs characters.
    if (embed.footer) parts.push(`(${flatten(embed.footer)})`);
  }

  const line = parts.length > 0 ? parts.join(" — ") : flatten(reply.text);
  return truncate(line, max);
}

/** Discord markdown and mentions mean nothing in Minecraft chat. */
function flatten(s: string): string {
  return s
    .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_m, secs: string) => new Date(Number(secs) * 1000).toISOString().slice(0, 16).replace("T", " "))
    .replace(/<@!?(\d+)>/g, "@user")
    .replace(/<#(\d+)>/g, "#channel")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // markdown links → their label
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut on a separator where possible, so a line never ends mid-number. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const seam = head.lastIndexOf(" | ");
  return `${(seam > max / 2 ? head.slice(0, seam) : head).trimEnd()}…`;
}

/**
 * Port: IGN → the Discord id that owns it, or null when the account isn't
 * linked. Narrow on purpose — this is the only thing the in-game surface needs
 * from identity, and widening `IdentityService` for it would touch every
 * consumer of that contract.
 */
export interface InGameIdentity {
  resolveDiscordIdByIgn(ign: string): Promise<string | null>;
}

export interface InGameDispatcherDeps {
  /**
   * Wire this with a permissive `CapabilityChecker`. Authorization for guild
   * chat is made *here* — the `inGame` allow-list plus the link requirement —
   * and it deliberately differs from Discord's: `BridgePermission` rows are
   * granted per Discord user, so reusing that check would leave every unlinked
   * member unable to run `!stats`, which §17 explicitly allows.
   */
  readonly dispatcher: CommandDispatcher;
  readonly identity: InGameIdentity;
  /** Per-IGN gate, separate from the dispatcher's per-user one. */
  readonly cooldowns: CooldownGate;
  readonly logger: Logger;
  readonly prefix?: string;
  /**
   * Floor applied to every in-game command regardless of its slash cooldown.
   * Hypixel rate-limits guild chat itself, and being muted for spam takes the
   * whole bridge down, not just one command.
   */
  readonly minCooldownMs?: number;
}

const DEFAULT_MIN_COOLDOWN_MS = 10_000;

/** Placeholder Discord id for an unlinked player, so public lookups still run. */
const ANONYMOUS = "ingame:anonymous";

const SURFACE: CommandSurface = "INGAME";

export class InGameDispatcher {
  private readonly d: InGameDispatcherDeps;
  private readonly log: Logger;
  private readonly prefix: string;
  private readonly floor: number;

  constructor(deps: InGameDispatcherDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "commands-ingame" });
    this.prefix = deps.prefix ?? INGAME_PREFIX;
    this.floor = deps.minCooldownMs ?? DEFAULT_MIN_COOLDOWN_MS;
  }

  /**
   * Handle one guild-chat line.
   *
   * `null` means "say nothing", which is the right answer far more often than a
   * reply is: a non-command, an unknown word after the prefix, or a cooldown all
   * resolve to silence rather than to chat noise that Hypixel would count
   * against the bridge account.
   */
  async handle(guildId: string, ign: string, line: string): Promise<string | null> {
    const parsed = parseInGameCommand(line, this.prefix);
    if (!parsed) return null;

    const spec = this.d.dispatcher.commands.get(parsed.name);
    // Unknown *and* not-exposed both answer with silence. Naming the commands
    // that exist but are Discord-only would just invite people to try them.
    // This allow-list is the authorization boundary for the whole surface.
    if (!spec || spec.inGame === undefined || spec.inGame === false) return null;

    const args = positionalArgs(spec, parsed.tokens);
    const missing = missingRequired(spec, args);
    if (missing.length > 0) return usageHint(spec, this.prefix);

    // Cooldown before identity: an IGN spamming `!stats` shouldn't cost a DB
    // lookup per line.
    const cooldownMs = Math.max(spec.cooldownMs, this.floor);
    const gate = await this.d.cooldowns.consume(`cd:ingame:${spec.name}:${ign.toLowerCase()}`, cooldownMs);
    if (!gate.allowed) return null;

    const discordId = await this.resolveDiscordId(ign);
    if (discordId === null && spec.inGame === "linked") {
      // Point at the fix rather than failing silently — an unlinked player has
      // no way to tell "not allowed" from "bot is broken" otherwise.
      return `Link your account on Discord first (/link ${ign}) to use ${this.prefix}${spec.name}.`;
    }

    const reply = await this.d.dispatcher.dispatch(spec.name, {
      guildId,
      userId: discordId ?? ANONYMOUS,
      surface: SURFACE,
      args,
    });
    return toGameLine(reply);
  }

  private async resolveDiscordId(ign: string): Promise<string | null> {
    try {
      return await this.d.identity.resolveDiscordIdByIgn(ign);
    } catch (error) {
      // An identity lookup failure shouldn't sink a public lookup — treat it as
      // "not linked" and let the command run anonymously.
      this.log.warn("ign lookup failed", { ign, error: error instanceof Error ? error.message : "unknown" });
      return null;
    }
  }
}
