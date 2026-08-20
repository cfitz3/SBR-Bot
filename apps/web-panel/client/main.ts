/**
 * Panel shell: chrome + hash router.
 *
 * Routing is hash-based so the server needs exactly one HTML route. History-API
 * routing would mean every deep link had to be rewritten server-side, which is a
 * second place for the route list to drift out of sync with this one.
 */
import type { GuildCard, SelectorVM } from "@sbr/panel-core";
import { loadPage } from "./api.js";
import { installCopy, nav as navCopy, shell, type PanelCopy } from "./copy.js";
import { frag, h, replace } from "./dom.js";
import { count } from "./format.js";
import { icon, initials, type IconName } from "./icons.js";
import { renderAnalytics } from "./pages/analytics.js";
import { renderEvents } from "./pages/events.js";
import { renderHealth } from "./pages/health.js";
import { renderMembers } from "./pages/members.js";
import { renderModeration } from "./pages/moderation.js";
import { renderOverview } from "./pages/overview.js";
import { renderPermissions } from "./pages/permissions.js";
import { renderSelector } from "./pages/selector.js";
import { renderSettings } from "./pages/settings.js";
import { renderMilestones } from "./pages/milestones.js";
import { renderRoles } from "./pages/roles.js";
import { renderTickets } from "./pages/tickets.js";

interface GuildRoute {
  readonly guildId: string;
  readonly page: string;
}

/**
 * Page order runs from watching to acting: what's happening, then the queues
 * that need a person, then the settings that change how the platform behaves.
 * The three groups are the headings the sidebar prints above each run.
 *
 * Ids and groups are keys, not words: the label each one prints comes from
 * `panel.nav` in the brand layer, so renaming a page in the sidebar never
 * touches this table, its routes or its bookmarks.
 */
type NavGroup = keyof PanelCopy["nav"]["group"];
type NavId = Exclude<keyof PanelCopy["nav"], "group">;

interface GuildPage {
  readonly id: NavId;
  readonly group: NavGroup;
  readonly icon: IconName;
  readonly render: (host: HTMLElement, guildId: string) => Promise<void> | void;
}

const GUILD_PAGES: readonly GuildPage[] = [
  { id: "overview", group: "monitor", icon: "overview", render: renderOverview },
  { id: "analytics", group: "monitor", icon: "analytics", render: renderAnalytics },
  { id: "health", group: "monitor", icon: "health", render: renderHealth },
  { id: "events", group: "monitor", icon: "events", render: renderEvents },
  { id: "moderation", group: "queues", icon: "moderation", render: renderModeration },
  { id: "members", group: "queues", icon: "members", render: renderMembers },
  { id: "tickets", group: "queues", icon: "tickets", render: renderTickets },
  { id: "settings", group: "configure", icon: "settings", render: renderSettings },
  { id: "milestones", group: "configure", icon: "milestones", render: renderMilestones },
  { id: "roles", group: "configure", icon: "roles", render: renderRoles },
  { id: "permissions", group: "configure", icon: "permissions", render: renderPermissions },
  // The filter has no entry of its own: it is a section of Moderation, next to
  // the automod rules that read the same wordlist. A stale `#/…/wordlist` link
  // falls through to the guild's front page like any other unknown id.
];

const NAV_GROUPS: readonly NavGroup[] = ["monitor", "queues", "configure"];

const viewEl = document.getElementById("view");
const navEl = document.getElementById("nav");
if (!viewEl || !navEl) throw new Error("panel shell is missing its mount points");
const view: HTMLElement = viewEl;
const nav: HTMLElement = navEl;

/** Guild cards come from the selector; cached so page switches don't refetch. */
let guildCards: ReadonlyMap<string, GuildCard> | null = null;

function parseRoute(hash: string): GuildRoute | null {
  const match = /^#\/g\/([^/]+)\/([a-z-]+)$/.exec(hash);
  if (!match) return null;
  return { guildId: decodeURIComponent(match[1]!), page: match[2]! };
}

async function guildCard(guildId: string): Promise<GuildCard | null> {
  if (!guildCards) {
    const result = await loadPage<SelectorVM>("/api/guilds");
    if (result.kind !== "ok") return null;
    guildCards = new Map(result.data.guilds.map((g) => [g.id, g]));
  }
  return guildCards.get(guildId) ?? null;
}

