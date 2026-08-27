/**
 * `/remind` and `/reminders` — a member's own notes to themselves.
 *
 * Durable by design: the reminder is a row and a sweeper, not a `setTimeout`,
 * because the ones worth setting are hours or days out and a deploy in between
 * must not swallow them.
 *
 * Everything here is scoped to the caller. There is no "remind someone else",
 * which would be a way to make the bot ping a person on command, and no way to
 * see or cancel another member's reminders.
 */
import type { CommandHandler, CommandReply, CommandSpec } from "./types.js";
import type { ReminderDTO } from "@sbr/shared-types";
import { copy } from "@sbr/brand";

const E = copy.error;

/** Under a minute is a timer, not a reminder, and the sweeper cannot honour it anyway. */
export const MIN_REMINDER_MS = 60_000;
/** A year out. Past this the guild, the channel and the person have all probably moved on. */
export const MAX_REMINDER_MS = 365 * 24 * 60 * 60_000;
/** Per member, per guild. Enough for real use, small enough not to be a spam vector. */
export const MAX_PENDING_REMINDERS = 10;
/** Discord's own field limit is far larger; this keeps a listing readable. */
export const MAX_REMINDER_TEXT = 280;

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * `"90m"`, `"2h30m"`, `"1w2d"` → milliseconds. Null when it is not a duration
 * at all.
 *
 * Compound rather than the single-unit parser `@sbr/commands-admin` uses: a mute
 * is always one round number, but "in an hour and a half" is the normal way to
 * ask for a reminder. Repeated units are summed rather than rejected — `"1h1h"`
 * is odd but unambiguous, and guessing at intent would be worse.
 */
export function parseReminderDelay(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;

  const pattern = /(\d+)\s*([smhdw])/g;
  let total = 0;
  let consumed = 0;
  for (const match of trimmed.matchAll(pattern)) {
    total += Number(match[1]) * (UNIT_MS[match[2] ?? ""] ?? 0);
    consumed += match[0].length;
  }
  // Every character has to have been part of a unit; otherwise `"tomorrow"`
  // would silently become zero and `"5 bananas"` five seconds.
  if (consumed !== trimmed.replace(/\s+/g, "").length) return null;
  return total > 0 ? total : null;
}

/** `<t:…:R>` — Discord renders it live, in the reader's own locale. */
function relative(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return `<t:${String(Math.floor(at / 1000))}:R>`;
}

const remind: CommandHandler = async (ctx, deps): Promise<CommandReply> => {
  if (deps.reminders === undefined) {
    return { ephemeral: true, text: "Reminders aren't set up on this deployment." };
  }
  // The reminder comes back to where it was set, so a surface with no channel
  // has nowhere to deliver it. Guild chat is the case that matters.
  if (ctx.channelId === undefined) {
    return { ephemeral: true, text: E.surface.needsChannel };
  }

  const raw = ctx.args.getString("when") ?? "";
  const delay = parseReminderDelay(raw);
  if (delay === null) {
    return { ephemeral: true, text: E.badDuration };
  }
  if (delay < MIN_REMINDER_MS) return { ephemeral: true, text: "The shortest reminder I'll set is a minute." };
  if (delay > MAX_REMINDER_MS) return { ephemeral: true, text: "The longest reminder I'll set is a year." };

  const text = (ctx.args.getString("about") ?? "").trim();
  if (text === "") return { ephemeral: true, text: "Tell me what to remind you about." };
  if (text.length > MAX_REMINDER_TEXT) {
    return { ephemeral: true, text: `Keep it under ${String(MAX_REMINDER_TEXT)} characters.` };
  }

  const pending = await deps.reminders.countPendingFor(ctx.guildId, ctx.userId);
  if (pending >= MAX_PENDING_REMINDERS) {
    return {
      ephemeral: true,
      text: `You already have ${String(MAX_PENDING_REMINDERS)} reminders waiting. Clear one with \`/reminders\` first.`,
    };
  }

  const dueAt = new Date(Date.now() + delay);
  await deps.reminders.create({
    guildId: ctx.guildId,
    discordId: ctx.userId,
    channelId: ctx.channelId,
    text,
    dueAt,
  });

  return { ephemeral: true, text: `I'll remind you ${relative(dueAt.toISOString())} — ${text}` };
};

function listBody(reminders: readonly ReminderDTO[]): string {
  return reminders
    .map((r, index) => `**${String(index + 1)}.** ${relative(r.dueAt)} — ${r.text}\n\`${r.id}\``)
    .join("\n");
}

const reminders: CommandHandler = async (ctx, deps): Promise<CommandReply> => {
  if (deps.reminders === undefined) {
    return { ephemeral: true, text: "Reminders aren't set up on this deployment." };
  }

  const cancelId = ctx.args.getString("cancel");
  if (cancelId !== null) {
    const done = await deps.reminders.cancel(ctx.guildId, ctx.userId, cancelId.trim());
    return {
      ephemeral: true,
      text: done ? "Cancelled." : "You have no pending reminder with that id.",
    };
  }

  const mine = await deps.reminders.listPendingFor(ctx.guildId, ctx.userId);
  if (mine.length === 0) return { ephemeral: true, text: "You have no reminders waiting." };

  return {
    ephemeral: true,
    text: listBody(mine),
    embed: {
      title: "Your reminders",
      description: listBody(mine),
      color: "INFO",
    },
  };
};

export function reminderSpecs(): CommandSpec[] {
  return [
    {
      name: "remind",
      description: "Have me remind you about something later",
      options: [
        {
          name: "when",
          description: "How long from now — 30m, 2h30m, 1w",
          type: "string",
          required: true,
        },
        {
          name: "about",
          description: "What to remind you about",
          type: "string",
          required: true,
        },
      ],
      cooldownMs: 5_000,
      handler: remind,
    },
    {
      name: "reminders",
      description: "Your pending reminders",
      options: [
        {
          name: "cancel",
          description: "The id of one to cancel",
          type: "string",
        },
      ],
      cooldownMs: 5_000,
      handler: reminders,
    },
  ];
}
