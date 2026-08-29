/**
 * `/lfg`, offline.
 *
 * The flow is two menus and a button, and every one of them re-derives its
 * state from the id it was handed — so the whole thing is testable by calling
 * the functions the router calls, in the order a member would press them.
 *
 * Nothing here touches Discord. What the transport owes is a send; what these
 * prove is everything decided before it: which controls are offered, what the
 * card says, and which of the ways a post can fail the member is told about.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ok,
  err,
  type DataEnvelope,
  type DungeonsDTO,
  type IdentityService,
  type ProgressionService,
} from "@sbr/shared-types";
import { parseFloor } from "@sbr/perms";
import { lfgRequestReplies, classRows, floorRows, typeRows, LFG_PING_ROLE_SETTING_KEY } from "./lfg-request.js";
import type { HandlerDeps, LfgAnnouncer } from "./types.js";

const FETCHED_AT = "2026-08-27T12:00:00.000Z";

function live<T>(data: T) {
  return ok<DataEnvelope<T>>({ data, freshness: "LIVE", source: "LIVE", fetchedAt: FETCHED_AT });
}

const dungeons: DungeonsDTO = {
  catacombsLevel: 42,
  catacombsExperience: 5_000_000,
  catacombsXpToNext: 500_000,
  catacombsProgress: 0.5,
  selectedClass: "mage",
  classAverage: 38,
  classes: [
    { name: "healer", level: 44, experience: 6_000_000 },
    { name: "mage", level: 40, experience: 4_000_000 },
  ],
  floors: [],
  masterFloors: [],
  played: true,
};

interface Over {
  readonly identity?: Partial<IdentityService>;
  readonly progression?: Partial<ProgressionService>;
  readonly channel?: string | null;
  readonly setting?: unknown;
  readonly announcer?: LfgAnnouncer | null;
}

/**
 * A posting member: linked, with a channel set and no ping role.
 *
 * Four ports and no others, which is the point of the cast — filling in the
 * other fifteen services to prove the flow does not read them would make the
 * dependency claim harder to see rather than easier.
 */
function deps(over: Over = {}): HandlerDeps {
  return {
    identity: {
      async resolveByDiscordId() {
        return ok({ minecraftUuid: "u-alpha", ign: "Alpha" });
      },
      ...over.identity,
    },
    progression: {
      async getDungeons() {
        return live<DungeonsDTO>(dungeons);
      },
      ...over.progression,
    },
    config: {
      async getChannel() {
        return over.channel === undefined ? "c-lfg" : over.channel;
      },
      async getSetting() {
        return over.setting ?? null;
      },
    },
    ...(over.announcer === null ? {} : { lfgAnnouncer: over.announcer ?? spy() }),
  } as unknown as HandlerDeps;
}

interface Sent {
  readonly channelId: string;
  readonly text: string;
  readonly pingRoleId: string | null;
  readonly embed: {
    readonly fields?: readonly { readonly name: string; readonly value: string }[];
    readonly description?: string;
  };
}

/** The announcer, remembering what it was asked to send. */
function spy(result = true): LfgAnnouncer & { readonly sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    async announce(input) {
      sent.push(input as unknown as Sent);
      return result;
    },
  };
}

interface RowsOf {
  readonly components?: readonly {
    readonly buttons: readonly { readonly label: string; readonly customId?: string }[];
    readonly select?: {
      readonly customId: string;
      readonly minValues?: number;
      readonly options: readonly { readonly label: string; readonly value: string; readonly default?: boolean }[];
    };
  }[];
}

function select(reply: RowsOf) {
  return (reply.components ?? []).map((row) => row.select).find((s) => s !== undefined);
}

function buttons(reply: RowsOf) {
  return (reply.components ?? []).flatMap((row) => row.buttons);
}

function field(sent: Sent, name: string): string {
  return (sent.embed.fields ?? []).find((f) => f.name === name)?.value ?? "";
}

// ────────────────────────────── The floors ──────────────────────────────

test("a floor is recognised in the forms people type it in", () => {
  for (const raw of ["f7", "F7", "floor 7", "Floor-7"]) {
    assert.equal(parseFloor(raw)?.code, "F7", raw);
  }
  for (const raw of ["m3", "master 3", "Master Mode 3"]) {
    assert.equal(parseFloor(raw)?.code, "M3", raw);
  }
  // Kuudra is named by tier as often as by number, and both reach the same run.
  assert.equal(parseFloor("infernal")?.code, "K5");
  assert.equal(parseFloor("t5")?.code, "K5");
});

