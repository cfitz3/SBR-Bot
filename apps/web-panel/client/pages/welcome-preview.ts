/**
 * The greeter's renderer, mirrored for the browser.
 *
 * A copy rather than an import for the same reason `channel-slots.ts` keeps its
 * own list: the client half has no bundler, so a runtime import of a workspace
 * package would emit a bare specifier nothing can resolve. The duplication is
 * guarded — `welcome-preview.test.ts` runs under Node, imports the real
 * `renderTemplate` from `@sbr/roles`, and fails if the two ever disagree.
 *
 * Worth mirroring at all because the preview is the whole point of the editor:
 * a welcome message is written once and then read by everybody who ever joins,
 * and the cheapest moment to notice that `{membercount}` is not a token is
 * before it is saved rather than after four hundred people have read it.
 */

/** `{token}` — no whitespace, no nesting, no expressions. */
const TOKEN = /\{([a-zA-Z]+)\}/g;

/** Anything that could turn one admin's typo into eight hundred pings. */
const BROADCAST = /@(everyone|here)/g;

/** The closed token set, in the order the hint lists them. */
export const WELCOME_TOKENS = [
  "user",
  "username",
  "server",
  "memberCount",
  "ign",
  "guildRank",
  "level",
] as const;

export type WelcomeToken = (typeof WELCOME_TOKENS)[number];

const KNOWN = new Set<string>(WELCOME_TOKENS);

/**
 * Interpolate, exactly as the greeter does: one pass over the source, so a
 * value that is itself token-shaped is never re-scanned, and `@everyone`
 * becomes a zero-width-spaced lookalike that pings nobody.
 */
export function renderPreview(template: string, values: Partial<Record<WelcomeToken, string>>): string {
  const rendered = template.replace(TOKEN, (whole, name: string) =>
    KNOWN.has(name) ? values[name as WelcomeToken] ?? "" : whole,
  );
  return rendered.replace(BROADCAST, "@​$1");
}

/**
 * Stand-in values for the preview.
 *
 * Deliberately not the viewer's own name or the real member count: a preview
 * that looked like a real post is a preview somebody screenshots and asks why
 * it never appeared in the channel.
 */
export const SAMPLE_VALUES: Readonly<Record<WelcomeToken, string>> = {
  user: "@Ash",
  username: "Ash",
  server: "Skyblock and Relax",
  memberCount: "412",
  ign: "AshOnMars",
  guildRank: "Member",
  level: "27",
};
