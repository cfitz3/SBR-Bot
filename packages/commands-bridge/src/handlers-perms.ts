/**
 * Perm command handlers — standing parties (COMMANDS.md §9, PLATFORM_EXPANSION_PLAN.md §3).
 *
 * One command with an `action` option rather than seven top-level commands: the
 * whole feature is "the group I always run with", and splitting it across
 * `/permcreate`, `/permadd`, `/permdisband` would spend seven slots of a shared
 * command namespace on it. This mirrors `/ticket`, which made the same trade.
 *
 * Every rule — who may edit, capacity, role names, duplicate seats — lives in
 * `@sbr/perms`. This module only turns the typed error union into a sentence
 * someone can act on, and decides what to do with each `action`.
 */
import type { LFGActivity, PermError, PermGroupDTO } from "@sbr/shared-types";
import type {
  AutocompleteHandler,
  CommandContext,
  CommandHandler,
  CommandReply,
  CommandSpec,
  HandlerDeps,
} from "./types.js";
import { permChatLine, renderPermEmbed, renderPermListEmbed } from "./render-perms.js";
import { copy } from "@sbr/brand";

const E = copy.error;

// ───────────────────────────── Error wording ─────────────────────────────

function permProblem(error: PermError): string {
  switch (error.kind) {
    case "NOT_FOUND":
      return "I couldn't find a perm by that name or id. `/perm action:list` shows yours.";
    case "DISBANDED":
      return "That perm has been disbanded, so it can't be changed. Create a new one with `/perm action:create`.";
    case "NAME_TAKEN":
      return `"${error.name}" is already the name of an active perm. Pick another.`;
    case "NOT_OWNER":
      return "Only the person who created that perm (or staff) can change it.";
    case "FULL":
      return `That perm is full — ${error.capacity} seats. Remove someone first.`;
    case "ALREADY_ON_ROSTER":
      return `${error.ign} already has that seat.`;
    case "NOT_ON_ROSTER":
      return `${error.ign} isn't on that roster in that role.`;
    case "INVALID_ROLE":
      return `That isn't a role for this activity. Try one of: ${error.allowed.join(", ")}.`;
    case "INVALID_NAME":
      return `That name won't work — ${error.detail}`;
    case "INVALID_IGN":
      return "Which player? Pass `ign:` with their Minecraft name.";
  }
}

/**
 * Staff, for the purposes of "owner or staff may edit".
 *
 * `MENTION` is the moderator floor in the capability table, which is the same
 * line the rest of the member surface treats as staff. Resolved here rather
 * than inside `@sbr/perms` so the domain package stays free of the capability
 * model, and so a failed lookup degrades to "not staff" — the safe direction.
 */
async function isStaff(guildId: string, userId: string, deps: HandlerDeps): Promise<boolean> {
  return deps.identity.hasCapability(guildId, userId, "MENTION").catch(() => false);
}

/** Every write shares this shape: resolve the actor, act, render the roster. */
function permReply(perm: PermGroupDTO, text: string, ephemeral: boolean): CommandReply {
  return { ephemeral, text, embed: renderPermEmbed(perm) };
}

// ─────────────────────────────── Actions ───────────────────────────────

async function create(ctx: CommandContext, deps: HandlerDeps): Promise<CommandReply> {
  const notes = ctx.args.getString("notes");
  const result = await deps.perms.createPerm({
    guildId: ctx.guildId,
    ownerDiscordId: ctx.userId,
    name: ctx.args.getString("name") ?? "",
    activity: (ctx.args.getString("activity") ?? "OTHER") as LFGActivity,
    ...(notes === null ? {} : { notes }),
  });
  if (!result.ok) return { ephemeral: true, text: permProblem(result.error) };
  return permReply(
    result.value,
    `Created "${result.value.name}". Add people with \`/perm action:roster-add\`.`,
    false,
  );
}

async function info(ctx: CommandContext, deps: HandlerDeps): Promise<CommandReply> {
  const which = ctx.args.getString("perm");
  if (which === null) return list(ctx, deps);

  const result = await deps.perms.getPerm(ctx.guildId, which);
  if (!result.ok) return { ephemeral: true, text: permProblem(result.error) };
  return permReply(result.value, permChatLine(result.value), false);
}

async function list(ctx: CommandContext, deps: HandlerDeps): Promise<CommandReply> {
  // Unscoped: perms are a public thing within the guild — half the point is
  // seeing who already has a five-stack before starting a sixth.
  const result = await deps.perms.listPerms(ctx.guildId);
  if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
  const perms = result.value;
  return {
    ephemeral: false,
    text:
      perms.length === 0
        ? "No perms yet. Start one with /perm action:create."
        : perms.map((p) => `${p.name} ${p.members.length}/${p.capacity}`).join(" | "),
    embed: renderPermListEmbed(perms, false),
  };
}

