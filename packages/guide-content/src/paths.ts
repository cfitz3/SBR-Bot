/**
 * Where the curated corpus lives on disk, and where the compiler puts what it
 * makes of it. Constants rather than string literals scattered through a build
 * script, because three separate things need to agree on these: the compiler,
 * the CI gate that re-runs it and diffs, and the mirror exporter that carries
 * the result into the standalone repo.
 *
 * All paths are relative to this package's root.
 */

/**
 * Hand-written YAML, one file per topic, laid out `{phase}/{category}/*.yaml`.
 *
 * Hand-written is the whole design. Every record in here was checked by a human
 * against a primary source and stamped with the patch it was checked against;
 * nothing is scraped into it and nothing is generated into it.
 */
export const CONTENT_DIR = "content";

/** Compiled, validated artefact — the only thing the runtime ever reads. */
export const GENERATED_DIR = "generated";

/** The artefact itself: the corpus after schema validation and the loader gate. */
export const ARTEFACT_FILE = `${GENERATED_DIR}/content.json`;

/**
 * The NEU-REPO commit this corpus was compiled against.
 *
 * Pinned rather than tracked. NEU-REPO is community-maintained and generally
 * excellent, but an upstream mistake followed live is an upstream mistake
 * shipped straight to a player as advice — precisely the failure this project
 * exists to avoid. Moving the pin is a deliberate act with a diff to read.
 */
export const NEU_PIN_FILE = "neu.pin.json";
