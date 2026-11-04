import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companiesMatch, JobPool, listingFromJob, titlesMatch } from '../src/collector/jobPool.js';
import { companyKey, fingerprintFor, titleKey } from '../src/normalize.js';

// A cleaned job as buildJob would produce it.
const job = (platform, id, title, company, cities, extra = {}) => ({
  platform,
  url: `https://${platform.toLowerCase()}.example/${id}`,
  sourceKey: `${platform}:${id}`,
  fingerprint: fingerprintFor({ company, title, city: cities[0], platform, sourceId: id }),
  title,
  company,
  cities,
  course: 'data-engineering',
  skills: [],
  ...extra,
});

test('company names written differently on each platform match', () => {
  const same = (a, b) => companiesMatch(companyKey(a), companyKey(b));
  assert.ok(same('HSBC', 'HSBC Holdings plc'));
  assert.ok(same('Nielsen', 'Nielsen Holdings B.V.'));
  assert.ok(same('The Nielsen Company', 'Nielsen'));
  assert.ok(same('Accenture in India', 'Accenture Ltd'));
  assert.ok(same('Tyson Foods', 'Tyson Foods India Innovation Center'));
  assert.ok(same('Hennes & Mauritz AB', 'H&M'), 'legal name used by Glassdoor');
  assert.ok(same('Ernst & Young Global Ltd', 'EY'));
  assert.ok(same('Citigroup Inc.', 'Citi'));
  assert.ok(same('UAL Corporation', 'United Airlines India Knowledge Center'));
  assert.ok(same('JPMorgan Chase & Co.', 'JPMorganChase'));
  assert.ok(!same('Infosys', 'Info Edge'));
  assert.ok(!same('Wipro', 'Wiprotech Solutions'));
});

test('titles written differently match, but different seniority does not', () => {
  const same = (a, b) => titlesMatch(titleKey(a), titleKey(b));
  assert.ok(same('GCP Data Engineer', 'Walk-in || GCP Data Engineer - S'));
  assert.ok(same('Informatica/IICS', 'IICS / Informatica Developer (2-5 Years)'));
  assert.ok(same('Senior AI/ML Engineer', 'Senior AI/ML Engineer - Python, LLM, Deep Learning'));
  assert.ok(!same('Data Engineer', 'Senior Data Engineer'));
  assert.ok(!same('Data Analyst', 'Data Analyst Intern'));
  assert.ok(!same('Data Engineer', 'Engineer'), 'one-word titles are too vague to match');
});

test('the same opening on three platforms becomes one job with all three links', () => {
  const pool = new JobPool();
  pool.addListing(listingFromJob(job('LinkedIn', 1, 'Senior Data Analyst', 'Microchip Technology Inc.', ['Bengaluru'])));
  pool.addListing(listingFromJob(job('Indeed', 2, 'Senior Data Analyst', 'Microchip Technology', ['India (city not stated)'])));
  pool.addListing(listingFromJob(job('Glassdoor', 3, 'Senior Data Analyst', 'Microchip Technology Inc', ['Bengaluru'])));
  assert.equal(pool.openings.length, 1);
  const [opening] = pool.openings;
  assert.deepEqual(opening.platforms, ['LinkedIn', 'Indeed', 'Glassdoor']);
  assert.equal(Object.keys(opening.links).length, 3);
  assert.deepEqual(opening.cities, ['Bengaluru'], 'the vague city does not replace the real one');
});

test('two listings on the same platform are not merged by similarity', () => {
  const pool = new JobPool();
  pool.addListing(listingFromJob(job('Naukri', 1, 'Data Engineer', 'TCS', ['Pune'])));
  pool.addListing(listingFromJob(job('Naukri', 2, 'Azure Data Engineer', 'TCS', ['Pune'])));
  assert.equal(pool.openings.length, 2);
});

test('different cities keep openings apart', () => {
  const pool = new JobPool();
  pool.addListing(listingFromJob(job('LinkedIn', 1, 'Data Engineer', 'Infosys', ['Pune'])));
  pool.addListing(listingFromJob(job('Naukri', 2, 'Data Engineer', 'Infosys', ['Chennai'])));
  assert.equal(pool.openings.length, 2);
});

test('the earliest posting decides which platform counts a new opening', () => {
  const pool = new JobPool();
  pool.addListing(listingFromJob(job('LinkedIn', 1, 'Data Engineer', 'ABC', ['Pune'], { postedAt: new Date('2026-10-16') })));
  pool.addListing(listingFromJob(job('Naukri', 2, 'Data Engineer', 'ABC Pvt Ltd', ['Pune'], { postedAt: new Date('2026-10-15') })));
  assert.equal(pool.openings[0].primaryPlatform, 'Naukri');
});

