/**
 * Members (WEB_PANEL.md §3.10) — everyone on both rosters, whether or not the
 * two sides have been joined.
 *
 * The page used to list only people with a platform membership row, which made
 * the two questions staff actually ask — "who is in the guild but not in the
 * server" and "who is in the server but not in the guild" — unanswerable from
 * the panel. Both rosters are now merged server-side and the tabs below are the
 * four views of that merge.
 *
 * Searching moved to the server with it. The filter can no longer be applied in
 * the browser because half the fields it matches on (IGN, uuid, in-game rank)
 * belong to rows the browser would otherwise never receive; the input is
 * debounced so a keystroke does not cost a query.
 *
 * OWNER is missing from the role dropdown on purpose — the mutation layer
 * refuses it, and offering an option that always fails is worse than not
 * offering it. Handing over ownership stays a deliberate act outside this page.
 */
import type { DirectoryMemberRow, DirectorySide, MembersVM } from "@sbr/panel-core";
import { loadPage, postAction } from "../api.js";
import {
  badge,
  card,
  deniedState,
  emptyState,
  errorState,
  pageTitle,
  person,
  spinner,
  statTile,
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

const TABS: readonly (readonly [DirectorySide, string])[] = [
  ["all", "All"],
  ["discord", "Discord only"],
  ["game", "In-game only"],
  ["unlinked", "Unlinked"],
];

/** Kept across tab switches, like the analytics window. */
const state: { q: string; side: DirectorySide } = { q: "", side: "all" };

/** Long enough that typing a name is one query, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

export async function renderMembers(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading members…"));

  const query = new URLSearchParams({ q: state.q, side: state.side });
  const result = await loadPage<MembersVM>(
    `/api/guilds/${encodeURIComponent(guildId)}/members?${query.toString()}`,
  );
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderMembers(host, guildId)));
  }

  const data = result.data;
  const rerender = (): void => void renderMembers(host, guildId);

  const search = h("input", {
    class: "control control-text",
    type: "search",
    value: state.q,
    placeholder: "Search by name, IGN, rank, Discord id or uuid",
    autocomplete: "off",
    "aria-label": "Search members",
  }) as HTMLInputElement;
  let timer = 0;
  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    state.q = search.value;
    timer = window.setTimeout(rerender, SEARCH_DEBOUNCE_MS);
  });

  const tabs = h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "Member filter" },
    ...TABS.map(([side, label]) => {
      const button = h("button", {
        type: "button",
        class: "tab",
        role: "tab",
        "aria-selected": side === state.side ? "true" : "false",
      }, label);
      button.addEventListener("click", () => {
        if (side === state.side) return;
        state.side = side;
        rerender();
      });
      return button;
    }),
  );

  // Percent and fraction both, because they answer different questions: the
  // percent says how healthy linking is, the fraction says how many people are
  // actually left to chase.
  const linkedNote =
    data.discordCount === 0
      ? "No Discord roster yet"
      : `${Math.round((data.linkedCount / data.discordCount) * 100)}% of the server · ${count(
          data.linkedCount,
        )}/${count(data.discordCount)}`;

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Members", `${count(data.rows.length)} shown`),
      h(
        "div",
        { class: "tiles" },
        statTile("Discord members", count(data.discordCount), scanNote(data.scannedAt.discord)),
        statTile("Guild members", count(data.guildCount), scanNote(data.scannedAt.hypixel)),
        statTile("Linked", count(data.linkedCount), linkedNote),
      ),
      card(
        "Roster",
        h(
          "div",
          {},
          h("div", { class: "controls" }, tabs, search),
          data.rows.length === 0
            ? emptyState(emptyMessage(data))
            : h(
                "div",
                {},
                membersTable(guildId, data.rows, rerender),
                data.truncated
                  ? h(
                      "p",
                      { class: "note" },
                      "More members matched than fit on one page. Narrow the search to see the rest.",
                    )
                  : null,
              ),
        ),
      ),
    ),
  );
}

/**
 * A roster is only as true as its last scan, so the tile says when that was
 * rather than presenting a stale count as current.
 */
function scanNote(at: string | null): string {
  return at === null ? "Never scanned" : `Scanned ${relativeTime(at)}`;
}

function emptyMessage(data: MembersVM): string {
  if (data.q.length > 0) return "Nobody matches that search.";
  switch (data.side) {
    case "discord":
      return "Everyone in the server has a linked account.";
    case "game":
      return "Everyone in the guild is linked to somebody in the server.";
    case "unlinked":
      return "Everyone on both rosters is linked.";
    default:
      return "No members on record yet. They appear as the roster scans run.";
  }
}

function membersTable(
  guildId: string,
  members: readonly DirectoryMemberRow[],
  rerender: () => void,
): HTMLElement {
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
          ...["Member", "Minecraft", "Link", "Guild rank", "Weekly GEXP", "Platform role", ""].map(
            (label) => h("th", { scope: "col" }, label),
          ),
        ),
      ),
      h("tbody", {}, ...members.map((member) => memberRow(guildId, member, rerender))),
    ),
  );
}

function memberRow(guildId: string, member: DirectoryMemberRow, rerender: () => void): HTMLElement {
  const status = statusSlot();
  const discordId = member.discordId;

  // A row with no Discord side has nothing this panel can edit: the platform
  // role lives on a membership that does not exist, and there is no link to
  // detach. It is still listed, because "in the guild, not in the server" is
  // precisely what someone came to this tab to find.
  const role =
    discordId === null
      ? h("span", { class: "muted" }, "—")
      : member.role === "OWNER"
        ? badge("owner", "neutral")
        : selectField({
            ariaLabel: `Platform role for ${member.username ?? discordId}`,
            value: ROLES.some(([value]) => value === member.role) ? (member.role ?? "MEMBER") : "MEMBER",
            options: ROLES,
            save: (next) => postAction(guildId, "member.role", { discordId, role: next }),
          });

  const unlink =
    discordId === null || member.uuid === null
      ? null
      : actionButton({
          label: "Unlink",
          tone: "danger",
          confirm: "Confirm unlink",
          // Only a real link can be detached; an unlinked row's uuid, if it has
          // one, belongs to the in-game side and nothing joins them.
          ...(member.linked ? {} : { disabled: true }),
          status,
          run: () =>
            postAction(guildId, "member.unlink", { discordId, minecraftUuid: member.uuid }),
          onDone: rerender,
        });

  return h(
    "tr",
    {},
    h(
      "td",
      {},
      discordId === null
        ? h("span", { class: "muted" }, "Not in Discord")
        : person(member.nickname ?? member.username ?? "unknown", h("code", {}, discordId)),
    ),
    h(
      "td",
      {},
      member.ign ?? (member.uuid === null ? "—" : "unknown name"),
      member.uuid ? h("div", {}, h("code", { class: "muted" }, member.uuid)) : null,
    ),
    h("td", {}, member.linked ? badge("linked", "ok") : badge("unlinked", "warn")),
    h("td", {}, member.guildRank ?? "—"),
    h("td", {}, member.weeklyGexp === null ? "—" : count(member.weeklyGexp)),
    h("td", {}, role),
    h("td", {}, h("div", { class: "row-actions" }, unlink, status.el)),
  );
}
