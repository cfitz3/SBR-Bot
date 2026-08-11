/**
 * Prisma reads and writes for the bridge relay: wordlist entries and guild
 * config. `guildId` is the internal Guild.id.
 */
import { Prisma } from "@prisma/client";
import { isConfigChannelSlot, type ConfigChannelSlot, type WordlistRuleDTO } from "@sbr/shared-types";
import { prisma } from "../client.js";

export type WordMatchType = "EXACT" | "SUBSTRING" | "REGEX" | "WILDCARD";
export type WordAction = "BLOCK" | "FLAG" | "REPLACE" | "SHADOW_MUTE";

export interface WordlistEntryRow {
  pattern: string;
  matchType: WordMatchType;
  action: WordAction;
  severity: number;
}

interface WordlistRuleRow {
  id: string;
  guildId: string;
  pattern: string;
  matchType: string;
  action: string;
  severity: number;
  enabled: boolean;
}

function mapRule(r: WordlistRuleRow): WordlistRuleDTO {
  return {
    id: r.id,
    guildId: r.guildId,
    pattern: r.pattern,
    matchType: r.matchType as WordlistRuleDTO["matchType"],
    action: r.action as WordlistRuleDTO["action"],
    severity: r.severity,
    enabled: r.enabled,
  };
}

const RULE_FIELDS = {
  id: true,
  guildId: true,
  pattern: true,
  matchType: true,
  action: true,
  severity: true,
  enabled: true,
} as const;

export const wordlistRepository = {
  async listEnabled(guildId: string): Promise<WordlistEntryRow[]> {
    const rows = await prisma.wordlistEntry.findMany({
      where: { guildId, enabled: true },
      select: { pattern: true, matchType: true, action: true, severity: true },
    });
    return rows.map((r) => ({
      pattern: r.pattern,
      matchType: r.matchType as WordMatchType,
      action: r.action as WordAction,
      severity: r.severity,
    }));
  },

  /** Every rule, enabled or not — `/filter-test` must show why a disabled rule didn't fire. */
  async list(guildId: string): Promise<readonly WordlistRuleDTO[]> {
    const rows = await prisma.wordlistEntry.findMany({
      where: { guildId },
      orderBy: { createdAt: "asc" },
      select: RULE_FIELDS,
    });
    return rows.map(mapRule);
  },

  async add(input: {
    guildId: string;
    pattern: string;
    matchType: string;
    action: string;
    severity: number;
    addedByDiscordId: string;
    note: string | null;
  }): Promise<WordlistRuleDTO> {
    const row = await prisma.wordlistEntry.create({
      data: {
        guildId: input.guildId,
        pattern: input.pattern,
        matchType: input.matchType as WordMatchType,
        action: input.action as WordAction,
        severity: input.severity,
        addedById: input.addedByDiscordId,
        note: input.note,
      },
      select: RULE_FIELDS,
    });
    return mapRule(row);
  },

  /**
   * Patch one rule. Scoped by guild as well as id for the same reason removal
   * is: a rule id pasted in from another guild must not be editable here.
   */
  async update(
    guildId: string,
    id: string,
    patch: {
      pattern?: string;
      matchType?: string;
      action?: string;
      severity?: number;
      enabled?: boolean;
      note?: string | null;
    },
  ): Promise<WordlistRuleDTO | null> {
    const result = await prisma.wordlistEntry.updateMany({
      where: { guildId, id },
      data: {
        ...(patch.pattern === undefined ? {} : { pattern: patch.pattern }),
        ...(patch.matchType === undefined ? {} : { matchType: patch.matchType as WordMatchType }),
        ...(patch.action === undefined ? {} : { action: patch.action as WordAction }),
        ...(patch.severity === undefined ? {} : { severity: patch.severity }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.note === undefined ? {} : { note: patch.note }),
      },
    });
    if (result.count === 0) return null;
    const rows = await prisma.wordlistEntry.findMany({ where: { guildId, id }, select: RULE_FIELDS });
    const row = rows[0];
    return row ? mapRule(row) : null;
  },

  async removeById(guildId: string, id: string): Promise<WordlistRuleDTO | null> {
    // Delete scoped by guild as well as id: a rule id from another guild must
    // not be removable by pasting it into this one.
    const rows = await prisma.wordlistEntry.findMany({ where: { guildId, id }, select: RULE_FIELDS });
    const row = rows[0];
    if (!row) return null;
    await prisma.wordlistEntry.delete({ where: { id: row.id } });
    return mapRule(row);
  },

  async removeByPattern(guildId: string, pattern: string): Promise<WordlistRuleDTO | null> {
    const rows = await prisma.wordlistEntry.findMany({ where: { guildId, pattern }, select: RULE_FIELDS });
    const row = rows[0];
    if (!row) return null;
    await prisma.wordlistEntry.delete({ where: { id: row.id } });
    return mapRule(row);
  },
};

export interface GuildConfigRow {
  channels: Partial<Record<ConfigChannelSlot, string>>;
  prefixes: string[];
  timezone: string;
  applicationsOpen: boolean;
  bridgeSuspended: boolean;
  features: Record<string, boolean>;
  minWeight: number | null;
  minNetworth: number | null;
  roleMappings: Record<string, string>;
}

/** `features` is a Json column, so coerce defensively rather than trusting its shape. */
function toFeatureMap(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
    if (typeof flag === "boolean") out[key] = flag;
  }
  return out;
}

/** Same defensive coercion for the `roleMappings` Json column. */
function toRoleMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [role, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id === "string") out[role] = id;
  }
  return out;
}

