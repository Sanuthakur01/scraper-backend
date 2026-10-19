import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { connectDb, disconnectDb } from '../src/db.js';
import { collect, perSearch } from '../src/collector/collect.js';
import { CollectorRun, Job } from '../src/models.js';

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

// One search per platform returns these items; every other search returns nothing.
// LinkedIn items are in the Apify actor's format; the others in their scraper feed's format.
const linkedinItem = { id: 'L1', url: 'https://www.linkedin.com/jobs/view/L1', title: 'Data Analyst (SQL, Power BI)', companyName: 'ABC Technologies', location: 'Bengaluru, Karnataka, India', postedDate: '2026-10-15' };
const usItem = { id: 'L2', url: 'https://www.linkedin.com/jobs/view/L2', title: 'Data Analyst', companyName: 'US Co', location: 'New York, NY' };
const naukriItem = {
  jobId: 'N1',
  jdURL: '/job-listings-data-analyst-abc-N1',
  title: 'Data Analyst - SQL/Power BI',
  companyName: 'ABC Technologies Pvt Ltd',
  placeholders: [{ type: 'location', label: 'Bangalore' }, { type: 'experience', label: '2-5 Yrs' }],
  createdDate: Date.parse('2026-10-14T10:00:00Z'),
  minimumExperience: '2',
  maximumExperience: '5',
  tagsAndSkills: 'SQL,Power BI,Excel',
};
const supportItem = { jobId: 'N2', jdURL: '/job-listings-N2', title: 'Customer Support Executive', companyName: 'XYZ', placeholders: [{ type: 'location', label: 'Pune' }] };
const indeedItem = {
  jobkey: 'da4068f7d6231edf',
  displayTitle: 'Data Analyst (Power BI, SQL)',
  company: 'ABC Technologies',
  formattedLocation: 'Bengaluru, Karnataka',
  pubDate: Date.parse('2026-10-15T05:00:00Z'),
  salarySnippet: { text: '₹6,00,000 - ₹9,00,000 a year' },
  snippet: '<ul><li>Build <b>Power BI</b> dashboards</li></ul>',
};

const linkedinSearch = async (source, input) => ({ runId: 'r', items: input.keywords === 'data analyst' ? [linkedinItem, usItem] : [] });
const batchOf = (items) => async (source, inputs) => inputs.map((i) => ({ status: 'ok', items: i.keyword === 'data analyst' ? items : [] }));
const none = async (source, inputs) => inputs.map(() => ({ status: 'ok', items: [] }));

// Routes like scripts/collect.js: Apify one search at a time, each scraper platform as one batch.
const fetchSearches = ({ apify = linkedinSearch, Naukri = batchOf([naukriItem, supportItem]), Indeed = none, Glassdoor = none } = {}) => {
  const scrapers = { Naukri, Indeed, Glassdoor };
  return (source, inputs) => (source.via === 'apify' ? perSearch(apify, 3, { retryDelayMs: 0 })(source, inputs) : scrapers[source.platform](source, inputs));
};
const quiet = { log: () => {}, rawDir: null };

test('Apify is used only for LinkedIn; Naukri, Indeed and Glassdoor each go to their scraper in one batch', async () => {
  const apifyCalls = [];
  const scraperCalls = [];
  const batch = async (source, inputs) => (
    scraperCalls.push([source.platform, source.feedScript, inputs.length]),
    inputs.map(() => ({ status: 'ok', items: [] }))
  );
  const run = await collect({
    fetchSearches: fetchSearches({
      apify: async (source) => (apifyCalls.push(source.platform), { runId: 'r', items: [] }),
      Naukri: batch,
      Indeed: batch,
      Glassdoor: batch,
    }),
    now: new Date('2026-10-01T01:30:00Z'),
    ...quiet,
  });
  assert.deepEqual([...new Set(apifyCalls)], ['LinkedIn']);
  assert.equal(apifyCalls.length, 9);
  assert.deepEqual(scraperCalls.sort(), [
    ['Glassdoor', 'glassdoor_feed.py', 9],
    ['Indeed', 'indeed_feed.py', 9],
    ['Naukri', 'naukri_feed.py', 9],
  ]);
  assert.equal(run.searches.length, 36);
  assert.equal(run.platforms.length, 4);
});

