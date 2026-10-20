// `npm run collect`: the whole pipeline in one command, from scraping to the database.
//   LinkedIn  -> Apify
//   Naukri, Indeed, Glassdoor -> our Python scraper in naukri-scraper/ (one Chrome window each)
// All platforms run at the same time; each one's jobs are saved as soon as it finishes.
// Exit code: 0 = everything (or most things) saved, 1 = nothing could be collected or saved.
// --days N (1-30): search postings from the last N days instead of the last day, e.g. a one-off
// 30-day backfill: `npm run collect -- --days 30`. New jobs are then dated by when they were posted.
import { config } from '../src/config.js';
import { COURSES } from '../src/config/courses.js';
import { experienceRangeText } from '../src/config/filters.js';
import { enabledSources } from '../src/config/sources.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { collect, perSearch, stopActiveRun } from '../src/collector/collect.js';
import { checkApifyCredit, createApifyFetcher } from '../src/collector/apify.js';
import { createScraperFeedFetcher, stopScrapers } from '../src/collector/scraperFeed.js';

// Ctrl+C or closing the window: close the scraper browsers and release the lock before exiting, so
// the next `npm run collect` can start straight away. Platforms already saved stay saved.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping: closing the scrapers and releasing the lock (jobs already saved stay saved)...');
    stopScrapers();
    await stopActiveRun('Stopped by user before finishing').catch(() => {});
    await disconnectDb().catch(() => {});
    process.exit(130);
  });
}

const daysAt = process.argv.indexOf('--days');
const lookbackDays = daysAt > -1 ? Number(process.argv[daysAt + 1]) : 1;
if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 30) {
  console.error('--days must be a whole number from 1 to 30.');
  process.exit(1);
}

const started = Date.now();
const sources = enabledSources(config.disabledSources);

// LinkedIn (Apify): if it can't run (no APIFY_TOKEN, or not enough Apify credit left this month), its
// searches are reported as failed with the reason, and the other platforms are collected as usual.
let linkedinProblem = '';
if (sources.some((s) => s.via === 'apify')) {
  if (!config.apifyToken) {
    linkedinProblem = 'APIFY_TOKEN is not set, so LinkedIn was skipped. Add it to .env (or set DISABLED_SOURCES=LinkedIn to stop this message).';
  } else {
    const searches = COURSES.reduce((n, c) => n + c.searchTerms.length, 0);
    const credit = await checkApifyCredit(config.apifyToken, { searches, limitPerSearch: config.limitPerSearch });
    if (!credit.ok) {
      const resets = credit.resetsAt ? `; it resets on ${new Date(credit.resetsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : '';
      linkedinProblem = `Not enough Apify credit for LinkedIn: $${credit.left.toFixed(2)} left this month, this run needs about $${credit.needed.toFixed(2)}${resets}. LinkedIn was skipped.`;
    } else if (credit.left != null) {
      console.log(`Apify credit: $${credit.left.toFixed(2)} left this month (this run uses about $${credit.needed.toFixed(2)} for LinkedIn).`);
    }
  }
  if (linkedinProblem) console.log(`⚠ ${linkedinProblem}`);
}

const apifyFetch = config.apifyToken && !linkedinProblem ? createApifyFetcher(config.apifyToken) : null;
const scraperFetch = createScraperFeedFetcher(config.scraper);
const fetchers = {
  apify: apifyFetch
    ? perSearch((source, input) => apifyFetch(source.actorId, input), config.apifyConcurrency)
    : async () => {
        throw new Error(linkedinProblem);
      },
  scraper: scraperFetch,
};

// The database: a short network blip at the start shouldn't cost the whole collection.
const DB_WAITS_S = [20, 60];
for (let attempt = 0; ; attempt++) {
  try {
    await connectDb();
    break;
  } catch (err) {
    if (attempt >= DB_WAITS_S.length || /MONGODB_URI is not set/.test(err.message)) {
      console.error(`Could not connect to MongoDB: ${err.message}`);
      process.exit(1);
    }
    console.log(`Could not connect to MongoDB (${err.message}). Trying again in ${DB_WAITS_S[attempt]}s...`);
    await disconnectDb().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, DB_WAITS_S[attempt] * 1000));
  }
}

try {
  if (lookbackDays > 1) {
    console.log(`Backfill: postings from the last ${lookbackDays} days. New jobs are dated by when they were posted.`);
  }
  const run = await collect({ fetchSearches: (source, inputs) => fetchers[source.via](source, inputs), lookbackDays });
  const t = run.totals;
  console.log(`\n========== Collection ${run.status.toUpperCase()} in ${Math.round((Date.now() - started) / 60_000)} min ==========`);
  for (const p of run.platforms) {
    const searches = `${p.searches - p.failedSearches}/${p.searches} searches ok`;
    const saved = p.saveError ? `NOT SAVED: ${p.saveError}` : `${p.newJobs} new, ${p.knownJobs} already known`;
    console.log(`  ${p.platform.padEnd(10)} ${searches.padEnd(18)} fetched ${String(p.fetched ?? 0).padStart(5)}  ->  ${saved}`);
  }
  console.log(`  Total: ${t.unique} jobs this run (${t.inserted} new, ${t.updated} already known); ${t.removedOld} old jobs removed.`);
  console.log(
    `  Left out: ${t.bigCompany} at excluded big companies, ${t.outsideExperience} outside ` +
      `${experienceRangeText()} years, ${t.noExperience - t.noExperienceKept} without stated experience ` +
      `(${t.noExperienceKept} of those were added to a matching ${experienceRangeText()} year job).`,
  );
  const nf = t.nonFiltered ?? {};
  console.log(
    run.nonFilteredError
      ? `  Non-filtered jobs NOT saved: ${run.nonFilteredError}`
      : `  Non-filtered (the left-out jobs, on the dashboard's Non-filtered switch): ${nf.inserted ?? 0} new, ${nf.updated ?? 0} already known.`,
  );
  if (run.status !== 'success') console.log('  Some searches failed or were not saved; see the lines above. The other results are saved.');
  if (run.status === 'failed') process.exitCode = 1;
} catch (err) {
  console.error(`\nCollection stopped: ${err.message}`);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
