/**
 * Cards and controls for the staff utilities: notes, stickies, role menus and
 * the ticket queue.
 *
 * These four commands all had the same shape: `action:` as the first option,
 * choices in a dropdown, and the *arguments* that action needs typed alongside
 * it whether that action needs them or not. `/sticky action:clear message:...`
 * is a legal invocation that ignores half of what was typed; `/tickets
 * action:close` with no id answers with a usage string. The typist is being
 * asked to hold the command's state machine in their head and supply exactly
 * the branch's arguments, with no feedback until they get it wrong.
 *
 * So the state machine moves onto the card. Each of these commands now takes
 * only the nouns (which channel, which ticket, what to say), answers with what
 * exists, and puts the verbs on buttons underneath, where they are offered only
 * when they apply. `action` survives as an unpublished argument the component
 * router synthesises, which keeps the buttons on the ordinary dispatch path
 * (role floor, policy floor, handler) rather than opening a second route into a
 * privileged write.
 */
import type {
  ActionRowView,
  ButtonView,
  EmbedView,
  ModerationActionDTO,
  SelectOptionView,
  TicketDTO,
} from "@sbr/shared-types";
import { card, facts, field } from "@sbr/embed-kit";
import { relativeTs } from "./render.js";
import type { RoleMenuSummary, StickySummary } from "./types.js";

/** Discord's own limit on a select menu, and so on every list that feeds one. */
const MAX_OPTIONS = 25;

/** A menu label Discord will accept, with the overflow marked rather than cut silently. */
function clampLabel(text: string, max = 90): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The absent segment, so a missing id round-trips as null rather than as "-". */
function dash(segment: string | undefined): string | null {
  return segment === undefined || segment === "" || segment === "-"
    ? null
    : segment;
}

// --------------------------------- /note ---------------------------------

/**
 * `/note` - the note itself is the card.
 *
 * It was `/member-note`, a compound name for something staff say in one word,
 * and the confirmation was a line of text ending in a case id in parentheses.
 * The card puts the note in the headline, because the useful thing to see after
 * writing a note is the note, and carries the case's own `createdAt` as its
 * timestamp so the record is dated by when it was recorded rather than by when
 * the reply happened to render.
 */
export function renderNoteEmbed(action: ModerationActionDTO): EmbedView {
  return card({
    tone: "INFO",
    title: "Note recorded",
    headline: action.reason ?? "",
    fields: [
      field(
        "Where it lives",
        facts([
          {
            label: "Member",
            value: action.targetDiscordId
              ? `<@${action.targetDiscordId}>`
              : "an unlinked member",
          },
          { label: "By", value: `<@${action.actorDiscordId}>` },
          { label: "Case", value: action.caseCode },
        ]),
      ),
    ],
    footer: "Notes are staff-only and are never enforced.",
    timestamp: action.createdAt,
  });
}

// -------------------------------- /sticky --------------------------------

export const STICKY_NAMESPACE = "sticky";

export type StickyAction = "show" | "clear";
const STICKY_ACTIONS: readonly string[] = ["show", "clear"];

/** `sticky:<action>:<channelId|->` - a channel id is all a sticky is keyed by. */
export function stickyId(
  action: StickyAction,
  channelId: string | null,
): string {
  return [STICKY_NAMESPACE, action, channelId ?? "-"].join(":");
}

export function parseStickyId(
  segments: readonly string[],
): { readonly action: StickyAction; readonly channelId: string | null } | null {
  const [action, channelId] = segments;
  if (action === undefined || !STICKY_ACTIONS.includes(action)) return null;
  return { action: action as StickyAction, channelId: dash(channelId) };
}

export interface StickyPrompt {
  /** The channel in focus, or null for the whole-guild overview. */
  readonly channelId: string | null;
  readonly notice?: string;
  readonly now?: Date;
}

function focusSticky(
  stickies: readonly StickySummary[],
  channelId: string | null,
): StickySummary | null {
  if (channelId === null) return null;
  return stickies.find((s) => s.channelId === channelId) ?? null;
}

/**
 * The sticky card: one channel's message, or every channel that has one.
 *
 * The overview consolidates into a single field rather than one field per
 * channel. A field per sticky puts the channel name in bold over the message,
 * which reads as a heading above a paragraph - a shape suggesting the message is
 * a section of a document rather than a line the bot repeats.
 */
