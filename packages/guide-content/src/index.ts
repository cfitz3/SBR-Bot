/**
 * @sbr/guide-content — the curated corpus and the compiler that turns it into a
 * validated artefact.
 *
 * The corpus is YAML written by hand, each record carrying `sources[]` and the
 * patch it was last verified against. The compiler validates it against the
 * content schema, applies the publishability gate from `@sbr/guide`, and emits
 * a single JSON artefact. The runtime reads only the artefact — never the YAML,
 * never a network source — so an outage upstream costs a citation link at worst
 * and never a recommendation (docs/GUIDE.md).
 */
export { ARTEFACT_FILE, CONTENT_DIR, GENERATED_DIR, NEU_PIN_FILE } from "./paths.js";
