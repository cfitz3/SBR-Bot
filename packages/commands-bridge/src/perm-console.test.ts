/**
 * The `/perm` console, offline.
 *
 * These are the tests that used to drive `/perm action:… perm:… ign:… role:…`
 * through the dispatcher. The behaviour did not move — the way it is reached
 * did — so they moved with it: what a press does is a fact about the console,
 * and the dispatcher now owes only that `/perm` opens one.
 *
 * Nothing here touches Discord. The console returns view models, and the
 * transport's whole job is to turn them into a message — so the rules that
 * matter (who may edit, which controls are live, what a failure says) are
 * provable without a gateway.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  err,
  ok,
  type IdentityService,
  type LinkedIdentityDTO,
  type PermGroupDTO,
  type PermService,
  type RosterChange,
} from "@sbr/shared-types";
import { theme } from "@sbr/brand";
import {
  activityRows,
  addRoleRows,
  permConsole,
  permConsoleReplies,
  permView,
} from "./perm-console.js";
import type { HandlerDeps } from "./types.js";

const linked: LinkedIdentityDTO = {
  discordId: "111",
  minecraftUuid: "uuid-alpha",
  ign: "Alpha",
  status: "VERIFIED",
  primary: true,
  verifiedAt: "t",
};

/**
 * Two seats of five, so "full" and "empty" are both a deliberate override.
 * `Beta` is unlinked and unsnapshotted, which is the ordinary case for somebody
 * a party owner adds by name.
 */
const aPerm: PermGroupDTO = {
  id: "pm1",
  guildId: "g1",
  ownerDiscordId: "111",
  name: "F7 core",
  activity: "DUNGEONS",
  status: "ACTIVE",
  isDefault: false,
  notes: null,
  capacity: 5,
  createdAt: "2026-08-01T00:00:00.000Z",
  members: [
    { ign: "Alpha", role: "healer", slot: 0, discordId: "111", uuid: "u-alpha", inGuild: true, catacombsLevel: 42, skillAverage: 51.25, roleLevel: 38 },
    { ign: "Beta", role: "berserk", slot: 1, discordId: null, uuid: null, inGuild: null, catacombsLevel: null, skillAverage: null, roleLevel: null },
  ],
};

function perms(over: Partial<PermService> = {}): PermService {
  const base: PermService = {
    async createPerm(input) { return ok({ ...aPerm, id: "new", name: input.name, members: [] }); },
    async getPerm() { return ok(aPerm); },
    async listPerms() { return ok([aPerm]); },
    async addToRoster() { return ok(aPerm); },
    async removeFromRoster() { return ok({ ...aPerm, members: [aPerm.members[0]!] }); },
    async disbandPerm() { return ok({ ...aPerm, status: "DISBANDED" }); },
    async setDefaultPerm() { return ok({ ...aPerm, isDefault: true }); },
    async defaultPermFor() { return ok(aPerm); },
  };
  return { ...base, ...over };
}

function identity(over: Partial<IdentityService> = {}): IdentityService {
  return {
    async resolveByDiscordId() { return ok(linked); },
    async linkByIgn() { return ok(linked); },
    async unlink() { return ok(undefined); },
    async hasCapability() { return true; },
    ...over,
  } as IdentityService;
}

/**
 * The console reads two ports and no others, which is the point of the cast:
 * filling in eight unrelated services to prove that it doesn't would make the
 * dependency claim harder to see rather than easier.
 */
function deps(over: { perms?: PermService; identity?: IdentityService } = {}): HandlerDeps {
  return { perms: over.perms ?? perms(), identity: over.identity ?? identity() } as unknown as HandlerDeps;
}

/** `padInlineRow`'s spacer field. Chrome, not a field the card chose to send. */
const PAD = "​";

function fields(reply: { readonly embed?: { readonly fields?: readonly { name: string; value: string }[] } }) {
  return reply.embed?.fields ?? [];
}

/** The one field the whole roster lives in, found by name rather than by index. */
function party(reply: Parameters<typeof fields>[0]): string {
  return fields(reply).find((f) => f.name === "Party")?.value ?? "";
}

function button(reply: { readonly components?: readonly { readonly buttons: readonly { label: string; disabled?: boolean }[] }[] }, label: string) {
  return (reply.components ?? []).flatMap((r) => r.buttons).find((b) => b.label === label);
}

function select(reply: { readonly components?: readonly { readonly select?: { customId: string; options: readonly { label: string; value: string }[] } }[] }, prefix: string) {
  return (reply.components ?? []).map((r) => r.select).find((s) => s?.customId.startsWith(prefix));
}

// ─────────────────────────────── The list ───────────────────────────────

