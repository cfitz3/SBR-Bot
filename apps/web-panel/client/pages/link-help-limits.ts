/**
 * The browser's copy of the link-help limit.
 *
 * Literal rather than an import of `@sbr/guild-config`, for the same reason as
 * `trigger-limits.ts`: a runtime import of a workspace package emits a bare
 * specifier the browser cannot resolve, and one of those in any statically
 * imported page stops the whole shell at its `Loading…` placeholder.
 *
 * Guarded by `link-help-limits.test.ts`, which runs under Node against the real
 * constant.
 */

/** Characters of extra instructions under the link help. */
export const MAX_LINK_HELP_BODY = 900;
