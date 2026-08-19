/**
 * The ticket gateway, against fake ports.
 *
 * Everything asserted here is an ordering or a failure mode rather than a
 * rendering: which write happens before which, and what survives when one of
 * them does not. Those are the properties that decide whether a member ends up
 * with a channel nobody can find, or a panel that reports success without a
 * message behind it — and they are invisible in the happy path, which is why
 * they are pinned down.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CommunityService,
  GuildConfigService,
  TicketCategoryDTO,
  TicketDTO,
  TicketPanelDTO,
  TicketSettingsDTO,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import {
  TicketGateway,
  eligibilityMessage,
  type NewChannelRequest,
  type OutboundMessage,
  type TicketArchivePort,
  type TicketConfigPort,
  type TicketDiscordPort,
} from "./tickets.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const silent: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

function settings(over: Partial<TicketSettingsDTO> = {}): TicketSettingsDTO {
  return {
    guildId: "g1",
    archiveEnabled: true,
    logChannelId: null,
    blocklistRoleIds: [],
    primaryColor: "INFO",
    successColor: "SUCCESS",
    errorColor: "DANGER",
    footer: null,
    staleAfterMinutes: null,
    autoCloseAfterMinutes: 720,
    closeButton: true,
    claimButton: true,
    workingHours: {},
    updatedAt: null,
    ...over,
  };
}

function category(over: Partial<TicketCategoryDTO> = {}): TicketCategoryDTO {
  return {
    id: "cat-1",
    guildId: "g1",
    key: "support",
    name: "Support",
    description: "Ask us anything",
    emoji: null,
    position: 0,
    enabled: true,
    channelNameTemplate: "ticket-{num}",
    parentChannelId: "parent-1",
    staffRoleIds: ["role-staff"],
    requiredRoleIds: [],
    pingRoleIds: [],
    openingMessage: "Hello {name}",
    image: null,
    claiming: true,
    cooldownSeconds: null,
    memberLimit: 5,
    totalLimit: 50,
    slowModeSeconds: null,
    requireTopic: false,
    questions: [],
    ...over,
  };
}

function ticket(over: Partial<TicketDTO> = {}): TicketDTO {
  return {
    id: "t-1",
    guildId: "g1",
    number: 7,
    openerDiscordId: "member-1",
    assigneeDiscordId: null,
    categoryId: "cat-1",
    categoryKey: "support",
    categoryName: "Support",
    status: "OPEN",
    channelId: null,
    subject: null,
    topic: null,
    claimedByDiscordId: null,
    claimedAt: null,
    closeRequestedByDiscordId: null,
    closeRequestedAt: null,
    lastMessageAt: null,
    firstStaffReplyAt: null,
    feedbackRating: null,
    transcriptReady: false,
    closeReason: null,
    createdAt: "2026-08-18T12:00:00.000Z",
    closedAt: null,
    ...over,
  };
}

function panel(over: Partial<TicketPanelDTO> = {}): TicketPanelDTO {
  return {
    id: "p-1",
    guildId: "g1",
    name: "Help",
    channelId: "chan-panel",
    messageId: null,
    title: "Need a hand?",
    description: null,
    image: null,
    thumbnail: null,
    style: "BUTTONS",
    categoryKeys: ["support"],
    updatedAt: null,
    ...over,
  };
}

interface HarnessOptions {
  readonly categories?: readonly TicketCategoryDTO[];
  readonly settings?: TicketSettingsDTO;
  readonly panel?: TicketPanelDTO | null;
  readonly open?: readonly TicketDTO[];
  readonly mine?: readonly TicketDTO[];
  readonly roles?: readonly string[] | null;
  /** Null makes every channel creation fail, which is a tested path. */
  readonly channelId?: string | null;
  readonly postFails?: boolean;
  readonly editFails?: boolean;
  readonly byChannel?: TicketDTO | null;
  /** What `getTicket` answers with, for the by-id paths. */
  readonly ticketById?: TicketDTO;
}