test("the console lists the guild's parties with a control to open one", async () => {
  const r = await permConsole("g1", 0, deps());
  assert.equal(r.embed?.title, "Standing parties");
  assert.match(r.text, /F7 core 2\/5/);
  const open = select(r, "perm:open");
  assert.deepEqual(open?.options.map((o) => o.value), ["pm1"]);
  assert.ok(button(r, "New party"), "a console you cannot start a party from is a list");
});

test("one page of parties offers no pager, and more than one does", async () => {
  const single = await permConsole("g1", 0, deps());
  assert.equal(button(single, "Next"), undefined, "a Next that cannot go anywhere is furniture");

  const many = Array.from({ length: 12 }, (_, i) => ({ ...aPerm, id: `pm${String(i)}`, name: `Party ${String(i)}` }));
  const r = await permConsole("g1", 0, deps({ perms: perms({ async listPerms() { return ok(many); } }) }));
  assert.equal(button(r, "Back")?.disabled, true, "page one has nothing behind it");
  assert.equal(button(r, "Next")?.disabled, false);
});

test("a page beyond the end lands on the last one rather than an empty card", async () => {
  const r = await permConsoleReplies.page("g1", 99, deps());
  assert.equal(r.embed?.title, "Standing parties");
});

/**
 * The member cannot fix a database. The reply says the one thing they can act
 * on — where to find out whether anything else is down — and is ephemeral,
 * because a failure addressed to the channel helps nobody in it.
 */
test("a console that cannot read the parties points at /health", async () => {
  const down = perms({ async listPerms() { return err(new Error("db down")); } });
  const r = await permConsole("g1", 0, deps({ perms: down }));
  assert.match(r.text, /\/health/);
  assert.equal(r.ephemeral, true);
  assert.equal(r.embed, undefined);
});

// ─────────────────────────────── One party ───────────────────────────────

test("a party puts its whole roster in one field, not one field per seat", async () => {
  const r = await permView("g1", "pm1", "111", deps());
  // Five seats used to mean five fields named after the roles in them. The role
  // is data about the seat, so it belongs in the value with the numbers it
  // qualifies, and the card gets its field budget back.
  assert.deepEqual(fields(r).map((f) => f.name).filter((n) => n !== PAD), ["Party", "Seats", "Owner"]);
  const lines = party(r).split("\n");
  assert.match(lines[0]!, /\*\*Healer\*\* Alpha \(<@111>\) — cata 42 · healer 38/);
  assert.equal(lines[1], "**Berserk** Beta — unlinked");
});

test("a seat is only marked as having left when the cache actually says so", async () => {
  const gone = perms({
    async getPerm() {
      return ok({ ...aPerm, members: [{ ...aPerm.members[0]!, inGuild: false }, aPerm.members[1]!] });
    },
  });
  const lines = party(await permView("g1", "pm1", "111", deps({ perms: gone }))).split("\n");
  assert.match(lines[0]!, /left the guild/);
  // `inGuild: null` is "we don't know", and must not read as an accusation.
  assert.doesNotMatch(lines[1]!, /left the guild/);
});

test("a seat far behind in the class it is played as is marked, and the mark is explained", async () => {
  const lagging = perms({
    async getPerm() { return ok({ ...aPerm, members: [{ ...aPerm.members[0]!, roleLevel: 12 }] }); },
  });
  const r = await permView("g1", "pm1", "111", deps({ perms: lagging }));
  const glyph = theme.embed.glyphs.marker;
  assert.ok(party(r).includes(`**Healer**${glyph}`), "cata 42 sitting as a healer at 12 is the case worth flagging");
  assert.ok((r.embed?.footer ?? "").includes(glyph));
  // A legend only when something wears the glyph; on the ordinary roster there
  // is nothing to explain.
  assert.equal((await permView("g1", "pm1", "111", deps())).embed?.footer, undefined);
});

// ─────────────────────────────── Controls ───────────────────────────────

test("the seat menu is offered only where taking a seat would work", async () => {
  // Somebody already in the party has nothing to take.
  assert.equal(select(await permView("g1", "pm1", "111", deps()), "perm:seat"), undefined);

  const stranger = await permView("g1", "pm1", "999", deps());
  assert.deepEqual(
    select(stranger, "perm:seat")?.options.map((o) => o.value),
    // Every dungeon role including `filler`, which is what a sixth person in a
    // five-class party actually is — the menu is the activity's own shape.
    ["healer", "mage", "berserk", "archer", "tank", "filler"],
  );

  const full = perms({
    async getPerm() {
      return ok({ ...aPerm, members: Array.from({ length: 5 }, (_, i) => ({ ...aPerm.members[1]!, ign: `P${String(i)}`, slot: i })) });
    },
  });
  assert.equal(select(await permView("g1", "pm1", "999", deps({ perms: full })), "perm:seat"), undefined);

  const dead = perms({ async getPerm() { return ok({ ...aPerm, status: "DISBANDED" as const }); } });
  assert.equal(select(await permView("g1", "pm1", "999", deps({ perms: dead })), "perm:seat"), undefined);
});

