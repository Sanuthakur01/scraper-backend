// Reliability of the collection pipeline: saving as each platform finishes, raw files, the run lock,
// save retries and the database's duplicate guard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { connectDb, disconnectDb } from '../src/db.js';
import { collect, perSearch } from '../src/collector/collect.js';
import { CollectorRun, Job, NonFilteredJob } from '../src/models.js';

let mongo;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  await Job.init();
});
after(async () => {
  await disconnectDb();
  await mongo.stop();
});
beforeEach(async () => {
  await Job.deleteMany({});
  await NonFilteredJob.deleteMany({});
  await CollectorRun.deleteMany({});
});

const naukriJob = (id, title, company) => ({ jobId: id, jdURL: `/job-listings-${id}`, title, companyName: company, minimumExperience: '3', maximumExperience: '6', placeholders: [{ type: 'location', label: 'Pune' }] });
const naukriJobs = [naukriJob('N1', 'Data Engineer', 'Alpha'), naukriJob('N2', 'Data Scientist', 'Beta')];
const indeedJob = { jobkey: 'i1', displayTitle: 'Production Support Engineer', company: 'Gamma', formattedLocation: 'Chennai, Tamil Nadu', snippet: '<li>3+ years of experience</li>' };

const termHas = (input) => ['data engineer', 'data scientist'].includes(input.keyword);
const okBatch = (items) => async (source, inputs) => inputs.map((i) => ({ status: 'ok', items: termHas(i) ? items : [] }));
const fetchWith = (scrapers) => (source, inputs) =>
  source.via === 'apify'
    ? perSearch(async () => ({ items: [] }), 3, { retryDelayMs: 0 })(source, inputs)
    : (scrapers[source.platform] ?? (async () => inputs.map(() => ({ status: 'ok', items: [] }))))(source, inputs);

test('each platform is saved as soon as it finishes, without waiting for slower platforms', async () => {
  let releaseIndeed;
  const indeedFinished = new Promise((resolve) => (releaseIndeed = resolve));
  let naukriJobsInDbWhileIndeedRunning = -1;
  const run = collect({
    fetchSearches: fetchWith({
      Naukri: okBatch(naukriJobs),
      Indeed: async (source, inputs) => {
        // Indeed is still "scraping": wait until Naukri's jobs are in the database.
        for (let i = 0; i < 100 && (await Job.countDocuments()) === 0; i++) await new Promise((r) => setTimeout(r, 20));
        naukriJobsInDbWhileIndeedRunning = await Job.countDocuments();
        await indeedFinished;
        return inputs.map((input) => ({ status: 'ok', items: input.keyword === 'production support' ? [indeedJob] : [] }));
      },
    }),
    now: new Date('2026-10-16T01:30:00Z'),
    log: () => {},
    rawDir: null,
  });
  setTimeout(releaseIndeed, 200);
  const done = await run;
  assert.equal(naukriJobsInDbWhileIndeedRunning, 2, "Naukri's jobs were saved before Indeed finished");
  assert.equal(done.status, 'success');
  assert.equal(await Job.countDocuments(), 3);
});

test('big companies and jobs asking under 2 years are left out (5+ years are kept); a job without stated experience is kept only when it matches one', async () => {
  const tcs = naukriJob('N7', 'Data Engineer', 'Tata Consultancy Services');
  const junior = { ...naukriJob('N8', 'Data Scientist', 'Delta'), minimumExperience: '0', maximumExperience: '2' };
  const senior = { ...naukriJob('N9', 'Data Scientist', 'Gamma'), minimumExperience: '8', maximumExperience: '12' };
  const sameAsAlpha = { jobkey: 'i2', displayTitle: 'Data Engineer', company: 'Alpha', formattedLocation: 'Pune, Maharashtra' };
  const loneIndeed = { jobkey: 'i3', displayTitle: 'Data Engineer', company: 'Omega', formattedLocation: 'Pune, Maharashtra' };
  const run = await collect({
    fetchSearches: fetchWith({
      Naukri: okBatch([...naukriJobs, tcs, junior, senior]),
      Indeed: async (source, inputs) => inputs.map((i) => ({ status: 'ok', items: i.keyword === 'data engineer' ? [sameAsAlpha, loneIndeed] : [] })),
    }),
    now: new Date('2026-10-16T01:45:00Z'),
    log: () => {},
    rawDir: null,
  });
  const jobs = await Job.find().lean();
  assert.deepEqual(jobs.map((j) => j.company).sort(), ['Alpha', 'Beta', 'Gamma'], 'no TCS, no 0-2 year job, no lone job without experience');
  assert.equal(jobs.find((j) => j.company === 'Gamma').experienceBand, '5+', 'an 8-12 year job is kept, in the 5+ (more than 5) group');
  assert.deepEqual([...jobs.find((j) => j.company === 'Alpha').platforms].sort(), ['Indeed', 'Naukri'], 'the Indeed listing joined the matching job');
  assert.ok(run.totals.bigCompany >= 1 && run.totals.outsideExperience >= 1);
  assert.equal(run.totals.noExperience, 2);
  assert.equal(run.totals.noExperienceKept, 1);
});

