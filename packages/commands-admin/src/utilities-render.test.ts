/**
 * The utility cards, and the ids their controls carry.
 *
 * A custom id is the only state a persistent component has: Discord hands back
 * the string and nothing else, so anything the click needs has to survive a
 * round trip through it. These tests are mostly that round trip, plus the two
 * rules the controls exist to enforce - a verb is offered only when it applies,
 * and what the card promises is what the button will actually do.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ModerationActionDTO, TicketDTO } from "@sbr/shared-types";
import type { RoleMenuSummary, StickySummary } from "./types.js";
import {
  TICKET_REASON_MAX,
  parseRoleMenuId,
  parseStickyId,
  parseTicketId,
  renderNoteEmbed,
  renderRoleMenuControls,
  renderRoleMenuEmbed,
  renderStaffTicketEmbed,
  renderStickyControls,
  renderStickyEmbed,
  renderTicketControls,
  renderTicketQueueEmbed,
  roleMenuId,
  stickyId,
  ticketId,
  trimTicketReason,
} from "./utilities.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");

/** Segments as the router hands them over: the namespace is already stripped. */
const seg = (id: string): readonly string[] => id.split(":").slice(1);

function note(over: Partial<ModerationActionDTO> = {}): ModerationActionDTO {
  return {
    id: "act-note-1",
    caseCode: "CASE-DrJay-a1b2c3d4-2",
    guildId: "g1",
    type: "NOTE",
    actorDiscordId: "staff",
    targetDiscordId: "member",
    reason:
      "Asked twice about carry pricing after being pointed at the shop channel.",
    durationSeconds: null,
    expiresAt: null,
    surfaces: [],
    active: false,
    enforcement: "NOT_REQUIRED",
    enforcementDetail: null,
    createdAt: "2026-03-01T11:00:00.000Z",
    updatedAt: null,
    editedByDiscordId: null,
    voidedAt: null,
    voidReason: null,
    ...over,
  };
}

const STICKIES: readonly StickySummary[] = [
  { channelId: "c1", content: "Read the rules.\nSeriously.", enabled: true },
  { channelId: "c2", content: "Applications are closed.", enabled: false },
];

const MENUS: readonly RoleMenuSummary[] = [
  { id: "pings", title: "Ping roles", optionCount: 6, channelId: "c9" },
  { id: "regions", title: "Region", optionCount: 4, channelId: null },
];

function ticket(over: Partial<TicketDTO> = {}): TicketDTO {
  return {
    id: "tkt-1",
    guildId: "g1",
    number: 12,
    openerDiscordId: "member",
    assigneeDiscordId: null,
    categoryId: "cat-1",
    categoryKey: "SUPPORT",
    categoryName: "Support",
    status: "OPEN",
    channelId: "c3",
    subject: null,
    topic: "Cannot link my account",
    claimedByDiscordId: null,
    claimedAt: null,
    closeRequestedByDiscordId: null,
    closeRequestedAt: null,
    lastMessageAt: null,
    firstStaffReplyAt: null,
    feedbackRating: null,
    transcriptReady: false,
    closeReason: null,
    createdAt: "2026-03-01T09:00:00.000Z",
    closedAt: null,
    ...over,
  };
}

const value = (
  view: { fields?: readonly { name: string; value: string }[] },
  name: string,
): string => view.fields?.find((f) => f.name === name)?.value ?? "";

// --------------------------------- /note ---------------------------------

test("the note is the card's headline, not a sentence about a case id", () => {
  const view = renderNoteEmbed(note());
  assert.match(view.description ?? "", /carry pricing/);
  assert.match(value(view, "Where it lives"), /<@member>/);
  assert.match(value(view, "Where it lives"), /CASE-DrJay-a1b2c3d4-2/);
});

test("a note is dated by when it was recorded, not by when the reply rendered", () => {
  // The card outlives the interaction: pulled up later from the audit log, a
  // timestamp of "now" would date every historical note to the moment it was read.
  assert.equal(renderNoteEmbed(note()).timestamp, "2026-03-01T11:00:00.000Z");
});

test("a note against somebody with no Discord account still renders", () => {
  assert.match(
    value(renderNoteEmbed(note({ targetDiscordId: null })), "Where it lives"),
    /unlinked/,
  );
});

// -------------------------------- /sticky --------------------------------

