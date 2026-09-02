import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAdminRegistry, FEATURE_SELECT_NAMESPACE } from "@sbr/commands-admin";
import { ComponentRouter } from "@sbr/discord-kit";
import type { AdminContext } from "@sbr/commands-admin";
import type { CommandArgs } from "@sbr/shared-types";
import type { AdminApp } from "./composition.js";
import { attachCaseSelect, attachFeatureMenu, buildCommands } from "./transport.js";

interface Payload {
  name: string;
  description: string;
  options?: { name: string; required?: boolean }[];
}

const payload = (): Payload[] => buildCommands() as Payload[];

test("every registered command has a handler behind it", () => {
  const registry = buildAdminRegistry();
  const names = payload().map((c) => c.name);
  assert.deepEqual([...names].sort(), [...registry.keys()].sort());
});

test("required options precede optional ones (Discord rejects otherwise)", () => {
  for (const command of payload()) {
    const flags = (command.options ?? []).map((o) => o.required ?? false);
    const sorted = [...flags].sort((a, b) => Number(b) - Number(a));
    assert.deepEqual(flags, sorted, `${command.name} has a required option after an optional one`);
  }
});

test("ban is published with a confirm option, matching the destructive gate", () => {
  const ban = payload().find((c) => c.name === "ban");
  assert.ok(ban, "ban should be registered");
  assert.ok(ban.options?.some((o) => o.name === "confirm"));
});

test("/audit publishes the date range options the panel and the command share", () => {
  const audit = payload().find((c) => c.name === "audit");
  const names = (audit?.options ?? []).map((o) => o.name);
  assert.ok(names.includes("from") && names.includes("to"), "a case id must never be the only way in");
});

/**
 * The case menu is routed back through the dispatcher rather than reading the
 * case out of the service, so that the role gate, the per-guild policy floor
 * and the handler are the same ones a typed `/case` goes through. This asserts
 * that hop, because the failure it prevents — a menu that answers to anybody who
 * can see the message — is invisible from the outside.
 */
test("the case menu dispatches /case with the picked id, not a second data path", async () => {
  const seen: { name: string; guildId: string; actorId: string; id: string | null }[] = [];
  const replies: unknown[] = [];
  const router = new ComponentRouter();
  attachCaseSelect(router, {
    async resolveGuild() { return "g1"; },
    dispatcher: {
      async dispatch(name: string, ctx: AdminContext) {
        seen.push({ name, guildId: ctx.guildId, actorId: ctx.actorId, id: ctx.args.getString("id") });
        return { ephemeral: false, text: "ok" };
      },
    },
  } as unknown as AdminApp);

  await router.handle({
    customId: "case",
    guildId: "discord-guild",
    channelId: "c1",
    user: { id: "staffer" },
    values: ["act-1f3b"],
    isStringSelectMenu: () => true,
    async reply(options: unknown) { replies.push(options); },
  } as never);

  assert.deepEqual(seen, [{ name: "case", guildId: "g1", actorId: "staffer", id: "act-1f3b" }]);
  // Ephemeral whatever the handler said: more than one staffer can be reading
  // the same `/audit` output, and a case card is not for the channel.
  assert.equal((replies[0] as { flags?: number }).flags !== undefined, true);
});

test("a menu from a server the platform does not know says so instead of dispatching", async () => {
  let dispatched = 0;
  const router = new ComponentRouter();
  attachCaseSelect(router, {
    async resolveGuild() { return null; },
    dispatcher: { async dispatch() { dispatched += 1; return { ephemeral: true, text: "" }; } },
  } as unknown as AdminApp);

  let content = "";
  await router.handle({
    customId: "case",
    guildId: "stranger",
    channelId: "c1",
    user: { id: "staffer" },
    values: ["act-1"],
    isStringSelectMenu: () => true,
    async reply(o: { content: string }) { content = o.content; },
  } as never);

  assert.equal(dispatched, 0);
  assert.match(content, /isn't set up/);
});

test("the feature menu dispatches the command rather than writing the flag itself", async () => {
  // The write is ADMIN-gated. A component handler that called setFeature would
  // hand that gate to anyone who can see the message the menu is attached to —
  // a hole that is invisible from the outside, because the card looks the same.
  const dispatched: Array<{ name: string; guildId: string; actorId: string; set: string | null }> = [];
  let updated: Record<string, unknown> | null = null;
  const app = {
    async resolveGuild() { return "g1"; },
    dispatcher: {
      async dispatch(name: string, ctx: { guildId: string; actorId: string; args: CommandArgs }) {
        dispatched.push({ name, guildId: ctx.guildId, actorId: ctx.actorId, set: ctx.args.getString("set") });
        return { text: "", ephemeral: true, embed: { title: "Features", color: "INFO" as const } };
      },
    },
  } as unknown as AdminApp;

  const router = new ComponentRouter({ onError() {} });
  attachFeatureMenu(router, app);
  const routed = await router.handle({
    customId: FEATURE_SELECT_NAMESPACE,
    guildId: "discord-guild",
    channelId: "chan",
    user: { id: "staffer" },
    values: ["welcome:off"],
    isStringSelectMenu: () => true,
    async update(payload: Record<string, unknown>) { updated = payload; },
  } as never);

  assert.equal(routed, true);
  assert.deepEqual(dispatched, [
    { name: "feature-toggle", guildId: "g1", actorId: "staffer", set: "welcome:off" },
  ]);
  assert.ok(updated, "the card is replaced in place, not answered beside");
  assert.equal("flags" in (updated as Record<string, unknown>), false, "update inherits visibility; naming it is rejected");
});
