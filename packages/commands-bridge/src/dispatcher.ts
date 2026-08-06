/**
 * CommandDispatcher — the single entry point the transport adapters call.
 * Order: resolve spec → capability → cooldown → run handler → capture usage.
 * Never throws: every path returns a CommandReply so the adapter can respond.
 */
import type { Logger } from "@sbr/observability";
import type {
  CapabilityChecker,
  CommandContext,
  CommandReply,
  CommandSpec,
  CooldownGate,
  HandlerDeps,
  UsageSink,
} from "./types.js";

export interface CommandDispatcherDeps {
  readonly registry: ReadonlyMap<string, CommandSpec>;
  readonly cooldowns: CooldownGate;
  readonly capabilities: CapabilityChecker;
  readonly handlerDeps: HandlerDeps;
  readonly logger: Logger;
  readonly usage?: UsageSink;
  readonly now?: () => number;
}

export class CommandDispatcher {
  private readonly d: CommandDispatcherDeps;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(deps: CommandDispatcherDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "commands-bridge" });
    this.now = deps.now ?? (() => Date.now());
  }

  async dispatch(name: string, ctx: CommandContext): Promise<CommandReply> {
    const spec = this.d.registry.get(name);
    if (!spec) return { ephemeral: true, text: `Unknown command: ${name}` };

    if (spec.capability) {
      const allowed = await this.d.capabilities.can(ctx.guildId, ctx.userId, spec.capability);
      if (!allowed) return { ephemeral: true, text: "You don't have permission to use that command." };
    }

    const cdKey = `${ctx.surface}:${name}:${ctx.userId}`;
    const cd = await this.d.cooldowns.consume(cdKey, spec.cooldownMs);
    if (!cd.allowed) {
      const secs = Math.ceil((cd.retryAfterMs ?? spec.cooldownMs) / 1000);
      return { ephemeral: true, text: `Slow down — try that again in ${secs}s.` };
    }

    const started = this.now();
    let success = true;
    let reply: CommandReply;
    try {
      reply = await spec.handler(ctx, this.d.handlerDeps);
    } catch (error) {
      success = false;
      this.log.warn("command handler threw", {
        command: name,
        error: error instanceof Error ? error.message : "unknown",
      });
      reply = { ephemeral: true, text: "Something went wrong fetching that — try again shortly." };
    }

    await this.captureUsage(name, ctx, success, this.now() - started);
    return reply;
  }

  private async captureUsage(command: string, ctx: CommandContext, success: boolean, latencyMs: number): Promise<void> {
    if (!this.d.usage) return;
    try {
      await this.d.usage.capture({
        guildId: ctx.guildId,
        discordId: ctx.userId,
        surface: ctx.surface,
        command,
        success,
        latencyMs,
        invokedAt: new Date().toISOString(),
      });
    } catch {
      // usage capture is best-effort
    }
  }
}