async function rosterChange(
  ctx: CommandContext,
  deps: HandlerDeps,
  direction: "add" | "remove",
): Promise<CommandReply> {
  const which = ctx.args.getString("perm");
  if (which === null) return { ephemeral: true, text: "Which perm? Pass `perm:` with its name." };

  const slot = ctx.args.getNumber("slot");
  const change = {
    guildId: ctx.guildId,
    idOrName: which,
    actor: { discordId: ctx.userId, isStaff: await isStaff(ctx.guildId, ctx.userId, deps) },
    ign: ctx.args.getString("ign") ?? "",
    role: ctx.args.getString("role") ?? "filler",
    ...(slot === null ? {} : { slot }),
  };

  const result =
    direction === "add" ? await deps.perms.addToRoster(change) : await deps.perms.removeFromRoster(change);
  if (!result.ok) return { ephemeral: true, text: permProblem(result.error) };

  const perm = result.value;
  const verb = direction === "add" ? "Added" : "Removed";
  return permReply(perm, `${verb} ${change.ign} — ${perm.members.length}/${perm.capacity}.`, false);
}

async function disband(ctx: CommandContext, deps: HandlerDeps): Promise<CommandReply> {
  const which = ctx.args.getString("perm");
  if (which === null) return { ephemeral: true, text: "Which perm? Pass `perm:` with its name." };

  const result = await deps.perms.disbandPerm(ctx.guildId, which, {
    discordId: ctx.userId,
    isStaff: await isStaff(ctx.guildId, ctx.userId, deps),
  });
  if (!result.ok) return { ephemeral: true, text: permProblem(result.error) };
  // Ephemeral: disbanding is housekeeping, and announcing it to the channel
  // invites a conversation the owner didn't ask for.
  return permReply(result.value, `Disbanded "${result.value.name}". The name is free again.`, true);
}

async function setDefault(ctx: CommandContext, deps: HandlerDeps): Promise<CommandReply> {
  const which = ctx.args.getString("perm");
  if (which === null) return { ephemeral: true, text: "Which perm? Pass `perm:` with its name." };

  const result = await deps.perms.setDefaultPerm(ctx.guildId, which, {
    discordId: ctx.userId,
    isStaff: await isStaff(ctx.guildId, ctx.userId, deps),
  });
  if (!result.ok) return { ephemeral: true, text: permProblem(result.error) };
  return permReply(
    result.value,
    `"${result.value.name}" is now what /lfg fills from for ${result.value.activity.toLowerCase()}.`,
    true,
  );
}

const perm: CommandHandler = async (ctx, deps) => {
  switch (ctx.args.getString("action") ?? "info") {
    case "create":
      return create(ctx, deps);
    case "list":
      return list(ctx, deps);
    case "roster-add":
      return rosterChange(ctx, deps, "add");
    case "roster-remove":
      return rosterChange(ctx, deps, "remove");
    case "disband":
      return disband(ctx, deps);
    case "default":
      return setDefault(ctx, deps);
    default:
      return info(ctx, deps);
  }
};

/**
 * Suggest perms by name — the caller's own first, since those are the ones they
 * can edit. Degrades to an empty list on any failure: Discord shows nothing on
 * an autocomplete error anyway, so there is no better outcome to reach for.
 */
const permAutocomplete: AutocompleteHandler = async (focused, ctx, deps) => {
  if (focused.name !== "perm") return [];

  const all = await deps.perms.listPerms(ctx.guildId);
  if (!all.ok) return [];

  const typed = focused.value.trim().toLowerCase();
  return all.value
    .filter((p) => typed === "" || p.name.toLowerCase().includes(typed))
    .sort((a, b) => Number(b.ownerDiscordId === ctx.userId) - Number(a.ownerDiscordId === ctx.userId))
    .slice(0, 25)
    .map((p) => ({ name: `${p.name} (${p.members.length}/${p.capacity})`, value: p.name }));
};

// ─────────────────────────────── Registry ───────────────────────────────

export function permSpecs(): readonly CommandSpec[] {
  return [
    {
      name: "perm",
      category: "GUILD",
      description: "Standing parties — create one, see a roster, add or drop people",
      options: [
        {
          name: "action",
          description: "What to do (default info)",
          type: "string",
          choices: [
            { name: "Show a perm", value: "info" },
            { name: "List perms", value: "list" },
            { name: "Create", value: "create" },
            { name: "Add to roster", value: "roster-add" },
            { name: "Remove from roster", value: "roster-remove" },
            { name: "Disband", value: "disband" },
            { name: "Make my LFG default", value: "default" },
          ],
        },
        {
          name: "perm",
          description: "Which perm, by name or id",
          type: "string",
          autocomplete: true,
        },
        { name: "name", description: "Name for the new perm (when creating)", type: "string" },
        {
          name: "activity",
          description: "What it runs (when creating)",
          type: "string",
          choices: [
            { name: "Dungeons", value: "DUNGEONS" },
            { name: "Slayers", value: "SLAYERS" },
            { name: "Kuudra", value: "KUUDRA" },
            { name: "Fishing", value: "FISHING" },
            { name: "Mining", value: "MINING" },
            { name: "Other", value: "OTHER" },
          ],
        },
        { name: "ign", description: "Minecraft name (when adding or removing)", type: "string" },
        { name: "role", description: "Their role, e.g. healer, tank, filler", type: "string" },
        { name: "slot", description: "Seat order (optional)", type: "integer", minValue: 0, maxValue: 20 },
        { name: "notes", description: "Anything worth remembering about the group", type: "string" },
      ],
      capability: "RUN_COMMAND",
      cooldownMs: 10_000,
      // Reads and writes both reachable from guild chat, because a perm is a
      // thing people assemble in-game. `"linked"` — every action here is
      // attributed to a person, and a chat line alone can't name one.
      inGame: "linked",
      handler: perm,
      autocomplete: permAutocomplete,
    },
  ];
}
