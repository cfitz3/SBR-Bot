import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import { defineConfig, env } from "prisma/config";

// Intentionally self-contained: this build-time config runs during `prisma
// generate` BEFORE any workspace package (including @sbr/env) is compiled, so it
// can't import @sbr/env. It mirrors @sbr/env's semantics — anchor to the
// monorepo root via the pnpm-workspace.yaml marker, then load the root .env.
(function loadRootEnv(start = process.cwd()): void {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      for (const name of [".env.local", ".env"]) {
        const path = join(dir, name);
        if (existsSync(path)) loadEnv({ path });
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  loadEnv();
})();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
