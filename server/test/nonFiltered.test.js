// Non-filtered jobs: what the keep rules leave out is saved apart (NonFilteredJob), never mixed with the
// kept (filtered) jobs, and never the same listing in both.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { connectDb, disconnectDb } from '../src/db.js';
import { collect, perSearch } from '../src/collector/collect.js';
import { CollectorRun, Job, NonFilteredJob } from '../src/models.js';

let mongo;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  await Promise.all([Job.init(), NonFilteredJob.init()]);
});
after(async () => {
  await disconnectDb();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([Job.deleteMany({}), NonFilteredJob.deleteMany({}), CollectorRun.deleteMany({})]);
});

const naukri = (id, title, company, min = 3, max = 6) => ({
  jobId: id, jdURL: `/job-listings-${id}`, title, companyName: company, minimumExperience: String(min), maximumExperience: String(max),
  placeholders: [{ type: 'location', label: 'Pune' }],
});
const indeed = (key, title, company, snippet = '') => ({ jobkey: key, displayTitle: title, company, formattedLocation: 'Pune, Maharashtra', snippet });

// Naukri and Indeed answer the "data engineer" search with these items; every other search is empty.
const run = (items, now) =>
  collect({
    fetchSearches: (source, inputs) =>
      source.via === 'apify'
        ? perSearch(async () => ({ items: [] }), 3, { retryDelayMs: 0 })(source, inputs)
        : Promise.resolve(inputs.map((i) => ({ status: 'ok', items: i.keyword === 'data engineer' ? (items[source.platform] ?? []) : [] }))),
    now,
    log: () => {},
    rawDir: null,
  });

const companies = async (model) => (await model.find().lean()).map((j) => j.company).sort();
const sourceKeysIn = async (model) => (await model.find().lean()).flatMap((j) => j.sourceKeys);

test('jobs the keep rules leave out are saved as non-filtered, with the reason; the kept jobs are exactly as before', async () => {
  const done = await run(
    {
      Naukri: [
        naukri('N1', 'Data Engineer', 'Alpha'),
        naukri('N2', 'Data Engineer', 'Beta'),
        naukri('N3', 'Data Engineer', 'Tata Consultancy Services'), // big company
        naukri('N4', 'Data Engineer', 'Delta', 0, 2), // under 2 years
        naukri('N5', 'Sales Executive', 'Epsilon'), // fits no course: not stored anywhere
      ],
      Indeed: [
        indeed('i1', 'Data Engineer', 'Alpha'), // no experience stated, the same job as Alpha: joins it
        indeed('i2', 'Data Engineer', 'Omega'), // no experience stated, no kept twin
      ],
    },
    new Date('2026-10-16T01:00:00Z'),
  );

  assert.deepEqual(await companies(Job), ['Alpha', 'Beta'], 'kept jobs as before');
  assert.deepEqual([...(await Job.findOne({ company: 'Alpha' }).lean()).platforms].sort(), ['Indeed', 'Naukri']);
  const left = await NonFilteredJob.find().lean();
  assert.deepEqual(
    left.map((j) => `${j.company}: ${j.leftOutBy}`).sort(),
    ['Delta: experience', 'Omega: no-experience', 'Tata Consultancy Services: big-company'],
  );
  assert.ok(left.every((j) => j.course === 'data-engineering' && j.firstSeenAt && j.links), 'stored like kept jobs');
  assert.ok(!left.some((j) => j.company === 'Epsilon'), 'a job that fits no course is not stored');

  const kept = new Set(await sourceKeysIn(Job));
  assert.ok((await sourceKeysIn(NonFilteredJob)).every((k) => !kept.has(k)), 'no listing in both');
  assert.equal(done.totals.nonFiltered.inserted, 3);
  assert.equal(done.totals.bigCompany, 1, 'the run summary counts are unchanged');
  assert.equal(done.totals.outsideExperience, 1);
});

test('a left-out listing that is the same job as a kept one is not added, and the kept job is not changed', async () => {
  const done = await run(
    {
      Naukri: [naukri('N1', 'Data Engineer', 'Alpha')],
      Indeed: [indeed('i1', 'Data Engineer', 'Alpha', '<li>1+ years of experience</li>')], // under 2 years on Indeed
    },
    new Date('2026-10-16T01:00:00Z'),
  );
  assert.equal(await NonFilteredJob.countDocuments(), 0);
  assert.equal(done.totals.nonFiltered.alreadyKept, 1);
  assert.deepEqual((await Job.findOne({ company: 'Alpha' }).lean()).platforms, ['Naukri'], 'the left-out listing did not join the kept job');
});

