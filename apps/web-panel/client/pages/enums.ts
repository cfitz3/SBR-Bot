/**
 * Browser-side copies of the platform enums these pages render options from.
 *
 * Literal declarations rather than an import of `@sbr/shared-types`, for the
 * same reason as `channel-slots.ts`: these modules are loaded by the browser,
 * and the client half has no bundler, so a runtime import of a workspace
 * package emits a bare specifier the browser cannot resolve. Unlike a view
 * model, which travels as `import type` and erases at emit, these are const
 * objects — real values at runtime — so there is nothing to erase and the
 * import survives into the served JavaScript.
 *
 * That failure is not local to the page that does it: `main.ts` imports every
 * page statically, so one unresolvable specifier fails the whole module graph
 * and the shell never gets past its `Loading…` placeholder.
 *
 * The duplication is deliberate and guarded — `enums.test.ts` runs under Node,
 * imports the real registries, and fails if any list here drifts from them.
 */

/** Metrics a milestone can be measured against (`MILESTONE_METRICS`). */
export const MILESTONE_METRICS = [
  "networth",
  "skillAverage",
  "catacombsLevel",
  "slayerXp",
  "senitherWeight",
] as const;
export type MilestoneMetric = (typeof MILESTONE_METRICS)[number];

/** What kind of thing a milestone recognises. */
export const MilestoneType = {
  SKILL_LEVEL: "SKILL_LEVEL",
  CATACOMBS_LEVEL: "CATACOMBS_LEVEL",
  SLAYER_TIER: "SLAYER_TIER",
  NETWORTH_THRESHOLD: "NETWORTH_THRESHOLD",
  COLLECTION: "COLLECTION",
  CUSTOM: "CUSTOM",
} as const;
export type MilestoneType = (typeof MilestoneType)[keyof typeof MilestoneType];

/** The fixed category a ticket type is filed under for reporting. */
export const TicketCategory = {
  SUPPORT: "SUPPORT",
  REPORT: "REPORT",
  APPEAL: "APPEAL",
  APPLICATION: "APPLICATION",
  OTHER: "OTHER",
} as const;
export type TicketCategory = (typeof TicketCategory)[keyof typeof TicketCategory];

/**
 * What a member is allowed to do through the bridge. The panel offers this list
 * as an automod exemption: it is the guild-chat side's staff check, where there
 * are no Discord roles to exempt.
 */
export const BridgeCapability = {
  RELAY_MESSAGE: "RELAY_MESSAGE",
  RUN_COMMAND: "RUN_COMMAND",
  MENTION: "MENTION",
  BYPASS_FILTER: "BYPASS_FILTER",
  BYPASS_COOLDOWN: "BYPASS_COOLDOWN",
  ADMIN: "ADMIN",
} as const;
export type BridgeCapability = (typeof BridgeCapability)[keyof typeof BridgeCapability];

/** How a wordlist rule's pattern is matched against a message. */
export const WordMatchType = {
  EXACT: "EXACT",
  SUBSTRING: "SUBSTRING",
  REGEX: "REGEX",
  WILDCARD: "WILDCARD",
} as const;
export type WordMatchType = (typeof WordMatchType)[keyof typeof WordMatchType];

/** What the relay does when a wordlist rule matches. */
export const WordAction = {
  BLOCK: "BLOCK",
  FLAG: "FLAG",
  REPLACE: "REPLACE",
  SHADOW_MUTE: "SHADOW_MUTE",
} as const;
export type WordAction = (typeof WordAction)[keyof typeof WordAction];
