// Jobs added by the team: an opening the collector missed, added by hand with its link and HR contact. It is stored
// as an ordinary job on the site "Added by team" (Filtered or Non-filtered by the keep rules), its HR contact counts
// like any other added contact, and the activity record says who added it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { connectDb, disconnectDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth.js';
import { Activity, CollectorRun, Job, NonFilteredJob } from '../src/models.js';
import { forgetCompanySpellings } from '../src/sameCompany.js';
import { can, PERMISSIONS, roleFrom, ROLES } from '../src/config/access.js';
import { FOUND_BY_REQUIRED, PHONE_EXISTS } from '../src/api/followUp.js';
import { fingerprintFor } from '../src/normalize.js';
import { canonicalLink, EXPERIENCE_UNREADABLE, jobLink, parseAddedJobInput, readExperience, siteFromUrl, TEAM_PLATFORM } from '../src/addedJobs.js';
import { runTool } from '../src/ai/tools.js';
import { describePage } from '../src/ai/prompt.js';

// No Authorization header: a signed-in admin; "Bearer <role>:<email>" signs in that person; "Bearer signed-out": not
// signed in.
const TESTER = { userId: 'user_tester', email: 'tester@example.com', name: 'Test Admin', role: 'ADMIN' };
async function fakeIdentify(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!token) return TESTER;
  if (token === 'signed-out') throw new AuthError(401, 'Please sign in again.');
  const [role, email] = token.split(':');
  return { userId: `user_${email}`, email, name: '', role: roleFrom({ role }) };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TEKION_LINK = 'https://in.linkedin.com/jobs/view/data-analyst-i-at-tekion-corp-4487004709';
let mongo;
let server;
let base;
let tekion; // a scraped LinkedIn job (Filtered)
let omega; // another company's job with an HR number typed in
let zema; // a scraped Naukri job in Non-filtered

before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  await Promise.all([Job.init(), NonFilteredJob.init(), Activity.init()]);
  const now = Date.now();
  const job = (n, extra) => ({
    fingerprint: `f${n}`,
    title: `Data Analyst ${n}`,
    course: 'data-analyst',
    cities: ['Pune'],
    firstSeenAt: new Date(now - HOUR),
    lastSeenAt: new Date(now - HOUR),
    primaryPlatform: 'Naukri',
    platforms: ['Naukri'],
    sourceKeys: [`X:${n}`],
    ...extra,
  });
  const hr = (phone, ago) => ({ manual: { phone, phoneKeys: [phone.replace(/\D/g, '')], foundBy: 'apollo', updatedAt: new Date(now - ago) } });
  [tekion, omega] = await Job.create([
    job(1, {
      title: 'Data Analyst I',
      company: 'Tekion Corp',
      cities: ['Bengaluru'],
      fingerprint: fingerprintFor({ company: 'Tekion Corp', title: 'Data Analyst I', city: 'Bengaluru' }), // as the collector writes it
      primaryPlatform: 'LinkedIn',
      platforms: ['LinkedIn'],
      links: { LinkedIn: TEKION_LINK },
      sourceKeys: ['LinkedIn:4487004709'],
    }),
    job(2, { company: 'Omega Corp', ...hr('90909 09090', HOUR) }),
    job(3, { company: 'Acme Analytics', title: 'Data Engineer', course: 'data-engineering', firstSeenAt: new Date(now - 5 * DAY), ...hr('91111 22222', 5 * DAY) }),
  ]);
  zema = await NonFilteredJob.create(
    job(4, { company: 'Zema Global', title: 'Data Analyst', sourceKeys: ['Naukri:031126021521'], experienceMin: 0, experienceBand: 'fresher', leftOutBy: 'experience' }),
  );
  // Today's collection: the latest day is today, so a job added now is in the job list's latest day.
  await CollectorRun.create({ startedAt: new Date(now - 60_000), finishedAt: new Date(now - 30_000), status: 'success', lookbackDays: 1 });
  forgetCompanySpellings();
  server = createApp({ identify: fakeIdentify }).listen(0);
  base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  await disconnectDb();
  await mongo?.stop();
});

const send = (path, method, body, token) =>
  fetch(`${base}/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const add = (body, token) => send('added-jobs', 'POST', body, token);
const get = async (path, token) => (await fetch(`${base}/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).json();
const check = (params) => get(`added-jobs/check?${new URLSearchParams(params)}`);
const storedCounts = async () => [await Job.countDocuments(), await NonFilteredJob.countDocuments(), await Activity.countDocuments()];
const job = (fields) => ({ title: 'Data Analyst', course: 'data-analyst', ...fields });

