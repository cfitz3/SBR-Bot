/**
 * What a role menu promises: it edits rather than re-posts, a moved menu leaves
 * no live buttons behind, a press is resolved against the stored menu rather
 * than trusted from the button, and the reply says what actually happened.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLE_MENUS_SETTING_KEY } from "@sbr/roles";
import type { ActionRowView, EmbedView } from "@sbr/shared-types";
import { RoleMenuGateway, renderRoleMenu, type RoleMenuDeps } from "./role-menus.js";
import type { RoleApplyOutcome } from "./role-effector.js";
import { copy } from "@sbr/brand";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as RoleMenuDeps["log"];

const MENU = {
  id: "colours",
  title: "Pick a colour",
  body: "One each.",
  channelId: "chan-1",
  messageId: "msg-1",
  exclusive: false,
  options: [
    { key: "red", roleId: "role-red", label: "Red", description: "warm", emoji: null },
    { key: "blue", roleId: "role-blue", label: "Blue", description: null, emoji: null },
  ],
};

interface Posted {
  readonly channelId: string;
  readonly embed: EmbedView;
  readonly rows: readonly ActionRowView[];
}

interface Harness {
  readonly gateway: RoleMenuGateway;
  readonly posts: Posted[];
  readonly edits: { channelId: string; messageId: string }[];
  readonly saved: unknown[];
  readonly applied: { add: readonly string[]; remove: readonly string[]; reason: string }[];
}

function make(
  over: {
    stored?: unknown;
    editSucceeds?: boolean;
    canPost?: boolean;
    outcome?: Partial<RoleApplyOutcome>;
  } = {},
): Harness {
  const posts: Posted[] = [];
  const edits: { channelId: string; messageId: string }[] = [];
  const saved: unknown[] = [];
  const applied: { add: readonly string[]; remove: readonly string[]; reason: string }[] = [];

  const gateway = new RoleMenuGateway({
    config: {
      async getSetting<T>() {
        return (over.stored === undefined ? { menus: [MENU] } : over.stored) as T | null;
      },
      async setSetting(_guildId: string, _key: string, value: unknown) {
        saved.push(value);
      },
    },
    messages: {
      async post(channelId, embed, rows) {
        if (over.canPost === false) return null;
        posts.push({ channelId, embed, rows });
        return "msg-new";
      },
      async edit(channelId, messageId) {
        edits.push({ channelId, messageId });
        return over.editSucceeds !== false;
      },
    },
    roles: {
      async apply(_guildId, _userId, add, remove, reason) {
        applied.push({ add, remove, reason });
        return {
          ok: true,
          memberPresent: true,
          added: [...add],
          removed: [...remove],
          refused: [],
          ...over.outcome,
        };
      },
    },
    log: silentLog,
  });

  return { gateway, posts, edits, saved, applied };
}

// ── rendering ────────────────────────────────────────────────────────────────

test("the buttons carry the menu and the option, never the role", () => {
  const { rows } = renderRoleMenu({ ...MENU, options: MENU.options });
  const ids = rows.flatMap((row) => row.buttons.map((b) => b.customId));
  assert.deepEqual(ids, ["rmenu:colours:red", "rmenu:colours:blue"]);
  assert.ok(!JSON.stringify(rows).includes("role-red"), "a role id must never travel in a custom id");
});

test("buttons are laid out five to a row", () => {
  const options = Array.from({ length: 7 }, (_, i) => ({
    key: `k${String(i)}`,
    roleId: `r${String(i)}`,
    label: `Option ${String(i)}`,
    description: null,
    emoji: null,
  }));
  const { rows } = renderRoleMenu({ ...MENU, options });
  assert.deepEqual(
    rows.map((row) => row.buttons.length),
    [5, 2],
  );
});

test("notes become lines of the embed, and an empty menu body is not a blank line", () => {
  const { embed } = renderRoleMenu({ ...MENU, body: "" });
  assert.equal(embed.description, "**Red** — warm");
});

// ── publishing ───────────────────────────────────────────────────────────────

test("republishing edits the message it remembers", async () => {
  const h = make();
  const result = await h.gateway.publish("g1", "colours", null);
  assert.deepEqual(result, { ok: true, channelId: "chan-1", messageId: "msg-1", edited: true });
  assert.deepEqual(h.edits, [{ channelId: "chan-1", messageId: "msg-1" }]);
  assert.equal(h.posts.length, 0);
});

test("a message that has been deleted heals into a fresh post", async () => {
  const h = make({ editSucceeds: false });
  const result = await h.gateway.publish("g1", "colours", null);
  assert.equal(result.ok && result.messageId, "msg-new");
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.saved, [{ menus: [{ ...MENU, channelId: "chan-1", messageId: "msg-new" }] }]);
});

test("moving a menu posts anew rather than editing the old channel's message", async () => {
  const h = make();
  const result = await h.gateway.publish("g1", "colours", "chan-2");
  assert.equal(result.ok && result.edited, false);
  assert.deepEqual(h.edits, [], "the old post must not be edited into a menu that has moved");
  assert.equal(h.posts[0]?.channelId, "chan-2");
});

test("a channel we cannot post in says so instead of claiming success", async () => {
  const h = make({ canPost: false, editSucceeds: false });
  const result = await h.gateway.publish("g1", "colours", null);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.detail, /permissions/);
  assert.deepEqual(h.saved, [], "nothing was posted, so nothing should be remembered");
});

test("a menu that has never had a channel is not guessed at", async () => {
  const h = make({ stored: { menus: [{ ...MENU, channelId: null, messageId: null }] } });
  const result = await h.gateway.publish("g1", "colours", null);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.problem, "NO_CHANNEL");
});

test("an unknown menu is a 'gone', not a crash", async () => {
  const h = make();
  const result = await h.gateway.publish("g1", "nope", "chan-1");
  assert.equal(result.ok ? "" : result.problem, "NO_MENU");
});

// ── pressing ─────────────────────────────────────────────────────────────────

test("a press grants the role the stored menu names for that key", async () => {
  const h = make();
  const result = await h.gateway.press("g1", "colours", "red", "u1", []);
  assert.deepEqual(h.applied, [{ add: ["role-red"], remove: [], reason: "role menu colours: red" }]);
  assert.equal(result.ok && result.note, "You now have **Red**.");
});

test("pressing one you hold takes it back", async () => {
  const h = make();
  const result = await h.gateway.press("g1", "colours", "red", "u1", ["role-red"]);
  assert.deepEqual(h.applied[0]?.remove, ["role-red"]);
  assert.equal(result.ok && result.note, "Taken **Red** back.");
});

test("an exclusive menu swaps in a single call", async () => {
  const h = make({ stored: { menus: [{ ...MENU, exclusive: true }] } });
  await h.gateway.press("g1", "colours", "blue", "u1", ["role-red"]);
  assert.deepEqual(h.applied, [
    { add: ["role-blue"], remove: ["role-red"], reason: "role menu colours: blue" },
  ]);
});

test("a key the menu no longer offers never reaches the effector", async () => {
  const h = make();
  const result = await h.gateway.press("g1", "colours", "green", "u1", []);
  assert.equal(result.ok, false);
  assert.deepEqual(h.applied, []);
});

test("a forged press naming another menu is answered, not applied", async () => {
  const h = make();
  const result = await h.gateway.press("g1", "staff", "admin", "u1", []);
  assert.equal(result.ok, false);
  assert.deepEqual(h.applied, []);
});

test("a refused role is reported with the effector's own reason", async () => {
  const h = make({ outcome: { ok: false, refused: [{ roleId: "role-red", detail: "Missing Permissions" }] } });
  const result = await h.gateway.press("g1", "colours", "red", "u1", []);
  assert.equal(result.ok ? "" : result.detail, "I can't hand out **Red**: Missing Permissions.");
});

test("an unreachable admin bot is a failure, not a silent success", async () => {
  const h = make({ outcome: { ok: false, added: [], removed: [] } });
  const result = await h.gateway.press("g1", "colours", "red", "u1", []);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.detail, copy.error.generic.saveFailed);
});

test("a member who has left is told so rather than told it worked", async () => {
  const h = make({ outcome: { ok: false, memberPresent: false } });
  const result = await h.gateway.press("g1", "colours", "red", "u1", []);
  assert.equal(result.ok ? "" : result.detail, copy.error.discord.memberMissing);
});

test("the note follows what the effector did, not what was asked", async () => {
  // The admin bot saw the role already held and moved nothing.
  const h = make({ outcome: { ok: true, added: [], removed: [] } });
  const result = await h.gateway.press("g1", "colours", "red", "u1", []);
  assert.equal(result.ok ? "" : result.detail, "You already have **Red**.");
});
