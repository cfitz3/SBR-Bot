/**
 * The staff side of the guild door, and of the roster behind it.
 *
 * Screening on its own only ever *reports*. `ScreeningService.screen()` decides
 * a verdict and writes a row; whether the guild door actually opens is a
 * separate act, and until this file existed there was exactly one way to
 * perform it — the bridge's own auto-accept. With auto-accept off, which is the
 * default and the setting most guilds want, a request was screened, recorded,
 * written up for staff, and then nothing could be done about it from anywhere
 * on the platform.
 *
 * So this is the missing half. It has since grown past the door to cover the
 * rest of the roster — kick, mute, promote, demote — because those have the
 * same shape and the same hazards, and a second module would have grown a
 * second, subtly different copy of the guards below.
 *
 * Four properties are worth stating, because each is a bug that would otherwise
 * be easy to write:
 *
 * - **Every argument is validated before it becomes a command.** Everything
 *   here is ultimately typed into a Minecraft chat box by the bridge account. A
 *   name is `[A-Za-z0-9_]{1,16}` and nothing else; anything containing a space
 *   could append a second argument, and anything containing a newline could
 *   append a second *command*. The same goes for mute durations and kick
 *   reasons, which are the two places a caller supplies free text.
 * - **The row is only decided once the command is away.** Recording ACCEPTED
 *   for a command that was never sent is worse than recording nothing: it makes
 *   the platform's history disagree with the guild's, silently, in the
 *   direction of "we handled it".
 * - **A name we cannot resolve is still actionable.** Hypixel's uuid lookup is
 *   the flakiest dependency in the building, and staff typing `/join-accept` on
 *   somebody they can see in the request notice should not be refused because a
 *   third party is down. The command is sent; the caller is told the row could
 *   not be matched.
 * - **Admission is on a clock.** A join request expires five minutes after it
 *   is made (see `window.ts`), and `/guild accept` past that point is an error
 *   upstream, not a slow success. `admit()` is the entry point that knows this;
 *   `accept()` remains available for callers that have already decided.
 */
import type { Logger } from "@sbr/observability";
import type { ScreeningService } from "./service.js";
import type { ScreeningRecord } from "./ports.js";
import type { ScreeningOutcome } from "./types.js";
import { remainingWindowMs, windowClosed } from "./window.js";

/** A Minecraft username and nothing else. See the header. */
const IGN = /^[A-Za-z0-9_]{1,16}$/;

/**
 * A Hypixel mute duration: a count and a unit, e.g. `30m`, `1h`, `7d`.
 *
 * Hypixel parses this itself and rejects what it does not like, but an
 * unvalidated value would reach it as a second chat argument, and "let the
 * remote end sanitise our command line" is not a security posture.
 */
const DURATION = /^[1-9][0-9]{0,2}[smhd]$/;

/**
 * A kick reason, which is the one genuinely free-text field on this surface.
 *
 * Restrictive on purpose: no slash (so a reason cannot begin a second command
 * even if Hypixel's parser were persuaded to see one), no newline, and no
 * section sign, which is Minecraft's formatting escape and would let a reason
 * recolour or blank the rest of the line it appears in.
 */
