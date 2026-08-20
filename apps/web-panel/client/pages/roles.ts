/**
 * Roles & welcome — the two things this platform does to a member with nobody
 * in the loop at the moment it does them.
 *
 * The page leads with health and a dry run rather than with the editor, and
 * that ordering is the whole design. An auto-role policy is a write into
 * somebody else's Discord server across their entire roster; the question worth
 * answering before saving one is not "is this form valid" but "how many people
 * does this move, and is Discord even letting us move them". Both answers are
 * above the fold.
 *
 * Every control writes the **whole** policy, because the mutation stores the
 * whole policy: the rule list is ordered and removable, and a merge on the
 * server would make "I deleted that rule" and "I never had that rule"
 * indistinguishable. The one exception is the trigger dropdown, which only
 * repaints — see `triggerSelect`.
 */
import type { RolesVM } from "@sbr/panel-core";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner, table } from "../components.js";
import { scope } from "../copy.js";
import { count, dateTime, relativeTime } from "../format.js";
import {
  actionButton,
  attempt,
  channelPicker,
  fieldGroup,
  idChooser,
  isSnowflake,
  rolePicker,
  selectField,
  statusSlot,
  textField,
  toggleField,
} from "../forms.js";
import { h, replace } from "../dom.js";
import { channelSlotCopy } from "./channel-slots.js";
import {
  MAX_MENUS,
  MAX_MENU_BODY,
  MAX_MENU_OPTIONS,
  MAX_MENU_TITLE,
  MAX_OPTION_DESCRIPTION,
  MAX_OPTION_LABEL,
  MAX_ROLE_MENU_KEY,
  ROLE_MENU_KEY_SHAPE,
} from "./role-menu-limits.js";
import { SAMPLE_VALUES, WELCOME_TOKENS, renderPreview } from "./welcome-preview.js";

const t = scope("roles");
/** The shared "Save" word, so the template box's button reads like every other. */
const forms = scope("forms");

type AutoPolicy = RolesVM["autoRoles"];
type Rule = AutoPolicy["rules"][number];
type Trigger = Rule["trigger"];
type TriggerKind = Trigger["kind"];
type Welcome = RolesVM["welcome"];
type RoleMenu = RolesVM["menus"]["menus"][number];
type RoleMenuOption = RoleMenu["options"][number];

/** Mutable working copies, same document-at-a-time contract as the rules. */
type MutableOption = { -readonly [K in keyof RoleMenuOption]: RoleMenuOption[K] };
type MutableMenu = { -readonly [K in keyof RoleMenu]: K extends "options" ? MutableOption[] : RoleMenu[K] };

/** Mutable working copies. The server is sent a whole document either way. */
type MutableRule = { -readonly [K in keyof Rule]: Rule[K] };
type MutablePolicy = { enabled: boolean; rules: MutableRule[] };

/** Mirrors `MAX_TEMPLATE_LENGTH`; see forms.ts on why both copies exist. */
const MAX_TEMPLATE = 1_500;
const KEY_SHAPE = /^[a-z0-9]+(?:[.:-][a-z0-9]+)*$/;

/** Registry order, mirrored for the same no-bundler reason as the slot list. */
const TRIGGER_ORDER = [
  "IN_GUILD",
  "LINKED",
  "GUILD_RANK",
  "XP_LEVEL",
  "ACHIEVEMENT",
  "EVENTS_ATTENDED",
  "MANUAL",
] as const satisfies readonly TriggerKind[];

const triggerLabel = (kind: string): string =>
  (t("trigger") as Readonly<Record<string, string>>)[kind] ?? kind;

const triggerOptions = (): readonly (readonly [string, string])[] =>
  TRIGGER_ORDER.map((kind) => [kind, triggerLabel(kind)] as const);

export async function renderRoles(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner());

  const result = await loadPage<RolesVM>(`/api/guilds/${encodeURIComponent(guildId)}/roles`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderRoles(host, guildId)));
  }

  const vm = result.data;
  const reload = (): void => void renderRoles(host, guildId);

  // One mutable copy for the whole page. Rule cards mutate rows inside it and
  // then post the document, so a save from one row never drops another's edit.
  const policy: MutablePolicy = {
    enabled: vm.autoRoles.enabled,
    rules: vm.autoRoles.rules.map((rule) => ({ ...rule })),
  };
  const saveAuto = (): Promise<WriteResult> => postAction(guildId, "roles.auto.save", serialize(policy));

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(t("title"), t("subtitle")),
      healthCard(guildId, vm, reload),
      autoCard(guildId, policy, saveAuto),
      ...policy.rules.map((rule, index) => ruleCard(guildId, policy, rule, index, saveAuto, reload)),
      addCard(guildId, policy, saveAuto, reload),
      welcomeCards(guildId, vm.welcome),
      ...menuSection(guildId, vm, reload),
    ),
  );
}

