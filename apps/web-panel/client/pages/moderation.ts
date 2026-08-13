/**
 * Moderation (WEB_PANEL.md §3.6) — everything that answers "what happens to
 * this member", in one place.
 *
 * Four sections, one page, no sub-routes. They are here together because they
 * are the same job seen at four distances: History is what staff did on
 * purpose, Automod and Filter are what the platform does without them, and
 * Cooldowns is the floor under everyone. Splitting them across pages is how the
 * panel ended up with a Filter tab nobody could relate to the warnings ladder
 * three clicks away.
 *
 * History is Moderator-tier, which is the page's own gate. The other three
 * configure the guild and are Admin-tier: `canConfigure` comes down with the
 * view model per load, exactly as the Tickets page does it, so a moderator sees
 * the section they can use rather than three tabs that refuse them.
 *
 * The action form deliberately does not pre-check rank. Whether the actor
 * outranks the target is `ModerationService`'s decision, and a second copy of
 * that rule here would be one that drifts — so a refusal arrives as a message on
 * the form rather than as a control that was never offered.
 */
import type { ModerationActionVM, ModerationVM } from "@sbr/panel-core";
import type { InfractionDTO } from "@sbr/shared-types";
import { loadPage, postAction, type WriteResult } from "../api.js";
import {
  badge,
  card,
  deniedState,
  emptyState,
  errorState,
  pageTitle,
  spinner,
  table,
  type BadgeTone,
} from "../components.js";
import { h, replace } from "../dom.js";
import {
  actionButton,
  fieldGroup,
  idChooser,
  isSnowflake,
  multiPickerField,
  reasonBox,
  selectField,
  statusSlot,
  textField,
  toggleField,
} from "../forms.js";
import { count, describeSpan, parseDurationSeconds, relativeTime } from "../format.js";
import { BridgeCapability } from "./enums.js";
import { filterCards } from "./wordlist.js";

/** The actions the panel is allowed to issue — mirrors `PANEL_ACTIONS`. */
const ACTIONS: readonly (readonly [string, string, string])[] = [
  ["NOTE", "Note", "A private record. Nothing is enforced and the member is not told."],
  ["WARN", "Warn", "A logged warning the member is notified about."],
  ["MUTE", "Mute", "Silences the member on Discord and in guild chat."],
  ["UNMUTE", "Unmute", "Lifts an active mute early."],
  ["KICK", "Kick", "Removes the member; they can rejoin with an invite."],
  ["BAN", "Ban", "Removes the member and blocks their return."],
  ["UNBAN", "Unban", "Lifts a ban."],
];

/** Only these two carry a duration; the rest are instantaneous. */
const TIMED = new Set(["MUTE", "BAN"]);

type Section = "history" | "automod" | "filter" | "cooldowns";

const SECTIONS: readonly (readonly [Section, string])[] = [
  ["history", "History"],
  ["automod", "Automod"],
  ["filter", "Filter"],
  ["cooldowns", "Cooldowns"],
];

/**
 * Survives a tab switch so coming back to the page keeps your place — including
 * which rule you had open, because saving a rule re-reads the page and landing
 * back on a collapsed list would lose the edit you were halfway through.
 */
const state: { target: string; section: Section; editing: string | null } = {
  target: "",
  section: "history",
  editing: null,
};

// ─────────────────────────── client-side bounds ───────────────────────────
// Mirrors of the mutation layer's limits; see forms.ts on why both exist. The
// server is the authority — these only save a round trip on a typo.
const RULE_NAME_MAX = 60;
const PATTERN_MAX = 300;
const WINDOW_MAX = 3_600;
const MUTE_MAX = 86_400;
const COOLDOWN_MAX = 600;
const ALLOWLIST_MAX = 50;

const TRIGGER_OPTIONS: readonly (readonly [string, string])[] = [
  ["wordlist", "a word on the chat filter"],
  ["regex", "a pattern"],
  ["spam", "too many messages"],
  ["repeat", "the same message repeated"],
  ["mentions", "too many mentions"],
  ["caps", "shouting"],
  ["links", "a link"],
  ["invites", "a Discord invite"],
];

/** What each trigger actually watches, in the guild's terms. */
const TRIGGER_HINT: Readonly<Record<string, string>> = {
  wordlist: "Runs the guild's chat filter over the message. One list, both features.",
  regex: "A regular expression, compiled as written. Refused at save time if it doesn't compile.",
  spam: "Counts one author's messages in a rolling window.",
  repeat: "Counts how often one author sent this exact text in a rolling window.",
  mentions: "Counts the mentions in a single message.",
  caps: "The share of letters in upper case, over a minimum length so “OK” doesn't trip it.",
  links: "Any link whose host is not on the allowlist. An empty allowlist catches every link.",
  invites: "A discord.gg (or equivalent) invite anywhere in the message.",
};

const ACTION_OPTIONS: readonly (readonly [string, string])[] = [
  ["FLAG", "record it"],
  ["WARN", "warn them"],
  ["MUTE", "mute them"],
];

const ACTION_HINT: Readonly<Record<string, string>> = {
  FLAG: "Recorded and shown to staff. Nothing happens to the member — start new rules here.",
  WARN: "A warning, which counts towards the escalation ladder on the Filter section.",
  MUTE: "A mute, carried into guild chat by the sync rows on the Filter section.",
};

