/**
 * The whole type surface of SBR-Guide.
 *
 * `common.ts` is copied verbatim from the platform this bot was extracted from —
 * it is the generic result/envelope vocabulary the parsers and the Hypixel
 * client are written against, and there is nothing player-specific in it.
 * `dtos.ts` is a hand-written reduction rather than a copy: see the note at the
 * top of that file, and COMPLIANCE.md §1.
 */
export * from "./common.js";
export * from "./dtos.js";
