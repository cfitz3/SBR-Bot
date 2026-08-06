/**
 * Two-gate access control (WEB_PANEL.md §2). A guild-scoped request is allowed
 * only when BOTH hold: the guild is in the user's manageable set (Discord
 * MANAGE_GUILD ∩ platform Guild record), AND the user's platform role meets the
 * page's required tier. Enforced server-side; UI gating is cosmetic.
 */
import { rankOf } from "@sbr/moderation";
import type { MemberRole } from "@sbr/shared-types";

export interface PanelSession {
  readonly discordId: string;
  /** Guilds the user can manage AND that the platform knows about. */
  readonly manageableGuildIds: readonly string[];
}

export type PanelPage = "overview" | "moderation" | "recruitment" | "analytics" | "settings";

/** Minimum platform role per page. */
export const PAGE_TIERS: Readonly<Record<PanelPage, MemberRole>> = {
  overview: "MODERATOR",
  moderation: "MODERATOR",
  analytics: "MODERATOR",
  recruitment: "OFFICER",
  settings: "ADMIN",
};

export type DenyReason = "NOT_AUTHENTICATED" | "NOT_MANAGEABLE" | "INSUFFICIENT_ROLE";

export type AccessDecision =
  | { readonly allowed: true; readonly role: MemberRole }
  | { readonly allowed: false; readonly reason: DenyReason };

export interface RoleResolver {
  getRole(guildId: string, discordId: string): Promise<MemberRole>;
}

export async function authorize(
  session: PanelSession | null,
  guildId: string,
  page: PanelPage,
  roles: RoleResolver,
): Promise<AccessDecision> {
  if (!session) return { allowed: false, reason: "NOT_AUTHENTICATED" };
  if (!session.manageableGuildIds.includes(guildId)) return { allowed: false, reason: "NOT_MANAGEABLE" };

  const role = await roles.getRole(guildId, session.discordId);
  if (rankOf(role) < rankOf(PAGE_TIERS[page])) return { allowed: false, reason: "INSUFFICIENT_ROLE" };

  return { allowed: true, role };
}