const CAPABILITY_OPTIONS: readonly (readonly [string, string])[] = [
  ["", "nobody"],
  ...Object.keys(BridgeCapability).map((v) => [v, v.toLowerCase().replace(/_/g, " ")] as const),
];

export async function renderModeration(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading moderation…"));

  const query = state.target ? `?target=${encodeURIComponent(state.target)}` : "";
  const result = await loadPage<ModerationVM>(
    `/api/guilds/${encodeURIComponent(guildId)}/moderation${query}`,
  );
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderModeration(host, guildId)));
  }

  const data = result.data;
  const rerender = (): void => void renderModeration(host, guildId);

  // A moderator has one section, so the tab strip would be a row of refusals.
  if (!data.canConfigure && state.section !== "history") state.section = "history";
  const sections = data.canConfigure ? SECTIONS : SECTIONS.slice(0, 1);

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Moderation", subtitle(data)),
      sections.length > 1 ? sectionTabs(sections, rerender) : null,
      ...sectionBody(guildId, data, rerender),
    ),
  );
}

function subtitle(data: ModerationVM): string {
  switch (state.section) {
    case "automod": {
      const live = data.automod.rules.filter((r) => r.enabled).length;
      return data.automod.enabled
        ? `${count(live)} of ${count(data.automod.rules.length)} rules live`
        : "Switched off — rules are kept but nothing fires";
    }
    case "filter":
      return "The chat filter, the warning ladder, and what a punishment does in guild chat";
    case "cooldowns":
      return "How long a member waits between commands, and between relayed messages";
    default:
      return data.target
        ? `${count(data.infractionCount)} infraction(s) on record for this member`
        : "Guild-wide audit trail — pick a member to narrow it";
  }
}

function sectionTabs(sections: readonly (readonly [Section, string])[], rerender: () => void): HTMLElement {
  return h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "Moderation section" },
    ...sections.map(([id, label]) => {
      const button = h("button", {
        type: "button",
        class: "tab",
        role: "tab",
        "aria-selected": id === state.section ? "true" : "false",
      }, label);
      button.addEventListener("click", () => {
        if (id === state.section) return;
        state.section = id;
        rerender();
      });
      return button;
    }),
  );
}

function sectionBody(guildId: string, data: ModerationVM, rerender: () => void): readonly (HTMLElement | null)[] {
  switch (state.section) {
    case "automod":
      return automodSection(guildId, data, rerender);
    case "filter":
      return filterCards(guildId, data.filter, rerender);
    case "cooldowns":
      return [card("Cooldowns", cooldownsBody(guildId, data))];
    default:
      return historySection(guildId, data, rerender);
  }
}

// ─────────────────────────── 1. history ───────────────────────────

function historySection(guildId: string, data: ModerationVM, rerender: () => void): readonly (HTMLElement | null)[] {
  return [
    card("Look up a member", lookupBody(guildId, rerender)),
    card("Issue an action", actionForm(guildId, rerender)),
    data.target ? card("Infractions", infractionsBody(data.infractions, true)) : null,
    card("In force now", inForceBody(data)),
    card(data.target ? "Actions on this member" : "Recent actions", actionsBody(data)),
    // Only worth showing when no target is picked: with one, the card above it
    // is the same list narrowed to the person actually being asked about.
    data.target ? null : card("Recent infractions", infractionsBody(data.recentInfractions, false)),
  ];
}

/**
 * The lookup box takes a name, not just an id.
 *
 * The picker searches the merged directory, so a username or an IGN resolves to
 * the Discord id the history is keyed by. Pasting an id still works, because
 * with the directory down that is the only route through.
 */
function lookupBody(guildId: string, rerender: () => void): HTMLElement {
  const note = h("p", { class: "field-hint" }, "");

  function look(): void {
    const raw = chooser.value();
    if (raw.length > 0 && !isSnowflake(raw)) {
      note.textContent = "No member matched. Pick one from the list, or paste their Discord user id.";
      return;
    }
    state.target = raw;
    rerender();
  }

  // Picking a member is the whole intent here, so a selection searches straight
  // away rather than waiting for the button — which stays for the paste path.
  const chooser = idChooser({
    guildId,
    kind: "member",
    value: state.target,
    placeholder: "Search by name, IGN, or paste an id",
    ariaLabel: "Member to look up",
    onPick: look,
    onCommit: look,
  });

  return h(
    "div",
    { class: "fields" },
    h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "field-row" },
        chooser.el,
        h("button", { class: "button button-primary", type: "button", onclick: look }, "Look up"),
        state.target
          ? h("button", {
              class: "button",
              type: "button",
              onclick: () => {
                state.target = "";
                rerender();
              },
            }, "Clear")
          : null,
      ),
      note,
    ),
  );
}

/**
 * The one composite form in the panel.
 *
 * Every other write is a single field that saves itself, but a moderation
 * action is not meaningful in pieces — a type without a reason is a row the
 * audit log should never hold — so this one submits as a unit.
 */
