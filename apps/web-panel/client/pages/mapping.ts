/**
 * Mapping (WEB_PANEL.md §3.9) — where the platform points: channel slots, the
 * platform-role → Discord-role bindings, and the feature flags.
 *
 * This is the page that most often explains "the bot isn't doing anything":
 * almost every silent no-op traces back to an unset channel or an unmapped role,
 * so each slot says what it is *for* rather than only what it is called.
 */
import type { MappingVM } from "@sbr/panel-core";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { card, deniedState, errorState, pageTitle, spinner } from "../components.js";
import { fieldGroup, textField, toggleField, validateSnowflake } from "../forms.js";
import { h, replace } from "../dom.js";

/** Slot id → what breaks when it is unset. */
const CHANNEL_SLOTS: readonly (readonly [string, string, string])[] = [
  ["bridge", "Bridge", "Relayed to and from guild chat. Unset means the bridge has nowhere to speak."],
  ["staff", "Staff", "Staff-only notices: safety sweeps, escalations."],
  ["log", "Log", "Moderation and config audit trail."],
  ["applications", "Applications", "Where new applications are posted for review."],
  ["events", "Events", "Event announcements and RSVP posts."],
];

/**
 * Every platform role, including MEMBER and OWNER.
 *
 * The low and high ends are the ones people forget: an unmapped MEMBER role
 * means verification grants nothing visible, and an unmapped OWNER is why a
 * server owner can find themselves unable to use owner commands.
 */
const ROLES: readonly (readonly [string, string])[] = [
  ["MEMBER", "Verified member"],
  ["MODERATOR", "Moderator"],
  ["OFFICER", "Officer"],
  ["ADMIN", "Admin"],
  ["OWNER", "Owner"],
];

/** Mirrors the mutation layer's `FEATURE_NAME`; see forms.ts on why both exist. */
const FEATURE_NAME = /^[a-z][a-z0-9-]{1,39}$/;

export async function renderMapping(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading mapping…"));

  const result = await loadPage<MappingVM>(`/api/guilds/${encodeURIComponent(guildId)}/mapping`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderMapping(host, guildId)));
  }

  const { channels, roleMappings, features } = result.data;

  const channelFields = fieldGroup(
    ...CHANNEL_SLOTS.map(([slot, label, hint]) =>
      textField({
        label,
        hint,
        value: channels[slot] ?? "",
        placeholder: "not set",
        validate: validateSnowflake("channel"),
        save: (raw) => postAction(guildId, "config.channel", { slot, channelId: raw }),
        clear: () => postAction(guildId, "config.channel", { slot, channelId: null }),
      }),
    ),
  );

  const roleFields = fieldGroup(
    ...ROLES.map(([role, label]) =>
      textField({
        label,
        hint: `Discord role granted to ${label.toLowerCase()}s, and read back when deciding what they may do.`,
        value: roleMappings[role] ?? "",
        placeholder: "not set",
        validate: validateSnowflake("role"),
        save: (raw) => postAction(guildId, "config.role-mapping", { role, discordRoleId: raw }),
        clear: () => postAction(guildId, "config.role-mapping", { role, discordRoleId: null }),
      }),
    ),
  );

  const names = Object.keys(features).sort((a, b) => a.localeCompare(b));
  const featureFields = fieldGroup(
    ...names.map((feature) =>
      toggleField({
        label: feature,
        checked: features[feature] === true,
        save: (enabled) => postAction(guildId, "config.feature", { feature, enabled }),
      }),
    ),
    textField({
      label: "Add a flag",
      value: "",
      hint: "Lowercase letters, digits and dashes. Created enabled; toggle it off above afterwards.",
      placeholder: "events",
      validate: (raw) =>
        FEATURE_NAME.test(raw) ? null : "Use 2–40 lowercase letters, digits or dashes, starting with a letter.",
      save: async (feature): Promise<WriteResult> => {
        const written = await postAction(guildId, "config.feature", { feature, enabled: true });
        // Re-read rather than splice a row in: the new flag has to come back
        // from the server for the page to be showing stored state, and a
        // locally-appended toggle would survive even if the write silently
        // landed on a different guild's config.
        if (written.kind === "ok") void renderMapping(host, guildId);
        return written;
      },
    }),
  );

  const unset = CHANNEL_SLOTS.filter(([slot]) => !channels[slot]).length;

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Mapping", unset === 0 ? "All channel slots assigned" : `${unset} channel slot(s) not set`),
      card("Channels", channelFields),
      card("Roles", roleFields),
      card("Feature flags", featureFields),
    ),
  );
}
