/**
 * Guild selector — the one page with no guild in scope (WEB_PANEL.md §3.2).
 * Lists what the signed-in user can actually manage; an empty list is a real
 * answer, not an error.
 */
import type { SelectorVM } from "@sbr/panel-core";
import { loadPage } from "../api.js";
import { badge, deniedState, emptyState, errorState, pageTitle, person, spinner } from "../components.js";
import { h, replace } from "../dom.js";
import { count } from "../format.js";

export async function renderSelector(host: HTMLElement): Promise<void> {
  replace(host, spinner("Loading your guilds…"));

  const result = await loadPage<SelectorVM>("/api/guilds");
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderSelector(host)));
  }

  const guilds = result.data.guilds;
  const body =
    guilds.length === 0
      ? emptyState(
          "No guilds to show. You need Manage Server on a Discord guild that the platform has been set up for.",
        )
      : h("div", { class: "guild-grid" }, ...guilds.map(guildCard));

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Your guilds", guilds.length === 1 ? "1 guild" : `${guilds.length} guilds`),
      body,
    ),
  );
}

function guildCard(guild: SelectorVM["guilds"][number]): HTMLElement {
  return h(
    "a",
    { class: "guild-card", href: `#/g/${encodeURIComponent(guild.id)}/overview` },
    // Same initials mark the sidebar's guild switcher uses, so the card you
    // clicked and the guild you land in are recognisably the same thing.
    person(guild.name, `${count(guild.memberCount)} members`),
    // Whether a Hypixel guild is attached decides how much of the panel has data
    // in it, so it belongs on the card rather than three clicks in.
    guild.hypixelGuildId ? badge("Hypixel linked", "ok") : badge("No Hypixel guild", "warn"),
  );
}
