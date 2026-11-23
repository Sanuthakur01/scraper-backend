// `npm run naukri-details`: reads the new Naukri jobs' full pages for the contact details written in them, on
// its own (`npm run collect` does this after every collection; see src/collector/naukriDetails.js). One Chrome
// window opens.
//   --limit N          pages to read this run (default NAUKRI_DETAILS_LIMIT, 400)
//   --days N           jobs first seen in the last N days (default NAUKRI_DETAILS_DAYS, 7)
//   --course ID        only that course's jobs (data-analyst, data-science, data-engineering, production-support)
//   --set WHICH        filtered (kept jobs only) | nonfiltered (non-filtered only) | all (default)
//   --contacts N       stop once N contacts were found; pages are then read --batch at a time (default 20)
//   --credit EMAIL     also save the contacts found as each job's HR details under that person (Found by: Naukri),
//                      so the Performance report counts them (src/collector/creditFound.js)
// A backlog:  npm run naukri-details -- --limit 2000 --days 14
// Ten contacts for one course, under a person:
//   npm run naukri-details -- --course production-support --contacts 10 --credit person@example.com
import { config } from '../src/config.js';
import { COURSES } from '../src/config/courses.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { createCrediting, personByEmail } from '../src/collector/creditFound.js';
import { createDetailsFetcher, enrichNaukriDetails } from '../src/collector/naukriDetails.js';
import { stopScrapers } from '../src/collector/scraperFeed.js';

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, async () => {
    console.log('\nStopping: closing the browser (pages already read are saved by the next run)...');
    stopScrapers();
    await disconnectDb().catch(() => {});
    process.exit(130);
  });
}

const argValue = (flag) => {
  const at = process.argv.indexOf(flag);
  return at > -1 ? (process.argv[at + 1] ?? '') : null;
};
const argInt = (flag, fallback) => {
  const value = argValue(flag);
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) {
    console.error(`${flag} must be a whole number from 1 to 100000.`);
    process.exit(1);
  }
  return n;
};
const limit = argInt('--limit', config.naukriDetails.limit);
const days = argInt('--days', config.naukriDetails.days);
const contacts = argInt('--contacts', null);
const batchSize = argInt('--batch', contacts ? 20 : limit);
const course = argValue('--course');
if (course && !COURSES.some((c) => c.id === course)) {
  console.error(`--course: "${course}" is not one of ${COURSES.map((c) => c.id).join(', ')}.`);
  process.exit(1);
}
const SET_CHOICES = { filtered: ['kept'], nonfiltered: ['non-filtered'], all: ['kept', 'non-filtered'] };
const setArg = argValue('--set');
if (setArg && !SET_CHOICES[setArg]) {
  console.error(`--set: "${setArg}" is not one of ${Object.keys(SET_CHOICES).join(', ')}.`);
  process.exit(1);
}
const sets = SET_CHOICES[setArg] ?? SET_CHOICES.all;
const credit = argValue('--credit');

try {
  await connectDb();
} catch (err) {
  console.error(`Could not connect to MongoDB: ${err.message}`);
  process.exit(1);
}
try {
  let crediting = null;
  if (credit) {
    const person = await personByEmail(credit);
    if (!person) throw new Error(`--credit: no activity record for ${credit}. The person must have saved HR details on the dashboard once.`);
    crediting = createCrediting(person);
    console.log(`Contact details found will also be saved as HR details by ${person.name || person.email} (Found by: Naukri).`);
  }
  if (course) console.log(`Only ${COURSES.find((c) => c.id === course).name} jobs.`);
  if (setArg && setArg !== 'all') console.log(`Only ${setArg === 'filtered' ? 'Filtered (kept)' : 'Non-filtered'} jobs.`);
  if (contacts) console.log(`Stopping after ${contacts} contact(s), reading ${batchSize} pages at a time.`);

  const fetchDetails = createDetailsFetcher({ ...config.scraper, delaySeconds: config.naukriDetails.delaySeconds });
  await enrichNaukriDetails({
    fetchDetails,
    limit,
    days,
    course,
    sets,
    batchSize,
    stopAfterContacts: contacts ?? Infinity,
    onFound: crediting?.onFound ?? null,
  });
  if (crediting) {
    const s = crediting.stats;
    console.log(
      `  ✓ HR details saved: ${s.contacts} new contact(s) on ${s.jobs} job(s)` +
        `${s.copies ? `, plus ${s.copies} copied from the same company's other job (not counted as new)` : ''}` +
        `${s.refused ? `; ${s.refused} job(s) refused (a number another company's job already has)` : ''}.`,
    );
  }
} catch (err) {
  console.error(`Naukri job pages not read: ${err.message}`);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
