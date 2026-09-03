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
import type { ModerationActionVM, ModerationVM, RelayVM } from "@sbr/panel-core";
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
import { scope } from "../copy.js";
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
  validateWhole,
} from "../forms.js";
import { count, describeSpan, parseDurationSeconds, relativeTime } from "../format.js";
import { BridgeCapability } from "./enums.js";
import { filterCards } from "./wordlist.js";

const t = scope("moderation");
const c = scope("common");

/** A copy table read by a value the platform owns, falling back to the value. */
const lookup = (table: unknown, key: string, fallback: string): string =>
  (table as Readonly<Record<string, string>>)[key] ?? fallback;

/**
 * The actions the panel is allowed to issue — mirrors `PANEL_ACTIONS`.
 *
 * Which actions exist and in what order is structure; what each is called and
 * what it does to a member is copy, so an action the platform gains before copy
 * names it is still offered, under its own key.
 */
const ACTIONS: readonly string[] = ["NOTE", "WARN", "MUTE", "UNMUTE", "KICK", "BAN", "UNBAN"];

const actionName = (value: string): string => lookup(t("actionName"), value, value);
const actionHint = (value: string): string => lookup(t("actionHint"), value, "");

/** Only these two carry a duration; the rest are instantaneous. */
const TIMED = new Set(["MUTE", "BAN"]);

type Section = "history" | "automod" | "antiraid" | "filter" | "cooldowns";

const SECTIONS: readonly Section[] = ["history", "automod", "antiraid", "filter", "cooldowns"];

const sectionLabel = (id: Section): string => {
  switch (id) {
    case "automod":
      return t("tabAutomod");
    case "antiraid":
      return t("tabAntiRaid");
    case "filter":
      return t("tabFilter");
    case "cooldowns":
      return t("tabCooldowns");
    default:
      return t("tabHistory");
  }
};

/**
 * Survives a tab switch so coming back to the page keeps your place — including
 * which rule you had open, because saving a rule re-reads the page and landing
 * back on a collapsed list would lose the edit you were halfway through.
 */
const state: {
  target: string;
  search: string;
  section: Section;
  editing: string | null;
  managing: string | null;
} = {
  target: "",
  // A case id, a uuid, or a name that resolved to no member — anything staff
  // arrive holding that is not a Discord id. It narrows the case log rather
  // than choosing whose history is shown, so the two live side by side.
  search: "",
  section: "history",
  editing: null,
  // The case whose management controls are open, if any. One at a time: these
  // controls change a punishment somebody is currently serving, and a page of
  // them all unfolded at once makes it far too easy to correct the wrong row.
  managing: null,
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

/** The trigger kinds `evaluateAutomod` understands, in the order they are offered. */
const TRIGGER_KINDS: readonly string[] = [
  "wordlist",
  "regex",
  "spam",
  "repeat",
  "mentions",
  "caps",
  "links",
  "invites",
];

const triggerLabel = (kind: string): string => lookup(t("trigger"), kind, kind);
const triggerHint = (kind: string): string => lookup(t("triggerHint"), kind, "");

const triggerOptions = (): readonly (readonly [string, string])[] =>
  TRIGGER_KINDS.map((kind) => [kind, triggerLabel(kind)] as const);

/** What a fired rule does. FLAG first: it is the honest place to start a rule. */
const AUTOMOD_ACTIONS: readonly string[] = ["FLAG", "WARN", "MUTE"];

const automodActionOptions = (): readonly (readonly [string, string])[] =>
  AUTOMOD_ACTIONS.map((v) => [v, lookup(t("automodAction"), v, v.toLowerCase())] as const);

const capabilityOptions = (): readonly (readonly [string, string])[] => [
  ["", t("exemptNobody")] as const,
  ...Object.keys(BridgeCapability).map((v) => [v, v.toLowerCase().replace(/_/g, " ")] as const),
];

export async function renderModeration(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("moderation"));

  const params = new URLSearchParams();
  if (state.target) params.set("target", state.target);
  if (state.search) params.set("search", state.search);
  const query = params.size > 0 ? `?${params.toString()}` : "";
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
      pageTitle(t("title"), subtitle(data)),
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
        ? t("subtitleAutomod")
            .replace("{live}", count(live))
            .replace("{total}", count(data.automod.rules.length))
        : t("subtitleAutomodOff");
    }
    case "antiraid":
      return t("subtitleAntiRaid");
    case "filter":
      return t("subtitleFilter");
    case "cooldowns":
      return t("subtitleCooldowns");
    default:
      return data.target
        ? t("subtitleMember").replace("{count}", count(data.infractionCount))
        : t("subtitleGuild");
  }
}

