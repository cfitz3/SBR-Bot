/**
 * XP (WEB_PANEL.md §3.11) — what activity is worth, and the limits that stop
 * one member farming it.
 *
 * Admin-only, and deliberately configuration only: there is no leaderboard and
 * no member standing here. Those are member-facing, and the panel is not a
 * member-facing surface — `/standing` and `/leaderboard` are where a member
 * sees where they are. What this page owns is the rules everyone is scored by,
 * plus the one write that bypasses them: a hand-entered adjustment.
 */
import type { XpVM } from "@sbr/panel-core";
import type { XpSourcePolicyDTO } from "@sbr/shared-types";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { card, deniedState, emptyState, errorState, pageTitle, spinner } from "../components.js";
import { actionButton, fieldGroup, isSnowflake, reasonBox, statusSlot, textField, toggleField } from "../forms.js";
import { h, replace } from "../dom.js";

/** Mirrors the mutation layer's bounds; see forms.ts on why both exist. */
const MAX_WEIGHT = 1_000;
const MAX_DAILY_CAP = 1_000_000;
const MAX_COOLDOWN_SEC = 24 * 60 * 60;
const MAX_MIN_LENGTH = 500;
const MAX_ADJUSTMENT = 1_000_000;

/**
 * What each source counts, in the admin's terms rather than the enum's.
 *
 * The unit matters more than the name: a weight only means something once you
 * know what it multiplies, and "1 per 1000 guild XP" is the difference between
 * a sensible 0.01 and a runaway 10.
 */
const SOURCE_COPY: Readonly<Record<string, { readonly label: string; readonly unit: string }>> = {
  GEXP: { label: "Guild XP", unit: "one unit per guild XP earned that day" },
  DISCORD_MESSAGE: { label: "Discord messages", unit: "one unit per counted message" },
  GUILD_CHAT_MESSAGE: { label: "Guild chat messages", unit: "one unit per counted message" },
  TENURE: { label: "Tenure", unit: "one unit per day in the guild" },
  COMMAND_USAGE: { label: "Command use", unit: "one unit per counted command" },
  EVENT: { label: "Events", unit: "one unit per event attended" },
  MANUAL: { label: "Staff adjustments", unit: "one unit per XP entered by hand" },
};

function copyFor(source: string): { readonly label: string; readonly unit: string } {
  return SOURCE_COPY[source] ?? { label: source, unit: "one unit per recorded action" };
}

/** A number the admin typed, bounded. Empty is rejected, not defaulted to 0. */
function validateNumber(raw: string, max: number, whole: boolean): string | null {
  const text = raw.trim();
  const value = Number(text);
  if (text.length === 0 || !Number.isFinite(value) || value < 0 || value > max) {
    return `Enter a number between 0 and ${max}.`;
  }
  if (whole && !Number.isInteger(value)) return "Enter a whole number.";
  return null;
}

export async function renderXp(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading XP settings…"));

  const result = await loadPage<XpVM>(`/api/guilds/${encodeURIComponent(guildId)}/xp`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderXp(host, guildId)));
  }

  const { installed, sources } = result.data;
  if (!installed) {
    return replace(
      host,
      h(
        "div",
        {},
        pageTitle("XP", "Not enabled"),
        emptyState("Guild XP isn't switched on for this deployment, so there is nothing to configure here."),
      ),
    );
  }

  const cards = sources.map((policy) => sourceCard(guildId, policy));

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("XP", `${sources.filter((s) => s.enabled).length} of ${sources.length} sources counting`),
      h(
        "p",
        { class: "page-note" },
        "Changes apply from the next totalling pass onwards. Days already scored keep the numbers they were scored under.",
      ),
      ...cards,
      card("Adjust a member", adjustForm(guildId)),
    ),
  );
}

/**
 * One source's rules.
 *
 * Every control writes the whole row, because the mutation takes a whole
 * policy: a partial write would need the server to merge against what it has,
 * and a merge is where "I turned the cap off" and "I left the cap alone"
 * become the same request.
 */