/**
 * The policy as the mutation wants it.
 *
 * Built field by field rather than posted as-is: the working copy is a browser
 * object that has been through several edits, and sending exactly the shape the
 * validator accepts keeps a stray property from turning a save into a refusal
 * the admin cannot see the cause of.
 */
function serialize(policy: MutablePolicy): Readonly<Record<string, unknown>> {
  return {
    enabled: policy.enabled,
    rules: policy.rules.map((rule) => ({
      key: rule.key,
      label: rule.label,
      trigger: rule.trigger,
      roleId: rule.roleId,
      revokeWhenUnqualified: rule.revokeWhenUnqualified,
      enabled: rule.enabled,
    })),
  };
}

// ──────────────────────────────── health ────────────────────────────────

/**
 * Is the feature keeping up, and is anything blocking it?
 *
 * The refusal list is the reason this card exists. A role we cannot apply fails
 * silently in Discord — the sync reports success, the member never gets the
 * role, and the only trace is a line in a worker log no member of staff reads.
 */
function healthCard(guildId: string, vm: RolesVM, reload: () => void): HTMLElement {
  if (!vm.installed || vm.health === null) {
    return card(t("healthCard"), emptyState("rolesHealthUnavailable"));
  }
  const health = vm.health;
  const status = statusSlot();

  const refusals =
    health.refusals.length === 0
      ? emptyState("rolesNoRefusals")
      : h(
          "div",
          {},
          table(
            [t("refusalsTitle"), ""],
            health.refusals.map((refusal) => [
              t("refusalRow").replace("{roleId}", refusal.roleId).replace("{detail}", refusal.detail),
              relativeTime(refusal.at),
            ]),
          ),
          h("p", { class: "field-hint" }, t("refusalsHint")),
          h(
            "div",
            { class: "field-row" },
            actionButton({
              label: t("refusalsClear"),
              confirm: t("refusalsClearConfirm"),
              status,
              run: () => postAction(guildId, "roles.refusals.clear", {}),
              onDone: reload,
            }),
          ),
        );

  return card(
    t("healthCard"),
    h(
      "div",
      {},
      h(
        "p",
        { class: "field-hint" },
        `${t("healthPending")}: ${count(health.pendingDirty)}. ${t("healthPendingNote")} ` +
          `${t("healthLastSync")}: ${health.lastSyncAt === null ? t("healthNever") : dateTime(health.lastSyncAt)}.`,
      ),
      refusals,
      status.el,
    ),
    health.lastSyncStatus === null
      ? null
      : badge(health.lastSyncStatus, health.lastSyncStatus === "OK" ? "ok" : "bad"),
  );
}

// ────────────────────────────── auto-roles ──────────────────────────────

/** The master switch and the dry run — the two controls that govern the rest. */
function autoCard(guildId: string, policy: MutablePolicy, saveAuto: () => Promise<WriteResult>): HTMLElement {
  const status = statusSlot();

  return card(
    t("autoCard"),
    h(
      "div",
      {},
      fieldGroup(
        toggleField({
          label: t("autoEnabledLabel"),
          hint: t("autoEnabledHint"),
          checked: policy.enabled,
          save: (enabled) => {
            policy.enabled = enabled;
            return saveAuto();
          },
        }),
      ),
      h(
        "div",
        { class: "field-row" },
        actionButton({
          label: t("previewButton"),
          tone: "primary",
          status,
          // Deliberately posts the *working copy*, not the stored setting: the
          // question being asked is "what would happen if I saved this", which
          // is only worth answering before it is saved.
          run: () => postAction(guildId, "roles.preview", serialize(policy)),
        }),
      ),
      h("p", { class: "field-hint" }, t("previewHint")),
      status.el,
    ),
  );
}

