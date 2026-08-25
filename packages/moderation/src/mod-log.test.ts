import assert from "node:assert/strict";
import test from "node:test";
import type { ModerationActionDTO } from "@sbr/shared-types";
import { modLogEmbed } from "./mod-log.js";
import { AUTOMOD_ACTOR } from "./automod-runner.js";
import { EXPIRY_ACTOR } from "./expiry.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");

function action(over: Partial<ModerationActionDTO> = {}): ModerationActionDTO {
  return {
    id: "act-1f3b",
    guildId: "g1",
    type: "MUTE",
    actorDiscordId: "staff",
    targetDiscordId: "member",
    reason: "spam",
    durationSeconds: 3600,
    expiresAt: "2026-03-01T13:00:00.000Z",
    surfaces: ["DISCORD", "GUILD_CHAT"],
    enforcement: "CONFIRMED",
    enforcementDetail: null,
    active: true,
    createdAt: "2026-03-01T11:00:00.000Z",
    updatedAt: null,
    editedByDiscordId: null,
    voidedAt: null,
    voidReason: null,
    ...over,
  };
}

const field = (view: ReturnType<typeof modLogEmbed>, name: string): string | undefined =>
  view.fields?.find((f) => f.name === name)?.value;

test("the card names the member, the staffer, the duration and the reason", () => {
  const view = modLogEmbed(action(), NOW);
  assert.equal(view.title, "Muted");
  assert.equal(field(view, "Member"), "<@member>");
  assert.equal(field(view, "Staff"), "<@staff>");
  assert.equal(field(view, "Duration"), "1h");
  assert.equal(field(view, "Reason"), "spam");
  assert.match(view.footer ?? "", /act-1f3b/);
});

test("a punishment that did not take says so instead of reading as done", () => {
  // The bug this whole module came out of: a case log that says "banned" while
  // the member is still in the server.
  const view = modLogEmbed(
    action({ type: "BAN", enforcement: "FAILED", enforcementDetail: "missing permission" }),
    NOW,
  );
  assert.equal(field(view, "Enforced"), undefined);
  const failed = view.fields?.find((f) => f.name.includes("Not enforced"));
  assert.match(failed?.value ?? "", /missing permission/);
  assert.match(failed?.value ?? "", /by hand/);
  assert.equal(view.color, "DANGER");
});

test("a warning prints no enforcement field at all", () => {
  const view = modLogEmbed(action({ type: "WARN", enforcement: "NOT_REQUIRED" }), NOW);
  assert.equal(view.fields?.some((f) => /nforce/.test(f.name)), false);
});

test("an enforced action lists the surfaces it reached, and says the guild answered", () => {
  const view = modLogEmbed(action(), NOW);
  // Only an in-game confirmation settles the guild-chat leg as CONFIRMED, so a
  // row that reached GUILD_CHAT is one Hypixel echoed back. Worth saying: the
  // bare surface list previously meant no more than "we typed something".
  assert.equal(field(view, "Enforced"), "DISCORD + GUILD_CHAT\nConfirmed in game by the guild.");
  assert.equal(
    field(modLogEmbed(action({ surfaces: ["DISCORD"] }), NOW), "Enforced"),
    "DISCORD",
    "a Discord-only action makes no claim about the guild",
  );
});

test("a pending action names what it is waiting on", () => {
  const waiting = action({ enforcement: "PENDING", enforcementDetail: "`/g kick Notch x` was sent but not confirmed" });
  assert.equal(
    field(modLogEmbed(waiting, NOW), "Enforcement"),
    "Still in progress — `/g kick Notch x` was sent but not confirmed",
  );
  assert.equal(
    field(modLogEmbed(action({ enforcement: "PENDING" }), NOW), "Enforcement"),
    "Still in progress.",
  );
});

test("the automatic actors read as themselves, not as a snowflake mention", () => {
  assert.equal(field(modLogEmbed(action({ actorDiscordId: AUTOMOD_ACTOR }), NOW), "Staff"), "Automod");
  assert.equal(
    field(modLogEmbed(action({ actorDiscordId: EXPIRY_ACTOR, type: "UNMUTE" }), NOW), "Staff"),
    "Expired (automatic)",
  );
});

test("expiry is a relative timestamp, and reads as past once it has passed", () => {
  const soon = modLogEmbed(action(), NOW);
  assert.match(field(soon, "Expires") ?? "", /^<t:\d+:R>$/);
  const gone = modLogEmbed(action({ expiresAt: "2026-03-01T11:30:00.000Z" }), NOW);
  assert.match(field(gone, "Expired") ?? "", /^<t:\d+:R>$/);
  assert.match(gone.footer ?? "", /expired/);
});

test("a permanent ban shows no duration or expiry line", () => {
  const view = modLogEmbed(action({ type: "BAN", durationSeconds: null, expiresAt: null }), NOW);
  assert.equal(field(view, "Duration"), undefined);
  assert.equal(field(view, "Expires"), undefined);
  assert.equal(view.footer, "Case act-1f3b");
});

test("an action on a member with no Discord account still renders", () => {
  const view = modLogEmbed(action({ targetDiscordId: null }), NOW);
  assert.equal(field(view, "Member"), "an unlinked member");
});
