/**
 * A `TicketPanel` row → the message that gets posted.
 *
 * The one judgement call here is buttons versus a select menu. Discord allows
 * five buttons per row and 25 options per menu, so the reference implementation
 * uses buttons for 1–5 categories and a menu for 2–25. We follow that, and we
 * **refuse** rather than truncate past the caps: silently dropping the sixth
 * category means an admin configures a category members can never reach and
 * gets no indication why.
 */
import type {
  ActionRowView,
  ButtonView,
  EmbedView,
  SelectOptionView,
  TicketCategoryDTO,
  TicketPanelDTO,
} from "@sbr/shared-types";
import { CATEGORY_LIMITS, categoryByKey } from "./categories.js";

/** Namespace for every ticket component id. Mirrors `customId()`'s format. */
export const TICKET_NAMESPACE = "tkt";

export type PanelProblem =
  | "NO_CATEGORIES"
  | "TOO_MANY_BUTTONS"
  | "TOO_MANY_OPTIONS"
  | "UNKNOWN_CATEGORY";

export interface RenderedPanel {
  readonly embed: EmbedView;
  readonly components: readonly ActionRowView[];
}

export type PanelResult =
  | { readonly ok: true; readonly value: RenderedPanel }
  | { readonly ok: false; readonly problem: PanelProblem; readonly detail: string };

/**
 * The categories a panel points at, in the panel's own order.
 *
 * Order comes from `categoryKeys` rather than from `position`: a panel is a
 * curated list, and an admin who dragged "Appeal" to the top of *this* panel
 * did not mean to reorder every other panel too.
 */
export function panelCategories(
  panel: TicketPanelDTO,
  categories: readonly TicketCategoryDTO[],
): { readonly resolved: readonly TicketCategoryDTO[]; readonly missing: readonly string[] } {
  const resolved: TicketCategoryDTO[] = [];
  const missing: string[] = [];
  for (const key of panel.categoryKeys) {
    const found = categoryByKey(categories, key);
    if (found === null) missing.push(key);
    else if (found.enabled) resolved.push(found);
  }
  return { resolved, missing };
}

/** The id a panel control carries: `tkt:new:<categoryKey>` for a button. */
export function newTicketId(categoryKey: string): string {
  return `${TICKET_NAMESPACE}:new:${categoryKey}`;
}

/** The menu's own id. The chosen category arrives in `interaction.values`. */
export function panelSelectId(panelId: string): string {
  return `${TICKET_NAMESPACE}:pick:${panelId}`;
}

function toButton(category: TicketCategoryDTO, only: boolean): ButtonView {
  const button: {
    label: string;
    style: ButtonView["style"];
    customId: string;
    emoji?: string;
  } = {
    // With a single category the button says what it does rather than naming a
    // category the member never had to choose between.
    label: only ? "Create a ticket" : category.name,
    style: "PRIMARY",
    customId: newTicketId(category.key),
  };
  if (category.emoji !== null) button.emoji = category.emoji;
  return button;
}

function toOption(category: TicketCategoryDTO): SelectOptionView {
  const option: {
    label: string;
    value: string;
    description?: string;
    emoji?: string;
  } = { label: category.name, value: category.key };
  // Discord truncates past 100 characters; the editor already refuses longer,
  // so anything arriving here over the cap is legacy data, and clipping it is
  // better than having Discord reject the whole message.
  const description = category.description.trim();
  if (description !== "") option.description = description.slice(0, CATEGORY_LIMITS.description);
  if (category.emoji !== null) option.emoji = category.emoji;
  return option;
}

export function renderPanel(
  panel: TicketPanelDTO,
  categories: readonly TicketCategoryDTO[],
): PanelResult {
  const { resolved, missing } = panelCategories(panel, categories);
  if (missing.length > 0) {
    return {
      ok: false,
      problem: "UNKNOWN_CATEGORY",
      detail: `this panel points at ${missing.length === 1 ? "a category" : "categories"} that no longer exist: ${missing.join(", ")}`,
    };
  }
  if (resolved.length === 0) {
    return {
      ok: false,
      problem: "NO_CATEGORIES",
      detail: "a panel needs at least one enabled category before it can be published",
    };
  }

  const embed: EmbedView = {
    title: panel.title,
    ...(panel.description === null ? {} : { description: panel.description }),
    ...(panel.thumbnail === null ? {} : { thumbnailUrl: panel.thumbnail }),
    color: "INFO",
  };

  if (panel.style === "BUTTONS") {
    if (resolved.length > CATEGORY_LIMITS.panelButtons) {
      return {
        ok: false,
        problem: "TOO_MANY_BUTTONS",
        detail: `a button panel holds at most ${CATEGORY_LIMITS.panelButtons} categories; this one has ${resolved.length}. Switch it to a menu.`,
      };
    }
    const only = resolved.length === 1;
    return {
      ok: true,
      value: { embed, components: [{ buttons: resolved.map((c) => toButton(c, only)) }] },
    };
  }

  if (resolved.length > CATEGORY_LIMITS.panelOptions) {
    return {
      ok: false,
      problem: "TOO_MANY_OPTIONS",
      detail: `a menu holds at most ${CATEGORY_LIMITS.panelOptions} categories; this one has ${resolved.length}.`,
    };
  }
  return {
    ok: true,
    value: {
      embed,
      components: [
        {
          buttons: [],
          select: {
            customId: panelSelectId(panel.id),
            placeholder: "Pick a category",
            options: resolved.map(toOption),
            minValues: 1,
            maxValues: 1,
          },
        },
      ],
    },
  };
}

/** The style a panel with this many categories can actually use. */
export function suggestedStyle(categoryCount: number): TicketPanelDTO["style"] {
  return categoryCount <= CATEGORY_LIMITS.panelButtons ? "BUTTONS" : "SELECT";
}

/** The controls inside an open ticket channel: claim, close, close request. */
export function ticketControls(options: {
  readonly claimable: boolean;
  readonly claimed: boolean;
  readonly closeButton: boolean;
  readonly isStaff: boolean;
}): readonly ActionRowView[] {
  const buttons: ButtonView[] = [];
  if (options.claimable && options.isStaff) {
    buttons.push(
      options.claimed
        ? { label: "Release", style: "SECONDARY", customId: `${TICKET_NAMESPACE}:release` }
        : { label: "Claim", style: "SUCCESS", customId: `${TICKET_NAMESPACE}:claim` },
    );
  }
  if (options.closeButton) {
    // Staff close outright; the opener asks. Same button, different id, so the
    // permission decision is made once here rather than inside the handler.
    buttons.push(
      options.isStaff
        ? { label: "Close", style: "DANGER", customId: `${TICKET_NAMESPACE}:close` }
        : { label: "Request close", style: "SECONDARY", customId: `${TICKET_NAMESPACE}:closereq` },
    );
  }
  return buttons.length === 0 ? [] : [{ buttons }];
}
