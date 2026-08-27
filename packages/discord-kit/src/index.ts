/**
 * @sbr/discord-kit — the discord.js adapter layer.
 *
 * Both bots share it: spec → registration payload, interaction → CommandArgs,
 * view model → embeds/buttons. Keeping it in one package is what lets the
 * command packages stay transport-agnostic.
 *
 * The card builder and the style checker are re-exported from `@sbr/embed-kit`
 * rather than defined here. They are pure view-model code, and the command
 * packages need them without needing discord.js — but every existing caller
 * imports them from this package, and a working import is not worth breaking to
 * make a point about layering.
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
export {
  capMarker,
  card,
  checkEmbed,
  checkEmbeds,
  EMBED_LIMITS,
  EMBED_STYLE,
  facts,
  field,
  inlineFacts,
  isCapped,
  marker,
  player,
  progressBar,
  progressLine,
  switchMark,
  VIEW_COLORS,
  type CardSpec,
  type CheckOptions,
  type EmbedStyle,
  type Fact,
  type StyleIssue,
  type StyleSeverity,
} from "@sbr/embed-kit";
export { toEmbed, toActionRow, replyOptions, type ReplyView, type DiscordReplyOptions } from "./render.js";
export { respond } from "./respond.js";
export {
  fromDiscordJson,
  nearestColor,
  toDiscordJson,
  type SpecimenNote,
  type SpecimenResult,
} from "./specimen.js";