// ---------- npm run dedupe (src/dedupe.js) ----------

const DAY = 86_400_000;
// A stored job, first found `days` days after 1 Oct 2026.
const stored = (n, days, platform, sourceKey, extra = {}) => {
  const at = new Date(Date.UTC(2026, 9, 1) + days * DAY);
  const fingerprint = fingerprintFor({ company: 'Acme', title: 'Data Engineer', city: undefined, platform, sourceId: String(n) });
  return {
    _id: `job${n}`, fingerprint, fingerprints: [fingerprint], title: 'Data Engineer', company: 'Acme', cities: [], course: 'data-engineering',
    firstSeenAt: at, lastSeenAt: at, primaryPlatform: platform, platforms: [platform], links: { [platform]: `https://example.com/${n}` },
    sourceKeys: sourceKey ? [sourceKey] : [], skills: [], foundPhones: [], foundEmails: [], ...extra,
  };
};
const TEAM = 'Added by team';
const byHand = (email) => ({ addedBy: { userId: `user_${email}`, email, name: '', at: new Date() } });

test('dedupe never merges away a job added by hand; a later collected copy still joins one', async () => {
  const { findMerges } = await import('../src/dedupe.js');
  // Riya and Aman added the same opening (the same company and title, no city) under two links.
  const docs = [stored(1, 0, TEAM, `${TEAM}:example.com/1`, byHand('riya@example.com')), stored(2, 1, TEAM, `${TEAM}:example.com/2`, byHand('aman@example.com'))];
  assert.deepEqual(findMerges(docs, { windowDays: 14 }), { kept: [], removed: [] }, 'both stay, each with its own link and who added it');

  // Collected later: joins a job added by hand, which keeps its own link and who added it.
  const { kept, removed } = findMerges([...docs, stored(3, 2, 'Naukri', 'Naukri:3')], { windowDays: 14 });
  assert.deepEqual(removed, ['job3']);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].addedBy);
  assert.deepEqual(kept[0].links, { [TEAM]: `https://example.com/${kept[0]._id.slice(3)}`, Naukri: 'https://example.com/3' });

  // A job added by hand after a collected one: a job of its own, not merged into it.
  const later = findMerges([stored(4, 0, 'Naukri', 'Naukri:4'), stored(5, 1, TEAM, `${TEAM}:example.com/5`, byHand('riya@example.com'))], { windowDays: 14 });
  assert.deepEqual(later, { kept: [], removed: [] });
});

test('dedupe writes merges whose copies have listing keys (the kept job takes them over)', async () => {
  const { MongoMemoryServer } = await import('mongodb-memory-server-core');
  const { connectDb, disconnectDb } = await import('../src/db.js');
  const { Job } = await import('../src/models.js');
  const { dedupeJobs } = await import('../src/dedupe.js');
  const mongo = await MongoMemoryServer.create();
  try {
    await connectDb(mongo.getUri());
    await Job.init();
    const withoutId = ({ _id, ...doc }) => doc;
    const [first, copy, mine] = await Job.create([
      withoutId(stored(1, 0, 'Naukri', 'Naukri:1')),
      withoutId(stored(2, 1, 'Indeed', 'Indeed:abc', { manual: { remarks: 'Called', updatedAt: new Date() } })),
      withoutId(stored(3, 2, 'Added by team', 'Added by team:careers.acme.com/jobs/3', byHand('riya@example.com'))),
    ]);
    const logged = [];
    assert.deepEqual(await dedupeJobs({ dryRun: true, log: (m) => logged.push(m) }), { total: 3, removed: 1, mergedInto: 1 });
    assert.equal(await Job.countDocuments(), 3, 'a dry run changes nothing');
    assert.ok(logged.some((m) => m.includes('Dry run')));

    await dedupeJobs({ log: () => {} });
    const left = await Job.find().sort({ firstSeenAt: 1 }).lean();
    assert.deepEqual(left.map((j) => String(j._id)), [String(first._id), String(mine._id)], 'the copy is gone, the job added by hand stays');
    assert.deepEqual([...left[0].sourceKeys].sort(), ['Indeed:abc', 'Naukri:1']);
    assert.deepEqual([...left[0].platforms].sort(), ['Indeed', 'Naukri']);
    assert.equal(left[0].manual.remarks, 'Called', "the copy's HR details moved to the kept job");
    assert.equal(await Job.exists({ _id: copy._id }), null);
    assert.deepEqual(await dedupeJobs({ log: () => {} }), { total: 2, removed: 0, mergedInto: 0 }, 'run again: nothing more');
  } finally {
    await disconnectDb();
    await mongo.stop();
  }
});
