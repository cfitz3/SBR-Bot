/**
 * @sbr/guide — the progression advisory domain: content schema, loader, ranker
 * and ports. Pure functions over DTOs; every read of the world arrives through
 * an injected port, so the whole package is testable without a network.
 *
 * Two rules govern everything that lands here, and both are enforced in
 * `rules.ts` rather than asserted in a comment:
 *
 *  1. No AI-generated advice, ever. Every recommendation traces to a curated,
 *     human-verified record carrying `sources[]` and a `lastVerifiedPatch`.
 *  2. Read-advise-discard. Advice is computed from a profile read and thrown
 *     away; nothing player-scoped is persisted beyond a cache TTL.
 *
 * See docs/GUIDE.md for the charter and the dual-repo contract.
 */
export { isPublishable, withholdReason, type Citable, type ContentStatus } from "./rules.js";
