import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTitle } from '../src/classify.js';
import { buildJob } from '../src/collector/buildJob.js';
import { SOURCES } from '../src/config/sources.js';
import {
  experienceBand,
  extractContacts,
  extractSkills,
  fingerprintFor,
  isIndiaLocation,
  parseExperience,
  parseLocation,
  phoneKey,
  shownCities,
  titleKey,
} from '../src/normalize.js';

test('titles go to the right course', () => {
  const cases = {
    'Sr. Data Analyst - SQL & Power BI (3-6 yrs)': 'data-analyst',
    'MIS Executive': 'data-analyst',
    'Data Scientist / Data Analyst': 'data-science',
    'AI/ML Engineer': 'data-science',
    'Azure Data Engineer': 'data-engineering',
    'Data Analytics Engineer': 'data-engineering',
    'L2/L3 Application Support Engineer - Unix, SQL': 'production-support',
    'Site Reliability Engineer (SRE)': 'production-support',
    'Business Analyst': 'data-analyst',
    'Senior Business Analyst - Insurance': 'data-analyst',
    'Business Analyst - Production Support': 'production-support', // a strong match elsewhere wins
    'Business Analyst (Azure Data Factory)': 'data-engineering',
    'SAP Support Consultant': 'production-support',
    'Production Control Analyst': 'production-support',
    'Service Desk Engineer': 'production-support',
    'Technical Operations Engineer': 'production-support',
    'Middleware Support Engineer (Kafka)': 'production-support', // not Data Engineering
    // Support titles the searches found that used to match nothing (23 Oct 2026)
    'Senior Engineer, Site Reliability Engineering': 'production-support',
    'Site Reliability Lead': 'production-support',
    'Service Reliability Engineer- Apple Data Platforms': 'production-support',
    'Reliability Engineer II': 'production-support',
    'Analyst Senior, Application Maintenance & Support': 'production-support',
    'IT Applications Support': 'production-support',
    'Senior SQL Support': 'production-support',
    'ERP Second Level Support (RUN) - Analyst': 'production-support',
    'Siebel Support _ Tier 2 FTE': 'production-support',
    'Sr. Service Operations Engineer': 'production-support',
    'ServiceNow Business Analyst': 'production-support', // the ServiceNow role, not a Data Analyst one
    'Data Analyst - ServiceNow Reporting': 'data-analyst', // a longer strong phrase still wins
  };
  for (const [title, course] of Object.entries(cases)) assert.equal(classifyTitle(title), course, title);
});

test("every search term is a title its own course's rules recognise (else its jobs would be thrown away)", async () => {
  const { COURSES, searchesOf } = await import('../src/config/courses.js');
  for (const course of COURSES) {
    for (const { term, extra } of searchesOf(course)) {
      if (extra) continue; // extra searches look for other titles on purpose (e.g. "mis executive" finds Data Analyst jobs)
      const title = term.replace(/\b\w/g, (c) => c.toUpperCase());
      assert.equal(classifyTitle(`Senior ${title}`), course.id, `${course.name}: "${term}"`);
    }
  }
});

test("LinkedIn's searches are some of each course's own searches (a typo would quietly search nothing)", async () => {
  const { COURSES, searchesOf } = await import('../src/config/courses.js');
  for (const course of COURSES) {
    const all = searchesOf(course).map((s) => s.term);
    assert.ok(course.linkedinSearchTerms?.length, `${course.name} has LinkedIn searches`);
    for (const term of course.linkedinSearchTerms) assert.ok(all.includes(term), `${course.name}: "${term}" is one of its searches`);
  }
});

test('unrelated titles are rejected', () => {
  for (const title of ['Customer Support Executive', 'Technical Support - Voice Process', 'Data Entry Operator', 'Data Science Trainer', 'Java Developer', 'ETL Tester']) {
    assert.equal(classifyTitle(title), null, title);
  }
});

test('locations are normalised and grouped', () => {
  assert.deepEqual(parseLocation('Bangalore Urban, Karnataka, India').cities, ['Bengaluru']);
  assert.deepEqual(parseLocation('Gurgaon, Haryana').cities, ['Delhi NCR']);
  assert.deepEqual(parseLocation('Hyderabad, Bengaluru, Pune').cities, ['Hyderabad', 'Bengaluru', 'Pune']);
  assert.deepEqual(parseLocation('Mumbai (All Areas)').cities, ['Mumbai']);
  assert.deepEqual(parseLocation('Hosur, Tamil Nadu').cities, ['Hosur']);
  assert.deepEqual(parseLocation('India').cities, ['India (city not stated)']);
  assert.deepEqual(parseLocation('Hyderābād').cities, ['Hyderabad'], 'accented spelling from Glassdoor');
  assert.equal(parseLocation('Work from home').isRemote, true);
  assert.deepEqual(shownCities(['Pune', 'Remote']), ['Pune'], 'Remote is stored but not shown');
  assert.deepEqual(shownCities(['Remote']), []);
  assert.deepEqual(shownCities(undefined), []);
});