/**
 * The guild switcher: which guild you are looking at, and the way back to the
 * list. It is a link rather than a dropdown because the guild list is already a
 * page — a second copy of it in a menu is a second thing to keep in sync.
 */
function guildSwitch(name: string, note: string | null): HTMLElement {
  return h(
    "a",
    { class: "guild-switch", href: "#/", title: shell().switchGuild },
    h("span", { class: "guild-switch-avatar", "aria-hidden": "true" }, initials(name)),
    h(
      "span",
      { class: "guild-switch-text" },
      h("span", { class: "guild-switch-name" }, name),
      note ? h("span", { class: "guild-switch-role" }, note) : null,
    ),
    icon("caret", "nav-icon guild-switch-caret"),
  );
}

function navLink(route: GuildRoute, page: GuildPage): HTMLElement {
  const active = page.id === route.page;
  return h(
    "a",
    {
      class: active ? "nav-link nav-link-active" : "nav-link",
      href: `#/g/${encodeURIComponent(route.guildId)}/${page.id}`,
      "aria-current": active ? "page" : false,
    },
    icon(page.icon, "nav-icon"),
    navCopy()[page.id],
  );
}

function renderNav(route: GuildRoute | null, card: GuildCard | null): void {
  if (!route) {
    replace(nav, h("span", { class: "nav-title" }, shell().guildsTitle));
    return;
  }
  // A missing card means the selector call failed or the id isn't one of yours;
  // the page itself will say so, so the switcher just drops the member count
  // rather than inventing a number.
  const name = card?.name ?? shell().unknownGuild;
  const note =
    card === null
      ? null
      : card.memberCount === 1
        ? shell().memberOne
        : shell().memberMany.replace("{count}", count(card.memberCount));
  replace(
    nav,
    frag([
      guildSwitch(name, note),
      h(
        "nav",
        { class: "nav", "aria-label": shell().navLabel },
        ...NAV_GROUPS.map((group) =>
          h(
            "div",
            { class: "nav-group" },
            h("span", { class: "nav-group-label" }, navCopy().group[group]),
            ...GUILD_PAGES.filter((page) => page.group === group).map((page) => navLink(route, page)),
          ),
        ),
      ),
      h("a", { class: "nav-back", href: "#/" }, icon("back", "nav-icon"), shell().allGuilds),
    ]),
  );
}

async function render(): Promise<void> {
  const route = parseRoute(location.hash);

  if (!route) {
    renderNav(null, null);
    document.title = shell().title;
    await renderSelector(view);
    return;
  }

  const page = GUILD_PAGES.find((p) => p.id === route.page);
  if (!page) {
    // An unknown page id is a stale bookmark, not an error worth a screen of its
    // own — send it to the guild's front page.
    location.hash = `#/g/${encodeURIComponent(route.guildId)}/overview`;
    return;
  }

  const card = await guildCard(route.guildId);
  renderNav(route, card);
  const label = navCopy()[page.id];
  document.title = card ? `${card.name} — ${label}` : `${shell().title} — ${label}`;
  await page.render(view, route.guildId);
}

/**
 * Boot: fetch the panel's own words, then render.
 *
 * One blocking request before the first paint, because every screen — including
 * the error screens — is written in copy that lives on the server. The failure
 * branch is the one place in the client with an English literal: there is no
 * copy to say it with.
 */
async function boot(): Promise<void> {
  const result = await loadCopy();
  if (!result) {
    replace(
      view,
      h(
        "div",
        { class: "state state-error", role: "alert" },
        "The panel couldn't load its own text. Reload, or check the server logs.",
      ),
    );
    return;
  }
  installCopy(result);
  window.addEventListener("hashchange", () => void render());
  await render();
}

async function loadCopy(): Promise<Parameters<typeof installCopy>[0] | null> {
  try {
    const res = await fetch("/api/copy", { headers: { accept: "application/json" }, credentials: "same-origin" });
    if (!res.ok) return null;
    return (await res.json()) as Parameters<typeof installCopy>[0];
  } catch {
    return null;
  }
}

void boot();
