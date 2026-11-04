// Merges duplicate openings already stored (for example, ones saved before the matching rules
// improved). Uses the same rules as the collector (src/collector/jobPool.js); the work is in src/dedupe.js.
// The earliest-found copy is kept and gains the other copies' platforms, links and contact details
// (HR details typed in on the dashboard too); the rest are deleted. A job the team added by hand is never
// deleted: it is never merged into another one (a later collected copy can still be merged into it).
// Run with --dry-run to only print what would be merged.
import { connectDb, disconnectDb } from '../src/db.js';
import { dedupeJobs } from '../src/dedupe.js';

const dryRun = process.argv.includes('--dry-run');

await connectDb();
try {
  await dedupeJobs({ dryRun });
} finally {
  await disconnectDb();
}
