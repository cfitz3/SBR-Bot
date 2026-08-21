/**
 * The seam, not the sentences.
 *
 * These tests assert that the renderers *read* the brand layer — that changing
 * a word in `defaults/embeds.ts` changes what a card says. They deliberately
 * compare against `copy.*` rather than against a quoted string: a test that
 * hardcoded "SkyBlock Level" would be a second place the wording lives, which is
 * the exact problem the brand layer exists to remove.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { copy } from "@sbr/brand";
import type { HypixelFailureState, LinkError, ProfileSummaryDTO, HypixelResult } from "@sbr/shared-types";
import { renderFailure, renderLinkError, renderProfileEmbed, renderStandingEmbed } from "./render.js";

const FAILURES: readonly HypixelFailureState[] = [
  "NOT_LINKED",
  "MISSING_PROFILE",
  "RATE_LIMITED",
  "API_DISABLED",
];

const LINK_ERRORS: readonly LinkError["kind"][] = [
  "IGN_NOT_FOUND",
  "SOCIAL_UNSET",
  "SOCIAL_MISMATCH",
  "ALREADY_OWNED",
];

test("every Hypixel failure state prints its own key, and none of them is empty", () => {
  for (const state of FAILURES) {
    assert.equal(renderFailure(state), copy.error.hypixel[state]);
    // A state that resolved to nothing would render as a blank description,
    // which Discord rejects outright and takes the whole message down with.
    assert.ok(renderFailure(state).length > 0, state);
  }
});

test("every link failure prints its own key", () => {
  for (const kind of LINK_ERRORS) {
    assert.equal(renderLinkError({ kind } as LinkError), copy.error.link[kind]);
    assert.ok(renderLinkError({ kind } as LinkError).length > 0, kind);
  }
});

const profile: ProfileSummaryDTO = {
  profileId: "p1",
  cuteName: "Mango",
  gameMode: "NORMAL",
  skyblockLevel: 210,
  skillAverage: 41.2,
  catacombsLevel: 38,
  senitherWeight: 9100,
  slayerXp: 4_100_000,
  bestiaryMilestone: 8,
};

const ok = <T>(data: T): HypixelResult<T> =>
  ({
    ok: true,
    value: { data, freshness: "FRESH", source: "LIVE", fetchedAt: new Date().toISOString() },
  }) as unknown as HypixelResult<T>;

test("a card title is the template filled in, not a sentence of its own", () => {
  const view = renderProfileEmbed("Notch", ok(profile));
  const expected = copy.embed.card.title
    .replace("{subject}", "Notch")
    .replace("{noun}", copy.embed.card.noun.profile);

  assert.equal(view.title, expected);
});

test("field names come from the shared vocabulary, so three cards cannot disagree", () => {
  const names = (renderProfileEmbed("Notch", ok(profile)).fields ?? []).map((f) => f.name);

  // Not an exhaustive list — padInlineRow appends blanks — but every real field
  // on this card has to be a key somebody could edit.
  assert.ok(names.includes(copy.embed.field.skyblockLevel));
  assert.ok(names.includes(copy.embed.field.skillAverage));
  assert.ok(names.includes(copy.embed.field.catacombs));
});

test("the standing card names XP sources in the member's words and footers from the key", () => {
  const view = renderStandingEmbed("Notch", {
    discordId: "1",
    totalXp: 1200,
    level: 12,
    intoLevel: 40,
    levelSpan: 100,
    bySource: { GEXP: 900, MANUAL: 300 },
    tenureDays: 90,
    lastAwardAt: null,
    rank: 3,
  });

  const breakdown = (view.fields ?? []).find((f) => f.name === copy.embed.field.whereFrom);
  assert.ok(breakdown, "the breakdown field is the point of the card");
  assert.ok(breakdown.value.includes(copy.embed.xpSource.GEXP));
  // The one that matters most: an adjustment must never read as something earned.
  assert.ok(breakdown.value.includes(copy.embed.xpSource.MANUAL));
  assert.equal(view.footer, copy.embed.card.standingFooter);
});
