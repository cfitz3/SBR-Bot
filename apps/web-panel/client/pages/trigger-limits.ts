/**
 * The browser's copy of the trigger-rule limits.
 *
 * Literal declarations rather than an import of `@sbr/triggers`, for the same
 * reason as `enums.ts` and `role-menu-limits.ts`: the client half has no
 * bundler, so a runtime import of a workspace package emits a bare specifier
 * the browser cannot resolve — and `main.ts` imports every page statically, so
 * one such specifier stops the whole shell at its `Loading…` placeholder, with
 * no sign-in button and no error, because no module in the graph ever ran.
 *
 * The duplication is guarded: `trigger-limits.test.ts` runs under Node, imports
 * the real constants, and fails if either copy drifts.
 */

/** Rules per guild. The editor batches, so this bounds the whole draft. */
export const MAX_TRIGGER_RULES = 10;

/** Reactions on one message before a starboard rule fires. */
export const MIN_REACTION_THRESHOLD = 1;
export const MAX_REACTION_THRESHOLD = 50;

/** A phrase to watch for, and the reply it earns. */
export const MAX_PATTERN_LENGTH = 120;
export const MAX_REPLY_LENGTH = 400;