/** A fresh trigger of `kind`, carrying over anything the old one can lend it. */
function triggerFor(kind: TriggerKind, previous: Trigger): Trigger {
  switch (kind) {
    case "GUILD_RANK":
      return { kind, rank: previous.kind === "GUILD_RANK" ? previous.rank : "" };
    case "ACHIEVEMENT":
      return { kind, definitionKey: previous.kind === "ACHIEVEMENT" ? previous.definitionKey : "" };
    case "XP_LEVEL":
    case "EVENTS_ATTENDED":
      return {
        kind,
        atLeast:
          previous.kind === "XP_LEVEL" || previous.kind === "EVENTS_ATTENDED" ? previous.atLeast : 0,
      };
    default:
      return { kind };
  }
}

/** The kinds that mean nothing without a value beside them. */
const NEEDS_VALUE = new Set<TriggerKind>(["GUILD_RANK", "ACHIEVEMENT", "XP_LEVEL", "EVENTS_ATTENDED"]);

function validateWhole(raw: string): string | null {
  const value = Number(raw.trim());
  return raw.trim().length > 0 && Number.isInteger(value) && value >= 0 ? null : t("errWholeNumber");
}

/**
 * One rule.
 *
 * Repaints itself rather than reloading the page when the trigger changes,
 * because changing the trigger changes which field sits under it and a round
 * trip to find that out would lose the choice on the way back. The repaint is
 * local only: nothing is stored until the field beneath it saves, which is what
 * lets somebody pick "They hold a guild rank" before knowing which rank.
 */
function ruleCard(
  guildId: string,
  policy: MutablePolicy,
  rule: MutableRule,
  index: number,
  saveAuto: () => Promise<WriteResult>,
  reload: () => void,
): HTMLElement {
  const host = h("div", {});

  function paint(): void {
    const status = statusSlot();

    const valueField =
      rule.trigger.kind === "GUILD_RANK"
        ? textField({
            label: t("ruleRankLabel"),
            hint: t("ruleRankHint"),
            value: rule.trigger.rank,
            validate: (raw) => (raw.trim().length === 0 ? t("errRank") : null),
            save: (raw) => {
              rule.trigger = { kind: "GUILD_RANK", rank: raw.trim() };
              return saveAuto();
            },
          })
        : rule.trigger.kind === "ACHIEVEMENT"
          ? textField({
              label: t("ruleAchievementLabel"),
              value: rule.trigger.definitionKey,
              validate: (raw) => (raw.trim().length === 0 ? t("errAchievement") : null),
              save: (raw) => {
                rule.trigger = { kind: "ACHIEVEMENT", definitionKey: raw.trim() };
                return saveAuto();
              },
            })
          : rule.trigger.kind === "XP_LEVEL" || rule.trigger.kind === "EVENTS_ATTENDED"
            ? textField({
                label: rule.trigger.kind === "XP_LEVEL" ? t("ruleLevelLabel") : t("ruleEventsLabel"),
                value: String(rule.trigger.atLeast),
                validate: validateWhole,
                save: (raw) => {
                  const kind = rule.trigger.kind === "XP_LEVEL" ? "XP_LEVEL" : "EVENTS_ATTENDED";
                  rule.trigger = { kind, atLeast: Number(raw.trim()) };
                  return saveAuto();
                },
              })
            : null;

    replace(
      host,
      card(
        rule.label,
        h(
          "div",
          {},
          fieldGroup(
            toggleField({
              label: t("ruleEnabledLabel"),
              checked: rule.enabled,
              save: (enabled) => {
                rule.enabled = enabled;
                return saveAuto();
              },
            }),
            textField({
              label: t("ruleLabel"),
              hint: t("ruleLabelHint"),
              value: rule.label,
              validate: (raw) => (raw.trim().length === 0 ? t("errKey") : null),
              save: (raw) => {
                rule.label = raw.trim();
                return saveAuto();
              },
            }),
            rolePicker({
              label: t("ruleRoleLabel"),
              guildId,
              value: rule.roleId,
              save: (roleId) => {
                rule.roleId = roleId;
                return saveAuto();
              },
            }),
            selectField({
              label: t("ruleTriggerLabel"),
              value: rule.trigger.kind,
              options: triggerOptions(),
              save: async (next) => {
                const kind = next as TriggerKind;
                const previous = rule.trigger;
                rule.trigger = triggerFor(kind, previous);
                // A trigger that still needs a value is not a policy yet, so it
                // is not sent. The field the repaint reveals is what commits it.
                if (NEEDS_VALUE.has(kind)) {
                  paint();
                  return { kind: "ok" };
                }
                const written = await saveAuto();
                if (written.kind !== "ok") rule.trigger = previous;
                paint();
                return written;
              },
            }),
            valueField,
            toggleField({
              label: t("ruleRevokeLabel"),
              hint: t("ruleRevokeHint"),
              checked: rule.revokeWhenUnqualified,
              save: (revoke) => {
                rule.revokeWhenUnqualified = revoke;
                return saveAuto();
              },
            }),
          ),
          h(
            "div",
            { class: "field-row" },
            actionButton({
              label: t("ruleRemove"),
              tone: "danger",
              confirm: t("ruleRemoveConfirm"),
              status,
              run: () => {
                policy.rules.splice(index, 1);
                return saveAuto();
              },
              onDone: reload,
            }),
          ),
          h("p", { class: "field-hint" }, t("ruleRemoveHint")),
          status.el,
        ),
        badge(rule.key, rule.enabled ? "ok" : "neutral"),
      ),
    );
  }

  paint();
  return host;
}