test('raw results are written to disk before saving, for every platform', async () => {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-test-'));
  const run = await collect({ fetchSearches: fetchWith({ Naukri: okBatch(naukriJobs) }), now: new Date('2026-10-16T02:00:00Z'), log: () => {}, rawDir });
  const files = fs.readdirSync(rawDir).sort();
  assert.deepEqual(files.map((f) => f.split('-')[0]), ['glassdoor', 'indeed', 'linkedin', 'naukri']);
  const naukriRaw = JSON.parse(fs.readFileSync(path.join(rawDir, files.find((f) => f.startsWith('naukri'))), 'utf8'));
  assert.equal(naukriRaw.searches.find((s) => s.term === 'data engineer').items.length, 2);
  assert.ok(run.platforms.every((p) => p.rawFile && fs.existsSync(p.rawFile)));
  fs.rmSync(rawDir, { recursive: true, force: true });
});

test('a database outage during one save is retried, and nothing is lost', async () => {
  const original = Job.bulkWrite.bind(Job);
  let failuresLeft = 2;
  Job.bulkWrite = async (...args) => {
    if (failuresLeft-- > 0) throw new Error('connection lost');
    return original(...args);
  };
  try {
    const run = await collect({ fetchSearches: fetchWith({ Naukri: okBatch(naukriJobs) }), now: new Date('2026-10-16T03:00:00Z'), log: () => {}, rawDir: null });
    assert.equal(run.status, 'success');
    assert.equal(await Job.countDocuments(), 2);
  } finally {
    Job.bulkWrite = original;
  }
});

test("if one platform's save keeps failing, the next platform's save writes its jobs too", async () => {
  const original = Job.bulkWrite.bind(Job);
  let failuresLeft = 3; // every attempt of the first platform's save
  Job.bulkWrite = async (...args) => {
    if (failuresLeft-- > 0) throw new Error('connection lost');
    return original(...args);
  };
  try {
    const run = await collect({
      fetchSearches: fetchWith({
        Naukri: okBatch(naukriJobs),
        Indeed: async (source, inputs) => {
          await new Promise((r) => setTimeout(r, 100)); // finishes after Naukri
          return inputs.map((input) => ({ status: 'ok', items: input.keyword === 'production support' ? [indeedJob] : [] }));
        },
      }),
      now: new Date('2026-10-16T04:00:00Z'),
      log: () => {},
      rawDir: null,
    });
    assert.equal(await Job.countDocuments(), 3, 'no jobs lost');
    const naukri = run.platforms.find((p) => p.platform === 'Naukri');
    assert.equal(naukri.saveError, undefined);
    assert.equal(naukri.savedLater, true);
    assert.equal(run.status, 'success');
  } finally {
    Job.bulkWrite = original;
  }
});

const runningRun = (lockedBy, heartbeatAgoMs) =>
  CollectorRun.create({
    startedAt: new Date(),
    lockedAt: new Date(Date.now() - heartbeatAgoMs),
    heartbeatAt: new Date(Date.now() - heartbeatAgoMs),
    lockedBy,
    status: 'running',
  });
const tryCollect = () => collect({ fetchSearches: fetchWith({}), log: () => {}, rawDir: null });

test('a second collection cannot start while one is alive', async () => {
  await runningRun({ host: os.hostname(), pid: process.pid }, 0); // this very process: alive
  await assert.rejects(tryCollect(), /Another collection is already running on this PC/);
  await CollectorRun.deleteMany({});
  await runningRun({ host: 'office-pc', pid: 1234 }, 30_000); // another PC, recent heartbeat
  await assert.rejects(tryCollect(), /Another collection is already running on office-pc/);
});

test('a stopped collection on this PC is released at once', async () => {
  await runningRun({ host: os.hostname(), pid: 999_999 }, 0); // no such process: it was stopped
  const run = await tryCollect();
  assert.equal(run.status, 'success');
  assert.equal(await CollectorRun.countDocuments({ status: 'running' }), 0, 'the stopped run was marked failed');
});

test('a collection on another PC that stopped sending heartbeats is released after 3 minutes', async () => {
  await runningRun({ host: 'office-pc', pid: 1234 }, 4 * 60_000);
  assert.equal((await tryCollect()).status, 'success');
});

test('an old run record without process details (older version) does not block', async () => {
  await CollectorRun.create({ startedAt: new Date(), lockedAt: new Date(Date.now() - 10 * 60_000), status: 'running' });
  assert.equal((await tryCollect()).status, 'success');
});

test('the database refuses a second record for the same platform listing', async () => {
  const doc = { fingerprint: 'x', title: 'Data Engineer', course: 'data-engineering', firstSeenAt: new Date(), lastSeenAt: new Date(), primaryPlatform: 'Naukri', sourceKeys: ['Naukri:1'] };
  await Job.create(doc);
  await assert.rejects(Job.create({ ...doc, sourceKeys: ['Indeed:9', 'Naukri:1'] }), /E11000/);
});
