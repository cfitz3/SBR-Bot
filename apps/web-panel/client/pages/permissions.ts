/**
 * Permissions — what a level is, and who is at one.
 *
 * Four questions, in the order they are actually asked: who is an Officer, what
 * an Officer may do on the bridge, what an Officer may run, and who the answer
 * is wrong about. Each is a different store underneath, but that is the
 * platform's problem — the page is one screen because "why can this person do
 * that" is one investigation.
 *
 * Every row prints its platform default beside its current value. The useful
 * question here is never "what does it say" but "what have we changed", and a
 * guild that has configured nothing should be able to see that at a glance
 * rather than by comparing thirty dropdowns against the documentation.
 *
 * The whole page is Admin-tier, because an Officer who could edit it could bind
 * their own Discord role to Admin in one write.
 */
import type { PermissionsVM } from "@sbr/panel-core";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner, table } from "../components.js";
import { scope } from "../copy.js";
import { actionButton, fieldGroup, idChooser, multiPickerField, selectField, statusSlot } from "../forms.js";
import { h, replace } from "../dom.js";

const t = scope("permissions");

/** Mirrors `MAX_RANK_NAME` in the mutation layer; see forms.ts on why both exist. */
const RANK_MAX = 64;

/**
 * The subject kinds an exception can name, in the order the dropdown offers
 * them. The values are schema; the words for them are copy, and a capability the
 * platform gains before copy names it falls back to its own key rather than
 * rendering blank.
 */
const SUBJECTS = ["DISCORD_USER", "DISCORD_ROLE", "GUILD_RANK"] as const;

const subjectOptions = (): readonly (readonly [string, string])[] =>
  SUBJECTS.map((value) => [value, t("subject")[value]] as const);

/** What holding a capability lets someone do; unnamed capabilities say nothing. */
function capabilityHint(capability: string): string {
  const table = t("capability") as Readonly<Record<string, string>>;
  return table[capability] ?? "";
}

export async function renderPermissions(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("permissions"));

  const result = await loadPage<PermissionsVM>(`/api/guilds/${encodeURIComponent(guildId)}/permissions`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderPermissions(host, guildId)));
  }

  const vm = result.data;
  const reload = (): void => void renderPermissions(host, guildId);

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(t("title"), t("subtitle")),
      h("p", { class: "page-note" }, t("intro")),
      card(t("cardLevels"), levelsSection(guildId, vm, reload)),
      card(t("cardRanks"), ranksSection(guildId, vm, reload)),
      card(t("cardCapabilities"), capabilitiesSection(guildId, vm)),
      card(t("cardCommands"), commandsSection(guildId, vm)),
      card(t("cardExceptions"), exceptionsSection(guildId, vm, reload)),
    ),
  );
}

/**
 * Discord roles → level.
 *
 * A set per level rather than one role each: guilds hand out "Officer" and
 * "Senior Officer" and expect both to be officers, and the single-role form
 * made that a choice between them.
 */
function levelsSection(guildId: string, vm: PermissionsVM, reload: () => void): HTMLElement {
  return h(
    "div",
    {},
    h("p", { class: "field-hint" }, t("levelsHint")),
    ...vm.roles.map((role) =>
      multiPickerField({
        label: titleCase(role),
        hint: t("levelHint").replace("{article}", article(role)).replace("{level}", titleCase(role)),
        guildId,
        kind: "role",
        values: vm.bindings[role] ?? [],
        // Reloaded rather than patched: the level a member lands on is the
        // highest of several bindings, so a change here can move rows the
        // picker never touched.
        save: async (ids) => {
          const written = await postAction(guildId, "roles.binding", { role, discordRoleIds: [...ids] });
          if (written.kind === "ok") reload();
          return written;
        },
      }),
    ),
  );
}

/**
 * In-game rank → level.
 *
 * The other half of the ladder, and the half that works for members who have
 * never opened Discord: the guild scan knows their rank, so a `[Officer]` in
 * game can be staff on the platform without a Discord role at all.
 */
