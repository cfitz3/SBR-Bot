/**
 * AdminDispatcher — staff command entry point. Order: resolve spec → role-tier
 * gate → destructive-confirmation gate → handler. Role/rank and per-action
 * guards are enforced here and (authoritatively) in the ModerationService.
 */
import { rankOf } from "@sbr/moderation";
import { isUpstreamUnavailable, UPSTREAM_UNAVAILABLE_MESSAGE, type MemberRole } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type {
  AdminAutocompleteContext,
  AdminCommandSpec,
  AdminContext,
  AdminHandlerDeps,
  AdminReply,
  RoleResolver,
} from "./types.js";

/**
 * Reads the guild's configured floor for one command.
 *
 * Takes the fallback rather than returning null so the dispatcher never has to
 * decide what "unconfigured" means — the answer is always a role.
 */
export interface CommandFloorReader {
  commandFloor(guildId: string, command: string, fallback: MemberRole): Promise<MemberRole>;
}

export interface AdminDispatcherDeps {
  readonly registry: ReadonlyMap<string, AdminCommandSpec>;
  readonly roles: RoleResolver;
  /**
   * Per-guild overrides of each command's minimum role, from the panel's
   * Permissions card. Optional: a deployment that has not wired it — and every
   * existing test — keeps the floors the handlers declare.
   */
  readonly policies?: CommandFloorReader;
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

  /** The wired registry — the transport derives its registration payload from this. */
  get commands(): ReadonlyMap<string, AdminCommandSpec> {
    return this.d.registry;
  }

  /**
   * Autocomplete for a focused option. Deliberately skips the role gate: Discord
   * gives a 3-second budget and suggestions leak nothing the command itself
   * wouldn't, so the rank check stays where it bites, on dispatch.
   */
  async autocomplete(
    name: string,
    focused: { readonly name: string; readonly value: string },
    ctx: AdminAutocompleteContext,
  ): Promise<readonly { name: string; value: string }[]> {
    const handler = this.d.registry.get(name)?.autocomplete;
    if (!handler) return [];
    try {
      return (await handler(focused, ctx, this.d.handlerDeps)).slice(0, 25);
    } catch (error) {
      this.log.warn("admin autocomplete threw", {
        command: name,
        error: error instanceof Error ? error.message : "unknown",
      });
      return [];
    }
  }

  async dispatch(name: string, ctx: AdminContext): Promise<AdminReply> {
    const spec = this.d.registry.get(name);
    if (!spec) return { ephemeral: true, text: `Unknown command: ${name}` };

    // The floor is the handler's own unless the guild has raised or lowered it
    // on the panel. Resolved before the actor's role so a denial message quotes
    // the level actually in force rather than the compiled-in default.
    const need = (await this.d.policies?.commandFloor(ctx.guildId, name, spec.minRole)) ?? spec.minRole;
    const actorRole = await this.d.roles.getRole(ctx.guildId, ctx.actorId);
    if (actorRole === null || rankOf(actorRole) < rankOf(need)) {
      this.log.warn("admin command denied (role)", { command: name, actor: ctx.actorId, actorRole, need });
      return {
        ephemeral: true,
        text:
          actorRole === null
            ? "You are not recorded as a member of this guild."
            : `That command requires ${need} or higher.`,
      };
    }

    if (spec.destructive && ctx.args.getBoolean("confirm") !== true) {
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
      // "Nothing was changed" is a claim, so keep the two cases apart: an
      // unreachable lookup never got as far as writing anything either way.
      return {
        ephemeral: true,
        text: isUpstreamUnavailable(error)
          ? UPSTREAM_UNAVAILABLE_MESSAGE
          : "That action failed unexpectedly — nothing was changed.",
      };
    }
  }
}
