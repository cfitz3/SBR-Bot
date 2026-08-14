/**
 * Guild selector — the one page with no guild in scope (WEB_PANEL.md §3.2).
 * Lists what the signed-in user can actually manage; an empty list is a real
 * answer, not an error.
 */
import type { SelectorVM } from "@sbr/panel-core";
import { loadPage } from "../api.js";
import { badge, deniedState, emptyState, errorState, pageTitle, person, spinner } from "../components.js";
import { scope, shell } from "../copy.js";
import { h, replace } from "../dom.js";
import { count } from "../format.js";

const t = scope("selector");

export async function renderSelector(host: HTMLElement): Promise<void> {
  replace(host, spinner("selector"));

  const result = await loadPage<SelectorVM>("/api/guilds");
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderSelector(host)));
  }

  const guilds = result.data.guilds;
  const body =
    guilds.length === 0
      ? emptyState("selectorGuilds")
      : h("div", { class: "guild-grid" }, ...guilds.map(guildCard));

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(shell().guildsTitle, guilds.length === 1 ? t("guildOne") : t("guildMany").replace("{count}", String(guilds.length))),
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
    person(
      guild.name,
      guild.memberCount === 1 ? shell().memberOne : shell().memberMany.replace("{count}", count(guild.memberCount)),
    ),
    // Whether a Hypixel guild is attached decides how much of the panel has data
    // in it, so it belongs on the card rather than three clicks in.
    guild.hypixelGuildId ? badge(t("hypixelLinked"), "ok") : badge(t("noHypixelGuild"), "warn"),
  );
}