test('a run merges the same job from LinkedIn, Naukri and Indeed and drops irrelevant jobs', async () => {
  const run = await collect({ fetchSearches: fetchSearches({ Indeed: batchOf([indeedItem]) }), now: new Date('2026-10-16T01:30:00Z'), ...quiet });
  assert.equal(run.status, 'success');
  assert.equal(run.totals.fetched, 5);
  assert.equal(run.totals.inIndia, 4);
  assert.equal(run.totals.matched, 3);
  assert.equal(run.totals.unique, 1);
  assert.equal(run.totals.inserted, 1);

  const jobs = await Job.find().lean();
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job.course, 'data-analyst');
  assert.deepEqual(job.cities, ['Bengaluru']);
  assert.deepEqual([...job.platforms].sort(), ['Indeed', 'LinkedIn', 'Naukri']);
  assert.equal(job.primaryPlatform, 'Naukri', 'posted first on Naukri, whichever platform finished first');
  assert.equal(job.experienceBand, '2', 'from Naukri; LinkedIn and Indeed did not state experience');
  assert.equal(job.links.Naukri, 'https://www.naukri.com/job-listings-data-analyst-abc-N1');
  assert.equal(job.links.Indeed, 'https://in.indeed.com/viewjob?jk=da4068f7d6231edf');
  assert.ok(job.skills.includes('Power BI'));
});

test('if the Naukri scraper fails completely, the other platforms are still saved', async () => {
  const run = await collect({
    fetchSearches: fetchSearches({ Naukri: async () => { throw new Error('Naukri scraper could not start'); } }),
    now: new Date('2026-10-17T01:30:00Z'),
    ...quiet,
  });
  assert.equal(run.status, 'partial');
  assert.equal(run.searches.filter((s) => s.platform === 'Naukri' && s.status === 'error').length, 9);
  assert.equal(run.totals.updated, 1, 'the LinkedIn listing updated the known job');
  const job = await Job.findOne().lean();
  assert.equal(job.firstSeenAt.toISOString(), '2026-10-16T01:30:00.000Z');
  assert.equal(job.lastSeenAt.toISOString(), '2026-10-17T01:30:00.000Z');
});

test('Glassdoor scraper jobs are cleaned and merged with the other platforms', async () => {
  const glassdoorCard = {
    jobId: '1010296650531',
    title: 'Data Analyst - SQL, Power BI',
    company: 'ABC Technologies',
    location: 'Bengaluru',
    age: '5h',
    salary: '₹6L - ₹12L (Employer provided)',
    snippet: 'Work with SQL and Power BI dashboards.',
    url: 'https://www.glassdoor.co.in/job-listing/data-analyst-abc-JV_KO0,12.htm?jl=1010296650531',
  };
  await collect({ fetchSearches: fetchSearches({ Glassdoor: batchOf([glassdoorCard]) }), now: new Date('2026-10-17T09:00:00Z'), ...quiet });
  const jobs = await Job.find().lean();
  assert.equal(jobs.length, 1, 'still one job');
  assert.deepEqual([...jobs[0].platforms].sort(), ['Glassdoor', 'Indeed', 'LinkedIn', 'Naukri']);
  assert.equal(jobs[0].links.Glassdoor, glassdoorCard.url);
});

test('if Apify fails completely, the scraper platforms are still saved', async () => {
  const run = await collect({
    fetchSearches: fetchSearches({ apify: async () => { throw new Error('Apify is down'); } }),
    now: new Date('2026-10-18T01:30:00Z'),
    ...quiet,
  });
  assert.equal(run.status, 'partial');
  assert.equal(run.totals.matched, 1, 'the Naukri data analyst job');
});

test('the same listing is never stored twice, even when it shows up again after the dedupe window', async () => {
  const run = await collect({ fetchSearches: fetchSearches(), now: new Date('2026-11-20T01:30:00Z'), ...quiet });
  assert.equal(run.totals.inserted, 0, 'same LinkedIn and Naukri listing ids = the same job');
  assert.equal(await Job.countDocuments(), 1);
});

test('the same company, title and city under a NEW listing a month later counts as a new opening', async () => {
  const repost = { ...naukriItem, jobId: 'N9', jdURL: '/job-listings-data-analyst-abc-N9' };
  const run = await collect({
    fetchSearches: fetchSearches({ apify: async () => ({ items: [] }), Naukri: batchOf([repost]) }),
    now: new Date('2027-01-10T01:30:00Z'),
    ...quiet,
  });
  assert.equal(run.totals.inserted, 1);
  assert.equal(await Job.countDocuments(), 2);
});

