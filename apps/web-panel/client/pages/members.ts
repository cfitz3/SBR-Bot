/**
 * Members (WEB_PANEL.md §3.10) — who is in the guild, what they're linked to,
 * and the two edits the panel allows on them: platform role and account link.
 *
 * The filter is client-side because the whole roster arrives in one read and
 * fits comfortably in memory; a server round trip per keystroke would be slower
 * and would make the page useless the moment the API hiccuped.
 *
 * OWNER is missing from the role dropdown on purpose — the mutation layer
 * refuses it, and offering an option that always fails is worse than not
 * offering it. Handing over ownership stays a deliberate act outside this page.
 */
import type { LinkedMember, MembersVM } from "@sbr/panel-core";
import { loadPage, postAction } from "../api.js";
import {
  badge,
  card,
  deniedState,
  emptyState,
  errorState,
  pageTitle,
  spinner,
  statTile,
  type BadgeTone,
} from "../components.js";
import { h, replace } from "../dom.js";
import { actionButton, selectField, statusSlot } from "../forms.js";
import { count, relativeTime } from "../format.js";

/** Assignable tiers, mirroring `ASSIGNABLE_ROLES` in the mutation layer. */
const ROLES: readonly (readonly [string, string])[] = [
  ["MEMBER", "Member"],
  ["MODERATOR", "Moderator"],
  ["OFFICER", "Officer"],
  ["ADMIN", "Admin"],
];

/** Kept across tab switches, like the analytics window. */
const state: { filter: string } = { filter: "" };

export async function renderMembers(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading members…"));

  const result = await loadPage<MembersVM>(`/api/guilds/${encodeURIComponent(guildId)}/members`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderMembers(host, guildId)));
  }

  const data = result.data;
  const rerender = (): void => void renderMembers(host, guildId);
  const rows = h("div", {});

  function paint(): void {
    const visible = data.members.filter((m) => matches(m, state.filter));
    replace(
      rows,
      visible.length === 0
        ? emptyState(
            state.filter
              ? "No member matches that search."
              : "No members on record yet. They appear as the roster sync runs.",
          )
        : membersTable(guildId, visible, rerender),
    );
  }

  const filter = h("input", {
    class: "control control-text",
    type: "search",
    value: state.filter,
    placeholder: "Filter by name, IGN, id or rank",
    autocomplete: "off",
    "aria-label": "Filter members",
  }) as HTMLInputElement;
  filter.addEventListener("input", () => {
    state.filter = filter.value;
    paint();
  });

  paint();

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Members", `${count(data.members.length)} on record`),
      h(
        "div",
        { class: "tiles" },
        statTile("Members", count(data.members.length)),
        statTile("Awaiting verification", count(data.pendingCount), "Linked but unconfirmed"),
        statTile("No linked account", count(data.unlinkedCount), "Can't be matched in-game"),
      ),
      card("Roster", h("div", {}, h("div", { class: "controls" }, filter), rows)),
    ),
  );
}

function matches(member: LinkedMember, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [member.username, member.ign, member.discordId, member.guildRank, member.role].some(
    (field) => (field ?? "").toLowerCase().includes(needle),
  );
}

function membersTable(guildId: string, members: readonly LinkedMember[], rerender: () => void): HTMLElement {
  // Built directly rather than through `table()` because each row owns live
  // controls and a status line, which the string-cell helper can't carry.
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ...["Member", "Minecraft", "Link", "Guild rank", "Last seen", "Platform role", ""].map((label) =>
            h("th", { scope: "col" }, label),
          ),
        ),
      ),
      h("tbody", {}, ...members.map((member) => memberRow(guildId, member, rerender))),
    ),
  );
}

function memberRow(guildId: string, member: LinkedMember, rerender: () => void): HTMLElement {
  const status = statusSlot();

  // An owner's row is shown, not hidden — you should be able to see who holds it
  // — but it gets a badge rather than a dropdown, because every option in that
  // dropdown would be a demotion the mutation layer refuses to apply to an owner.
  const role =
    member.role === "OWNER"
      ? badge("owner", "neutral")
      : selectField({
          ariaLabel: `Platform role for ${member.username ?? member.discordId}`,
          value: ROLES.some(([value]) => value === member.role) ? member.role : "MEMBER",
          options: ROLES,
          save: (next) => postAction(guildId, "member.role", { discordId: member.discordId, role: next }),
        });

  const unlink = actionButton({
    label: "Unlink",
    tone: "danger",
    confirm: "Confirm unlink",
    // The mutation needs the uuid, so a member without one has nothing to detach.
    ...(member.uuid === null ? { disabled: true } : {}),
    status,
    run: () =>
      postAction(guildId, "member.unlink", { discordId: member.discordId, minecraftUuid: member.uuid }),
    onDone: rerender,
  });

  return h(
    "tr",
    {},
    h(
      "td",
      {},
      h("div", { class: "job-cell" }, member.username ?? "unknown"),
      h("code", { class: "muted" }, member.discordId),
    ),
    h(
      "td",
      {},
      member.ign ?? "—",
      member.uuid ? h("div", {}, h("code", { class: "muted" }, member.uuid)) : null,
    ),
    h("td", {}, badge(linkLabel(member.verification), linkTone(member.verification))),
    h("td", {}, member.guildRank ?? "—"),
    h("td", {}, relativeTime(member.lastSeenAt)),
    h("td", {}, role),
    h("td", {}, h("div", { class: "row-actions" }, unlink, status.el)),
  );
}

function linkLabel(verification: LinkedMember["verification"]): string {
  switch (verification) {
    case "VERIFIED":
      return "verified";
    case "PENDING":
      return "pending";
    case "UNLINKED":
      return "not linked";
  }
}

function linkTone(verification: LinkedMember["verification"]): BadgeTone {
  switch (verification) {
    case "VERIFIED":
      return "ok";
    case "PENDING":
      return "warn";
    case "UNLINKED":
      return "neutral";
  }
}
