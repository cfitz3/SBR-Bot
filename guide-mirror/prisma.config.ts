/**
 * Where the Prisma CLI finds the schema and the database.
 *
 * Prisma 7 moved the connection URL out of the schema file and into here, which
 * suits this project: `prisma/schema.prisma` is a document a reviewer reads to
 * satisfy themselves about what is stored, and it is easier to read for that
 * when it holds only models.
 *
 * The URL reaches the *CLI* through this file and reaches the *runtime* through
 * the pg driver adapter in `src/db/index.ts` — two paths, one environment
 * variable, and neither of them a value baked into a committed file.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { defineConfig, env } from "prisma/config";

// This runs before anything in `src/` is compiled, so it cannot use the config
// loader there and reads the environment itself. `.env.local` first: a local
// override should win over the committed default, the same order the app uses.
for (const name of [".env.local", ".env"]) {
  const path = join(process.cwd(), name);
  if (existsSync(path)) loadEnv({ path });
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
