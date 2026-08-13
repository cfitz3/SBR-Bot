/**
 * Role resolution and the permission levels attached to it.
 *
 * The platform has one authority ladder — MEMBER < MODERATOR < OFFICER < ADMIN
 * < OWNER — and three separate questions hang off it:
 *
 * 1. **Who is at which level?** Answered here by `resolveMemberRole`, from a
 *    manual assignment, the member's Discord roles and their in-game guild rank.
 * 2. **What may a level do on the bridge?** `capabilityFloor` — the lowest level
 *    that holds a `BridgeCapability`.
 * 3. **What may a level run?** `commandFloor` — the lowest level that may invoke
 *    a named command, overriding the handler's own compiled-in `minRole`.
 *
 * Everything in this file is pure. The whole point is that "can this person do
 * this" is decidable from facts a caller already has, without a database round
 * trip per question and without a gateway call on the relay's hot path.
 *
 * **Reads are tolerant, writes are strict.** A malformed or years-old stored
 * policy degrades to the platform default rather than taking permissions
 * offline — the failure mode of a strict reader here is "nobody can do
 * anything", which is worse than "the guild is running the defaults". The panel
 * mutation that *writes* a policy rejects unknown keys instead, because a
 * typo'd capability accepted silently would read back as "not configured" and
 * look identical to a working setting.
 */
import { MemberRole, rankOfRole, type BridgeCapability } from "@sbr/shared-types";

/**
 * The capability floors a guild gets before it configures anything.
 *
 * These are the values that used to live as a private `MIN_ROLE` constant in
 * `@sbr/identity`. They moved here because they are now a *default* rather than
 * the rule: the guild can raise or lower any of them, and the resolver needs the
 * default and the override in the same place to merge them.
 *
 * The shape of the defaults is deliberate. Talking and running lookups are open
 * to any member, because a relay nobody may speak on is not a relay; the two
 * bypasses and ADMIN sit high, because they are the capabilities that let
 * someone route around the moderation the rest of the ladder enforces.
 */
export const DEFAULT_CAPABILITY_FLOOR: Readonly<Record<BridgeCapability, MemberRole>> = Object.freeze({
  RELAY_MESSAGE: MemberRole.MEMBER,
  RUN_COMMAND: MemberRole.MEMBER,
  MENTION: MemberRole.MODERATOR,
  BYPASS_COOLDOWN: MemberRole.OFFICER,
  BYPASS_FILTER: MemberRole.ADMIN,
  ADMIN: MemberRole.ADMIN,
});

export const CAPABILITIES: readonly BridgeCapability[] = Object.freeze(
  Object.keys(DEFAULT_CAPABILITY_FLOOR) as BridgeCapability[],
);

/** The ladder, lowest first — the order every picker and table renders in. */
export const ROLES: readonly MemberRole[] = Object.freeze([
  MemberRole.MEMBER,
  MemberRole.MODERATOR,
  MemberRole.OFFICER,
  MemberRole.ADMIN,
  MemberRole.OWNER,
]);

/**
 * Discord roles that confer a level, by level.
 *
 * Parsed from `GuildConfig.roleMappings`, which historically held exactly one
 * Discord role id per platform role (`/set-role type:mapping` still writes that
 * shape). A list is accepted for the same key, because guilds routinely have
 * several roles that all mean "staff" and forcing them into one would mean
 * inventing a role in Discord to satisfy us. The single-string form still parses,
 * so nothing has to be migrated.
 */
export type RoleBindings = Readonly<Record<MemberRole, readonly string[]>>;

/**
 * The configurable half of the permission model, stored under the
 * `roles.policy` guild setting.
 *
 * `roleBindings` is *not* here: it stays in `GuildConfig.roleMappings` where the
 * admin command already writes it, so there is one store for "which Discord role
 * means what" rather than two that can disagree.
 */
export interface RolePolicy {
  /**
   * In-game guild rank → platform level, keyed by the rank name lowercased.
   *
   * Hypixel rank names are guild-authored free text ("Guild Master", "Staff",
   * "Elite") and staff rename them, so the key is normalised on both write and
   * read; a rank with no entry confers nothing rather than defaulting to MEMBER.
   */
  readonly guildRanks: Readonly<Record<string, MemberRole>>;
  /** Capability → lowest level holding it. Merged over `DEFAULT_CAPABILITY_FLOOR`. */
  readonly capabilities: Readonly<Record<BridgeCapability, MemberRole>>;
  /**
   * Command name → lowest level that may run it.
   *
   * Absent means "use the level the handler declares". Storing only the
   * overrides, rather than a full table, means a command whose compiled-in
   * default is later raised does not stay silently lowered by a policy written
   * years ago against the old default.
   */
  readonly commands: Readonly<Record<string, MemberRole>>;
}

