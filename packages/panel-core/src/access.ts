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
  /**
   * Double-submit CSRF token, minted at login and mirrored into a readable
   * cookie the client echoes back in a header.
   *
   * Optional because sessions issued before writes existed carry none. Such a
   * session may still read; a write is refused and the caller signs in again,
   * which is the safe direction — the alternative is trusting a session that
   * never had a token to compare against.
   */
  readonly csrfToken?: string;
}

export type PanelPage =
  | "overview"
  | "moderation"
  | "analytics"
  | "settings"
  | "events"
  | "members"
  | "milestones"
  | "tickets"
  | "wordlist"
  | "health";

/**
 * Minimum platform role per page (WEB_PANEL.md §2). Staff read and work the
 * queues, Admins hold configuration and operations.
 *
 * No page sits at OFFICER any more. The one that did was Recruitment, and the
 * screening it existed to drive is automatic now; the tier still exists in the
 * role ladder and still gates individual mutations, it just isn't what any whole
 * page turns on.
 *
 * `health` sits at ADMIN because the page carries operational actions (requeue,
 * force-sync). The doc allows a read-only subset for Staff; that would be a
 * separate page id rather than a softer tier here, so the gate stays one
 * comparison with no special cases.
 */
export const PAGE_TIERS: Readonly<Record<PanelPage, MemberRole>> = {
  overview: "MODERATOR",
  moderation: "MODERATOR",
  analytics: "MODERATOR",
  events: "MODERATOR",
  members: "MODERATOR",
  // One page for everything an admin configures: the bridge, the channel and
  // role bindings, feature flags, XP weights, join screening and the Hypixel
  // link. Weights and caps decide what every member's standing is worth, which
  // is configuration in the strict sense and belongs behind the same gate.
  settings: "ADMIN",
  // What the guild recognises, and what it pays for reaching it. Configuration
  // in the same sense the XP weights are — the achievements themselves stay in
  // the bots, where the members who earned them can see them.
  milestones: "ADMIN",
  // Moderator, because the page leads with the queue of open tickets and
  // closing one is a Moderator action (`ticket.close`). The configuration on the
  // same page — the menu and the panel that advertises it — is Admin, and the
  // view model says so per-load rather than the whole page sitting at the higher
  // tier and shutting the people who answer tickets out of the queue.
  tickets: "MODERATOR",
  // The chat filter and the escalation ladder. Both decide what happens to a
  // member automatically, with nobody in the loop at the moment it happens,
  // which is exactly the kind of thing that belongs behind the config tier.
  wordlist: "ADMIN",
  health: "ADMIN",
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
  return authorizeRole(session, guildId, PAGE_TIERS[page], roles);
}

/**
 * The same two gates against an explicit role floor rather than a page's.
 *
 * Writes need this because a mutation's tier is not always its page's: bridge
 * suspend/unsuspend is an Officer control (WEB_PANEL.md §2) that no Officer-tier
 * page owns, and forcing it through a page id would either invent a page or
 * quietly hand Officers the whole Admin surface.
 */
export async function authorizeRole(
  session: PanelSession | null,
  guildId: string,
  minRole: MemberRole,
  roles: RoleResolver,
): Promise<AccessDecision> {
  if (!session) return { allowed: false, reason: "NOT_AUTHENTICATED" };
  if (!session.manageableGuildIds.includes(guildId)) return { allowed: false, reason: "NOT_MANAGEABLE" };

  const role = await roles.getRole(guildId, session.discordId);
  if (rankOf(role) < rankOf(minRole)) return { allowed: false, reason: "INSUFFICIENT_ROLE" };

  return { allowed: true, role };
}
