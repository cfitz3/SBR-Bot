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
import { scope } from "../copy.js";
import {
  channelPicker,
  fieldGroup,
  textField,
  toggleField,
  validateWhole,
} from "../forms.js";
import { h, replace } from "../dom.js";
import { channelSlotCopy } from "./channel-slots.js";
import { xpSection } from "./settings-xp.js";

const t = scope("settings");

/** Mirrors the mutation layer's `FEATURE_NAME`; see forms.ts on why both exist. */
const FEATURE_NAME = /^[a-z][a-z0-9-]{1,39}$/;

export async function renderSettings(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("settings"));

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
        pageTitle(t("title")),
        errorState(t("noConfig")),
      ),
    );
  }

  const bridge = fieldGroup(
    toggleField({
      label: t("suspendLabel"),
      checked: config.bridgeSuspended,
      hint: t("suspendHint"),
      save: (next) => postAction(guildId, "bridge.suspend", { suspended: next }),
    }),
  );

  const channels = fieldGroup(
    ...channelSlotCopy().map(({ slot, label, hint }) =>
      channelPicker({
        label,
        hint,
        guildId,
        value: result.data.channels[slot] ?? "",
        placeholder: t("channelUnset"),
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
      label: t("featureAddLabel"),
      value: "",
      hint: t("featureAddHint"),
      placeholder: t("featureAddPlaceholder"),
      validate: (raw) => (FEATURE_NAME.test(raw) ? null : t("errFeatureName")),
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

  // A `bar()` helper rendered the seven stat thresholds here. They are gone:
  // the scam check is the guild's only entry requirement, so screening reports
  // the account rather than grading it. The numbers are still read and still
  // shown on the join-attempt card — they simply no longer decide.

  const screening = fieldGroup(
    flag("enabled", t("screenEnabledLabel"), t("screenEnabledHint")),
    flag("autoAccept", t("autoAcceptLabel"), t("autoAcceptHint")),
    flag("denyOnScammer", t("denyScammerLabel"), t("denyScammerHint")),
    flag("reviewOnScammerUnknown", t("holdScammerLabel"), t("holdScammerHint")),
    flag("denyOnPriorExpulsion", t("denyExpelledLabel"), t("denyExpelledHint")),
    flag("reviewOnUnreadable", t("holdUnreadableLabel"), t("holdUnreadableHint")),
    textField({
      label: t("riskLabel"),
      value: String(policy.reviewAtRisk),
      hint: t("riskHint"),
      validate: (raw) => validateWhole(raw, 0, 100),
      save: (raw) => saveScreening({ reviewAtRisk: Number(raw) })(),
    }),
    textField({
      label: t("repeatWindowLabel"),
      value: String(policy.repeatWindowDays),
      hint: t("repeatWindowHint"),
      validate: (raw) => validateWhole(raw, 1, 365),
      save: (raw) => saveScreening({ repeatWindowDays: Number(raw) })(),
    }),
    textField({
      label: t("attemptsLabel"),
      value: String(policy.maxAttemptsInWindow),
      hint: t("attemptsHint"),
      validate: (raw) => validateWhole(raw, 1, 100),
      save: (raw) => saveScreening({ maxAttemptsInWindow: Number(raw) })(),
    }),
  );

  // The Hypixel link is editable; the two below it are not. They are shown
  // rather than hidden because "what timezone do the schedules use" is a
  // question this page should answer even while a staff command owns the answer.
  const identity = fieldGroup(
    textField({
      label: t("hypixelLabel"),
      value: result.data.guild?.hypixelGuildId ?? "",
      hint: t("hypixelHint"),
      placeholder: t("hypixelPlaceholder"),
      save: (raw) => postAction(guildId, "config.hypixel", { guild: raw }),
    }),
    textField({
      label: t("timezoneLabel"),
      value: config.timezone,
      hint: t("timezoneHint"),
      readOnly: true,
      save: async () => ({ kind: "ok" }),
    }),
    textField({
      label: t("prefixesLabel"),
      value: config.prefixes.join(" "),
      hint: t("prefixesHint"),
      readOnly: true,
      save: async () => ({ kind: "ok" }),
    }),
  );

  // The unset-slot count leads because it is the single most common explanation
  // for "the bot isn't doing anything": almost every silent no-op traces back to
  // a channel nobody bound.
  const unset = channelSlotCopy().filter(({ slot }) => !result.data.channels[slot]).length;

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(
        t("title"),
        unset === 0 ? t("subtitleAllSet") : t("subtitleUnset").replace("{count}", String(unset)),
      ),
      card(t("cardGuild"), identity),
      card(t("cardBridge"), bridge),
      card(t("cardChannels"), channels),
      card(t("cardFeatures"), features),
      card(t("cardScreening"), screening),
      ...xpSection(guildId, result.data.xp),
    ),
  );
}
