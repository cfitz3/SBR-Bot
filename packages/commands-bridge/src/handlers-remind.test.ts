import assert from "node:assert/strict";
import { test } from "node:test";
import { noArgs, recordArgs } from "@sbr/shared-types";
import type { CommandArgs, ReminderDTO, ReminderPort } from "@sbr/shared-types";
import {
  MAX_PENDING_REMINDERS,
  MAX_REMINDER_TEXT,
  parseReminderDelay,
  reminderSpecs,
} from "./handlers-remind.js";
import type { CommandContext, HandlerDeps } from "./types.js";

const GUILD = "guild-1";
const CALLER = "111";
const CHANNEL = "chan-1";

interface Store {
  readonly created: Parameters<ReminderPort["create"]>[0][];
  readonly cancelled: string[];
  pending: ReminderDTO[];
  cancelOk: boolean;
}

function store(over: Partial<Store> = {}): Store {
  return { created: [], cancelled: [], pending: [], cancelOk: true, ...over };
}

function deps(s: Store, wired = true): HandlerDeps {
  if (!wired) return {} as unknown as HandlerDeps;
  const reminders: ReminderPort = {
    async create(input) {
      s.created.push(input);
      return { id: "r-new", ...input, dueAt: input.dueAt.toISOString() };
    },
    async listDue() {
      return [];
    },
    async markDelivered() {
      return 0;
    },
    async listPendingFor() {
      return s.pending;
    },
    async cancel(_g, _d, id) {
      s.cancelled.push(id);
      return s.cancelOk;
    },
    async countPendingFor() {
      return s.pending.length;
    },
  };
  return { reminders } as unknown as HandlerDeps;
}

function run(name: string, args: CommandArgs, s: Store, over: Partial<CommandContext> = {}, wired = true) {
  const spec = reminderSpecs().find((x) => x.name === name);
  assert.ok(spec);
  const ctx: CommandContext = {
    guildId: GUILD,
    userId: CALLER,
    channelId: CHANNEL,
    surface: "BRIDGE_BOT",
    args,
    ...over,
  };
  return spec.handler(ctx, deps(s, wired));
}

function reminder(over: Partial<ReminderDTO> = {}): ReminderDTO {
  return {
    id: "r1",
    guildId: GUILD,
    discordId: CALLER,
    channelId: CHANNEL,
    text: "check auctions",
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  };
}

test("compound durations parse; anything that is not one is refused", () => {
  assert.equal(parseReminderDelay("30m"), 1_800_000);
  assert.equal(parseReminderDelay("2h30m"), 9_000_000);
  assert.equal(parseReminderDelay("1w 2d"), 604_800_000 + 172_800_000);
  assert.equal(parseReminderDelay("45s"), 45_000);

  // Trailing or leading text must not be silently dropped.
  assert.equal(parseReminderDelay("tomorrow"), null);
  assert.equal(parseReminderDelay("5 bananas"), null);
  assert.equal(parseReminderDelay("2h maybe"), null);
  assert.equal(parseReminderDelay(""), null);
  assert.equal(parseReminderDelay("0m"), null);
});

test("a reminder is stored against the channel it was set in", async () => {
  const s = store();
  const reply = await run("remind", recordArgs({ when: "2h", about: "check auctions" }), s);

  assert.equal(s.created.length, 1);
  assert.equal(s.created[0]?.channelId, CHANNEL);
  assert.equal(s.created[0]?.discordId, CALLER);
  assert.equal(s.created[0]?.text, "check auctions");
  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /check auctions/);
});

test("a surface with no channel is told so rather than having the reminder dropped", async () => {
  const s = store();
  const reply = await run("remind", recordArgs({ when: "2h", about: "x" }), s, { channelId: undefined });

  assert.deepEqual(s.created, []);
  assert.match(reply.text, /need a channel/);
});

test("too soon, too far out, and unparseable are each refused with their own reason", async () => {
  const s = store();
  const soon = await run("remind", recordArgs({ when: "10s", about: "x" }), s);
  const far = await run("remind", recordArgs({ when: "400d", about: "x" }), s);
  const junk = await run("remind", recordArgs({ when: "soonish", about: "x" }), s);

  assert.match(soon.text, /shortest/);
  assert.match(far.text, /longest/);
  assert.match(junk.text, /didn't understand/);
  assert.deepEqual(s.created, []);
});

test("empty and oversized text are refused", async () => {
  const s = store();
  const empty = await run("remind", recordArgs({ when: "1h", about: "   " }), s);
  const huge = await run("remind", recordArgs({ when: "1h", about: "x".repeat(MAX_REMINDER_TEXT + 1) }), s);

  assert.match(empty.text, /what to remind you/);
  assert.match(huge.text, new RegExp(String(MAX_REMINDER_TEXT)));
  assert.deepEqual(s.created, []);
});

test("the per-member cap is enforced and points at the way to clear it", async () => {
  const s = store({
    pending: Array.from({ length: MAX_PENDING_REMINDERS }, (_, i) => reminder({ id: `r${String(i)}` })),
  });
  const reply = await run("remind", recordArgs({ when: "1h", about: "x" }), s);

  assert.deepEqual(s.created, []);
  assert.match(reply.text, /\/reminders/);
});

test("the listing is the caller's own, ephemeral, and carries the ids to cancel with", async () => {
  const s = store({ pending: [reminder({ id: "r-abc" })] });
  const reply = await run("reminders", noArgs, s);

  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /r-abc/);
  assert.match(reply.embed?.description ?? "", /check auctions/);
});

test("an empty list says so rather than rendering an empty card", async () => {
  const reply = await run("reminders", noArgs, store());
  assert.match(reply.text, /no reminders/);
  assert.equal(reply.embed, undefined);
});

test("cancelling passes the caller through, so one id cannot reach another member's reminder", async () => {
  const s = store();
  await run("reminders", recordArgs({ cancel: " r-abc " }), s);
  assert.deepEqual(s.cancelled, ["r-abc"]);
});

test("cancelling something that is not yours is reported, not silently accepted", async () => {
  const s = store({ cancelOk: false });
  const reply = await run("reminders", recordArgs({ cancel: "r-other" }), s);
  assert.match(reply.text, /no pending reminder with that id/);
});

test("without the port wired, both commands say reminders are not set up", async () => {
  for (const name of ["remind", "reminders"]) {
    const reply = await run(name, recordArgs({ when: "1h", about: "x" }), store(), {}, false);
    assert.equal(reply.ephemeral, true, name);
    assert.match(reply.text, /aren't set up/, name);
  }
});
