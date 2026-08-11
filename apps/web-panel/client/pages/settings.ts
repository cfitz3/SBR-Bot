/**
 * Settings (WEB_PANEL.md §3.10) — the guild's own switches: bridge relay,
 * recruitment, and the read-only facts that identify the guild.
 *
 * Channel slots, role mappings and feature flags live on the Mapping page
 * instead. The split is by *what a change does*, not by which table it lands in:
 * this page changes how the platform behaves, Mapping changes where it points.
 */
import type { SettingsVM } from "@sbr/panel-core";
import type { ScreeningPolicyView } from "@sbr/screening";
import { loadPage, postAction } from "../api.js";
import { card, deniedState, errorState, pageTitle, spinner } from "../components.js";
import {
  fieldGroup,
  parseThreshold,
  textField,
  toggleField,
  validateCoins,
  validateThreshold,
  validateWhole,
} from "../forms.js";
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
      card("Join screening", screening),
      card("Guild", identity),
    ),
  );
}
