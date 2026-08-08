/**
 * Community command handlers — events, RSVP, LFG and tickets (COMMANDS.md §6–§8).
 *
 * These are the only member commands that *write*, so each one leans on the
 * domain service for the rules (capacity, slot limits, who may cancel) and does
 * nothing here but translate the typed error union into a sentence a member can
 * act on. The RSVP and run buttons route through the same code paths as the
 * slash commands, via `communityButtonReplies`, so the two can't drift apart.
 */
import type {
  EventError,
  EventType,
  LFGActivity,
  LfgError,
  RSVPState,
  TicketCategory,
} from "@sbr/shared-types";
import type { CommandHandler, CommandReply, CommandSpec, HandlerDeps } from "./types.js";
import {
  lfgButtons,
  renderAttendanceEmbed,
  renderEventEmbed,
  renderEventsEmbed,
  renderLfgEmbed,
  renderLfgListEmbed,
  renderTicketEmbed,
  renderTicketListEmbed,
  rsvpButtons,
} from "./render-community.js";

// ───────────────────────────── Error wording ─────────────────────────────

function eventProblem(error: EventError): string {
  switch (error.kind) {
    case "NOT_FOUND":
      return "I couldn't find an event with that id.";
    case "CLOSED":
      return "That event has already finished or been cancelled.";
    case "NOT_HOST":
      return "Only the person who created that event can cancel it.";
    case "INVALID_TIME":
      return `That didn't work — ${error.detail}`;
  }
}

function lfgProblem(error: LfgError): string {
  switch (error.kind) {
    case "NOT_FOUND":
      return "I couldn't find a run with that id.";
    case "FULL":
      return "That run is full.";
    case "CLOSED":
      return "That run has closed.";
    case "ALREADY_JOINED":
      return "You're already in that run.";
    case "NOT_A_MEMBER":
      return "You aren't in that run.";
    case "AUTHOR_CANNOT_LEAVE":
      return "You started this run, so you can't leave it — the run closes when it expires.";
    case "INVALID_SLOTS":
      return `That didn't work — ${error.detail}`;
  }
}

// ─────────────────────────────── Events ───────────────────────────────

const events: CommandHandler = async (ctx, deps) => {
  const result = await deps.community.listUpcomingEvents(ctx.guildId);
  if (!result.ok) return { ephemeral: true, text: "Couldn't load events right now." };
  const list = result.value;
  return {
    ephemeral: false,
    text:
      list.length === 0
        ? "Nothing scheduled right now."
        : list
            .slice(0, 5)
            .map((e) => `${e.title} — ${e.startsAt}`)
            .join(" | "),
    embed: renderEventsEmbed(list),
  };
};

const createEvent: CommandHandler = async (ctx, deps) => {
  const capacity = ctx.args.getNumber("capacity");
  const description = ctx.args.getString("description");
  const result = await deps.community.createEvent({
    guildId: ctx.guildId,
    title: ctx.args.getString("title") ?? "Untitled event",
    startsAt: ctx.args.getString("starts_at") ?? "",
    type: (ctx.args.getString("type") ?? "CUSTOM") as EventType,
    hostDiscordId: ctx.userId,
    ...(description === null ? {} : { description }),
    ...(capacity === null ? {} : { capacity }),
  });
  if (!result.ok) return { ephemeral: true, text: eventProblem(result.error) };

  const event = result.value;
  return {
    ephemeral: false,
    text: `Created "${event.title}" (id ${event.id}).`,
    embed: renderEventEmbed(event),
    components: rsvpButtons(event.id),
  };
};

const rsvp: CommandHandler = async (ctx, deps) => {
  const eventId = ctx.args.getString("event") ?? "";
  const state = (ctx.args.getString("response") ?? "GOING") as RSVPState;
  return rsvpReply(eventId, ctx.userId, state, deps);
};

