/**
 * `/networth` — the overview, and the drill-down behind it.
 *
 * The old card showed six categories as inline fields, each field *named*
 * `Storage — 62%`, with the category total and its two or three top items
 * crammed into the value. Three problems, all of them the same problem: a
 * breakdown is a list, and this was not rendering it as one.
 *
 * A percentage in a field name is data in a label. Discord renders a field name
 * in bold with no room around it, so the share sat glued to the category with
 * nothing for the eye to line up against — the one comparison the whole card
 * exists to support was the hardest thing on it to make. Six was also a cap
 * chosen to fit two rows of three, which means an account whose seventh
 * category held a billion coins was shown a breakdown that did not add up to
 * its own headline, and was told nothing about it.
 *
 * So: one vertical list, every category, ordered by value. The itemisation that
 * used to be squeezed under each column moves behind a dropdown, which is where
 * a list of items belongs — one category at a time, with room to name what is
 * actually in it.
 *
 * The dropdown is stateless like every other persistent control here. Its
 * customId carries the uuid and the profile, the chosen category is the
 * option's own value, and the reply is a fresh read — so a card scrolled back
 * to next week still opens, and opens on today's numbers rather than on a
 * snapshot of the ones it was posted with.
 */
import { copy } from "@sbr/brand";
import { card, field, player } from "@sbr/embed-kit";
import type {
  ActionRowView,
  EmbedView,
  HypixelResult,
  NetworthDTO,
  NetworthItemDTO,
} from "@sbr/shared-types";
import { staleness } from "@sbr/shared-types";
import { formatCoins, renderFailure } from "./render.js";

const C = copy.embed.card;
const F = copy.embed.field;

/** The router namespace the dropdown dispatches on. */
export const NETWORTH_NAMESPACE = "nw";

/**
 * Discord's own cap on a select menu. Not a taste constant — an account with
 * more than twenty-five value-bearing categories does not exist, and if one
 * ever does, the overview above the menu still lists every one of them.
 */
const MAX_MENU_OPTIONS = 25;

/** Items listed in a category card. Past ten the tail is worth nothing. */
const MAX_ITEMS = 10;

/** `personal_vault` / `personalBank` → "Personal Vault" / "Personal Bank". */
export function categoryLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** Categories worth showing, richest first. Zero is not a category. */
function ranked(data: NetworthDTO): readonly (readonly [string, number])[] {
  return Object.entries(data.breakdown)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((a, b) => b[1] - a[1]);
}

/** `62%`, or nothing at all when there is no total to be a share of. */
function share(value: number, total: number | null): string | null {
  if (total === null || total <= 0) return null;
  return `${String(Math.round((value / total) * 100))}%`;
}

/**
 * The breakdown as one column.
 *
 * Value then share, both on the same line as the category, because the question
 * is "where is it" and the answer should read straight down. The share is
 * parenthesised rather than dash-separated: it qualifies the number beside it
 * rather than being a third fact of equal weight.
 */
function breakdownLines(data: NetworthDTO): string {
  const rows = ranked(data);
  if (rows.length === 0) return C.networthNoCategories;
  return rows
    .map(([key, value]) => {
      const pct = share(value, data.total);
      return `**${categoryLabel(key)}** ${formatCoins(value)}${pct === null ? "" : ` (${pct})`}`;
    })
    .join("\n");
}

/**
 * The overview card.
 *
 * `uuid` is optional for the same reason it is on the member card: a card
 * without a face is still worth sending, and the caller that has one — every
 * caller that resolved a target to get here — is not the only one that may ever
 * build this.
 */
export function renderNetworthEmbed(
  ign: string,
  result: HypixelResult<NetworthDTO>,
  uuid?: string | null,
): EmbedView {
  if (!result.ok) {
    return card({
      title: C.networth,
      subject: player(ign, uuid ?? null),
      headline: renderFailure(result.error.state),
      tone: result.error.state === "RATE_LIMITED" ? "WARNING" : "NEUTRAL",
    });
  }

  const { data } = result.value;
  const hidden = data.missing.length === 0 ? null : data.missing.join(", ");

  return card({
    title: C.networth,
    subject: player(ign, uuid ?? null),
    headline:
      data.total === null
        ? C.networthHidden
        : `**${formatCoins(data.total)}**${data.exact ? "" : C.networthEstimate}`,
    fields: [
      field(F.breakdown, breakdownLines(data)),
      // Named on the card rather than folded into the footer caveat: a member
      // reading "8.24b, estimate" wants to know which sections are missing from
      // it, and that is a fact about the profile, not about our cache.
      hidden === null ? null : field(F.notCounted, hidden),
    ],
    freshness: staleness(result.value),
    tone: data.exact ? "SUCCESS" : "INFO",
  });
}

