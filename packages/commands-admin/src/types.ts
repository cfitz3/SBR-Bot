import type { MemberRole, ModerationService } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";

export interface AdminContext {
  readonly guildId: string;
  readonly actorId: string;
  readonly args: Readonly<Record<string, string>>;
}

export interface AdminReply {
  readonly text: string;
  readonly ephemeral: boolean;
}

export interface AdminHandlerDeps {
  readonly moderation: ModerationService;
  readonly logger: Logger;
}

export type AdminHandler = (ctx: AdminContext, deps: AdminHandlerDeps) => Promise<AdminReply>;

export interface AdminCommandSpec {
  readonly name: string;
  readonly minRole: MemberRole;
  readonly destructive?: boolean;
  readonly handler: AdminHandler;
}

/** Resolves the invoking staffer's platform role for tier + rank gating. */
export interface RoleResolver {
  getRole(guildId: string, discordId: string): Promise<MemberRole>;
}
