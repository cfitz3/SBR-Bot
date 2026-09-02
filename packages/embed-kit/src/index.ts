/**
 * @sbr/embed-kit — the house card style, with no transport attached.
 *
 * It lives apart from `@sbr/discord-kit` for one reason: the command packages
 * have to be able to import it. `commands-bridge` and `commands-admin` are
 * deliberately transport-agnostic and offline-testable, and `discord-kit`
 * depends on discord.js — so a renderer that wanted `card()` from there would
 * have pulled a gateway client into a package whose whole point is not having
 * one. The builder was written discord.js-free from the start; this makes that
 * a fact about the dependency graph rather than a habit.
 *
 * `discord-kit` re-exports everything here, so the bots and the gallery keep
 * importing from one place.
 */
export {
  capMarker,
  card,
  facts,
  field,
  inlineFacts,
  isCapped,
  marker,
  player,
  progressBar,
  progressLine,
  sparkline,
  type CardSpec,
  type Fact,
} from "./card.js";
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
export {
  BUG_TICKET_BUTTON_ID,
  failureComponents,
  failureReply,
  type FailureKind,
} from "./failure.js";