function actionForm(guildId: string, rerender: () => void): HTMLElement {
  const status = statusSlot();

  const type = h("select", { class: "control control-select", "aria-label": "Action" },
    ...ACTIONS.map(([value, label]) => h("option", { value }, label)),
  ) as HTMLSelectElement;

  const target = idChooser({
    guildId,
    kind: "member",
    value: state.target,
    placeholder: "Search by name, or paste an id",
    ariaLabel: "Member to act on",
  });

  const duration = h("input", {
    class: "control control-text control-short",
    type: "text",
    placeholder: "e.g. 30m, 2h, 7d",
    autocomplete: "off",
    "aria-label": "Duration",
  }) as HTMLInputElement;

  const durationRow = h(
    "div",
    { class: "field" },
    h("label", { class: "field-label" }, "Duration"),
    h("div", { class: "field-row" }, duration),
    h("p", { class: "field-hint" }, "Leave blank for permanent. Only mutes and bans take a duration."),
  );

  const reason = reasonBox("Why this action was taken — this is the audit record", 3);
  const explain = h("p", { class: "field-hint" }, ACTIONS[0]![2]);

  function syncType(): void {
    const chosen = ACTIONS.find(([value]) => value === type.value);
    explain.textContent = chosen ? chosen[2] : "";
    // Hidden rather than disabled: an untimed action has no duration at all, and
    // a greyed-out box invites the reader to wonder what would unlock it.
    durationRow.hidden = !TIMED.has(type.value);
  }
  type.addEventListener("change", syncType);
  syncType();

  const submit = actionButton({
    label: "Apply action",
    tone: "primary",
    status,
    run: async () => {
      const targetId = target.value();
      if (!isSnowflake(targetId)) {
        return { kind: "error", message: "Pick the member to act on, or paste their Discord user id." };
      }
      const note = reason.value.trim();
      if (note.length === 0) {
        return { kind: "error", message: "A reason is required — it's what the audit row will say." };
      }

      let durationSeconds: number | null = null;
      if (TIMED.has(type.value)) {
        const parsed = parseDurationSeconds(duration.value);
        if (parsed === "invalid") {
          return { kind: "error", message: "Duration must look like 30m, 2h or 7d, up to a year." };
        }
        durationSeconds = parsed;
      }

      return postAction(guildId, "moderation.action", {
        type: type.value,
        targetDiscordId: targetId,
        reason: note,
        // Omitted rather than nulled for the untimed actions, which refuse a
        // duration key outright.
        ...(durationSeconds === null ? {} : { durationSeconds }),
      });
    },
    onDone: () => {
      reason.value = "";
      duration.value = "";
      // The history below is now out of date by exactly this action.
      state.target = target.value();
      rerender();
    },
  });

  return h(
    "div",
    { class: "fields" },
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, "Action"),
      h("div", { class: "field-row" }, type),
      explain,
    ),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, "Member"),
      h("div", { class: "field-row" }, target.el),
    ),
    durationRow,
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, "Reason"),
      h("div", { class: "field-row" }, reason),
    ),
    h("div", { class: "field-row" }, submit, status.el),
  );
}

/**
 * Infractions, for one member or for the whole guild.
 *
 * The guild-wide list carries a Member column the per-member one does not: with
 * a target chosen, every row would repeat the id already in the search box.
 */
function infractionsBody(rows: readonly InfractionDTO[], targeted: boolean): HTMLElement {
  if (rows.length === 0) {
    return emptyState(
      targeted ? "No infractions on record for this member." : "No infractions recorded in this guild yet.",
    );
  }
  const headers = targeted
    ? ["Type", "Severity", "Reason", "When"]
    : ["Member", "Type", "Severity", "Reason", "When"];
  return table(
    headers,
    rows.map((row) => {
      const cells: (string | HTMLElement)[] = [
        row.type,
        badge(row.severity, severityTone(row.severity)),
        row.reason,
        relativeTime(row.createdAt),
      ];
      return targeted ? cells : [h("code", {}, row.targetDiscordId ?? "—"), ...cells];
    }),
  );
}

/**
 * What is *currently being enforced*, as opposed to what has happened.
 *
 * The actions table below is a history and answers "what was done"; a staffer
 * deciding whether to escalate is asking the different question "is this person
 * already muted right now", and reading that off a history means eyeballing
 * every row's expiry. The server has already resolved it, so it gets its own
 * card.
 */
function inForceBody(data: ModerationVM): HTMLElement {
  if (data.inForce.length === 0) {
    return emptyState(
      data.target
        ? "Nothing is currently being enforced against this member."
        : "Nobody in this guild is muted or banned right now.",
    );
  }
  return table(
    ["Action", "Member", "By", "Reason", "Ends", "Since"],
    data.inForce.map((row) => [
      h("div", { class: "job-cell" }, row.type, badge("in force", "warn")),
      h("code", {}, row.targetDiscordId ?? "—"),
      h("code", {}, row.actorDiscordId),
      row.reason,
      row.expiresAt === null ? "never" : relativeTime(row.expiresAt),
      relativeTime(row.createdAt),
    ]),
  );
}