test("a bare number is refused rather than guessed at", () => {
  // "7" is F7 to one member and M7 to another, and posting the wrong one wastes
  // everybody who joins. The menu exists for exactly this.
  assert.equal(parseFloor("7"), null);
  assert.equal(parseFloor("f9"), null);
  assert.equal(parseFloor(""), null);
});

// ─────────────────────────────── The flow ───────────────────────────────

test("the flow opens on the run type, ephemerally", () => {
  const r = lfgRequestReplies.start();
  assert.equal(r.ephemeral, true, "a member assembling a request is not news");
  assert.deepEqual(select(r)?.options.map((o) => o.value), ["CATACOMBS", "MASTER", "KUUDRA"]);
  assert.equal(select(r)?.customId, "lfg:type");
});

test("a run type offers its own floors and nothing else", () => {
  const master = lfgRequestReplies.chooseType("MASTER");
  assert.deepEqual(select(master)?.options.map((o) => o.value), ["M1", "M2", "M3", "M4", "M5", "M6", "M7"]);

  assert.deepEqual(select({ components: floorRows("KUUDRA") })?.options.map((o) => o.label), [
    "Kuudra — Basic",
    "Kuudra — Hot",
    "Kuudra — Burning",
    "Kuudra — Fiery",
    "Kuudra — Infernal",
  ]);
});

test("a floor offers the classes that run actually has", () => {
  const dungeon = lfgRequestReplies.chooseFloor("f7");
  assert.deepEqual(select(dungeon)?.options.map((o) => o.value), ["healer", "mage", "berserk", "archer", "tank"]);

  // Kuudra's seats are jobs, not dungeon classes, and offering "mage" for one
  // would be asking for something the run has no seat for.
  const kuudra = lfgRequestReplies.chooseFloor("k3");
  assert.deepEqual(select(kuudra)?.options.map((o) => o.value), ["tank", "damage", "cannoneer", "supplier"]);
});

test("the classes are optional and the post button is live from the start", () => {
  const r = lfgRequestReplies.chooseFloor("f7");
  assert.equal(select(r)?.minValues, 0, "'I just need bodies' is a real request");
  assert.equal(buttons(r)[0]?.customId, "lfg:post:F7:");
});

test("a chosen class comes back marked, and rides in the button", () => {
  const r = lfgRequestReplies.chooseClasses("F7", ["tank", "healer"]);
  const marked = select(r)?.options.filter((o) => o.default === true).map((o) => o.value);
  assert.deepEqual(marked, ["healer", "tank"], "a member who cannot see their pick will make it again");
  // Offer order, not click order: "Healer, Tank" and "Tank, Healer" are one
  // request, and reading them as two is a cost paid by the whole channel.
  assert.equal(buttons(r)[0]?.customId, "lfg:post:F7:healer,tank");
});

test("a class the run does not have is dropped rather than posted", () => {
  const r = lfgRequestReplies.chooseClasses("K3", ["mage", "tank"]);
  assert.equal(buttons(r)[0]?.customId, "lfg:post:K3:tank");
});

test("a control naming something that is not a floor is stale, not an error", () => {
  assert.match(lfgRequestReplies.chooseType("RAIDS").text, /out of date/);
  assert.match(lfgRequestReplies.chooseFloor("f9").text, /out of date/);
  assert.equal(lfgRequestReplies.chooseFloor("f9").components, undefined);
});

// ─────────────────────────────── The post ───────────────────────────────

