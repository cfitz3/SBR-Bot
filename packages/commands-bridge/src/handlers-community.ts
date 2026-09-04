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
} from "@sbr/shared-types";
import { copy } from "@sbr/brand";
import { allFloors } from "@sbr/perms";
import { findCategory, openableCategories } from "@sbr/tickets";
import { lfgRequestReplies } from "./lfg-request.js";
import type { AutocompleteHandler, CommandHandler, CommandReply, CommandSpec, HandlerDeps } from "./types.js";
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

const E = copy.error;

const C = copy.embed.card;

/**
 * The floors `/lfg` offers, from the one table that defines them.
 *
 * Twenty of Discord's twenty-five choices, which is why they can all be offered
 * rather than grouped behind a second option — and why the menu flow exists for
 * the day that stops being true.
 */
const FLOOR_CHOICES = allFloors().map((floor) => ({ name: floor.label, value: floor.code }));

// ───────────────────────────── Error wording ─────────────────────────────

function eventProblem(error: EventError): string {
  switch (error.kind) {
    case "NOT_FOUND":
      return E.generic.notFound;
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
      return E.generic.notFound;
    case "FULL":
      return "That run is full.";
    case "CLOSED":
      return "That run has closed.";
    case "ALREADY_JOINED":
      return "You're already in that run.";
    case "NOT_A_MEMBER":
      return "You aren't in that run.";
    case "AUTHOR_CANNOT_LEAVE":
      return "You started this run, so you can't leave it — close it instead with `/run close`.";
    case "NOT_YOURS":
      return "That isn't your run. Only whoever posted it, or staff, can change it.";
    case "NO_SUCH_PERM":
      return error.detail;
    case "SLOTS_BELOW_ROSTER":
      return `That didn't work — ${error.detail}`;
    case "INVALID_SLOTS":
      return `That didn't work — ${error.detail}`;
  }
}

// ─────────────────────────────── Events ───────────────────────────────