/**
 * The add form.
 *
 * The key is typed rather than derived from the name, for the same reason as a
 * milestone's: it is the identity the grant ledger keys off, so a key that
 * moved when somebody reworded the label would orphan everything the rule had
 * already granted.
 */
function addCard(
  guildId: string,
  policy: MutablePolicy,
  saveAuto: () => Promise<WriteResult>,
  reload: () => void,
): HTMLElement {
  const status = statusSlot();
  let key = "";
  let label = "";
  let kind: TriggerKind = "IN_GUILD";

  const role = idChooser({
    guildId,
    kind: "role",
    ariaLabel: t("ruleRoleLabel"),
    placeholder: t("addRolePlaceholder"),
  });

  const button = actionButton({
    label: t("addButton"),
    tone: "primary",
    status,
    run: async () => {
      const roleId = role.value().trim();
      if (!KEY_SHAPE.test(key)) return { kind: "error", message: t("errKey") };
      if (!isSnowflake(roleId)) return { kind: "error", message: t("errRole") };
      policy.rules.push({
        key,
        label: label.trim().length > 0 ? label.trim() : key,
        trigger: triggerFor(kind, { kind: "MANUAL" }),
        roleId,
        revokeWhenUnqualified: false,
        enabled: true,
      });
      const written = await saveAuto();
      // A refused add must not leave a row on the page that the server has
      // never heard of; the reload on success is what puts it there for real.
      if (written.kind !== "ok") policy.rules.pop();
      return written;
    },
    onDone: reload,
  });

  return card(
    t("addCard"),
    h(
      "div",
      {},
      fieldGroup(
        textField({
          label: t("addKeyLabel"),
          hint: t("addKeyHint"),
          value: "",
          validate: (raw) => (KEY_SHAPE.test(raw.trim()) ? null : t("errKey")),
          // Nothing is stored until "Add rule" — the field only records the
          // choice, so it reports success without a write.
          save: async (raw) => {
            key = raw.trim();
            return { kind: "ok" };
          },
        }),
        textField({
          label: t("ruleLabel"),
          value: "",
          save: async (raw) => {
            label = raw;
            return { kind: "ok" };
          },
        }),
        h(
          "div",
          { class: "field" },
          h("label", { class: "field-label" }, t("ruleRoleLabel")),
          h("div", { class: "field-row" }, role.el),
        ),
        selectField({
          label: t("ruleTriggerLabel"),
          value: kind,
          options: triggerOptions(),
          save: async (next) => {
            kind = next as TriggerKind;
            return { kind: "ok" };
          },
        }),
      ),
      h("div", { class: "field-row" }, button),
      status.el,
    ),
  );
}

// ─────────────────────────────── welcome ───────────────────────────────

const channelOptions = (): readonly (readonly [string, string])[] =>
  channelSlotCopy().map((slot) => [slot.slot, slot.label] as const);

