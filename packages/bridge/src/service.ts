/**
 * BridgeService — the relay pipeline. Every message runs the ordered stages
 * from BRIDGE_BOT.md: identify → permission → suspend/mute → filter → anti-spam
 * → format → deliver. Any stage may DROP (with a reason); only messages passing
 * all stages are delivered.
 */
import type { Logger } from "@sbr/observability";
import { flattenForGame, formatRelay } from "./format.js";
import type {
  BridgeGuard,
  DropReason,
  FloodControl,
  InboundMessage,
  RelayDecision,
  WordlistFilter,
} from "./types.js";

export interface BridgeServiceDeps {
  readonly guard: BridgeGuard;
  readonly wordlist: WordlistFilter;
  readonly flood: FloodControl;
  readonly logger: Logger;
}

export class BridgeService {
  private readonly guard: BridgeGuard;
  private readonly wordlist: WordlistFilter;
  private readonly flood: FloodControl;
  private readonly log: Logger;

  constructor(deps: BridgeServiceDeps) {
    this.guard = deps.guard;
    this.wordlist = deps.wordlist;
    this.flood = deps.flood;
    this.log = deps.logger.child({ service: "bridge" });
  }

  async processInbound(msg: InboundMessage): Promise<RelayDecision> {
    const drop = (reason: DropReason): RelayDecision => {
      this.log.debug("relay dropped", { guildId: msg.guildId, author: msg.authorId, direction: msg.direction, reason });
      return { action: "DROP", reason };
    };

    // 1. identify + empty check
    if (msg.content.trim().length === 0) return drop("EMPTY");

    // 2. permission
    if (!(await this.guard.canRelay(msg.guildId, msg.authorId))) return drop("NO_PERMISSION");

    // 3. suspend / mute
    if (await this.guard.isSuspended(msg.guildId)) return drop("BRIDGE_SUSPENDED");
    if (await this.guard.isMuted(msg.guildId, msg.authorId)) return drop("MUTED");

    // 4. content filter
    const verdict = await this.wordlist.check(msg.guildId, msg.content);
    let content = msg.content;
    let flagged = false;
    switch (verdict.action) {
      case "BLOCK":
      case "SHADOW_MUTE":
        return drop("FILTERED");
      case "REPLACE":
        content = verdict.replacement;
        break;
      case "FLAG":
        flagged = true;
        break;
      case "ALLOW":
        break;
    }

    // 5. anti-spam / flood
    const flood = await this.flood.allow(msg.guildId, msg.authorId, content);
    if (!flood.allowed) return drop(flood.reason === "DUPLICATE" ? "DUPLICATE" : "RATE_LIMITED");

    // 6. format + deliver
    const formatted = formatRelay({ ...msg, content });
    if (flagged) {
      this.log.info("relay delivered (flagged by filter)", { guildId: msg.guildId, author: msg.authorId });
    }
    return { action: "DELIVER", formatted, flagged };
  }
}

// Re-export so the flatten helper is reachable for adapters.
export { flattenForGame };