test("the owner's controls are dead for somebody who is neither owner nor staff", async () => {
  const notStaff = identity({ async hasCapability() { return false; } });
  const r = await permView("g1", "pm1", "999", deps({ identity: notStaff }));
  assert.equal(button(r, "Disband")?.disabled, true);
  assert.equal(button(r, "Set default")?.disabled, true);
  assert.equal(select(r, "perm:drop"), undefined, "a remove menu you cannot use is a trap");

  // Staff get the same controls as the owner, which is the rule `@sbr/perms`
  // enforces on the way in — the card must not disagree with it.
  const staff = await permView("g1", "pm1", "999", deps());
  assert.equal(button(staff, "Disband")?.disabled, false);
});

test("the remove menu names the seat by role as well as by player", async () => {
  const r = await permView("g1", "pm1", "111", deps());
  // The same player may hold two seats; dropping "Alpha" without saying which
  // one would be a coin toss.
  assert.deepEqual(
    select(r, "perm:drop")?.options.map((o) => o.value),
    ["healer/Alpha", "berserk/Beta"],
  );
});

test("a disbanded party keeps only the control that leads away from it", async () => {
  const dead = perms({ async getPerm() { return ok({ ...aPerm, status: "DISBANDED" as const }); } });
  const r = await permView("g1", "pm1", "111", deps({ perms: dead }));
  assert.equal(button(r, "Leave")?.disabled, true);
  assert.equal(button(r, "Add someone")?.disabled, true);
  assert.equal(button(r, "All parties")?.disabled, undefined);
});

// ─────────────────────────────── Actions ───────────────────────────────

test("taking a seat uses the presser's linked name rather than a typed one", async () => {
  const seen: RosterChange[] = [];
  const record = perms({ async addToRoster(change) { seen.push(change); return ok(aPerm); } });
  await permConsoleReplies.seat("g1", "pm1", "111", "mage", deps({ perms: record }));
  assert.deepEqual(
    seen.map((c) => ({ ign: c.ign, role: c.role })),
    [{ ign: "Alpha", role: "mage" }],
  );
});

test("an unlinked member is told what to do instead of being told their name is wrong", async () => {
  const nobody = identity({ async resolveByDiscordId() { return ok(null); } });
  const untouched = perms({ async addToRoster() { throw new Error("must not be called"); } });
  const r = await permConsoleReplies.seat("g1", "pm1", "111", "mage", deps({ perms: untouched, identity: nobody }));
  assert.match(r.text, /\/link/);
  assert.equal(r.ephemeral, true);
});