/** A template box with the preview under it, updating as it is typed. */
function templateField(
  label: string,
  value: string,
  save: (next: string) => Promise<WriteResult>,
  hint: string | null,
): HTMLElement {
  const status = statusSlot();
  const preview = h("p", { class: "field-hint" }, renderPreview(value, SAMPLE_VALUES));

  const area = h("textarea", {
    class: "control control-area",
    rows: 3,
    "aria-label": label,
    maxlength: MAX_TEMPLATE,
  }) as HTMLTextAreaElement;
  area.value = value;

  const button = h("button", {
    class: "button button-primary",
    type: "button",
    disabled: true,
  }) as HTMLButtonElement;
  button.textContent = forms("save");

  let baseline = value;
  area.addEventListener("input", () => {
    // The preview is the point of the control, so it tracks every keystroke
    // rather than waiting for a save nobody has been given a reason to press.
    preview.textContent = renderPreview(area.value, SAMPLE_VALUES);
    button.disabled = area.value === baseline;
  });
  button.addEventListener("click", () => {
    const next = area.value;
    button.disabled = true;
    void attempt(status, () => save(next)).then((ok) => {
      if (ok) baseline = next;
      else button.disabled = false;
    });
  });

  return h(
    "div",
    { class: "field" },
    h("label", { class: "field-label" }, label),
    h("div", { class: "field-row" }, area),
    hint === null ? null : h("p", { class: "field-hint" }, hint),
    h("div", { class: "field-row" }, button),
    h("p", { class: "field-label" }, t("previewTitle")),
    preview,
    h("p", { class: "field-hint" }, t("previewNote")),
    status.el,
  );
}

function tokenHint(): string {
  return t("welcomeTextHint").replace("{tokens}", WELCOME_TOKENS.map((token) => `{${token}}`).join(", "));
}

/**
 * The three messages, each in its own card.
 *
 * Like the rule editor, every control posts the whole welcome document: the
 * three sections are validated together, and a partial write would need the
 * server to merge against a shape it deliberately refuses to guess at.
 */
function welcomeCards(guildId: string, welcome: Welcome): HTMLElement {
  const current: {
    join: { -readonly [K in keyof Welcome["join"]]: Welcome["join"][K] };
    leave: { -readonly [K in keyof Welcome["leave"]]: Welcome["leave"][K] };
    guildJoin: { -readonly [K in keyof Welcome["guildJoin"]]: Welcome["guildJoin"][K] };
  } = {
    join: { ...welcome.join },
    leave: { ...welcome.leave },
    guildJoin: { ...welcome.guildJoin },
  };

  const save = (): Promise<WriteResult> =>
    postAction(guildId, "roles.welcome.save", {
      join: {
        enabled: current.join.enabled,
        channelSlot: current.join.channelSlot,
        mode: current.join.mode,
        text: current.join.text,
        dm: current.join.dm,
        deleteAfterSeconds: current.join.deleteAfterSeconds,
      },
      leave: {
        enabled: current.leave.enabled,
        channelSlot: current.leave.channelSlot,
        text: current.leave.text,
      },
      guildJoin: {
        enabled: current.guildJoin.enabled,
        channelSlot: current.guildJoin.channelSlot,
        text: current.guildJoin.text,
      },
    });

  const slotSelect = (value: string, apply: (next: string) => void): HTMLElement =>
    selectField({
      label: t("welcomeChannelLabel"),
      value,
      options: channelOptions(),
      save: (next) => {
        apply(next);
        return save();
      },
    });

  const joinCard = card(
    t("welcomeCard"),
    h(
      "div",
      {},
      fieldGroup(
        toggleField({
          label: t("welcomeEnabledLabel"),
          checked: current.join.enabled,
          save: (enabled) => {
            current.join.enabled = enabled;
            return save();
          },
        }),
        slotSelect(current.join.channelSlot, (next) => {
          current.join.channelSlot = next as Welcome["join"]["channelSlot"];
        }),
        selectField({
          label: t("welcomeModeLabel"),
          value: current.join.mode,
          options: [
            ["TEXT", t("welcomeModeText")],
            ["EMBED", t("welcomeModeEmbed")],
          ],
          save: (next) => {
            current.join.mode = next as Welcome["join"]["mode"];
            return save();
          },
        }),
        templateField(
          t("welcomeTextLabel"),
          current.join.text,
          (next) => {
            current.join.text = next;
            return save();
          },
          tokenHint(),
        ),
        textField({
          label: t("welcomeDmLabel"),
          hint: t("welcomeDmHint"),
          value: current.join.dm ?? "",
          save: (raw) => {
            current.join.dm = raw.trim().length === 0 ? null : raw;
            return save();
          },
          clear: () => {
            current.join.dm = null;
            return save();
          },
        }),
        textField({
          label: t("welcomeDeleteLabel"),
          hint: t("welcomeDeleteHint"),
          value: current.join.deleteAfterSeconds === null ? "" : String(current.join.deleteAfterSeconds),
          validate: (raw) => {
            if (raw.trim().length === 0) return null;
            const value = Number(raw.trim());
            return Number.isInteger(value) && value >= 5 ? null : t("errDeleteAfter");
          },
          save: (raw) => {
            current.join.deleteAfterSeconds = raw.trim().length === 0 ? null : Number(raw.trim());
            return save();
          },
          clear: () => {
            current.join.deleteAfterSeconds = null;
            return save();
          },
        }),
      ),
    ),
  );

  const leaveCard = card(
    t("farewellCard"),
    fieldGroup(
      toggleField({
        label: t("welcomeEnabledLabel"),
        checked: current.leave.enabled,
        save: (enabled) => {
          current.leave.enabled = enabled;
          return save();
        },
      }),
      slotSelect(current.leave.channelSlot, (next) => {
        current.leave.channelSlot = next as Welcome["leave"]["channelSlot"];
      }),
      templateField(
        t("welcomeTextLabel"),
        current.leave.text,
        (next) => {
          current.leave.text = next;
          return save();
        },
        tokenHint(),
      ),
    ),
  );

  const guildJoinCard = card(
    t("guildJoinCard"),
    fieldGroup(
      toggleField({
        label: t("welcomeEnabledLabel"),
        checked: current.guildJoin.enabled,
        save: (enabled) => {
          current.guildJoin.enabled = enabled;
          return save();
        },
      }),
      slotSelect(current.guildJoin.channelSlot, (next) => {
        current.guildJoin.channelSlot = next as Welcome["guildJoin"]["channelSlot"];
      }),
      templateField(
        t("welcomeTextLabel"),
        current.guildJoin.text,
        (next) => {
          current.guildJoin.text = next;
          return save();
        },
        tokenHint(),
      ),
    ),
  );

  return h("div", {}, joinCard, leaveCard, guildJoinCard);
}

