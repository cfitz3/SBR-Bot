/**
 * `/health` — is it me, or is it them?
 *
 * The command exists because of what the rest of this overhaul does to error
 * copy: every user-facing failure now points here instead of narrating its own
 * cause. That trade is only honest if there is something worth arriving at, and
 * "something worth arriving at" is a short, fixed list of the things a member's
 * command actually depends on, with an answer for each.
 *
 * What it is not is the panel's Health page. That one names components and
 * prints what a failing probe threw, which is right for an operator behind
 * Manage Server and wrong for a slash command any member can run —
 * `curateStatus` in `@sbr/observability` is where the two part company, and the
 * DTO this handler receives has nowhere for a detail to live.
 */
import { copy } from "@sbr/brand";
import { card, facts } from "@sbr/embed-kit";
import { flattenEmbed, type EmbedView, type PlatformStatusDTO } from "@sbr/shared-types";
import type { CommandHandler, CommandSpec } from "./types.js";

const H = copy.embed.health;
const T = copy.embed.tone;

/**
 * One glyph per state, and the tone of the whole card from the rollup.
 *
 * Not the theme's marker glyph: that one means "this qualifies" on progression
 * cards, and reusing it here for "this is up" would be the second meaning that
 * makes a shared glyph stop meaning anything.
 */
const GLYPH = { ok: "🟢", degraded: "🟡", down: "🔴" } as const;
const TONE = { ok: "SUCCESS", degraded: "WARNING", down: "DANGER" } as const;
const HEADLINE = { ok: H.ok, degraded: H.degraded, down: H.down } as const;
const WORD = { ok: T.ok, degraded: T.warn, down: T.bad } as const;

export function renderHealthEmbed(status: PlatformStatusDTO): EmbedView {
  const rows = status.lines.map((line) => ({
    label: `${GLYPH[line.status]} ${line.label}`,
    value: WORD[line.status],
  }));

  // Prose, and so it goes in the description under the headline rather than in
  // a field with a blank name. A zero-width-space field label is a layout trick
  // asking to be read as a heading that isn't there.
  const notes = [
    HEADLINE[status.overall],
    status.otherUnhealthy > 0 ? H.otherUnhealthy.replace("{n}", String(status.otherUnhealthy)) : "",
    status.overall === "ok" ? "" : H.reportHint,
  ].filter((n) => n !== "");

  return card({
    tone: TONE[status.overall],
    title: H.title,
    headline: notes.join("\n"),
    // One field, not one per component. Three two-word facts as three inline
    // fields is a ragged block on a phone and two thirds labels; as a list it
    // reads as the list it is.
    fields: [{ name: H.checks, value: facts(rows) }],
    // The age of the check, not the age of the send. A status card read ten
    // minutes later is describing a ten-minute-old check, and Discord says so.
    timestamp: status.checkedAt,
  });
}

const health: CommandHandler = async (_ctx, deps) => {
  // Unwired rather than broken. A deployment can run the member bot without a
  // health registry, and "not wired up" is a different fact from "down" — the
  // second would send a member to staff about an outage that is not happening.
  if (deps.status === undefined) return { ephemeral: true, text: H.unavailable };
  const status = await deps.status.status();
  const embed = renderHealthEmbed(status);
  return { ephemeral: false, text: flattenEmbed(embed), embed };
};

export function healthSpecs(): CommandSpec[] {
  return [
    {
      name: "health",
      description: "Whether the bot, guild chat and Hypixel are answering",
      options: [],
      // Deliberately public and ungated. Every error message points here, so a
      // capability check would put the explanation behind the same permission
      // whose absence a member might be trying to diagnose.
      cooldownMs: 15_000,
      inGame: true,
      handler: health,
    },
  ];
}
