import assert from "node:assert/strict";
import { test } from "node:test";
import { noArgs } from "@sbr/shared-types";
import type { CommandArgs, PlatformStatusDTO } from "@sbr/shared-types";
import { healthSpecs, renderHealthEmbed } from "./handlers-health.js";
import type { CommandContext, HandlerDeps } from "./types.js";

const CHECKED_AT = "2026-08-22T09:00:00.000Z";

function ctx(args: CommandArgs = noArgs): CommandContext {
  return { guildId: "guild-1", userId: "111", surface: "BRIDGE_BOT", args };
}

function status(over: Partial<PlatformStatusDTO> = {}): PlatformStatusDTO {
  return {
    overall: "ok",
    checkedAt: CHECKED_AT,
    lines: [
      { label: "Guild chat", status: "ok" },
      { label: "Bot", status: "ok" },
      { label: "Hypixel API", status: "ok" },
    ],
    otherUnhealthy: 0,
    ...over,
  };
}

function run(dto?: PlatformStatusDTO) {
  const spec = healthSpecs()[0];
  assert.ok(spec);
  const deps = (dto === undefined ? {} : { status: { status: async () => dto } }) as unknown as HandlerDeps;
  return spec.handler(ctx(), deps);
}

test("the card's age is the check's timestamp, not a sentence in the footer", async () => {
  const embed = renderHealthEmbed(status());
  assert.equal(embed.timestamp, CHECKED_AT);
  assert.equal(embed.footer, undefined);
});

test("every row appears whether it is up or down", () => {
  const embed = renderHealthEmbed(status({ overall: "down", lines: [
    { label: "Guild chat", status: "down" },
    { label: "Bot", status: "ok" },
    { label: "Hypixel API", status: "ok" },
  ] }));

  const rows = embed.fields?.[0]?.value ?? "";
  // A card listing only what is broken reads as "nothing else is checked".
  for (const label of ["Guild chat", "Bot", "Hypixel API"]) assert.match(rows, new RegExp(label));
  assert.equal(embed.color, "DANGER");
});

test("a component the card may not name is still counted", () => {
  const embed = renderHealthEmbed(status({ overall: "degraded", otherUnhealthy: 2 }));
  assert.match(embed.description ?? "", /2 other/);
  assert.equal(embed.color, "WARNING");
});

test("a healthy card does not tell anyone to file a bug", () => {
  const embed = renderHealthEmbed(status());
  assert.equal(embed.color, "SUCCESS");
  assert.doesNotMatch(embed.description ?? "", /bug report/);
});

test("an unhealthy card says what to do next", () => {
  const embed = renderHealthEmbed(status({ overall: "down" }));
  assert.match(embed.description ?? "", /bug report/);
});

test("no probe wired up says so, rather than reporting an outage", async () => {
  const reply = await run();
  assert.equal(reply.embed, undefined);
  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /wired up/);
});

test("the answer is public, because every error message points here", async () => {
  const reply = await run(status());
  assert.equal(reply.ephemeral, false);
  assert.ok(reply.embed);
});

test("health is reachable in guild chat and behind no capability", () => {
  const spec = healthSpecs()[0];
  assert.ok(spec);
  assert.equal(spec.inGame, true);
  // A permission gate here would hide the diagnostic behind the permission
  // whose absence a member might be trying to diagnose.
  assert.equal(spec.capability, undefined);
});