// ──────────────────────── self-service role menus ────────────────────────

/**
 * The menus members hand roles to themselves from.
 *
 * The document *is* the whitelist. A button press carries a menu id and an
 * option key and nothing else — never a role id — so the roles this page lists
 * are exactly the roles a member can reach, and a forged press can only name
 * something already published. That is why the editor is here, on the page that
 * already governs what happens to a member with nobody in the loop, rather than
 * on a page of its own.
 *
 * Saved whole, like the rules above and for the same reason: the option list is
 * ordered and removable, and merging it server-side would make "I removed that
 * colour" indistinguishable from "I never offered it".
 *
 * Posting is separate from saving. Saving is this process's work; posting is the
 * bridge bot's, and a menu whose text saved but whose message did not post must
 * say so rather than reporting one outcome for two different things.
 */
function menuSection(guildId: string, vm: RolesVM, reload: () => void): readonly HTMLElement[] {
  const menus: MutableMenu[] = vm.menus.menus.map((menu) => ({
    ...menu,
    options: menu.options.map((option) => ({ ...option })),
  }));
  const save = (): Promise<WriteResult> =>
    postAction(guildId, "roles.menus.save", {
      menus: menus.map((menu) => ({
        id: menu.id,
        title: menu.title,
        body: menu.body,
        channelId: menu.channelId,
        messageId: menu.messageId,
        exclusive: menu.exclusive,
        options: menu.options.map((option) => ({
          key: option.key,
          roleId: option.roleId,
          label: option.label,
          description: option.description,
          emoji: option.emoji,
        })),
      })),
    });

  return [
    menuIntroCard(vm, menus.length),
    ...menus.map((menu, index) => menuCard(guildId, vm, menus, menu, index, save, reload)),
    addMenuCard(menus, save, reload),
  ];
}

/** What the feature is, and — when no bot is wired — what it cannot do. */
function menuIntroCard(vm: RolesVM, total: number): HTMLElement {
  return card(
    t("menuCard"),
    h(
      "div",
      {},
      h("p", { class: "field-hint" }, t("menuIntro")),
      vm.canPublishMenus ? null : h("p", { class: "field-hint" }, t("menuNoBot")),
    ),
    badge(`${count(total)} / ${String(MAX_MENUS)}`, total === 0 ? "neutral" : "ok"),
  );
}

