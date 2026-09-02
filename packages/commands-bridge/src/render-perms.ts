/**
 * View models for perms — standing parties and their rosters (COMMANDS.md §9).
 *
 * Kept apart from `render-community.ts` because a perm is not an envelope and
 * not a run: it is a roster of *IGNs* first and Discord accounts second, so the
 * rendering rules are different everywhere they touch identity. A seat with no
 * linked account still has to read as a person, which is why nothing here falls
 * back to a bare snowflake.
 */
import type { EmbedFieldView, EmbedView, PermGroupDTO, PermMemberDTO } from "@sbr/shared-types";

/**
 * `catacombs 42 · sa 51.3` when we have a snapshot, nothing when we don't.
 *
 * A missing snapshot is the normal case for an unlinked player, so it prints as
 * absence rather than "unknown" — a roster peppered with "unknown" reads like
 * something is broken when in fact nothing is.
 */
function progressLabel(member: PermMemberDTO): string {
  const bits: string[] = [];
  if (member.catacombsLevel !== null) bits.push(`cata ${member.catacombsLevel}`);
  if (member.skillAverage !== null) bits.push(`sa ${member.skillAverage.toFixed(1)}`);
  return bits.join(" · ");
}

/**
 * `inGuild` is deliberately three-valued. `false` means the member cache was
 * populated and this IGN was not in it — they left. `null` means the cache is
 * cold or unreachable, and saying "left the guild" on that basis would be a
 * false accusation, so it prints nothing at all.
 */
function seatLine(member: PermMemberDTO): string {
  const who = member.discordId === null ? member.ign : `${member.ign} (<@${member.discordId}>)`;
  const notes = [progressLabel(member), member.inGuild === false ? "left the guild" : ""].filter((s) => s !== "");
  return notes.length === 0 ? who : `${who} — ${notes.join(" · ")}`;
}

export function renderPermEmbed(perm: PermGroupDTO): EmbedView {
  const fields: EmbedFieldView[] =
    perm.members.length === 0
      ? [{ name: "Roster", value: "Nobody yet — add people with `/perm roster add`.", inline: false }]
      : perm.members.map((m) => ({ name: m.role, value: seatLine(m), inline: false }));

  const flags = [
    perm.status === "DISBANDED" ? "disbanded" : `${perm.members.length}/${perm.capacity}`,
    perm.isDefault ? "default" : "",
  ].filter((s) => s !== "");

  const embed: EmbedView = {
    title: `${perm.name} — ${perm.activity.toLowerCase()}`,
    fields: [{ name: "Owner", value: `<@${perm.ownerDiscordId}>`, inline: true }, ...fields],
    footer: `${flags.join(" · ")} · id ${perm.id}`,
    color: perm.status === "DISBANDED" ? "NEUTRAL" : "INFO",
  };
  return perm.notes === null ? embed : { ...embed, description: perm.notes };
}

export function renderPermListEmbed(perms: readonly PermGroupDTO[], mine: boolean): EmbedView {
  const title = mine ? "Your perms" : "Guild perms";
  if (perms.length === 0) {
    return { title, description: "None yet. Start one with `/perm create`.", color: "NEUTRAL" };
  }
  return {
    title,
    fields: perms.slice(0, 10).map((p) => ({
      name: `${p.name}${p.isDefault ? " ★" : ""} — ${p.activity.toLowerCase()}`,
      value: `<@${p.ownerDiscordId}> · ${p.members.length}/${p.capacity} · \`${p.id}\``,
      inline: false,
    })),
    footer: "Open one with /perm info perm:<name>. ★ is your LFG autofill.",
    color: "INFO",
  };
}

/** One line, for guild chat — no embeds in-game, and 256 chars to say it in. */
export function permChatLine(perm: PermGroupDTO): string {
  const roster = perm.members.map((m) => `${m.ign}(${m.role})`).join(" ");
  return `${perm.name} [${perm.members.length}/${perm.capacity}] ${roster}`.trim();
}
