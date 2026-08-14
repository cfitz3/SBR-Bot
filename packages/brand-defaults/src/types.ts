/**
 * The type machinery behind the brand layer.
 *
 * The load-bearing idea: **the defaults are the schema.** `Copy` and `Theme` are
 * derived from the default objects with `typeof` rather than declared separately,
 * so there is no second list to keep in step — adding a key to the defaults adds
 * it to the type, and there is no way to write a default the type does not admit.
 *
 * That is also what makes an override safe to hand to an operator: `brand/copy.ts`
 * is typed `DeepPartial<Copy>`, so a misspelled key is a compile error rather
 * than a value that sits there looking configured while changing nothing. It is
 * the whole reason these files are TypeScript and not JSON.
 *
 * Note the defaults are written *without* `as const`: string leaves must widen to
 * `string`, or an override could only ever restate the default it is replacing.
 */

/** Every leaf optional, at every depth. The shape of an override file. */
export type DeepPartial<T> = T extends readonly (infer E)[]
  ? readonly E[]
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Every leaf readonly, at every depth. The shape of a resolved brand. */
export type DeepReadonly<T> = T extends readonly (infer E)[]
  ? readonly DeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * Walk a dotted path into a type: `Get<Copy, "panel.members">`.
 *
 * Used to type `scope()` without materialising the union of every path in the
 * tree — with ~180 commands and ~555 panel strings that union is large enough to
 * be worth not asking the compiler for on every call site.
 */
export type Get<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? Get<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;