function sectionTabs(sections: readonly Section[], rerender: () => void): HTMLElement {
  return h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": t("tabsAria") },
    ...sections.map((id) => {
      const button = h("button", {
        type: "button",
        class: "tab",
        role: "tab",
        "aria-selected": id === state.section ? "true" : "false",
      }, sectionLabel(id));
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
    case "antiraid":
      return antiRaidSection(guildId, data);
    case "filter":
      return filterCards(guildId, data.filter, rerender);
    case "cooldowns":
      return [card(t("cardCooldowns"), cooldownsBody(guildId, data))];
    default:
      return historySection(guildId, data, rerender);
  }
}

// ─────────────────────────── 1. history ───────────────────────────

function historySection(guildId: string, data: ModerationVM, rerender: () => void): readonly (HTMLElement | null)[] {
  return [
    card(t("cardLookup"), lookupBody(guildId, rerender)),
    card(t("cardIssue"), actionForm(guildId, rerender)),
    data.target ? card(t("cardInfractions"), infractionsBody(data.infractions, true)) : null,
    card(t("cardInForce"), inForceBody(data)),
    // Above the case log rather than below it: "did the last command work" is
    // the question somebody arrives with when something is wrong, and it was
    // previously answerable only by reading a process log.
    card(t("cardRelay"), relayBody(data.relay)),
    card(data.target ? t("cardActionsMember") : t("cardActionsRecent"), actionsBody(guildId, data, rerender)),
    // Only worth showing when no target is picked: with one, the card above it
    // is the same list narrowed to the person actually being asked about.
    data.target ? null : card(t("cardRecentInfractions"), infractionsBody(data.recentInfractions, false)),
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
  const note = h(
    "p",
    { class: "field-hint" },
    state.search ? t("lookupSearching").replace("{term}", state.search) : "",
  );

  function look(): void {
    const raw = chooser.value().trim();
    // A term that is not a Discord id used to be a dead end. It is now a search
    // over the case log, because the three things staff paste into this box —
    // a case id, a uuid, a username — are all of them things a member picker
    // cannot resolve and the log can.
    if (raw.length > 0 && !isSnowflake(raw)) {
      state.target = "";
      state.search = raw;
      state.managing = null;
      rerender();
      return;
    }
    state.target = raw;
    state.search = "";
    state.managing = null;
    rerender();
  }

  // Picking a member is the whole intent here, so a selection searches straight
  // away rather than waiting for the button — which stays for the paste path.
  const chooser = idChooser({
    guildId,
    kind: "member",
    value: state.target,
    placeholder: t("lookupPlaceholder"),
    ariaLabel: t("lookupAria"),
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
        h("button", { class: "button button-primary", type: "button", onclick: look }, t("lookupGo")),
        state.target || state.search
          ? h("button", {
              class: "button",
              type: "button",
              onclick: () => {
                state.target = "";
                state.search = "";
                rerender();
              },
            }, t("lookupClear"))
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

  const type = h("select", { class: "control control-select", "aria-label": t("fieldAction") },
    ...ACTIONS.map((value) => h("option", { value }, actionName(value))),
  ) as HTMLSelectElement;

  const target = idChooser({
    guildId,
    kind: "member",
    value: state.target,
    placeholder: t("targetPlaceholder"),
    ariaLabel: t("targetAria"),
  });

  const duration = h("input", {
    class: "control control-text control-short",
    type: "text",
    placeholder: t("durationPlaceholder"),
    autocomplete: "off",
    "aria-label": t("fieldDuration"),
  }) as HTMLInputElement;

  const durationRow = h(
    "div",
    { class: "field" },
    h("label", { class: "field-label" }, t("fieldDuration")),
    h("div", { class: "field-row" }, duration),
    h("p", { class: "field-hint" }, t("durationHint")),
  );

  const reason = reasonBox(t("reasonPlaceholder"), 3);
  const explain = h("p", { class: "field-hint" }, actionHint(ACTIONS[0]!));

  function syncType(): void {
    explain.textContent = actionHint(type.value);
    // Hidden rather than disabled: an untimed action has no duration at all, and
    // a greyed-out box invites the reader to wonder what would unlock it.
    durationRow.hidden = !TIMED.has(type.value);
  }
  type.addEventListener("change", syncType);
  syncType();

  const submit = actionButton({
    label: t("apply"),
    tone: "primary",
    status,
    run: async () => {
      const targetId = target.value();
      if (!isSnowflake(targetId)) {
        return { kind: "error", message: t("errNoTarget") };
      }
      const note = reason.value.trim();
      if (note.length === 0) {
        return { kind: "error", message: t("errNoReason") };
      }

      let durationSeconds: number | null = null;
      if (TIMED.has(type.value)) {
        const parsed = parseDurationSeconds(duration.value);
        if (parsed === "invalid") {
          return { kind: "error", message: t("errDuration") };
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
      h("label", { class: "field-label" }, t("fieldAction")),
      h("div", { class: "field-row" }, type),
      explain,
    ),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, t("fieldMember")),
      h("div", { class: "field-row" }, target.el),
    ),
    durationRow,
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, t("fieldReason")),
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
    return emptyState(targeted ? "moderationInfractionsMember" : "moderationInfractionsGuild");
  }
  const headers = targeted
    ? [t("colType"), t("colSeverity"), t("colReason"), t("colWhen")]
    : [t("colMember"), t("colType"), t("colSeverity"), t("colReason"), t("colWhen")];
  return table(
    headers,
    rows.map((row) => {
      const cells: (string | HTMLElement)[] = [
        row.type,
        badge(row.severity, severityTone(row.severity)),
        row.reason,
        relativeTime(row.createdAt),
      ];
      return targeted ? cells : [h("code", {}, row.targetDiscordId ?? c("dash")), ...cells];
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
    return emptyState(data.target ? "moderationInForceMember" : "moderationInForceGuild");
  }
  return table(
    [
      t("colCase"),
      t("colAction"),
      t("colMember"),
      t("colBy"),
      t("colReason"),
      t("colEnds"),
      { label: t("colSince"), align: "when" },
    ],
    data.inForce.map((row) => [
      h("div", { class: "job-cell" }, row.type, badge(t("badgeInForce"), "warn")),
      h("code", {}, row.targetDiscordId ?? c("dash")),
      h("code", {}, row.actorDiscordId),
      row.reason,
      row.expiresAt === null ? c("never") : relativeTime(row.expiresAt),
      relativeTime(row.createdAt),
    ]),
  );
}

/**
 * The relay strip.
 *
 * Three separate truths, each rendered as itself: whether a bridge is in game,
 * what its outbound queue is doing, and what became of the last few commands.
 * Any of them can be unreadable, and an unreadable one says so rather than
 * rendering as a zero — the whole reason this exists is that silence used to be
 * indistinguishable from success.
 */
function relayBody(relay: RelayVM): HTMLElement {
  const tone: BadgeTone = relay.bridgeLive === null ? "neutral" : relay.bridgeLive ? "ok" : "bad";
  const label =
    relay.bridgeLive === null ? t("relayUnknown") : relay.bridgeLive ? t("relayLive") : t("relayDown");

  const counts: (HTMLElement | string)[] = [badge(label, tone)];
  if (relay.lastSeenAt !== null) {
    counts.push(t("relaySeen").replace("{when}", relativeTime(relay.lastSeenAt)));
  }
  if (relay.queued !== null) counts.push(t("relayQueued").replace("{count}", count(relay.queued)));
  if (relay.sent !== null) {
    counts.push(
      t("relayCounts")
        .replace("{sent}", count(relay.sent))
        .replace("{dropped}", count(relay.dropped ?? 0))
        .replace("{expired}", count(relay.expired ?? 0))
        .replace("{evicted}", count(relay.evicted ?? 0)),
    );
  }

  const head = h("div", { class: "job-cell" }, ...counts);
  const intro = h("p", { class: "hint" }, t("relayIntro"));

  if (relay.commands === null) {
    return h("div", {}, intro, head, h("p", { class: "hint" }, t("relayNoLog")));
  }
  if (relay.commands.length === 0) {
    return h("div", {}, intro, head, emptyState("moderationRelay"));
  }
  return h("div", {}, intro, head, table(
    [t("colCommand"), t("colOutcome"), t("colDetail"), { label: t("colWhen"), align: "when" }],
    relay.commands.map((row) => [
      h("code", {}, row.command),
      badge(lookup(t("relayOutcome"), row.outcome, row.outcome), relayTone(row.outcome)),
      row.detail,
      relativeTime(row.at),
    ]),
  ));
}

/** Confirmed is good, typed is not yet anything, everything else is a failure. */
function relayTone(outcome: string): BadgeTone {
  switch (outcome) {
    case "CONFIRMED_INGAME":
      return "ok";
    case "TYPED":
      return "neutral";
    default:
      return "bad";
  }
}

function actionsBody(guildId: string, data: ModerationVM, rerender: () => void): HTMLElement {
  if (data.actions.length === 0) {
    return emptyState(data.target ? "moderationActionsMember" : "moderationActionsGuild");
  }

  const managed = data.actions.find((row) => row.id === state.managing) ?? null;

  const rows = table(
    [
      t("colAction"),
      t("colMember"),
      t("colBy"),
      t("colReason"),
      t("colDuration"),
      { label: t("colWhen"), align: "when" },
      t("colManage"),
    ],
    data.actions.map((row) => [
      // First column, because it is the handle for everything else: the id
      // staff quote in an appeal, paste into this page's own search box, and
      // read off a mod-log card.
      h("code", {}, row.caseCode),
      // Two badges, because they answer different questions: what the case is
      // now, and whether it ever actually happened. A row that says BAN and
      // nothing else is the shape this whole page exists to stop.
      h("div", { class: "job-cell" }, row.type, stateBadge(row), enforcementBadge(row)),
      h("code", {}, row.targetDiscordId ?? c("dash")),
      h("code", {}, row.actorDiscordId),
      row.reason,
      describeDuration(row),
      relativeTime(row.createdAt),
      manageButton(row, rerender),
    ]),
  );

  return h("div", {}, rows, managed === null ? null : caseCard(guildId, managed, rerender));
}

/** Opens the controls for one case, and closes whichever was open before. */
function manageButton(row: ModerationActionVM, rerender: () => void): HTMLElement {
  const open = state.managing === row.id;
  const button = h("button", { class: "button", type: "button" }, open ? t("manageClose") : t("manage"));
  button.addEventListener("click", () => {
    state.managing = open ? null : row.id;
    rerender();
  });
  return button;
}

/** Nothing to enforce prints nothing: a note carries no badge worth the space. */
function enforcementBadge(row: ModerationActionVM): HTMLElement | null {
  const label = lookup(t("enforcementName"), row.enforcement, row.enforcement);
  switch (row.enforcement) {
    case "NOT_REQUIRED":
      return null;
    case "CONFIRMED":
      return badge(label, "ok");
    case "FAILED":
      return badge(label, "bad");
    default:
      return badge(label, "warn");
  }
}

/** The statuses a person may declare by hand; the sweep owns PENDING. */
const MANUAL_ENFORCEMENT: readonly string[] = ["CONFIRMED", "FAILED", "NOT_REQUIRED"];

function enforcementOptions(current: string): readonly (readonly [string, string])[] {
  const settable = MANUAL_ENFORCEMENT.map(
    (value) => [value, lookup(t("enforcementName"), value, value)] as const,
  );
  // A row sitting in PENDING still has to show what it is sitting in, even
  // though picking it back is not on offer.
  return MANUAL_ENFORCEMENT.includes(current)
    ? settable
    : [["", t("caseEnforcementPending")] as const, ...settable];
}

/** `30m`, `2h`, `7d` -- written the way the duration box parses it back. */
function compactSpan(seconds: number): string {
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60]] as const) {
    if (seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

/**
 * Correcting one case.
 *
 * Every control writes only its own field, the wordlist card's idiom, because
 * the fields here are independent in a way a rule's are not: fixing the wording
 * of a reason should not resend a duration, and re-declaring enforcement should
 * not quietly reassert a reason somebody else edited in the meantime.
 *
 * `expiresAt` is deliberately not offered. The server derives it from the
 * duration and the time the case was issued; two controls that could disagree
 * about when a mute ends would reintroduce exactly the divergence between the
 * log and reality that this page exists to close.
 */
function caseCard(guildId: string, row: ModerationActionVM, rerender: () => void): HTMLElement {
  const title = t("caseTitle").replace("{id}", row.caseCode);
  const trail: (HTMLElement | null)[] = [
    h("p", { class: "hint" }, t("caseIntro")),
    row.editedByDiscordId === null || row.updatedAt === null
      ? null
      : h(
          "p",
          { class: "field-hint" },
          t("caseEditedBy")
            .replace("{who}", row.editedByDiscordId)
            .replace("{when}", relativeTime(row.updatedAt)),
        ),
  ];

  // A void is terminal. Offering edit boxes on a withdrawn case would invite a
  // correction the server will refuse, so the card says what happened instead.
  if (row.voidedAt !== null) {
    return card(
      title,
      h(
        "div",
        {},
        ...trail,
        h("p", { class: "field-hint" }, t("caseVoidedNote")),
        row.voidReason === null
          ? null
          : h("p", { class: "field-hint" }, t("caseVoidedReason").replace("{reason}", row.voidReason)),
      ),
      badge(t("badgeVoid"), "neutral"),
    );
  }

  const status = statusSlot();

  const note = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: t("caseNotePlaceholder"),
    autocomplete: "off",
    "aria-label": t("caseNoteLabel"),
  }) as HTMLInputElement;

  const why = reasonBox(t("caseVoidPlaceholder"), 2);

  const retry = actionButton({
    label: t("caseRetry"),
    status,
    run: () => postAction(guildId, "moderation.case.retry", { actionId: row.id }),
    onDone: rerender,
  });

  const scrap = actionButton({
    label: t("caseVoid"),
    tone: "danger",
    confirm: t("caseVoidConfirm"),
    status,
    run: async () => {
      const reason = why.value.trim();
      if (reason.length === 0) return { kind: "error", message: t("errCaseVoidReason") };
      return postAction(guildId, "moderation.case.void", { actionId: row.id, reason });
    },
    onDone: () => {
      // The row it belonged to is about to render as voided; leaving the panel
      // open on it would show controls that no longer apply to it.
      state.managing = null;
      rerender();
    },
  });

  return card(
    title,
    h(
      "div",
      {},
      ...trail,
      fieldGroup(
        textField({
          label: t("caseReasonLabel"),
          hint: t("caseReasonHint"),
          value: row.reason ?? "",
          validate: (raw) => (raw.trim().length === 0 ? t("errNoReason") : null),
          save: (raw) => postAction(guildId, "moderation.case.update", { actionId: row.id, reason: raw.trim() }),
        }),
        // Only where there is a clock to move: an untimed action has no
        // duration to correct, and a blank box on a kick reads as a missing one.
        TIMED.has(row.type)
          ? textField({
              label: t("caseDurationLabel"),
              hint: t("caseDurationHint"),
              value: row.durationSeconds === null ? "" : compactSpan(row.durationSeconds),
              validate: (raw) => (parseDurationSeconds(raw) === "invalid" ? t("errDuration") : null),
              save: async (raw) => {
                const parsed = parseDurationSeconds(raw);
                if (parsed === "invalid") return { kind: "error", message: t("errDuration") };
                return postAction(guildId, "moderation.case.update", {
                  actionId: row.id,
                  durationSeconds: parsed,
                });
              },
            })
          : null,
        selectField({
          label: t("caseEnforcementLabel"),
          hint: t("caseEnforcementHint"),
          value: MANUAL_ENFORCEMENT.includes(row.enforcement) ? row.enforcement : "",
          options: enforcementOptions(row.enforcement),
          save: async (next) => {
            if (next === "") return { kind: "error", message: t("errCaseEnforcement") };
            return postAction(guildId, "moderation.case.enforcement", {
              actionId: row.id,
              enforcement: next,
              note: note.value.trim(),
            });
          },
        }),
        h(
          "div",
          { class: "field" },
          h("label", { class: "field-label" }, t("caseNoteLabel")),
          h("div", { class: "field-row" }, note),
          h("p", { class: "field-hint" }, t("caseNoteHint")),
        ),
      ),
      h("p", { class: "field-hint" }, t("caseRetryHint")),
      h("div", { class: "field-row" }, retry),
      h("p", { class: "field-hint" }, t("caseVoidHint")),
      h("div", { class: "field-row" }, why),
      h("div", { class: "field-row" }, scrap, status.el),
    ),
    stateBadge(row),
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
      t("automodIntro"),
    ),
    fieldGroup(
      toggleField({
        label: t("automodLabel"),
        hint: t("automodHint"),
        checked: policy.enabled,
        save: (enabled) => postAction(guildId, "automod.enable", { enabled }),
      }),
    ),
    status.el,
  );

  const add = actionButton({
    label: t("newRule"),
    tone: "primary",
    status,
    run: async () => {
      state.editing = "new";
      rerender();
      return { kind: "ok" };
    },
  });

  return [
    card(t("cardAutomod"), master),
    card(t("cardTest"), testBox(guildId, policy)),
    card(
      policy.rules.length === 0
        ? t("cardRules")
        : t("cardRulesCount").replace("{count}", count(policy.rules.length)),
      policy.rules.length === 0 && state.editing !== "new"
        ? emptyState("moderationAutomod")
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
      ...rule.surfaces.map((s) =>
        badge(s === "DISCORD" ? t("surfaceDiscord") : t("surfaceGuildChat"), "neutral"),
      ),
      rule.enabled ? badge(t("ruleLive"), "ok") : badge(t("ruleOff"), "neutral"),
    ),
    h("button", {
      class: "button",
      type: "button",
      "aria-expanded": open ? "true" : "false",
      onclick: () => {
        state.editing = open ? null : rule.id;
        rerender();
      },
    }, open ? t("ruleClose") : t("ruleEdit")),
    actionButton({
      label: t("remove"),
      tone: "danger",
      confirm: t("removeConfirm"),
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
    label: t("addRule"),
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
    h("p", { class: "field-hint" }, t("draftNote")),
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
    }, t("cancel"))),
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
              label: t("muteForLabel"),
              hint: t("muteForHint").replace("{max}", count(MUTE_MAX)),
              value: draft.action.durationSeconds === null ? "" : String(draft.action.durationSeconds),
              validate: (raw) =>
                raw.trim() === "" || whole(raw, 1, MUTE_MAX)
                  ? null
                  : t("errMuteFor").replace("{max}", String(MUTE_MAX)),
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
        label: t("nameLabel"),
        hint: t("nameHint"),
        value: draft.name,
        validate: (raw) =>
          raw.trim().length === 0 || raw.length > RULE_NAME_MAX
            ? t("errName").replace("{max}", String(RULE_NAME_MAX))
            : null,
        save: (raw) => {
          draft.name = raw.trim();
          return save();
        },
      }),
      drafting
        ? null
        : toggleField({
            label: t("liveLabel"),
            hint: t("liveHint"),
            checked: draft.enabled,
            save: (next) => {
              draft.enabled = next;
              return save();
            },
          }),
      toggleField({
        label: t("discordLabel"),
        checked: draft.surfaces.includes("DISCORD"),
        save: (next) => {
          setSurface(draft, "DISCORD", next);
          return save();
        },
      }),
      toggleField({
        label: t("guildChatLabel"),
        hint: t("guildChatHint"),
        checked: draft.surfaces.includes("GUILD_CHAT"),
        save: (next) => {
          setSurface(draft, "GUILD_CHAT", next);
          return save();
        },
      }),
      selectField({
        label: t("catchesLabel"),
        hint: triggerHint(draft.trigger.kind),
        value: draft.trigger.kind,
        options: triggerOptions(),
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
        label: t("thenLabel"),
        hint: lookup(t("automodActionHint"), draft.action.type, ""),
        value: draft.action.type,
        options: automodActionOptions(),
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
        label: t("deleteLabel"),
        hint: t("deleteHint"),
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
        label: t("exemptRolesLabel"),
        hint: t("exemptRolesHint"),
        guildId,
        kind: "role",
        values: draft.exempt.roleIds,
        placeholder: t("exemptRolesPlaceholder"),
        save: (ids) => {
          draft.exempt.roleIds = [...ids];
          return save();
        },
      }),
      selectField({
        label: t("exemptCapabilityLabel"),
        hint: t("exemptCapabilityHint"),
        value: draft.exempt.capability ?? "",
        options: capabilityOptions(),
        save: (next) => {
          draft.exempt.capability = next === "" ? null : next;
          return save();
        },
      }),
    ),
    drafting ? null : h("p", { class: "field-hint" }, t("autosaveNote")),
  );
}

