/**
 * What the Discord board will say, rendered by the thing that says it.
 *
 * The panel's own scoreboard card answers "who is winning". This answers a
 * different question — "what will people see" — and the only honest way to
 * answer it is to call the bridge's renderer rather than to describe it. A
 * preview assembled from panel copy would drift the first time a guild
 * overrode an embed string, and a preview that lies is worse than none: the
 * whole reason to look at one is to catch a mistake before four hundred people
 * read it.
 *
 * It lives in the app rather than in `@sbr/panel-core` on purpose. The core is
 * shared with callers that have no business depending on a Discord command
 * layer; this composition root already depends on both, so the edge stops here.
 *
 * The mapping is straight out of the events read — the same rows the page is
 * already showing — so the preview costs one extra query of nothing at all and
 * cannot disagree with the numbers beside it.
 */
import { renderEventBoardEmbed } from "@sbr/commands-bridge";
/**
 * Re-shape an events read into the board's own view and render it.
 *
 * `updatedAt` is now rather than the stored `boardUpdatedAt`: this is what the
 * board would say if it were drawn at this moment, which is the question a
 * preview is asked. Using the stored stamp would show a "last updated" line
 * from the previous redraw beside standings from this one.
 */
export function boardPreview(result, now = new Date()) {
    // Narrowed on `data` rather than on `access.allowed`: the two are the same
    // condition, but only this one tells the compiler the rows are there.
    if (result.data === null)
        return { access: result.access, data: null };
    const vm = result.data;
    const event = vm.events.find((candidate) => candidate.id === vm.selected) ?? null;
    if (event === null)
        return { access: result.access, data: { embed: null } };
    const view = {
        eventId: event.id,
        title: event.title,
        status: boardStatus(event.status),
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        // The page reads standings in the event's own metric order, which is the
        // order the board draws them in, so no re-sorting happens here.
        metrics: vm.standings.map((block) => ({
            metric: block.metric,
            standings: block.entries.map((entry) => ({ discordId: entry.discordId, delta: entry.delta })),
        })),
        participantCount: event.going,
        unlinked: vm.unlinked.map((entry) => ({ discordId: entry.discordId })),
        prize: event.prize,
        updatedAt: now.toISOString(),
    };
    return { access: result.access, data: { embed: renderEventBoardEmbed(view) } };
}
/**
 * The four statuses the board knows.
 *
 * Anything else is treated as scheduled rather than rejected: a status added
 * upstream should cost a slightly wrong preview, never a failed page.
 */
function boardStatus(status) {
    switch (status) {
        case "LIVE":
        case "COMPLETED":
        case "CANCELLED":
            return status;
        default:
            return "SCHEDULED";
    }
}
