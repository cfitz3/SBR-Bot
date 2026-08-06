/**
 * @sbr/env — the single, deterministic environment loader for the monorepo.
 *
 * Resolves the workspace root by the `pnpm-workspace.yaml` marker (not "nearest
 * .env"), so it is cwd-independent and immune to stray nested .env files. Loads,
 * in precedence order (highest first): real process.env > .env.local >
 * .env.<NODE_ENV> > .env. Idempotent across every importer via a global guard.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as dotenvConfig } from "dotenv";

const ROOT_MARKER = "pnpm-workspace.yaml";

/**
 * Walk up from `start` to the monorepo root. Prefers the directory containing
 * `pnpm-workspace.yaml`; falls back to the highest package.json declaring
 * `workspaces`, then to `start`.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = start;
  let workspacePkgRoot: string | null = null;

  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, ROOT_MARKER))) return dir;

    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
        if (pkg.workspaces) workspacePkgRoot = dir; // remember the highest one seen
      } catch {
        // ignore unreadable/invalid package.json
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return workspacePkgRoot ?? start;
}

export interface LoadedEnv {
  readonly root: string;
  /** The .env files actually loaded, in the order applied (highest precedence first). */
  readonly files: readonly string[];
}

const globalForEnv = globalThis as typeof globalThis & { __sbrEnv?: LoadedEnv };

/**
 * Load the centralised environment. Safe to call from any process at any cwd;
 * runs once (subsequent calls return the cached result). Never overrides values
 * already present in process.env (so real deploy secrets always win).
 */
export function loadRootEnv(): LoadedEnv {
  if (globalForEnv.__sbrEnv) return globalForEnv.__sbrEnv;

  const root = findRepoRoot();
  const nodeEnv = process.env.NODE_ENV ?? "development";

  // Highest precedence first — dotenv only sets vars that aren't already defined,
  // so the earliest file to define a key wins, and real process.env beats all.
  const candidates = [".env.local", `.env.${nodeEnv}`, ".env"];
  const files: string[] = [];
  for (const name of candidates) {
    const path = join(root, name);
    if (existsSync(path)) {
      dotenvConfig({ path });
      files.push(name);
    }
  }

  const loaded: LoadedEnv = { root, files };
  globalForEnv.__sbrEnv = loaded;
  return loaded;
}
