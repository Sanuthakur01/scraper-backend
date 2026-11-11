// Copies the staff's interview sheet into the LMS's main database (LMS_MONGO_URI), collection all_interviews
// (src/allInterviews.js): new interviews added, changed ones updated, ones no longer in the sheet marked
// inSheet: false (never deleted). Nothing else in that database is written. Safe to run again: unchanged
// interviews aren't written. The first run is the backfill (every interview in the sheet).
//
//   npm run sync-interviews                (in server/)
//   npm run sync-interviews -- --dry-run   read the sheet and the collection, say what would change, write nothing
import { config } from '../src/config.js';
import { connectLms, LMS_COLLECTION, syncInterviews } from '../src/allInterviews.js';
import { createInterviewSource, missingSettings } from '../src/interviews.js';

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

const source = createInterviewSource(config.interviews);
if (!source) {
  console.error(`The interview sheet isn't set up: ${missingSettings(config.interviews).join(', ')} missing in server/.env.`);
  process.exit(1);
}
const sheet = await source.read();
if (sheet.error) {
  console.error(`Could not read the interview sheet: ${sheet.error}`);
  process.exit(1);
}
const days = sheet.items.map((i) => i.date).sort();
console.log(`Interview sheet: ${sheet.items.length} interviews in ${sheet.tabs.length} month tabs (${days[0]} to ${days.at(-1)}), ${sheet.courseItems.length} rows in the per-course tabs.`);

const lms = await connectLms(config.lms.mongoUri);
try {
  const where = `${lms.db.databaseName}.${LMS_COLLECTION}`;
  // Since 11 Nov 2026 the staff enter interviews in the LMS: the sheet isn't the source any more. A copy after that
  // could add again an interview taken out in the LMS, or one entered there written slightly differently.
  const inLms = await lms.collection.countDocuments({ source: 'lms' });
  if (inLms && !force && !dryRun) {
    throw new Error(`${inLms} interviews were entered or changed in the LMS, which is where interviews come from now. Copying the sheet again could add back ones taken out there. Add --force to copy anyway (the LMS's interviews are never overwritten).`);
  }
  const c = await syncInterviews(lms.collection, sheet, { dryRun });
  console.log(`${dryRun ? 'Dry run, nothing written. Would be in' : 'Saved to'} ${where}:`);
  console.log(`  ${c.inSheet} interviews in the sheet (${c.fromCourseTabsOnly} of them only in a per-course tab)`);
  console.log(`  ${c.added} new, ${c.changed} changed, ${c.unchanged} unchanged, ${c.moved} only moved to another row, ${c.back} back in the sheet, ${c.removed} no longer in the sheet (kept, marked inSheet: false), ${c.keptAsLms} changed in the LMS (left as they are)`);
  if (!dryRun) {
    const [total, inSheet] = await Promise.all([lms.collection.countDocuments({}), lms.collection.countDocuments({ inSheet: true })]);
    console.log(`  ${where} now holds ${total} interviews (${inSheet} in the sheet).`);
  }
} catch (err) {
  console.error(`Not saved: ${err.message}`);
  process.exitCode = 1;
} finally {
  await lms.close();
}
