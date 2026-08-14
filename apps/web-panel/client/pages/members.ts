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
  type EmptyContext,
} from "../components.js";
import { scope } from "../copy.js";
import { h, replace } from "../dom.js";
import { actionButton, selectField, statusSlot } from "../forms.js";
import { count, relativeTime } from "../format.js";

const t = scope("members");
const c = scope("common");

/**
 * Assignable tiers, mirroring `ASSIGNABLE_ROLES` in the mutation layer.
 *
 * The list is structure — which tiers may be handed out — and the words come
 * from the copy layer, so a guild that calls officers something else changes one
 * key rather than the dropdown's meaning.
 */
const ROLES = ["MEMBER", "MODERATOR", "OFFICER", "ADMIN"] as const;

const TABS = ["all", "discord", "game", "unlinked"] as const satisfies readonly DirectorySide[];

const roleOptions = (): readonly (readonly [string, string])[] =>
  ROLES.map((value) => [value, t("role")[value]] as const);

/** Kept across tab switches, like the analytics window. */
const state: { q: string; side: DirectorySide } = { q: "", side: "all" };

/** Long enough that typing a name is one query, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

export async function renderMembers(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("members"));

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
    placeholder: t("searchPlaceholder"),
    autocomplete: "off",
    "aria-label": t("searchLabel"),
  }) as HTMLInputElement;
  let timer = 0;
  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    state.q = search.value;
    timer = window.setTimeout(rerender, SEARCH_DEBOUNCE_MS);
  });

  const tabs = h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": t("filterLabel") },
    ...TABS.map((side) => {
      const button = h("button", {
        type: "button",
        class: "tab",
        role: "tab",
        "aria-selected": side === state.side ? "true" : "false",
      }, t("tab")[side]);
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
      ? t("noDiscordRoster")
      : t("linkedNote")
          .replace("{pct}", String(Math.round((data.linkedCount / data.discordCount) * 100)))
          .replace("{linked}", count(data.linkedCount))
          .replace("{total}", count(data.discordCount));

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(t("title"), t("subtitle").replace("{count}", count(data.rows.length))),
      h(
        "div",
        { class: "tiles" },
        statTile(t("tileDiscord"), count(data.discordCount), scanNote(data.scannedAt.discord)),
        statTile(t("tileGuild"), count(data.guildCount), scanNote(data.scannedAt.hypixel)),
        statTile(t("tileLinked"), count(data.linkedCount), linkedNote),
      ),
      card(
        t("cardRoster"),
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
                      t("truncated"),
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
  return at === null ? t("neverScanned") : t("scanned").replace("{when}", relativeTime(at));
}

function emptyMessage(data: MembersVM): EmptyContext {
  if (data.q.length > 0) return "membersSearch";
  switch (data.side) {
    case "discord":
      return "membersDiscord";
    case "game":
      return "membersGame";
    case "unlinked":
      return "membersUnlinked";
    default:
      return "membersNone";
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
          ...[
            t("colMember"),
            t("colMinecraft"),
            t("colLink"),
            t("colGuildRank"),
            t("colWeeklyGexp"),
            t("colRole"),
            "",
          ].map(
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
      ? h("span", { class: "muted" }, c("dash"))
      : member.role === "OWNER"
        ? badge(t("role").OWNER, "neutral")
        : selectField({
            ariaLabel: t("roleLabel").replace("{name}", member.username ?? discordId),
            value: ROLES.some((value) => value === member.role) ? (member.role ?? "MEMBER") : "MEMBER",
            options: roleOptions(),
            save: (next) => postAction(guildId, "member.role", { discordId, role: next }),
          });

  const unlink =
    discordId === null || member.uuid === null
      ? null
      : actionButton({
          label: t("unlink"),
          tone: "danger",
          confirm: t("unlinkConfirm"),
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
        ? h("span", { class: "muted" }, t("notInDiscord"))
        : person(member.nickname ?? member.username ?? t("unknownName"), h("code", {}, discordId)),
    ),
    h(
      "td",
      {},
      member.ign ?? (member.uuid === null ? c("dash") : t("unknownIgn")),
      member.uuid ? h("div", {}, h("code", { class: "muted" }, member.uuid)) : null,
    ),
    h("td", {}, member.linked ? badge(t("linked"), "ok") : badge(t("unlinked"), "warn")),
    h("td", {}, member.guildRank ?? c("dash")),
    h("td", {}, member.weeklyGexp === null ? c("dash") : count(member.weeklyGexp)),
    h("td", {}, role),
    h("td", {}, h("div", { class: "row-actions" }, unlink, status.el)),
  );
}