function ranksSection(guildId: string, vm: PermissionsVM, reload: () => void): HTMLElement {
  const status = statusSlot();

  const rankInput = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: t("rankPlaceholder"),
    "aria-label": t("rankLabel"),
    autocomplete: "off",
    spellcheck: "false",
    maxlength: String(RANK_MAX),
  }) as HTMLInputElement;

  let newRole = vm.roles[0] ?? "MEMBER";

  const add = actionButton({
    label: t("rankAdd"),
    tone: "primary",
    status,
    run: async () => {
      const rank = rankInput.value.trim();
      if (rank.length === 0 || rank.length > RANK_MAX) {
        return { kind: "error", message: t("errRankName").replace("{max}", String(RANK_MAX)) };
      }
      return postAction(guildId, "roles.rank", { rank, role: newRole });
    },
    onDone: reload,
  });

  const rows = vm.guildRanks.map((row) =>
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "job-cell" }, row.rank),
      selectField({
        label: t("rankLevel"),
        value: row.role,
        options: vm.roles.map((r) => [r, titleCase(r)] as const),
        save: (next) => postAction(guildId, "roles.rank", { rank: row.rank, role: next }),
      }),
      actionButton({
        label: t("rankUnmap"),
        tone: "danger",
        confirm: t("rankUnmapConfirm"),
        status,
        // null is the clear: the rank stops conferring anything rather than
        // dropping to the base level by way of a stored mapping.
        run: () => postAction(guildId, "roles.rank", { rank: row.rank, role: null }),
        onDone: reload,
      }),
    ),
  );

  return h(
    "div",
    {},
    h("p", { class: "field-hint" }, t("ranksHint")),
    ...(rows.length === 0 ? [emptyState("permissionsRanks")] : rows),
    h("div", { class: "field-row" }, rankInput),
    selectField({
      label: t("rankGives"),
      value: newRole,
      options: vm.roles.map((r) => [r, titleCase(r)] as const),
      // Nothing is stored until "Map rank"; the dropdown only records a choice.
      save: async (next) => {
        newRole = next;
        return { kind: "ok" };
      },
    }),
    h("div", { class: "field-row" }, add),
    status.el,
  );
}

/** The floor for each bridge capability — the lowest level that holds it. */
function capabilitiesSection(guildId: string, vm: PermissionsVM): HTMLElement {
  return h(
    "div",
    {},
    h("p", { class: "field-hint" }, t("capabilitiesHint")),
    fieldGroup(
      ...vm.capabilities.map((row) =>
        selectField({
          label: titleCase(row.capability),
          hint: `${capabilityHint(row.capability)} ${t("platformDefault").replace("{default}", titleCase(row.defaultRole))}`,
          value: row.role,
          options: vm.roles.map((r) => [r, titleCase(r)] as const),
          save: (next) => postAction(guildId, "roles.capability", { capability: row.capability, role: next }),
        }),
      ),
    ),
  );
}

/**
 * The level each staff command needs.
 *
 * Blank means "whatever the command ships with", and it is a real option rather
 * than a synonym for the current default: a command whose built-in floor is
 * later raised must not stay lowered by a policy written against the old one.
 */
function commandsSection(guildId: string, vm: PermissionsVM): HTMLElement {
  if (!vm.commandsAvailable) {
    return emptyState("permissionsCommandsUnavailable");
  }
  if (vm.commands.length === 0) return emptyState("permissionsCommandsNone");

  return h(
    "div",
    {},
    h("p", { class: "field-hint" }, t("commandsHint")),
    fieldGroup(
      ...vm.commands.map((row) =>
        selectField({
          label: `/${row.name}`,
          hint: t("commandHint")
            .replace("{description}", row.description)
            .replace("{default}", titleCase(row.defaultRole)),
          value: row.overridden ? row.role : "",
          options: [
            ["", t("commandDefaultOption").replace("{default}", titleCase(row.defaultRole))] as const,
            ...vm.roles.map((r) => [r, titleCase(r)] as const),
          ],
          save: (next) =>
            postAction(guildId, "roles.command", { command: row.name, role: next === "" ? null : next }),
        }),
      ),
    ),
  );
}