/** The gateway, its fakes, and an ordered log of every side effect. */
function harness(options: HarnessOptions = {}) {
  const steps: string[] = [];
  const posts: { channelId: string; message: OutboundMessage }[] = [];
  const dms: { discordId: string; message: OutboundMessage }[] = [];
  const created: NewChannelRequest[] = [];
  const recorded: { input: { discordMessageId: string }; fromStaff: boolean }[] = [];
  const panelMessages: (string | null)[] = [];
  const disposed: { channelId: string; archive: boolean }[] = [];
  let opened: TicketDTO = ticket();
  let messageId = 0;

  const config: TicketConfigPort = {
    settings: async () => options.settings ?? settings(),
    categories: async () => options.categories ?? [category()],
    panel: async () => (options.panel === undefined ? panel() : options.panel),
    async recordPanelMessage(_g, _p, _c, id) {
      panelMessages.push(id);
    },
  };

  const archive: TicketArchivePort = {
    async record(input, fromStaff) {
      recorded.push({ input, fromStaff });
    },
    async markEdited() {},
    async markDeleted() {},
    messages: async () => [],
    async bindChannel(ticketId, channelId) {
      steps.push(`bind:${ticketId}:${channelId}`);
      opened = { ...opened, channelId };
    },
    recent: async () => [],
    countSince: async () => 0,
  };

  const discord: TicketDiscordPort = {
    memberRoles: async () => (options.roles === undefined ? ["role-staff"] : options.roles),
    memberNames: async () => ({ username: "Ada", nickname: "Ada" }),
    userTag: async () => "ada#0001",
    async createChannel(request) {
      steps.push("create-channel");
      created.push(request);
      return options.channelId === undefined ? "chan-1" : options.channelId;
    },
    async post(channelId, message) {
      steps.push(`post:${channelId}`);
      posts.push({ channelId, message });
      if (options.postFails === true) return null;
      messageId += 1;
      return `msg-${messageId}`;
    },
    async edit() {
      steps.push("edit");
      return options.editFails !== true;
    },
    async dm(discordId, message) {
      dms.push({ discordId, message });
      return true;
    },
    async disposeChannel(channelId, archiveIt) {
      steps.push("dispose");
      disposed.push({ channelId, archive: archiveIt });
    },
  };

  const community = {
    async openTicket(input: { guildId: string; openerDiscordId: string; topic?: string | null }) {
      steps.push("open-row");
      opened = ticket({ guildId: input.guildId, openerDiscordId: input.openerDiscordId, topic: input.topic ?? null });
      return { ok: true, value: opened };
    },
    listTickets: async (_g: string, opener?: string) => ({
      ok: true as const,
      value: opener === undefined ? (options.open ?? []) : (options.mine ?? []),
    }),
    getTicket: async () => ({ ok: true as const, value: options.ticketById ?? opened }),
    getTicketByChannel: async () => ({
      ok: true as const,
      value: options.byChannel === undefined ? ticket({ channelId: "chan-1" }) : options.byChannel,
    }),
    claimTicket: async () => ({ ok: true as const, value: opened }),
    releaseTicket: async () => ({ ok: true as const, value: opened }),
    requestTicketClose: async () => ({ ok: true as const, value: opened }),
    async closeTicket() {
      steps.push("close-row");
      return { ok: true as const, value: opened };
    },
  } as unknown as CommunityService;

  const guildConfig = {
    get: async () => ({ ok: true as const, value: { timezone: "UTC" } }),
  } as unknown as GuildConfigService;

  const gateway = new TicketGateway({
    community,
    config: guildConfig,
    tickets: config,
    archive,
    discord,
    guildName: async () => "Skyblock and Relax",
    log: silent,
    now: () => new Date("2026-08-18T12:30:00.000Z"),
  });

  return { gateway, steps, posts, dms, created, recorded, panelMessages, disposed };
}

// ── panels ───────────────────────────────────────────────────────────────────

test("a panel that has never been posted is posted, and the message recorded", async () => {
  const { gateway, steps, panelMessages } = harness();
  const result = await gateway.publishPanel("g1", "p-1");
  assert.equal(result.ok && result.edited, false);
  assert.deepEqual(steps, ["post:chan-panel"]);
  assert.deepEqual(panelMessages, ["msg-1"]);
});

