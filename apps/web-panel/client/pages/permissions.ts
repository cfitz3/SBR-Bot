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
import { actionButton, fieldGroup, idChooser, multiPickerField, selectField, statusSlot } from "../forms.js";
import { h, replace } from "../dom.js";

/** Mirrors `MAX_RANK_NAME` in the mutation layer; see forms.ts on why both exist. */
const RANK_MAX = 64;

/** What holding a capability actually lets someone do, in the guild's terms. */
const CAPABILITY_COPY: Readonly<Record<string, string>> = {
  RELAY_MESSAGE: "Speak through the bridge — their Discord messages reach guild chat.",
  RUN_COMMAND: "Run bot commands from guild chat.",
  MENTION: "Have @mentions survive the relay instead of being flattened.",
  BYPASS_FILTER: "Skip the chat filter entirely, in both directions.",
  BYPASS_COOLDOWN: "Skip relay and command cooldowns.",
  ADMIN: "Administrative bridge control. Only ever an Admin.",
};

const SUBJECT_COPY: readonly (readonly [string, string])[] = [
  ["DISCORD_USER", "one person"],
  ["DISCORD_ROLE", "a Discord role"],
  ["GUILD_RANK", "an in-game rank"],
];

export async function renderPermissions(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading permissions…"));

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
      pageTitle("Permissions", "Who is staff, and what staff means"),
      h(
        "p",
        { class: "page-note" },
        "A member's level is the highest of what their Discord roles and their in-game rank give them. " +
          "Levels grant capabilities; an exception overrides a level for one subject, and a denial there beats " +
          "every grant and every level.",
      ),
      card("Levels", levelsSection(guildId, vm, reload)),
      card("In-game ranks", ranksSection(guildId, vm, reload)),
      card("Bridge capabilities", capabilitiesSection(guildId, vm)),
      card("Command access", commandsSection(guildId, vm)),
      card("Exceptions", exceptionsSection(guildId, vm, reload)),
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
    h(
      "p",
      { class: "field-hint" },
      "Holding any of a level's roles puts a member at that level. Someone with roles at two levels gets the " +
        "higher one. Members with none of these roles are at the base level.",
    ),
    ...vm.roles.map((role) =>
      multiPickerField({
        label: titleCase(role),
        hint: `Discord roles that make someone ${article(role)} ${titleCase(role)}.`,
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
    placeholder: "the rank's name in game",
    "aria-label": "In-game rank",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: String(RANK_MAX),
  }) as HTMLInputElement;

  let newRole = vm.roles[0] ?? "MEMBER";

  const add = actionButton({
    label: "Map rank",
    tone: "primary",
    status,
    run: async () => {
      const rank = rankInput.value.trim();
      if (rank.length === 0 || rank.length > RANK_MAX) {
        return { kind: "error", message: `Enter a rank name of up to ${RANK_MAX} characters.` };
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
        label: "Level",
        value: row.role,
        options: vm.roles.map((r) => [r, titleCase(r)] as const),
        save: (next) => postAction(guildId, "roles.rank", { rank: row.rank, role: next }),
      }),
      actionButton({
        label: "Unmap",
        tone: "danger",
        confirm: "Confirm unmap",
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
    h(
      "p",
      { class: "field-hint" },
      "Ranks are matched case-insensitively against the guild scan. A rank that isn't mapped confers nothing.",
    ),
    ...(rows.length === 0 ? [emptyState("No in-game rank confers a level in this guild.")] : rows),
    h("div", { class: "field-row" }, rankInput),
    selectField({
      label: "Gives",
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
    h(
      "p",
      { class: "field-hint" },
      "Every level at or above the floor holds the capability. ADMIN cannot be lowered below Admin, which is what " +
        "stops this page from being used to give it away.",
    ),
    fieldGroup(
      ...vm.capabilities.map((row) =>
        selectField({
          label: titleCase(row.capability),
          hint: `${CAPABILITY_COPY[row.capability] ?? ""} Platform default: ${titleCase(row.defaultRole)}.`,
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
    return emptyState("The command list isn't available in this deployment, so command floors can't be edited here.");
  }
  if (vm.commands.length === 0) return emptyState("No staff commands are registered.");

  return h(
    "div",
    {},
    h(
      "p",
      { class: "field-hint" },
      "Leave a command on its default unless you have a reason — the defaults are what the handlers were written " +
        "against, and lowering one is how a destructive command reaches someone it wasn't meant for.",
    ),
    fieldGroup(
      ...vm.commands.map((row) =>
        selectField({
          label: `/${row.name}`,
          hint: `${row.description} Default: ${titleCase(row.defaultRole)}.`,
          value: row.overridden ? row.role : "",
          options: [
            ["", `default — ${titleCase(row.defaultRole)}`] as const,
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
    return emptyState("Per-person exceptions aren't available in this deployment.");
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
    ariaLabel: "Member or role",
    placeholder: "search members",
  });
  const rankInput = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: "the rank's name in game",
    "aria-label": "In-game rank",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: String(RANK_MAX),
  }) as HTMLInputElement;

  const add = actionButton({
    label: "Add exception",
    tone: "primary",
    status,
    run: async () => {
      const subjectId = subjectType === "GUILD_RANK" ? rankInput.value.trim() : chooser.value();
      if (subjectId.length === 0) return { kind: "error", message: "Choose who this applies to." };
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
    badge(row.allow ? "granted" : "denied", row.allow ? "ok" : "bad"),
    actionButton({
      label: "Remove",
      tone: "danger",
      confirm: "Confirm remove",
      status,
      run: () => postAction(guildId, "roles.exception.remove", { id: row.id }),
      onDone: reload,
    }),
  ]);

  return h(
    "div",
    {},
    h(
      "p",
      { class: "field-hint" },
      "An exception overrides the level for one subject. A denial wins over every grant and every level — removing " +
        "a row is not the same as denying it, and restores whatever the level said.",
    ),
    rows.length === 0
      ? emptyState("Nobody is an exception in this guild.")
      : table(["Applies to", "Subject", "Capability", "Effect", ""], rows),
    selectField({
      label: "Applies to",
      value: subjectType,
      options: SUBJECT_COPY.map(([v, l]) => [v, l] as const),
      save: async (next) => {
        subjectType = next;
        return { kind: "ok" };
      },
    }),
    h("div", { class: "field-row" }, chooser.el, rankInput),
    h(
      "p",
      { class: "field-hint" },
      "Search picks a member; a Discord role or in-game rank can be typed in by hand.",
    ),
    selectField({
      label: "Capability",
      value: capability,
      options: vm.capabilities.map((c) => [c.capability, titleCase(c.capability)] as const),
      save: async (next) => {
        capability = next;
        return { kind: "ok" };
      },
    }),
    selectField({
      label: "Effect",
      value: allow,
      options: [
        ["true", "grant it"],
        ["false", "deny it"],
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
  return SUBJECT_COPY.find(([v]) => v === kind)?.[1] ?? kind;
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