test('India check', () => {
  assert.equal(isIndiaLocation('Pune, Maharashtra, India'), true);
  assert.equal(isIndiaLocation('Sriperumbudur, Tamil Nadu'), true);
  assert.equal(isIndiaLocation('New York, NY'), false);
  assert.equal(isIndiaLocation(''), true);
  assert.equal(isIndiaLocation('Hyderābād'), true);
});

test('Glassdoor scraper cards: India-only search keeps localities, ages become dates', () => {
  const glassdoor = SOURCES.find((s) => s.platform === 'Glassdoor');
  const now = new Date('2026-10-16T12:00:00Z');
  const card = (location, age) => ({ jobId: '1', title: 'Data Engineer', company: 'ABC', location, age, url: 'https://www.glassdoor.co.in/job-listing/x?jl=1' });
  assert.deepEqual(buildJob(glassdoor, card('Hauz Khas', '5h'), now).job.cities, ['Hauz Khas']);
  assert.equal(buildJob(glassdoor, card('Pune', '5h'), now).job.postedAt.toISOString(), '2026-10-16T07:00:00.000Z');
  assert.equal(buildJob(glassdoor, card('Pune', '3d'), now).job.postedAt.toISOString(), '2026-10-13T12:00:00.000Z');
  assert.equal(buildJob(glassdoor, card('Pune', ''), now).job.postedAt, null);
});

test('Naukri scraper items map to clean jobs', () => {
  const naukri = SOURCES.find((s) => s.platform === 'Naukri');
  const { job } = buildJob(naukri, {
    jobId: '161026022886',
    title: 'Data Platform Engineer',
    companyName: 'Filuet',
    jdURL: '/job-listings-data-platform-engineer-161026022886',
    placeholders: [{ type: 'experience', label: '5 Yrs' }, { type: 'salary', label: '6-10 Lacs PA' }, { type: 'location', label: 'Hybrid - Hyderabad, Pune' }],
    createdDate: 1792150832027,
    minimumExperience: '5',
    maximumExperience: '5',
    tagsAndSkills: 'Unix,Azure Data Lake,Azure Data Factory',
  }, new Date());
  assert.equal(job.url, 'https://www.naukri.com/job-listings-data-platform-engineer-161026022886');
  assert.deepEqual(job.cities, ['Hyderabad', 'Pune']);
  assert.equal(job.experienceBand, '5');
  assert.equal(job.salaryText, '6-10 Lacs PA');
  assert.ok(job.skills.includes('Azure Data Factory'));
  assert.equal(job.sourceKey, 'Naukri:161026022886');
});

test('experience is read from text', () => {
  assert.deepEqual(parseExperience('Data Analyst (3-6 yrs)'), { min: 3, max: 6 });
  assert.deepEqual(parseExperience('needs 5+ years in SQL'), { min: 5, max: null });
  assert.deepEqual(parseExperience('Minimum 2 years of experience'), { min: 2, max: null });
  assert.deepEqual(parseExperience('4 years of relevant experience'), { min: 4, max: null });
  assert.deepEqual(parseExperience('Freshers welcome'), { min: 0, max: null });
  assert.deepEqual(parseExperience('Founded in 2024-25 years ago'), { min: null, max: null });
  assert.equal(experienceBand(0), 'fresher');
  assert.equal(experienceBand(4), '4');
  assert.equal(experienceBand(5), '5');
  assert.equal(experienceBand(6), '5+', 'more than 5 years');
  assert.equal(experienceBand(12), '5+');
  assert.equal(experienceBand(null), 'unknown');
});

test('the same job on two platforms gets the same fingerprint', () => {
  const naukri = fingerprintFor({ company: 'ABC Technologies Pvt. Ltd.', title: 'Data Analyst - SQL/Power BI (2-5 yrs)', city: 'Bengaluru', platform: 'Naukri', sourceId: '1' });
  const linkedin = fingerprintFor({ company: 'ABC Technologies', title: 'Data Analyst (SQL, Power BI)', city: 'Bengaluru', platform: 'LinkedIn', sourceId: '2' });
  assert.equal(naukri, linkedin);
  assert.equal(titleKey('Sr Data Engineer - Bangalore'), titleKey('Senior Data Engineer'));
});

test('jobs without a company are never merged', () => {
  const a = fingerprintFor({ company: '', title: 'Data Analyst', city: 'Pune', platform: 'Indeed', sourceId: 'x1' });
  const b = fingerprintFor({ company: '', title: 'Data Analyst', city: 'Pune', platform: 'Indeed', sourceId: 'x2' });
  assert.notEqual(a, b);
});

