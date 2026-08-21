import assert from "node:assert/strict";
import { test } from "node:test";
import { recordArgs } from "@sbr/shared-types";
import type { CommandArgs, TicketTagDTO } from "@sbr/shared-types";
import { tagSpecs } from "./handlers-tags.js";
import type { CommandContext, HandlerDeps } from "./types.js";

const GUILD = "guild-1";

function tag(over: Partial<TicketTagDTO> = {}): TicketTagDTO {
  return {
    id: "t1",
    guildId: GUILD,
    name: "Welcome",
    content: "Welcome! Read the rules first.",
    autoPattern: null,
    scope: "TICKET",
    enabled: true,
    ...over,
  };
}

function deps(tags: readonly TicketTagDTO[] | null, throws = false): HandlerDeps {
  if (tags === null) return {} as unknown as HandlerDeps;
  return {
    tags: {
      async listTags() {
        if (throws) throw new Error("db down");
        return tags;
      },
    },
  } as unknown as HandlerDeps;
}

const spec = (): NonNullable<ReturnType<typeof tagSpecs>[number]> => {
  const found = tagSpecs().find((s) => s.name === "tag");
  assert.ok(found);
  return found;
};

function run(args: CommandArgs, tags: readonly TicketTagDTO[] | null) {
  const ctx: CommandContext = { guildId: GUILD, userId: "111", surface: "BRIDGE_BOT", args };
  return spec().handler(ctx, deps(tags));
}

test("a known tag is posted to the channel, not whispered to the caller", async () => {
  const reply = await run(recordArgs({ name: "welcome" }), [tag()]);
  assert.equal(reply.ephemeral, false);
  assert.equal(reply.text, "Welcome! Read the rules first.");
});

test("a name nobody has is refused privately, so a typo does not become a message", async () => {
  const reply = await run(recordArgs({ name: "rules" }), [tag()]);
  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /no reply called/);
});

test("a disabled tag reads as absent rather than as a configuration error", async () => {
  const reply = await run(recordArgs({ name: "welcome" }), [tag({ enabled: false })]);
  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /no reply called/);
});

test("scope does not gate an explicit ask — a TICKET tag still posts in the open", async () => {
  const reply = await run(recordArgs({ name: "welcome" }), [tag({ scope: "TICKET" })]);
  assert.equal(reply.ephemeral, false);
});

test("an empty name asks for one instead of listing everything", async () => {
  const reply = await run(recordArgs({ name: "   " }), [tag()]);
  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /Which one/);
});

test("without the port wired the command says canned replies are not set up", async () => {
  const reply = await run(recordArgs({ name: "welcome" }), null);
  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /aren't set up/);
});

test("autocomplete offers enabled tags matching what has been typed", async () => {
  const tags = [tag({ id: "1", name: "Welcome" }), tag({ id: "2", name: "Rules" }), tag({ id: "3", name: "Old", enabled: false })];
  const suggest = spec().autocomplete;
  assert.ok(suggest);

  const all = await suggest({ name: "name", value: "" }, { guildId: GUILD, userId: "111" }, deps(tags));
  assert.deepEqual(all.map((c) => c.value), ["Welcome", "Rules"]);

  const filtered = await suggest({ name: "name", value: " wel " }, { guildId: GUILD, userId: "111" }, deps(tags));
  assert.deepEqual(filtered.map((c) => c.value), ["Welcome"]);
});

test("autocomplete stays inside Discord's 25-suggestion limit and survives a failed read", async () => {
  const many = Array.from({ length: 40 }, (_, i) => tag({ id: String(i), name: `Tag${String(i)}` }));
  const suggest = spec().autocomplete;
  assert.ok(suggest);

  const capped = await suggest({ name: "name", value: "tag" }, { guildId: GUILD, userId: "111" }, deps(many));
  assert.equal(capped.length, 25);

  const broken = await suggest({ name: "name", value: "" }, { guildId: GUILD, userId: "111" }, deps([], true));
  assert.deepEqual(broken, []);

  const unwired = await suggest({ name: "name", value: "" }, { guildId: GUILD, userId: "111" }, deps(null));
  assert.deepEqual(unwired, []);
});