const REASON = /^[A-Za-z0-9 .,!?'()_-]{1,64}$/;

/**
 * Where a guild command goes.
 *
 * Returns false when it could not be handed off — an unresolved guild, a full
 * backlog, no bridge listening. False is not an error; it is the honest answer
 * that the door did not move, and the caller reports it rather than pretending.
 */
export interface GuildCommandSender {
  send(guildId: string, command: string): Promise<boolean> | boolean;
}

/** IGN → uuid, for matching a typed name back to its pending row. */
export interface JoinPlayerLookup {
  resolveIgn(ign: string): Promise<{ readonly uuid: string; readonly ign: string } | null>;
}

export interface JoinQueueDeps {
  readonly screening: ScreeningService;
  readonly commands: GuildCommandSender;
  readonly logger: Logger;
  /** Without it, a decision is sent but never matched to a row. */
  readonly players?: JoinPlayerLookup;
  readonly now?: () => Date;
}

export type JoinActionFailure =
  /** The name is not a Minecraft username. Nothing was sent. */
  | "BAD_NAME"
  /** The mute duration is not a count and a unit. Nothing was sent. */
  | "BAD_DURATION"
  /** The kick reason contains something that must not reach a chat box. */
  | "BAD_REASON"
  /** The bridge could not take the command. Nothing was sent, nothing recorded. */
  | "NOT_SENT";

export type JoinActionResult =
  | {
      readonly ok: true;
      /** The name as sent, in the casing Mojang reports where we could get it. */
      readonly ign: string;
      /** True when a pending screening row was found and marked. */
      readonly recorded: boolean;
      /** Set when the screening row was found, for the caller's summary line. */
      readonly screening: ScreeningRecord | null;
    }
  | { readonly ok: false; readonly reason: JoinActionFailure };

/**
 * The outcome of answering a live request.
 *
 * `via` is the part callers must report rather than swallow: an invite is not a
 * quieter accept. It puts the ball back in the applicant's court — they have to
 * see the invite and take it — so a staffer told only "done" would reasonably
 * believe somebody is in the guild who is not.
 */
export type AdmitResult =
  | {
      readonly ok: true;
      readonly via: "ACCEPT" | "INVITE";
      readonly ign: string;
      readonly recorded: boolean;
      readonly screening: ScreeningRecord | null;
      /** Milliseconds of request window left when we acted. Zero after an invite. */
      readonly remainingMs: number;
    }
  | { readonly ok: false; readonly reason: JoinActionFailure };

/**
 * What each action does, in one table, so they cannot drift apart.
 *
 * `outcome` is the screening state the action implies, or null for actions that
 * are not answers to a join request. Kicking somebody is a statement about a
 * member, not about an application, and marking their months-old screening row
 * DENIED because they were kicked today would corrupt the only record of what
 * we knew when we let them in.
 */
const ACTIONS = {
  ACCEPT: { verb: "accept", outcome: "ACCEPTED", arg: "none" },
  DENY: { verb: "deny", outcome: "DENIED", arg: "none" },
  INVITE: { verb: "invite", outcome: null, arg: "none" },
  KICK: { verb: "kick", outcome: null, arg: "reason" },
  MUTE: { verb: "mute", outcome: null, arg: "duration" },
  UNMUTE: { verb: "unmute", outcome: null, arg: "none" },
  PROMOTE: { verb: "promote", outcome: null, arg: "none" },
  DEMOTE: { verb: "demote", outcome: null, arg: "none" },
} as const satisfies Record<string, { verb: string; outcome: ScreeningOutcome | null; arg: "none" | "reason" | "duration" }>;

export type JoinAction = keyof typeof ACTIONS;

export class JoinQueueService {
  private readonly d: JoinQueueDeps;
  private readonly log: Logger;

  constructor(deps: JoinQueueDeps) {
    this.d = deps;
    this.log = deps.logger.child({ component: "join-queue" });
  }

  /** Everyone screened and still answerable, oldest first. */
  async pending(guildId: string, limit = 25): Promise<readonly ScreeningRecord[]> {
    return this.d.screening.pending(guildId, limit);
  }

  /**
   * Let somebody in, by whichever route still works.
   *
   * `/guild accept` only exists for the five minutes Hypixel keeps a request.
   * Past that the request is gone upstream and the only way to admit the person
   * is `/guild invite`, which is a materially different act — it needs *them*
   * to accept — so this both switches route and reports which route it took.
   *
   * The decision reads the newest request on record rather than the queue,
   * because the queue retires stale rows and a retired row is exactly the
   * evidence that an invite is needed. Three cases:
   *
   * - a request still inside its window: accept, which is the fast path and the
   *   one the bridge's own auto-accept takes;
   * - a request past its window, whether or not the sweep has got to it yet:
   *   invite, and make sure the row is retired;
   * - no request we can see at all: accept. The likely explanation is a request
   *   we did not witness — the bridge was down when it arrived — and Hypixel
   *   refusing an accept costs one line in chat, whereas inviting somebody who
   *   is in fact standing at the door is refused *and* leaves their live
   *   request unanswered while its clock runs down.
   */
  async admit(guildId: string, rawIgn: string, actorId: string): Promise<AdmitResult> {
    const typed = rawIgn.trim();
    if (!IGN.test(typed)) {
      this.log.warn("admit refused: not a Minecraft name", { guildId });
      return { ok: false, reason: "BAD_NAME" };
    }

    const resolved = await this.resolve(typed);
    const row = await this.d.screening.latestRequest(guildId, resolved?.uuid ?? null, typed);
    const now = this.d.now?.() ?? new Date();
    const lapsed =
      row !== null &&
      (row.outcome === "EXPIRED" || (row.outcome === "PENDING" && windowClosed(row.requestedAt, now)));

    if (lapsed && row !== null) {
      // Retired first, and regardless of whether the invite lands. The row
      // describes a request Hypixel has already forgotten; leaving it PENDING
      // would put it back in the queue for the next staffer to try.
      if (row.outcome === "PENDING") await this.d.screening.decide(row.id, "EXPIRED", actorId);
      this.log.info("join window closed; inviting instead", { guildId, ign: typed, actor: actorId });
      const invited = await this.act("INVITE", guildId, typed, actorId);
      return invited.ok
        ? { ok: true, via: "INVITE", ign: invited.ign, recorded: true, screening: row, remainingMs: 0 }
        : invited;
    }

    const accepted = await this.act("ACCEPT", guildId, typed, actorId);
    if (!accepted.ok) return accepted;
    return {
      ok: true,
      via: "ACCEPT",
      ign: accepted.ign,
      recorded: accepted.recorded,
      screening: accepted.screening,
      // Only a request still awaiting an answer has a window worth quoting; a
      // row we already decided is not a countdown, it is history.
      remainingMs: row !== null && row.outcome === "PENDING" ? remainingWindowMs(row.requestedAt, now) : 0,
    };
  }

  /**
   * Admit an applicant who has asked, without consulting the clock.
   *
   * Prefer `admit()` from a staff surface. This stays public for the bridge's
   * own auto-accept, which fires seconds after the request and would only be
   * slowed down by a second database read to confirm what it just saw.
   */
  async accept(guildId: string, ign: string, actorId: string): Promise<JoinActionResult> {
    return this.act("ACCEPT", guildId, ign, actorId);
  }

  /** Refuse one. */
  async deny(guildId: string, ign: string, actorId: string): Promise<JoinActionResult> {
    return this.act("DENY", guildId, ign, actorId);
  }

  /**
   * Invite somebody who never asked.
   *
   * Not interchangeable with accept: Hypixel refuses `invite` for a player with
   * a pending request and refuses `accept` for one without, so the two stay
   * separate commands rather than one that guesses.
   */
  async invite(guildId: string, ign: string, actorId: string): Promise<JoinActionResult> {
    return this.act("INVITE", guildId, ign, actorId);
  }

  /** Remove a member. The reason, if given, is shown in-game. */
  async kick(guildId: string, ign: string, actorId: string, reason?: string): Promise<JoinActionResult> {
    return this.act("KICK", guildId, ign, actorId, reason);
  }

  /** Silence a member in guild chat for a Hypixel duration such as `30m`. */
  async mute(guildId: string, ign: string, actorId: string, duration: string): Promise<JoinActionResult> {
    return this.act("MUTE", guildId, ign, actorId, duration);
  }

  async unmute(guildId: string, ign: string, actorId: string): Promise<JoinActionResult> {
    return this.act("UNMUTE", guildId, ign, actorId);
  }

  /** Raise a member one guild rank. Hypixel decides which; we only ask. */
  async promote(guildId: string, ign: string, actorId: string): Promise<JoinActionResult> {
    return this.act("PROMOTE", guildId, ign, actorId);
  }

  async demote(guildId: string, ign: string, actorId: string): Promise<JoinActionResult> {
    return this.act("DEMOTE", guildId, ign, actorId);
  }

  private async act(
    action: JoinAction,
    guildId: string,
    rawIgn: string,
    actorId: string,
    rawExtra?: string,
  ): Promise<JoinActionResult> {
    const typed = rawIgn.trim();
    if (!IGN.test(typed)) {
      this.log.warn("guild action refused: not a Minecraft name", { action, guildId });
      return { ok: false, reason: "BAD_NAME" };
    }

    const { verb, outcome, arg } = ACTIONS[action];

    const extra = rawExtra?.trim() ?? "";
    if (arg === "duration" && !DURATION.test(extra)) {
      this.log.warn("guild action refused: not a duration", { action, guildId });
      return { ok: false, reason: "BAD_DURATION" };
    }
    // A reason is optional; only a reason that was *given* has to be clean.
    if (arg === "reason" && extra !== "" && !REASON.test(extra)) {
      this.log.warn("guild action refused: reason contains something unsendable", { action, guildId });
      return { ok: false, reason: "BAD_REASON" };
    }

    // Resolved first, so the command carries Mojang's casing and so the row can
    // be found — but a failure here is not fatal, only unrecorded.
    const resolved = await this.resolve(typed);
    const ign = resolved?.ign ?? typed;

    const suffix = arg === "none" || extra === "" ? "" : ` ${extra}`;
    const sent = await this.d.commands.send(guildId, `/guild ${verb} ${ign}${suffix}`);
    if (!sent) {
      this.log.warn("guild action not sent", { action, guildId, ign });
      return { ok: false, reason: "NOT_SENT" };
    }

    if (outcome === null || resolved === null) {
      if (outcome !== null) this.log.warn("guild action sent but not recorded: name unresolved", { action, ign });
      return { ok: true, ign, recorded: false, screening: null };
    }

    const row = await this.d.screening.findPending(guildId, resolved.uuid);
    if (row === null) {
      // Common and legitimate: staff accepting somebody whose request predates
      // the bridge being up, or who was screened under a different name.
      this.log.info("guild action sent with no pending row to mark", { action, ign });
      return { ok: true, ign, recorded: false, screening: null };
    }

    await this.d.screening.decide(row.id, outcome satisfies ScreeningOutcome, actorId);
    this.log.info("guild action recorded", { action, guildId, ign, actor: actorId, screeningId: row.id });
    return { ok: true, ign, recorded: true, screening: row };
  }

  private async resolve(ign: string): Promise<{ readonly uuid: string; readonly ign: string } | null> {
    if (!this.d.players) return null;
    try {
      return await this.d.players.resolveIgn(ign);
    } catch (e) {
      this.log.warn("could not resolve applicant name", { ign, err: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }
}
