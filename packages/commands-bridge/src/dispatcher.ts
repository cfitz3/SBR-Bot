/**
 * CommandDispatcher — the single entry point the transport adapters call.
 * Order: resolve spec → capability → cooldown → run handler → capture usage.
 * Never throws: every path returns a CommandReply so the adapter can respond.
 */
import { isUpstreamUnavailable, UPSTREAM_UNAVAILABLE_MESSAGE } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type {
  AutocompleteContext,
  CapabilityChecker,
  CommandContext,
  CommandReply,
  CommandSpec,
  CooldownGate,
  CooldownPolicySource,
  HandlerDeps,
  UsageSink,
} from "./types.js";

export interface CommandDispatcherDeps {
  readonly registry: ReadonlyMap<string, CommandSpec>;
  readonly cooldowns: CooldownGate;
  /** Per-guild cooldown overrides. Unwired, every command keeps its spec value. */
  readonly cooldownPolicy?: CooldownPolicySource;
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

  /** The wired registry — the transport derives its registration payload from this. */
  get commands(): ReadonlyMap<string, CommandSpec> {
    return this.d.registry;
  }

  /**
   * Autocomplete for a focused option. Deliberately skips the capability and
   * cooldown gates: Discord allows 3 seconds and fires a request per keystroke,
   * so the gates would both blow the budget and burn the user's cooldown before
   * they ever ran the command. Suggestions expose nothing the command wouldn't.
   */
  async autocomplete(
    name: string,
    focused: { readonly name: string; readonly value: string },
    ctx: AutocompleteContext,
  ): Promise<readonly { name: string; value: string }[]> {
    const handler = this.d.registry.get(name)?.autocomplete;
    if (!handler) return [];
    try {
      // Discord rejects a response with more than 25 choices outright.
      return (await handler(focused, ctx, this.d.handlerDeps)).slice(0, 25);
    } catch (error) {
      this.log.warn("autocomplete threw", {
        command: name,
        error: error instanceof Error ? error.message : "unknown",
      });
      return [];
    }
  }

  async dispatch(name: string, ctx: CommandContext): Promise<CommandReply> {
    const spec = this.d.registry.get(name);
    if (!spec) return { ephemeral: true, text: `Unknown command: ${name}` };

    if (spec.capability) {
      const allowed = await this.d.capabilities.can(ctx.guildId, ctx.userId, spec.capability);
      if (!allowed) return { ephemeral: true, text: "You don't have permission to use that command." };
    }

    // A guild may lengthen or shorten this; an unreadable policy leaves the
    // spec's own number standing, because a config lookup failing is not a
    // reason to stop answering commands.
    let cooldownMs = spec.cooldownMs;
    if (this.d.cooldownPolicy) {
      cooldownMs = await this.d.cooldownPolicy
        .resolveMs(ctx.guildId, name, spec.cooldownMs)
        .catch(() => spec.cooldownMs);
    }

    // Zero means the guild switched this command's cooldown off. Consuming a
    // 0ms key would still write to Redis for nothing, so skip the gate outright.
    if (cooldownMs > 0) {
      const cdKey = `${ctx.surface}:${name}:${ctx.userId}`;
      const cd = await this.d.cooldowns.consume(cdKey, cooldownMs);
      if (!cd.allowed) {
        const secs = Math.ceil((cd.retryAfterMs ?? cooldownMs) / 1000);
        return { ephemeral: true, text: `Slow down — try that again in ${secs}s.` };
      }
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
      // Degrade honestly: an unreachable data source is a different situation
      // from a bug, and the user can act on the difference.
      reply = {
        ephemeral: true,
        text: isUpstreamUnavailable(error)
          ? UPSTREAM_UNAVAILABLE_MESSAGE
          : "Something went wrong fetching that — try again shortly.",
      };
    }

    await this.captureUsage(name, ctx, success, this.now() - started);
    // A renamed command still answers under its old name for a release, with the
    // new name in front of the answer — telling someone their command is gone
    // and then not answering it teaches them nothing and costs them the lookup.
    if (spec.deprecatedBy !== undefined) {
      return { ...reply, text: `\`/${name}\` is now \`/${spec.deprecatedBy}\`.\n${reply.text}` };
    }
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
