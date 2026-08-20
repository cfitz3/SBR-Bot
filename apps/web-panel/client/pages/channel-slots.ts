/**
 * The channel slots the Mapping page renders, in the order it renders them.
 *
 * A literal list rather than an import of `CONFIG_CHANNEL_SLOTS`: this module is
 * loaded by the browser, and the client half has no bundler, so a runtime import
 * of a workspace package would emit a bare specifier nothing can resolve. The
 * duplication is deliberate and guarded — `channel-slots.test.ts` runs under
 * Node, imports the registry, and fails if this list drifts from it.
 *
 * The *words* for each slot are not here: they are copy, and live under
 * `panel.channelSlot.<slot>` in the brand layer. What stays is the one thing
 * that is genuinely structure — which slots exist and in what order.
 */
import { scope, type PanelCopy } from "../copy.js";

const t = scope("channelSlot");

export type ChannelSlot = keyof PanelCopy["channelSlot"];

export interface ChannelSlotCopy {
  readonly slot: ChannelSlot;
  readonly label: string;
  readonly hint: string;
}

/** Registry order. Must match `CONFIG_CHANNEL_SLOTS` exactly; the test enforces it. */
export const CHANNEL_SLOT_ORDER = [
  "bridge",
  "staff",
  "log",
  "applications",
  "events",
  "lfg",
  "tickets",
  "milestones",
  "leaderboard",
  "modlog",
  "welcome",
] as const satisfies readonly ChannelSlot[];

/**
 * The slots with their resolved words.
 *
 * A function rather than a constant because copy does not exist until the
 * bootstrap fetch resolves, and a module-level constant would read it at import
 * time — before there is anything to read.
 */
export function channelSlotCopy(): readonly ChannelSlotCopy[] {
  return CHANNEL_SLOT_ORDER.map((slot) => ({ slot, label: t(slot).label, hint: t(slot).hint }));
}
