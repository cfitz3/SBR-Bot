import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAdminRegistry,
  FEATURE_SELECT_NAMESPACE,
} from "@sbr/commands-admin";
import { ComponentRouter } from "@sbr/discord-kit";
import type { AdminContext } from "@sbr/commands-admin";
import type { CommandArgs } from "@sbr/shared-types";
import type { AdminApp } from "./composition.js";
import { attachCaseSelect, attachFeatureMenu, attachLockdownButtons, buildCommands } from "./transport.js";

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

test("/lockdown-lift is gone from the published payload, not merely inert", () => {
  // `put` replaces the whole scope, so dropping the spec deregisters the command
  // in Discord's picker. A command that still autocompletes but refuses to work
  // is the thing this slice removed.
  assert.equal(payload().some((c) => c.name === "lockdown-lift"), false);
  const lockdown = payload().find((c) => c.name === "lockdown");
  assert.equal(lockdown?.options?.some((o) => o.name === "action" || o.name === "confirm"), false);
});

test("a lockdown button re-enters the dispatcher rather than writing on its own", async () => {
  // The role floor and the guild's policy override live on the dispatch path.
  // A button that called the safety service directly would be a second route
  // into a privileged write with no permission check on it.
  const seen: { name: string; actorId: string; args: Record<string, string | null> }[] = [];
  const router = new ComponentRouter();
  let updated: unknown = null;
  const app = {
    resolveGuild: async () => "g1",
    dispatcher: {
      async dispatch(name: string, ctx: { actorId: string; args: CommandArgs }) {
        seen.push({
          name,
          actorId: ctx.actorId,
          args: {
            action: ctx.args.getString("action"),
            channel: ctx.args.getChannel("channel"),
            duration: ctx.args.getString("duration"),
            reason: ctx.args.getString("reason"),
          },
        });
        return { text: "", ephemeral: false, embed: { title: "Lockdown" } };
      },
    },
  };
  attachLockdownButtons(router, app as never);

  const handled = await router.handle({
    customId: "lockdown:server:300000000000000001:30m:raid",
    guildId: "77",
    channelId: "300000000000000001",
    user: { id: "staff" },
    async update(payload: unknown) { updated = payload; },
    async reply() { throw new Error("a public reply must update the prompt, not post a second message"); },
  } as never);

  assert.equal(handled, true);
  assert.deepEqual(seen, [
    {
      name: "lockdown",
      actorId: "staff",
      args: { action: "server", channel: "300000000000000001", duration: "30m", reason: "raid" },
    },
  ]);
  assert.ok(updated, "the prompt is edited in place so the warning and the record are one message");
  assert.equal((updated as { flags?: unknown }).flags, undefined, "update() rejects the ephemeral flag");
});

test("a refusal comes back privately instead of editing the public prompt", async () => {
  const router = new ComponentRouter();
  let replied: unknown = null;
  const app = {
    resolveGuild: async () => "g1",
    dispatcher: { async dispatch() { return { text: "You need OFFICER for that.", ephemeral: true }; } },
  };
  attachLockdownButtons(router, app as never);
  await router.handle({
    customId: "lockdown:lift:-:-:",
    guildId: "77",
    channelId: "c1",
    user: { id: "member" },
    async reply(payload: unknown) { replied = payload; },
    async update() { throw new Error("a denial must not rewrite the card everyone can see"); },
  } as never);
  assert.match((replied as { content: string }).content, /OFFICER/);
});

test("the renamed note command is the one published, and the old name is gone", () => {
  // `rest.put` replaces the whole scope, so a spec that is no longer built is
  // deregistered rather than merely inert — which is what a rename has to mean.
  const names = payload().map((c) => c.name);
  assert.equal(names.includes("member-note"), false);
  assert.ok(names.includes("note"));
});

test("the staff utilities publish no action option — the verbs live on the card", () => {
  for (const name of ["tickets", "rolemenu", "sticky"]) {
    const command = payload().find((c) => c.name === name);
    assert.ok(command, `${name} should be registered`);
    assert.equal(
      command.options?.some((o) => o.name === "action"),
      false,
      `${name} still asks for an action up front`,
    );
  }
});

test("tickets takes only the nouns it needs", () => {
  const tickets = payload().find((c) => c.name === "tickets");
  assert.deepEqual(tickets?.options?.map((o) => o.name), ["id", "reason"]);
});
