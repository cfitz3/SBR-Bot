/**
 * Watching guild chat for the answer to a command we just typed.
 *
 * The delivery ack says the bridge typed the line. That is not the same as
 * Hypixel running it, and the difference is the whole reason a `/g kick` could
 * be recorded as a completed ban while the member kept their guild slot:
 * Hypixel refuses a kick with no reason, a kick against a name it cannot find,
 * and a kick by an account without the rank to do it — and every one of those
 * looks, from the bridge's side, exactly like a kick that worked.
 *
 * So each outbound moderation command is watched for a short window, and the
 * guild's own reply settles it.
 *
 * **This is best-effort, deliberately.** The success notices come from
 * `parseModNotice`, which is already documented as reading a format nobody
 * versions. The refusals below are a hand-collected table of strings Hypixel
 * prints today. A window that ends with nothing recognised is reported as
 * *unconfirmed*, never as failure — an unrecognised line must not turn a kick
 * that landed into a red case.
 */
import { stripMinecraftColors } from "@sbr/bridge";
import { isPunitiveNotice, parseModNotice, type ModNoticeKind } from "./mod-notice.js";

/** How long to wait for the guild to say something about a command. */
export const ECHO_WINDOW_MS = 10_000;

/**
 * How long a kick we performed is remembered, so the notice it produces is not
 * also read as somebody else's in-game kick and mirrored back into Discord.
 * Generous relative to the window: the guard costs nothing, a double punishment
 * costs a member their Discord account twice over.
 */
export const ECHO_MEMORY_MS = 120_000;

/**
 * Refusals Hypixel prints instead of running the command.
 *
 * Matched against the whole line after colour codes are stripped, and kept in
 * one exported table rather than scattered through the matcher so that when
 * Hypixel rewords one of them there is a single place to fix and a single place
 * to read to know what is covered.
 */
export const HYPIXEL_REFUSALS: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /you must be the guild master/i, why: "the bridge account is not the Guild Master" },
  { re: /you (?:do not|don.t) have permission/i, why: "the bridge account lacks the guild permission" },
  { re: /can.?t find a player by the name of/i, why: "Hypixel does not know that name" },
  { re: /(?:that|this) player is not in your guild/i, why: "the player is not in the guild" },
  { re: /you cannot kick yourself/i, why: "the command targeted the bridge account itself" },
  { re: /you cannot mute yourself/i, why: "the command targeted the bridge account itself" },
  { re: /you cannot mute a player with a higher rank/i, why: "the target outranks the bridge account" },
  { re: /invalid usage/i, why: "Hypixel rejected the command's form" },
  { re: /^unknown command/i, why: "Hypixel did not recognise the command" },
  { re: /is already muted/i, why: "the player is already muted" },
  { re: /you are not in a guild/i, why: "the bridge account is not in a guild" },
];

/** What a typed command was trying to make happen. */
export interface CommandIntent {
  readonly kind: ModNoticeKind;
  /** Lower-cased, for comparison against the name in the notice. */
  readonly target: string;
}

/**
 * Read the intent back out of a command line.
 *
 * Only the guild moderation verbs: a `/guild accept` has its own reporting and
 * a `/g online` is not a punishment, and watching either would let an unrelated
 * refusal settle a punishment that is still in flight.
 */
export function parseCommandIntent(command: string): CommandIntent | null {
  const m = /^\/g(?:uild)? (kick|mute|unmute|promote|demote) (\w{1,16})\b/i.exec(command.trim());
  if (m === null) return null;
  const verb = (m[1] ?? "").toUpperCase();
  const kind =
    verb === "KICK" || verb === "MUTE" || verb === "UNMUTE" || verb === "PROMOTE" || verb === "DEMOTE"
      ? (verb as ModNoticeKind)
      : null;
  if (kind === null) return null;
  return { kind, target: (m[2] ?? "").toLowerCase() };
}

/** The answer, in the shape the ack channel wants. */
export interface EchoVerdict {
  readonly guildId: string;
  readonly correlationId: string;
  readonly outcome: "CONFIRMED_INGAME" | "REFUSED_INGAME";
  readonly detail: string;
}

