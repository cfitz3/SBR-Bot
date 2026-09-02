/**
 * The join notice card. The assertions here are about what a reviewer can act
 * on: whether the notice says it wants a decision, whether it says by when, and
 * whether a bad screening degrades into a legible card rather than an empty one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderJoinNoticeEmbed, needsStaffDecision, type JoinNoticeView } from "./card.js";
import { NO_HISTORY, UNREADABLE_STATS, type ApplicantStats, type Screening } from "./types.js";

const SEEN_AT = Date.parse("2026-08-09T12:00:00.000Z");
const UUID = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

const GOOD: ApplicantStats = {
  ...UNREADABLE_STATS,
  profileName: "Mango",
  skyblockLevel: 240,
  skillAverage: 42.53,
  catacombsLevel: 34,
  senitherWeight: 9200,
  networth: 4_500_000_000n,
  unreadable: false,
};

function screening(over: Partial<Screening> = {}): Screening {
  return {
    uuid: UUID,
    ign: "Aria",
    discordId: null,
    requestedAt: new Date(SEEN_AT),
    verdict: "REVIEW",
    riskScore: 40,
    reasons: ["MEETS_REQUIREMENTS"],
    scammer: { status: "CLEAR" },
    stats: GOOD,
    history: NO_HISTORY,
    error: null,
    ...over,
  };
}

function view(over: Partial<JoinNoticeView> = {}): JoinNoticeView {
  return {
    kind: "REVIEW",
    ign: "Aria",
    uuid: UUID,
    screening: screening(),
    deadlineAt: SEEN_AT + 5 * 60_000,
    seenAt: SEEN_AT,
    ...over,
  };
}

function fieldNamed(embed: ReturnType<typeof renderJoinNoticeEmbed>, name: string): string | undefined {
  return embed.fields?.find((f) => f.name === name)?.value;
}

test("the two kinds that need a human are the two that say so", () => {
  assert.equal(needsStaffDecision("REVIEW"), true);
  assert.equal(needsStaffDecision("UNSCREENED"), true);
  for (const kind of ["ACCEPTED", "DENIED", "JOINED"] as const) {
    assert.equal(needsStaffDecision(kind), false);
  }
});

test("a request held for staff is dated by the request, not the send", () => {
  const embed = renderJoinNoticeEmbed(view());
  assert.equal(embed.timestamp, new Date(SEEN_AT).toISOString());
});

test("the applicant is the author, with a face, and never the title", () => {
  const embed = renderJoinNoticeEmbed(view());
  assert.equal(embed.author?.name, "Aria");
  assert.ok(embed.author?.iconUrl?.includes(UUID));
  assert.ok(embed.thumbnailUrl?.includes(UUID));
  assert.ok(!embed.title?.includes("Aria"));
});

test("the risk score is in the headline, not a field of its own", () => {
  const embed = renderJoinNoticeEmbed(view({ screening: screening({ riskScore: 62 }) }));
  assert.ok(embed.description?.includes("62"));
  assert.ok(!embed.fields?.some((f) => f.value.includes("62/100")));
});

test("the account block reads as one field, not five", () => {
  const embed = renderJoinNoticeEmbed(view());
  const account = fieldNamed(embed, "Account") ?? "";
  assert.ok(account.includes("240"));
  assert.ok(account.includes("42.5"));
  assert.ok(account.includes("4.50b"));
  assert.ok(account.includes("Mango"));
});

test("a stat nobody could read prints as unknown rather than as zero", () => {
  const embed = renderJoinNoticeEmbed(view({ screening: screening({ stats: UNREADABLE_STATS }) }));
  const account = fieldNamed(embed, "Account") ?? "";
  assert.ok(account.includes("—"));
  assert.ok(!account.includes(" 0"));
});

test("a scammer listing is a finding, in a value, never a field name", () => {
  const embed = renderJoinNoticeEmbed(
    view({
      screening: screening({
        reasons: ["SCAMMER_FLAGGED"],
        scammer: { status: "FLAGGED", reason: "sold a fake wither cloak", source: "UUID" },
      }),
    }),
  );
  const findings = fieldNamed(embed, "Findings") ?? "";
  assert.ok(findings.includes("sold a fake wither cloak"));
  assert.ok(!embed.fields?.some((f) => f.name.includes("wither")));
});

test("a screening that broke says so in the findings rather than rendering clean", () => {
  const embed = renderJoinNoticeEmbed(view({ screening: screening({ error: "hypixel timed out" }) }));
  assert.ok(fieldNamed(embed, "Findings")?.includes("hypixel timed out"));
});

test("a guild that knows nothing about the applicant gets no history field", () => {
  const embed = renderJoinNoticeEmbed(view());
  assert.equal(fieldNamed(embed, "History"), undefined);
});

test("what the guild does know is one field, and names the linked account", () => {
  const embed = renderJoinNoticeEmbed(
    view({
      screening: screening({
        discordId: "123456789012345678",
        stats: { ...GOOD, currentGuild: "Skyblock Rejects" },
        history: { ...NO_HISTORY, recentAttempts: 3, priorExpulsion: true, expulsionReason: "kicked for begging" },
      }),
    }),
  );
  const history = fieldNamed(embed, "History") ?? "";
  assert.ok(history.includes("<@123456789012345678>"));
  assert.ok(history.includes("Skyblock Rejects"));
  assert.ok(history.includes("kicked for begging"));
  assert.ok(history.includes("3"));
});

test("an open request carries a client-rendered deadline and what missing it costs", () => {
  const embed = renderJoinNoticeEmbed(view());
  const window = fieldNamed(embed, "Window") ?? "";
  assert.ok(window.includes(`<t:${Math.floor((SEEN_AT + 5 * 60_000) / 1_000)}:R>`));
  assert.ok(window.toLowerCase().includes("invited"));
});

test("an answered request has no window and no footer about buttons", () => {
  const embed = renderJoinNoticeEmbed(view({ kind: "ACCEPTED", deadlineAt: null }));
  assert.equal(fieldNamed(embed, "Window"), undefined);
  assert.equal(embed.footer, undefined);
});

test("each outcome gets its own tone, so a channel of these is scannable", () => {
  const tones = (["REVIEW", "ACCEPTED", "DENIED", "JOINED"] as const).map(
    (kind) => renderJoinNoticeEmbed(view({ kind, deadlineAt: null })).color,
  );
  assert.deepEqual(tones, ["WARNING", "SUCCESS", "DANGER", "INFO"]);
});

test("an account we could not look up still produces a card staff can act on", () => {
  const embed = renderJoinNoticeEmbed(
    view({ kind: "UNSCREENED", uuid: null, screening: null, deadlineAt: SEEN_AT + 5 * 60_000 }),
  );
  // No stats, no findings, no history — but a name, a reason, and a clock.
  assert.equal(embed.author?.name, "Aria");
  assert.equal(fieldNamed(embed, "Account"), undefined);
  assert.ok(embed.description?.toLowerCase().includes("could not be looked up"));
  assert.ok(fieldNamed(embed, "Window") !== undefined);
  assert.ok(embed.footer !== undefined);
  // Not the refusal colour: the failure is ours, not the applicant's.
  assert.equal(embed.color, "WARNING");
});