test('a job site link names its listing as the collector stores it; other links name none', () => {
  assert.deepEqual(siteFromUrl(TEKION_LINK), { platform: 'LinkedIn', sourceId: '4487004709' });
  assert.deepEqual(siteFromUrl('linkedin.com/jobs/view/4487004709/'), { platform: 'LinkedIn', sourceId: '4487004709' });
  assert.deepEqual(siteFromUrl('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4487004709'), { platform: 'LinkedIn', sourceId: '4487004709' });
  assert.deepEqual(
    siteFromUrl('https://www.naukri.com/job-listings-data-analyst-zema-global-data-corporation-navi-mumbai-0-to-2-years-031126021521?src=jobsearchDesk&sid=1'),
    { platform: 'Naukri', sourceId: '031126021521' },
    'leading zeros kept',
  );
  assert.deepEqual(siteFromUrl('https://in.indeed.com/viewjob?jk=c6b760be703ab600'), { platform: 'Indeed', sourceId: 'c6b760be703ab600' });
  assert.deepEqual(siteFromUrl('https://in.indeed.com/jobs?q=data+analyst&vjk=C6B760BE703AB600'), { platform: 'Indeed', sourceId: 'c6b760be703ab600' });
  assert.deepEqual(
    siteFromUrl('https://www.glassdoor.co.in/job-listing/senior-data-analyst-gallagher-JV_IC2887994_KO0,19_KE20,29.htm?jl=1010316114893'),
    { platform: 'Glassdoor', sourceId: '1010316114893' },
  );
  assert.deepEqual(siteFromUrl('https://www.glassdoor.co.in/Job/index.htm?jobListingId=1010316114893'), { platform: 'Glassdoor', sourceId: '1010316114893' });
  // A LinkedIn job's other pages: Easy Apply, the Apply button's redirect, the /comm/ link.
  for (const link of [
    'https://www.linkedin.com/jobs/view/4487004709/apply/?openSDUIApplyFlow=true',
    'https://www.linkedin.com/jobs/view/data-analyst-at-acme-4487004709/apply/',
    'https://www.linkedin.com/jobs/view/externalApply/4487004709?url=https%3A%2F%2Fcareers.acme.com',
    'https://www.linkedin.com/comm/jobs/view/4487004709',
  ]) {
    assert.deepEqual(siteFromUrl(link), { platform: 'LinkedIn', sourceId: '4487004709' }, link);
  }
  for (const link of ['https://careers.acme.com/jobs/4487004709', 'https://www.linkedin.com/company/acme', 'https://www.naukri.com/data-analyst-jobs', 'https://in.indeed.com/jobs?q=sql', 'https://www.linkedin.com/jobs/view/4487004709abc', 'not a link']) {
    assert.equal(siteFromUrl(link), null, link);
  }

  assert.equal(jobLink('careers.acme.com/jobs/12#apply'), 'https://careers.acme.com/jobs/12', 'https:// added, the part after # dropped');
  assert.equal(jobLink('careers.acme.com/#apply'), 'https://careers.acme.com/');
  assert.equal(jobLink('careers.hashy.in/#/job/101'), 'https://careers.hashy.in/#/job/101', 'a page of the site after #: kept');
  assert.equal(jobLink('https://careers.hashy.in/#!/jobs/7'), 'https://careers.hashy.in/#!/jobs/7');
  // One spelling for the same page, as the database keeps it unique: no http(s), no www., no slash at the end.
  assert.equal(canonicalLink('https://www.Careers.Acme.com:8443/jobs/12/?a=1'), 'careers.acme.com:8443/jobs/12?a=1');
  assert.equal(canonicalLink('http://acme.com'), 'acme.com/');
  assert.equal(canonicalLink('https://careers.hashy.in/#/job/101'), 'careers.hashy.in/#/job/101');
  assert.equal(jobLink('javascript:alert(1)'), null);
  assert.equal(jobLink('https://me:secret@acme.com/jobs/1'), null);
  assert.equal(jobLink('http://localhost/jobs/1'), null, 'a domain with a dot');
});

test('the form: each mistake is named by its box', () => {
  const ok = { company: 'Nimbus Data Labs', title: 'Data Analyst', url: 'https://careers.nimbus.in/jobs/1', course: 'data-analyst' };
  const error = (change) => parseAddedJobInput({ ...ok, ...change }).error;
  assert.ok(parseAddedJobInput(ok).value);
  assert.match(error({ company: ' ' }), /^Company: /);
  assert.equal(error({ company: 'Pvt Ltd' }), 'Company: "Pvt Ltd" is not a company name.');
  assert.match(error({ company: 'x'.repeat(121) }), /^Company: at most 120/);
  assert.match(error({ title: '' }), /^Job title: /);
  assert.match(error({ title: 'x'.repeat(201) }), /^Job title: at most 200/);
  assert.match(error({ url: '' }), /^Job link: /);
  assert.match(error({ url: 'javascript:alert(1)' }), /^Job link: .* is not a web link/);
  assert.match(error({ url: `https://acme.com/${'x'.repeat(1000)}` }), /^Job link: at most 1000/);
  assert.match(error({ course: 'cooking' }), /^Course: /);
  assert.match(error({ course: undefined }), /^Course: /);
  assert.match(error({ location: 'x'.repeat(121) }), /^Location: at most 120/);
  assert.equal(error({ experience: 'a few' }), EXPERIENCE_UNREADABLE);
  assert.match(error({ experience: '1'.repeat(61) }), /^Experience: at most 60/);
  assert.match(error({ hrName: ['x'.repeat(81)], foundBy: 'apollo' }), /^HR name: /);
  assert.match(error({ hrProfile: ['not-a-link'], foundBy: 'apollo' }), /^HR profile: /);
  assert.match(error({ phone: ['call me'], foundBy: 'apollo' }), /^Phone: /);
  assert.match(error({ email: ['hr@'], foundBy: 'apollo' }), /^Email: /);
  assert.match(error({ foundBy: 'fax' }), /^Found by: /);
  assert.equal(error({ email: ['hr@nimbus.in'] }), FOUND_BY_REQUIRED, 'Found by is needed with any HR contact');
  assert.equal(error({ hrName: ['Priya'] }), FOUND_BY_REQUIRED);

  assert.deepEqual(['2-5 years', '3+ yrs', '4 years', '2-5', 'Fresher', ''].map((t) => readExperience(t).experience), [
    { min: 2, max: 5 }, { min: 3, max: null }, { min: 4, max: null }, { min: 2, max: 5 }, { min: 0, max: null }, null,
  ]);
});

