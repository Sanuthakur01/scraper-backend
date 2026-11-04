// Non-filtered jobs: what the keep rules leave out is saved apart (NonFilteredJob), never mixed with the
// kept (filtered) jobs, and never the same listing in both.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/db.js';
import { collect, perSearch } from '../src/collector/collect.js';
import { CollectorRun, Job, NonFilteredJob } from '../src/models.js';
import { addedJobDoc, parseAddedJobInput, TEAM_PLATFORM } from '../src/addedJobs.js';
import { addedJobReason } from '../src/config/filters.js';

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
// Indeed in the Apify actor's format (valig/indeed-jobs-scraper), in Pune.
const indeed = (key, title, company, text = '') => ({
  key, title, employer: { name: company }, location: { countryCode: 'IN', admin1Code: 'MH', admin3Code: 'PNQ', city: '' }, description: { text },
});
// What a search was for, whichever platform's input it is.
const termOf = (input) => input.keywords ?? input.title ?? input.keyword;

// Naukri and Indeed answer the "data engineer" search with these items; every other search is empty.
const run = (items, now) =>
  collect({
    fetchSearches: (source, inputs) =>
      source.via === 'apify'
        ? perSearch(async (src, input) => ({ items: termOf(input) === 'data engineer' ? (items[src.platform] ?? []) : [] }), 3, { retryDelayMs: 0 })(source, inputs)
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
      Indeed: [indeed('i1', 'Data Engineer', 'Alpha', 'Freshers welcome, 0-1 years of experience')], // a fresher job on Indeed
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
  assert.deepEqual(counts.toNonFiltered, { 'big-company': 1, experience: 0, senior: 0, 'no-experience': 0 });
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

// Naukri (and Indeed, when given) answer each search, by keyword, with these items; every other search is empty.
const runSearches = (byKeyword, now, indeedByKeyword = {}) =>
  collect({
    fetchSearches: (source, inputs) =>
      source.via === 'apify'
        ? perSearch(async (src, input) => ({ items: (src.platform === 'Indeed' ? indeedByKeyword : {})[termOf(input)] ?? [] }), 3, { retryDelayMs: 0 })(source, inputs)
        : Promise.resolve(inputs.map((i) => ({ status: 'ok', items: (source.platform === 'Naukri' ? byKeyword : {})[i.keyword] ?? [] }))),
    now,
    log: () => {},
    rawDir: null,
  });

test('what the extra searches find is non-filtered (even when it passes the keep rules); a main search still wins', async () => {
  const done = await runSearches(
    {
      'data analyst': [naukri('K1', 'Data Analyst', 'Kappa')],
      'business analyst': [
        naukri('B1', 'Business Analyst', 'Lambda'), // passes the keep rules, but only this search found it
        naukri('K1', 'Data Analyst', 'Kappa'), // the same listing the main search found: stays kept, once
        naukri('B3', 'Business Analyst', 'Mu', 0, 2), // under 2 years: that reason comes first
        naukri('B4', 'Sales Manager', 'Rho'), // fits no course: not stored anywhere
      ],
      'mis executive': [naukri('M1', 'MIS Executive', 'Xi')],
      'site reliability engineer': [naukri('S1', 'Site Reliability Engineer', 'Nu')],
    },
    new Date('2026-10-16T01:00:00Z'),
  );

  assert.deepEqual(await companies(Job), ['Kappa'], 'the main numbers come from the main searches only');
  const left = await NonFilteredJob.find().lean();
  assert.deepEqual(
    left.map((j) => `${j.company} ${j.course} ${j.leftOutBy} ${j.fromExtraSearch}`).sort(),
    [
      'Lambda data-analyst extra-search true',
      'Mu data-analyst experience true',
      'Nu production-support extra-search true',
      'Xi data-analyst extra-search true',
    ],
  );
  assert.equal(done.totals.extraSearch, 5, 'matched a course in an extra search');
  assert.equal(done.totals.nonFiltered.alreadyKept, 1);
  const run = await CollectorRun.findOne().lean();
  assert.deepEqual(run.searches.filter((s) => s.extra && s.platform === 'Naukri').map((s) => s.term), ['mis executive', 'business analyst', 'site reliability engineer']);

  // Next day a main search finds Lambda's job too: it becomes a kept job, and leaves non-filtered.
  await NonFilteredJob.updateOne({ company: 'Lambda' }, { $set: { manual: { remarks: 'Called HR', updatedAt: new Date() } } });
  await runSearches({ 'data analyst': [naukri('B1', 'Business Analyst', 'Lambda')] }, new Date('2026-10-17T01:00:00Z'));
  assert.deepEqual(await companies(Job), ['Kappa', 'Lambda']);
  assert.equal((await Job.findOne({ company: 'Lambda' }).lean()).manual.remarks, 'Called HR', 'its HR details moved with it');
  assert.deepEqual(await companies(NonFilteredJob), ['Mu', 'Nu', 'Xi']);

  // A main search's left-out listing (0-1 years) joins Nu's job, which says 3-6: still not kept by a main
  // search, so it keeps its reason (never none).
  await runSearches({ 'production support': [naukri('S1', 'Site Reliability Engineer', 'Nu', 0, 1)] }, new Date('2026-10-18T01:00:00Z'));
  const nu = await NonFilteredJob.findOne({ company: 'Nu' }).lean();
  assert.deepEqual([nu.fromExtraSearch, nu.leftOutBy], [true, 'extra-search']);
  assert.ok((await NonFilteredJob.find().lean()).every((j) => j.leftOutBy), 'every non-filtered job has a reason');
});

test('a main search listing without stated experience and an extra search listing with it: one non-filtered job, with a reason', async () => {
  await runSearches(
    { 'business analyst': [naukri('O9', 'Business Analyst', 'Omega')] },
    new Date('2026-10-16T01:00:00Z'),
    { 'data analyst': [indeed('i9', 'Business Analyst', 'Omega')] }, // no experience stated, no kept twin
  );
  assert.equal(await Job.countDocuments(), 0);
  const left = await NonFilteredJob.find().lean();
  assert.deepEqual(left.map((j) => `${j.company} ${[...j.platforms].sort().join('+')} ${j.leftOutBy}`), ['Omega Indeed+Naukri extra-search']);
});

test('reclassify keeps a job only the extra searches found as non-filtered', async () => {
  const { reclassifyJobs } = await import('../src/reclassify.js');
  const now = new Date();
  const doc = (n, extra) => ({
    fingerprint: `x${n}`, title: 'Business Analyst', company: `Firm ${n}`, course: 'data-analyst', cities: ['Pune'], experienceMin: 3,
    experienceBand: '3', firstSeenAt: now, lastSeenAt: now, primaryPlatform: 'Naukri', platforms: ['Naukri'], sourceKeys: [`X:${n}`], ...extra,
  });
  await NonFilteredJob.create([
    doc(1, { leftOutBy: 'extra-search', fromExtraSearch: true }), // stays
    doc(2, { leftOutBy: 'experience', fromExtraSearch: false }), // passes the rules now, and a main search found it: kept
  ]);
  const { counts } = await reclassifyJobs();
  assert.equal(counts.toKept, 1);
  assert.deepEqual((await NonFilteredJob.find().lean()).map((j) => `${j.company} ${j.leftOutBy}`), ['Firm 1 extra-search']);
  const moved = await Job.findOne({ company: 'Firm 2' }).lean();
  assert.ok(moved && moved.leftOutBy === undefined && moved.fromExtraSearch === undefined, 'a kept job has neither');
});

// ---------- Jobs the team added by hand (src/addedJobs.js) ----------

const STAFF = { userId: 'user_riya', email: 'riya@example.com', name: 'Riya' };
// A job added by hand, stored in `model` as POST /added-jobs stores it (without its HR contact); extra: fields to change.
const addedJob = (model, fields, at, extra = {}) => {
  const { value } = parseAddedJobInput({ title: 'Data Engineer', course: 'data-engineering', ...fields });
  const leftOutBy = addedJobReason({ company: value.company, experienceMin: value.experience?.min ?? null });
  return model.create({ ...addedJobDoc(value, { _id: new mongoose.Types.ObjectId(), person: STAFF, now: at, leftOutBy }), ...extra });
};

test('a collected listing of a job the team added joins it: the job gains the site and keeps what the team gave it', async () => {
  const at = new Date('2026-10-15T06:00:00Z');
  const link = 'https://www.naukri.com/job-listings-big-data-engineer-omega-pune-3-to-6-years-123456789012';
  const mine = await addedJob(Job, { company: 'Omega', title: 'Big Data Engineer', course: 'data-analyst', url: link }, at);
  assert.deepEqual(mine.sourceKeys, ['Naukri:123456789012'], 'the key the collector gives this listing');

  const done = await run({ Naukri: [naukri('123456789012', 'Data Engineer', 'Omega')] }, new Date('2026-10-16T01:00:00Z'));
  assert.equal(done.totals.inserted, 0);
  assert.equal(await Job.countDocuments(), 1, 'one job');
  const job = await Job.findById(mine._id).lean();
  assert.deepEqual(job.platforms, [TEAM_PLATFORM, 'Naukri']);
  assert.deepEqual(job.links, { [TEAM_PLATFORM]: link, Naukri: 'https://www.naukri.com/job-listings-123456789012' });
  assert.deepEqual(
    [job.title, job.course, job.primaryPlatform, job.firstSeenAt.toISOString()],
    ['Big Data Engineer', 'data-analyst', TEAM_PLATFORM, at.toISOString()],
    "the team's title and course, still counted where it was first added",
  );
  assert.deepEqual(job.addedBy, mine.toObject().addedBy);
  assert.equal(job.experienceMin, 3, "the listing's experience fills in what the team didn't give");
});

test('the cleanup never removes a job the team added, however long ago it was last seen', async () => {
  const at = new Date('2026-10-15T06:00:00Z');
  const kept = await addedJob(Job, { company: 'Alpha', url: 'https://alpha.in/jobs/1', experience: '3 years' }, at);
  const left = await addedJob(NonFilteredJob, { company: 'Oracle', url: 'https://oracle.com/jobs/1' }, at);
  assert.equal(left.leftOutBy, 'big-company');
  await Job.create({
    fingerprint: 'old', title: 'Data Engineer', company: 'Beta', course: 'data-engineering', firstSeenAt: at, lastSeenAt: at,
    primaryPlatform: 'Naukri', platforms: ['Naukri'], sourceKeys: ['Naukri:OLD1'],
  });
  const done = await run({}, new Date('2027-03-01T01:00:00Z'));
  assert.equal(done.totals.removedOld, 1, 'only the collected job');
  assert.deepEqual((await Job.find().lean()).map((j) => String(j._id)), [String(kept._id)]);
  assert.deepEqual((await NonFilteredJob.find().lean()).map((j) => String(j._id)), [String(left._id)]);
});

test('a Non-filtered job the team added that turns up as a kept job: both stay, the team\'s job just as they added it', async () => {
  const at = new Date('2026-10-15T06:00:00Z');
  const link = 'https://www.naukri.com/job-listings-big-data-engineer-omega-123456789013';
  const mine = await addedJob(NonFilteredJob, { company: 'Omega', title: 'Big Data Engineer', course: 'data-analyst', url: link, experience: '6+ years' }, at);
  assert.equal(mine.leftOutBy, 'senior');
  const done = await run({ Naukri: [naukri('123456789013', 'Data Engineer', 'Omega')] }, new Date('2026-10-16T01:00:00Z'));
  assert.equal(done.totals.nonFiltered.removedAsKept, 0);
  // What the team gave the job, and that nothing else changed (lastSeenAt).
  const asAdded = (d) => [String(d._id), d.title, d.course, d.firstSeenAt.toISOString(), d.lastSeenAt.toISOString(), d.platforms, d.links, d.sourceKeys, d.leftOutBy, d.addedBy];
  const added = asAdded(mine.toObject());
  assert.deepEqual(added.slice(1, 8), ['Big Data Engineer', 'data-analyst', at.toISOString(), at.toISOString(), [TEAM_PLATFORM], { [TEAM_PLATFORM]: link }, ['Naukri:123456789013']]);
  assert.deepEqual((await NonFilteredJob.find().lean()).map(asAdded), [added], "the team's job is not touched: the same id, title, course, date, link and who added it");
  const kept = await Job.find().lean();
  assert.equal(kept.length, 1, 'the kept job is saved too');
  assert.deepEqual([kept[0].title, kept[0].platforms, kept[0].sourceKeys, kept[0].addedBy], ['Data Engineer', ['Naukri'], ['Naukri:123456789013'], undefined]);

  // Collected again: still both, the team's job unchanged.
  await run({ Naukri: [naukri('123456789013', 'Data Engineer', 'Omega')] }, new Date('2026-10-17T01:00:00Z'));
  assert.deepEqual((await NonFilteredJob.find().lean()).map(asAdded), [added]);
  assert.equal(await Job.countDocuments(), 1);
});

test('two people add the same opening, one in each set: a collection that keeps it removes neither', async () => {
  const at = new Date('2026-10-15T06:00:00Z');
  const riya = await addedJob(Job, { company: 'Zeta', url: 'https://careers.zeta.in/jobs/1', location: 'Pune', experience: '3 years' }, at);
  const byAman = { addedBy: { userId: 'user_aman', email: 'aman@example.com', name: 'Aman', at } };
  const naukriLink = 'https://www.naukri.com/job-listings-data-engineer-zeta-223456789013';
  const aman = await addedJob(NonFilteredJob, { company: 'Zeta', url: naukriLink, location: 'Pune', experience: '6+ years' }, at, byAman);
  assert.deepEqual([aman.leftOutBy, aman.fingerprint], ['senior', riya.fingerprint], 'the same company, title and city');
  await run({ Naukri: [naukri('223456789013', 'Data Engineer', 'Zeta')] }, new Date('2026-10-16T01:00:00Z'));
  const [kept] = await Job.find().lean();
  assert.deepEqual([String(kept._id), kept.addedBy.email, kept.platforms], [String(riya._id), 'riya@example.com', [TEAM_PLATFORM, 'Naukri']], "the listing joined Riya's job");
  assert.deepEqual((await NonFilteredJob.find().lean()).map((j) => [String(j._id), j.addedBy.email, j.links[TEAM_PLATFORM]]), [[String(aman._id), 'aman@example.com', naukriLink]], "Aman's stays");
});

test('reclassify keeps the jobs the team added: their course stays, and experience not stated keeps them in Filtered', async () => {
  const { reclassifyJobs } = await import('../src/reclassify.js');
  const at = new Date();
  const plain = await addedJob(Job, { company: 'Firm A', url: 'https://firma.in/1' }, at);
  const noCourse = await addedJob(Job, { company: 'Firm B', title: 'Office Coordinator', course: 'data-analyst', url: 'https://firmb.in/1', experience: '2-4 years' }, at);
  const ownCourse = await addedJob(Job, { company: 'Firm C', course: 'production-support', url: 'https://firmc.in/1', experience: '3 years' }, at);
  const nowBig = await addedJob(Job, { company: 'Firm D', url: 'https://firmd.in/1', experience: '3 years' }, at, { company: 'Infosys' }); // as if the rules changed
  const legacy = await addedJob(NonFilteredJob, { company: 'Firm E', url: 'https://firme.in/1' }, at, { leftOutBy: 'no-experience' });
  const collected = await Job.create({
    fingerprint: 'c1', title: 'Data Engineer', company: 'Firm F', course: 'data-engineering', experienceBand: 'unknown', firstSeenAt: at, lastSeenAt: at,
    primaryPlatform: 'Naukri', platforms: ['Naukri'], sourceKeys: ['Naukri:C1'],
  });

  const { counts } = await reclassifyJobs();
  assert.ok(await Job.exists({ _id: plain._id }), 'experience not stated: still Filtered');
  assert.equal((await Job.findById(noCourse._id).lean())?.course, 'data-analyst', 'its title fits no course, but it is not removed');
  assert.equal((await Job.findById(ownCourse._id).lean()).course, 'production-support', "the staff's course, not the title's");
  const moved = await NonFilteredJob.findById(nowBig._id).lean();
  assert.equal(moved?.leftOutBy, 'big-company');
  assert.deepEqual(moved.addedBy, nowBig.toObject().addedBy, 'who added it moves with it');
  const back = await Job.findById(legacy._id).lean();
  assert.ok(back && back.leftOutBy === undefined && back.addedBy, 'experience not stated: Filtered');
  assert.equal((await NonFilteredJob.findById(collected._id).lean())?.leftOutBy, 'no-experience', 'a collected job is left out as before');
  assert.deepEqual([counts.noCourse, counts.courseChanged], [0, 0]);
});