test("a panel that has been posted is edited, not posted again", async () => {
  // Reposting would leave a trail of dead panels behind, each with live
  // buttons on it, and members would keep pressing the oldest one.
  const { gateway, steps } = harness({ panel: panel({ messageId: "msg-old" }) });
  const result = await gateway.publishPanel("g1", "p-1");
  assert.equal(result.ok && result.edited, true);
  assert.deepEqual(steps, ["edit"]);
});

test("a panel whose message somebody deleted heals into a fresh post", async () => {
  const { gateway, steps, panelMessages } = harness({
    panel: panel({ messageId: "msg-gone" }),
    editFails: true,
  });
  const result = await gateway.publishPanel("g1", "p-1");
  assert.equal(result.ok, true);
  assert.deepEqual(steps, ["edit", "post:chan-panel"]);
  assert.deepEqual(panelMessages, ["msg-1"]);
});

test("a panel that could not be posted un-records its message and says so", async () => {
  // A stored id pointing at nothing would send every future publish down the
  // edit path, to fail the same way — this is the one failure that would
  // otherwise be permanent.
  const { gateway, panelMessages } = harness({ panel: panel({ messageId: "msg-old" }), editFails: true, postFails: true });
  const result = await gateway.publishPanel("g1", "p-1");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.problem, "NOT_POSTED");
  assert.deepEqual(panelMessages, [null]);
});

test("a panel with no channel is refused before anything is rendered", async () => {
  const { gateway, steps } = harness({ panel: panel({ channelId: null }) });
  const result = await gateway.publishPanel("g1", "p-1");
  assert.equal(!result.ok && result.problem, "NO_CHANNEL");
  assert.deepEqual(steps, []);
});

// ── opening ──────────────────────────────────────────────────────────────────

const opener = { discordId: "member-1", username: "Ada", nickname: "Ada", roleIds: [] as string[] };

