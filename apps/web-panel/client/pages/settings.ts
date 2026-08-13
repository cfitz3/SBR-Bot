/**
 * Settings — everything an admin configures, on one page.
 *
 * It absorbed the old Mapping and XP pages. The split between them was by which
 * table a change landed in, which is not a distinction anyone browsing the panel
 * can predict: "is the bridge suspended" and "which channel does the bridge use"
 * are the same question asked twice, and they were two tabs apart. Sections here
 * are ordered by how often they are touched, not by which service owns them.
 *
 * Role bindings used to be a card here. They moved to Permissions, which owns
 * the whole question of what a level *is* — one page writes them, in one shape.
 */
import type { SettingsVM } from "@sbr/panel-core";
import type { ScreeningPolicyView } from "@sbr/screening";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { card, deniedState, errorState, pageTitle, spinner } from "../components.js";
import {
  channelPicker,
  fieldGroup,
  parseThreshold,
  textField,
  toggleField,
  validateCoins,
  validateThreshold,
  validateWhole,
} from "../forms.js";
import { h, replace } from "../dom.js";
import { CHANNEL_SLOT_COPY } from "./channel-slots.js";
import { xpSection } from "./settings-xp.js";

/** Mirrors the mutation layer's `FEATURE_NAME`; see forms.ts on why both exist. */
const FEATURE_NAME = /^[a-z][a-z0-9-]{1,39}$/;

