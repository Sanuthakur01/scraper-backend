// Applies the current rules to the jobs already stored, kept and non-filtered (see src/reclassify.js),
// after any of these change:
//   - course rules (src/config/courses.js): a job moves to its new course, or is removed if it fits none
//   - excluded companies (src/config/filters.js) or the experience range (EXPERIENCE_MIN / EXPERIENCE_MAX):
//     kept jobs the rules now leave out move to the non-filtered jobs, and non-filtered jobs the rules
//     now keep move to the kept jobs
// Jobs someone typed HR details into are never removed; when they move, the details move with them.
// Run with --dry-run to only print what would change.
import { connectDb, disconnectDb } from '../src/db.js';
import { experienceRangeText } from '../src/config/filters.js';
import { reclassifyJobs } from '../src/reclassify.js';

const dryRun = process.argv.includes('--dry-run');

await connectDb();
try {
  const { counts: c, examples } = await reclassifyJobs({ dryRun });
  const would = dryRun ? 'would ' : '';
  const toNonFiltered = Object.values(c.toNonFiltered).reduce((a, b) => a + b, 0);
  console.log(`${dryRun ? 'Dry run: ' : ''}rules: excluded companies, ${experienceRangeText()} years' experience, a course match.`);
  console.log(`  Filtered (kept) jobs: ${c.kept} stay; ${toNonFiltered} ${would}move to Non-filtered` +
    `${toNonFiltered ? ` (${c.toNonFiltered['big-company']} big company, ${c.toNonFiltered.experience} under the minimum experience, ${c.toNonFiltered.senior} over the maximum, ` +
      `${c.toNonFiltered['no-experience']} experience not stated)` : ''}${examples.toNonFiltered.length ? `, e.g. ${examples.toNonFiltered.join('; ')}` : ''}`);
  console.log(`  Non-filtered jobs: ${c.nonFiltered} stay; ${c.toKept} ${would}move to Filtered${examples.toKept.length ? `, e.g. ${examples.toKept.join('; ')}` : ''}`);
  console.log(`  ${c.noCourse} jobs that no longer match any course ${would}${dryRun ? 'be ' : ''}removed.`);
  console.log(`  ${c.courseChanged} ${would}move to another course, ${c.bandChanged} experience groups ${would}${dryRun ? 'be ' : ''}updated.`);
  if (c.keptManual) console.log(`  Also kept ${c.keptManual} jobs that fit no course, because HR details were typed in for them.`);
  if (c.moveFailed) console.log(`  ${c.moveFailed} jobs could not move (the other set already has one of their listings) and stayed where they were.`);
  if (dryRun) console.log('Nothing changed. Run without --dry-run to apply.');
} finally {
  await disconnectDb();
}
