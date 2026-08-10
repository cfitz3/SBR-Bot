/**
 * Panel shell: chrome + hash router.
 *
 * Routing is hash-based so the server needs exactly one HTML route. History-API
 * routing would mean every deep link had to be rewritten server-side, which is a
 * second place for the route list to drift out of sync with this one.
 */
import type { SelectorVM } from "@sbr/panel-core";
import { loadPage } from "./api.js";
import { h, replace } from "./dom.js";
import { renderAnalytics } from "./pages/analytics.js";
import { renderEvents } from "./pages/events.js";
import { renderHealth } from "./pages/health.js";
import { renderMapping } from "./pages/mapping.js";
import { renderMembers } from "./pages/members.js";
import { renderModeration } from "./pages/moderation.js";
import { renderOverview } from "./pages/overview.js";
import { renderRecruitment } from "./pages/recruitment.js";
import { renderSelector } from "./pages/selector.js";
import { renderSettings } from "./pages/settings.js";
import { renderXp } from "./pages/xp.js";
import { renderMilestones } from "./pages/milestones.js";

interface GuildRoute {
  readonly guildId: string;
  readonly page: string;
}

/**
 * Tab order runs from watching to acting: what's happening, then the queues
 * that need a person, then the settings that change how the platform behaves.
 */
const GUILD_PAGES = [
  { id: "overview", label: "Overview", render: renderOverview },
  { id: "analytics", label: "Analytics", render: renderAnalytics },
  { id: "health", label: "Health", render: renderHealth },
  { id: "recruitment", label: "Recruitment", render: renderRecruitment },
  { id: "events", label: "Events", render: renderEvents },
  { id: "moderation", label: "Moderation", render: renderModeration },
  { id: "members", label: "Members", render: renderMembers },
  { id: "settings", label: "Settings", render: renderSettings },
  { id: "mapping", label: "Mapping", render: renderMapping },
  { id: "xp", label: "XP", render: renderXp },
  { id: "milestones", label: "Milestones", render: renderMilestones },
] as const;

const viewEl = document.getElementById("view");
const navEl = document.getElementById("nav");
if (!viewEl || !navEl) throw new Error("panel shell is missing its mount points");
const view: HTMLElement = viewEl;
const nav: HTMLElement = navEl;

/** Guild names come from the selector; cached so tab switches don't refetch. */
let guildNames: ReadonlyMap<string, string> | null = null;

function parseRoute(hash: string): GuildRoute | null {
  const match = /^#\/g\/([^/]+)\/([a-z-]+)$/.exec(hash);
  if (!match) return null;
  return { guildId: decodeURIComponent(match[1]!), page: match[2]! };
}

async function guildName(guildId: string): Promise<string | null> {
  if (!guildNames) {
    const result = await loadPage<SelectorVM>("/api/guilds");
    if (result.kind !== "ok") return null;
    guildNames = new Map(result.data.guilds.map((g) => [g.id, g.name]));
  }
  return guildNames.get(guildId) ?? null;
}

function renderNav(route: GuildRoute | null, name: string | null): void {
  if (!route) {
    replace(nav, h("span", { class: "nav-title" }, "SBR Panel"));
    return;
  }
  replace(
    nav,
    h(
      "div",
      { class: "nav-inner" },
      h("a", { class: "nav-back", href: "#/", title: "Back to guild list" }, "← Guilds"),
      h("span", { class: "nav-title" }, name ?? "Guild"),
      h(
        "nav",
        { class: "nav-tabs", "aria-label": "Guild pages" },
        ...GUILD_PAGES.map((page) =>
          h(
            "a",
            {
              class: page.id === route.page ? "tab tab-active" : "tab",
              href: `#/g/${encodeURIComponent(route.guildId)}/${page.id}`,
              "aria-current": page.id === route.page ? "page" : false,
            },
            page.label,
          ),
        ),
      ),
    ),
  );
}

async function render(): Promise<void> {
  const route = parseRoute(location.hash);

  if (!route) {
    renderNav(null, null);
    document.title = "SBR Panel";
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

  const name = await guildName(route.guildId);
  renderNav(route, name);
  document.title = name ? `${name} — ${page.label}` : `SBR Panel — ${page.label}`;
  await page.render(view, route.guildId);
}

window.addEventListener("hashchange", () => void render());
void render();