/** Shared by `/rsvp` and the RSVP buttons, so both answer identically. */
async function rsvpReply(
  eventId: string,
  userId: string,
  state: RSVPState,
  deps: HandlerDeps,
): Promise<CommandReply> {
  const result = await deps.community.rsvp(eventId, userId, state);
  if (!result.ok) return { ephemeral: true, text: eventProblem(result.error) };

  const { event, waitlisted } = result.value;
  const text = waitlisted
    ? `"${event.title}" is full — you're on the waitlist.`
    : `Recorded: ${result.value.state.toLowerCase().replace("_", " ")} for "${event.title}".`;
  return { ephemeral: true, text, embed: renderEventEmbed(event) };
}

const attendance: CommandHandler = async (ctx, deps) => {
  const result = await deps.community.getAttendance(ctx.args.getString("event") ?? "");
  if (!result.ok) return { ephemeral: true, text: eventProblem(result.error) };
  const a = result.value;
  return {
    ephemeral: false,
    text: `${a.event.title}: ${a.going.length} going, ${a.maybe.length} maybe, ${a.waitlist.length} waitlisted.`,
    embed: renderAttendanceEmbed(a),
  };
};

// ──────────────────────────────── LFG ────────────────────────────────

const lfg: CommandHandler = async (ctx, deps) => {
  const details = ctx.args.getString("details");
  const result = await deps.community.createLfg({
    guildId: ctx.guildId,
    authorDiscordId: ctx.userId,
    activity: (ctx.args.getString("activity") ?? "OTHER") as LFGActivity,
    slotsTotal: ctx.args.getNumber("slots") ?? 5,
    ...(details === null ? {} : { details }),
    // Runs go stale fast; two hours keeps `/runs` from filling with dead parties.
    expiresInMinutes: 120,
  });
  if (!result.ok) return { ephemeral: true, text: lfgProblem(result.error) };

  const post = result.value;
  return {
    ephemeral: false,
    text: `${post.activity.toLowerCase()} run open — ${post.slotsFilled}/${post.slotsTotal} (id ${post.id}).`,
    embed: renderLfgEmbed(post),
    components: lfgButtons(post),
  };
};

const runs: CommandHandler = async (ctx, deps) => {
  const activity = ctx.args.getString("activity");
  const result = await deps.community.listLfg(
    ctx.guildId,
    activity === null ? undefined : (activity as LFGActivity),
  );
  if (!result.ok) return { ephemeral: true, text: "Couldn't load runs right now." };
  const list = result.value;
  return {
    ephemeral: false,
    text:
      list.length === 0
        ? "No open runs right now."
        : list.map((p) => `${p.activity.toLowerCase()} ${p.slotsFilled}/${p.slotsTotal}`).join(" | "),
    embed: renderLfgListEmbed(list),
  };
};

async function joinReply(postId: string, userId: string, deps: HandlerDeps): Promise<CommandReply> {
  const result = await deps.community.joinLfg(postId, userId);
  if (!result.ok) return { ephemeral: true, text: lfgProblem(result.error) };
  const post = result.value;
  return {
    ephemeral: false,
    text: `Joined — ${post.slotsFilled}/${post.slotsTotal}.`,
    embed: renderLfgEmbed(post),
    components: lfgButtons(post),
  };
}

async function leaveReply(postId: string, userId: string, deps: HandlerDeps): Promise<CommandReply> {
  const result = await deps.community.leaveLfg(postId, userId);
  if (!result.ok) return { ephemeral: true, text: lfgProblem(result.error) };
  const post = result.value;
  return {
    ephemeral: false,
    text: `Left — ${post.slotsFilled}/${post.slotsTotal}.`,
    embed: renderLfgEmbed(post),
    components: lfgButtons(post),
  };
}

const joinrun: CommandHandler = async (ctx, deps) => joinReply(ctx.args.getString("id") ?? "", ctx.userId, deps);
const leaverun: CommandHandler = async (ctx, deps) => leaveReply(ctx.args.getString("id") ?? "", ctx.userId, deps);

// ─────────────────────────────── Tickets ───────────────────────────────