test("a post reaches the configured channel with the requester's own numbers", async () => {
  const announcer = spy();
  const r = await lfgRequestReplies.post("g1", "111", "M7", ["healer"], deps({ announcer }));

  const sent = announcer.sent[0];
  assert.ok(sent !== undefined);
  assert.equal(sent.channelId, "c-lfg");
  assert.equal(field(sent, "Floor"), "Master Mode 7");
  assert.equal(field(sent, "Catacombs"), "42");
  assert.equal(field(sent, "Looking for"), "Healer");
  // The class they are actually playing, not the one they have levelled most.
  assert.equal(field(sent, "Plays"), "Mage 40");
  assert.match(sent.embed.description ?? "", /<@111>/);
  assert.equal(r.ephemeral, true);
  assert.match(r.text, /<#c-lfg>/);
});

test("no classes picked posts as any class rather than as nothing", async () => {
  const announcer = spy();
  await lfgRequestReplies.post("g1", "111", "f5", [], deps({ announcer }));
  assert.equal(field(announcer.sent[0]!, "Looking for"), "Any class");
});

test("a Kuudra post leaves off the dungeon class it would otherwise claim", async () => {
  const announcer = spy();
  await lfgRequestReplies.post("g1", "111", "k5", [], deps({ announcer }));
  // A class level is true and irrelevant to a Kuudra run, and a card that fills
  // a field to avoid a gap is a card people stop reading.
  assert.equal(field(announcer.sent[0]!, "Plays"), "");
  assert.equal(field(announcer.sent[0]!, "Catacombs"), "42");
});

test("a Hypixel read that fails costs the card a line, not the member their group", async () => {
  const announcer = spy();
  const r = await lfgRequestReplies.post(
    "g1",
    "111",
    "f7",
    [],
    deps({
      announcer,
      progression: {
        async getDungeons() {
          return err({ kind: "RATE_LIMITED", message: "slow down" } as never);
        },
      },
    }),
  );
  assert.equal(announcer.sent.length, 1, "the post is the point; the stats are decoration");
  assert.equal(field(announcer.sent[0]!, "Catacombs"), "");
  assert.match(r.text, /Posted/);
});

test("the ping role is mentioned only when one is set and looks like an id", async () => {
  const unset = spy();
  await lfgRequestReplies.post("g1", "111", "f7", [], deps({ announcer: unset }));
  assert.equal(unset.sent[0]?.pingRoleId, null);
  assert.equal(unset.sent[0]?.text, "", "no role set means no ping, not an empty mention");

  const set = spy();
  await lfgRequestReplies.post("g1", "111", "f7", [], deps({ announcer: set, setting: "123456789012345678" }));
  assert.equal(set.sent[0]?.pingRoleId, "123456789012345678");
  assert.equal(set.sent[0]?.text, "<@&123456789012345678>");

  // Anything else in the setting is somebody's typo, and pinging on a guess is
  // worse than not pinging at all: @everyone lives in the same field shape.
  const junk = spy();
  await lfgRequestReplies.post("g1", "111", "f7", [], deps({ announcer: junk, setting: "everyone" }));
  assert.equal(junk.sent[0]?.pingRoleId, null);
});

test("the ping role is read under the documented key", async () => {
  const keys: string[] = [];
  const d = deps();
  (d.config as unknown as { getSetting: (guildId: string, key: string) => Promise<unknown> }).getSetting = async (
    _guildId,
    key,
  ) => {
    keys.push(key);
    return null;
  };
  await lfgRequestReplies.post("g1", "111", "f7", [], d);
  assert.deepEqual(keys, [LFG_PING_ROLE_SETTING_KEY]);
});

// ─────────────────────────── The refusals ───────────────────────────────

test("an unlinked member is told what to do, before anything is asked of Hypixel", async () => {
  let asked = false;
  const r = await lfgRequestReplies.post(
    "g1",
    "111",
    "f7",
    [],
    deps({
      identity: {
        async resolveByDiscordId() {
          return ok(null);
        },
      },
      progression: {
        async getDungeons() {
          asked = true;
          return live<DungeonsDTO>(dungeons);
        },
      },
    }),
  );
  assert.match(r.text, /\/link/);
  assert.equal(asked, false, "a member who cannot post should not spend a request finding that out");
});

test("no configured channel says so rather than posting where the command was run", async () => {
  const announcer = spy();
  const r = await lfgRequestReplies.post("g1", "111", "f7", [], deps({ announcer, channel: null }));
  assert.equal(announcer.sent.length, 0);
  assert.match(r.text, /staff can set one on the panel/);
});

test("a send that does not land is reported rather than claimed", async () => {
  const refused = await lfgRequestReplies.post("g1", "111", "f7", [], deps({ announcer: spy(false) }));
  assert.match(refused.text, /\/health/);

  // No transport attached at all reads the same to the member, because it is
  // the same fact: the card is not in the channel.
  const unattached = await lfgRequestReplies.post("g1", "111", "f7", [], deps({ announcer: null }));
  assert.match(unattached.text, /\/health/);
});

test("a floor the express lane cannot parse names itself in the answer", async () => {
  const r = await lfgRequestReplies.post("g1", "111", "f9", [], deps());
  assert.match(r.text, /f9/);
  assert.match(r.text, /f1-f7/);
});

// ─────────────────────────────── The rows ───────────────────────────────

test("every control fits the id Discord will accept", () => {
  const rows = [
    ...typeRows(),
    ...floorRows("MASTER"),
    ...classRows(parseFloor("m7")!, ["healer", "mage", "berserk", "archer", "tank"]),
  ];
  const ids = rows.flatMap((row) => [row.select?.customId, ...row.buttons.map((b) => b.customId)]);
  for (const id of ids) {
    if (id === undefined) continue;
    assert.ok(id.length <= 100, `${id} is ${String(id.length)} characters`);
  }
});
