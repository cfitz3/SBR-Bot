/**
 * Settings (WEB_PANEL.md §3.10) — the guild's own switches: bridge relay,
 * recruitment, and the read-only facts that identify the guild.
 *
 * Channel slots, role mappings and feature flags live on the Mapping page
 * instead. The split is by *what a change does*, not by which table it lands in:
 * this page changes how the platform behaves, Mapping changes where it points.
 */
import type { SettingsVM } from "@sbr/panel-core";
import { loadPage, postAction } from "../api.js";
import { card, deniedState, errorState, pageTitle, spinner } from "../components.js";
import { fieldGroup, parseThreshold, textField, toggleField, validateThreshold } from "../forms.js";
import { h, replace } from "../dom.js";
import { count } from "../format.js";

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

  /**
   * `setRecruitment` takes the open flag on every call, so a threshold save has
   * to send the current one. Held here and updated only after a write lands, so
   * a refused toggle can't leave the next threshold save carrying a value the
   * server rejected.
   */
  let recruitmentOpen = config.applicationsOpen;

  const bridge = fieldGroup(
    toggleField({
      label: "Suspend the Discord ↔ in-game bridge",
      checked: config.bridgeSuspended,
      hint: "Stops relaying in both directions without taking the bot offline. Commands keep working.",
      save: (next) => postAction(guildId, "bridge.suspend", { suspended: next }),
    }),
  );

  const recruitment = fieldGroup(
    toggleField({
      label: "Applications open",
      checked: config.applicationsOpen,
      hint: "Closed hides the apply flow and turns away new applications.",
      save: async (next) => {
        // Thresholds omitted, not nulled: RecruitmentSettings treats absent as
        // "leave the bar alone", and sending null here would wipe a guild's
        // entry requirements every time someone opened applications.
        const written = await postAction(guildId, "config.recruitment", { open: next });
        if (written.kind === "ok") recruitmentOpen = next;
        return written;
      },
    }),
    textField({
      label: "Minimum Senither weight",
      value: config.minWeight === null ? "" : String(config.minWeight),
      hint: "Blank means no weight requirement.",
      placeholder: "no requirement",
      validate: validateThreshold,
      save: (raw) =>
        postAction(guildId, "config.recruitment", { open: recruitmentOpen, minWeight: parseThreshold(raw) }),
    }),
    textField({
      label: "Minimum networth",
      value: config.minNetworth === null ? "" : String(config.minNetworth),
      hint: "In coins, blank for no requirement.",
      placeholder: "no requirement",
      validate: validateThreshold,
      save: (raw) =>
        postAction(guildId, "config.recruitment", { open: recruitmentOpen, minNetworth: parseThreshold(raw) }),
    }),
  );

  // No mutation exists for these two yet, so they are shown rather than hidden:
  // "what timezone do the schedules use" is a question this page should answer
  // even while the answer is only editable from a staff command.
  const identity = fieldGroup(
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

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Settings", `${count(Object.keys(config.features).length)} feature flag(s) — edit those on Mapping`),
      card("Bridge", bridge),
      card("Recruitment", recruitment),
      card("Guild", identity),
    ),
  );
}