/**
 * Per-subject grants and denials.
 *
 * A deny row is not the absence of a grant and the form keeps them apart,
 * because the resolver does: deny beats grant beats level. Removing a row
 * restores whatever the subject's level says, which is a different outcome from
 * writing a denial and is the mistake this section is shaped to prevent.
 */
function exceptionsSection(guildId: string, vm: PermissionsVM, reload: () => void): HTMLElement {
  if (!vm.exceptionsAvailable) {
    return emptyState("permissionsExceptionsUnavailable");
  }

  const status = statusSlot();

  let subjectType = "DISCORD_USER";
  let capability = vm.capabilities[0]?.capability ?? "RELAY_MESSAGE";
  let allow = "true";

  // Both inputs exist at once and the form reads whichever the type calls for.
  // Swapping one for the other on change would clear a half-typed subject every
  // time someone corrected the dropdown.
  const chooser = idChooser({
    guildId,
    kind: "member",
    ariaLabel: t("subjectAria"),
    placeholder: t("subjectPlaceholder"),
  });
  const rankInput = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: t("rankPlaceholder"),
    "aria-label": t("rankLabel"),
    autocomplete: "off",
    spellcheck: "false",
    maxlength: String(RANK_MAX),
  }) as HTMLInputElement;

  const add = actionButton({
    label: t("exceptionAdd"),
    tone: "primary",
    status,
    run: async () => {
      const subjectId = subjectType === "GUILD_RANK" ? rankInput.value.trim() : chooser.value();
      if (subjectId.length === 0) return { kind: "error", message: t("errNoSubject") };
      return postAction(guildId, "roles.exception", {
        subjectType,
        subjectId,
        capability,
        allow: allow === "true",
      });
    },
    onDone: reload,
  });

  const rows = vm.exceptions.map((row) => [
    describeSubject(row.subjectType),
    row.subjectId,
    titleCase(row.capability),
    badge(row.allow ? t("granted") : t("denied"), row.allow ? "ok" : "bad"),
    actionButton({
      label: t("remove"),
      tone: "danger",
      confirm: t("removeConfirm"),
      status,
      run: () => postAction(guildId, "roles.exception.remove", { id: row.id }),
      onDone: reload,
    }),
  ]);

  return h(
    "div",
    {},
    h("p", { class: "field-hint" }, t("exceptionsHint")),
    rows.length === 0
      ? emptyState("permissionsExceptionsNone")
      : table([t("colAppliesTo"), t("colSubject"), t("colCapability"), t("colEffect"), ""], rows),
    selectField({
      label: t("subjectLabel"),
      value: subjectType,
      options: subjectOptions(),
      save: async (next) => {
        subjectType = next;
        return { kind: "ok" };
      },
    }),
    h("div", { class: "field-row" }, chooser.el, rankInput),
    h("p", { class: "field-hint" }, t("subjectHint")),
    selectField({
      label: t("capabilityLabel"),
      value: capability,
      options: vm.capabilities.map((c) => [c.capability, titleCase(c.capability)] as const),
      save: async (next) => {
        capability = next;
        return { kind: "ok" };
      },
    }),
    selectField({
      label: t("effectLabel"),
      value: allow,
      options: [
        ["true", t("effectGrant")],
        ["false", t("effectDeny")],
      ],
      save: async (next) => {
        allow = next;
        return { kind: "ok" };
      },
    }),
    h("div", { class: "field-row" }, add),
    status.el,
  );
}

function describeSubject(kind: string): string {
  const table = t("subject") as Readonly<Record<string, string>>;
  return table[kind] ?? kind;
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function article(role: string): string {
  return /^[AEIOU]/.test(role) ? "an" : "a";
}
