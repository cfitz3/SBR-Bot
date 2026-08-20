/**
 * The refusals that stand between a dropdown and a server-wide mistake.
 *
 * Every test here is a thing the feature must not do, which is why they are
 * written as prohibitions rather than as "returns X for Y".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import { dangerousPermissionsOf, describeRefusal, refuseRole, type BotFacts, type RoleFacts } from "./role-preflight.js";

function role(over: Partial<RoleFacts> = {}): RoleFacts {
  return {
    id: "r1",
    name: "Guild Member",
    position: 5,
    managed: false,
    isEveryone: false,
    permissions: 0n,
    ...over,
  };
}

const bot: BotFacts = { highestPosition: 10, canManageRoles: true };

test("an ordinary role below the bot is assignable", () => {
  assert.equal(refuseRole(role(), bot), null);
});

test("a role carrying Administrator is never assignable", () => {
  assert.equal(refuseRole(role({ permissions: PermissionFlagsBits.Administrator }), bot), "DANGEROUS_PERMISSION");
});

test("the quieter authority permissions are refused too", () => {
  for (const bit of [
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ModerateMembers,
  ]) {
    assert.equal(refuseRole(role({ permissions: bit }), bot), "DANGEROUS_PERMISSION", String(bit));
  }
});

test("harmless permissions do not make a role dangerous", () => {
  const harmless = PermissionFlagsBits.SendMessages | PermissionFlagsBits.AddReactions | PermissionFlagsBits.Connect;
  assert.equal(refuseRole(role({ permissions: harmless }), bot), null);
  assert.deepEqual(dangerousPermissionsOf(harmless), []);
});

test("a role at the bot's own height is refused, not only one above it", () => {
  // Discord needs a *strictly* higher role to assign one, so a tie would fail
  // at the API as a bare 50013 with nothing to explain it.
  assert.equal(refuseRole(role({ position: 10 }), bot), "ABOVE_BOT");
  assert.equal(refuseRole(role({ position: 11 }), bot), "ABOVE_BOT");
  assert.equal(refuseRole(role({ position: 9 }), bot), null);
});

test("integration-owned roles and @everyone are refused", () => {
  assert.equal(refuseRole(role({ managed: true }), bot), "MANAGED");
  assert.equal(refuseRole(role({ isEveryone: true }), bot), "EVERYONE");
});

test("a role that has since been deleted is refused rather than attempted", () => {
  assert.equal(refuseRole(null, bot), "UNKNOWN_ROLE");
});

test("a bot without Manage Roles reports that, not a per-role reason", () => {
  const powerless: BotFacts = { highestPosition: 10, canManageRoles: false };
  // Otherwise an operator reads "that role is too high", drags roles around,
  // and nothing changes — the fix was a permission, not an ordering.
  assert.equal(refuseRole(role({ position: 99 }), powerless), "BOT_LACKS_MANAGE_ROLES");
  assert.equal(refuseRole(null, powerless), "BOT_LACKS_MANAGE_ROLES");
});

test("a dangerous role is refused before it is measured against the hierarchy", () => {
  // Both are true here. Naming the permission is the more useful of the two,
  // because moving the bot's role would not make the grant acceptable.
  const r = role({ position: 99, permissions: PermissionFlagsBits.Administrator });
  assert.equal(refuseRole(r, bot), "DANGEROUS_PERMISSION");
});

test("every refusal names the thing to change", () => {
  const reasons = ["BOT_LACKS_MANAGE_ROLES", "UNKNOWN_ROLE", "EVERYONE", "MANAGED", "ABOVE_BOT"] as const;
  for (const reason of reasons) {
    const text = describeRefusal(reason, role());
    assert.ok(text.length > 20, reason);
    assert.ok(!text.includes("_"), `${reason} leaked its enum name`);
  }
  const dangerous = describeRefusal("DANGEROUS_PERMISSION", role({ permissions: PermissionFlagsBits.BanMembers }));
  assert.match(dangerous, /Ban Members/);
});
