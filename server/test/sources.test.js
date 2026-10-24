// How each platform's items become jobs (config/sources.js). Fake companies and jobs only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildJob } from '../src/collector/buildJob.js';
import { SOURCES } from '../src/config/sources.js';

const indeed = SOURCES.find((s) => s.platform === 'Indeed');
const now = new Date('2026-10-24T05:30:00Z');

// One result of valig/indeed-jobs-scraper, as it came on 24 Oct 2026 (fields trimmed).
const item = (extra = {}) => ({
  key: 'f00dcafe12345678',
  url: 'https://in.indeed.com/viewjob?jk=f00dcafe12345678',
  title: 'Application Support Engineer (L2)',
  datePublished: '2026-10-01T05:00:00.000Z',
  dateOnIndeed: '2026-10-23T09:15:00.000Z',
  location: { countryName: 'India', countryCode: 'IN', admin1Code: 'KA', admin3Code: 'BLR', city: '' },
  employer: { name: 'Quokka Systems Pvt Ltd' },
  attributes: { A1: 'SQL', A2: 'Linux', A3: 'Full-time', A4: 'In-person' },
  baseSalary: { min: 600000, max: 1000000, unitOfWork: 'YEAR', currencyCode: 'INR' },
  description: { text: 'L2 support for our payments platform. 3-6 years of experience. Write to hr@quokka.in', html: '<p>…</p>' },
  ...extra,
});

test('Indeed (Apify): searched in India, for the last day; a 30-day backfill reaches 14 days, its longest filter', () => {
  assert.deepEqual(indeed.buildInput('production support', 100, null, { days: 1 }), {
    country: 'in', title: 'production support', location: '', limit: 100, datePosted: '1',
  });
  assert.deepEqual([2, 7, 10, 30].map((days) => indeed.buildInput('x', 100, null, { days }).datePosted), ['3', '7', '14', '14']);
  assert.equal(indeed.via, 'apify');
  assert.equal(indeed.actorId, 'valig/indeed-jobs-scraper');
});

test('Indeed (Apify): an item becomes a job, with the same job key and link as the old scraper saved', () => {
  const raw = indeed.map(item(), now);
  assert.equal(raw.sourceId, 'f00dcafe12345678');
  assert.equal(raw.url, 'https://in.indeed.com/viewjob?jk=f00dcafe12345678');
  assert.equal(raw.company, 'Quokka Systems Pvt Ltd');
  assert.equal(raw.postedAt.toISOString(), '2026-10-23T09:15:00.000Z', 'when it appeared on Indeed, not when first published');
  assert.equal(raw.salaryText, '₹6,00,000 - ₹10,00,000 a year');

  const { job, skip } = buildJob(indeed, item(), now);
  assert.equal(skip, undefined);
  assert.equal(job.course, 'production-support');
  assert.deepEqual(job.cities, ['Bengaluru']);
  assert.deepEqual([job.experienceMin, job.experienceMax], [3, 6], 'read from the full description');
  assert.equal(job.sourceKey, 'Indeed:f00dcafe12345678');
  assert.ok(job.skills.includes('SQL') && job.skills.includes('Linux/Unix'), "Indeed's own skill tags count");
  assert.deepEqual(job.foundEmails, ['hr@quokka.in'], 'an HR email in the description is found');
});

test("Indeed (Apify): place codes become our cities; remote is marked; an unknown place says so", () => {
  const cities = (location, attributes) => buildJob(indeed, item({ location: { countryCode: 'IN', ...location }, attributes }), now).job;
  assert.deepEqual(cities({ admin1Code: 'HR', admin3Code: 'GRG' }).cities, ['Delhi NCR'], 'Gurugram');
  assert.deepEqual(cities({ admin1Code: 'MH', admin3Code: 'NVM' }).cities, ['Mumbai'], 'Navi Mumbai');
  assert.deepEqual(cities({ admin1Code: 'DL' }).cities, ['Delhi NCR'], 'only the state: Delhi is a city');
  assert.deepEqual(cities({ admin1Code: 'UP', admin3Code: 'ZZZ' }).cities, ['India (city not stated)'], 'never a guess');
  assert.deepEqual(cities({ city: 'Pune' }).cities, ['Pune'], 'a city it names');
  const remote = cities({ admin1Code: 'MH', admin3Code: 'PNQ' }, { A1: 'Remote', A2: 'Work from home' });
  assert.deepEqual([remote.cities, remote.isRemote], [['Pune'], true]);
  const anywhere = cities({}, { A1: 'Work from home' });
  assert.deepEqual([anywhere.cities, anywhere.isRemote], [['Remote'], true]);
  assert.equal(cities({ admin3Code: 'BLR' }, { A1: 'Hybrid work' }).isRemote, false, 'hybrid is not remote');
});

test('Indeed (Apify): salaries read as Indeed writes them', () => {
  const pay = (baseSalary) => indeed.map(item({ baseSalary }), now).salaryText;
  assert.equal(pay({ min: 20000, max: 40000, unitOfWork: 'MONTH', currencyCode: 'INR' }), '₹20,000 - ₹40,000 a month');
  assert.equal(pay({ min: 1500000, max: null, unitOfWork: 'YEAR', currencyCode: 'INR' }), 'From ₹15,00,000 a year');
  assert.equal(pay({ min: null, max: 800, unitOfWork: 'HOUR', currencyCode: 'INR' }), 'Up to ₹800 an hour');
  assert.equal(pay({ min: 50000, max: 50000, unitOfWork: 'MONTH', currencyCode: 'INR' }), '₹50,000 a month');
  assert.equal(pay({ min: null, max: null, unitOfWork: null, currencyCode: null }), '');
  assert.equal(pay(null), '');
});
