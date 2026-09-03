import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEmbed } from "@sbr/embed-kit";
import type { ModerationActionDTO } from "@sbr/shared-types";
import {
  CASE_SELECT_LIMIT,
  CASE_SELECT_NAMESPACE,
  renderAuditOverviewEmbed,
  renderAuditPages,
  renderCaseSelectRow,
} from "./render.js";

const NOW = new Date("2026-03-10T12:00:00.000Z");

function action(over: Partial<ModerationActionDTO> = {}): ModerationActionDTO {
  return {
    id: "act-1",
    caseCode: "CASE-target-a1b2c3d4-1",
    guildId: "g1",
    type: "WARN",
    actorDiscordId: "111111111111111111",
    targetDiscordId: "222222222222222222",
    reason: "spam",
    enforcement: "CONFIRMED",
    enforcementDetail: null,
    updatedAt: null,
    editedByDiscordId: null,
    voidedAt: null,
    voidReason: null,
    durationSeconds: null,
    expiresAt: null,
    surfaces: ["DISCORD"],
    active: true,
    createdAt: "2026-03-09T12:00:00.000Z",
    ...over,
  };
}

const field = (view: { fields?: readonly { name: string; value: string }[] }, name: string): string | undefined =>
  view.fields?.find((f) => f.name === name)?.value;

const fact = (value: string | undefined, label: string): string | undefined =>
  value
    ?.split("\n")
    .find((line) => line.startsWith(`**${label}** `))
    ?.slice(label.length + 5);

test("the overview answers the question staff opened /audit with", () => {
  const view = renderAuditOverviewEmbed(
    [
      action({ id: "act-1", type: "BAN" }),
      action({ id: "act-2", type: "WARN", actorDiscordId: "333333333333333333" }),
      action({ id: "act-3", type: "WARN" }),
    ],
    { now: NOW, rangeLabel: "last 30 days" },
  );
  assert.equal(view.description, "3 actions match.");
  assert.equal(fact(field(view, "Scope"), "Range"), "last 30 days");
  // WARN twice, BAN once, and the busiest actor first — the breakdown is sorted
  // by count, because a breakdown in insertion order is just the log again.
  assert.match(field(view, "By type") ?? "", /^\*\*WARN\*\* 2/);
  assert.match(field(view, "Busiest staff") ?? "", /^<@111111111111111111> — 2/);
});

test("the overview counts what is still being enforced, not what was issued", () => {
  const rows = [
    // Ran its time out: on the books, not in force.
    action({ id: "act-1", type: "MUTE", expiresAt: "2026-03-09T13:00:00.000Z" }),
    action({ id: "act-2", type: "MUTE", expiresAt: "2026-03-11T13:00:00.000Z" }),
  ];
  assert.equal(fact(field(renderAuditOverviewEmbed(rows, { now: NOW }), "Scope"), "Still in force"), "1");
  assert.equal(
    fact(field(renderAuditOverviewEmbed([rows[0]!], { now: NOW }), "Scope"), "Still in force"),
    "None",
    "zero reads as a word, because a bare 0 beside three other numbers scans as a count that failed",
  );
});

test("a truncated log says so in the headline rather than implying it is complete", () => {
  const view = renderAuditOverviewEmbed([action()], { now: NOW, truncated: true });
  assert.match(view.description ?? "", /Newest 1 of more than that/);
  assert.match(view.description ?? "", /Narrow the filters/);
});

