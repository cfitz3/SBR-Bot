/**
 * The channel slots the Mapping page renders, with the copy that explains each.
 *
 * A literal list rather than an import of `CONFIG_CHANNEL_SLOTS`: this module is
 * loaded by the browser, and the client half has no bundler, so a runtime import
 * of a workspace package would emit a bare specifier nothing can resolve. The
 * duplication is deliberate and guarded — `channel-slots.test.ts` runs under
 * Node, imports the registry, and fails if this list drifts from it.
 *
 * The hints answer the question people actually arrive with, which is not "what
 * is this slot" but "what stopped working because it is empty".
 */
export interface ChannelSlotCopy {
  readonly slot: string;
  readonly label: string;
  readonly hint: string;
}

export const CHANNEL_SLOT_COPY: readonly ChannelSlotCopy[] = [
  {
    slot: "bridge",
    label: "Bridge",
    hint: "Relayed to and from guild chat. Unset means the bridge has nowhere to speak.",
  },
  { slot: "staff", label: "Staff", hint: "Staff-only notices: safety sweeps, escalations." },
  { slot: "log", label: "Log", hint: "Moderation and config audit trail." },
  {
    slot: "applications",
    label: "Applications",
    hint: "Where new applications are posted for review.",
  },
  { slot: "events", label: "Events", hint: "Event announcements and RSVP posts." },
  {
    slot: "lfg",
    label: "Looking for group",
    hint: "Where /lfg posts land. Unset and the post has nowhere to go, so the command refuses.",
  },
  {
    slot: "tickets",
    label: "Ticket panel",
    hint: "Holds the open-a-ticket message. Threads for new tickets are created under it.",
  },
  {
    slot: "milestones",
    label: "Milestones",
    hint: "Achievement and milestone announcements. Unset means they are recorded but never shown.",
  },
  {
    slot: "leaderboard",
    label: "Leaderboards",
    hint: "Where scheduled leaderboard posts are published.",
  },
  {
    slot: "modlog",
    label: "Moderation log",
    hint: "Per-action moderation record. Separate from Log so audit noise can stay out of a staff-visible channel.",
  },
];
