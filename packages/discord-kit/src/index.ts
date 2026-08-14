/**
 * @sbr/discord-kit — the discord.js adapter layer.
 *
 * Both bots share it: spec → registration payload, interaction → CommandArgs,
 * view model → embeds/buttons. Keeping it in one package is what lets the
 * command packages stay transport-agnostic.
 */
export { interactionArgs } from "./args.js";
export {
  toSlashCommand,
  toSlashCommands,
  type ChoiceLike,
  type CommandSpecLike,
  type OptionSpecLike,
} from "./builders.js";
export {
  ComponentRouter,
  CUSTOM_ID_SEPARATOR,
  customId,
  type ComponentHandler,
  type ComponentRouterDeps,
} from "./components.js";
export { toEmbed, toActionRow, replyOptions, type ReplyView, type DiscordReplyOptions } from "./render.js";
export { respond } from "./respond.js";
export {
  fromDiscordJson,
  nearestColor,
  toDiscordJson,
  type SpecimenNote,
  type SpecimenResult,
} from "./specimen.js";
export {
  checkEmbed,
  checkEmbeds,
  EMBED_LIMITS,
  EMBED_STYLE,
  VIEW_COLORS,
  type CheckOptions,
  type EmbedStyle,
  type StyleIssue,
  type StyleSeverity,
} from "./style.js";
