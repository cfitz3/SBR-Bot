/**
 * IdentityServiceImpl — account linking + permission resolution.
 *
 * Link flow (COMMANDS.md /link): read the Hypixel in-game social Discord field
 * for the IGN and match it against the caller's Discord id. If the field is
 * unset or mismatched, the link is refused — there is no code-challenge path.
 */
import {
  err,
  ok,
  rankOfRole,
  type BridgeCapability,
  type HypixelSocialLookup,
  type IdentityRepository,
  type IdentityService,
  type LinkActor,
  type LinkError,
  type LinkedIdentityDTO,
  type MemberRole,
  type MemberRoleReader,
  type Result,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";

/**
 * The platform role that carries a capability on its own, with no
 * `BridgePermission` row behind it.
 *
 * `BridgePermission` is the fine-grained model, but it starts *empty*: a guild
 * that has just been onboarded has no rows at all. Resolving capabilities from
 * rows alone therefore denies `/stats` to every member including the owner,
 * which contradicts both COMMANDS.md §1–7 (the lookup surface is Public) and
 * BRIDGE_BOT.md §3.3 (the relay is open to any linked, non-muted member). These
 * floors are what makes an unconfigured guild usable, and what makes setting
 * someone to OWNER mean something before the panel can write rows.
 */
const MIN_ROLE: Readonly<Record<BridgeCapability, MemberRole>> = {
  RELAY_MESSAGE: "MEMBER",
  RUN_COMMAND: "MEMBER",
  MENTION: "MODERATOR",
  BYPASS_COOLDOWN: "OFFICER",
  BYPASS_FILTER: "ADMIN",
  ADMIN: "ADMIN",
};

/**
 * Compare Discord handles the way a human would.
 *
 * Hypixel stores whatever the player typed in-game, so the field holds a
 * username in either the modern form (`refraction`) or the legacy tagged one
 * (`boblovespi#9817`) — both confirmed against the live API. Discord usernames
 * are case-insensitive and the discriminator is gone, so the part before `#`,
 * lowercased, is the stable thing to match on.
 */
function normalizeHandle(value: string): string {
  return (value.trim().split("#")[0] ?? "").toLowerCase();
}

export interface IdentityServiceDeps {
  readonly repo: IdentityRepository;
  readonly social: HypixelSocialLookup;
  readonly roles: MemberRoleReader;
  readonly logger: Logger;
}

export class IdentityServiceImpl implements IdentityService {
  private readonly repo: IdentityRepository;
  private readonly social: HypixelSocialLookup;
  private readonly roles: MemberRoleReader;
  private readonly log: Logger;

  constructor(deps: IdentityServiceDeps) {
    this.repo = deps.repo;
    this.social = deps.social;
    this.roles = deps.roles;
    this.log = deps.logger.child({ service: "identity" });
  }

  async resolveByDiscordId(discordId: string): Promise<Result<LinkedIdentityDTO | null>> {
    const link = await this.repo.findPrimaryLinkByDiscordId(discordId);
    return ok(link);
  }

  async linkByIgn(actor: LinkActor, ign: string): Promise<Result<LinkedIdentityDTO, LinkError>> {
    const { discordId, username } = actor;
    const social = await this.social.getLinkedDiscord(ign);

    if (social.kind === "IGN_NOT_FOUND") {
      this.log.info("link rejected", { discordId, ign, reason: "IGN_NOT_FOUND" });
      return err({ kind: "IGN_NOT_FOUND" });
    }

    if (social.discordId === null) {
      this.log.info("link rejected", { discordId, ign, reason: "SOCIAL_UNSET" });
      return err({ kind: "SOCIAL_UNSET" });
    }

    // Two accepted forms. The username is what the field actually holds in
    // practice; the raw snowflake is accepted as well because some players do
    // paste their id in, and only its true owner can match it anyway.
    const claimed = social.discordId;
    const matches =
      claimed === discordId ||
      (username !== undefined && normalizeHandle(claimed) === normalizeHandle(username));

    if (!matches) {
      this.log.warn("link rejected", { discordId, ign, reason: "SOCIAL_MISMATCH", claimed });
      return err({ kind: "SOCIAL_MISMATCH" });
    }

    const existingOwner = await this.repo.findMinecraftOwnerDiscordId(social.uuid);
    if (existingOwner !== null && existingOwner !== discordId) {
      this.log.warn("link rejected", { discordId, ign, reason: "ALREADY_OWNED", byDiscordId: existingOwner });
      return err({ kind: "ALREADY_OWNED", byDiscordId: existingOwner });
    }

    const link = await this.repo.createVerifiedLink({
      discordId,
      uuid: social.uuid,
      ign: social.ign,
    });
    this.log.info("link verified", { discordId, ign: social.ign, uuid: social.uuid });
    return ok(link);
  }

  async unlink(discordId: string, minecraftUuid: string): Promise<Result<void>> {
    const removed = await this.repo.unlink(discordId, minecraftUuid);
    this.log.info("unlink", { discordId, minecraftUuid, removed });
    return ok(undefined);
  }

  /**
   * Resolution order: explicit deny → explicit grant → platform role floor.
   *
   * A deny row is checked first because it is the only way to take a capability
   * away from someone who would otherwise hold it by rank — if a grant or a role
   * could outvote it, there would be no way to silence one person without
   * demoting them.
   */
  async hasCapability(
    guildId: string,
    discordId: string,
    capability: BridgeCapability,
  ): Promise<boolean> {
    const [grants, role] = await Promise.all([
      this.repo.getCapabilityGrants(guildId, discordId),
      this.roles.getRole(guildId, discordId),
    ]);

    if (grants.some((g) => !g.allow && g.capability === capability)) return false;
    if (grants.some((g) => g.allow && (g.capability === capability || g.capability === "ADMIN"))) {
      return true;
    }

    return rankOfRole(role) >= rankOfRole(MIN_ROLE[capability]);
  }
}