export interface CommandEchoDeps {
  readonly onSettle: (verdict: EchoVerdict) => void;
  readonly now?: () => number;
  readonly windowMs?: number;
  readonly memoryMs?: number;
}

interface Watch {
  readonly guildId: string;
  readonly correlationId: string;
  readonly command: string;
  readonly intent: CommandIntent;
  readonly at: number;
}

export class CommandEcho {
  private readonly deps: CommandEchoDeps;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly memoryMs: number;
  private watches: Watch[] = [];
  /** Lower-cased IGN, and when we kicked them. */
  private readonly ourKicks = new Map<string, number>();

  constructor(deps: CommandEchoDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.windowMs = deps.windowMs ?? ECHO_WINDOW_MS;
    this.memoryMs = deps.memoryMs ?? ECHO_MEMORY_MS;
  }

  /** Start watching for the answer to a command that has just been typed. */
  watch(guildId: string, correlationId: string, command: string): void {
    const intent = parseCommandIntent(command);
    if (intent === null) return;
    this.expire();
    this.watches.push({ guildId, correlationId, command, intent, at: this.now() });
  }

  /**
   * Offer one chat line to the watchers.
   *
   * Returns whether the line was the answer to something we sent — which is
   * also the echo guard: a kick notice this claims is our own kick coming back,
   * not a staffer acting in game, and must not be mirrored into Discord a
   * second time.
   */
  observe(rawLine: string): boolean {
    this.expire();
    if (this.watches.length === 0) return false;
    const line = stripMinecraftColors(rawLine).trim();
    if (line.length === 0) return false;

    // A refusal names the command, not the player: "You cannot kick yourself"
    // carries nobody to match on. Commands leave this bridge one at a time and
    // paced, so the oldest command still waiting is the one being refused.
    const refusal = HYPIXEL_REFUSALS.find((r) => r.re.test(line));
    if (refusal !== undefined) {
      const watch = this.watches.shift();
      if (watch === undefined) return false;
      this.deps.onSettle({
        guildId: watch.guildId,
        correlationId: watch.correlationId,
        outcome: "REFUSED_INGAME",
        detail: `Hypixel refused \`${watch.command}\` — ${refusal.why} ("${line}")`,
      });
      return true;
    }

    const notice = parseModNotice(line);
    if (notice === null || !isPunitiveNotice(notice)) return false;
    const target = notice.target.toLowerCase();
    const i = this.watches.findIndex((w) => w.intent.kind === notice.kind && w.intent.target === target);
    if (i === -1) return false;
    const [watch] = this.watches.splice(i, 1);
    if (watch === undefined) return false;
    if (notice.kind === "KICK") this.ourKicks.set(target, this.now());
    this.deps.onSettle({
      guildId: watch.guildId,
      correlationId: watch.correlationId,
      outcome: "CONFIRMED_INGAME",
      detail: line,
    });
    return true;
  }

  /**
   * Did this bridge kick that player recently?
   *
   * The mirror asks before treating a kick notice as somebody's in-game
   * decision. Without it, a Discord ban would relay a `/g kick`, read its own
   * notice back, and mirror it into a second punishment.
   */
  claimedKick(ign: string): boolean {
    const key = ign.toLowerCase();
    const at = this.ourKicks.get(key);
    if (at === undefined) return false;
    if (this.now() - at > this.memoryMs) {
      this.ourKicks.delete(key);
      return false;
    }
    return true;
  }

  /** Watchers past their window, and kicks past living memory. */
  private expire(): void {
    const cutoff = this.now() - this.windowMs;
    // Nothing is settled on the way out: a window that ends quietly means the
    // guild said nothing we recognised, which the waiting publisher already
    // reports as unconfirmed. Calling it a refusal here would make every
    // reworded Hypixel notice look like a failed punishment.
    this.watches = this.watches.filter((w) => w.at > cutoff);
    const forget = this.now() - this.memoryMs;
    for (const [ign, at] of this.ourKicks) if (at <= forget) this.ourKicks.delete(ign);
  }
}