function actionsBody(data: ModerationVM): HTMLElement {
  if (data.actions.length === 0) {
    return emptyState(
      data.target ? "No panel or bot actions recorded against this member." : "No moderation actions recorded yet.",
    );
  }

  return table(
    ["Action", "Member", "By", "Reason", "Duration", "When"],
    data.actions.map((row) => [
      h("div", { class: "job-cell" }, row.type, stateBadge(row)),
      h("code", {}, row.targetDiscordId ?? "—"),
      h("code", {}, row.actorDiscordId),
      row.reason,
      describeDuration(row),
      relativeTime(row.createdAt),
    ]),
  );
}

// ─────────────────────────── 2. automod ───────────────────────────

type AutomodPolicy = ModerationVM["automod"];
type AutomodRule = AutomodPolicy["rules"][number];

/**
 * A rule being edited, before it is a rule.
 *
 * Deliberately loose where `AutomodRule` is a discriminated union: switching a
 * trigger from `caps` to `spam` passes through a state that is neither, and
 * modelling the half-switched shape as the real type would mean either lying
 * about it or rebuilding the whole draft on every dropdown change.
 */
interface Draft {
  id: string;
  name: string;
  enabled: boolean;
  surfaces: string[];
  trigger: Record<string, unknown> & { kind: string };
  exempt: { roleIds: string[]; capability: string | null };
  action: { type: string; deleteMessage: boolean; durationSeconds: number | null };
}

function automodSection(
  guildId: string,
  data: ModerationVM,
  rerender: () => void,
): readonly (HTMLElement | null)[] {
  const policy = data.automod;
  const status = statusSlot();

  const master = h(
    "div",
    {},
    h(
      "p",
      { class: "field-hint" },
      "Automod acts on a message with nobody in the loop, on Discord and in guild chat alike. A rule that fires " +
        "hands the action to the same pipeline as /warn — so the escalation ladder, the audit trail and the " +
        "in-game punishment sync all apply to it.",
    ),
    fieldGroup(
      toggleField({
        label: "Automod on",
        hint: "Off stops every rule at once and keeps them all. Use this first when something is misfiring.",
        checked: policy.enabled,
        save: (enabled) => postAction(guildId, "automod.enable", { enabled }),
      }),
    ),
    status.el,
  );

  const add = actionButton({
    label: "New rule",
    tone: "primary",
    status,
    run: async () => {
      state.editing = "new";
      rerender();
      return { kind: "ok" };
    },
  });

  return [
    card("Automod", master),
    card("Test a message", testBox(guildId, policy)),
    card(
      policy.rules.length === 0 ? "Rules" : `Rules (${count(policy.rules.length)})`,
      policy.rules.length === 0 && state.editing !== "new"
        ? emptyState("No automod rules yet. Start one on “record it” and watch what it catches before it acts.")
        : h(
            "div",
            {},
            ...(state.editing === "new" ? [draftCard(guildId, rerender)] : []),
            ...policy.rules.map((rule) => ruleRow(guildId, rule, rerender)),
          ),
      add,
    ),
  ];
}

/**
 * One rule, collapsed to a line until you open it.
 *
 * The line says what it catches and what it does, because that is the pair a
 * staffer scanning the list is checking. Everything else is behind the row.
 */
function ruleRow(guildId: string, rule: AutomodRule, rerender: () => void): HTMLElement {
  const open = state.editing === rule.id;
  const status = statusSlot();

  const head = h(
    "div",
    { class: "field-row" },
    h(
      "span",
      { class: "job-cell" },
      rule.name,
      badge(triggerLabel(rule.trigger.kind), "neutral"),
      badge(describeAction(rule.action), rule.action.type === "FLAG" ? "neutral" : "warn"),
      ...rule.surfaces.map((s) => badge(s === "DISCORD" ? "discord" : "guild chat", "neutral")),
      rule.enabled ? badge("live", "ok") : badge("off", "neutral"),
    ),
    h("button", {
      class: "button",
      type: "button",
      "aria-expanded": open ? "true" : "false",
      onclick: () => {
        state.editing = open ? null : rule.id;
        rerender();
      },
    }, open ? "Close" : "Edit"),
    actionButton({
      label: "Remove",
      tone: "danger",
      confirm: "Confirm remove",
      status,
      run: () => postAction(guildId, "automod.rule.remove", { id: rule.id }),
      onDone: () => {
        if (state.editing === rule.id) state.editing = null;
        rerender();
      },
    }),
  );

  return h(
    "div",
    { class: "field" },
    head,
    status.el,
    open ? ruleEditor(guildId, toDraft(rule), false) : null,
  );
}

/** The unsaved rule. Nothing is written until the button at the bottom. */
function draftCard(guildId: string, rerender: () => void): HTMLElement {
  const draft = newDraft();
  const status = statusSlot();

  const create = actionButton({
    label: "Add rule",
    tone: "primary",
    status,
    run: () => {
      const invalid = validateDraft(draft);
      if (invalid !== null) return Promise.resolve<WriteResult>({ kind: "error", message: invalid });
      return postAction(guildId, "automod.rule.upsert", ruleBody(draft));
    },
    onDone: () => {
      state.editing = draft.id;
      rerender();
    },
  });

  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, "Nothing here is stored until you press Add rule."),
    ruleEditor(guildId, draft, true),
    h("div", { class: "field-row" }, create),
    status.el,
    h("div", { class: "field-row" }, h("button", {
      class: "button",
      type: "button",
      onclick: () => {
        state.editing = null;
        rerender();
      },
    }, "Cancel")),
  );
}

