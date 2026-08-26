import type { EventsVM, PageResult } from "@sbr/panel-core";
import type { EmbedView } from "@sbr/shared-types";
export interface BoardPreviewVM {
    /** Null when no event is open, or the open one has been purged. */
    readonly embed: EmbedView | null;
}
/**
 * Re-shape an events read into the board's own view and render it.
 *
 * `updatedAt` is now rather than the stored `boardUpdatedAt`: this is what the
 * board would say if it were drawn at this moment, which is the question a
 * preview is asked. Using the stored stamp would show a "last updated" line
 * from the previous redraw beside standings from this one.
 */
export declare function boardPreview(result: PageResult<EventsVM>, now?: Date): PageResult<BoardPreviewVM>;
//# sourceMappingURL=event-board-preview.d.ts.map