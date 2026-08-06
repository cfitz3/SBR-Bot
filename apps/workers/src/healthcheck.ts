/**
 * Standalone health probe: runs the registered checks (postgres + redis) and
 * prints the aggregated report. Exit code 0 = ok/degraded, 1 = down. Intended
 * for container HEALTHCHECK and manual verification against live infra.
 */
import { closeRedis } from "@sbr/redis";
import { disconnectDb } from "@sbr/db";
import { bootstrap } from "./bootstrap.js";

async function main(): Promise<void> {
  const { health, log } = bootstrap("workers-healthcheck");
  const report = await health.run();
  log.info("health report", { report });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  await Promise.allSettled([closeRedis(), disconnectDb()]);
  process.exit(report.status === "down" ? 1 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write(`healthcheck failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