/** One menu: its text, where it lives, and the roles it offers. */
function menuCard(
  guildId: string,
  vm: RolesVM,
  menus: MutableMenu[],
  menu: MutableMenu,
  index: number,
  save: () => Promise<WriteResult>,
  reload: () => void,
): HTMLElement {
  const status = statusSlot();

  const optionRole = idChooser({
    guildId,
    kind: "role",
    ariaLabel: t("menuOptionRoleLabel"),
    placeholder: t("addRolePlaceholder"),
  });
  let optionKey = "";
  let optionLabel = "";

  return card(
    menu.title,
    h(
      "div",
      {},
      fieldGroup(
        textField({
          label: t("menuTitleLabel"),
          hint: t("menuTitleHint"),
          value: menu.title,
          validate: (raw) =>
            raw.trim().length === 0 || raw.trim().length > MAX_MENU_TITLE ? t("errMenuTitle") : null,
          save: (raw) => {
            menu.title = raw.trim();
            return save();
          },
        }),
        textField({
          label: t("menuBodyLabel"),
          hint: t("menuBodyHint"),
          value: menu.body,
          validate: (raw) => (raw.length > MAX_MENU_BODY ? t("errMenuBody") : null),
          save: (raw) => {
            menu.body = raw;
            return save();
          },
        }),
        toggleField({
          label: t("menuExclusiveLabel"),
          hint: t("menuExclusiveHint"),
          checked: menu.exclusive,
          save: (exclusive) => {
            menu.exclusive = exclusive;
            return save();
          },
        }),
        channelPicker({
          label: t("menuChannelLabel"),
          hint: t("menuChannelHint"),
          guildId,
          value: menu.channelId ?? "",
          save: (channelId) => {
            // Moving a menu drops the remembered message: the bridge posts anew
            // rather than editing a message in the channel it has left, which is
            // what stops live buttons being abandoned where nobody maintains them.
            const next = channelId === "" ? null : channelId;
            if (next !== menu.channelId) menu.messageId = null;
            menu.channelId = next;
            return save();
          },
        }),
      ),
      // The roles themselves. Listed rather than tabled: each row is a picker
      // and two text fields, which a table would only make narrower.
      menu.options.length === 0
        ? h("p", { class: "field-hint" }, t("menuNoOptions"))
        : h(
            "div",
            {},
            ...menu.options.map((option, optionIndex) =>
              menuOptionRow(guildId, menu, option, optionIndex, save, reload),
            ),
          ),
      h("div", { class: "field-row" }, h("label", { class: "field-label" }, t("menuOptionAdd")), optionRole.el),
      fieldGroup(
        textField({
          label: t("menuOptionKeyLabel"),
          hint: t("menuOptionKeyHint"),
          value: "",
          validate: (raw) => (menuKeyOk(raw) ? null : t("errMenuKey")),
          save: async (raw) => {
            optionKey = raw.trim().toLowerCase();
            return { kind: "ok" };
          },
        }),
        textField({
          label: t("menuOptionLabelLabel"),
          value: "",
          save: async (raw) => {
            optionLabel = raw.trim();
            return { kind: "ok" };
          },
        }),
      ),
      h(
        "div",
        { class: "field-row" },
        actionButton({
          label: t("menuOptionAddButton"),
          tone: "primary",
          status,
          run: async () => {
            const roleId = optionRole.value().trim();
            if (menu.options.length >= MAX_MENU_OPTIONS) return { kind: "error", message: t("errMenuFull") };
            if (!menuKeyOk(optionKey)) return { kind: "error", message: t("errMenuKey") };
            if (!isSnowflake(roleId)) return { kind: "error", message: t("errRole") };
            if (menu.options.some((option) => option.roleId === roleId)) {
              return { kind: "error", message: t("errMenuDuplicateRole") };
            }
            menu.options.push({
              key: optionKey,
              roleId,
              label: optionLabel.length > 0 ? optionLabel.slice(0, MAX_OPTION_LABEL) : optionKey,
              description: null,
              emoji: null,
            });
            const written = await save();
            // A refused add must not leave a row the server has never heard of.
            if (written.kind !== "ok") menu.options.pop();
            return written;
          },
          onDone: reload,
        }),
        // Posting is the bridge bot's work, so it is its own button and its own
        // outcome: a saved menu that failed to post has to say which half failed.
        actionButton({
          label: menu.messageId === null ? t("menuPublish") : t("menuRepublish"),
          tone: "primary",
          status,
          run: async () => {
            if (!vm.canPublishMenus) return { kind: "error", message: t("menuNoBot") };
            return postAction(guildId, "roles.menu.publish", { menuId: menu.id, channelId: menu.channelId });
          },
          onDone: reload,
        }),
        actionButton({
          label: t("menuRemove"),
          tone: "danger",
          confirm: t("menuRemoveConfirm"),
          status,
          run: () => {
            menus.splice(index, 1);
            return save();
          },
          onDone: reload,
        }),
      ),
      h("p", { class: "field-hint" }, t("menuRemoveHint")),
      status.el,
    ),
    badge(
      menu.messageId === null ? t("menuNotPosted") : t("menuPosted"),
      menu.messageId === null ? "neutral" : "ok",
    ),
  );
}

