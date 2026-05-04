/**
 * One-shot backfill: re-parse every existing task-shaped memory file and
 * populate memory_files.task_meta. Idempotent — safe to run after each
 * deploy until we're confident every write path populates the cache.
 */

import { backfillTaskMeta, pool } from "@runner-mobile/db";

async function main() {
  const result = await backfillTaskMeta();
  console.log(`scanned=${result.scanned} updated=${result.updated}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