test('skills are found as whole words', () => {
  assert.deepEqual(extractSkills('Strong SQL, PL/SQL and Power-BI; JavaScript a plus'), ['SQL', 'Power BI', 'PL/SQL']);
});

test('phone numbers and emails written in a posting are found', () => {
  assert.deepEqual(
    extractContacts('Share your CV at HR@Acme.in or call +91-98450-12345 / 080 4123 4567. Thanks', 'Call Neha 9845011122'),
    { phones: ['+91 98450 12345', '+91 80412 34567', '+91 98450 11122'], emails: ['hr@acme.in'] },
  );
  assert.deepEqual(extractContacts('Mail priya [at] talentco [dot] com, Mob.9900112233'), { phones: ['+91 99001 12233'], emails: ['priya@talentco.com'] });
  assert.deepEqual(extractContacts('Reach priya@talentco.com.MIS Executive role'), { phones: [], emails: ['priya@talentco.com'] }, 'the next sentence is not part of the address');
});

test('numbers and mailboxes that are not a recruiter contact are ignored', () => {
  const none = { phones: [], emails: [] };
  assert.deepEqual(extractContacts('Job ID: 9123456780. Req #8123456789'), none, 'job and requisition IDs');
  assert.deepEqual(extractContacts('Apply at https://www.linkedin.com/jobs/view/9988776655'), none, 'numbers inside links');
  assert.deepEqual(extractContacts('CTC 6,00,000 - 9,00,000. Posted 17-10-2026. 12345678901234'), none, 'salaries, dates, long numbers');
  assert.deepEqual(extractContacts('Call 9876543210 or 99999 99999'), none, 'placeholder numbers');
  assert.deepEqual(extractContacts('Need an accommodation? Email jobs.accommodations@wdc.com or compliance@wdc.com'), none, 'non-hiring mailboxes');
});

test('the collector keeps the contacts found in a posting', () => {
  const naukri = SOURCES.find((s) => s.platform === 'Naukri');
  const { job } = buildJob(
    naukri,
    {
      jobId: 'C1', jdURL: '/job-listings-C1', title: 'Data Analyst', companyName: 'Crown Solutions',
      placeholders: [{ type: 'location', label: 'Pune' }], minimumExperience: '3', maximumExperience: '5',
      jobDescription: '<p>Send resume to <b>resumes@hiringco.in</b></p>', hiringFor: 'Call Neha 9845011122',
    },
    new Date(),
  );
  assert.deepEqual(job.foundEmails, ['resumes@hiringco.in']);
  assert.deepEqual(job.foundPhones, ['+91 98450 11122']);
});

test('a phone number gives the same key however it is written', () => {
  for (const written of ['+91 98450 12345', '+91-98450-12345', '098450 12345', '9845012345', '0091 98450 12345', '(+91) 98450 12345']) {
    assert.equal(phoneKey(written), '9845012345', written);
  }
  assert.equal(phoneKey('080 4123 4567'), '8041234567');
  assert.notEqual(phoneKey('98450 12345'), phoneKey('98450 12346'));
});

test('skills with short or everyday names are found only where they mean the skill', () => {
  assert.deepEqual(extractSkills('Strong in Python and R; CI/CD with Jenkins'), ['Python', 'R', 'CI/CD']);
  assert.deepEqual(extractSkills('Our R&D team will help you excel at this'), [], '"R&D" and "excel at" are not skills');
  assert.deepEqual(extractSkills('Build RAG pipelines; share RAG status in incident management'), ['RAG', 'Incident management']);
  assert.deepEqual(extractSkills('Data warehousing, PySpark, Excel macros'), ['Excel', 'Excel VBA/Macros', 'Spark', 'Data Warehousing']);
});

test("Production Support skills are found in postings, and not in other courses' everyday words", () => {
  const post = 'L2 support in 24/7 rotational shifts: incident and problem management, RCA, hotfixes, batch job monitoring with Control-M, ' +
    'meeting SLAs, maintaining runbooks, on-call support and hypercare after go-live.';
  const found = extractSkills(post);
  for (const skill of ['Problem management', 'Root cause analysis', 'Hotfix deployment', 'SLA management', '24x7 support', 'Rotational shifts',
    'Batch monitoring', 'Runbooks and SOPs', 'On-call support', 'Hypercare', 'Control-M']) {
    assert.ok(found.includes(skill), skill);
  }
  assert.ok(!extractSkills('Build a RAG pipeline over our knowledge base with LangChain').includes('Runbooks and SOPs'), 'a knowledge base is not a runbook');
  assert.deepEqual(extractSkills('Strong troubleshooting and debugging skills; automation a plus'), [], 'everyday words are not skills');
});