test('HR details typed in on the dashboard survive later collections; contacts in postings are added', async () => {
  const filter = { sourceKeys: 'Naukri:N9' };
  const manual = { phone: '+91 98450 00000', email: 'priya@abc.in', remarks: 'Spoke to HR', updatedAt: new Date('2027-01-10T08:00:00Z') };
  await Job.updateOne(filter, { $set: { manual } });

  const withContact = { ...naukriItem, jobId: 'N9', jdURL: '/job-listings-data-analyst-abc-N9', jobDescription: 'Share CV: careers@abctech.in, 98450 12345' };
  await collect({
    fetchSearches: fetchSearches({ apify: async () => ({ items: [] }), Naukri: batchOf([withContact]) }),
    now: new Date('2027-01-11T01:30:00Z'),
    ...quiet,
  });
  const job = await Job.findOne(filter).lean();
  assert.deepEqual(job.manual, manual, 'what was typed in is untouched');
  assert.deepEqual(job.foundEmails, ['careers@abctech.in']);
  assert.deepEqual(job.foundPhones, ['+91 98450 12345']);

  // 90+ days later, old jobs are deleted, but not one with typed-in HR details.
  const run = await collect({ fetchSearches: fetchSearches({ apify: async () => ({ items: [] }), Naukri: none }), now: new Date('2027-06-01T01:30:00Z'), ...quiet });
  assert.equal(run.totals.removedOld, 1);
  assert.deepEqual((await Job.find().lean()).map((j) => j.sourceKeys), [['Naukri:N9']]);
});

test('a 30-day backfill dates new jobs by when they were posted, and LinkedIn skips listings already stored', async () => {
  const now = new Date('2027-08-01T01:30:00Z');
  const DAY = 86_400_000;
  await Job.create({
    fingerprint: 'stored-linkedin', title: 'Data Analyst', course: 'data-analyst', firstSeenAt: now, lastSeenAt: now,
    primaryPlatform: 'LinkedIn', platforms: ['LinkedIn'], sourceKeys: ['LinkedIn:LX1'],
  });
  const posted = (n, date) => ({
    ...naukriItem, jobId: `BF${n}`, jdURL: `/job-listings-bf-${n}`, title: `Data Analyst ${n}`, companyName: `Backfill Co ${n}`,
    createdDate: date ? Date.parse(date) : undefined,
  });
  const linkedinInputs = [];
  const naukriInputs = [];
  const run = await collect({
    fetchSearches: fetchSearches({
      apify: async (source, input) => (linkedinInputs.push(input), { items: [] }),
      Naukri: async (source, inputs) => {
        naukriInputs.push(...inputs);
        return inputs.map((i) => ({ status: 'ok', items: i.keyword === 'data analyst' ? [posted(1, '2027-07-20T06:00:00Z'), posted(2, '2027-05-01T06:00:00Z'), posted(3)] : [] }));
      },
    }),
    now,
    lookbackDays: 30,
    ...quiet,
  });

  assert.equal(linkedinInputs[0].datePosted, 'r2592000', 'LinkedIn: past month');
  assert.deepEqual(linkedinInputs[0].skipJobId, ['LX1'], 'LinkedIn: listings already stored are not fetched (or paid for) again');
  assert.equal(naukriInputs[0].days, 30);

  const firstSeen = async (id) => (await Job.findOne({ sourceKeys: `Naukri:${id}` }).lean()).firstSeenAt.toISOString();
  assert.equal(await firstSeen('BF1'), '2027-07-20T06:00:00.000Z', 'dated by its posting date');
  assert.equal(await firstSeen('BF2'), new Date(now.getTime() - 30 * DAY).toISOString(), 'older postings: the start of the window');
  assert.equal(await firstSeen('BF3'), now.toISOString(), 'no posting date: dated now');

  const stored = await CollectorRun.findById(run._id).lean();
  assert.equal(stored.lookbackDays, 30);
  assert.equal(stored.coverageFrom.toISOString(), new Date(now.getTime() - 30 * DAY).toISOString());
});