test('a job added with its HR contact is stored in Filtered as a job on "Added by team", and shows everywhere', async () => {
  const before = Date.now();
  const res = await add({
    company: 'Nimbus Data Labs',
    title: 'Data Analyst (SQL, Power BI)',
    url: 'in.linkedin.com/jobs/view/data-analyst-at-nimbus-data-labs-4499000001?trk=abc#top',
    course: 'data-analyst',
    location: 'Pune, Maharashtra',
    experience: '2-5 years',
    hrName: ['Priya S'],
    phone: ['98450 12345'],
    email: ['priya@nimbus.in'],
    foundBy: 'linkedin',
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.set, 'filtered');
  const link = 'https://in.linkedin.com/jobs/view/data-analyst-at-nimbus-data-labs-4499000001?trk=abc';
  assert.deepEqual(body.job.platforms, [TEAM_PLATFORM]);
  assert.deepEqual(body.job.links, { [TEAM_PLATFORM]: link });
  assert.deepEqual(Object.keys(body.job.addedBy).sort(), ['at', 'email', 'name'], 'no Clerk user id in a row');
  assert.equal(body.job.addedBy.email, TESTER.email);
  assert.equal(body.job.addedBy.name, TESTER.name);
  assert.equal(body.job.contact.phone, '98450 12345');
  assert.equal(body.job.contact.email, 'priya@nimbus.in');
  assert.deepEqual(body.job.contact.hrNames, ['Priya S']);
  assert.deepEqual(body.known, { phone: [], email: [] }, 'a new company: nothing known, both count');

  const doc = await Job.findById(body.job._id).lean();
  assert.equal(doc.primaryPlatform, TEAM_PLATFORM);
  assert.deepEqual(doc.sourceKeys, ['LinkedIn:4499000001'], 'as the collector stores this listing, so a later collection joins it');
  assert.equal(doc.course, 'data-analyst');
  assert.deepEqual(doc.cities, ['Pune']);
  assert.deepEqual([doc.experienceMin, doc.experienceMax, doc.experienceBand, doc.experienceText], [2, 5, '2', '2-5 years']);
  assert.ok(doc.skills.includes('SQL') && doc.skills.includes('Power BI'));
  assert.deepEqual([doc.foundPhones, doc.foundEmails, doc.postedAt], [[], [], undefined]);
  assert.equal(doc.firstSeenAt.getTime(), doc.lastSeenAt.getTime());
  assert.ok(doc.firstSeenAt.getTime() >= before);
  assert.deepEqual({ ...doc.addedBy, at: undefined }, { userId: TESTER.userId, email: TESTER.email, name: TESTER.name, at: undefined });
  assert.equal(doc.manual.foundBy, 'linkedin');
  assert.equal(doc.leftOutBy, undefined);

  // In the job lists at once (the latest day's collection has run). The job lists need no sign-in, so they say who
  // added it by name, never by email.
  const byId = (await get(`jobs?id=${doc._id}`)).items[0];
  assert.deepEqual(Object.keys(byId.addedBy).sort(), ['at', 'name']);
  assert.equal(byId.addedBy.name, TESTER.name);
  assert.equal(JSON.stringify(await get('jobs?days=1')).includes(TESTER.email), false, 'no staff email in /jobs');
  const today = await get('jobs?days=1');
  assert.ok(today.items.some((j) => j._id === String(doc._id)), "in the latest day's jobs");
  assert.ok((await get(`jobs?days=1&platform=${encodeURIComponent(TEAM_PLATFORM)}`)).items.some((j) => j._id === String(doc._id)));
  const added = await get('added-jobs?days=1');
  const listed = added.items.find((j) => j._id === String(doc._id));
  assert.equal(listed.set, 'filtered');
  assert.equal(listed.addedBy.email, TESTER.email, 'signed in: with the email');
  assert.equal(listed.contact.phone, '98450 12345');
  assert.ok(added.withHr >= 1);
  assert.deepEqual(added.people.find((p) => p.email === TESTER.email)?.name, TESTER.name);

  // The activity record: who added the job, and its HR contact as any added contact.
  const record = await Activity.findOne({ 'job.id': doc._id }).lean();
  assert.equal(record.actor.email, TESTER.email);
  assert.equal(record.action, 'added');
  assert.deepEqual([record.job.set, record.job.title, record.job.company, record.job.course], ['filtered', 'Data Analyst (SQL, Power BI)', 'Nimbus Data Labs', 'data-analyst']);
  assert.deepEqual(record.newJob, { url: link, newCompany: true });
  assert.deepEqual(record.changes.find((c) => c.field === 'phone').added, ['98450 12345']);
  assert.deepEqual(record.changes.find((c) => c.field === 'email').added, ['priya@nimbus.in']);

  // The leaderboard counts the typed phone and email for the person, with where they were found.
  const rows = (await get('performance?days=1')).rows.filter((r) => r.job.id === String(doc._id));
  assert.deepEqual(rows.map((r) => [r.field, r.value, r.actor.email, r.foundBy, r.copied]).sort(), [
    ['email', 'priya@nimbus.in', TESTER.email, 'LinkedIn', false],
    ['phone', '98450 12345', TESTER.email, 'LinkedIn', false],
  ]);

  // The CSV says who added it.
  const csv = await (await fetch(`${base}/jobs.csv?days=1&company=${encodeURIComponent('Nimbus Data Labs')}`)).text();
  const [header, line] = csv.replace(/^﻿/, '').split('\r\n');
  assert.match(header, /,Remarks,Added by,/);
  assert.match(line, new RegExp(`,${TESTER.name},`));
  assert.match(header, /,Added by team link/);
});

test("a number on another company's job is refused, and nothing is stored", async () => {
  const counts = await storedCounts();
  const res = await add(job({ company: 'Zeta Labs', url: 'https://careers.zeta.in/jobs/9', phone: ['+91 90909-09090'], foundBy: 'apollo' }));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, PHONE_EXISTS);
  assert.match(body.detail, /^\+91 90909-09090 is already saved on "Data Analyst 2" at Omega Corp\.$/);
  assert.deepEqual(await storedCounts(), counts, 'no job, no activity record');
});

