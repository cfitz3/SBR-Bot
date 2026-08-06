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
  type BridgeCapability,
  type HypixelSocialLookup,
  type IdentityRepository,
  type IdentityService,
  type LinkError,
  type LinkedIdentityDTO,
  type Result,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";

export interface IdentityServiceDeps {
  readonly repo: IdentityRepository;
  readonly social: HypixelSocialLookup;
  readonly logger: Logger;
}

export class IdentityServiceImpl implements IdentityService {
  private readonly repo: IdentityRepository;
  private readonly social: HypixelSocialLookup;
  private readonly log: Logger;

  constructor(deps: IdentityServiceDeps) {
    this.repo = deps.repo;
    this.social = deps.social;
    this.log = deps.logger.child({ service: "identity" });
  }

  async resolveByDiscordId(discordId: string): Promise<Result<LinkedIdentityDTO | null>> {
    const link = await this.repo.findPrimaryLinkByDiscordId(discordId);
    return ok(link);
  }

  async linkByIgn(discordId: string, ign: string): Promise<Result<LinkedIdentityDTO, LinkError>> {
    const social = await this.social.getLinkedDiscord(ign);

    if (social.kind === "IGN_NOT_FOUND") {
      this.log.info("link rejected", { discordId, ign, reason: "IGN_NOT_FOUND" });
      return err({ kind: "IGN_NOT_FOUND" });
    }

    if (social.discordId === null) {
      this.log.info("link rejected", { discordId, ign, reason: "SOCIAL_UNSET" });
      return err({ kind: "SOCIAL_UNSET" });
    }

    if (social.discordId !== discordId) {
      this.log.warn("link rejected", { discordId, ign, reason: "SOCIAL_MISMATCH" });
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

  async hasCapability(
    guildId: string,
    discordId: string,
    capability: BridgeCapability,
  ): Promise<boolean> {
    const caps = await this.repo.getUserCapabilities(guildId, discordId);
    return caps.includes(capability) || caps.includes("ADMIN");
  }
}