/**
 * The dropdown under the overview, or nothing.
 *
 * Nothing when there is nothing to open — a valuation engine that reports
 * totals only leaves `topItems` empty, and a menu that opens onto "no items"
 * for every category is a control that teaches people not to press controls.
 * Categories with no items are left out of the menu individually for the same
 * reason, while staying on the overview above it, which is the honest split:
 * the money is there, we just cannot itemise it.
 */
export function networthComponents(
  data: NetworthDTO,
  target: { readonly uuid: string; readonly ign: string },
  profileId?: string,
): readonly ActionRowView[] {
  const options = ranked(data)
    .filter(([key]) => (data.topItems[key] ?? []).length > 0)
    .slice(0, MAX_MENU_OPTIONS)
    .map(([key, value]) => {
      const pct = share(value, data.total);
      return {
        label: categoryLabel(key),
        value: key,
        // The description is where the numbers go, so the label stays a label.
        description: `${formatCoins(value)}${pct === null ? "" : ` · ${pct}`}`,
      };
    });

  if (options.length === 0) return [];

  const profile = profileId !== undefined && !profileId.includes(":") ? profileId : "";

  return [
    {
      buttons: [],
      select: {
        // Built here rather than through `discord-kit`'s `customId()` — this
        // package is offline domain code and does not depend on the transport.
        // The router splits on the same separator either way.
        //
        // The IGN rides along because it is a *label*, not a key: the drill-down
        // needs a name for its author row, and `PlayerLookup` only resolves in
        // the other direction. Widening a port so a card can print a name it was
        // already given is the wrong trade. A profile name containing the
        // separator is dropped rather than producing an unroutable menu — cute
        // names do not contain colons, but a card that silently stops working
        // would be worse than one that ignores an odd profile argument.
        customId: [NETWORTH_NAMESPACE, target.uuid, target.ign, profile].join(":"),
        placeholder: C.networthPick,
        options,
      },
    },
  ];
}

/**
 * One category, itemised.
 *
 * The share is repeated here on purpose. A drill-down opened from a menu is
 * read on its own — it arrives as its own message — and "1.1b" means nothing
 * without the account it is a fifth of.
 */
export function renderNetworthCategoryEmbed(
  ign: string,
  result: HypixelResult<NetworthDTO>,
  category: string,
  uuid?: string | null,
): EmbedView {
  if (!result.ok) {
    return card({
      title: C.networth,
      subject: player(ign, uuid ?? null),
      headline: renderFailure(result.error.state),
      tone: result.error.state === "RATE_LIMITED" ? "WARNING" : "NEUTRAL",
    });
  }

  const { data } = result.value;
  const value = data.breakdown[category];
  const title = `${C.networth} · ${categoryLabel(category)}`;

  if (value === undefined) {
    // The profile moved on: a category that paid last week can be gone today,
    // and the menu that opened this was rendered against the older read.
    return card({
      title,
      subject: player(ign, uuid ?? null),
      headline: C.networthCategoryGone,
      tone: "NEUTRAL",
    });
  }

  const items = (data.topItems[category] ?? []).slice(0, MAX_ITEMS);
  const pct = share(value, data.total);

  return card({
    title,
    subject: player(ign, uuid ?? null),
    headline: `**${formatCoins(value)}**${pct === null ? "" : ` — ${pct} ${C.networthOfTotal}`}`,
    fields: [field(F.mostValuable, items.length === 0 ? C.networthNoItems : itemLines(items, value))],
    freshness: staleness(result.value),
    tone: "INFO",
  });
}

/**
 * Items as a numbered column, each with its share *of the category*.
 *
 * Of the category rather than of the account: the reader has already been told
 * what the category is worth, and inside a drill-down the useful comparison is
 * "is this one sword most of my storage", not "is it most of my net worth".
 */
function itemLines(items: readonly NetworthItemDTO[], categoryTotal: number): string {
  return items
    .map((item, i) => {
      const pct = share(item.price, categoryTotal);
      return `**${String(i + 1)}.** ${item.name} — ${formatCoins(item.price)}${pct === null ? "" : ` (${pct})`}`;
    })
    .join("\n");
}
