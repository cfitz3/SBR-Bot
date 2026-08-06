/**
 * Member bot command handlers. Thin: resolve identity, call a domain service,
 * render. The registry wires these with capability + cooldown metadata.
 */
import type { CommandHandler, CommandSpec } from "./types.js";
import { renderFailure, renderLinkError, renderNetworth } from "./render.js";

const help: CommandHandler = async () => ({
  ephemeral: true,
  text: "Commands: /link <ign>, /networth [player], /help",
});

const link: CommandHandler = async (ctx, deps) => {
  const ign = ctx.args.ign?.trim();
  if (!ign) return { ephemeral: true, text: "Usage: /link <ign>" };

  const result = await deps.identity.linkByIgn(ctx.userId, ign);
  if (!result.ok) return { ephemeral: true, text: renderLinkError(result.error) };
  return { ephemeral: true, text: `Linked to ${result.value.ign}. ✅` };
};

const networth: CommandHandler = async (ctx, deps) => {
  // Resolve the caller's linked account (self-lookup for this slice).
  const linked = await deps.identity.resolveByDiscordId(ctx.userId);
  if (!linked.ok || linked.value === null) {
    return { ephemeral: true, text: renderFailure("NOT_LINKED") };
  }
  const nw = await deps.progression.getNetworth(linked.value.minecraftUuid);
  return { ephemeral: false, text: `${linked.value.ign}: ${renderNetworth(nw)}` };
};

export function buildBridgeRegistry(): Map<string, CommandSpec> {
  const specs: CommandSpec[] = [
    { name: "help", cooldownMs: 3_000, handler: help },
    { name: "link", cooldownMs: 10_000, handler: link },
    { name: "networth", capability: "RUN_COMMAND", cooldownMs: 15_000, handler: networth },
  ];
  return new Map(specs.map((s) => [s.name, s]));
}