test("a query caveat rides in the headline, where an embed cannot swallow it", () => {
  // `replyOptions` drops the reply text when an embed is present, so a warning
  // put there would be silently discarded — which is the exact failure it
  // exists to prevent.
  const view = renderAuditOverviewEmbed([action()], { now: NOW, notice: "⚠️ Couldn't read `to` as a date." });
  assert.match(view.description ?? "", /Couldn't read `to`/);
});

test("the overview is dated by the newest matched action, not by the send", () => {
  const view = renderAuditOverviewEmbed([action({ createdAt: "2026-03-09T12:00:00.000Z" })], { now: NOW });
  assert.equal(view.timestamp, "2026-03-09T12:00:00.000Z");
});

test("the platform's own actors are named, not rendered as broken mentions", () => {
  // `automod`, `expiry` and `discord` are not snowflakes; `<@expiry>` renders as
  // the literal text rather than as anybody.
  const view = renderAuditOverviewEmbed([action({ actorDiscordId: "automod" })], { now: NOW });
  assert.equal(field(view, "Busiest staff"), "automod — 1");
});

test("the case menu carries the case id, so it still routes after a restart", () => {
  const [row] = renderCaseSelectRow([action({ id: "act-9" })], { now: NOW });
  assert.equal(row?.select?.customId, CASE_SELECT_NAMESPACE);
  assert.equal(row?.select?.options[0]?.value, "act-9");
  assert.match(row?.select?.options[0]?.label ?? "", /act-9/);
});

test("the menu is capped at Discord's limit and says what it left out", () => {
  const rows = Array.from({ length: CASE_SELECT_LIMIT + 5 }, (_, i) => action({ id: `act-${i}` }));
  const [row] = renderCaseSelectRow(rows, { now: NOW });
  assert.equal(row?.select?.options.length, CASE_SELECT_LIMIT);
  assert.match(row?.select?.placeholder ?? "", new RegExp(`newest ${CASE_SELECT_LIMIT} of ${rows.length}`));
});

test("a menu option never exceeds the length that would make Discord reject the whole menu", () => {
  const [row] = renderCaseSelectRow([action({ reason: "x".repeat(400), id: "y".repeat(120) })], { now: NOW });
  const option = row?.select?.options[0];
  assert.ok((option?.label.length ?? 0) <= 100);
  assert.ok((option?.description?.length ?? 0) <= 100);
});

test("no menu at all when nothing matched", () => {
  assert.deepEqual(renderCaseSelectRow([], { now: NOW }), []);
});

test("the listing labels its fields and puts the record in the value", () => {
  // The whole difference from the version this replaced: `BAN (expired) · 3
  // days ago` used to be the field *name*, which Discord renders in bold and
  // which gives the reader's eye nothing to anchor on.
  const [page] = renderAuditPages(
    [action({ id: "act-7", caseCode: "CASE-DrJay-a1b2c3d4-7", type: "KICK" })],
    { now: NOW },
  );
  assert.equal(page?.fields?.[0]?.name, "Case CASE-DrJay-a1b2c3d4-7");
  const value = page?.fields?.[0]?.value ?? "";
  assert.match(value, /\*\*KICK\*\* <t:\d+:R>/);
  assert.match(value, /\*\*Member\*\* <@222222222222222222>/);
  assert.match(value, /\*\*Reason\*\* spam/);
});

test("a punishment that ended says how it ended", () => {
  const [page] = renderAuditPages(
    [action({ type: "MUTE", expiresAt: "2026-03-09T13:00:00.000Z" })],
    { now: NOW },
  );
  assert.match(page?.fields?.[0]?.value ?? "", /expired/);
});

test("the listing pages at five, so a field count cannot outrun Discord's cap", () => {
  const rows = Array.from({ length: 12 }, (_, i) => action({ id: `act-${i}` }));
  const pages = renderAuditPages(rows, { now: NOW });
  assert.equal(pages.length, 3);
  assert.equal(pages[0]?.fields?.length, 5);
  assert.equal(pages[2]?.fields?.length, 2);
  assert.match(pages[1]?.footer ?? "", /Page 2 of 3/);
});

test("every audit card is legal to send", () => {
  const rows = Array.from({ length: 7 }, (_, i) => action({ id: `act-${i}` }));
  const views = [renderAuditOverviewEmbed(rows, { now: NOW }), ...renderAuditPages(rows, { now: NOW })];
  for (const view of views) {
    assert.deepEqual(checkEmbed(view).filter((i) => i.severity === "error"), []);
  }
});
