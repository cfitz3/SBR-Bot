/**
 * Staff command handlers over the shared ModerationService. Thin: assemble the
 * ApplyActionInput, call the service (which enforces rank/duration/permission),
 * render the verdict.
 */
import type { AdminHandler, AdminCommandSpec } from "./types.js";
import { parseDurationSeconds, renderModError } from "./util.js";

const warn: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.target;
  if (!target) return { ephemeral: true, text: "Usage: /warn target:<user> reason:<text>" };
  const result = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "WARN",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: ctx.args.reason ?? "No reason given",
  });
  if (!result.ok) return { ephemeral: true, text: renderModError(result.error) };
  return { ephemeral: false, text: `Warned <@${target}>. (case ${result.value.id})` };
};

const mute: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.target;
  if (!target) return { ephemeral: true, text: "Usage: /mute target:<user> duration:<1h> reason:<text>" };
  const result = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "MUTE",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: ctx.args.reason ?? "No reason given",
    durationSeconds: parseDurationSeconds(ctx.args.duration) ?? null,
  });
  if (!result.ok) return { ephemeral: true, text: renderModError(result.error) };
  return {
    ephemeral: false,
    text: `Muted <@${target}> across ${result.value.surfaces.join(" + ")} until ${result.value.expiresAt}.`,
  };
};

const ban: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.target;
  if (!target) return { ephemeral: true, text: "Usage: /ban target:<user> reason:<text>" };
  const result = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "BAN",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: ctx.args.reason ?? "No reason given",
    durationSeconds: parseDurationSeconds(ctx.args.duration) ?? null,
  });
  if (!result.ok) return { ephemeral: true, text: renderModError(result.error) };
  return { ephemeral: false, text: `Banned <@${target}>. (case ${result.value.id})` };
};

const infractions: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.target;
  if (!target) return { ephemeral: true, text: "Usage: /infractions target:<user>" };
  const result = await deps.moderation.listInfractions(ctx.guildId, target);
  if (!result.ok) return { ephemeral: true, text: "Couldn't load infractions." };
  return { ephemeral: true, text: `<@${target}> has ${result.value.length} infraction(s) on record.` };
};

export function buildAdminRegistry(): Map<string, AdminCommandSpec> {
  const specs: AdminCommandSpec[] = [
    { name: "warn", minRole: "MODERATOR", handler: warn },
    { name: "mute", minRole: "MODERATOR", handler: mute },
    { name: "ban", minRole: "OFFICER", destructive: true, handler: ban },
    { name: "infractions", minRole: "MODERATOR", handler: infractions },
  ];
  return new Map(specs.map((s) => [s.name, s]));
}