/**
 * The editor, shared by a stored rule and a draft.
 *
 * A stored rule writes the *whole* rule on every field change, as on the Filter
 * section and for the same reason: the mutation validates the result, and
 * changing only the trigger kind can turn a legal rule into one the server
 * refuses in a way the changed field alone cannot show. A draft writes nothing
 * — `create` is non-null for it, and every field's save simply records the
 * choice and reports success.
 */
function ruleEditor(guildId: string, draft: Draft, drafting: boolean): HTMLElement {

  const save = (): Promise<WriteResult> => {
    if (drafting) return Promise.resolve<WriteResult>({ kind: "ok" });
    const invalid = validateDraft(draft);
    if (invalid !== null) return Promise.resolve<WriteResult>({ kind: "error", message: invalid });
    return postAction(guildId, "automod.rule.upsert", ruleBody(draft));
  };

  // Rebuilt in place on a kind change rather than through a page re-read: the
  // fields for `spam` and `caps` have nothing in common, and a re-read would
  // close the row the operator is working in.
  const params = h("div", { class: "fields" });
  const drawParams = (): void => {
    params.replaceChildren(...triggerFields(draft, save));
  };
  drawParams();

  const duration = h("div", { class: "fields" });
  const drawDuration = (): void => {
    duration.replaceChildren(
      ...(draft.action.type === "MUTE"
        ? [
            textField({
              label: "Mute for",
              hint: `Seconds, up to ${count(MUTE_MAX)} (a day). Blank leaves it open-ended.`,
              value: draft.action.durationSeconds === null ? "" : String(draft.action.durationSeconds),
              validate: (raw) =>
                raw.trim() === "" || whole(raw, 1, MUTE_MAX) ? null : `Enter 1–${MUTE_MAX} seconds, or leave it blank.`,
              save: (raw) => {
                draft.action.durationSeconds = raw.trim() === "" ? null : Number(raw.trim());
                return save();
              },
            }),
          ]
        : []),
    );
  };
  drawDuration();

  return h(
    "div",
    { class: "fields" },
    fieldGroup(
      textField({
        label: "Name",
        hint: "What this rule is for. It appears in the audit row when the rule fires.",
        value: draft.name,
        validate: (raw) =>
          raw.trim().length === 0 || raw.length > RULE_NAME_MAX
            ? `Enter a name up to ${RULE_NAME_MAX} characters.`
            : null,
        save: (raw) => {
          draft.name = raw.trim();
          return save();
        },
      }),
      drafting
        ? null
        : toggleField({
            label: "Live",
            hint: "Off keeps the rule here and stops it firing.",
            checked: draft.enabled,
            save: (next) => {
              draft.enabled = next;
              return save();
            },
          }),
      toggleField({
        label: "On Discord",
        checked: draft.surfaces.includes("DISCORD"),
        save: (next) => {
          setSurface(draft, "DISCORD", next);
          return save();
        },
      }),
      toggleField({
        label: "In guild chat",
        hint: "A member muted on Discord who carries on in guild chat has not been moderated, only redirected.",
        checked: draft.surfaces.includes("GUILD_CHAT"),
        save: (next) => {
          setSurface(draft, "GUILD_CHAT", next);
          return save();
        },
      }),
      selectField({
        label: "Catches",
        hint: TRIGGER_HINT[draft.trigger.kind] ?? "",
        value: draft.trigger.kind,
        options: TRIGGER_OPTIONS,
        save: (next) => {
          draft.trigger = defaultTrigger(next);
          drawParams();
          return save();
        },
      }),
    ),
    params,
    fieldGroup(
      selectField({
        label: "Then",
        hint: ACTION_HINT[draft.action.type] ?? "",
        value: draft.action.type,
        options: ACTION_OPTIONS,
        save: (next) => {
          draft.action.type = next;
          // A duration only means something on a mute, and the server refuses
          // one anywhere else rather than dropping it silently.
          if (next !== "MUTE") draft.action.durationSeconds = null;
          drawDuration();
          return save();
        },
      }),
      toggleField({
        label: "Delete the message",
        hint: "Separate from the action above: “delete it and say nothing” and “warn them but leave it up” are both things staff ask for.",
        checked: draft.action.deleteMessage,
        save: (next) => {
          draft.action.deleteMessage = next;
          return save();
        },
      }),
    ),
    duration,
    fieldGroup(
      multiPickerField({
        label: "Roles that skip this rule",
        hint: "Discord only — guild chat has no roles. Leave empty and the rule applies to everyone.",
        guildId,
        kind: "role",
        values: draft.exempt.roleIds,
        placeholder: "Search roles",
        save: (ids) => {
          draft.exempt.roleIds = [...ids];
          return save();
        },
      }),
      selectField({
        label: "Capability that skips this rule",
        hint: "The guild-chat side's staff check, since there are no roles there to exempt.",
        value: draft.exempt.capability ?? "",
        options: CAPABILITY_OPTIONS,
        save: (next) => {
          draft.exempt.capability = next === "" ? null : next;
          return save();
        },
      }),
    ),
    drafting ? null : h("p", { class: "field-hint" }, "Every change here is saved as you make it."),
  );
}

