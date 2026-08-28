import { theme } from "@sbr/brand";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capMarker,
  card,
  facts,
  field,
  inlineFacts,
  isCapped,
  player,
  progressBar,
  progressLine,
  sparkline,
} from "./card.js";
import { checkEmbed } from "./style.js";

const G = theme.embed.glyphs;

// ── The one bar ──────────────────────────────────────────────────────────────

test("progressBar is the theme's glyphs, at the theme's width", () => {
  const bar = progressBar(0.5);
  assert.equal(bar.length, G.barWidth);
  assert.equal(bar, G.barFilled.repeat(5) + G.barEmpty.repeat(5));
});

test("progressBar clamps rather than trusting a division", () => {
  // Both of these are real: a level with a zero span divides by zero, and XP
  // past a cap is over 1. Repeating a glyph NaN times throws, which would turn a
  // cosmetic edge case into a failed command.
  assert.equal(progressBar(Number.NaN), G.barEmpty.repeat(G.barWidth));
  assert.equal(progressBar(Number.POSITIVE_INFINITY), G.barFilled.repeat(G.barWidth));
  assert.equal(progressBar(-3), G.barEmpty.repeat(G.barWidth));
  assert.equal(progressBar(4), G.barFilled.repeat(G.barWidth));
});

test("progressLine adds the percentage the cards were printing anyway", () => {
  assert.equal(progressLine(0.42), `${progressBar(0.42)} 42%`);
});

// ── The one marker ───────────────────────────────────────────────────────────

test("isCapped treats an unknown level as not capped", () => {
  // The alternative is claiming somebody maxed a skill we could not read, which
  // is the worse of the two wrong answers.
  assert.equal(isCapped(null, 60), false);
  assert.equal(isCapped(undefined, 60), false);
  assert.equal(isCapped(Number.NaN, 60), false);
});

test("isCapped is inclusive, and holds above the cap", () => {
  assert.equal(isCapped(59, 60), false);
  assert.equal(isCapped(60, 60), true);
  assert.equal(isCapped(61, 60), true);
});

test("capMarker prints the theme's mark, or nothing at all", () => {
  assert.equal(capMarker(25, 25), G.marker);
  assert.equal(capMarker(24, 25), "");
});

// ── Consolidation ────────────────────────────────────────────────────────────

test("facts is one field of labelled lines, not several fields", () => {
  assert.equal(facts([{ label: "Cata", value: 42 }, { label: "SA", value: "51.3" }]), "**Cata** 42\n**SA** 51.3");
});

test("facts prints unknown rather than dropping the line", () => {
  // A missing line and a line reading "—" are different claims, and "we could
  // not read this" is usually the more useful one.
  assert.equal(facts([{ label: "Museum", value: null }]), `**Museum** ${theme.embed.style.unknown}`);
  assert.equal(facts([{ label: "Museum", value: "" }]), `**Museum** ${theme.embed.style.unknown}`);
});

test("inlineFacts joins with the theme separator, never a pipe", () => {
  assert.equal(inlineFacts([{ label: "cata", value: 42 }, { label: "sa", value: 51 }]), "cata 42 · sa 51");
});

// ── Identity ─────────────────────────────────────────────────────────────────

test("player sets the author and the thumbnail together", () => {
  const subject = player("Aria", "5f2b-8c11-4a90-b3d2-77e1a4c05b93");
  assert.equal(subject.author.name, "Aria");
  assert.ok(subject.author.iconUrl?.startsWith("https://"));
  assert.ok(subject.thumbnailUrl?.startsWith("https://"));
  // Dashes are stripped from the uuid: the avatar hosts want the undashed form.
  assert.match(subject.author.iconUrl ?? "", /5f2b8c114a90b3d277e1a4c05b93/);
});

test("player without a uuid still names the player", () => {
  // An unlinked member has a name worth printing; dropping the identity because
  // we cannot draw a face would be strictly worse.
  const subject = player("Aria");
  assert.deepEqual(subject, { author: { name: "Aria" } });
});

// ── The builder ──────────────────────────────────────────────────────────────

