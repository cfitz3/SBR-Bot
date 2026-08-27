/**
 * Two-gate access control (WEB_PANEL.md §2). A guild-scoped request is allowed
 * only when BOTH hold: the guild is in the session's addressable set, AND the
 * user's platform role meets the page's or the mutation's required tier.
 * Enforced server-side; UI gating is cosmetic.
 *
 * Gate one used to be Discord MANAGE_GUILD alone, which made the tier table
 * below decorative: every tier under ADMIN described people who could not sign
 * in. It is now MANAGE_GUILD *or* a platform staff role at
 * `PANEL_ACCESS_FLOOR`, so the ladder the platform maintains is the ladder the
 * panel runs on and gate two does the work it was written to do.
 *
 * The two gates are not redundant. Gate one answers "may this session address
 * this guild at all", cheaply and from the session, and it is what stops a
 * guild id swapped in a URL from reaching a service call. Gate two answers "may
 * this person do this particular thing", freshly, against the current role —
 * which matters because gate one's answer is up to six hours old.
 */
import { rankOf } from "@sbr/moderation";
import type { MemberRole } from "@sbr/shared-types";

export interface PanelSession {
  readonly discordId: string;
  /**
   * Gate one: the platform guilds this session may address at all.
   *
   * Historically "guilds Discord says you manage", which is where the name
   * comes from; it is now the union of those and the guilds where the platform
   * records this account at `PANEL_ACCESS_FLOOR` or above. Kept under the old
   * name so sessions already in Redis stay valid across the deploy rather than
   * signing every member of staff out at once.
   *
   * Internal `Guild.id` values, not Discord snowflakes.
   */
  readonly manageableGuildIds: readonly string[];
  /**
   * Of those, the ones Discord itself says the user manages.
   *
   * Separate because a handful of decisions are about Discord authority rather
   * than platform rank, and folding them together would silently hand those to
   * anyone the platform had made a Moderator. Absent on sessions minted before
   * the split, where the two sets were the same thing — see `managesInDiscord`.
   */
  readonly discordManagedGuildIds?: readonly string[];
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
  | "roles"
  | "tickets"
  | "wordlist"
  | "health"
  | "permissions"
  | "leaderboard"
  | "directory"
  | "xp";

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
  // Automatic roles and the greeter. Both act on members with nobody in the
  // loop at the moment they act — a rule that hands out a role and a message
  // the whole server reads — so both sit behind the configuration tier.
  roles: "ADMIN",
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
  // Who is staff, and what staff means. Every other tier on this table is
  // enforced by comparing against a level this page defines, so it sits at the
  // top of the ladder that it configures — an Officer who could edit it could
  // make themselves an Admin in one write.
  permissions: "ADMIN",
  // Not a page anyone navigates to — it backs the channel/role/member pickers
  // that the config pages are built from. Moderator rather than Admin because
  // Moderator-tier pages use pickers too (a moderation target, a ticket
  // assignee), and it discloses nothing a member cannot see in Discord itself.
  // The one page that asks for nothing above being a member: it shows standings
  // that are already public to the guild on Discord, and holds no action at all.
  //
  // Gate one is what it does not reach past. `PANEL_ACCESS_FLOOR` is MODERATOR,
  // so no session that could open this page belongs to a plain member today.
  // The tier stays MEMBER because it states what the page needs: if a
  // member-scoped session is ever minted, this page is already correct instead
  // of quietly staff-only.
  leaderboard: "MEMBER",
  directory: "MODERATOR",
  // The weights and caps every member's standing is derived from, plus the one
  // write that bypasses them. Admin for the same reason `milestones` is: this
  // decides what activity is worth for everybody, and a hand-entered adjustment
  // is XP created out of nothing.
  xp: "ADMIN",
};

/**
 * The platform role that gets an account through gate one.
 *
 * MODERATOR, because that is the lowest tier any staff page asks for, and gate
 * two refuses anything above it per page and per mutation. Deliberately not
 * MEMBER: `leaderboard` sits at MEMBER to state what the page needs, but the
 * panel as a whole is a staff surface, and admitting every member would make
 * one session-minting decision into a product change nobody asked for.
 */
export const PANEL_ACCESS_FLOOR: MemberRole = "MODERATOR";

/**
 * Whether Discord — not the platform's own ladder — says this session manages
 * this guild.
 *
 * A session minted before the two sets were told apart has no
 * `discordManagedGuildIds`, and for those the sets really were identical: gate
 * one admitted MANAGE_GUILD holders and nobody else. Reading the old field is
 * therefore accurate rather than a lenient fallback.
 */
export function managesInDiscord(session: PanelSession, guildId: string): boolean {
  return (session.discordManagedGuildIds ?? session.manageableGuildIds).includes(guildId);
}

export type DenyReason = "NOT_AUTHENTICATED" | "NOT_MANAGEABLE" | "INSUFFICIENT_ROLE";

export type AccessDecision =
  | { readonly allowed: true; readonly role: MemberRole }
  | { readonly allowed: false; readonly reason: DenyReason };

export interface RoleResolver {
  /** Null when the session's account is not a member of the guild at all. */
  getRole(guildId: string, discordId: string): Promise<MemberRole | null>;
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

  // A Discord-side server manager who has never been recorded as a member of
  // this guild resolves to null. That is INSUFFICIENT_ROLE rather than a crash
  // or an implicit MEMBER: the panel's ladder is the platform's, not Discord's.
  const role = await roles.getRole(guildId, session.discordId);
  if (role === null || rankOf(role) < rankOf(minRole)) return { allowed: false, reason: "INSUFFICIENT_ROLE" };

  return { allowed: true, role };
}
