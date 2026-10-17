// Loads the most recent raw results again, through the current cleaning and course rules, without
// searching again (free). Use it:
//   - after a collection said "NOT SAVED" for a platform (e.g. the database was unreachable)
//   - after changing courses.js or fixing a mapper, so jobs the old rules rejected get added
// Jobs already stored are matched, not duplicated.
// Raw results come from data/raw/ (every platform, kept 14 days). For runs from before raw files
// existed it falls back to the run's Apify datasets or scraper feed files.
import fs from 'node:fs';
import path from 'node:path';
import { ApifyClient } from 'apify-client';
import { config } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { collect, perSearch } from '../src/collector/collect.js';
import { readSavedFeed } from '../src/collector/scraperFeed.js';
import { CollectorRun } from '../src/models.js';

const key = (platform, term, location) => `${platform}|${term}|${location ?? ''}`;
const termOf = (input) => input.keywords ?? input.title ?? input.keyword;

// The newest raw file of each platform -> Map(platform|term|location -> items)
function latestRawResults() {
  const results = new Map();
  if (!fs.existsSync(config.rawDir)) return results;
  const newestFirst = fs.readdirSync(config.rawDir).filter((f) => f.endsWith('.json')).sort().reverse();
  const platformsDone = new Set();
  for (const name of newestFirst) {
    const raw = JSON.parse(fs.readFileSync(path.join(config.rawDir, name), 'utf8'));
    if (platformsDone.has(raw.platform)) continue;
    platformsDone.add(raw.platform);
    for (const s of raw.searches) if (s.status === 'ok') results.set(key(raw.platform, s.term, s.location), { file: name, items: s.items });
  }
  return results;
}

await connectDb();
try {
  const raw = latestRawResults();
  // Older runs: the newest successful Apify run or feed file for every platform + term + city.
  const runIds = new Map();
  const runs = await CollectorRun.find({ status: { $in: ['success', 'partial'] } }).sort({ startedAt: -1 }).limit(20).lean();
  for (const run of runs) {
    for (const s of run.searches ?? []) {
      const k = key(s.platform, s.term, s.location);
      if (s.status === 'ok' && s.actorRunId && !runIds.has(k)) runIds.set(k, s.actorRunId);
    }
  }
  console.log(`Replaying stored results: ${raw.size} searches from data/raw, older runs as a fallback (no new searches).`);

  const apify = config.apifyToken ? new ApifyClient({ token: config.apifyToken }) : null;
  const fetchStored = async (source, input) => {
    const k = key(source.platform, termOf(input), source.locations ? input.location : null);
    if (raw.has(k)) return { runId: `raw:${raw.get(k).file}`, items: raw.get(k).items };
    const runId = runIds.get(k);
    if (!runId) return { runId: null, items: [] };
    if (runId.startsWith('file:')) return { runId, items: readSavedFeed(runId.slice(5), termOf(input), path.join(config.rootDir, 'data', 'scraper-feed')) };
    if (!apify) return { runId: null, items: [] };
    const run = await apify.run(runId).get();
    const { items } = await apify.dataset(run.defaultDatasetId).listItems({ clean: true });
    return { runId, items };
  };

  const run = await collect({ fetchSearches: perSearch(fetchStored, 3, { retries: 0 }), log: () => {}, rawDir: null });
  const t = run.totals;
  console.log(`Replay ${run.status}: re-read ${t.fetched}, in India ${t.inIndia}, matched a course ${t.matched}, newly added ${t.inserted}, already stored ${t.updated}`);
} finally {
  await disconnectDb();
}