test('a non-filtered job that later turns up as a kept job leaves non-filtered, and its typed-in HR details move with it', async () => {
  await run({ Indeed: [indeed('i9', 'Data Engineer', 'Omega')] }, new Date('2026-10-16T01:00:00Z'));
  const stored = await NonFilteredJob.findOne({ company: 'Omega' }).lean();
  assert.ok(stored, 'first: no experience stated, so non-filtered');
  await NonFilteredJob.updateOne({ _id: stored._id }, { $set: { manual: { phone: '+91 98450 11111', phoneKeys: ['9845011111'], remarks: 'Called', updatedAt: new Date() } } });

  // Next day Naukri lists it with 3-6 years, and Indeed lists it again: one kept job.
  const done = await run(
    { Naukri: [naukri('N9', 'Data Engineer', 'Omega')], Indeed: [indeed('i9', 'Data Engineer', 'Omega')] },
    new Date('2026-10-17T01:00:00Z'),
  );
  assert.equal(await NonFilteredJob.countDocuments(), 0, 'gone from non-filtered');
  const kept = await Job.findOne({ company: 'Omega' }).lean();
  assert.deepEqual([...kept.platforms].sort(), ['Indeed', 'Naukri']);
  assert.equal(kept.manual?.remarks, 'Called', 'HR details moved to the kept job');
  assert.equal(done.totals.nonFiltered.removedAsKept, 1);
});

test('collecting the same results again adds nothing to either set', async () => {
  const items = { Naukri: [naukri('N1', 'Data Engineer', 'Alpha'), naukri('N3', 'Data Engineer', 'Infosys')], Indeed: [indeed('i2', 'Data Engineer', 'Omega')] };
  await run(items, new Date('2026-10-16T01:00:00Z'));
  const done = await run(items, new Date('2026-10-17T01:00:00Z'));
  assert.equal(await Job.countDocuments(), 1);
  assert.equal(await NonFilteredJob.countDocuments(), 2);
  assert.equal(done.totals.nonFiltered.inserted, 0);
  assert.equal(done.totals.nonFiltered.updated, 2);
});

test('reclassify moves jobs between the two sets when the rules change, losing nothing', async () => {
  const { reclassifyJobs } = await import('../src/reclassify.js');
  const now = new Date();
  const job = (n, extra) => ({
    fingerprint: `r${n}`, title: 'Data Engineer', company: `Firm ${n}`, course: 'data-engineering', cities: ['Pune'],
    firstSeenAt: now, lastSeenAt: now, primaryPlatform: 'Naukri', platforms: ['Naukri'], sourceKeys: [`R:${n}`], ...extra,
  });
  const [keptNowExcluded] = await Job.create([
    job(1, { company: 'Infosys', experienceMin: 3, experienceBand: '3', manual: { remarks: 'Called', updatedAt: now } }), // now a big company
    job(2, { experienceMin: 4, experienceBand: '4' }), // stays kept
  ]);
  const [nowKept] = await NonFilteredJob.create([
    job(3, { experienceMin: 3, experienceBand: '3', leftOutBy: 'experience' }), // passes the rules now
    job(4, { leftOutBy: 'no-experience' }), // stays non-filtered
    job(5, { title: 'Sales Executive', leftOutBy: 'big-company' }), // fits no course: removed
  ]);

  const dry = await reclassifyJobs({ dryRun: true });
  assert.equal(dry.counts.toKept, 1);
  assert.equal(await Job.countDocuments(), 2, 'a dry run changes nothing');

  const { counts } = await reclassifyJobs();
  assert.deepEqual(counts.toNonFiltered, { 'big-company': 1, experience: 0, 'no-experience': 0 });
  assert.equal(counts.toKept, 1);
  assert.equal(counts.noCourse, 1);
  assert.deepEqual((await Job.find().lean()).map((j) => j.company).sort(), ['Firm 2', 'Firm 3']);
  const moved = await NonFilteredJob.findById(keptNowExcluded._id).lean();
  assert.equal(moved.leftOutBy, 'big-company', 'moved with its reason, same id');
  assert.equal(moved.manual.remarks, 'Called', 'HR details moved with it');
  const back = await Job.findById(nowKept._id).lean();
  assert.ok(back && back.leftOutBy === undefined, 'moved to the kept jobs without a reason');
  assert.deepEqual((await NonFilteredJob.find().lean()).map((j) => j.company).sort(), ['Firm 4', 'Infosys']);
});