/**
 * Bindings, keyed by slot.
 *
 * Until `20260811150000_drop_legacy_channel_columns` this also merged five
 * `*ChannelId` columns underneath the bindings. Those were backfilled into this
 * table and dropped, so there is now exactly one place a channel is recorded
 * and nothing left to reconcile.
 */
function toChannels(
  bindings: readonly { slot: string; channelId: string }[],
): Partial<Record<ConfigChannelSlot, string>> {
  const channels: Partial<Record<ConfigChannelSlot, string>> = {};
  for (const binding of bindings) {
    // An unrecognised slot is a row from a newer release than this process;
    // ignoring it is correct, and better than widening the typed map with it.
    if (isConfigChannelSlot(binding.slot)) channels[binding.slot] = binding.channelId;
  }

  return channels;
}

export const guildConfigRepository = {
  async get(guildId: string): Promise<GuildConfigRow | null> {
    const [cfg, bindings] = await Promise.all([
      prisma.guildConfig.findUnique({ where: { guildId } }),
      prisma.guildChannelBinding.findMany({ where: { guildId }, select: { slot: true, channelId: true } }),
    ]);
    if (!cfg) return null;
    return {
      channels: toChannels(bindings),
      prefixes: cfg.prefixes,
      timezone: cfg.timezone,
      applicationsOpen: cfg.applicationsOpen,
      bridgeSuspended: cfg.bridgeSuspended,
      features: toFeatureMap(cfg.features),
      minWeight: cfg.minWeight,
      // BigInt in Postgres, plain number here: guild networth bars are billions
      // of coins, comfortably inside the safe-integer range.
      minNetworth: cfg.minNetworth === null ? null : Number(cfg.minNetworth),
      roleMappings: toRoleMap(cfg.roleMappings),
    };
  },

  /**
   * Upsert a partial config. Creating on demand matters: a guild seeded without
   * a GuildConfig row would otherwise make every `/set-channel` fail with a
   * foreign-key error rather than doing the obvious thing.
   */
  async update(
    guildId: string,
    patch: Partial<Omit<GuildConfigRow, "features" | "roleMappings" | "channels">>,
  ): Promise<void> {
    await prisma.guildConfig.upsert({
      where: { guildId },
      create: { guildId, ...patch },
      update: patch,
    });
  },

  /** Flip one feature flag, preserving the rest of the map. */
  async setFeature(guildId: string, feature: string, enabled: boolean): Promise<void> {
    const current = await prisma.guildConfig.findUnique({ where: { guildId }, select: { features: true } });
    const features = { ...toFeatureMap(current?.features), [feature]: enabled };
    await prisma.guildConfig.upsert({
      where: { guildId },
      create: { guildId, features },
      update: { features },
    });
  },

  /** Bind or clear one platform role's Discord role, preserving the other bindings. */
  async setRoleMapping(guildId: string, role: string, discordRoleId: string | null): Promise<void> {
    const current = await prisma.guildConfig.findUnique({ where: { guildId }, select: { roleMappings: true } });
    const roleMappings = toRoleMap(current?.roleMappings);
    if (discordRoleId === null) delete roleMappings[role];
    else roleMappings[role] = discordRoleId;
    await prisma.guildConfig.upsert({
      where: { guildId },
      create: { guildId, roleMappings },
      update: { roleMappings },
    });
  },

  /**
   * Bind or clear one channel slot. Clearing deletes the row rather than storing
   * an empty string, so "never configured" and "deliberately cleared" resolve to
   * the same absent value instead of one of them reading as a channel id of "".
   */
  async setChannelBinding(guildId: string, slot: ConfigChannelSlot, channelId: string | null): Promise<void> {
    if (channelId === null) {
      await prisma.guildChannelBinding.deleteMany({ where: { guildId, slot } });
      return;
    }
    await prisma.guildChannelBinding.upsert({
      where: { guildId_slot: { guildId, slot } },
      create: { guildId, slot, channelId },
      update: { channelId },
    });
  },

  /**
   * Bind or clear the Hypixel guild. Writes `Guild`, not `GuildConfig` — see the
   * note on this method in `@sbr/guild-config`'s port.
   *
   * `Guild.hypixelGuildId` is unique, so a second guild claiming one already
   * taken arrives as P2002. Translated here rather than left to surface as a
   * driver error, because it is the one failure an admin can act on: the id is
   * right, it just belongs to a guild already on this platform.
   */
  async setHypixelGuild(guildId: string, hypixelGuildId: string | null): Promise<void> {
    try {
      await prisma.guild.update({ where: { id: guildId }, data: { hypixelGuildId } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new Error("another guild on this platform is already linked to that Hypixel guild");
      }
      throw error;
    }
  },

  async getSetting(guildId: string, key: string): Promise<unknown> {
    const row = await prisma.guildSetting.findUnique({
      where: { guildId_key: { guildId, key } },
      select: { value: true },
    });
    return row?.value ?? null;
  },

  /** Upsert one setting; null deletes it, restoring the caller's own default. */
  async setSetting(guildId: string, key: string, value: unknown): Promise<void> {
    if (value === null || value === undefined) {
      await prisma.guildSetting.deleteMany({ where: { guildId, key } });
      return;
    }
    const json = value as Prisma.InputJsonValue;
    await prisma.guildSetting.upsert({
      where: { guildId_key: { guildId, key } },
      create: { guildId, key, value: json },
      update: { value: json },
    });
  },
};