/** The fields one trigger kind needs, and nothing from the other seven. */
function triggerFields(draft: Draft, save: () => Promise<WriteResult>): readonly HTMLElement[] {
  const t = draft.trigger;
  const num = (key: string, label: string, hint: string, min: number, max: number): HTMLElement =>
    textField({
      label,
      hint,
      value: String(t[key] ?? ""),
      validate: (raw) => (whole(raw, min, max) ? null : `Enter a whole number between ${min} and ${max}.`),
      save: (raw) => {
        t[key] = Number(raw.trim());
        return save();
      },
    });

  switch (t.kind) {
    case "regex":
      return [
        textField({
          label: "Pattern",
          hint: "A regular expression. Refused at save time if it doesn't compile — better than storing one that silently never matches.",
          value: String(t["pattern"] ?? ""),
          validate: (raw) =>
            raw.trim().length === 0 || raw.length > PATTERN_MAX
              ? `Enter a pattern up to ${PATTERN_MAX} characters.`
              : null,
          save: (raw) => {
            t["pattern"] = raw.trim();
            return save();
          },
        }),
        textField({
          label: "Flags",
          hint: "Regex flags, e.g. i for case-insensitive. Leave blank for none.",
          value: String(t["flags"] ?? ""),
          validate: (raw) => (/^[gimsuy]*$/.test(raw.trim()) ? null : "Flags may only be g, i, m, s, u or y."),
          save: (raw) => {
            t["flags"] = raw.trim();
            return save();
          },
        }),
      ];
    case "spam":
      return [
        num("messages", "Messages", "How many messages from one author trip it.", 2, 100),
        num("windowSeconds", "Within", `Seconds, up to ${WINDOW_MAX}.`, 1, WINDOW_MAX),
      ];
    case "repeat":
      return [
        num("times", "Repeats", "How many times the same text has to be sent.", 2, 100),
        num("windowSeconds", "Within", `Seconds, up to ${WINDOW_MAX}.`, 1, WINDOW_MAX),
      ];
    case "mentions":
      return [num("max", "Mentions allowed", "The most mentions one message may carry.", 1, 100)];
    case "caps":
      return [
        num("percent", "Upper case", "Percent of letters in caps. The floor is 50 — below half, ordinary emphatic typing trips it.", 50, 100),
        num("minLength", "Only messages at least", "Characters. Short messages are exempt so “OK” doesn't count as shouting.", 4, 500),
      ];
    case "links":
      return [
        textField({
          label: "Allowed hosts",
          hint: `Comma-separated hostnames, up to ${ALLOWLIST_MAX}. Leave empty to catch every link.`,
          value: (Array.isArray(t["allowlist"]) ? (t["allowlist"] as string[]) : []).join(", "),
          validate: (raw) =>
            splitList(raw).length > ALLOWLIST_MAX ? `At most ${ALLOWLIST_MAX} hosts.` : null,
          save: (raw) => {
            t["allowlist"] = splitList(raw);
            return save();
          },
        }),
      ];
    default:
      // wordlist and invites take no parameters — the rule is the whole setting.
      return [];
  }
}

/**
 * The test box.
 *
 * It runs the real evaluator against the real policy, which is the only version
 * of this feature worth having: an approximation that agrees with production
 * most of the time is worse than no test at all. The counters are stubs because
 * a rolling window cannot be replayed — the operator says "pretend they have
 * sent 6 already" and sees what the rule would do.
 */
function testBox(guildId: string, policy: AutomodPolicy): HTMLElement {
  const status = statusSlot();
  const text = reasonBox("Paste a message to run the rules against", 3);

  let surface = "DISCORD";
  let mentions = "0";
  const mentionInput = h("input", {
    class: "control control-text control-short",
    type: "text",
    value: "0",
    autocomplete: "off",
    "aria-label": "Mentions in the message",
  }) as HTMLInputElement;
  mentionInput.addEventListener("input", () => {
    mentions = mentionInput.value;
  });

  // One box per windowed rule, because their windows differ: two spam rules,
  // one at 5-in-10s and one at 20-in-60s, are two independent counts.
  const windowed = policy.rules.filter((r) => r.trigger.kind === "spam" || r.trigger.kind === "repeat");
  const counterInputs = new Map<string, HTMLInputElement>();
  const counterFields = windowed.map((rule) => {
    const input = h("input", {
      class: "control control-text control-short",
      type: "text",
      value: "0",
      autocomplete: "off",
      "aria-label": `Counter for ${rule.name}`,
    }) as HTMLInputElement;
    counterInputs.set(rule.id, input);
    return h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, `Already counted for “${rule.name}”`),
      h("div", { class: "field-row" }, input),
    );
  });

  const run = actionButton({
    label: "Test it",
    tone: "primary",
    status,
    run: () => {
      const body = text.value;
      if (body.trim().length === 0) {
        return Promise.resolve<WriteResult>({ kind: "error", message: "Type a message to test." });
      }
      if (!whole(mentions, 0, 100)) {
        return Promise.resolve<WriteResult>({ kind: "error", message: "Mentions must be a whole number from 0 to 100." });
      }
      const counters: Record<string, number> = {};
      for (const [id, input] of counterInputs) {
        const raw = input.value.trim() === "" ? "0" : input.value;
        if (!whole(raw, 0, 10_000)) {
          return Promise.resolve<WriteResult>({ kind: "error", message: "Counters must be whole numbers." });
        }
        counters[id] = Number(raw.trim());
      }
      return postAction(guildId, "automod.test", {
        text: body,
        surface,
        mentionCount: Number(mentions.trim() === "" ? "0" : mentions.trim()),
        counters,
      });
    },
  });

  return h(
    "div",
    { class: "fields" },
    h(
      "p",
      { class: "field-hint" },
      "Nothing is written and nobody is punished — the answer below is what would have happened. The message " +
        "itself is never recorded, which is the point: testing a slur rule should not file the slur in the audit log.",
    ),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, "Message"),
      h("div", { class: "field-row" }, text),
    ),
    selectField({
      label: "As if sent",
      value: surface,
      options: [
        ["DISCORD", "in Discord"],
        ["GUILD_CHAT", "in guild chat"],
      ],
      save: async (next) => {
        surface = next;
        return { kind: "ok" };
      },
    }),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, "Mentions in it"),
      h("div", { class: "field-row" }, mentionInput),
    ),
    ...counterFields,
    h("div", { class: "field-row" }, run),
    status.el,
  );
}