export const DEFAULT_ROLE_POLICY: RolePolicy = Object.freeze({
  guildRanks: Object.freeze({}),
  capabilities: DEFAULT_CAPABILITY_FLOOR,
  commands: Object.freeze({}),
});

/** Hypixel rank names are free text; one normalisation, used on read and write. */
export function normalizeRank(rank: string): string {
  return rank.trim().toLowerCase();
}

function asRole(value: unknown): MemberRole | null {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value) ? (value as MemberRole) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read `GuildConfig.roleMappings` into the list-per-level shape.
 *
 * Accepts both the historical `{"OFFICER": "123"}` and the widened
 * `{"OFFICER": ["123", "456"]}`. Blank ids are dropped rather than stored,
 * because an empty string would compare equal to nothing a member holds and so
 * would sit in the table looking configured while granting nobody anything.
 */
export function parseRoleBindings(raw: unknown): RoleBindings {
  const source = asRecord(raw) ?? {};
  const out = {} as Record<MemberRole, readonly string[]>;
  for (const role of ROLES) {
    const value = source[role];
    const ids = (Array.isArray(value) ? value : [value])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
    out[role] = Object.freeze([...new Set(ids)]);
  }
  return Object.freeze(out);
}

/**
 * Read a stored policy, degrading each field independently.
 *
 * Field-by-field rather than all-or-nothing: a guild that has configured its
 * ranks and then written one bad capability keeps its rank mapping. Rejecting
 * the whole document would revoke configuration the operator never touched.
 */
export function parseRolePolicy(raw: unknown): RolePolicy {
  const source = asRecord(raw);
  if (source === null) return DEFAULT_ROLE_POLICY;

  const guildRanks: Record<string, MemberRole> = {};
  for (const [rank, value] of Object.entries(asRecord(source["guildRanks"]) ?? {})) {
    const role = asRole(value);
    const key = normalizeRank(rank);
    if (role !== null && key.length > 0) guildRanks[key] = role;
  }

  const capabilities = { ...DEFAULT_CAPABILITY_FLOOR } as Record<BridgeCapability, MemberRole>;
  for (const [capability, value] of Object.entries(asRecord(source["capabilities"]) ?? {})) {
    const role = asRole(value);
    if (role !== null && (CAPABILITIES as readonly string[]).includes(capability)) {
      capabilities[capability as BridgeCapability] = role;
    }
  }

  const commands: Record<string, MemberRole> = {};
  for (const [command, value] of Object.entries(asRecord(source["commands"]) ?? {})) {
    const role = asRole(value);
    const key = command.trim().toLowerCase();
    if (role !== null && key.length > 0) commands[key] = role;
  }

  return Object.freeze({
    guildRanks: Object.freeze(guildRanks),
    capabilities: Object.freeze(capabilities),
    commands: Object.freeze(commands),
  });
}

/** What the resolver knows about one person, all of it already in hand. */
export interface MemberRoleFacts {
  /**
   * Whether this person is a member of this guild at all — a `GuildMember` row.
   *
   * Load-bearing, and the reason the resolver can return null: a stranger who
   * has never been in the server is not a MEMBER with no perks, they are not
   * anybody, and a permission check for them must fail rather than land on the
   * bottom rung of the ladder.
   */
  readonly present: boolean;
  /** `GuildMember.role`, the manual assignment `/set-role type:member` writes. */
  readonly assigned: MemberRole | null;
  /**
   * `GuildMember.roleOverride` — an explicit level that wins outright.
   *
   * The escape hatch, and the only way *down*: everything else combines by
   * taking the highest, so without this there would be no way to demote someone
   * who still holds a mapped Discord role short of editing Discord.
   */
  readonly override: MemberRole | null;
  readonly discordRoleIds: readonly string[];
  /** Their in-game guild rank, when we have a roster entry for them. */
  readonly guildRank: string | null;
}

/**
 * The level someone holds, or null when they are not a member of this guild.
 *
 * Three sources combine by **taking the highest**, because each of them is an
 * affirmative statement by staff — someone given the staff Discord role and
 * someone promoted in-game have both been trusted, and the lower reading of two
 * deliberate acts is the wrong one. `override` is the exception and is checked
 * first, since a demotion that anything could outvote would not be a demotion.
 */