export function renderStickyEmbed(
  stickies: readonly StickySummary[],
  prompt: StickyPrompt,
): EmbedView {
  const focused = focusSticky(stickies, prompt.channelId);
  const now = (prompt.now ?? new Date()).toISOString();

  if (focused) {
    return card({
      tone: focused.enabled ? "SUCCESS" : "NEUTRAL",
      title: "Sticky message",
      headline:
        prompt.notice ?? `Repeated at the bottom of <#${focused.channelId}>.`,
      fields: [
        field("Message", focused.content.slice(0, 1000)),
        field(
          "State",
          facts([
            { label: "Posting", value: focused.enabled ? "yes" : "paused" },
          ]),
        ),
      ],
      timestamp: now,
    });
  }

  if (stickies.length === 0) {
    const where =
      prompt.channelId === null
        ? "No channel has one"
        : `<#${prompt.channelId}> has no sticky`;
    return card({
      tone: "NEUTRAL",
      title: "Sticky messages",
      headline:
        prompt.notice ??
        `${where}. Run the command again with a message to set one.`,
      timestamp: now,
    });
  }

  return card({
    tone: "INFO",
    title: "Sticky messages",
    headline:
      prompt.notice ??
      `${stickies.length} channel${stickies.length === 1 ? "" : "s"} repeat a message.`,
    fields: [
      field(
        "Where",
        stickies
          .slice(0, MAX_OPTIONS)
          .map(
            (s) =>
              `<#${s.channelId}>${s.enabled ? "" : " · paused"} — ${clampLabel(s.content, 60)}`,
          )
          .join("\n"),
      ),
    ],
    timestamp: now,
  });
}

/**
 * The controls under it.
 *
 * With a channel in focus the only verb is *Clear*, and it is offered only when
 * there is something to clear - the old command accepted `action:clear` against
 * a channel with no sticky and answered with a success message about removing
 * nothing. The overview carries the picker instead, so reaching one sticky never
 * requires retyping the channel.
 */
export function renderStickyControls(
  stickies: readonly StickySummary[],
  prompt: StickyPrompt,
): readonly ActionRowView[] {
  const focused = focusSticky(stickies, prompt.channelId);

  if (focused) {
    const buttons: ButtonView[] = [
      {
        label: "Clear it",
        style: "DANGER",
        customId: stickyId("clear", focused.channelId),
      },
    ];
    if (stickies.length > 1) {
      buttons.push({
        label: "Back to all",
        style: "SECONDARY",
        customId: stickyId("show", null),
      });
    }
    return [{ buttons }];
  }

  if (stickies.length === 0) return [];

  const options: SelectOptionView[] = stickies
    .slice(0, MAX_OPTIONS)
    .map((s) => ({
      label: clampLabel(s.content, 90),
      value: s.channelId,
      ...(s.enabled ? {} : { description: "paused" }),
    }));

  return [
    {
      buttons: [],
      select: {
        customId: stickyId("show", null),
        placeholder: "Open one of them",
        options,
      },
    },
  ];
}

// ------------------------------- /rolemenu -------------------------------

export const ROLEMENU_NAMESPACE = "rolemenu";

export type RoleMenuAction = "show" | "post";
const ROLEMENU_ACTIONS: readonly string[] = ["show", "post"];

/** `rolemenu:<action>:<menuId|->:<channelId|->`. */
export function roleMenuId(
  action: RoleMenuAction,
  menuId: string | null,
  channelId: string | null,
): string {
  return [ROLEMENU_NAMESPACE, action, menuId ?? "-", channelId ?? "-"].join(
    ":",
  );
}

export function parseRoleMenuId(segments: readonly string[]): {
  readonly action: RoleMenuAction;
  readonly menuId: string | null;
  readonly channelId: string | null;
} | null {
  const [action, menuId, channelId] = segments;
  if (action === undefined || !ROLEMENU_ACTIONS.includes(action)) return null;
  return {
    action: action as RoleMenuAction,
    menuId: dash(menuId),
    channelId: dash(channelId),
  };
}

export interface RoleMenuPrompt {
  readonly menuId: string | null;
  /** Where *Post it here* would put it: the channel the command was typed in. */
  readonly channelId: string | null;
  readonly notice?: string;
  readonly now?: Date;
}

function focusMenu(
  menus: readonly RoleMenuSummary[],
  menuId: string | null,
): RoleMenuSummary | null {
  if (menuId === null) return null;
  return menus.find((m) => m.id === menuId) ?? null;
}