const events: CommandHandler = async (ctx, deps) => {
  const result = await deps.community.listUpcomingEvents(ctx.guildId);
  if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
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

/**
 * What the Register button asks for: in, out, or "the other one from now".
 *
 * `TOGGLE` is not a stored state and never reaches the service — it is resolved
 * against the roster first. It exists because one button cannot know, at the
 * moment it is rendered, which way the next press goes.
 */
export type RsvpPress = RSVPState | "TOGGLE";

/**
 * Which way a `TOGGLE` press goes for this member.
 *
 * On the roster in any form — going, maybe from an older card, or waitlisted —
 * counts as registered, so the press takes them off. A read that fails registers
 * them: the failure mode of guessing wrong is one extra press, and guessing
 * "register" is the guess that matches what somebody pressing a green button
 * labelled Register almost always meant.
 */
async function toggleTarget(eventId: string, userId: string, deps: HandlerDeps): Promise<RSVPState> {
  const attendance = await deps.community.getAttendance(eventId);
  if (!attendance.ok) return "GOING";
  const { going, maybe, waitlist } = attendance.value;
  const registered = [...going, ...maybe, ...waitlist].some((entry) => entry.discordId === userId);
  return registered ? "NOT_GOING" : "GOING";
}

/** Shared by `/rsvp` and the Register button, so both answer identically. */
async function rsvpReply(
  eventId: string,
  userId: string,
  press: RsvpPress,
  deps: HandlerDeps,
): Promise<CommandReply> {
  const state = press === "TOGGLE" ? await toggleTarget(eventId, userId, deps) : press;
  const result = await deps.community.rsvp(eventId, userId, state);
  if (!result.ok) return { ephemeral: true, text: eventProblem(result.error) };

  const { event, waitlisted } = result.value;
  // Said back in the words of the button they pressed. "Recorded: not going" is
  // accurate about the row and wrong about what they did, which was leave.
  const text = waitlisted
    ? `"${event.title}" is full — you're on the waitlist.`
    : result.value.state === "NOT_GOING"
      ? `You're off the list for "${event.title}". Press Register again to rejoin.`
      : `You're registered for "${event.title}".`;
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

/**
 * `/lfg` — ask the guild for a group.
 *
 * Two ways in, and they are different requests rather than two spellings of one.
 * Without a floor it opens the menu, which is the path that can ask for classes.
 * With a floor it posts immediately: that is the express lane, and it is the
 * only lane guild chat has, because `!lfg f7` arrives as a token and there are
 * no components to press afterwards. A post made that way asks for any class,
 * which is what somebody in a hurry meant.
 */
const lfg: CommandHandler = async (ctx, deps) => {
  const floor = ctx.args.getString("floor");
  if (floor === null || floor.trim() === "") {
    // The menu cannot be shown to a chat line, so say what to type instead of
    // sending a reply whose controls are invisible.
    return ctx.surface === "INGAME"
      ? { ephemeral: true, text: C.lfgFloorNeeded }
      : lfgRequestReplies.start();
  }
  return lfgRequestReplies.post(ctx.guildId, ctx.userId, floor, [], deps);
};

/**
 * Staff, for "the author or staff may change this". Same `MENTION` floor the
 * perms surface uses, and a failed lookup degrades to "not staff".
 */
async function isStaff(guildId: string, userId: string, deps: HandlerDeps): Promise<boolean> {
  return deps.identity.hasCapability(guildId, userId, "MENTION").catch(() => false);
}

const editrun: CommandHandler = async (ctx, deps) => {
  const title = ctx.args.getString("title");
  const details = ctx.args.getString("details");
  const slots = ctx.args.getNumber("slots");
  if (title === null && details === null && slots === null) {
    return { ephemeral: true, text: "Nothing to change — pass `title:`, `details:` or `slots:`." };
  }
  const result = await deps.community.editLfg({
    postId: ctx.args.getString("id") ?? "",
    actorDiscordId: ctx.userId,
    isStaff: await isStaff(ctx.guildId, ctx.userId, deps),
    ...(title === null ? {} : { title }),
    ...(details === null ? {} : { details }),
    ...(slots === null ? {} : { slotsTotal: slots }),
  });
  if (!result.ok) return { ephemeral: true, text: lfgProblem(result.error) };

  const post = result.value;
  await deps.lfgBoard?.refresh(post);
  return {
    ephemeral: true,
    text: `Updated — ${post.slotsFilled}/${post.slotsTotal}.`,
    embed: renderLfgEmbed(post),
  };
};

async function closeReply(postId: string, userId: string, ctxGuildId: string, deps: HandlerDeps): Promise<CommandReply> {
  const result = await deps.community.closeLfg(postId, userId, await isStaff(ctxGuildId, userId, deps));
  if (!result.ok) return { ephemeral: true, text: lfgProblem(result.error) };
  const post = result.value;
  await deps.lfgBoard?.refresh(post);
  return {
    ephemeral: false,
    text: "Run closed.",
    embed: renderLfgEmbed(post),
    components: lfgButtons(post),
  };
}

const closerun: CommandHandler = async (ctx, deps) =>
  closeReply(ctx.args.getString("id") ?? "", ctx.userId, ctx.guildId, deps);

const runs: CommandHandler = async (ctx, deps) => {
  const activity = ctx.args.getString("activity");
  const result = await deps.community.listLfg(
    ctx.guildId,
    activity === null ? undefined : (activity as LFGActivity),
  );
  if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
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
  // The roster on the board is the one people read before deciding to join, so
  // it is updated before the reply that says the roster changed.
  await deps.lfgBoard?.refresh(post);
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
  await deps.lfgBoard?.refresh(post);
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
    if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
    return {
      ephemeral: true,
      text: result.value.length === 0 ? "You have no open tickets." : `${result.value.length} open.`,
      embed: renderTicketListEmbed(result.value),
    };
  }

  if (action === "close") {
    const id = ctx.args.getString("id");
    if (!id) return { ephemeral: true, text: "Which ticket? Pass `id:` — `/ticket action:list` shows yours." };
    // Staff-ness is a capability read, not an assertion. This path takes an
    // arbitrary id, which is exactly how any member could close anyone's ticket
    // before the rebuild; the lifecycle lets a member close only their own
    // unless they actually hold `TICKET_MANAGE`, and a failed read denies
    // rather than grants.
    const actor = {
      discordId: ctx.userId,
      isStaff: await deps.identity.hasCapability(ctx.guildId, ctx.userId, "TICKET_MANAGE").catch(() => false),
    };
    // And the guild is checked too, because the lifecycle cannot: it is handed
    // a ticket id and an actor, so "is this staffer allowed" gets answered
    // against the wrong server's capabilities for an id from another one.
    const found = await deps.community.getTicket(id);
    if (!found.ok) return { ephemeral: true, text: "Couldn't load that ticket." };
    if (found.value === null || found.value.guildId !== ctx.guildId) {
      return { ephemeral: true, text: "I couldn't find a ticket with that id." };
    }

    const result = await deps.community.closeTicket(id, actor, ctx.args.getString("reason"));
    if (!result.ok) {
      return {
        ephemeral: true,
        text:
          result.error.kind === "NOT_FOUND"
            ? E.generic.notFound
            : result.error.kind === "FORBIDDEN"
              ? "That isn't your ticket. Staff can close it from the ticket channel."
              : "That ticket is already closed.",
      };
    }
    return { ephemeral: true, text: `Closed ticket #${result.value.number}.`, embed: renderTicketEmbed(result.value) };
  }

  // `type:` is the guild's own menu; `category:` is the old fixed enum, kept
  // working because members have the five old values in their slash-command
  // history and a guild that seeded the defaults matches either way.
  const wanted = ctx.args.getString("type") ?? ctx.args.getString("category");
  const cats = await deps.community.listTicketCategories(ctx.guildId);
  const chosen = cats.ok ? findCategory(cats.value, wanted) : null;

  if (chosen === null) {
    const open = cats.ok ? openableCategories(cats.value) : [];
    return {
      ephemeral: true,
      text:
        open.length === 0
          ? "Tickets aren't open here right now."
          : `I don't have a ticket type called that. Try: ${open.map((c) => `\`${c.key}\``).join(", ")}.`,
    };
  }

  // The slash command opens the row only. The channel, the modal and the
  // opening message belong to the button flow in `apps/bridge-bot/src/tickets.ts`
  // — this path exists so `/ticket` keeps working, not as a second implementation.
  const topic = ctx.args.getString("subject");
  const result = await deps.community.openTicket({
    guildId: ctx.guildId,
    openerDiscordId: ctx.userId,
    categoryId: chosen.id,
    ...(topic === null ? {} : { topic }),
  });
  if (!result.ok) return { ephemeral: true, text: E.generic.saveFailed };
  // The category's own opening message replaces the generic line when it has
  // one: it is the question staff actually want answered, and only now.
  const prompt = chosen.openingMessage.trim() === "" ? "Staff will pick it up." : chosen.openingMessage;
  return {
    ephemeral: true,
    text: `Opened ${chosen.name.toLowerCase()} ticket #${result.value.number}. ${prompt}`,
    embed: renderTicketEmbed(result.value),
  };
};