function sourceCard(guildId: string, policy: XpSourcePolicyDTO): HTMLElement {
  const { label, unit } = copyFor(policy.source);
  // Mutable local copy so each control saves alongside its siblings' current
  // values rather than the values the page happened to load with.
  const current: { -readonly [K in keyof XpSourcePolicyDTO]: XpSourcePolicyDTO[K] } = { ...policy };

  const write = (patch: Partial<XpSourcePolicyDTO>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "xp.source", { ...current });
  };

  const messageSource = policy.source === "DISCORD_MESSAGE" || policy.source === "GUILD_CHAT_MESSAGE";

  return card(
    label,
    fieldGroup(
      toggleField({
        label: "Counts towards XP",
        hint: `Weight is ${unit}.`,
        checked: policy.enabled,
        save: (enabled) => write({ enabled }),
      }),
      textField({
        label: "Weight",
        hint: `XP awarded per unit — ${unit}. Fractions are allowed.`,
        value: String(policy.weight),
        validate: (raw) => validateNumber(raw, MAX_WEIGHT, false),
        save: (raw) => write({ weight: Number(raw.trim()) }),
      }),
      textField({
        label: "Daily cap",
        hint: "Most XP one member can earn from this source in a day. Clear it for no cap.",
        value: policy.dailyCap === null ? "" : String(policy.dailyCap),
        placeholder: "no cap",
        validate: (raw) => (raw.trim().length === 0 ? null : validateNumber(raw, MAX_DAILY_CAP, true)),
        save: (raw) => write({ dailyCap: raw.trim().length === 0 ? null : Number(raw.trim()) }),
        clear: () => write({ dailyCap: null }),
      }),
      textField({
        label: "Cooldown (seconds)",
        hint: "Minimum gap between two actions that count. 0 counts every one.",
        value: String(policy.cooldownSec),
        validate: (raw) => validateNumber(raw, MAX_COOLDOWN_SEC, true),
        save: (raw) => write({ cooldownSec: Number(raw.trim()) }),
      }),
      // Only shown where it means anything: a minimum length on tenure or on
      // guild XP would be a control that does nothing, which is worse than a
      // missing one — it invites someone to set it and expect an effect.
      messageSource
        ? textField({
            label: "Minimum message length",
            hint: "Shorter messages are ignored entirely. Keeps \"gg\" from being worth the same as a conversation.",
            value: String(policy.minLength),
            validate: (raw) => validateNumber(raw, MAX_MIN_LENGTH, true),
            save: (raw) => write({ minLength: Number(raw.trim()) }),
          })
        : null,
    ),
  );
}

/**
 * The manual adjustment form.
 *
 * Armed before it fires and cleared afterwards, because unlike everything else
 * on this page an adjustment is not a setting that can be corrected by typing
 * a different value — it is a ledger row, and the only way back is a second
 * adjustment in the other direction.
 */
function adjustForm(guildId: string): HTMLElement {
  const status = statusSlot();

  const member = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: "Discord user id",
    "aria-label": "Discord user id",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const amount = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: "e.g. 500 or -250",
    "aria-label": "XP amount, negative to deduct",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const reason = reasonBox("Why — this is stored on the member's XP history, not just the audit log.", 3);

  const button = actionButton({
    label: "Apply adjustment",
    tone: "danger",
    confirm: "Confirm adjustment",
    status,
    run: async () => {
      const discordId = member.value.trim();
      if (!isSnowflake(discordId)) return { kind: "error", message: "Enter a Discord user id." };
      const value = Number(amount.value.trim());
      if (!Number.isInteger(value) || value === 0 || Math.abs(value) > MAX_ADJUSTMENT) {
        return { kind: "error", message: `Enter a non-zero whole number within ±${MAX_ADJUSTMENT}.` };
      }
      if (reason.value.trim().length === 0) return { kind: "error", message: "A reason is required." };
      return postAction(guildId, "xp.adjust", { discordId, amount: value, reason: reason.value.trim() });
    },
    onDone: () => {
      // Emptied on success so the next adjustment starts from nothing. A form
      // still holding the last amount is how the same 5,000 XP gets applied
      // twice to two different people.
      member.value = "";
      amount.value = "";
      reason.value = "";
    },
  });

  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, "Adds or removes XP directly. Positive credits, negative deducts."),
    h("div", { class: "field-row" }, member, amount),
    reason,
    h("div", { class: "field-row" }, button),
    status.el,
  );
}
