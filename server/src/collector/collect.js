// One collection run (`npm run collect`): every platform is searched at the same time, and each
// platform's results are saved the moment that platform finishes:
//
//   LinkedIn  (Apify)  ──┐
//   Naukri    (scraper) ─┤  as each finishes:  raw results -> data/raw/  ->  clean -> match -> save to MongoDB
//   Indeed    (scraper) ─┤                     (one platform at a time, so duplicates are matched correctly)
//   Glassdoor (scraper) ─┘
//
// Safety:
//   - Lock: a second collection can't start while one is running (so the same jobs aren't added twice);
//     a stopped or crashed collection releases it automatically.
//   - Raw results are written to disk before the database step, so nothing is lost if saving fails;
//     `npm run replay` loads them again.
//   - Failed searches are retried once; a platform that fails completely doesn't stop the others.
//   - Saving is retried, and new jobs get their database id before the first attempt, so a retry
//     can't create a second record. The database also refuses a second record for the same listing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { COURSES } from '../config/courses.js';
import { enabledSources } from '../config/sources.js';
import { CollectorRun, Job } from '../models.js';
import { buildJob } from './buildJob.js';
import { JobPool, listingFromJob, openingFromDoc } from './jobPool.js';

const DAY_MS = 86_400_000;
const KEEP_RAW_DAYS = 14;
const SAVE_ATTEMPTS = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function mapWithConcurrency(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await fn(list[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

// Turns a one-search-at-a-time fetcher, fetchOne(source, input) -> { runId, items }, into the
// collector's fetchSearches(source, inputs) -> one result per input, running `concurrency` at a time.
// A failed search is retried; if it still fails it becomes an error result instead of stopping the others.
export function perSearch(fetchOne, concurrency, { retries = 1, retryDelayMs = 10_000 } = {}) {
  return (source, inputs) =>
    mapWithConcurrency(inputs, concurrency, async (input) => {
      const started = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          const { runId, items } = await fetchOne(source, input);
          return { status: 'ok', runId, items, durationMs: Date.now() - started };
        } catch (err) {
          if (attempt >= retries) return { status: 'error', items: [], error: err.message, durationMs: Date.now() - started };
          await sleep(retryDelayMs);
        }
      }
    });
}

// Runs all of one platform's searches. Never throws: if the whole platform fails (e.g. a scraper
// can't start), every search of that platform is marked failed and the other platforms carry on.
async function searchPlatform(source, tasks, fetchSearches, log) {
  const started = Date.now();
  let results;
  try {
    results = await fetchSearches(source, tasks.map((t) => t.input));
  } catch (err) {
    results = tasks.map(() => ({ status: 'error', items: [], error: err.message }));
  }
  const durationMs = Date.now() - started;
  return tasks.map((task, i) => {
    const result = results?.[i] ?? { status: 'error', items: [], error: 'No result returned' };
    const label = `${source.platform.padEnd(9)} "${task.term}"${task.location ? ` in ${task.location}` : ''}`;
    log(result.status === 'ok' ? `  ${label}: ${result.items.length} jobs` : `  ${label}: FAILED - ${result.error}`);
    return {
      source,
      platform: source.platform,
      course: task.course.id,
      term: task.term,
      location: task.location,
      status: result.status,
      items: result.items ?? [],
      error: result.error,
      note: result.note,
      actorRunId: result.runId,
      durationMs: result.durationMs ?? durationMs,
    };
  });
}

// ---------- Run lock ----------
// While a collection runs, its run record is marked "running" with the PC and process running it and
// a heartbeat every 30 seconds. A new collection refuses to start while another one is alive. A run
// that was stopped (Ctrl+C, window closed, crash) is noticed and released:
//   - on the same PC, as soon as its process is gone
//   - on another PC (e.g. the GitHub fallback), when its heartbeat is 3 minutes old

const HEARTBEAT_MS = 30_000;
const STALE_MS = 3 * 60_000;
const STALE_SAME_PC_MS = 30 * 60_000; // in case Windows reused a dead run's process id
const thisHost = os.hostname();
let activeRun = null; // { id, heartbeat } of the collection running in this process

const processAlive = (pid) => {
  try {
    process.kill(pid, 0); // signal 0 = only check that the process exists
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

function isAbandoned(run) {
  const lastSign = run.heartbeatAt ?? run.lockedAt ?? run.startedAt;
  const silentFor = Date.now() - new Date(lastSign).getTime();
  if (run.lockedBy?.host === thisHost && run.lockedBy?.pid) return !processAlive(run.lockedBy.pid) || silentFor > STALE_SAME_PC_MS;
  return silentFor > STALE_MS;
}

const istTime = (date) =>
  new Date(date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

// Starts a run, unless another collection is still running.
async function startRun(now, log) {
  const abandoned = (await CollectorRun.find({ status: 'running' }).lean()).filter(isAbandoned);
  if (abandoned.length) {
    await CollectorRun.updateMany(
      { _id: { $in: abandoned.map((r) => r._id) }, status: 'running' },
      { $set: { status: 'failed', error: 'Stopped before finishing', finishedAt: new Date() } },
    );
    log(`Released ${abandoned.length} earlier collection(s) that stopped before finishing.`);
  }

  const run = await CollectorRun.create({
    startedAt: now,
    lockedAt: new Date(),
    heartbeatAt: new Date(),
    lockedBy: { host: thisHost, pid: process.pid },
    status: 'running',
  });
  // If two collections start at the same moment, the one that started first wins.
  const startedEarlier = (other) =>
    other.lockedAt < run.lockedAt || (+other.lockedAt === +run.lockedAt && String(other._id) < String(run._id));
  const blocker = (await CollectorRun.find({ _id: { $ne: run._id }, status: 'running' }).lean()).find(
    (other) => !isAbandoned(other) && startedEarlier(other),
  );
  if (blocker) {
    await CollectorRun.updateOne({ _id: run._id }, { $set: { status: 'failed', error: 'Another collection was running', finishedAt: new Date() } });
    const where = blocker.lockedBy?.host === thisHost ? 'on this PC' : `on ${blocker.lockedBy?.host ?? 'another PC'}`;
    throw new Error(
      `Another collection is already running ${where} (started ${istTime(blocker.lockedAt)} IST). ` +
        'Wait for it to finish, or stop it. A stopped collection is released automatically.',
    );
  }

  const heartbeat = setInterval(() => {
    CollectorRun.updateOne({ _id: run._id }, { $set: { heartbeatAt: new Date() } }).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();
  activeRun = { id: run._id, heartbeat };
  return run;
}

function endRun() {
  if (activeRun) clearInterval(activeRun.heartbeat);
  activeRun = null;
}

// Called when the collection is stopped (Ctrl+C, window closed): releases the lock straight away.
// Platforms already saved stay saved.
export async function stopActiveRun(reason) {
  if (!activeRun) return;
  const { id } = activeRun;
  endRun();
  await CollectorRun.updateOne({ _id: id, status: 'running' }, { $set: { status: 'failed', error: reason, finishedAt: new Date() } });
}

// ---------- Raw results on disk ----------

function saveRawFile(rawDir, source, now, searches, log) {
  if (!rawDir) return null;
  try {
    fs.mkdirSync(rawDir, { recursive: true });
    const file = path.join(rawDir, `${source.platform.toLowerCase()}-${now.toISOString().replace(/[:.]/g, '-')}.json`);
    const raw = {
      platform: source.platform,
      via: source.via,
      startedAt: now,
      searches: searches.map(({ term, location, course, status, error, note, items }) => ({ term, location, course, status, error, note, items })),
    };
    fs.writeFileSync(file, JSON.stringify(raw));
    for (const name of fs.readdirSync(rawDir)) {
      const full = path.join(rawDir, name);
      if (Date.now() - fs.statSync(full).mtimeMs > KEEP_RAW_DAYS * DAY_MS) fs.rmSync(full, { force: true });
    }
    return file;
  } catch (err) {
    log(`  ${source.platform}: could not write raw results to disk (${err.message}); saving to the database anyway`);
    return null;
  }
}

// ---------- Saving to MongoDB ----------

// Fields that later listings of the same opening may fill in or extend. The HR contact typed in on the
// dashboard (`manual`) is never written here, so a collection can't overwrite it.
const MERGED_FIELDS = [
  'platforms', 'links', 'sourceKeys', 'fingerprints', 'cities', 'experienceMin', 'experienceMax',
  'experienceText', 'experienceBand', 'salaryText', 'skills', 'foundPhones', 'foundEmails',
];

// A new opening is inserted (with the id it was given in the pool); a stored one gets its new
// listings and details. An opening first found by this run may also change its counting platform.
export function writeOperation(opening, now) {
  const merged = Object.fromEntries(MERGED_FIELDS.map((f) => [f, opening[f]]));
  if (!opening.isNew) {
    const ownedByThisRun = opening.createdThisRun ? { primaryPlatform: opening.primaryPlatform, postedAt: opening.postedAt } : {};
    return { updateOne: { filter: { _id: opening._id }, update: { $set: { lastSeenAt: now, ...merged, ...ownedByThisRun } } } };
  }
  return {
    insertOne: {
      document: {
        _id: opening._id,
        fingerprint: opening.fingerprints[0],
        title: opening.title,
        company: opening.company,
        course: opening.course,
        isRemote: opening.isRemote,
        postedAt: opening.postedAt,
        firstSeenAt: now,
        lastSeenAt: now,
        primaryPlatform: opening.primaryPlatform,
        ...merged,
      },
    },
  };
}

const duplicateKeyOnly = (err) => {
  const errors = err?.writeErrors ?? [];
  return err?.code === 11000 || (errors.length > 0 && errors.every((e) => (e.code ?? e.err?.code) === 11000));
};

// Writes every opening with unsaved changes. Safe to repeat: inserts that already went through on an
// earlier attempt come back as "duplicate key" and are treated as saved; updates set full values.
async function writeTouched(pool, now, log) {
  const touched = pool.openings.filter((o) => o.touched);
  if (!touched.length) return 0;
  const operations = touched.map((opening) => writeOperation(opening, now));
  for (let attempt = 1; ; attempt++) {
    try {
      await Job.bulkWrite(operations, { ordered: false });
      break;
    } catch (err) {
      if (duplicateKeyOnly(err)) {
        log(`  ${err.writeErrors?.length ?? 1} job(s) were already saved; not saved twice.`);
        break;
      }
      if (attempt >= SAVE_ATTEMPTS) throw err;
      log(`  Saving failed (${err.message}); retry ${attempt}/${SAVE_ATTEMPTS - 1} in ${2 * attempt}s`);
      await sleep(2000 * attempt);
    }
  }
  for (const opening of touched) {
    opening.isNew = false;
    opening.touched = false;
  }
  return touched.length;
}

async function loadRecentOpenings(pool, now) {
  // Only jobs seen within the dedupe window are matched by company/title/city, so a company that
  // posts "Data Engineer, Pune" again next month counts as hiring again.
  const since = new Date(now.getTime() - config.dedupeWindowDays * DAY_MS);
  for await (const doc of Job.find({ lastSeenAt: { $gte: since } }).lean().cursor()) pool.add(openingFromDoc(doc));
}

// The same platform listing (same listing id) is always the same job, however long ago it was saved.
async function loadOpeningsForListings(pool, listings) {
  const keys = [...new Set(listings.flatMap((l) => l.sourceKeys))].filter((key) => !pool.hasSourceKey(key));
  for (let i = 0; i < keys.length; i += 1000) {
    const docs = await Job.find({ sourceKeys: { $in: keys.slice(i, i + 1000) } }).lean();
    for (const doc of docs) if (!pool.has(doc._id)) pool.add(openingFromDoc(doc));
  }
}

// Cleans one platform's results, matches them against stored jobs and this run's other platforms,
// and saves them. Platforms are saved one at a time (callers chain this), because they share the pool.
// summary.queued = true once the jobs are in the pool: from then on a later save can still write them.
// Jobs that don't state their experience go to `waiting` (see attachWaitingListings).
async function savePlatform(searches, pool, now, log, summary, waiting) {
  const counts = { fetched: 0, inIndia: 0, matched: 0, bigCompany: 0, outsideExperience: 0, noExperience: 0, kept: 0 };
  const listings = [];
  for (const search of searches) {
    for (const item of search.items) {
      counts.fetched++;
      let result;
      try {
        result = buildJob(search.source, item, now);
      } catch (err) {
        log(`  Skipped one ${search.platform} item: ${err.message}`);
        continue;
      }
      if (result.skip === 'incomplete' || result.skip === 'outside-india') continue;
      counts.inIndia++;
      if (result.skip === 'no-course') continue;
      counts.matched++;
      if (result.skip === 'big-company') counts.bigCompany++;
      else if (result.skip === 'experience') counts.outsideExperience++;
      else if (result.job.experienceUnknown) {
        counts.noExperience++;
        waiting.push({ listing: listingFromJob(result.job), summary });
      } else {
        counts.kept++;
        listings.push(listingFromJob(result.job));
      }
    }
  }

  await loadOpeningsForListings(pool, listings);
  const openings = new Set();
  let newJobs = 0;
  for (const listing of listings) {
    const opening = pool.addListing(listing, () => new mongoose.Types.ObjectId());
    if (!openings.has(opening)) {
      openings.add(opening);
      if (opening.isNew) newJobs++;
    }
  }
  summary.queued = true;
  await writeTouched(pool, now, log);
  return { ...counts, newJobs, knownJobs: openings.size - newJobs };
}

// After every platform is saved: a job that doesn't state its experience is kept only when it is the
// same job as one that does state 2-5 years (on another platform, or stored earlier), so its link isn't
// lost. Done at the end because the matching job may come from a platform that finished later.
async function attachWaitingListings(waiting, pool, now, log) {
  if (!waiting.length) return;
  await loadOpeningsForListings(pool, waiting.map((w) => w.listing));
  let attached = 0;
  for (const { listing, summary } of waiting) {
    const opening = pool.find(listing);
    if (!opening) continue;
    pool.merge(opening, listing);
    summary.noExperienceKept = (summary.noExperienceKept ?? 0) + 1;
    attached++;
  }
  await writeTouched(pool, now, log);
  log(`  ${waiting.length} jobs didn't state their experience: ${attached} matched a 2-5 year job on another platform and were added to it, ${waiting.length - attached} left out.`);
}

// A failed save leaves its jobs marked unsaved in the pool, so the next successful save writes them
// too. Once that happens, the earlier platform counts as saved. (A platform that failed before its
// jobs reached the pool stays "not saved": its raw file and `npm run replay` recover it.)
function resolveEarlierFailures(summaries, log) {
  for (const summary of summaries.filter((s) => s.saveError && s.queued)) {
    log(`  ✓ ${summary.platform}: saved on a later retry`);
    summary.saveError = undefined;
    summary.savedLater = true;
    summary.savedAt = new Date();
  }
}

// ---------- The run ----------

const limitFor = (source) =>
  source.via === 'scraper' ? (config.scraper.limitPerSearch[source.platform] ?? 100) : config.limitPerSearch;

// fetchSearches(source, inputs) -> one { status, items, runId?, note?, error? } per input. It is
// injected so the real run can route LinkedIn to Apify and the other platforms to the Python scraper
// (see scripts/collect.js), and the demo and tests can run without either.
// rawDir: where raw results are written first (null = don't write, e.g. for replay and the demo).
export async function collect({ fetchSearches, now = new Date(), log = console.log, rawDir = config.rawDir }) {
  const run = await startRun(now, log);
  const pool = new JobPool();
  const summaries = [];
  const waiting = []; // jobs that don't state their experience (see attachWaitingListings)

  try {
    const sources = enabledSources(config.disabledSources);
    const tasksBySource = sources.map((source) =>
      COURSES.flatMap((course) =>
        course.searchTerms.flatMap((term) =>
          (source.locations ?? [null]).map((location) => ({
            course,
            term,
            location,
            input: source.buildInput(term, limitFor(source), location),
          })),
        ),
      ),
    );
    const searchCount = tasksBySource.reduce((n, tasks) => n + tasks.length, 0);
    log(`Running ${searchCount} searches on ${sources.map((s) => `${s.platform} (${s.via})`).join(', ')}`);
    await loadRecentOpenings(pool, now);

    // Each platform: search -> raw file -> save. Saves happen one at a time, in the order platforms finish.
    let saveQueue = Promise.resolve();
    await Promise.all(
      sources.map(async (source, i) => {
        const searches = await searchPlatform(source, tasksBySource[i], fetchSearches, log);
        const rawFile = saveRawFile(rawDir, source, now, searches, log);
        const saved = saveQueue.then(async () => {
          const summary = {
            platform: source.platform,
            via: source.via,
            searches: searches.length,
            failedSearches: searches.filter((s) => s.status !== 'ok').length,
            rawFile,
          };
          try {
            Object.assign(summary, await savePlatform(searches, pool, now, log, summary, waiting), { savedAt: new Date() });
            log(
              `  ✓ ${source.platform}: saved (${summary.newJobs} new, ${summary.knownJobs} already known; ` +
                `left out: ${summary.bigCompany} big company, ${summary.outsideExperience} outside ${config.experience.min}-${config.experience.max} yrs)`,
            );
            resolveEarlierFailures(summaries, log);
          } catch (err) {
            summary.saveError = err.message;
            log(`  ✗ ${source.platform}: NOT SAVED - ${err.message}.${rawFile ? ` Raw results kept in ${rawFile}; run "npm run replay" to load them.` : ''}`);
          }
          summaries.push(summary);
          // Record progress, so the run shows which platforms are done even if it stops later.
          await CollectorRun.updateOne(
            { _id: run._id },
            { $push: { platforms: summary, searches: { $each: searches.map(({ source: _s, items, ...rest }) => ({ ...rest, items: items.length })) } } },
          ).catch((err) => log(`  Could not record ${source.platform}'s progress: ${err.message}`));
        });
        saveQueue = saved.catch(() => {}); // the next platform's save runs even if this one hit a bug
        await saved;
      }),
    );

    try {
      await attachWaitingListings(waiting, pool, now, log);
    } catch (err) {
      log(`  Could not add the jobs without stated experience: ${err.message}`);
    }

    // A platform whose save failed left unsaved changes in the pool; one more try now.
    if (pool.openings.some((o) => o.touched)) {
      try {
        await writeTouched(pool, now, log);
        resolveEarlierFailures(summaries, log);
      } catch (err) {
        log(`  Final save retry failed: ${err.message}`);
      }
    }

    // Old jobs are deleted, except ones someone typed HR details into.
    const removed = await Job.deleteMany({
      lastSeenAt: { $lt: new Date(now.getTime() - config.retentionDays * DAY_MS) },
      manual: { $exists: false },
    });
    const sum = (key) => summaries.reduce((n, s) => n + (s[key] ?? 0), 0);
    const failedSearches = sum('failedSearches');
    const unsaved = summaries.filter((s) => s.saveError).length;
    const allFailed = failedSearches === searchCount || unsaved === summaries.length;
    const status = allFailed ? 'failed' : failedSearches || unsaved ? 'partial' : 'success';
    const totals = {
      fetched: sum('fetched'),
      inIndia: sum('inIndia'),
      matched: sum('matched'),
      bigCompany: sum('bigCompany'),
      outsideExperience: sum('outsideExperience'),
      noExperience: sum('noExperience'),
      noExperienceKept: sum('noExperienceKept'),
      unique: pool.openings.filter((o) => o.seenThisRun).length,
      inserted: pool.openings.filter((o) => o.createdThisRun && !o.isNew).length,
      updated: pool.openings.filter((o) => o.seenThisRun && !o.createdThisRun).length,
      removedOld: removed.deletedCount ?? 0,
    };
    await CollectorRun.updateOne({ _id: run._id }, { $set: { status, totals, platforms: summaries, finishedAt: new Date() } });
    return CollectorRun.findById(run._id).lean();
  } catch (err) {
    await CollectorRun.updateOne({ _id: run._id }, { $set: { status: 'failed', error: err.message, platforms: summaries, finishedAt: new Date() } });
    throw err;
  } finally {
    endRun();
  }
}
