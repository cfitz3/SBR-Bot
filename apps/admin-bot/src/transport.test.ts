import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAdminRegistry } from "@sbr/commands-admin";
import { ComponentRouter } from "@sbr/discord-kit";
import type { CommandArgs } from "@sbr/shared-types";
import { attachLockdownButtons, buildCommands } from "./transport.js";

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
