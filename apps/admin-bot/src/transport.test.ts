import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAdminRegistry, FEATURE_SELECT_NAMESPACE } from "@sbr/commands-admin";
import { ComponentRouter } from "@sbr/discord-kit";
import type { CommandArgs } from "@sbr/shared-types";
import type { AdminApp } from "./composition.js";
import { attachFeatureMenu, buildCommands } from "./transport.js";

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
