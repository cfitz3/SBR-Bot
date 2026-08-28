/**
 * What the "How do I link?" button shows.
 *
 * Linking is the one step every member has to complete and the one step this
 * platform cannot do for them: Hypixel's Discord social field is set in-game,
 * three menus deep, and the written instructions for it have been retyped in
 * every guild's chat by every staffer who has ever been asked. A short
 * recording answers it once.
 *
 * The guild supplies the recording and, optionally, its own words — server
 * fifteen may run a modified client with a different menu, and the built-in
 * steps would be wrong there. What it cannot do is *replace* the built-in
 * steps, which is why `body` is stored beside them rather than instead of them:
 * a member whose client will not play the GIF still needs the instructions.
 *
 * Tolerant on read, strict on write, like every other policy in this package.
 */
export const LINK_HELP_SETTING_KEY = "help.link";

/**
 * Discord renders an embed image from a URL it fetches itself, so the scheme is
 * a hard requirement rather than a preference — anything else is a broken image
 * on every card the button ever shows.
 */
const ALLOWED_SCHEMES = ["https:"];

/** Long enough for the steps a modified client needs; short enough to stay a card. */
export const MAX_LINK_HELP_BODY = 900;

export interface LinkHelpPolicy {
  /** A still or animated image Discord can fetch, or null for none. */
  readonly image: string | null;
  /** The guild's own words, shown under the built-in steps, or null. */
  readonly body: string | null;
}

export const DEFAULT_LINK_HELP: LinkHelpPolicy = Object.freeze({ image: null, body: null });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return ALLOWED_SCHEMES.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Read the stored document, dropping only what cannot be used.
 *
 * A bad image URL loses the image and keeps the words, because the words are
 * still the answer to the question — an all-or-nothing read would turn one
 * mistyped link into a button that explains nothing.
 */
export function parseLinkHelp(raw: unknown): LinkHelpPolicy {
  if (!isRecord(raw)) return DEFAULT_LINK_HELP;
  const image = isImageUrl(raw["image"]) ? raw["image"] : null;
  const body =
    typeof raw["body"] === "string" && raw["body"].trim().length > 0
      ? raw["body"].trim().slice(0, MAX_LINK_HELP_BODY)
      : null;
  return { image, body };
}

/** The strict half, for the panel: the first thing wrong with this blob, or null. */
export function validateLinkHelp(raw: unknown): string | null {
  if (!isRecord(raw)) return "link help must be an object";
  const image = raw["image"];
  if (image !== null && image !== undefined && image !== "" && !isImageUrl(image)) {
    return "the image must be an https URL Discord can fetch";
  }
  const body = raw["body"];
  if (body !== null && body !== undefined && typeof body !== "string") {
    return "the extra instructions must be text";
  }
  if (typeof body === "string" && body.length > MAX_LINK_HELP_BODY) {
    return `the extra instructions must be at most ${MAX_LINK_HELP_BODY} characters`;
  }
  return null;
}