test("the row is written before the channel and bound after it", async () => {
  // The channel name interpolates {num}, which does not exist until the row
  // does. A channel created but never bound is visible and recoverable; a row
  // pointing at a channel that was never made is not.
  const { gateway, steps } = harness();
  const result = await gateway.open({
    guildId: "g1",
    discordGuildId: "d1",
    categoryKey: "support",
    opener,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(steps.slice(0, 3), ["open-row", "create-channel", "bind:t-1:chan-1"]);
});

test("the ticket channel is created for the opener and the category's staff, nobody else", async () => {
  const { gateway, created } = harness();
  await gateway.open({ guildId: "g1", discordGuildId: "d1", categoryKey: "support", opener });
  assert.deepEqual(created[0]?.viewerUserIds, ["member-1"]);
  assert.deepEqual(created[0]?.viewerRoleIds, ["role-staff"]);
  assert.equal(created[0]?.name, "ticket-7");
});

test("a greeting that could not be posted still leaves an open ticket", async () => {
  // The conversation is the point; the embed is decoration. Failing the open
  // here would cost the member their ticket over a missing Embed Links.
  const { gateway } = harness({ postFails: true });
  const result = await gateway.open({ guildId: "g1", discordGuildId: "d1", categoryKey: "support", opener });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.channelId, "chan-1");
});

test("a channel that could not be created does not roll the ticket back", async () => {
  // The row stays so staff can see the attempt, and the member is told to ask
  // for help rather than silently getting nothing.
  const { gateway, steps } = harness({ channelId: null });
  const result = await gateway.open({ guildId: "g1", discordGuildId: "d1", categoryKey: "support", opener });
  assert.equal(!result.ok && result.problem, "NO_CHANNEL");
  assert.deepEqual(steps, ["open-row", "create-channel"]);
});

test("a category the member lacks the role for never reaches the database", async () => {
  const { gateway, steps } = harness({ categories: [category({ requiredRoleIds: ["role-vip"] })] });
  const result = await gateway.open({ guildId: "g1", discordGuildId: "d1", categoryKey: "support", opener });
  assert.equal(!result.ok && result.problem, "NOT_ELIGIBLE");
  assert.deepEqual(steps, []);
});

test("a category that has been switched off is gone, not merely refused", async () => {
  const { gateway } = harness({ categories: [category({ enabled: false })] });
  const result = await gateway.open({ guildId: "g1", discordGuildId: "d1", categoryKey: "support", opener });
  assert.equal(!result.ok && result.problem, "NO_CATEGORY");
});

test("the greeting pings the opener and the category's ping roles, and nothing else", async () => {
  const { gateway, posts } = harness({ categories: [category({ pingRoleIds: ["role-ping"] })] });
  await gateway.open({ guildId: "g1", discordGuildId: "d1", categoryKey: "support", opener });
  const greeting = posts.at(-1);
  assert.deepEqual(greeting?.message.mentionUsers, ["member-1"]);
  assert.deepEqual(greeting?.message.mentionRoles, ["role-ping"]);
});

test("the answers a member typed are carried onto the opening embed", async () => {
  const { gateway, posts } = harness({
    categories: [
      category({
        questions: [
          { id: "q1", label: "What happened?", placeholder: null, style: "PARAGRAPH", required: true, maxLength: null },
        ],
      }),
    ],
  });
  await gateway.open({
    guildId: "g1",
    discordGuildId: "d1",
    categoryKey: "support",
    opener,
    answers: { q1: "My island is gone" },
  });
  const fields = posts.at(-1)?.message.embeds?.[0]?.fields ?? [];
  assert.deepEqual(
    fields.map((f) => [f.name, f.value]),
    [["What happened?", "My island is gone"]],
  );
});

// ── staff-ness ───────────────────────────────────────────────────────────────

test("staff-ness comes from the category's own roles", async () => {
  const { gateway } = harness({ roles: ["role-staff"] });
  assert.equal(await gateway.isStaff(ticket(), "u1", "d1"), true);
});

test("a member whose roles could not be read is not staff", async () => {
  // Fails closed: an outage must not hand somebody else's ban appeal to a
  // member who happened to press Claim while the gateway was unhappy.
  const { gateway } = harness({ roles: null });
  assert.equal(await gateway.isStaff(ticket(), "u1", "d1"), false);
});

test("a category with no staff roles leaves nobody staff", async () => {
  const { gateway } = harness({ categories: [category({ staffRoleIds: [] })] });
  assert.equal(await gateway.isStaff(ticket(), "u1", "d1"), false);
});

// ── capture ──────────────────────────────────────────────────────────────────

const captured = {
  channelId: "chan-1",
  discordMessageId: "m-1",
  authorDiscordId: "member-1",
  authorTag: "ada#0001",
  content: "hello",
  attachments: [],
  createdAt: new Date("2026-08-18T12:15:00.000Z"),
  fromBot: false,
};

test("a message outside any ticket is not recorded", async () => {
  const { gateway, recorded } = harness({ byChannel: null });
  assert.equal(await gateway.capture(captured), false);
  assert.deepEqual(recorded, []);
});

test("the opener's own message is not a staff reply", async () => {
  // `fromStaff` stamps firstStaffReplyAt, which is the input to the average
  // response time — counting the opener would report every ticket as answered
  // instantly.
  const { gateway, recorded } = harness();
  assert.equal(await gateway.capture(captured), true);
  assert.equal(recorded[0]?.fromStaff, false);
});

test("the bot's own greeting is captured but never counts as a reply", async () => {
  const { gateway, recorded } = harness();
  await gateway.capture({ ...captured, authorDiscordId: "bot-1", fromBot: true });
  assert.equal(recorded[0]?.fromStaff, false);
});

test("somebody else answering is a staff reply", async () => {
  const { gateway, recorded } = harness();
  await gateway.capture({ ...captured, authorDiscordId: "staff-1" });
  assert.equal(recorded[0]?.fromStaff, true);
});

// ── closing ──────────────────────────────────────────────────────────────────

test("the transcript is delivered before the channel is disposed of", async () => {
  // Disposal may delete the channel, and a transcript that failed to send is
  // worth knowing about while the conversation still exists.
  const { gateway, steps, dms } = harness();
  const result = await gateway.close("chan-1", "staff-1", "d1", "resolved");
  assert.equal(result.ok, true);
  assert.equal(dms.length, 1);
  assert.ok(steps.indexOf("close-row") < steps.indexOf("dispose"));
});

test("archiving is what the setting says, not what the caller assumes", async () => {
  const { gateway, disposed } = harness({ settings: settings({ archiveEnabled: false }) });
  await gateway.close("chan-1", "staff-1", "d1", null);
  assert.deepEqual(disposed, [{ channelId: "chan-1", archive: false }]);
});

test("a press in a channel that is not a ticket says so rather than failing", async () => {
  const { gateway } = harness({ byChannel: null });
  const result = await gateway.claim("chan-x", "staff-1", "d1");
  assert.equal(!result.ok && result.problem, "NOT_A_TICKET");
});

// ── copy ─────────────────────────────────────────────────────────────────────

test("every refusal reads as something a member can act on", () => {
  // The reason enum is the thing that grows; a new member of it that nobody
  // wrote copy for would otherwise reach a member as an empty message.
  for (const reason of [
    "BLOCKED",
    "CATEGORY_DISABLED",
    "MISSING_ROLE",
    "MEMBER_LIMIT",
    "TOTAL_LIMIT",
  ] as const) {
    const message = eligibilityMessage({ allowed: false, reason, retryAfterSeconds: null, opensAt: null });
    assert.ok(message.length > 0, reason);
  }
  assert.match(
    eligibilityMessage({ allowed: false, reason: "COOLDOWN", retryAfterSeconds: 90, opensAt: null }),
    /2 minutes/,
  );
  assert.equal(eligibilityMessage({ allowed: true, reason: "OK", retryAfterSeconds: null, opensAt: null }), "");
});

// ── sweep ────────────────────────────────────────────────────────────────────

test("a sweep for a ticket in another server is not answered at all", async () => {
  // The worker holds ids from its own database read, and the guild in the path
  // is what the caller claims. Disagreement is a caller error, not a ticket.
  const { gateway, steps } = harness({ ticketById: ticket({ guildId: "g1", channelId: "chan-1" }) });

  assert.equal(await gateway.sweepById("g2", "t-1", false), null);
  assert.deepEqual(steps, []);
});

test("a quiet ticket is warned once, in its own channel", async () => {
  const { gateway, posts } = harness({
    settings: settings({ staleAfterMinutes: 10 }),
    ticketById: ticket({ channelId: "chan-1", lastMessageAt: "2026-08-18T12:00:00.000Z" }),
  });

  assert.equal(await gateway.sweepById("g1", "t-1", false), "WARN_STALE");
  assert.equal(posts[0]?.channelId, "chan-1");
  // Addressed to the person who opened it, or the warning reaches nobody.
  assert.equal(posts[0]?.message.content, "<@member-1>");

  // Same ticket, already warned: the second pass says nothing.
  const second = harness({
    settings: settings({ staleAfterMinutes: 10 }),
    ticketById: ticket({ channelId: "chan-1", lastMessageAt: "2026-08-18T12:00:00.000Z" }),
  });
  assert.equal(await second.gateway.sweepById("g1", "t-1", true), "NONE");
  assert.deepEqual(second.posts, []);
});

test("past the window the ticket closes itself and the channel goes with it", async () => {
  const { gateway, steps, disposed } = harness({
    settings: settings({ staleAfterMinutes: 10, autoCloseAfterMinutes: 20 }),
    ticketById: ticket({ channelId: "chan-1", lastMessageAt: "2026-08-18T11:00:00.000Z" }),
  });

  assert.equal(await gateway.sweepById("g1", "t-1", true), "AUTO_CLOSE");
  // Closed first, disposed last: a channel deleted before the row is written
  // is a conversation with no record of why it ended.
  assert.equal(steps[0], "close-row");
  assert.equal(steps.at(-1), "dispose");
  assert.deepEqual(disposed, [{ channelId: "chan-1", archive: true }]);
});