/**
 * Suggest the guild's own ticket types. Empty on any failure — Discord shows
 * nothing on an autocomplete error regardless, and a member can still type a
 * key by hand.
 */
const ticketTypeAutocomplete: AutocompleteHandler = async (focused, ctx, deps) => {
  if (focused.name !== "type") return [];

  const cats = await deps.community.listTicketCategories(ctx.guildId);
  if (!cats.ok) return [];

  const typed = focused.value.trim().toLowerCase();
  return openableCategories(cats.value)
    .filter((c) => typed === "" || c.name.toLowerCase().includes(typed) || c.key.includes(typed))
    .slice(0, 25)
    .map((c) => ({ name: c.emoji === null ? c.name : `${c.emoji} ${c.name}`, value: c.key }));
};

// ─────────────────────────── Persistent buttons ───────────────────────────

/**
 * The button half of the community surface. Kept as plain functions rather than
 * transport wiring so the app layer only has to supply the interaction plumbing,
 * and the tests can press a button without a Discord client.
 */
export const communityButtonReplies = {
  /** `rsvp:<eventId>:TOGGLE`, or a state on a card posted before the merge. */
  async rsvp(eventId: string, userId: string, press: RsvpPress, deps: HandlerDeps): Promise<CommandReply> {
    return rsvpReply(eventId, userId, press, deps);
  },
  /**
   * `run:<postId>:join|leave|close`
   *
   * `guildId` is the internal guild, needed to work out whether the presser is
   * staff. A surface that cannot resolve it passes null, which costs staff their
   * override on the button and leaves the author's own close working.
   */
  async run(
    postId: string,
    userId: string,
    action: string,
    guildId: string | null,
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    if (action === "join") return joinReply(postId, userId, deps);
    if (action === "leave") return leaveReply(postId, userId, deps);
    if (action === "close") {
      if (guildId === null) {
        const own = await deps.community.closeLfg(postId, userId);
        if (!own.ok) return { ephemeral: true, text: lfgProblem(own.error) };
        await deps.lfgBoard?.refresh(own.value);
        return { ephemeral: true, text: "Run closed." };
      }
      return closeReply(postId, userId, guildId, deps);
    }
    return { ephemeral: true, text: "That button isn't valid any more." };
  },
};