/** One offered role, and the button that stops offering it. */
function menuOptionRow(
  guildId: string,
  menu: MutableMenu,
  option: MutableOption,
  index: number,
  save: () => Promise<WriteResult>,
  reload: () => void,
): HTMLElement {
  const status = statusSlot();

  return h(
    "div",
    { class: "field" },
    fieldGroup(
      textField({
        label: t("menuOptionLabelLabel"),
        value: option.label,
        validate: (raw) =>
          raw.trim().length === 0 || raw.trim().length > MAX_OPTION_LABEL ? t("errMenuOptionLabel") : null,
        save: (raw) => {
          option.label = raw.trim();
          return save();
        },
      }),
      textField({
        label: t("menuOptionDescriptionLabel"),
        hint: t("menuOptionDescriptionHint"),
        value: option.description ?? "",
        validate: (raw) => (raw.trim().length > MAX_OPTION_DESCRIPTION ? t("errMenuOptionDescription") : null),
        save: (raw) => {
          option.description = raw.trim().length === 0 ? null : raw.trim();
          return save();
        },
      }),
      rolePicker({
        label: t("menuOptionRoleLabel"),
        guildId,
        value: option.roleId,
        save: (roleId) => {
          option.roleId = roleId;
          return save();
        },
      }),
    ),
    h(
      "div",
      { class: "field-row" },
      actionButton({
        label: t("menuOptionRemove"),
        tone: "danger",
        status,
        run: () => {
          menu.options.splice(index, 1);
          return save();
        },
        onDone: reload,
      }),
    ),
    status.el,
    // The key never changes: it is what the posted buttons carry, so renaming
    // one would break every button already in the channel until a republish.
    h("p", { class: "field-hint" }, `${t("menuOptionKeyLabel")}: ${option.key}`),
  );
}

/** Nothing here is stored until "Add menu"; the fields only record the choice. */
function addMenuCard(
  menus: MutableMenu[],
  save: () => Promise<WriteResult>,
  reload: () => void,
): HTMLElement {
  const status = statusSlot();
  let id = "";
  let title = "";

  return card(
    t("menuAddCard"),
    h(
      "div",
      {},
      fieldGroup(
        textField({
          label: t("menuIdLabel"),
          hint: t("menuIdHint"),
          value: "",
          validate: (raw) => (menuKeyOk(raw) ? null : t("errMenuKey")),
          save: async (raw) => {
            id = raw.trim().toLowerCase();
            return { kind: "ok" };
          },
        }),
        textField({
          label: t("menuTitleLabel"),
          value: "",
          save: async (raw) => {
            title = raw.trim();
            return { kind: "ok" };
          },
        }),
      ),
      h(
        "div",
        { class: "field-row" },
        actionButton({
          label: t("menuAddButton"),
          tone: "primary",
          status,
          run: async () => {
            if (menus.length >= MAX_MENUS) return { kind: "error", message: t("errMenuLimit") };
            if (!menuKeyOk(id)) return { kind: "error", message: t("errMenuKey") };
            if (menus.some((menu) => menu.id === id)) return { kind: "error", message: t("errMenuDuplicateId") };
            menus.push({
              id,
              title: title.length > 0 ? title.slice(0, MAX_MENU_TITLE) : id,
              body: "",
              channelId: null,
              messageId: null,
              exclusive: false,
              options: [],
            });
            const written = await save();
            if (written.kind !== "ok") menus.pop();
            return written;
          },
          onDone: reload,
        }),
      ),
      h("p", { class: "field-hint" }, t("menuAddHint")),
      status.el,
    ),
  );
}

/** The shape a menu id and an option key share — no colons; see the limits file. */
function menuKeyOk(raw: string): boolean {
  const key = raw.trim().toLowerCase();
  return key.length > 0 && key.length <= MAX_ROLE_MENU_KEY && ROLE_MENU_KEY_SHAPE.test(key);
}