export function renderRoleMenuEmbed(
  menus: readonly RoleMenuSummary[],
  prompt: RoleMenuPrompt,
): EmbedView {
  const focused = focusMenu(menus, prompt.menuId);
  const now = (prompt.now ?? new Date()).toISOString();

  if (focused) {
    return card({
      tone: "INFO",
      title: focused.title,
      headline:
        prompt.notice ?? "Built on the panel; the member-facing bot posts it.",
      fields: [
        field(
          "This menu",
          facts([
            { label: "Roles", value: focused.optionCount },
            {
              label: "Posted in",
              value:
                focused.channelId === null
                  ? "nowhere yet"
                  : `<#${focused.channelId}>`,
            },
            { label: "Id", value: focused.id },
          ]),
        ),
      ],
      timestamp: now,
    });
  }

  if (menus.length === 0) {
    return card({
      tone: "NEUTRAL",
      title: "Role menus",
      headline:
        prompt.notice ??
        "None built yet. Build one on the panel, then post it from here.",
      timestamp: now,
    });
  }

  return card({
    tone: "INFO",
    title: "Role menus",
    headline:
      prompt.notice ??
      `${menus.length} menu${menus.length === 1 ? "" : "s"} built.`,
    fields: [
      field(
        "Built",
        menus
          .slice(0, MAX_OPTIONS)
          .map((m) => {
            const roles = `${m.optionCount} role${m.optionCount === 1 ? "" : "s"}`;
            const where =
              m.channelId === null ? "not posted" : `<#${m.channelId}>`;
            return `${m.title} — ${roles} · ${where}`;
          })
          .join("\n"),
      ),
    ],
    timestamp: now,
  });
}

/**
 * *Post it here* names the channel it means.
 *
 * `/rolemenu action:post id:x` posted to wherever it was typed unless a channel
 * was named - the right default, and an invisible one. On a button the
 * destination is in the label, so a menu is never published into a staff channel
 * by a staffer who forgot which tab they were on.
 */
export function renderRoleMenuControls(
  menus: readonly RoleMenuSummary[],
  prompt: RoleMenuPrompt,
): readonly ActionRowView[] {
  const focused = focusMenu(menus, prompt.menuId);

  if (focused) {
    const here =
      focused.channelId !== null && focused.channelId === prompt.channelId;
    const buttons: ButtonView[] = [
      {
        label: here ? "Repost it here" : "Post it here",
        style: "PRIMARY",
        customId: roleMenuId("post", focused.id, prompt.channelId),
      },
    ];
    if (menus.length > 1) {
      buttons.push({
        label: "Back to all",
        style: "SECONDARY",
        customId: roleMenuId("show", null, prompt.channelId),
      });
    }
    return [{ buttons }];
  }

  if (menus.length === 0) return [];

  return [
    {
      buttons: [],
      select: {
        customId: roleMenuId("show", null, prompt.channelId),
        placeholder: "Open one of them",
        options: menus.slice(0, MAX_OPTIONS).map((m) => ({
          label: clampLabel(m.title, 90),
          value: m.id,
          description: `${m.optionCount} roles`,
        })),
      },
    },
  ];
}

// -------------------------------- /tickets --------------------------------

export const TICKET_NAMESPACE = "ticket";

export type TicketAction = "show" | "close" | "transcript";
const TICKET_ACTIONS: readonly string[] = ["show", "close", "transcript"];

/**
 * How much of a close reason a button can carry.
 *
 * `ticket:close:<25-char id>:` is roughly 40 of Discord's 100. The reason is
 * trimmed here rather than at the transport, so the card shows exactly what will
 * be recorded - a card promising a full sentence while the button carries half
 * of it is a card that lies.
 */
export const TICKET_REASON_MAX = 55;

export function trimTicketReason(raw: string | null): string {
  const reason = (raw ?? "").trim().split("\n").join(" ");
  if (reason.length <= TICKET_REASON_MAX) return reason;
  return `${reason.slice(0, TICKET_REASON_MAX - 1).trimEnd()}…`;
}

/** `ticket:<action>:<ticketId|->:<reason>` - the reason is the remainder. */
export function ticketId(
  action: TicketAction,
  id: string | null,
  reason = "",
): string {
  return [TICKET_NAMESPACE, action, id ?? "-", reason].join(":");
}

export function parseTicketId(segments: readonly string[]): {
  readonly action: TicketAction;
  readonly ticketId: string | null;
  readonly reason: string;
} | null {
  const [action, id, ...rest] = segments;
  if (action === undefined || !TICKET_ACTIONS.includes(action)) return null;
  return {
    action: action as TicketAction,
    ticketId: dash(id),
    reason: rest.join(":"),
  };
}

export interface TicketPrompt {
  readonly ticketId: string | null;
  readonly reason: string;
  readonly notice?: string;
  readonly now?: Date;
}

/**
 * The queue, at a glance.
 *
 * Was ten fields, each named `#12 — support` with the record in the value: data
 * in a field name, which Discord renders in bold and which gives the reader's
 * eye nothing to anchor on. One field, one line each, and the count in the
 * headline where the answer to "how bad is it" belongs.
 */
