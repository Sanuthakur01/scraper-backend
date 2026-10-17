// Applies the current rules to jobs already stored, after any of these change:
//   - course rules (src/config/courses.js): a job moves to its new course, or is removed if it fits none
//   - excluded companies (src/config/filters.js): their jobs are removed
//   - experience range (EXPERIENCE_MIN / EXPERIENCE_MAX): jobs outside it, or without stated experience,
//     are removed; each job's experience group is updated
// Jobs someone typed HR details into on the dashboard are never removed (counted as "kept: HR details").
// Run with --dry-run to only print what would change.
// Removed jobs can come back with `npm run replay` (raw results are kept 14 days) if the rules are relaxed.
import { config } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { classifyTitle } from '../src/classify.js';
import { experienceInRange, isExcludedCompany } from '../src/config/filters.js';
import { experienceBand } from '../src/normalize.js';
import { Job } from '../src/models.js';

const dryRun = process.argv.includes('--dry-run');

await connectDb();
try {
  const counts = { moved: 0, noCourse: 0, bigCompany: 0, outsideExperience: 0, noExperience: 0, band: 0, kept: 0, keptManual: 0 };
  const examples = { bigCompany: new Set(), outsideExperience: [] };
  let ops = [];
  const flush = async () => {
    if (ops.length && !dryRun) await Job.bulkWrite(ops, { ordered: false });
    ops = [];
  };
  const remove = (job, reason) => {
    if (job.manual) {
      counts.keptManual++;
      return;
    }
    counts[reason]++;
    ops.push({ deleteOne: { filter: { _id: job._id } } });
  };

  const fields = { title: 1, company: 1, course: 1, experienceMin: 1, experienceMax: 1, experienceBand: 1, manual: 1 };
  for await (const job of Job.find({}, fields).lean().cursor()) {
    const course = classifyTitle(job.title);
    if (!course) remove(job, 'noCourse');
    else if (isExcludedCompany(job.company)) {
      remove(job, 'bigCompany');
      examples.bigCompany.add(job.company);
    } else if (job.experienceMin == null) remove(job, 'noExperience');
    else if (!experienceInRange(job.experienceMin)) {
      remove(job, 'outsideExperience');
      if (examples.outsideExperience.length < 4) examples.outsideExperience.push(`"${job.title}" (${job.experienceMin}${job.experienceMax != null ? `-${job.experienceMax}` : '+'} yrs)`);
    } else {
      counts.kept++;
      const set = {};
      if (course !== job.course) {
        set.course = course;
        counts.moved++;
      }
      const band = experienceBand(job.experienceMin);
      if (band !== job.experienceBand) {
        set.experienceBand = band;
        counts.band++;
      }
      if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: job._id }, update: { $set: set } } });
    }
    if (ops.length >= 500) await flush();
  }
  await flush();

  const removed = counts.noCourse + counts.bigCompany + counts.outsideExperience + counts.noExperience;
  console.log(`${dryRun ? 'Dry run - would remove' : 'Removed'} ${removed} jobs:`);
  console.log(`  ${counts.bigCompany} at excluded big companies${counts.bigCompany ? ` (${[...examples.bigCompany].slice(0, 8).join(', ')}${examples.bigCompany.size > 8 ? ', …' : ''})` : ''}`);
  console.log(`  ${counts.outsideExperience} asking for experience outside ${config.experience.min}-${config.experience.max} years${examples.outsideExperience.length ? `, e.g. ${examples.outsideExperience.join('; ')}` : ''}`);
  console.log(`  ${counts.noExperience} that don't state their experience`);
  console.log(`  ${counts.noCourse} that no longer match any course`);
  console.log(`Kept ${counts.kept} jobs (${counts.moved} moved to another course, ${counts.band} experience groups updated).`);
  if (counts.keptManual) console.log(`Also kept ${counts.keptManual} jobs that no longer fit the rules, because HR details were typed in for them.`);
  if (dryRun) console.log('Nothing changed. Run without --dry-run to apply.');
} finally {
  await disconnectDb();
}
