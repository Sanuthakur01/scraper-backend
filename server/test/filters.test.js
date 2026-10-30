// The two keep-rules: no large IT services firms, and 2-5 years of experience.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildJob } from '../src/collector/buildJob.js';
import { experienceInRange, experienceReason, isExcludedCompany } from '../src/config/filters.js';
import { SOURCES } from '../src/config/sources.js';

const naukri = SOURCES.find((s) => s.platform === 'Naukri');
const naukriItem = (company, minYears, maxYears) => ({
  jobId: `${company}-${minYears}`,
  jdURL: '/job-listings-x',
  title: 'Data Engineer',
  companyName: company,
  placeholders: [{ type: 'location', label: 'Pune' }],
  minimumExperience: minYears == null ? undefined : String(minYears),
  maximumExperience: maxYears == null ? undefined : String(maxYears),
});

test('big IT services firms are excluded under the names platforms use for them', () => {
  for (const name of [
    'TCS', 'Tata Consultancy Services', 'Tata Consultancy Services Ltd.', 'Infosys', 'Infosys BPM', 'Infosys Limited',
    'IBM', 'IBM India Pvt Ltd', 'International Business Machines', 'Wipro Limited', 'Accenture in India',
    'Cognizant Technology Solutions', 'HCLTech', 'HCL Technologies', 'Tech Mahindra', 'Capgemini Technology Services India',
    'LTIMindtree', 'Genpact India Pvt. Ltd.', 'LTM', 'LTM Limited',
  ]) {
    assert.ok(isExcludedCompany(name), name);
  }
});

test('other companies are kept, including ones whose names merely start like an excluded one', () => {
  for (const name of ['Citi', 'Deloitte', 'Infopie Business Solutions', 'Ibmetrics Analytics', 'Wiproxy Labs', 'Microchip Technology', 'LTMS Analytics', '']) {
    assert.ok(!isExcludedCompany(name), name);
  }
});

test('experience: the minimum asked must be 1 to 5 years (fresher jobs and 5+ year jobs are left out)', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10, null].map(experienceInRange), [false, true, true, true, true, true, false, false, false]);
  assert.deepEqual([0, 1, 5, 6, 10, null].map(experienceReason), ['experience', null, null, 'senior', 'senior', null]);
});

test('jobs are checked before saving', () => {
  const now = new Date();
  const tcs = buildJob(naukri, naukriItem('Tata Consultancy Services', 3, 5), now);
  assert.equal(tcs.skip, 'big-company');
  assert.equal(tcs.job?.company, 'Tata Consultancy Services', 'left out, but its details come back for the non-filtered jobs');
  assert.equal(buildJob(naukri, naukriItem('Alpha Analytics', 0, 2), now).skip, 'experience', '0-2 yrs: a fresher job');
  assert.equal(buildJob(naukri, naukriItem('Alpha Analytics', 1, 3), now).job?.experienceBand, '1', '1-3 yrs is kept, in the 1 yr group');
  assert.equal(buildJob(naukri, naukriItem('Alpha Analytics', 1, 5), now).skip, undefined, '1-5 yrs is kept');
  const senior = buildJob(naukri, naukriItem('Alpha Analytics', 6, 9), now);
  assert.deepEqual([senior.skip, senior.job?.experienceBand], ['senior', '5+'], '6-9 yrs (more than 5): left out, its details come back for Non-filtered');
  assert.ok(buildJob(naukri, naukriItem('Alpha Analytics', 3, 6), now).job, '3-6 yrs is kept');
  assert.ok(buildJob(naukri, naukriItem('Alpha Analytics', 5, 8), now).job, '5-8 yrs is kept');
  const unknown = buildJob(naukri, naukriItem('Alpha Analytics', null, null), now);
  assert.equal(unknown.job.experienceUnknown, true, 'kept only if it matches a kept job elsewhere');
});