test("card routes identity to author and thumbnail, leaving the title free", () => {
  const view = card({
    tone: "INFO",
    title: "Skills",
    headline: "**Skill average 51.3**",
    subject: player("Aria", "abc"),
    fields: [field("Progress", progressBar(0.5))],
  });
  assert.equal(view.author?.name, "Aria");
  assert.equal(view.title, "Skills");
  assert.equal(view.description, "**Skill average 51.3**");
});

test("card drops an empty field instead of failing the whole message", () => {
  // Discord rejects the entire payload for one empty field value, so a rank with
  // nobody online would otherwise take the roster command down for the guild.
  const view = card({
    tone: "NEUTRAL",
    title: "Roster",
    fields: [field("Staff", ""), null, undefined, { name: "Members", value: "  " }, field("Guest", "Aria")],
  });
  assert.deepEqual(view.fields?.map((f) => f.name), ["Guest"]);
});

test("card takes the age from the envelope and the caveat from the footer", () => {
  const view = card({
    tone: "INFO",
    title: "Networth",
    freshness: { timestamp: "2026-08-06T11:00:00.000Z", footer: "⚠ cached — refresh failed" },
    footer: "hidden: inventory",
  });
  assert.equal(view.timestamp, "2026-08-06T11:00:00.000Z");
  // Both notes survive, joined by the theme's separator — neither silently wins.
  assert.equal(view.footer, "hidden: inventory · ⚠ cached — refresh failed");
  assert.deepEqual(checkEmbed(view).filter((i) => i.rule === "footer.time-relative"), []);
});

test("card pads the last inline row, so a data-dependent count stays in column", () => {
  const view = card({
    tone: "INFO",
    title: "Networth",
    fields: [1, 2, 3, 4].map((n) => field(`Cat ${n}`, "1b", true)),
  });
  assert.equal(view.fields?.length, 6);
  assert.deepEqual(checkEmbed(view).filter((i) => i.rule === "inline.ragged"), []);
});

test("card always states a tone, so color.missing cannot be reached through it", () => {
  const view = card({ tone: "NEUTRAL", headline: "Nothing to report" });
  assert.equal(view.color, "NEUTRAL");
  assert.deepEqual(checkEmbed(view).filter((i) => i.rule === "color.missing"), []);
});

test("card does not trim a card down to the field budget", () => {
  // The budget is a taste constant. Dropping a member's data to satisfy one is
  // not a fix, so this warns and renders everything.
  const view = card({
    tone: "INFO",
    title: "Skills",
    fields: Array.from({ length: 9 }, (_, i) => field(`Skill ${i}`, "60")),
  });
  assert.equal(view.fields?.length, 9);
  assert.equal(checkEmbed(view).filter((i) => i.rule === "field.budget").length, 1);
});

test("a sparkline spans its own series, low to high", () => {
  // Prices are levels, not fractions of an absolute, so the ramp is relative.
  assert.equal(sparkline([1, 2, 3, 4, 5, 6, 7, 8]), G.spark);
  assert.equal(sparkline([10, 20]), `${G.spark[0] ?? ""}${G.spark[7] ?? ""}`);
});

test("a flat series draws flat rather than dividing by its own zero range", () => {
  // The old failure mode of every bar this platform has drawn: a zero span
  // becomes NaN repeats, and `String.repeat(NaN)` throws mid-render.
  assert.equal(sparkline([5, 5, 5]), (G.spark[0] ?? "").repeat(3));
});

test("a bucket with no trades is a gap, not the bottom of the ramp", () => {
  // Drawing an untraded hour at the floor reports a crash that did not happen.
  const line = sparkline([10, null, 20]);
  assert.equal(line[1], G.sparkGap);
  assert.notEqual(line[1], G.spark[0]);
});

test("a series with nothing readable in it draws nothing at all", () => {
  assert.equal(sparkline([null, undefined, Number.NaN]), "");
  assert.equal(sparkline([]), "");
});

test("a long series is averaged down, so a spike cannot fall between samples", () => {
  const flat = Array.from({ length: 100 }, () => 10);
  const withSpike = [...flat];
  withSpike[57] = 1000;

  assert.equal(sparkline(flat, 10).length, 10);
  // Every point is in some bucket, so the spike survives the reduction.
  assert.notEqual(sparkline(withSpike, 10), sparkline(flat, 10));
});

test("a series shorter than the width is drawn as-is rather than stretched", () => {
  assert.equal(sparkline([1, 2, 3], 24).length, 3);
});
