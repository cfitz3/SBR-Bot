/**
 * View models for perms — standing parties and their rosters (COMMANDS.md §9).
 *
 * Kept apart from `render-community.ts` because a perm is not an envelope and
 * not a run: it is a roster of *IGNs* first and Discord accounts second, so the
 * rendering rules are different everywhere they touch identity. A seat with no
 * linked account still has to read as a person, which is why nothing here falls
 * back to a bare snowflake.
 *
 * The roster used to be one field per seat with the *role* as the field name,
 * which put data in a label, spent five of Discord's fields on five short lines,
 * and left the card no room for anything else. It is one field now, and the role
 * is bold inside the value where it can be read alongside the numbers it
 * qualifies.
 */
import { copy, theme } from "@sbr/brand";
import { card, field, marker, progressLine } from "@sbr/embed-kit";
import type { EmbedView, PermGroupDTO, PermMemberDTO } from "@sbr/shared-types";

const C = copy.embed.card;
const F = copy.embed.field;
const SEPARATOR = theme.embed.style.separator;

/** Perms per page of the list. Ten lines is a screen on a phone. */
const PAGE_SIZE = 10;

/**
 * How far a class level may trail a catacombs level before the seat is marked.
 *
 * Ten is chosen to catch the reading this card exists for — cata 45 sitting as a
 * healer at 17 — while leaving the ordinary spread alone: nobody levels five
 * classes evenly, and a marker on every seat marks nothing.
 */
const LAG = 10;

/** Whether this seat is played in a class the player has barely levelled. */
function lags(member: PermMemberDTO): boolean {
  return (
    member.roleLevel !== null &&
    member.catacombsLevel !== null &&
    member.catacombsLevel - member.roleLevel >= LAG
  );
}

/**
 * `cata 48 · healer 44` — what a seat is worth knowing about, in one line.
 *
 * A missing snapshot is the normal case for an unlinked player, so it prints as
 * absence rather than "unknown" — a roster peppered with "unknown" reads like
 * something is broken when in fact nothing is.
 */
function seatStats(member: PermMemberDTO): string[] {
  const bits: string[] = [];
  if (member.catacombsLevel !== null) bits.push(`cata ${member.catacombsLevel}`);
  if (member.roleLevel !== null) bits.push(`${member.role} ${member.roleLevel}`);
  else if (member.skillAverage !== null) bits.push(`sa ${member.skillAverage.toFixed(1)}`);
  return bits;
}

/**
 * One seat: role, who is in it, and how much dungeon they have run in it.
 *
 * `inGuild` is deliberately three-valued. `false` means the member cache was
 * populated and this IGN was not in it — they left. `null` means the cache is
 * cold or unreachable, and saying "left the guild" on that basis would be a
 * false accusation, so it prints nothing at all.
 */
function seatLine(member: PermMemberDTO): string {
  const who = member.discordId === null ? member.ign : `${member.ign} (<@${member.discordId}>)`;
  const notes = [
    ...seatStats(member),
    member.discordId === null ? C.permUnlinked : "",
    member.inGuild === false ? C.permLeftGuild : "",
  ].filter((s) => s !== "");
  const role = `**${titleCase(member.role)}**${marker(lags(member))}`;
  return notes.length === 0 ? `${role} ${who}` : `${role} ${who} — ${notes.join(SEPARATOR)}`;
}

/** Roles are stored lowercase because people type them; the card capitalises. */
function titleCase(role: string): string {
  return role.length === 0 ? role : role[0]!.toUpperCase() + role.slice(1);
}

export function renderPermCard(perm: PermGroupDTO): EmbedView {
  const disbanded = perm.status === "DISBANDED";
  const filled = perm.members.length;
  const roster = perm.members.map(seatLine).join("\n");

  const footers = [
    perm.isDefault ? C.permDefault : "",
    // Only when something is actually marked: a legend for a glyph that is not
    // on the card is noise the reader has to rule out.
    perm.members.some(lags) ? C.permLagFooter.replace("{marker}", theme.embed.glyphs.marker) : "",
  ].filter((s) => s !== "");

  return card({
    tone: disbanded ? "NEUTRAL" : "INFO",
    title: perm.name,
    headline: disbanded
      ? C.permDisbanded
      : C.permHeadline
          .replace("{activity}", copy.embed.activity[perm.activity])
          .replace("{filled}", String(filled))
          .replace("{capacity}", String(perm.capacity)),
    fields: [
      field(F.party, roster === "" ? C.permNoRoster : roster),
      field(F.seats, progressLine(filled / perm.capacity), true),
      field(F.owner, `<@${perm.ownerDiscordId}>`, true),
      field(F.notes, perm.notes ?? ""),
    ],
    ...(footers.length === 0 ? {} : { footer: footers.join(SEPARATOR) }),
    timestamp: perm.createdAt,
  });
}

/** One perm as a line in the list — never as a field of its own. */
function permLine(perm: PermGroupDTO): string {
  const tail = [
    `${perm.members.length}/${perm.capacity}`,
    `<@${perm.ownerDiscordId}>`,
    perm.isDefault ? C.permDefaultTag : "",
    perm.status === "DISBANDED" ? C.permDisbandedTag : "",
  ].filter((s) => s !== "");
  return `**${perm.name}** — ${copy.embed.activity[perm.activity]}${SEPARATOR}${tail.join(SEPARATOR)}`;
}

/**
 * The guild's perms, ten to a page.
 *
 * Paged rather than truncated at ten as it was before: a guild with twelve
 * standing parties had two of them silently absent, and there was nothing on the
 * card to say so.
 */
export function renderPermListPages(perms: readonly PermGroupDTO[], mine: boolean): readonly EmbedView[] {
  const title = mine ? C.permListMineTitle : C.permListTitle;
  if (perms.length === 0) {
    return [card({ tone: "NEUTRAL", title, headline: C.permNone })];
  }

  const pages: PermGroupDTO[][] = [];
  for (let i = 0; i < perms.length; i += PAGE_SIZE) pages.push(perms.slice(i, i + PAGE_SIZE));

  return pages.map((page, i) =>
    card({
      tone: "INFO",
      title,
      fields: [field(F.perms, page.map(permLine).join("\n"))],
      ...(pages.length === 1
        ? {}
        : {
            footer: C.permListPage.replace("{n}", String(i + 1)).replace("{total}", String(pages.length)),
          }),
    }),
  );
}

/** One line, for guild chat — no embeds in-game, and 256 chars to say it in. */
export function permChatLine(perm: PermGroupDTO): string {
  const roster = perm.members.map((m) => `${m.ign}(${m.role})`).join(" ");
  return `${perm.name} [${perm.members.length}/${perm.capacity}] ${roster}`.trim();
}