export function renderTicketQueueEmbed(
  tickets: readonly TicketDTO[],
  prompt: TicketPrompt,
): EmbedView {
  const now = (prompt.now ?? new Date()).toISOString();
  if (tickets.length === 0) {
    return card({
      tone: "SUCCESS",
      title: "Ticket queue",
      headline: prompt.notice ?? "Nothing open.",
      timestamp: now,
    });
  }
  const unclaimed = tickets.filter((t) => t.claimedByDiscordId === null).length;
  return card({
    tone: unclaimed > 0 ? "WARNING" : "INFO",
    title: "Ticket queue",
    headline:
      prompt.notice ??
      `${tickets.length} open, ${unclaimed === 0 ? "all claimed" : `${unclaimed} unclaimed`}.`,
    fields: [
      field(
        "Open",
        tickets
          .slice(0, MAX_OPTIONS)
          .map((t) => {
            const who =
              t.claimedByDiscordId === null
                ? "unclaimed"
                : `claimed by <@${t.claimedByDiscordId}>`;
            const kind = t.categoryName ?? "uncategorised";
            return `**#${t.number}** ${kind} · <@${t.openerDiscordId}> · ${who} · ${relativeTs(t.createdAt)}`;
          })
          .join("\n"),
      ),
    ],
    timestamp: now,
  });
}

/**
 * One ticket.
 *
 * Six inline fields became two: the facts staff read as a group, grouped. The
 * topic is the headline, because it is the sentence the member wrote and the
 * only part of the card that says what the ticket is about. "Answered" is absent
 * rather than zero when nobody has replied - the number matters in aggregate on
 * the panel; here the question is only whether anyone has.
 */
export function renderStaffTicketEmbed(
  ticket: TicketDTO,
  prompt?: TicketPrompt,
): EmbedView {
  const closed = ticket.closedAt !== null;
  const when = [
    { label: "Opened", value: relativeTs(ticket.createdAt) },
    {
      label: "Answered",
      value:
        ticket.firstStaffReplyAt === null
          ? null
          : relativeTs(ticket.firstStaffReplyAt),
    },
    { label: "Status", value: ticket.status.toLowerCase() },
  ];
  if (ticket.closedAt !== null)
    when.push({ label: "Closed", value: relativeTs(ticket.closedAt) });

  return card({
    tone: closed
      ? "NEUTRAL"
      : ticket.claimedByDiscordId === null
        ? "WARNING"
        : "INFO",
    title: `Ticket #${ticket.number} — ${ticket.categoryName ?? "uncategorised"}`,
    headline:
      prompt?.notice ?? ticket.topic ?? ticket.subject ?? "No topic given.",
    fields: [
      field(
        "Who",
        facts([
          { label: "Opened by", value: `<@${ticket.openerDiscordId}>` },
          {
            label: "Claimed by",
            value:
              ticket.claimedByDiscordId === null
                ? null
                : `<@${ticket.claimedByDiscordId}>`,
          },
          {
            label: "Channel",
            value: ticket.channelId === null ? null : `<#${ticket.channelId}>`,
          },
        ]),
      ),
      field("When", facts(when)),
      ...(ticket.closeReason === null
        ? []
        : [field("Closed because", ticket.closeReason)]),
    ],
    footer: `id ${ticket.id}`,
    timestamp: ticket.createdAt,
  });
}

/**
 * The controls under a ticket, or under the queue.
 *
 * *Close* is offered only on an open ticket and *Transcript* only once the
 * archive exists, so neither button is a way to discover that the thing it names
 * cannot be done. The queue carries a picker of what is actually open, which is
 * what stops a ticket number from being a prerequisite.
 */
export function renderTicketControls(
  tickets: readonly TicketDTO[],
  prompt: TicketPrompt,
): readonly ActionRowView[] {
  const focused =
    prompt.ticketId === null
      ? null
      : (tickets.find((t) => t.id === prompt.ticketId) ?? null);

  if (focused) {
    const buttons: ButtonView[] = [];
    if (focused.closedAt === null) {
      buttons.push({
        label: "Close it",
        style: "DANGER",
        customId: ticketId("close", focused.id, prompt.reason),
      });
    }
    if (focused.transcriptReady) {
      buttons.push({
        label: "Transcript",
        style: "SECONDARY",
        customId: ticketId("transcript", focused.id),
      });
    }
    if (tickets.length > 1) {
      buttons.push({
        label: "Back to the queue",
        style: "SECONDARY",
        customId: ticketId("show", null),
      });
    }
    return buttons.length === 0 ? [] : [{ buttons }];
  }

  const open = tickets.filter((t) => t.closedAt === null).slice(0, MAX_OPTIONS);
  if (open.length === 0) return [];

  return [
    {
      buttons: [],
      select: {
        customId: ticketId("show", null, prompt.reason),
        placeholder: "Open one of them",
        options: open.map((t) => ({
          label: clampLabel(
            `#${t.number} — ${t.categoryName ?? "uncategorised"}`,
            90,
          ),
          value: t.id,
          ...(t.claimedByDiscordId === null
            ? { description: "unclaimed" }
            : {}),
        })),
      },
    },
  ];
}