test("the same company's number is saved, marked as known and not counted; HR contact without Found by is refused", async () => {
  const counts = await storedCounts();
  const refused = await add(job({ company: 'Acme Analytics', url: 'https://careers.acme.com/jobs/77', phone: ['91111 22222'] }));
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, FOUND_BY_REQUIRED);
  assert.deepEqual(await storedCounts(), counts, 'nothing stored');

  const res = await add({
    company: 'Acme Analytics Pvt Ltd',
    title: 'Data Engineer',
    url: 'careers.acme.com/jobs/77',
    course: 'data-engineering',
    experience: '3-6 years',
    phone: ['+91 91111-22222'],
    foundBy: 'apollo',
  });
  assert.equal(res.status, 201);
  const { job: row, known } = await res.json();
  assert.equal(row.contact.phone, '+91 91111-22222');
  assert.equal(row.sameCompany.earlier, 1, 'hiring again');
  const record = await Activity.findOne({ 'job.id': row._id }).lean();
  assert.deepEqual(record.changes.find((c) => c.field === 'phone').known, ['+91 91111-22222']);
  assert.deepEqual(known, { phone: ['+91 91111-22222'], email: [] }, 'the form is told which ones are not counted');
  assert.equal(record.newJob.newCompany, false, 'the company had a job already');
  assert.equal((await get('performance?days=1')).rows.filter((r) => r.job.id === row._id).length, 0, 'a copy is not a new contact');

  // The same link again, written another way: the same posting.
  const again = await add(job({ company: 'Acme Analytics', url: 'http://www.careers.acme.com/jobs/77/' }));
  assert.equal(again.status, 409);
  assert.deepEqual((await again.json()).job, { _id: row._id, set: 'filtered' });
});

test('where a job goes: a big company and 6+ years go to Non-filtered; no experience stated stays Filtered', async () => {
  const oracle = await add(job({ company: 'Oracle', title: 'Data Engineer', course: 'data-engineering', url: 'https://careers.oracle.com/jobs/1', experience: '3-5 years' }));
  assert.equal(oracle.status, 201);
  const big = await oracle.json();
  assert.equal(big.set, 'nonfiltered');
  assert.equal((await NonFilteredJob.findById(big.job._id).lean()).leftOutBy, 'big-company');
  assert.equal(big.job.leftOutBy, 'big-company');

  const senior = await (await add(job({ company: 'Senior Co', url: 'https://senior.co/jobs/1', experience: '6+ years' }))).json();
  assert.equal(senior.set, 'nonfiltered');
  assert.deepEqual([senior.job.leftOutBy, senior.job.experienceBand], ['senior', '5+']);

  const plain = await (await add(job({ company: 'Plain Co', url: 'https://plain.co/jobs/1' }))).json();
  assert.equal(plain.set, 'filtered', 'the staff vouch for it');
  const doc = await Job.findById(plain.job._id).lean();
  assert.deepEqual([doc.experienceMin, doc.experienceBand, doc.cities, doc.leftOutBy], [null, 'unknown', [], undefined]);
  const record = await Activity.findOne({ 'job.id': doc._id }).lean();
  assert.deepEqual([record.action, record.changes, record.newJob.newCompany], ['added', [], true], 'recorded without HR contact too');

  const left = (await get('added-jobs?days=1')).items.find((j) => j._id === big.job._id);
  assert.equal(left.set, 'nonfiltered');
});

