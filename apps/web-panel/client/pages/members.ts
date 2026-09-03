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
 * Ordering is the server's, not the browser's: linked first, then by whether
 * the guild still has them, then by authority, then by name. That puts the two
 * rows staff act on — somebody unlinked, somebody gone — at the top of the list
 * they are already reading, rather than behind a sort they have to think to
 * apply.
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

/**
 * Whether this page has ever drawn in this session.
 *
 * A search keystroke and a cleanup both re-read the roster, and blanking the
 * table to a spinner each time reads as a page breaking rather than a page
 * working. So the spinner is for the first paint only; a refresh leaves the
 * previous table on screen until the new one is ready.
 */
let painted = false;

export async function renderMembers(host: HTMLElement, guildId: string): Promise<void> {
  if (!painted) replace(host, spinner("members"));

  const query = new URLSearchParams({ q: state.q, side: state.side });
  const result = await loadPage<MembersVM>(
    `/api/guilds/${encodeURIComponent(guildId)}/members?${query.toString()}`,
  );
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderMembers(host, guildId)));
  }

  const data = result.data;
  painted = true;
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
          h("p", { class: "note" }, t("cleanupHint")),
        ),
        cleanupAction(guildId, data, rerender),
      ),
    ),
  );
}

/**
 * The one bulk tool: archive everybody the Discord side has recorded as gone
 * who is still holding a role.
 *
 * Disabled rather than hidden when there is nobody to archive, with the count
 * in the label either way — a button that appears and disappears makes staff
 * wonder whether they imagined it, and "Archive 0 departed" is a clear answer
 * to "is there anything to clean up".
 */
function cleanupAction(guildId: string, data: MembersVM, rerender: () => void): HTMLElement {
  const status = statusSlot();
  return h(
    "div",
    { class: "card-action" },
    actionButton({
      label: t("archiveDeparted").replace("{n}", count(data.departedCount)),
      tone: "danger",
      confirm: t("archiveDepartedConfirm"),
      ...(data.departedCount === 0 ? { disabled: true } : {}),
      status,
      run: () => postAction(guildId, "member.archive.departed", {}),
      onDone: rerender,
    }),
    status.el,
  );
}

/**
 * Where a member stands on each side, as badges.
 *
 * Two separate facts, deliberately not collapsed into one word: the in-game
 * guild no longer listing somebody ("Left guild") and the Discord side having
 * recorded them out ("Removed") happen independently and need different
 * follow-up. `null` means no scan has answered yet, which is not the same as
 * being gone, so nothing is claimed.
 */
function standing(member: DirectoryMemberRow): HTMLElement {
  const marks: HTMLElement[] = [];
  if (member.inGuild === false) marks.push(badge(t("leftGuild"), "warn"));
  else if (member.inGuild === true) marks.push(badge(t("inGuild"), "ok"));

  if (member.status === "BANNED") marks.push(badge(t("banned"), "bad"));
  else if (member.status === "LEFT") marks.push(badge(t("removed"), "bad"));

  if (member.activeCases > 0) {
    marks.push(badge(t("openCases").replace("{n}", count(member.activeCases)), "warn"));
  }

  if (marks.length === 0) return h("span", { class: "muted" }, t("standingUnknown"));
  return h(
    "div",
    {},
    ...marks,
    member.leftAt === null ? null : h("div", { class: "muted" }, relativeTime(member.leftAt)),
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
            t("colStanding"),
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

  // No Discord membership row means nothing to archive and no platform level to
  // pin: an in-game-only row is a person this panel has no record of.
  const cleanup =
    discordId === null
      ? null
      : h(
          "details",
          { class: "collapse" },
          h("summary", {}, t("cleanup")),
          h(
            "div",
            { class: "row-actions" },
            actionButton({
              label: t("archive"),
              tone: "danger",
              confirm: t("archiveConfirm"),
              status,
              run: () => postAction(guildId, "member.archive", { discordId }),
              onDone: rerender,
            }),
            actionButton({
              label: t("stripRoles"),
              tone: "danger",
              confirm: t("stripRolesConfirm"),
              status,
              run: () => postAction(guildId, "member.roles.strip", { discordId }),
              onDone: rerender,
            }),
          ),
        );

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
    h("td", {}, standing(member)),
    h("td", {}, member.weeklyGexp === null ? c("dash") : count(member.weeklyGexp)),
    h("td", {}, role),
    h(
      "td",
      {},
      h(
        "div",
        { class: "row-actions" },
        unlink,
        // The destructive pair sits behind a disclosure rather than on the row:
        // three danger buttons per member across a 300-row table is an invitation
        // to a mis-click, and neither of these is anybody's routine action.
        cleanup === null ? null : cleanup,
        status.el,
      ),
    ),
  );
}
