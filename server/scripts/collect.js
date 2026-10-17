// `npm run collect`: the whole pipeline in one command, from scraping to the database.
//   LinkedIn  -> Apify
//   Naukri, Indeed, Glassdoor -> our Python scraper in naukri-scraper/ (one Chrome window each)
// All platforms run at the same time; each one's jobs are saved as soon as it finishes.
// Exit code: 0 = everything (or most things) saved, 1 = nothing could be collected or saved.
import { config } from '../src/config.js';
import { enabledSources } from '../src/config/sources.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { collect, perSearch, stopActiveRun } from '../src/collector/collect.js';
import { createApifyFetcher } from '../src/collector/apify.js';
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

const sources = enabledSources(config.disabledSources);
if (sources.some((s) => s.via === 'apify') && !config.apifyToken) {
  console.error('APIFY_TOKEN is not set (needed for LinkedIn). Add it to .env, or skip LinkedIn with DISABLED_SOURCES=LinkedIn.');
  process.exit(1);
}

const apifyFetch = config.apifyToken ? createApifyFetcher(config.apifyToken) : null;
const scraperFetch = createScraperFeedFetcher(config.scraper);
const fetchers = {
  apify: perSearch((source, input) => apifyFetch(source.actorId, input), config.apifyConcurrency),
  scraper: scraperFetch,
};

const started = Date.now();
try {
  await connectDb();
} catch (err) {
  console.error(`Could not connect to MongoDB: ${err.message}`);
  process.exit(1);
}

try {
  const run = await collect({ fetchSearches: (source, inputs) => fetchers[source.via](source, inputs) });
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
      `${config.experience.min}-${config.experience.max} years, ${t.noExperience - t.noExperienceKept} without stated experience ` +
      `(${t.noExperienceKept} of those were added to a matching 2-${config.experience.max} year job).`,
  );
  if (run.status !== 'success') console.log('  Some searches failed or were not saved; see the lines above. The other results are saved.');
  if (run.status === 'failed') process.exitCode = 1;
} catch (err) {
  console.error(`\nCollection stopped: ${err.message}`);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