export function resolveMemberRole(
  facts: MemberRoleFacts,
  bindings: RoleBindings,
  policy: RolePolicy,
): MemberRole | null {
  if (!facts.present) return null;
  if (facts.override !== null) return facts.override;

  let best: MemberRole = facts.assigned ?? MemberRole.MEMBER;
  const raise = (candidate: MemberRole): void => {
    if (rankOfRole(candidate) > rankOfRole(best)) best = candidate;
  };

  for (const role of ROLES) {
    if (bindings[role].some((id) => facts.discordRoleIds.includes(id))) raise(role);
  }

  if (facts.guildRank !== null) {
    const fromRank = policy.guildRanks[normalizeRank(facts.guildRank)];
    if (fromRank !== undefined) raise(fromRank);
  }

  return best;
}

/** The lowest level that holds `capability` in this guild. */
export function capabilityFloor(policy: RolePolicy, capability: BridgeCapability): MemberRole {
  return policy.capabilities[capability] ?? DEFAULT_CAPABILITY_FLOOR[capability];
}

/**
 * The lowest level that may run `command`, or the handler's own default.
 *
 * `fallback` is passed in rather than looked up because the command table lives
 * in the dispatchers, and a permission module that imported it would drag every
 * handler into the identity path.
 */
export function commandFloor(policy: RolePolicy, command: string, fallback: MemberRole): MemberRole {
  return policy.commands[command.trim().toLowerCase()] ?? fallback;
}

/** Does `role` clear `floor`? The one place the ladder comparison is spelled. */
export function meetsFloor(role: MemberRole | null, floor: MemberRole): boolean {
  return role !== null && rankOfRole(role) >= rankOfRole(floor);
}

/** Where the policy lives in `GuildSetting`. */
export const ROLE_POLICY_SETTING_KEY = "roles.policy";

/**
 * The strict counterpart to `parseRolePolicy`, for the panel's write path.
 *
 * Returns the message to show the operator, or null when the value is sound.
 * Unknown keys are rejected rather than dropped: a misspelled capability that
 * saved silently would read back as "not configured", which is indistinguishable
 * from a working setting and would have somebody debugging Discord instead of
 * their own typo.
 *
 * The one rule that is not merely well-formedness: **ADMIN cannot be lowered
 * below ADMIN**. It is the capability that grants every other capability in
 * `hasCapability`, so a guild that set it to MEMBER would hand the bridge to
 * everyone who joined the server, and would do it through a control that reads
 * like a preference.
 */
export function validateRolePolicy(raw: unknown): string | null {
  const source = asRecord(raw);
  if (source === null) return "The policy must be an object.";

  for (const key of Object.keys(source)) {
    if (!["guildRanks", "capabilities", "commands"].includes(key)) return `Unknown field "${key}".`;
  }

  const ranks = asRecord(source["guildRanks"]);
  if (source["guildRanks"] !== undefined && ranks === null) return "guildRanks must be an object.";
  for (const [rank, value] of Object.entries(ranks ?? {})) {
    if (normalizeRank(rank).length === 0) return "A guild rank name cannot be blank.";
    if (asRole(value) === null) return `"${rank}" is mapped to "${String(value)}", which is not a role.`;
  }

  const caps = asRecord(source["capabilities"]);
  if (source["capabilities"] !== undefined && caps === null) return "capabilities must be an object.";
  for (const [capability, value] of Object.entries(caps ?? {})) {
    if (!(CAPABILITIES as readonly string[]).includes(capability)) return `Unknown capability "${capability}".`;
    const role = asRole(value);
    if (role === null) return `"${capability}" is set to "${String(value)}", which is not a role.`;
    if (capability === "ADMIN" && rankOfRole(role) < rankOfRole(MemberRole.ADMIN)) {
      return "The ADMIN capability cannot be given to a role below ADMIN — it grants every other capability.";
    }
  }

  const commands = asRecord(source["commands"]);
  if (source["commands"] !== undefined && commands === null) return "commands must be an object.";
  for (const [command, value] of Object.entries(commands ?? {})) {
    if (command.trim().length === 0) return "A command name cannot be blank.";
    if (asRole(value) === null) return `"${command}" is set to "${String(value)}", which is not a role.`;
  }

  return null;
}
