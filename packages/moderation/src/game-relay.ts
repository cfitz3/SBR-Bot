/**
 * The guild-command bus, with an answer attached.
 *
 * Every process that punishes somebody has, until now, carried its own copy of
 * roughly this: check a heartbeat, publish to Redis, return `true`. All three
 * copies were wrong in the same way. Redis pub/sub has no store-and-forward,
 * the heartbeat is up to 45 seconds stale, and neither of those has anything
 * to say about whether Hypixel ran the line — so `true` meant "a bridge was
 * probably alive recently", and a `/g kick` that Hypixel threw away looked
 * exactly like one it honoured.
 *
 * This waits for the bridge to answer for the command it was given, and
 * reports what came back. The transport is injected, so the moderation package
 * still knows nothing about Redis.
 */
import type { Logger } from "@sbr/observability";
import type { GameCommandBus, GameCommandReceipt } from "./ports.js";

/** One instruction, on its way out. */
export interface RelayInstruction {
  readonly guildId: string;
  readonly kind: "GAME_COMMAND";
  readonly command: string;
  readonly correlationId: string;
}

/** One answer, on its way back. Structurally the redis `ModAckMessage`. */
export interface RelayAck {
  readonly correlationId: string;
  readonly outcome: string;
  readonly detail: string;
}

export interface GameRelayDeps {
  /** Hand the instruction to whoever is listening. */
  publish(message: RelayInstruction): Promise<void>;
  /**
   * Listen for answers. Called once, lazily, and awaited *before* the first
   * publish — subscribing afterwards would race the ack for short commands.
   */
  subscribeAcks(onAck: (ack: RelayAck) => void): Promise<() => void>;
  /**
   * Is a bridge in-game for this guild? Kept as a pre-flight because it is the
   * cheap answer: with no session there is nothing to wait for, and waiting
   * fifteen seconds to discover that would stall every command in the burst.
   */
  live(guildId: string): Promise<boolean>;
  readonly logger: Logger;
  /** How long to wait for a verdict. Defaults to 15s. */
  readonly timeoutMs?: number;
  readonly correlationId?: () => string;
  /** Injected for tests. Returns a cancel function. */
  readonly schedule?: (ms: number, fn: () => void) => () => void;
}

/**
 * Answers that end the wait.
 *
 * `TYPED` is deliberately absent: the bridge saying it typed the line is
 * progress, not a verdict, and treating it as one would restore the exact
 * false success this file exists to remove. It is remembered instead, so a
 * command that Hypixel never comments on can be reported as sent-unconfirmed
 * rather than as never sent at all.
 */
const TERMINAL: ReadonlySet<string> = new Set([
  "CONFIRMED_INGAME",
  "REFUSED_INGAME",
  "WRONG_GUILD",
  "REFUSED_BACKLOG",
  "EXPIRED",
]);

interface Waiter {
  typed: boolean;
  settle(receipt: GameCommandReceipt): void;
}

const defaultSchedule = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => { clearTimeout(t); };
};

export function createGameCommandBus(deps: GameRelayDeps): GameCommandBus {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const schedule = deps.schedule ?? defaultSchedule;
  const newId = deps.correlationId ?? (() => globalThis.crypto.randomUUID());
  const waiting = new Map<string, Waiter>();

  let listening: Promise<boolean> | null = null;
  function listen(): Promise<boolean> {
    listening ??= deps
      .subscribeAcks((ack) => {
        const waiter = waiting.get(ack.correlationId);
        // Not ours, or already settled. Both are ordinary: acks are broadcast
        // to every process on the bus, and only one of them asked.
        if (waiter === undefined) return;
        if (ack.outcome === "TYPED") { waiter.typed = true; return; }
        if (!TERMINAL.has(ack.outcome)) return;
        waiter.settle({ outcome: ack.outcome as GameCommandReceipt["outcome"], detail: ack.detail });
      })
      .then(() => true)
      .catch((error: unknown) => {
        // Reset so a later command retries the subscription rather than being
        // permanently unable to hear an answer because Redis blipped once.
        listening = null;
        deps.logger.error("guild command acks unavailable", { error: String(error) });
        return false;
      });
    return listening;
  }

  return {
    async send(guildId, command): Promise<GameCommandReceipt> {
      if (!(await deps.live(guildId).catch(() => false))) {
        deps.logger.warn("guild command not sent: no bridge is in-game", { guildId });
        return { outcome: "NO_SESSION", detail: "no bridge is in-game for this guild" };
      }

      const heard = await listen();
      const correlationId = newId();

      const answer = heard
        ? new Promise<GameCommandReceipt>((resolve) => {
            const cancel = schedule(timeoutMs, () => {
              const waiter = waiting.get(correlationId);
              waiting.delete(correlationId);
              resolve(
                waiter?.typed === true
                  ? { outcome: "UNCONFIRMED", detail: "typed in guild chat; the guild said nothing either way" }
                  : { outcome: "TIMED_OUT", detail: `no answer from the bridge within ${Math.round(timeoutMs / 1000)}s` },
              );
            });
            waiting.set(correlationId, {
              typed: false,
              settle(receipt) {
                waiting.delete(correlationId);
                cancel();
                resolve(receipt);
              },
            });
          })
        : null;

      try {
        await deps.publish({ guildId, kind: "GAME_COMMAND", command, correlationId });
      } catch (error) {
        waiting.get(correlationId)?.settle({ outcome: "NO_SESSION", detail: String(error) });
        deps.logger.error("guild command could not be published", { guildId, error: String(error) });
        return { outcome: "NO_SESSION", detail: `the command could not be published (${String(error)})` };
      }

      if (answer === null) {
        return { outcome: "UNCONFIRMED", detail: "sent, but this process cannot hear the bridge's answer" };
      }
      return answer;
    },
  };
}