test('a posting stored already is refused with where it is, in either set', async () => {
  const counts = await storedCounts();
  const kept = await add(job({ company: 'Tekion', url: 'https://www.linkedin.com/jobs/view/4487004709/' }));
  assert.equal(kept.status, 409);
  assert.deepEqual(await kept.json(), {
    error: 'This job is already in the HR database.',
    detail: '"Data Analyst I" at Tekion Corp, in Filtered.',
    job: { _id: String(tekion._id), set: 'filtered' },
  });
  // The same listing's Easy Apply page: the same listing.
  const apply = await add(job({ company: 'Tekion', url: 'https://www.linkedin.com/jobs/view/4487004709/apply/?openSDUIApplyFlow=true' }));
  assert.equal(apply.status, 409);
  assert.deepEqual((await apply.json()).job, { _id: String(tekion._id), set: 'filtered' });
  const left = await add(job({ company: 'Zema', url: 'https://www.naukri.com/job-listings-data-analyst-zema-global-navi-mumbai-0-to-2-years-031126021521?src=jobsearchDesk' }));
  assert.equal(left.status, 409);
  const body = await left.json();
  assert.deepEqual(body.job, { _id: String(zema._id), set: 'nonfiltered' });
  assert.match(body.detail, /^"Data Analyst" at Zema Global, in Non-filtered \(.+\)\.$/);
  assert.deepEqual(await storedCounts(), counts);

  // Two people saving the same new listing at the same moment: one job, the other told it is there.
  const same = job({ company: 'Race Co', url: 'https://in.indeed.com/viewjob?jk=0123456789abcdef' });
  const statuses = (await Promise.all([add(same), add(same)])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.equal(await Job.countDocuments({ sourceKeys: 'Indeed:0123456789abcdef' }), 1);

  // The collector stores the listing between the check and the save: the database refuses the second record, and
  // the answer is the same 409 (never a server error).
  const create = Job.create;
  let raced;
  Job.create = async function (doc, ...rest) {
    Job.create = create;
    [raced] = await Job.insertMany([{ ...doc, _id: undefined, addedBy: undefined, title: 'Data Analyst (collected)', platforms: ['LinkedIn'], primaryPlatform: 'LinkedIn' }]);
    return create.call(this, doc, ...rest);
  };
  try {
    const res = await add(job({ company: 'Race Two', url: 'https://www.linkedin.com/jobs/view/4499000777' }));
    assert.equal(res.status, 409);
    assert.deepEqual((await res.json()).job, { _id: String(raced._id), set: 'filtered' });
  } finally {
    Job.create = create;
  }
  assert.equal(await Job.countDocuments({ sourceKeys: 'LinkedIn:4499000777' }), 1);
  assert.equal(await Activity.countDocuments({ 'job.company': 'Race Two' }), 0);
});

test('two people adding the same link at the same moment: one job, also for a careers page and across the sets', async () => {
  // A careers page link (no job site listing): stored with a key of its own, which the database keeps unique.
  const same = job({ company: 'Race Careers', url: 'https://careers.racecareers.in/jobs/42', phone: ['98450 55555'], foundBy: 'apollo' });
  const statuses = (await Promise.all([add(same), add(same)])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.equal(await Job.countDocuments({ company: 'Race Careers' }), 1);
  assert.equal(await Activity.countDocuments({ 'job.company': 'Race Careers' }), 1, 'one record: the number is counted once');
  assert.deepEqual((await Job.findOne({ company: 'Race Careers' }).lean()).sourceKeys, [`${TEAM_PLATFORM}:careers.racecareers.in/jobs/42`]);
  // The same page written another way is the same key.
  const again = await add(job({ company: 'Race Careers', url: 'http://www.careers.racecareers.in/jobs/42/' }));
  assert.equal(again.status, 409);

  // The same LinkedIn listing, typed with 2-5 years (Filtered) and with 8+ years (Non-filtered) at the same moment.
  const link = 'https://www.linkedin.com/jobs/view/4499000999';
  const answers = await Promise.all([
    add(job({ company: 'Cross Co', url: link, experience: '2-5 years' })),
    add(job({ company: 'Cross Co', url: link, experience: '8+ years' })),
  ]);
  assert.deepEqual(answers.map((r) => r.status).sort(), [201, 409]);
  const key = { sourceKeys: 'LinkedIn:4499000999' };
  assert.equal((await Job.countDocuments(key)) + (await NonFilteredJob.countDocuments(key)), 1, 'one job in the two sets together');
  assert.equal(await Activity.countDocuments({ 'job.company': 'Cross Co' }), 1);
  const refused = await answers.find((r) => r.status === 409).json();
  assert.equal(refused.error, 'This job is already in the HR database.');
  const kept = await answers.find((r) => r.status === 201).json();
  assert.deepEqual(refused.job, { _id: kept.job._id, set: kept.set }, 'told where the one that stayed is');
});

test('a careers page that names the job after # ("#/job/101"): each opening is a job of its own', async () => {
  const first = await add(job({ company: 'Hashy', url: 'https://careers.hashy.in/#/job/101' }));
  assert.equal(first.status, 201);
  assert.deepEqual((await first.json()).job.links, { [TEAM_PLATFORM]: 'https://careers.hashy.in/#/job/101' }, 'the saved link still opens the job');
  const second = await add(job({ company: 'Hashy', title: 'Data Engineer', course: 'data-engineering', url: 'https://careers.hashy.in/#/job/202' }));
  assert.equal(second.status, 201, 'another opening on the same site');
  const again = await add(job({ company: 'Hashy', url: 'http://www.careers.hashy.in/#/job/101' }));
  assert.equal(again.status, 409, 'the first one again, written another way');
  assert.equal((await check({ url: 'careers.hashy.in/#/job/303' })).duplicate, null);
  assert.equal(await Job.countDocuments({ company: 'Hashy' }), 2);
});

test('a failure once the job is saved: the save stands; a failure before that leaves nothing', async () => {
  const logged = [];
  const consoleError = console.error;
  console.error = (message) => logged.push(String(message));
  // The same-company look-up after the save fails once: the job and its record stay, and the answer is the saved row.
  const aggregate = Job.aggregate;
  Job.aggregate = function () {
    Job.aggregate = aggregate;
    throw new Error('look-up failed');
  };
  try {
    const res = await add(job({ company: 'Orphan Co', url: 'https://orphan.co/jobs/1', phone: ['98450 66666'], foundBy: 'apollo' }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.job.contact.phone, '98450 66666');
    assert.deepEqual(body.known, { phone: [], email: [] });
    assert.equal(await Job.countDocuments({ company: 'Orphan Co' }), 1);
    assert.equal(await Activity.countDocuments({ 'job.company': 'Orphan Co' }), 1);
    assert.ok(logged.some((m) => m.includes('look-up failed')), 'the failed look-up is logged');

    // An HR details save likewise answers its saved row, as before.
    Job.aggregate = function () {
      Job.aggregate = aggregate;
      throw new Error('look-up failed');
    };
    const put = await send(`jobs/${body.job._id}/follow-up`, 'PUT', { phone: ['98450 66666'], remarks: 'Called', foundBy: 'apollo' });
    assert.equal(put.status, 200);
    const row = await put.json();
    assert.equal(row.contact.remarks, 'Called');
    assert.equal(row.known, undefined, 'the same answer as before: the row');

    // The job can't take its HR contact, and that save can't take its record back either: the add removes both.
    const update = Job.findByIdAndUpdate;
    const deleteOne = Activity.deleteOne;
    Job.findByIdAndUpdate = function () {
      Job.findByIdAndUpdate = update;
      throw new Error('update failed');
    };
    Activity.deleteOne = function () {
      Activity.deleteOne = deleteOne;
      return Promise.reject(new Error('delete failed'));
    };
    try {
      const failed = await add(job({ company: 'Orphan Two', url: 'https://orphan.co/jobs/2', phone: ['98450 77777'], foundBy: 'apollo' }));
      assert.equal(failed.status, 500);
    } finally {
      Job.findByIdAndUpdate = update;
      Activity.deleteOne = deleteOne;
    }
    assert.equal(await Job.countDocuments({ company: 'Orphan Two' }), 0);
    assert.equal(await Activity.countDocuments({ 'job.company': 'Orphan Two' }), 0, 'no record of a job that is not there');
    assert.equal((await get('performance?days=1')).rows.filter((r) => r.value === '98450 77777').length, 0);
  } finally {
    Job.aggregate = aggregate;
    console.error = consoleError;
  }
});

test('"Listed on 2+ sites": "Added by team" is not a job site', async () => {
  const at = new Date();
  const doc = (n, platforms, extra = {}) => ({
    fingerprint: `sites${n}`, title: `Sites Analyst ${n}`, company: `Sites Co ${n}`, course: 'data-analyst', cities: ['Pune'],
    firstSeenAt: at, lastSeenAt: at, primaryPlatform: platforms[0], platforms, sourceKeys: [`SITES:${n}`], ...extra,
  });
  const addedBy = { addedBy: { userId: 'user_riya', email: 'riya@example.com', name: 'Riya', at } };
  const [oneSite, twoSites, scraped] = await Job.create([
    doc(1, [TEAM_PLATFORM, 'LinkedIn'], addedBy), // added by hand, then a collection found it on LinkedIn
    doc(2, [TEAM_PLATFORM, 'LinkedIn', 'Naukri'], addedBy), // ... on LinkedIn and Naukri
    doc(3, ['Naukri', 'Indeed']),
  ]);
  const listed = await get('jobs?days=1&sites=2&limit=100');
  const ids = listed.items.map((j) => j._id);
  assert.ok(!ids.includes(String(oneSite._id)), 'on one job site');
  assert.ok(ids.includes(String(twoSites._id)) && ids.includes(String(scraped._id)), 'on two job sites');
  assert.equal((await get('platforms?days=1')).multiPlatform, listed.total, 'the number and its list agree');
  assert.equal((await get('course/data-analyst?days=1')).multiPlatform, (await get('jobs?days=1&sites=2&course=data-analyst')).total);
  // With a search too (each its own "or").
  const searched = await get(`jobs?days=1&sites=2&q=${encodeURIComponent('Sites Co')}`);
  assert.deepEqual(searched.items.map((j) => j._id).sort(), [String(twoSites._id), String(scraped._id)].sort());
  assert.equal((await get(`jobs?days=1&q=${encodeURIComponent('Sites Co')}`)).total, 3);
  await Job.deleteMany({ _id: { $in: [oneSite._id, twoSites._id, scraped._id] } });
});

test('the check: course, site, where it goes, the company, and the same posting or opening stored already', async () => {
  const empty = await check({});
  assert.deepEqual(empty, {
    course: null, site: null, set: 'filtered', leftOutBy: null, experience: null, experienceUnreadable: false, knownCompany: false, duplicate: null, similar: [],
  });

  const same = await check({ company: 'Tekion Corp', title: 'Data Analyst I', url: TEKION_LINK, experience: '3-5 years', location: 'Bengaluru' });
  assert.equal(same.course, 'data-analyst');
  assert.equal(same.site, 'LinkedIn');
  assert.deepEqual([same.set, same.leftOutBy, same.experience, same.experienceUnreadable, same.knownCompany], ['filtered', null, { min: 3, max: 5 }, false, true]);
  assert.deepEqual({ ...same.duplicate, firstSeenAt: undefined }, {
    _id: String(tekion._id), set: 'filtered', title: 'Data Analyst I', company: 'Tekion Corp', cities: ['Bengaluru'], firstSeenAt: undefined,
  });
  assert.deepEqual(same.similar, [], 'never the duplicate');

  // The same company's same title (words in another order), under another link.
  const other = await check({ company: 'TEKION CORP.', title: 'analyst data i', url: 'https://careers.tekion.com/jobs/5' });
  assert.equal(other.duplicate, null);
  assert.equal(other.site, null);
  assert.deepEqual(other.similar.map((s) => s._id), [String(tekion._id)]);
  // A job added by hand is found the same way, with who added it.
  const nimbus = await check({ company: 'Nimbus Data Labs', title: 'Data Analyst (SQL, Power BI)' });
  assert.equal(nimbus.similar.length, 1);
  assert.equal(nimbus.similar[0].addedBy.email, TESTER.email);
  assert.deepEqual((await check({ company: 'Nimbus Data Labs', title: 'Senior Data Analyst' })).similar, [], 'another title');

  const big = await check({ company: 'Oracle India Pvt Ltd', title: 'Data Engineer' });
  assert.deepEqual([big.course, big.set, big.leftOutBy, big.knownCompany], ['data-engineering', 'nonfiltered', 'big-company', true]);
  const senior = await check({ experience: '6+ years' });
  assert.deepEqual([senior.set, senior.leftOutBy, senior.experience], ['nonfiltered', 'senior', { min: 6, max: null }]);
  const unreadable = await check({ experience: 'a few' });
  assert.deepEqual([unreadable.experience, unreadable.experienceUnreadable, unreadable.set], [null, true, 'filtered']);
  assert.equal((await check({ company: 'Brand New Co' })).knownCompany, false);
  assert.equal((await check({ url: 'https://www.naukri.com/job-listings-x-031126021521' })).duplicate.set, 'nonfiltered');
  assert.equal((await check({ title: 'Office Coordinator' })).course, null);
});

test('sign-in is needed; the activity record can list only the jobs added by hand', async () => {
  assert.equal((await add(job({ company: 'Nobody Co', url: 'https://nobody.co/1' }), 'signed-out')).status, 401);
  assert.equal((await fetch(`${base}/added-jobs/check?company=x`, { headers: { Authorization: 'Bearer signed-out' } })).status, 401);
  assert.equal((await send(`added-jobs/${tekion._id}`, 'DELETE', null, 'signed-out')).status, 401);
  assert.equal((await add(job({ company: 'Nobody Co', url: 'https://nobody.co/1' }), 'INTERN:intern@example.com')).status, 403, 'no allowed role');
  // Every role may add jobs; a role without the permission would be told so.
  assert.ok(ROLES.every((role) => can(role, 'add-jobs')));
  const research = PERMISSIONS.RESEARCH_TEAM;
  PERMISSIONS.RESEARCH_TEAM = research.filter((p) => p !== 'add-jobs');
  try {
    const refused = await add(job({ company: 'Nobody Co', url: 'https://nobody.co/1' }), 'RESEARCH_TEAM:aman@example.com');
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, "Your role can't add jobs.");
  } finally {
    PERMISSIONS.RESEARCH_TEAM = research;
  }
  assert.equal(await Job.countDocuments({ company: 'Nobody Co' }), 0);

  // A usual HR details save is not a new job.
  assert.equal((await send(`jobs/${omega._id}/follow-up`, 'PUT', { phone: ['90909 09090'], remarks: 'Called', foundBy: 'apollo' })).status, 200);
  const all = await get('activity');
  const newJobs = await get('activity?action=new-job');
  assert.ok(newJobs.total > 0 && newJobs.total < all.total);
  assert.equal(newJobs.total, await Activity.countDocuments({ newJob: { $exists: true } }));
  assert.ok(newJobs.items.every((r) => r.newJob?.url));
});

test('removing a job added by hand: by who added it or an admin, only while no site has it', async () => {
  const riya = 'PLACEMENT_STAFF:riya@example.com';
  const addAs = async (company, token) => (await (await add(job({ company, url: `https://${company.toLowerCase().replace(/\W/g, '')}.in/jobs/1` }), token)).json()).job;
  const remove = (id, token) => send(`added-jobs/${id}`, 'DELETE', null, token);

  const mine = await addAs('Riya One', riya);
  assert.equal(mine.addedBy.email, 'riya@example.com');
  const other = await remove(mine._id, 'RESEARCH_TEAM:aman@example.com');
  assert.equal(other.status, 403);
  assert.equal((await other.json()).error, 'Only the person who added this job, or an admin, can remove it.');
  assert.equal((await remove(mine._id, 'PLACEMENT_STAFF:Riya@Example.com')).status, 204, 'the same email in any case');
  assert.equal(await Job.exists({ _id: mine._id }), null);
  assert.deepEqual((await get(`jobs?id=${mine._id}`)).items, []);
  const record = await Activity.findOne({ 'job.id': mine._id, action: 'removed' }).lean();
  assert.deepEqual(
    [record.actor.email, record.job.set, record.job.company, record.changes, record.removedJob.url],
    ['Riya@Example.com', 'filtered', 'Riya One', [], 'https://riyaone.in/jobs/1'],
  );

  const second = await addAs('Riya Two', riya);
  assert.equal((await remove(second._id)).status, 204, 'an admin may');

  // Once the collector has found it too, it stays.
  const third = await addAs('Riya Three', riya);
  await Job.updateOne({ _id: third._id }, { $push: { platforms: 'Naukri' } });
  const found = await remove(third._id, riya);
  assert.equal(found.status, 409);
  assert.equal((await found.json()).error, 'The scraper has found this job too, so it stays on the dashboard.');
  assert.ok(await Job.exists({ _id: third._id }));

  const scraped = await remove(tekion._id);
  assert.equal(scraped.status, 400);
  assert.equal((await scraped.json()).error, 'Only jobs added by the team can be removed here.');
  assert.equal((await remove('0123456789abcdef01234567')).status, 404);
  assert.equal((await remove('nope')).status, 404);
  assert.equal(await Activity.countDocuments({ action: 'removed' }), 2, 'only the removals that happened are recorded');

  // The CSV says who added it by name; one without a name is "Team member", never their email.
  const csv = await (await fetch(`${base}/jobs.csv?days=1&company=${encodeURIComponent('Riya Three')}`)).text();
  assert.match(csv.split('\r\n')[1], /,Team member,/);
  assert.equal(csv.includes('riya@example.com'), false);

  // IJF AI's look-up of the activity record tells a job added or removed by hand from HR details.
  const ctx = { tools: [], cards: [] };
  const added = await runTool({ name: 'get_activity', arguments: JSON.stringify({ action: 'new-job', q: 'Riya One', limit: 20 }) }, ctx);
  assert.deepEqual(added.items.map((i) => [i.action, i.jobAddedByHand]), [['added', { link: 'https://riyaone.in/jobs/1', newCompany: true }]]);
  const both = await runTool({ name: 'get_activity', arguments: JSON.stringify({ q: 'Riya One', limit: 20 }) }, ctx);
  assert.deepEqual(both.items.map((i) => [i.action, i.jobAddedByHandRemoved ?? null]), [['removed', { link: 'https://riyaone.in/jobs/1' }], ['added', null]]);
  const plain = await runTool({ name: 'get_activity', arguments: JSON.stringify({ q: 'Omega Corp', limit: 20 }) }, ctx);
  assert.ok(plain.items.length && plain.items.every((i) => !('jobAddedByHand' in i) && !('jobAddedByHandRemoved' in i)), 'only on those records');
});

test('IJF AI knows the Jobs added by the team page, which lists both sets', () => {
  const page = describePage({ path: '/added-jobs', period: { days: 7 }, view: 'filtered' });
  assert.match(page, /^the Jobs added by the team page /);
  assert.match(page, /, showing the last 7 days$/, 'no Filtered view: the page lists both sets');
  assert.match(describePage({ path: '/added-jobs', period: { days: 1 } }), /, showing today$/, 'its days end today');
  assert.match(describePage({ path: '/dashboard', period: { days: 1 } }), /, showing the latest day, Filtered view$/, 'other pages as before');
});