export async function renderSettings(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading settings…"));

  const result = await loadPage<SettingsVM>(`/api/guilds/${encodeURIComponent(guildId)}/settings`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderSettings(host, guildId)));
  }

  const config = result.data.config;
  if (config === null) {
    return replace(
      host,
      h(
        "div",
        {},
        pageTitle("Settings"),
        errorState("This guild has no configuration row yet. Run any staff command once to create it, then reload."),
      ),
    );
  }

  const bridge = fieldGroup(
    toggleField({
      label: "Suspend the Discord ↔ in-game bridge",
      checked: config.bridgeSuspended,
      hint: "Stops relaying in both directions without taking the bot offline. Commands keep working.",
      save: (next) => postAction(guildId, "bridge.suspend", { suspended: next }),
    }),
  );

  const channels = fieldGroup(
    ...CHANNEL_SLOT_COPY.map(({ slot, label, hint }) =>
      channelPicker({
        label,
        hint,
        guildId,
        value: result.data.channels[slot] ?? "",
        placeholder: "not set",
        save: (raw) => postAction(guildId, "config.channel", { slot, channelId: raw }),
        clear: () => postAction(guildId, "config.channel", { slot, channelId: null }),
      }),
    ),
  );

  const flagNames = Object.keys(result.data.features).sort((a, b) => a.localeCompare(b));
  const features = fieldGroup(
    ...flagNames.map((feature) =>
      toggleField({
        label: feature,
        checked: result.data.features[feature] === true,
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
        if (written.kind === "ok") void renderSettings(host, guildId);
        return written;
      },
    }),
  );

  /**
   * Screening writes the whole policy every time (see `setScreeningPolicy`), so
   * the page keeps the current one and edits a copy. Updated only after a write
   * lands, for the same reason `recruitmentOpen` is: a field the server refused
   * must not travel along in the next field's save.
   */
  let policy: ScreeningPolicyView = result.data.screening;

  const saveScreening = (patch: Partial<ScreeningPolicyView>) => async () => {
    const next = { ...policy, ...patch };
    const written = await postAction(guildId, "config.screening", next);
    if (written.kind === "ok") policy = next;
    return written;
  };

  /** A screening switch: flip one flag, send the policy it produces. */
  const flag = (key: keyof ScreeningPolicyView, label: string, hint: string) =>
    toggleField({
      label,
      checked: policy[key] === true,
      hint,
      save: (next) => saveScreening({ [key]: next } as Partial<ScreeningPolicyView>)(),
    });

  /** A nullable bar. Blank means "don't check this", which is not zero. */
  const bar = (key: keyof ScreeningPolicyView, label: string, hint: string) =>
    textField({
      label,
      value: policy[key] === null ? "" : String(policy[key]),
      hint,
      placeholder: "no requirement",
      validate: validateThreshold,
      save: (raw) => saveScreening({ [key]: parseThreshold(raw) } as Partial<ScreeningPolicyView>)(),
    });

  const screening = fieldGroup(
    flag("enabled", "Screen join requests", "Off means the bot still records every request but decides nothing."),
    flag(
      "autoAccept",
      "Auto-accept clean requests",
      "Sends /guild accept when a request passes. Leave off for a week first and read what it would have done.",
    ),
    flag("denyOnScammer", "Deny listed scammers", "A SkyKings match is refused outright rather than queued."),
    flag(
      "reviewOnScammerUnknown",
      "Hold when the scammer list is unreachable",
      "An outage should not read as a clean record.",
    ),
    flag("denyOnPriorExpulsion", "Deny previously kicked or banned players", "Checked against this guild's own record."),
    flag("reviewOnUnreadable", "Hold when the account's stats can't be read", "Usually an applicant with their API off."),
    bar("minSkyblockLevel", "Minimum Skyblock level", "Blank for no level requirement."),
    bar("minSkillAverage", "Minimum skill average", "Blank for no skill requirement."),
    bar("minCatacombs", "Minimum Catacombs level", "Blank for no dungeon requirement."),
    bar("minSenitherWeight", "Minimum Senither weight", "Blank for no weight requirement."),
    textField({
      label: "Minimum networth",
      value: policy.minNetworth ?? "",
      hint: "In coins, blank for no requirement. Typed in full — 10000000000, not 10b.",
      placeholder: "no requirement",
      validate: validateCoins,
      save: (raw) => saveScreening({ minNetworth: raw.trim().length === 0 ? null : raw.trim() })(),
    }),
    bar("minAccountAgeDays", "Minimum account age (days)", "Since Hypixel first saw them. Blank for no minimum."),
    bar("maxInactiveDays", "Hold if last seen more than (days) ago", "Blank to ignore how long they've been away."),
    textField({
      label: "Hold at risk score",
      value: String(policy.reviewAtRisk),
      hint: "0–100. A request that passes every rule but scores at or above this still waits for a human.",
      validate: (raw) => validateWhole(raw, 0, 100),
      save: (raw) => saveScreening({ reviewAtRisk: Number(raw) })(),
    }),
    textField({
      label: "Repeat window (days)",
      value: String(policy.repeatWindowDays),
      hint: "1–365. How far back repeat attempts are counted.",
      validate: (raw) => validateWhole(raw, 1, 365),
      save: (raw) => saveScreening({ repeatWindowDays: Number(raw) })(),
    }),
    textField({
      label: "Attempts allowed in that window",
      value: String(policy.maxAttemptsInWindow),
      hint: "1–100. Beyond this, the request waits for a human.",
      validate: (raw) => validateWhole(raw, 1, 100),
      save: (raw) => saveScreening({ maxAttemptsInWindow: Number(raw) })(),
    }),
  );

  // The Hypixel link is editable; the two below it are not. They are shown
  // rather than hidden because "what timezone do the schedules use" is a
  // question this page should answer even while a staff command owns the answer.
  const identity = fieldGroup(
    textField({
      label: "Hypixel guild",
      value: result.data.guild?.hypixelGuildId ?? "",
      hint:
        "The guild whose roster syncs here. Enter its name or its 24-character id; " +
        "clear the field to unlink. Nothing syncs until this is set.",
      placeholder: "Guild name or id",
      save: (raw) => postAction(guildId, "config.hypixel", { guild: raw }),
    }),
    textField({
      label: "Timezone",
      value: config.timezone,
      hint: "Used for event schedules and daily rollups. Change with /set-timezone.",
      readOnly: true,
      save: async () => ({ kind: "ok" }),
    }),
    textField({
      label: "Command prefixes",
      value: config.prefixes.join(" "),
      hint: "In-game chat prefixes the bridge answers to.",
      readOnly: true,
      save: async () => ({ kind: "ok" }),
    }),
  );

  // The unset-slot count leads because it is the single most common explanation
  // for "the bot isn't doing anything": almost every silent no-op traces back to
  // a channel nobody bound.
  const unset = CHANNEL_SLOT_COPY.filter(({ slot }) => !result.data.channels[slot]).length;

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Settings", unset === 0 ? "All channel slots assigned" : `${unset} channel slot(s) not set`),
      card("Guild", identity),
      card("Bridge", bridge),
      card("Channels", channels),
      card("Feature flags", features),
      card("Join screening", screening),
      ...xpSection(guildId, result.data.xp),
    ),
  );
}