// ─────────────────────────── 4. cooldowns ───────────────────────────

/**
 * Cooldowns, written whole.
 *
 * The policy is small and every field is read together by the dispatcher, so
 * there is nothing to gain from per-field writes and one thing to lose: a
 * half-applied policy where the default landed and the overrides did not.
 */
function cooldownsBody(guildId: string, data: ModerationVM): HTMLElement {
  const policy = data.cooldowns;
  let commandDefaultSeconds = policy.commandDefaultSeconds;
  let relaySeconds = policy.relaySeconds;
  const perCommand: Record<string, number> = { ...policy.perCommand };

  const status = statusSlot();
  const save = (): Promise<WriteResult> =>
    postAction(guildId, "config.cooldowns", { commandDefaultSeconds, relaySeconds, perCommand });

  const rows = h("div", { class: "fields" });
  const drawRows = (): void => {
    const entries = Object.entries(perCommand);
    rows.replaceChildren(
      ...(entries.length === 0
        ? [h("p", { class: "field-hint" }, "No per-command overrides. Every command uses the default above.")]
        : entries.map(([command, seconds]) =>
            h(
              "div",
              { class: "field-row" },
              h("span", { class: "job-cell" }, h("code", {}, `/${command}`), describeSeconds(seconds)),
              actionButton({
                label: "Remove",
                tone: "danger",
                status,
                run: () => {
                  delete perCommand[command];
                  drawRows();
                  return save();
                },
              }),
            ),
          )),
    );
  };
  drawRows();

  const nameInput = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: "command name, e.g. networth",
    autocomplete: "off",
    "aria-label": "Command name",
  }) as HTMLInputElement;
  const secondsInput = h("input", {
    class: "control control-text control-short",
    type: "text",
    placeholder: "seconds",
    autocomplete: "off",
    "aria-label": "Seconds",
  }) as HTMLInputElement;

  const add = actionButton({
    label: "Add override",
    tone: "primary",
    status,
    run: () => {
      const command = nameInput.value.trim().replace(/^\//, "").toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(command)) {
        return Promise.resolve<WriteResult>({ kind: "error", message: "That is not a command name." });
      }
      if (!whole(secondsInput.value, 0, COOLDOWN_MAX)) {
        return Promise.resolve<WriteResult>({
          kind: "error",
          message: `Enter a whole number of seconds between 0 and ${COOLDOWN_MAX}.`,
        });
      }
      perCommand[command] = Number(secondsInput.value.trim());
      drawRows();
      return save();
    },
    onDone: () => {
      nameInput.value = "";
      secondsInput.value = "";
    },
  });

  return h(
    "div",
    {},
    h(
      "p",
      { class: "field-hint" },
      "Every command ships with a cooldown its author chose. These override that: a guild-wide default, plus the " +
        "handful of commands you actually care about.",
    ),
    fieldGroup(
      textField({
        label: "Default command cooldown",
        hint: `Seconds, 0–${COOLDOWN_MAX}. Blank leaves each command on the number it shipped with, which is not the same as 0.`,
        value: commandDefaultSeconds === null ? "" : String(commandDefaultSeconds),
        validate: (raw) =>
          raw.trim() === "" || whole(raw, 0, COOLDOWN_MAX)
            ? null
            : `Enter 0–${COOLDOWN_MAX} seconds, or leave it blank.`,
        save: (raw) => {
          commandDefaultSeconds = raw.trim() === "" ? null : Number(raw.trim());
          return save();
        },
        clear: () => {
          commandDefaultSeconds = null;
          return save();
        },
      }),
      textField({
        label: "Between relayed messages",
        hint:
          `Seconds one member waits between messages the bridge relays, 0–${COOLDOWN_MAX}. 0 disables it. This sits ` +
          "on top of flood control, which protects the bridge account from Hypixel's own limit and is deliberately not settable here.",
        value: String(relaySeconds),
        validate: (raw) => (whole(raw, 0, COOLDOWN_MAX) ? null : `Enter 0–${COOLDOWN_MAX} seconds.`),
        save: (raw) => {
          relaySeconds = Number(raw.trim());
          return save();
        },
      }),
    ),
    h("h4", { class: "field-label" }, "Per-command overrides"),
    rows,
    h("div", { class: "field-row" }, nameInput, secondsInput, add),
    status.el,
  );
}