const ticket: CommandHandler = async (ctx, deps) => {
  const action = ctx.args.getString("action") ?? "open";

  if (action === "list") {
    // Scoped to the caller: a member seeing everyone's tickets would leak
    // reports and appeals about other people.
    const result = await deps.community.listTickets(ctx.guildId, ctx.userId);
    if (!result.ok) return { ephemeral: true, text: "Couldn't load your tickets right now." };
    return {
      ephemeral: true,
      text: result.value.length === 0 ? "You have no open tickets." : `${result.value.length} open.`,
      embed: renderTicketListEmbed(result.value),
    };
  }

  if (action === "close") {
    const id = ctx.args.getString("id");
    if (!id) return { ephemeral: true, text: "Which ticket? Pass `id:` — `/ticket action:list` shows yours." };
    const result = await deps.community.closeTicket(id, ctx.userId, ctx.args.getString("reason"));
    if (!result.ok) {
      return {
        ephemeral: true,
        text:
          result.error.kind === "NOT_FOUND"
            ? "I couldn't find a ticket with that id."
            : "That ticket is already closed.",
      };
    }
    return { ephemeral: true, text: `Closed ticket ${result.value.id}.`, embed: renderTicketEmbed(result.value) };
  }

  const subject = ctx.args.getString("subject");
  const result = await deps.community.openTicket({
    guildId: ctx.guildId,
    openerDiscordId: ctx.userId,
    category: (ctx.args.getString("category") ?? "SUPPORT") as TicketCategory,
    ...(subject === null ? {} : { subject }),
  });
  if (!result.ok) return { ephemeral: true, text: "Couldn't open a ticket right now." };
  return {
    ephemeral: true,
    text: `Opened ticket ${result.value.id}. Staff will pick it up.`,
    embed: renderTicketEmbed(result.value),
  };
};

// ─────────────────────────── Persistent buttons ───────────────────────────

/**
 * The button half of the community surface. Kept as plain functions rather than
 * transport wiring so the app layer only has to supply the interaction plumbing,
 * and the tests can press a button without a Discord client.
 */
export const communityButtonReplies = {
  /** `rsvp:<eventId>:<state>` */
  async rsvp(eventId: string, userId: string, state: RSVPState, deps: HandlerDeps): Promise<CommandReply> {
    return rsvpReply(eventId, userId, state, deps);
  },
  /** `run:<postId>:join|leave` */
  async run(postId: string, userId: string, action: string, deps: HandlerDeps): Promise<CommandReply> {
    if (action === "join") return joinReply(postId, userId, deps);
    if (action === "leave") return leaveReply(postId, userId, deps);
    return { ephemeral: true, text: "That button isn't valid any more." };
  },
};

/** Valid RSVP states, for validating a customId segment before trusting it. */
export function parseRsvpState(raw: string | undefined): RSVPState | null {
  return raw === "GOING" || raw === "MAYBE" || raw === "NOT_GOING" || raw === "WAITLIST" ? raw : null;
}

// ─────────────────────────────── Registry ───────────────────────────────

const EVENT_ID_OPTION = {
  name: "event",
  description: "Event id (shown by /events)",
  type: "string" as const,
  required: true,
};

const ACTIVITY_CHOICES = [
  { name: "Dungeons", value: "DUNGEONS" },
  { name: "Slayers", value: "SLAYERS" },
  { name: "Kuudra", value: "KUUDRA" },
  { name: "Fishing", value: "FISHING" },
  { name: "Mining", value: "MINING" },
  { name: "Other", value: "OTHER" },
];

