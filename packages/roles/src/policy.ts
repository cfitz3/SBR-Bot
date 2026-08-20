/**
 * What a guild has asked us to hand out, and how to read it back safely.
 *
 * The stored blob is `GuildSetting["roles.auto"]`, and it follows the same
 * contract as every other policy in the platform: **tolerant on read, strict on
 * write**. A rule that cannot be understood is dropped rather than failing the
 * whole policy, because one mangled row written by an older panel build should
 * cost that row and not silence every rule behind it — a guild whose auto-roles
 * all stopped would notice slowly and blame something else.
 */

/** What makes somebody qualify for a role. */
export type AutoRoleTrigger =
  | { readonly kind: "IN_GUILD" }
  | { readonly kind: "LINKED" }
  | { readonly kind: "GUILD_RANK"; readonly rank: string }
  | { readonly kind: "XP_LEVEL"; readonly atLeast: number }
  | { readonly kind: "ACHIEVEMENT"; readonly definitionKey: string }
  | { readonly kind: "EVENTS_ATTENDED"; readonly atLeast: number }
  | { readonly kind: "MANUAL" };

export const AUTO_ROLE_TRIGGERS = [
  "IN_GUILD",
  "LINKED",
  "GUILD_RANK",
  "XP_LEVEL",
  "ACHIEVEMENT",
  "EVENTS_ATTENDED",
  "MANUAL",
] as const;

export type AutoRoleTriggerKind = (typeof AUTO_ROLE_TRIGGERS)[number];

export interface AutoRoleRule {
  /**
   * Stable identity. The grant ledger keys off this rather than the label or the
   * role id, so renaming "Guild member" or pointing it at a different role does
   * not orphan everything already granted under it.
   */
  readonly key: string;
  readonly label: string;
  readonly trigger: AutoRoleTrigger;
  readonly roleId: string;
  /**
   * Whether losing the qualification takes the role back.
   *
   * Defaults to **false**. Taking something away is the surprising direction,
   * and a guild that wanted a role to be permanent would not think to look for
   * a switch that prevents it being removed.
   */
  readonly revokeWhenUnqualified: boolean;
  readonly enabled: boolean;
}

export interface AutoRolePolicy {
  readonly enabled: boolean;
  readonly rules: readonly AutoRoleRule[];
}

export const AUTO_ROLES_SETTING_KEY = "roles.auto";

/**
 * Off, with nothing in it.
 *
 * Auto-roles write to somebody else's Discord server. Installing the platform
 * must not start changing who holds what on rules the guild never read.
 */
export const DEFAULT_AUTO_ROLES: AutoRolePolicy = Object.freeze({ enabled: false, rules: [] });

/** More than this is a configuration nobody is reading, and a slow reconcile. */
export const MAX_RULES = 40;

/** Hypixel rank names are free text; one normalisation, used on read and on write. */
export function normalizeRank(rank: string): string {
  return rank.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A whole number at least zero, or null. Rejects NaN, Infinity and 1.5 alike. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseTrigger(raw: unknown): AutoRoleTrigger | null {
  if (!isRecord(raw)) return null;
  const kind = raw["kind"];
  switch (kind) {
    case "IN_GUILD":
    case "LINKED":
    case "MANUAL":
      return { kind };
    case "GUILD_RANK": {
      const rank = str(raw["rank"]);
      return rank === null ? null : { kind, rank: normalizeRank(rank) };
    }
    case "ACHIEVEMENT": {
      const definitionKey = str(raw["definitionKey"]);
      return definitionKey === null ? null : { kind, definitionKey };
    }
    case "XP_LEVEL":
    case "EVENTS_ATTENDED": {
      const atLeast = count(raw["atLeast"]);
      return atLeast === null ? null : { kind, atLeast };
    }
    default:
      // A trigger kind from a newer deployment. Dropping the rule is right:
      // we cannot evaluate it, and guessing would grant a role on the wrong
      // condition.
      return null;
  }
}

function parseRule(raw: unknown): AutoRoleRule | null {
  if (!isRecord(raw)) return null;
  const key = str(raw["key"]);
  const roleId = str(raw["roleId"]);
  const trigger = parseTrigger(raw["trigger"]);
  if (key === null || roleId === null || trigger === null) return null;
  return {
    key,
    label: str(raw["label"]) ?? key,
    trigger,
    roleId,
    revokeWhenUnqualified: raw["revokeWhenUnqualified"] === true,
    // Absent means on: a rule that exists in the list was added deliberately,
    // and only an explicit `false` should stop it running.
    enabled: raw["enabled"] !== false,
  };
}

/**
 * Read the stored policy, dropping what cannot be understood.
 *
 * Duplicate keys collapse to the first, because the ledger treats a key as an
 * identity and two rules sharing one would let each revoke the other's grants.
 */
export function parseAutoRoles(raw: unknown): AutoRolePolicy {
  if (!isRecord(raw)) return DEFAULT_AUTO_ROLES;
  const list = Array.isArray(raw["rules"]) ? raw["rules"] : [];
  const seen = new Set<string>();
  const rules: AutoRoleRule[] = [];
  for (const entry of list) {
    const rule = parseRule(entry);
    if (rule === null || seen.has(rule.key)) continue;
    seen.add(rule.key);
    rules.push(rule);
  }
  return { enabled: raw["enabled"] === true, rules };
}

/**
 * The strict half, for the panel: the first thing wrong with this blob, or null.
 *
 * Read is forgiving so a live guild keeps working; write is not, so nobody saves
 * a rule that will be silently dropped the moment it is read back.
 */
export function validateAutoRoles(raw: unknown): string | null {
  if (!isRecord(raw)) return "policy must be an object";
  if (typeof raw["enabled"] !== "boolean") return "enabled must be a boolean";
  const list = raw["rules"];
  if (!Array.isArray(list)) return "rules must be a list";
  if (list.length > MAX_RULES) return `at most ${MAX_RULES} rules`;
  const seen = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const where = `rule ${index + 1}`;
    if (!isRecord(entry)) return `${where} must be an object`;
    const key = str(entry["key"]);
    if (key === null) return `${where} needs a key`;
    if (seen.has(key)) return `${where} repeats the key ${key}`;
    seen.add(key);
    if (str(entry["roleId"]) === null) return `${where} needs a role`;
    if (entry["label"] !== undefined && str(entry["label"]) === null) return `${where} has an empty label`;
    if (entry["revokeWhenUnqualified"] !== undefined && typeof entry["revokeWhenUnqualified"] !== "boolean") {
      return `${where}: revokeWhenUnqualified must be a boolean`;
    }
    if (entry["enabled"] !== undefined && typeof entry["enabled"] !== "boolean") {
      return `${where}: enabled must be a boolean`;
    }
    const trigger = entry["trigger"];
    if (!isRecord(trigger)) return `${where} needs a trigger`;
    const kind = trigger["kind"];
    if (typeof kind !== "string" || !(AUTO_ROLE_TRIGGERS as readonly string[]).includes(kind)) {
      return `${where}: trigger must be one of ${AUTO_ROLE_TRIGGERS.join(", ")}`;
    }
    if (kind === "GUILD_RANK" && str(trigger["rank"]) === null) return `${where} needs a rank name`;
    if (kind === "ACHIEVEMENT" && str(trigger["definitionKey"]) === null) return `${where} needs an achievement`;
    if ((kind === "XP_LEVEL" || kind === "EVENTS_ATTENDED") && count(trigger["atLeast"]) === null) {
      return `${where}: atLeast must be a whole number of at least 0`;
    }
  }
  return null;
}