test("a sticky custom id survives the round trip, absent channel included", () => {
  assert.deepEqual(parseStickyId(seg(stickyId("clear", "c1"))), {
    action: "clear",
    channelId: "c1",
  });
  assert.deepEqual(parseStickyId(seg(stickyId("show", null))), {
    action: "show",
    channelId: null,
  });
});

test("a custom id from another namespace is refused rather than half-read", () => {
  assert.equal(parseStickyId(["post", "c1"]), null);
  assert.equal(parseRoleMenuId(["clear", "x", "-"]), null);
  assert.equal(parseTicketId(["publish", "t1"]), null);
});

test("the sticky overview lists every channel and offers each as a pick", () => {
  const prompt = { channelId: null, now: NOW };
  const view = renderStickyEmbed(STICKIES, prompt);
  assert.match(view.description ?? "", /2 channels/);
  assert.match(value(view, "Where"), /<#c1>/);
  // One line each: the second line of a sticky is not part of the summary.
  assert.equal(value(view, "Where").includes("Seriously"), false);
  assert.deepEqual(
    renderStickyControls(STICKIES, prompt)[0]?.select?.options.map(
      (o) => o.value,
    ),
    ["c1", "c2"],
  );
});

test("Clear is offered on a channel that has a sticky, and on no other", () => {
  // action:clear against an empty channel used to answer with a success message
  // about removing nothing.
  const rows = renderStickyControls(STICKIES, { channelId: "c1", now: NOW });
  assert.deepEqual(
    rows[0]?.buttons.map((b) => b.customId),
    ["sticky:clear:c1", "sticky:show:-"],
  );
  assert.deepEqual(renderStickyControls([], { channelId: "c1", now: NOW }), []);
});

test("a paused sticky says it is paused rather than reading as live", () => {
  const view = renderStickyEmbed(STICKIES, { channelId: "c2", now: NOW });
  assert.equal(view.color, "NEUTRAL");
  assert.match(value(view, "State"), /paused/);
});

test("a notice leads the card, so the result of the click is the first thing read", () => {
  const view = renderStickyEmbed(STICKIES, {
    channelId: "c1",
    notice: "Sticky set in <#c1>.",
    now: NOW,
  });
  assert.equal(view.description, "Sticky set in <#c1>.");
});

// ------------------------------- /rolemenu -------------------------------

test("a role menu custom id carries both the menu and the destination", () => {
  assert.deepEqual(parseRoleMenuId(seg(roleMenuId("post", "pings", "c9"))), {
    action: "post",
    menuId: "pings",
    channelId: "c9",
  });
  assert.deepEqual(parseRoleMenuId(seg(roleMenuId("show", null, null))), {
    action: "show",
    menuId: null,
    channelId: null,
  });
});

test("the post button names the channel it means", () => {
  // action:post published to wherever it was typed unless a channel was named:
  // the right default, and an invisible one.
  const rows = renderRoleMenuControls(MENUS, {
    menuId: "regions",
    channelId: "c7",
    now: NOW,
  });
  assert.equal(rows[0]?.buttons[0]?.label, "Post it here");
  assert.equal(rows[0]?.buttons[0]?.customId, "rolemenu:post:regions:c7");
  const again = renderRoleMenuControls(MENUS, {
    menuId: "pings",
    channelId: "c9",
    now: NOW,
  });
  assert.equal(
    again[0]?.buttons[0]?.label,
    "Repost it here",
    "a menu already here says repost",
  );
});

test("a menu that has never been posted says so", () => {
  const view = renderRoleMenuEmbed(MENUS, {
    menuId: "regions",
    channelId: "c7",
    now: NOW,
  });
  assert.match(value(view, "This menu"), /nowhere yet/);
});

test("no menus at all is a sentence, not an empty card with a dead picker", () => {
  const prompt = { menuId: null, channelId: "c7", now: NOW };
  assert.match(
    renderRoleMenuEmbed([], prompt).description ?? "",
    /None built yet/,
  );
  assert.deepEqual(renderRoleMenuControls([], prompt), []);
});

// -------------------------------- /tickets --------------------------------

test("a close reason rides in the custom id, colons and all", () => {
  const id = ticketId("close", "tkt-1", "resolved: they relinked");
  assert.deepEqual(parseTicketId(seg(id)), {
    action: "close",
    ticketId: "tkt-1",
    reason: "resolved: they relinked",
  });
});

test("a trimmed reason still fits inside Discord's custom id limit", () => {
  const reason = trimTicketReason("x".repeat(200));
  assert.equal(reason.length, TICKET_REASON_MAX);
  // The widest realistic id: the verb, a 25-character row id, and the reason.
  assert.ok(ticketId("transcript", "c".repeat(25), reason).length <= 100);
});

test("a reason is trimmed before it reaches the card, not after", () => {
  // A card promising a full sentence while the button carries half of it is a
  // card that lies about what is being recorded.
  const long =
    "They opened this twice and the second one has the actual details in it, see #13";
  const rows = renderTicketControls([ticket()], {
    ticketId: "tkt-1",
    reason: trimTicketReason(long),
    now: NOW,
  });
  const carried =
    parseTicketId(seg(rows[0]?.buttons[0]?.customId ?? ""))?.reason ?? "";
  assert.equal(carried, trimTicketReason(long));
  assert.ok(
    carried.endsWith("\u2026"),
    "the truncation is visible rather than silent",
  );
});

test("the queue leads with how many are unanswered, and keeps data out of field names", () => {
  const rows = [
    ticket(),
    ticket({ id: "tkt-2", number: 13, claimedByDiscordId: "staff" }),
  ];
  const view = renderTicketQueueEmbed(rows, {
    ticketId: null,
    reason: "",
    now: NOW,
  });
  assert.match(view.description ?? "", /2 open, 1 unclaimed/);
  assert.equal(view.color, "WARNING");
  // Data in a field name renders in bold and gives the eye nothing to anchor on.
  assert.deepEqual(
    view.fields?.map((f) => f.name),
    ["Open"],
  );
  assert.match(value(view, "Open"), /#12/);
});

test("a fully claimed queue stops reading as a warning", () => {
  const rows = [ticket({ claimedByDiscordId: "staff" })];
  const view = renderTicketQueueEmbed(rows, {
    ticketId: null,
    reason: "",
    now: NOW,
  });
  assert.equal(view.color, "INFO");
  assert.match(view.description ?? "", /all claimed/);
});

test("Close is absent on a closed ticket, Transcript absent until the archive exists", () => {
  const open = renderTicketControls([ticket()], {
    ticketId: "tkt-1",
    reason: "",
    now: NOW,
  });
  assert.deepEqual(
    open[0]?.buttons.map((b) => b.label),
    ["Close it"],
  );

  const closed = ticket({
    closedAt: "2026-03-01T10:00:00.000Z",
    status: "CLOSED",
    transcriptReady: true,
  });
  const rows = renderTicketControls([closed], {
    ticketId: "tkt-1",
    reason: "",
    now: NOW,
  });
  assert.deepEqual(
    rows[0]?.buttons.map((b) => b.label),
    ["Transcript"],
  );
});

test("the queue's picker offers only what is open", () => {
  const rows = [
    ticket(),
    ticket({
      id: "tkt-2",
      closedAt: "2026-03-01T10:00:00.000Z",
      status: "CLOSED",
    }),
  ];
  const controls = renderTicketControls(rows, {
    ticketId: null,
    reason: "",
    now: NOW,
  });
  assert.deepEqual(
    controls[0]?.select?.options.map((o) => o.value),
    ["tkt-1"],
  );
});

test("a ticket card puts the member's own sentence in the headline", () => {
  const view = renderStaffTicketEmbed(ticket());
  assert.equal(view.description, "Cannot link my account");
  assert.equal(view.timestamp, "2026-03-01T09:00:00.000Z");
  // Six inline fields became two, plus the close reason when there is one.
  assert.deepEqual(
    view.fields?.map((f) => f.name),
    ["Who", "When"],
  );
  // Unclaimed keeps the label with the shared unknown glyph rather than dropping
  // the line: the reader is asking "has anyone picked this up", and an absent
  // row answers that less plainly than an empty one.
  assert.match(value(view, "Who"), /Claimed by/);
  assert.equal(value(view, "Who").includes("<@staff>"), false);
});

test("a closed ticket names why, and stops reading as live", () => {
  const view = renderStaffTicketEmbed(
    ticket({
      status: "CLOSED",
      closedAt: "2026-03-01T10:00:00.000Z",
      closeReason: "Duplicate of #13",
    }),
  );
  assert.equal(view.color, "NEUTRAL");
  assert.equal(value(view, "Closed because"), "Duplicate of #13");
});