export function communitySpecs(): readonly CommandSpec[] {
  return [
    {
      name: "events",
      description: "Upcoming guild events",
      cooldownMs: 10_000,
      inGame: true,
      handler: events,
    },
    {
      name: "create-event",
      description: "Schedule a guild event",
      options: [
        { name: "title", description: "Event name", type: "string", required: true },
        {
          name: "starts_at",
          description: "When it starts, as an ISO time (2026-09-01T18:00Z)",
          type: "string",
          required: true,
        },
        {
          name: "type",
          description: "What kind of event",
          type: "string",
          choices: [
            { name: "Dungeon", value: "DUNGEON" },
            { name: "Slayer", value: "SLAYER" },
            { name: "Fishing", value: "FISHING" },
            { name: "Mining", value: "MINING" },
            { name: "Giveaway", value: "GIVEAWAY" },
            { name: "Meeting", value: "MEETING" },
            { name: "Custom", value: "CUSTOM" },
          ],
        },
        { name: "capacity", description: "Max people going (leave empty for unlimited)", type: "integer", minValue: 1, maxValue: 200 },
        { name: "description", description: "Extra detail", type: "string" },
      ],
      capability: "RUN_COMMAND",
      cooldownMs: 30_000,
      handler: createEvent,
    },
    {
      name: "rsvp",
      description: "Respond to a guild event",
      options: [
        EVENT_ID_OPTION,
        {
          name: "response",
          description: "Your answer (default going)",
          type: "string",
          choices: [
            { name: "Going", value: "GOING" },
            { name: "Maybe", value: "MAYBE" },
            { name: "Can't make it", value: "NOT_GOING" },
          ],
        },
      ],
      cooldownMs: 5_000,
      handler: rsvp,
    },
    {
      name: "attendance",
      description: "Who has responded to an event",
      options: [EVENT_ID_OPTION],
      cooldownMs: 10_000,
      handler: attendance,
    },
    {
      name: "lfg",
      description: "Start a looking-for-group post",
      options: [
        { name: "activity", description: "What you're running", type: "string", required: true, choices: ACTIVITY_CHOICES },
        { name: "slots", description: "Party size including you (default 5)", type: "integer", minValue: 2, maxValue: 20 },
        { name: "details", description: "Requirements or notes", type: "string" },
      ],
      capability: "RUN_COMMAND",
      cooldownMs: 60_000,
      // The one write reachable from guild chat (COMMANDS.md §17): forming a
      // party is the thing people are already in-game to do. `"linked"`, not
      // `true` — the post is attributed to its author, so the speaking IGN has
      // to resolve to a Discord account first.
      inGame: "linked",
      handler: lfg,
    },
    {
      name: "runs",
      description: "Open looking-for-group posts",
      options: [{ name: "activity", description: "Filter by activity", type: "string", choices: ACTIVITY_CHOICES }],
      cooldownMs: 10_000,
      inGame: true,
      handler: runs,
    },
    {
      name: "joinrun",
      description: "Take a slot in an open run",
      options: [{ name: "id", description: "Run id (shown by /runs)", type: "string", required: true }],
      cooldownMs: 5_000,
      handler: joinrun,
    },
    {
      name: "leaverun",
      description: "Give up your slot in a run",
      options: [{ name: "id", description: "Run id", type: "string", required: true }],
      cooldownMs: 5_000,
      handler: leaverun,
    },
    {
      name: "ticket",
      description: "Open, list or close a support ticket",
      options: [
        {
          name: "action",
          description: "What to do (default open)",
          type: "string",
          choices: [
            { name: "Open", value: "open" },
            { name: "List mine", value: "list" },
            { name: "Close", value: "close" },
          ],
        },
        {
          name: "category",
          description: "What it's about (when opening)",
          type: "string",
          choices: [
            { name: "Support", value: "SUPPORT" },
            { name: "Report a member", value: "REPORT" },
            { name: "Appeal a punishment", value: "APPEAL" },
            { name: "Application", value: "APPLICATION" },
            { name: "Other", value: "OTHER" },
          ],
        },
        { name: "subject", description: "One-line summary (when opening)", type: "string" },
        { name: "id", description: "Ticket id (when closing)", type: "string" },
        { name: "reason", description: "Why you're closing it", type: "string" },
      ],
      cooldownMs: 30_000,
      handler: ticket,
    },
  ];
}
