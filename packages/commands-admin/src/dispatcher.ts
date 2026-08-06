/**
 * AdminDispatcher — staff command entry point. Order: resolve spec → role-tier
 * gate → destructive-confirmation gate → handler. Role/rank and per-action
 * guards are enforced here and (authoritatively) in the ModerationService.
 */
import { rankOf } from "@sbr/moderation";
import type { Logger } from "@sbr/observability";
import type { AdminCommandSpec, AdminContext, AdminHandlerDeps, AdminReply, RoleResolver } from "./types.js";

export interface AdminDispatcherDeps {
  readonly registry: ReadonlyMap<string, AdminCommandSpec>;
  readonly roles: RoleResolver;
  readonly handlerDeps: AdminHandlerDeps;
  readonly logger: Logger;
}

export class AdminDispatcher {
  private readonly d: AdminDispatcherDeps;
  private readonly log: Logger;

  constructor(deps: AdminDispatcherDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "commands-admin" });
  }

  async dispatch(name: string, ctx: AdminContext): Promise<AdminReply> {
    const spec = this.d.registry.get(name);
    if (!spec) return { ephemeral: true, text: `Unknown command: ${name}` };

    const actorRole = await this.d.roles.getRole(ctx.guildId, ctx.actorId);
    if (rankOf(actorRole) < rankOf(spec.minRole)) {
      this.log.warn("admin command denied (role)", { command: name, actor: ctx.actorId, actorRole, need: spec.minRole });
      return { ephemeral: true, text: `That command requires ${spec.minRole} or higher.` };
    }

    if (spec.destructive && ctx.args.confirm !== "true") {
      return {
        ephemeral: true,
        text: `⚠️ /${name} is destructive. Re-run with confirm:true to proceed.`,
      };
    }

    try {
      return await spec.handler(ctx, this.d.handlerDeps);
    } catch (error) {
      this.log.error("admin command threw", {
        command: name,
        error: error instanceof Error ? error.message : "unknown",
      });
      return { ephemeral: true, text: "That action failed unexpectedly — nothing was changed." };
    }
  }
}
