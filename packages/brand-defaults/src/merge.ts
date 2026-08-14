/**
 * Override resolution: merge, freeze, and the scoped reader.
 *
 * Pure and dependency-free on purpose — this runs in the browser bundle, both
 * bots, the workers and the CLI scripts, so it may not reach for a Node API.
 */
import type { DeepPartial, DeepReadonly, Get } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Override wins, key by key, recursing into plain objects only.
 *
 * Arrays **replace** rather than concatenate. A merged array has no sensible
 * answer for order or duplicates, and the arrays here are things like a font
 * stack — where "my list, then yours appended" is never what anybody meant.
 *
 * An `undefined` in the override is treated as absent rather than as a request
 * to blank the value. That is what makes a partial file partial: the operator
 * names what they want to change and says nothing about the rest.
 */
export function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

/**
 * Freeze the whole tree, once, at module load.
 *
 * Copy is read on nearly every request and every rendered card. Freezing means
 * no runtime path can mutate it — a page that "just tweaked" a label in place
 * would otherwise change it for every other reader in the process, and the bug
 * would surface somewhere else entirely.
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (isPlainObject(value) || Array.isArray(value)) {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** What `scope()` hands back: a reader over one subtree of the copy. */
export type Scoped<T> = <K extends keyof T>(key: K) => T[K];

/**
 * Build the scoped reader for a resolved copy tree.
 *
 * `const t = scope("panel.members")` then `t("title")`, so a page module reads
 * about as it does with literals and the namespace is stated once rather than
 * repeated at forty call sites.
 *
 * A path that does not exist resolves to `never`, which makes the argument
 * itself unassignable — so `scope("panel.membres")` fails to compile rather than
 * returning a reader that answers `undefined` for everything.
 */
export function makeScope<Root>(root: Root) {
  return function scope<P extends string>(path: Get<Root, P> extends never ? never : P): Scoped<Get<Root, P>> {
    let node: unknown = root;
    for (const segment of path.split(".")) {
      node = isPlainObject(node) ? node[segment] : undefined;
    }
    const table = (node ?? {}) as Record<string, unknown>;
    return ((key: string) => table[key]) as Scoped<Get<Root, P>>;
  };
}