test("leaving gives up every seat the presser holds, and says so when there are none", async () => {
  const two = { ...aPerm, members: [aPerm.members[0]!, { ...aPerm.members[0]!, role: "mage", slot: 2 }] };
  const seen: RosterChange[] = [];
  const record = perms({
    async getPerm() { return ok(two); },
    async removeFromRoster(change) { seen.push(change); return ok(two); },
  });
  await permConsoleReplies.leave("g1", "pm1", "111", deps({ perms: record }));
  assert.deepEqual(seen.map((c) => c.role), ["healer", "mage"]);

  const r = await permConsoleReplies.leave("g1", "pm1", "999", deps());
  assert.match(r.text, /don't have a seat/);
  assert.equal(r.ephemeral, true);
});

test("a remove carries the role the menu named", async () => {
  const seen: RosterChange[] = [];
  const record = perms({ async removeFromRoster(change) { seen.push(change); return ok(aPerm); } });
  await permConsoleReplies.drop("g1", "pm1", "111", "berserk/Beta", deps({ perms: record }));
  assert.deepEqual(seen.map((c) => ({ ign: c.ign, role: c.role })), [{ ign: "Beta", role: "berserk" }]);
});

test("a value from an older menu shape is refused rather than guessed at", async () => {
  const untouched = perms({ async removeFromRoster() { throw new Error("must not be called"); } });
  const r = await permConsoleReplies.drop("g1", "pm1", "111", "Beta", deps({ perms: untouched }));
  assert.match(r.text, /out of date/);
  assert.equal(r.ephemeral, true);
});

test("the new-party modal creates from the name and notes it collected", async () => {
  const seen: { name: string; activity: string; notes?: string | null }[] = [];
  const record = perms({
    async createPerm(input) {
      seen.push({ name: input.name, activity: input.activity, ...(input.notes === undefined ? {} : { notes: input.notes }) });
      return ok({ ...aPerm, id: "new", name: input.name, members: [] });
    },
  });
  const r = await permConsoleReplies.create("g1", "111", "KUUDRA", "  Kuudra core  ", "  t5 only  ", deps({ perms: record }));
  assert.deepEqual(seen, [{ name: "Kuudra core", activity: "KUUDRA", notes: "t5 only" }]);
  // The reply is the party itself, so the next thing to do — fill it — is on
  // the card that just appeared rather than in another command.
  assert.equal(r.embed?.title, "F7 core");

  // An empty optional field is absence, not an empty string in the database.
  await permConsoleReplies.create("g1", "111", "KUUDRA", "Kuudra core", "   ", deps({ perms: record }));
  assert.equal(seen[1]?.notes, undefined);
});

test("a name clash comes back as a sentence naming the taken name", async () => {
  const taken = perms({ async createPerm() { return err({ kind: "NAME_TAKEN", name: "F7 core" }); } });
  const r = await permConsoleReplies.create("g1", "111", "DUNGEONS", "f7 CORE", "", deps({ perms: taken }));
  assert.match(r.text, /"F7 core" is already the name/);
  assert.equal(r.ephemeral, true);
});

test("an unusable role lists the ones that would work", async () => {
  const strict = perms({ async addToRoster() { return err({ kind: "INVALID_ROLE", allowed: ["healer", "mage", "tank"] }); } });
  const r = await permConsoleReplies.add("g1", "pm1", "111", "cannoneer", "Gamma", deps({ perms: strict }));
  assert.match(r.text, /healer, mage, tank/);
});

test("a full party says how many seats there are", async () => {
  const full = perms({ async addToRoster() { return err({ kind: "FULL", capacity: 5 }); } });
  const r = await permConsoleReplies.add("g1", "pm1", "111", "tank", "Gamma", deps({ perms: full }));
  assert.match(r.text, /full — 5 seats/);
});

test("editing someone else's party is refused with the rule, not a stack trace", async () => {
  const notMine = perms({ async removeFromRoster() { return err({ kind: "NOT_OWNER" }); } });
  const r = await permConsoleReplies.drop("g1", "pm1", "999", "healer/Alpha", deps({ perms: notMine }));
  assert.match(r.text, /Only the person who created that party/);
});

test("disbanding answers with the party, marked disbanded", async () => {
  const dead = perms({
    async disbandPerm() { return ok({ ...aPerm, status: "DISBANDED" as const }); },
    async getPerm() { return ok({ ...aPerm, status: "DISBANDED" as const }); },
  });
  const r = await permConsoleReplies.disband("g1", "pm1", "111", deps({ perms: dead }));
  assert.match(r.embed?.description ?? "", /Disbanded/);
});

/**
 * The actor's staff flag is derived from the capability check, not from the
 * surface — a caller that could pass `isStaff: true` itself would make the
 * owner-or-staff rule unenforceable.
 */
test("the staff flag reaching the perm service comes from the capability check", async () => {
  const seen: boolean[] = [];
  const record = perms({ async disbandPerm(_g, _n, actor) { seen.push(actor.isStaff); return ok(aPerm); } });
  await permConsoleReplies.disband("g1", "pm1", "111", deps({ perms: record }));
  await permConsoleReplies.disband(
    "g1",
    "pm1",
    "111",
    deps({ perms: record, identity: identity({ async hasCapability() { return false; } }) }),
  );
  await permConsoleReplies.disband(
    "g1",
    "pm1",
    "111",
    // An outage must not hand out staff powers.
    deps({ perms: record, identity: identity({ async hasCapability() { throw new Error("db down"); } }) }),
  );
  assert.deepEqual(seen, [true, false, false]);
});

// ─────────────────────────── Menus in front of modals ───────────────────────

test("the activity menu offers every activity with the seats it comes with", async () => {
  const options = activityRows()[0]?.select?.options ?? [];
  assert.deepEqual(options.map((o) => o.value), ["DUNGEONS", "KUUDRA", "SLAYERS", "FISHING", "MINING", "OTHER"]);
  assert.equal(options.find((o) => o.value === "DUNGEONS")?.description, "5 seats");
  assert.equal(options.find((o) => o.value === "KUUDRA")?.description, "4 seats");
});

test("the add-someone menu is built from the activity's own roles", async () => {
  const row = addRoleRows("pm1", "KUUDRA")[0];
  assert.equal(row?.select?.customId, "perm:addrole:pm1");
  assert.ok((row?.select?.options ?? []).length > 0);
  assert.ok(!(row?.select?.options ?? []).some((o) => o.value === "healer"), "kuudra has no healer");
});