/** The fields one trigger kind needs, and nothing from the other seven. */
function triggerFields(draft: Draft, save: () => Promise<WriteResult>): readonly HTMLElement[] {
  const trig = draft.trigger;
  const num = (key: string, label: string, hint: string, min: number, max: number): HTMLElement =>
    textField({
      label,
      hint,
      value: String(trig[key] ?? ""),
      validate: (raw) =>
        whole(raw, min, max)
          ? null
          : t("errWhole").replace("{min}", String(min)).replace("{max}", String(max)),
      save: (raw) => {
        trig[key] = Number(raw.trim());
        return save();
      },
    });

  switch (trig.kind) {
    case "regex":
      return [
        textField({
          label: t("patternLabel"),
          hint: t("patternHint"),
          value: String(trig["pattern"] ?? ""),
          validate: (raw) =>
            raw.trim().length === 0 || raw.length > PATTERN_MAX
              ? t("errPattern").replace("{max}", String(PATTERN_MAX))
              : null,
          save: (raw) => {
            trig["pattern"] = raw.trim();
            return save();
          },
        }),
        textField({
          label: t("flagsLabel"),
          hint: t("flagsHint"),
          value: String(trig["flags"] ?? ""),
          validate: (raw) => (/^[gimsuy]*$/.test(raw.trim()) ? null : t("errFlags")),
          save: (raw) => {
            trig["flags"] = raw.trim();
            return save();
          },
        }),
      ];
    case "spam":
      return [
        num("messages", t("messagesLabel"), t("messagesHint"), 2, 100),
        num("windowSeconds", t("withinLabel"), within(), 1, WINDOW_MAX),
      ];
    case "repeat":
      return [
        num("times", t("repeatsLabel"), t("repeatsHint"), 2, 100),
        num("windowSeconds", t("withinLabel"), within(), 1, WINDOW_MAX),
      ];
    case "mentions":
      return [num("max", t("mentionsLabel"), t("mentionsHint"), 1, 100)];
    case "caps":
      return [
        num("percent", t("capsLabel"), t("capsHint"), 50, 100),
        num("minLength", t("minLengthLabel"), t("minLengthHint"), 4, 500),
      ];
    case "links":
      return [
        textField({
          label: t("allowlistLabel"),
          hint: t("allowlistHint").replace("{max}", String(ALLOWLIST_MAX)),
          value: (Array.isArray(trig["allowlist"]) ? (trig["allowlist"] as string[]) : []).join(", "),
          validate: (raw) =>
            splitList(raw).length > ALLOWLIST_MAX
              ? t("errAllowlist").replace("{max}", String(ALLOWLIST_MAX))
              : null,
          save: (raw) => {
            trig["allowlist"] = splitList(raw);
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
// ─────────────────────────── 2b. anti-raid ───────────────────────────

/**
 * The join gate: what turns it on, who it stops, and what they get.
 *
 * It sits beside Automod rather than on a page of its own because the two are
 * the same question asked at different doors — one about what a member posts,
 * one about whether they get in — and because the dry run below reports on both
 * together. An operator tightening a join threshold usually wants to know
 * whether the wordlist was the thing catching those accounts anyway.
 *
 * Every control saves the whole rule set. Unlike automod rules, which are
 * edited one at a time by different people, these eight fields are one
 * decision: a burst threshold with no action, or an action with no threshold,
 * is not a state worth being able to save.
 */
function antiRaidSection(guildId: string, data: ModerationVM): readonly (HTMLElement | null)[] {
  const rules = data.antiraid;
  if (!data.canConfigure) return [card(t("cardAntiRaid"), h("p", { class: "field-hint" }, t("antiRaidReadOnly")))];

  const save = (over: Partial<Record<string, unknown>>): Promise<WriteResult> =>
    postAction(guildId, "antiraid.save", {
      enabled: rules.enabled,
      burst: { joins: rules.burst.joins, windowSeconds: rules.burst.windowSeconds },
      autoEngage: rules.autoEngage,
      minAccountAgeHours: rules.minAccountAgeHours,
      requireAvatar: rules.requireAvatar,
      joinAction: rules.joinAction,
      autoLiftMinutes: rules.autoLiftMinutes,
      lockdownOnEngage: rules.lockdownOnEngage,
      ...over,
    });

  const body = h(
    "div",
    { class: "fields" },
    h("p", { class: "field-hint" }, t("antiRaidIntro")),
    fieldGroup(
      toggleField({
        label: t("antiRaidEnabledLabel"),
        hint: t("antiRaidEnabledHint"),
        checked: rules.enabled,
        save: (enabled) => save({ enabled }),
      }),
      toggleField({
        label: t("antiRaidAutoEngageLabel"),
        hint: t("antiRaidAutoEngageHint"),
        checked: rules.autoEngage,
        // An auto-engaging posture needs an auto-lift, which the mutation
        // refuses without. Sending one here rather than surfacing that refusal
        // turns a correct rule into a form the operator cannot get out of.
        save: (autoEngage) =>
          save(
            autoEngage && rules.autoLiftMinutes === null
              ? { autoEngage, autoLiftMinutes: 60 }
              : { autoEngage },
          ),
      }),
      textField({
        label: t("antiRaidBurstJoinsLabel"),
        hint: t("antiRaidBurstJoinsHint"),
        value: String(rules.burst.joins),
        validate: (raw) => validateWhole(raw, 2, 200),
        save: (raw) =>
          save({ burst: { joins: Number(raw.trim()), windowSeconds: rules.burst.windowSeconds } }),
      }),
      textField({
        label: t("antiRaidWindowLabel"),
        hint: t("antiRaidWindowHint"),
        value: String(rules.burst.windowSeconds),
        validate: (raw) => validateWhole(raw, 5, 3_600),
        save: (raw) => save({ burst: { joins: rules.burst.joins, windowSeconds: Number(raw.trim()) } }),
      }),
      textField({
        label: t("antiRaidAgeLabel"),
        hint: t("antiRaidAgeHint"),
        value: String(rules.minAccountAgeHours),
        validate: (raw) => validateWhole(raw, 0, 24 * 365),
        save: (raw) => save({ minAccountAgeHours: Number(raw.trim()) }),
      }),
      toggleField({
        label: t("antiRaidAvatarLabel"),
        hint: t("antiRaidAvatarHint"),
        checked: rules.requireAvatar,
        save: (requireAvatar) => save({ requireAvatar }),
      }),
      selectField({
        label: t("antiRaidActionLabel"),
        hint: t("antiRaidActionHint"),
        value: rules.joinAction,
        options: [
          ["FLAG", t("antiRaidActionFlag")],
          ["ALLOW", t("antiRaidActionAllow")],
          ["KICK", t("antiRaidActionKick")],
          ["BAN", t("antiRaidActionBan")],
        ],
        save: (joinAction) => save({ joinAction }),
      }),
      textField({
        label: t("antiRaidLiftLabel"),
        hint: t("antiRaidLiftHint"),
        value: rules.autoLiftMinutes === null ? "" : String(rules.autoLiftMinutes),
        placeholder: t("antiRaidLiftPlaceholder"),
        // Blank is a real answer here — stays on until lifted — so it is not
        // treated as an unfilled field.
        validate: (raw) => (raw.trim() === "" ? null : validateWhole(raw, 1, 24 * 60)),
        save: (raw) => save({ autoLiftMinutes: raw.trim() === "" ? null : Number(raw.trim()) }),
      }),
      toggleField({
        label: t("antiRaidLockdownLabel"),
        hint: t("antiRaidLockdownHint"),
        checked: rules.lockdownOnEngage,
        save: (lockdownOnEngage) => save({ lockdownOnEngage }),
      }),
    ),
  );

  return [card(t("cardAntiRaid"), body), card(t("cardRaidTest"), raidTestBox(guildId))];
}

/**
 * The dry run.
 *
 * An operator describes a burst — how many arrive, how old their accounts are,
 * whether they have a profile picture — and the panel replays it through the
 * same evaluator the gate uses. It exists because anti-raid rules are otherwise
 * only ever exercised during a raid, which is the worst possible moment to find
 * out a threshold was wrong.
 *
 * Deliberately coarse. Asking for a per-arrival table would model a raid more
 * precisely and answer a question nobody has; the questions operators actually
 * ask are "does my threshold trip" and "does this catch ordinary new members
 * too", and both are answered by a count and an age.
 */
function raidTestBox(guildId: string): HTMLElement {
  const status = statusSlot();
  let arrivals = "10";
  let ageHours = "2";
  let hasAvatar = false;
  let postureActive = false;

  const arrivalsInput = h("input", {
    class: "control control-text control-short",
    type: "text",
    value: arrivals,
    autocomplete: "off",
    "aria-label": t("raidTestArrivalsAria"),
  }) as HTMLInputElement;
  arrivalsInput.addEventListener("input", () => {
    arrivals = arrivalsInput.value;
  });

  const ageInput = h("input", {
    class: "control control-text control-short",
    type: "text",
    value: ageHours,
    autocomplete: "off",
    "aria-label": t("raidTestAgeAria"),
  }) as HTMLInputElement;
  ageInput.addEventListener("input", () => {
    ageHours = ageInput.value;
  });

  const run = actionButton({
    label: t("raidTestRun"),
    tone: "primary",
    status,
    run: () => {
      if (!whole(arrivals, 1, 50)) {
        return Promise.resolve<WriteResult>({ kind: "error", message: t("errRaidArrivals") });
      }
      if (!whole(ageHours, 0, 24 * 365)) {
        return Promise.resolve<WriteResult>({ kind: "error", message: t("errRaidAge") });
      }
      const joins = Array.from({ length: Number(arrivals.trim()) }, () => ({
        accountAgeHours: Number(ageHours.trim()),
        hasAvatar,
      }));
      return postAction(guildId, "antiraid.test", { joins, postureActive });
    },
  });

  return h(
    "div",
    { class: "fields" },
    h("p", { class: "field-hint" }, t("raidTestIntro")),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, t("raidTestArrivalsLabel")),
      h("div", { class: "field-row" }, arrivalsInput),
    ),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, t("raidTestAgeLabel")),
      h("div", { class: "field-row" }, ageInput),
    ),
    toggleField({
      label: t("raidTestAvatarLabel"),
      hint: t("raidTestAvatarHint"),
      checked: hasAvatar,
      save: async (next) => {
        hasAvatar = next;
        return { kind: "ok" };
      },
    }),
    toggleField({
      label: t("raidTestPostureLabel"),
      hint: t("raidTestPostureHint"),
      checked: postureActive,
      save: async (next) => {
        postureActive = next;
        return { kind: "ok" };
      },
    }),
    h("div", { class: "field-row" }, run),
    status.el,
  );
}

function testBox(guildId: string, policy: AutomodPolicy): HTMLElement {
  const status = statusSlot();
  const text = reasonBox(t("testPlaceholder"), 3);

  let surface = "DISCORD";
  let mentions = "0";
  const mentionInput = h("input", {
    class: "control control-text control-short",
    type: "text",
    value: "0",
    autocomplete: "off",
    "aria-label": t("testMentionsAria"),
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
      "aria-label": t("testCounterAria").replace("{rule}", rule.name),
    }) as HTMLInputElement;
    counterInputs.set(rule.id, input);
    return h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, t("testCounterLabel").replace("{rule}", rule.name)),
      h("div", { class: "field-row" }, input),
    );
  });

  const run = actionButton({
    label: t("testRun"),
    tone: "primary",
    status,
    run: () => {
      const body = text.value;
      if (body.trim().length === 0) {
        return Promise.resolve<WriteResult>({ kind: "error", message: t("errNoTestText") });
      }
      if (!whole(mentions, 0, 100)) {
        return Promise.resolve<WriteResult>({ kind: "error", message: t("errTestMentions") });
      }
      const counters: Record<string, number> = {};
      for (const [id, input] of counterInputs) {
        const raw = input.value.trim() === "" ? "0" : input.value;
        if (!whole(raw, 0, 10_000)) {
          return Promise.resolve<WriteResult>({ kind: "error", message: t("errTestCounters") });
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
      t("testIntro"),
    ),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, t("testMessageLabel")),
      h("div", { class: "field-row" }, text),
    ),
    selectField({
      label: t("testAsIfLabel"),
      value: surface,
      options: [
        ["DISCORD", t("testAsIfDiscord")],
        ["GUILD_CHAT", t("testAsIfGuildChat")],
      ],
      save: async (next) => {
        surface = next;
        return { kind: "ok" };
      },
    }),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, t("testMentionsLabel")),
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
        ? [h("p", { class: "field-hint" }, t("noOverrides"))]
        : entries.map(([command, seconds]) =>
            h(
              "div",
              { class: "field-row" },
              h("span", { class: "job-cell" }, h("code", {}, `/${command}`), describeSeconds(seconds)),
              actionButton({
                label: t("remove"),
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
    placeholder: t("overrideNamePlaceholder"),
    autocomplete: "off",
    "aria-label": t("overrideNameAria"),
  }) as HTMLInputElement;
  const secondsInput = h("input", {
    class: "control control-text control-short",
    type: "text",
    placeholder: t("overrideSecondsPlaceholder"),
    autocomplete: "off",
    "aria-label": t("overrideSecondsAria"),
  }) as HTMLInputElement;

  const add = actionButton({
    label: t("addOverride"),
    tone: "primary",
    status,
    run: () => {
      const command = nameInput.value.trim().replace(/^\//, "").toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(command)) {
        return Promise.resolve<WriteResult>({ kind: "error", message: t("errCommandName") });
      }
      if (!whole(secondsInput.value, 0, COOLDOWN_MAX)) {
        return Promise.resolve<WriteResult>({
          kind: "error",
          message: t("errCommandSeconds").replace("{max}", String(COOLDOWN_MAX)),
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
      t("cooldownsIntro"),
    ),
    fieldGroup(
      textField({
        label: t("defaultLabel"),
        hint: t("defaultHint").replace("{max}", String(COOLDOWN_MAX)),
        value: commandDefaultSeconds === null ? "" : String(commandDefaultSeconds),
        validate: (raw) =>
          raw.trim() === "" || whole(raw, 0, COOLDOWN_MAX)
            ? null
            : t("errDefault").replace("{max}", String(COOLDOWN_MAX)),
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
        label: t("relayLabel"),
        hint: t("relayHint").replace("{max}", String(COOLDOWN_MAX)),
        value: String(relaySeconds),
        validate: (raw) =>
          whole(raw, 0, COOLDOWN_MAX) ? null : t("errRelay").replace("{max}", String(COOLDOWN_MAX)),
        save: (raw) => {
          relaySeconds = Number(raw.trim());
          return save();
        },
      }),
    ),
    h("h4", { class: "field-label" }, t("overridesHeading")),
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
  if (draft.name.trim().length === 0) return t("errNoRuleName");
  if (draft.surfaces.length === 0) return t("errNoSurface");
  if (draft.trigger.kind === "regex" && String(draft.trigger["pattern"] ?? "").trim().length === 0) {
    return t("errNoPattern");
  }
  if (draft.action.type === "FLAG" && !draft.action.deleteMessage && draft.trigger.kind === "wordlist") {
    return t("errFlagOnlyWordlist");
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

/** The seconds cap on a rolling window, said once and used by both trigger kinds. */
function within(): string {
  return t("withinHint").replace("{max}", String(WINDOW_MAX));
}

function describeAction(action: AutomodRule["action"]): string {
  const base =
    action.type === "MUTE"
      ? action.durationSeconds === null
        ? t("describeMute")
        : t("describeMuteFor").replace("{span}", describeSpan(action.durationSeconds * 1000))
      : action.type.toLowerCase();
  return action.deleteMessage ? t("describeDelete").replace("{action}", base) : base;
}

function describeSeconds(seconds: number): string {
  return seconds === 0 ? t("noCooldown") : describeSpan(seconds * 1000);
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
      return badge(t("badgeInForce"), "warn");
    case "EXPIRED":
      return badge(t("badgeExpired"), "neutral");
    case "LIFTED":
      return badge(t("badgeLifted"), "ok");
    case "VOID":
      return badge(t("badgeVoid"), "neutral");
    default:
      // MOMENTARY — a warn or a kick had no duration to run out.
      return null;
  }
}

function describeDuration(row: ModerationActionVM): string {
  if (row.durationSeconds === null) return TIMED.has(row.type) ? t("permanent") : c("dash");
  const span = describeSpan(row.durationSeconds * 1000);
  if (row.expiresAt === null) return span;
  const remaining = Date.parse(row.expiresAt) - Date.now();
  return remaining > 0
    ? t("remaining").replace("{span}", span).replace("{left}", describeSpan(remaining))
    : span;
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
