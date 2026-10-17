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
