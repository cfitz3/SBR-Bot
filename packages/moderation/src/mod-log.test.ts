import assert from "node:assert/strict";
import test from "node:test";
import { checkEmbed } from "@sbr/embed-kit";
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

/**
 * One labelled line out of the consolidated "Case" field.
 *
 * The member, the staffer, the duration and the expiry used to be four inline
 * fields; they are four short facts always read together, so they are one field
 * now. The tests read them the same way a reader does — by label — rather than
 * by field, so the assertions stay about what the card says.
 */
const fact = (view: ReturnType<typeof modLogEmbed>, label: string): string | undefined =>
  field(view, "Case")
    ?.split("\n")
    .find((line) => line.startsWith(`**${label}** `))
    ?.slice(label.length + 5);

test("the card names the member, the staffer, the duration and the reason", () => {
  const view = modLogEmbed(action(), NOW);
  assert.equal(view.title, "Muted");
  assert.equal(fact(view, "Member"), "<@member>");
  assert.equal(fact(view, "Staff"), "<@staff>");
  assert.equal(fact(view, "Duration"), "1h");
  assert.equal(field(view, "Reason"), "spam");
  assert.match(view.footer ?? "", /act-1f3b/);
});

test("the card is dated by when the punishment happened, not by when it was sent", () => {
  // A live post makes those the same instant. `/case` renders this same card
  // months later, and a case with no date at all — which is what this renderer
  // used to produce — is the version of the card that is actively unhelpful.
  const view = modLogEmbed(action(), NOW);
  assert.equal(view.timestamp, "2026-03-01T11:00:00.000Z");
});

test("the card is legal to send and inside the house style", () => {
  // The style checker is what keeps this renderer honest now that it goes
  // through `card()`: an empty field value or a hand-built footer would be
  // caught here rather than by Discord refusing the message.
  const issues = checkEmbed(modLogEmbed(action(), NOW)).filter((i) => i.severity === "error");
  assert.deepEqual(issues, []);
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
  assert.equal(fact(modLogEmbed(action({ actorDiscordId: AUTOMOD_ACTOR }), NOW), "Staff"), "Automod");
  assert.equal(
    fact(modLogEmbed(action({ actorDiscordId: EXPIRY_ACTOR, type: "UNMUTE" }), NOW), "Staff"),
    "Expired (automatic)",
  );
});

test("expiry is a relative timestamp, and reads as past once it has passed", () => {
  const soon = modLogEmbed(action(), NOW);
  assert.match(fact(soon, "Expires") ?? "", /^<t:\d+:R>$/);
  const gone = modLogEmbed(action({ expiresAt: "2026-03-01T11:30:00.000Z" }), NOW);
  assert.match(fact(gone, "Expired") ?? "", /^<t:\d+:R>$/);
  // The state moved out of the footer and into the headline, where a reader
  // scanning the channel meets it first instead of last.
  assert.match(gone.description ?? "", /expired/);
});

test("a punishment still running says nothing extra in the headline", () => {
  // Every card would otherwise open with "active", which is the default state
  // and therefore no information at all.
  assert.equal(modLogEmbed(action(), NOW).description, undefined);
});

test("a permanent ban shows no duration or expiry line", () => {
  const view = modLogEmbed(action({ type: "BAN", durationSeconds: null, expiresAt: null }), NOW);
  assert.equal(fact(view, "Duration"), undefined);
  assert.equal(fact(view, "Expires"), undefined);
  assert.equal(view.footer, "Case act-1f3b");
});

test("an action on a member with no Discord account still renders", () => {
  const view = modLogEmbed(action({ targetDiscordId: null }), NOW);
  assert.equal(fact(view, "Member"), "an unlinked member");
});

test("a voided ban stops reading as a ban", () => {
  // The card outlives the decision it recorded. A withdrawn case that kept its
  // red bar and said nothing about being withdrawn is the same silence this
  // module was written to remove, pointed the other way.
  const view = modLogEmbed(
    action({ type: "BAN", active: false, voidedAt: "2026-03-01T11:45:00.000Z", voidReason: "wrong person" }),
    NOW,
  );
  assert.equal(view.color, "NEUTRAL");
  assert.equal(field(view, "Voided"), "wrong person");
  assert.match(view.description ?? "", /voided/);
});