/** Valid RSVP states, for validating a customId segment before trusting it. */
export function parseRsvpState(raw: string | undefined): RSVPState | null {
  return raw === "GOING" || raw === "MAYBE" || raw === "NOT_GOING" || raw === "WAITLIST" ? raw : null;
}

/**
 * The same, plus the toggle the Register button sends.
 *
 * The old states stay readable on purpose: cards posted before the merge still
 * carry `rsvp:<id>:GOING` buttons, and a member pressing one of those should
 * have their answer recorded rather than be told the button is too old.
 */
export function parseRsvpPress(raw: string | undefined): RsvpPress | null {
  return raw === "TOGGLE" ? "TOGGLE" : parseRsvpState(raw);
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
      category: "EVENTS",
      description: "Upcoming guild events",
      cooldownMs: 10_000,
      inGame: true,
      // Retired by `E-01`: an event is one message now. It is posted when the
      // event is created, it carries the roster and the RSVP buttons while
      // signups are open, and it becomes the standings in place — so the
      // channel already answers what this command answered, without anybody
      // having to ask it, and without an event id to quote.
      enabled: false,
      handler: events,
    },
    {
      name: "create-event",
      category: "EVENTS",
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
      // Retired by `E-01`: creation moved to the panel, which is the only
      // surface that can offer the choice this command could not. An event is
      // now one activity — the activity fixes the type, the metric and the
      // default name together — and a slash command with a free-text title and
      // an independent type dropdown is exactly how "Catacombs push, scored on
      // networth" became a thing somebody could create by accident.
      enabled: false,
      handler: createEvent,
    },
    {
      name: "rsvp",
      category: "EVENTS",
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
      // Retired by `E-01`: the three buttons are on the event's own message,
      // for as long as an answer means anything. Pressing one is a press;
      // this was a command, an event id copied out of another message, and a
      // choice list that said the same three things.
      enabled: false,
      handler: rsvp,
    },
    {
      name: "attendance",
      category: "EVENTS",
      description: "Who has responded to an event",
      options: [EVENT_ID_OPTION],
      cooldownMs: 10_000,
      // Retired by `E-01`: who has responded is on the event's message, kept
      // current by the presses themselves. Marking who actually *turned up* is
      // a different question and a staff one — it stays on the panel's events
      // page, where the tracker's own observations are already shown next to
      // the hand-ticked boxes.
      enabled: false,
      handler: attendance,
    },
    {
      name: "lfg",
      category: "GUILD",
      description: "Ask the guild for a group",
      // One option, and it is optional: `/lfg` is the menu, `/lfg floor:F7` and
      // `!lfg f7` are the express lane. It is first and positional so the
      // in-game router maps the single token people type onto it.
      options: [
        { name: "floor", description: "Post straight away for this floor, without the menu", type: "string", choices: FLOOR_CHOICES },
      ],
      capability: "RUN_COMMAND",
      // A minute between requests. Long enough that the channel cannot be
      // flooded, short enough that a member who picked the wrong floor is not
      // stuck with it — reposting is the only correction an announcement has.
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
      category: "GUILD",
      description: "Open looking-for-group posts",
      options: [{ name: "activity", description: "Filter by activity", type: "string", choices: ACTIVITY_CHOICES }],
      cooldownMs: 10_000,
      inGame: true,
      // Retired: looking-for-group never found an audience — parties get formed
      // in guild chat and the board went stale faster than anyone closed a
      // post. Decision 3 of Phase 17 in
      // `~/.claude/plans/typed-dreaming-torvalds.md`. `LFGPost`, `LFGActivity`
      // and `@sbr/perms` are untouched: `/perm` still keeps the party lists,
      // and existing posts stay readable in the database.
      enabled: false,
      handler: runs,
    },
    {
      name: "joinrun",
      category: "GUILD",
      description: "Take a slot in an open run",
      options: [{ name: "id", description: "Run id (shown by /runs)", type: "string", required: true }],
      cooldownMs: 5_000,
      // Retired: looking-for-group never found an audience — parties get formed
      // in guild chat and the board went stale faster than anyone closed a
      // post. Decision 3 of Phase 17 in
      // `~/.claude/plans/typed-dreaming-torvalds.md`. `LFGPost`, `LFGActivity`
      // and `@sbr/perms` are untouched: `/perm` still keeps the party lists,
      // and existing posts stay readable in the database.
      enabled: false,
      handler: joinrun,
    },
    {
      name: "leaverun",
      category: "GUILD",
      description: "Give up your slot in a run",
      options: [{ name: "id", description: "Run id", type: "string", required: true }],
      cooldownMs: 5_000,
      // Retired: looking-for-group never found an audience — parties get formed
      // in guild chat and the board went stale faster than anyone closed a
      // post. Decision 3 of Phase 17 in
      // `~/.claude/plans/typed-dreaming-torvalds.md`. `LFGPost`, `LFGActivity`
      // and `@sbr/perms` are untouched: `/perm` still keeps the party lists,
      // and existing posts stay readable in the database.
      enabled: false,
      handler: leaverun,
    },
    {
      name: "editrun",
      category: "GUILD",
      description: "Change your run's headline, notes or party size",
      options: [
        { name: "id", description: "Run id", type: "string", required: true },
        { name: "title", description: "New headline", type: "string" },
        { name: "details", description: "New requirements or notes", type: "string" },
        { name: "slots", description: "New party size", type: "integer", minValue: 2, maxValue: 20 },
      ],
      capability: "RUN_COMMAND",
      cooldownMs: 10_000,
      // Retired: looking-for-group never found an audience — parties get formed
      // in guild chat and the board went stale faster than anyone closed a
      // post. Decision 3 of Phase 17 in
      // `~/.claude/plans/typed-dreaming-torvalds.md`. `LFGPost`, `LFGActivity`
      // and `@sbr/perms` are untouched: `/perm` still keeps the party lists,
      // and existing posts stay readable in the database.
      enabled: false,
      handler: editrun,
    },
    {
      name: "closerun",
      category: "GUILD",
      description: "Close your run early",
      options: [{ name: "id", description: "Run id", type: "string", required: true }],
      capability: "RUN_COMMAND",
      cooldownMs: 5_000,
      // Retired: looking-for-group never found an audience — parties get formed
      // in guild chat and the board went stale faster than anyone closed a
      // post. Decision 3 of Phase 17 in
      // `~/.claude/plans/typed-dreaming-torvalds.md`. `LFGPost`, `LFGActivity`
      // and `@sbr/perms` are untouched: `/perm` still keeps the party lists,
      // and existing posts stay readable in the database.
      enabled: false,
      handler: closerun,
    },
    {
      name: "ticket",
      category: "EXTRAS",
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
          // Autocompleted rather than a choice list: the types are per-guild
          // and editable at any time, and slash-command choices are fixed at
          // registration — a guild adding a type would otherwise need the whole
          // command re-registered before anyone could pick it.
          name: "type",
          description: "What it's about (when opening)",
          type: "string",
          autocomplete: true,
        },
        {
          // The old fixed enum. Kept so existing muscle memory and any saved
          // command history still open a ticket; `type:` wins when both are set.
          name: "category",
          description: "Deprecated — use type:",
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
      autocomplete: ticketTypeAutocomplete,
    },
  ];
}
