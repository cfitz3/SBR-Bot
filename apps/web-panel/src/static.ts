/**
 * Static asset resolution for the panel UI.
 *
 * The UI is plain ES modules compiled by `tsc -p tsconfig.client.json` into
 * `public/app/`, served beside the hand-written `index.html` and `app.css`. No
 * bundler sits in between, so what the browser loads is what tsc emitted — which
 * is also why this file exists: serving a directory from an HTTP server needs a
 * path guard, and a guard is worth testing on its own.
 */
import { fileURLToPath } from "node:url";

/** `dist/static.js` → `apps/web-panel/public/`. */
export const ASSET_ROOT = new URL("../public/", import.meta.url);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/**
 * Content type by extension, or null for anything not on the list.
 *
 * A null is a refusal to serve, not a fallback to octet-stream: everything the
 * panel ships is one of these, so an unknown extension means something ended up
 * in `public/` that was never meant to be public.
 */
export function contentTypeFor(pathname: string): string | null {
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return null;
  return CONTENT_TYPES[pathname.slice(dot).toLowerCase()] ?? null;
}

export interface ResolvedAsset {
  readonly filePath: string;
  readonly contentType: string;
}

/**
 * Map a request path to a file inside `root`, or null if it doesn't resolve to
 * one we're willing to serve.
 *
 * The containment check compares resolved URLs rather than inspecting the path
 * for `..`, so encoded traversal (`%2e%2e%2f`), backslashes on Windows, and
 * absolute paths are all covered by the same test instead of three string rules
 * that each need to be right.
 */
export function resolveAsset(pathname: string, root: URL = ASSET_ROOT): ResolvedAsset | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null;

  if (!decoded.startsWith("/")) return null;
  // A second leading slash is protocol-relative to a URL parser; collapsing it
  // would quietly turn `//host/x.js` into a same-root lookup for `host/x.js`.
  if (decoded.startsWith("//")) return null;

  const relative = decoded === "/" ? "index.html" : decoded.slice(1);
  if (relative.length === 0) return null;

  // The client's unit tests compile into public/app alongside the code they
  // cover. They're inert, but they're build artefacts rather than part of the
  // app, and the app never requests them.
  if (relative.endsWith(".test.js")) return null;

  const contentType = contentTypeFor(relative);
  if (contentType === null) return null;

  let resolved: URL;
  try {
    resolved = new URL(relative, root);
  } catch {
    return null;
  }
  if (!resolved.href.startsWith(root.href)) return null;

  return { filePath: fileURLToPath(resolved), contentType };
}