// ─────────────────────────── shared helpers ───────────────────────────

function newDraft(): Draft {
  return {
    id: freshId(),
    name: "",
    enabled: true,
    surfaces: ["DISCORD", "GUILD_CHAT"],
    trigger: defaultTrigger("wordlist"),
    exempt: { roleIds: [], capability: null },
    // FLAG with no deletion is the honest starting point for a new rule: it
    // records what the rule would catch without acting on anybody while the
    // operator is still finding out whether it catches the right things.
    action: { type: "FLAG", deleteMessage: false, durationSeconds: null },
  };
}

/** Ids only have to be unique within one guild's policy and URL-safe. */
function freshId(): string {
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `r-${Date.now().toString(36)}-${rand}`;
}

function toDraft(rule: AutomodRule): Draft {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    surfaces: [...rule.surfaces],
    trigger: { ...rule.trigger },
    exempt: { roleIds: [...rule.exempt.roleIds], capability: rule.exempt.capability },
    action: { ...rule.action },
  };
}

function ruleBody(draft: Draft): Record<string, unknown> {
  return {
    id: draft.id,
    name: draft.name,
    enabled: draft.enabled,
    surfaces: draft.surfaces,
    trigger: draft.trigger,
    exempt: { roleIds: draft.exempt.roleIds, capability: draft.exempt.capability },
    action: draft.action,
  };
}

/**
 * The checks worth catching before the round trip. Not the authority — the
 * mutation re-validates everything, including the things only it can know, like
 * whether a regex compiles.
 */
function validateDraft(draft: Draft): string | null {
  if (draft.name.trim().length === 0) return "Give the rule a name.";
  if (draft.surfaces.length === 0) return "Pick at least one surface.";
  if (draft.trigger.kind === "regex" && String(draft.trigger["pattern"] ?? "").trim().length === 0) {
    return "A pattern rule needs a pattern.";
  }
  if (draft.action.type === "FLAG" && !draft.action.deleteMessage && draft.trigger.kind === "wordlist") {
    return "A flag-only wordlist rule duplicates the chat filter — give it an action or delete the message.";
  }
  return null;
}

function setSurface(draft: Draft, surface: string, on: boolean): void {
  const at = draft.surfaces.indexOf(surface);
  if (on && at < 0) draft.surfaces.push(surface);
  if (!on && at >= 0) draft.surfaces.splice(at, 1);
}

function defaultTrigger(kind: string): Record<string, unknown> & { kind: string } {
  switch (kind) {
    case "regex":
      return { kind, pattern: "", flags: "i" };
    case "spam":
      return { kind, messages: 5, windowSeconds: 10 };
    case "repeat":
      return { kind, times: 3, windowSeconds: 60 };
    case "mentions":
      return { kind, max: 5 };
    case "caps":
      return { kind, percent: 70, minLength: 10 };
    case "links":
      return { kind, allowlist: [] };
    default:
      return { kind };
  }
}

function triggerLabel(kind: string): string {
  return TRIGGER_OPTIONS.find(([value]) => value === kind)?.[1] ?? kind;
}

function describeAction(action: AutomodRule["action"]): string {
  const base =
    action.type === "MUTE"
      ? action.durationSeconds === null
        ? "mute"
        : `mute ${describeSpan(action.durationSeconds * 1000)}`
      : action.type.toLowerCase();
  return action.deleteMessage ? `${base} + delete` : base;
}

function describeSeconds(seconds: number): string {
  return seconds === 0 ? "no cooldown" : describeSpan(seconds * 1000);
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function whole(raw: string, min: number, max: number): boolean {
  const value = Number(raw.trim());
  return raw.trim().length > 0 && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The `active` flag alone cannot say this, which is why the state is resolved
 * server-side: a swept mute and a hand-lifted one are both `active: false`, and
 * a kick is `active` forever because nothing lifts one. Labelling every cleared
 * flag "lifted" would credit a staffer with an unmute the clock performed.
 */
function stateBadge(row: ModerationActionVM): HTMLElement | null {
  switch (row.state) {
    case "ACTIVE":
      return badge("in force", "warn");
    case "EXPIRED":
      return badge("expired", "neutral");
    case "LIFTED":
      return badge("lifted", "ok");
    default:
      // MOMENTARY — a warn or a kick had no duration to run out.
      return null;
  }
}

function describeDuration(row: ModerationActionVM): string {
  if (row.durationSeconds === null) return TIMED.has(row.type) ? "permanent" : "—";
  const span = describeSpan(row.durationSeconds * 1000);
  if (row.expiresAt === null) return span;
  const remaining = Date.parse(row.expiresAt) - Date.now();
  return remaining > 0 ? `${span} (${describeSpan(remaining)} left)` : span;
}

function severityTone(severity: string): BadgeTone {
  switch (severity) {
    case "LOW":
      return "neutral";
    case "MEDIUM":
      return "warn";
    case "HIGH":
    case "CRITICAL":
      return "bad";
    default:
      return "neutral";
  }
}
