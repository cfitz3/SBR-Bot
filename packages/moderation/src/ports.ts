/**
 * Ports for the moderation core. Implemented over @sbr/db (audit tables) and
 * @sbr/redis (enforcement mirror) at wiring time; faked in tests.
 */
import type {
  InfractionDTO,
  MemberRole,
  ModActionType,
  ModerationActionDTO,
  ModerationSurface,
} from "@sbr/shared-types";

export interface NewActionRecord {
  readonly guildId: string;
  readonly infractionId: string | null;
  readonly type: ModActionType;
  readonly actorDiscordId: string;
  readonly targetDiscordId: string | null;
  readonly targetMinecraftUuid: string | null;
  readonly reason: string;
  readonly durationSeconds: number | null;
  readonly expiresAt: string | null;
  readonly surfaces: readonly ModerationSurface[];
  readonly active: boolean;
}

export interface ModerationRepository {
  createInfraction(input: Omit<InfractionDTO, "id" | "createdAt">): Promise<InfractionDTO>;
  createAction(input: NewActionRecord): Promise<ModerationActionDTO>;
  listInfractions(guildId: string, discordId: string): Promise<readonly InfractionDTO[]>;
}

/** Resolves a member's platform role for rank-hierarchy checks (defaults MEMBER). */
export interface RankResolver {
  getRole(guildId: string, discordId: string): Promise<MemberRole>;
}

/** Mirrors active enforcement (mute/ban) into Redis for fast bridge/bot checks. */
export interface EnforcementMirror {
  apply(action: ModerationActionDTO): Promise<void>;
}

/** Whether the bot currently has the Discord permission to perform an action. */
export interface BotCapabilities {
  canPerform(guildId: string, type: ModActionType): Promise<boolean>;
}
