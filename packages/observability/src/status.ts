/**
 * `HealthReportDTO` → what a member is allowed to read.
 *
 * The health registry is an operator's instrument: it names components by their
 * internal names and carries whatever a failing probe threw, which for a
 * database is routinely a hostname, a schema name, or a credential error. All
 * of that is correct on the panel's Health page, behind Manage Server. None of
 * it should be one slash command away from every member of the guild.
 *
 * So this module curates, once, and returns a shape with nowhere for a detail to
 * live. Two properties matter more than the mapping itself:
 *
 *  - the rows are **fixed**. The same three lines appear whether they are up or
 *    down, because a card that only lists what is broken cannot be read as
 *    "everything else is fine" — it reads as "nothing else is checked";
 *  - a component we do not name still counts. `otherUnhealthy` is how a member
 *    learns that their slow command has a known cause without learning what we
 *    run. Dropping unnamed components entirely would let `/health` report all
 *    clear during a database outage, which is the one failure this card exists
 *    to prevent.
 */
import type { HealthReportDTO, PlatformStatusDTO, StatusLineDTO } from "@sbr/shared-types";

/**
 * The member-facing rows, in reading order, mapped from registry names.
 *
 * Ordered by what a member can act on: guild chat first, because that is the
 * surface they are usually standing in when they run `/health`; then the bot
 * they just typed at; then Hypixel, which is the one row where the answer is
 * routinely "not us".
 */
export const MEMBER_STATUS_ROWS: readonly { readonly component: string; readonly label: string }[] = [
  { component: "bridge", label: "Guild chat" },
  { component: "discord", label: "Bot" },
  { component: "hypixel", label: "Hypixel API" },
];

/**
 * A row nobody registered a probe for reads as `down`, not as missing.
 *
 * A deployment with no Mineflayer session has no guild chat, and saying so is
 * more useful than omitting the line and leaving a member to guess whether the
 * relay is broken or absent.
 */
function rowFor(report: HealthReportDTO, component: string, label: string): StatusLineDTO {
  const found = report.components.find((c) => c.name === component);
  return { label, status: found?.status ?? "down" };
}

export function curateStatus(report: HealthReportDTO): PlatformStatusDTO {
  const named = new Set(MEMBER_STATUS_ROWS.map((r) => r.component));
  return {
    // The rollup is the registry's, over *every* component — not a recount of
    // the three rows below. A member whose command is failing because Redis is
    // down must not be told the platform is healthy.
    overall: report.status,
    checkedAt: report.checkedAt,
    lines: MEMBER_STATUS_ROWS.map((r) => rowFor(report, r.component, r.label)),
    otherUnhealthy: report.components.filter((c) => !named.has(c.name) && c.status !== "ok").length,
  };
}
