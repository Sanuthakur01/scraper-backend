// The course page's numbers must agree with the dashboard tile and add up.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { config } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { Activity, CollectorRun, ContactOutcome, Job, NonFilteredJob } from '../src/models.js';
import { parseFollowUpInput } from '../src/api/followUp.js';
import { REMARKS, remarkLabel, remarkOf } from '../src/outcomes.js';
import { COURSES } from '../src/config/courses.js';
import { SKILL_NAMES } from '../src/normalize.js';
import { AuthError, createClerkIdentify } from '../src/auth.js';
import { roleFrom } from '../src/config/access.js';

// Stand-in for the Clerk sign-in check (src/auth.js), so tests never call Clerk: no Authorization
// header is a signed-in admin; "Bearer <role>:<email>" signs in that person; "Bearer expired" is refused.
const TESTER = { userId: 'user_tester', email: 'tester@example.com', name: 'Test Admin', role: 'ADMIN' };
async function fakeIdentify(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!token) return TESTER;
  if (token === 'expired') throw new AuthError(401, 'Your sign-in has expired. Reload the page, then try again.');
  const [role, email] = token.split(':');
  return { userId: `user_${email}`, email, name: '', role: roleFrom({ role }) };
}

const HOUR = 3_600_000;
let mongo;
let server;
let base;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  await Promise.all([Job.init(), NonFilteredJob.init()]);
  const now = Date.now();
  await CollectorRun.create({ startedAt: new Date(now), finishedAt: new Date(now), status: 'success' });
  const job = (n, extra) => ({
    fingerprint: `f${n}`,
    title: `Data Analyst ${n}`,
    company: `Company ${n}`,
    course: 'data-analyst',
    cities: ['Pune'],
    firstSeenAt: new Date(now - HOUR),
    lastSeenAt: new Date(now - HOUR),
    sourceKeys: [`X:${n}`],
    ...extra,
  });
  await Job.create([
    job(1, { primaryPlatform: 'LinkedIn', platforms: ['LinkedIn'], postedAt: new Date(now - 3 * HOUR), experienceMin: 2, experienceBand: '2', salaryText: '₹5L' }),
    job(2, { primaryPlatform: 'Naukri', platforms: ['Naukri', 'Indeed'], postedAt: new Date(now - 50 * HOUR), experienceMin: 4, experienceBand: '4', salaryText: 'Not Disclosed', foundPhones: ['+91 98450 12345'], foundEmails: ['careers@company2.in'] }),
    job(3, { primaryPlatform: 'Naukri', platforms: ['Naukri'], postedAt: null, experienceMin: 2, experienceBand: '2', cities: ['India (city not stated)'], isRemote: true }),
    job(4, { course: 'data-science', primaryPlatform: 'Indeed', platforms: ['Indeed'], postedAt: new Date(now - 2 * HOUR) }),
  ]);
  server = createApp({ identify: fakeIdentify }).listen(0);
  base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server.close();
  await disconnectDb();
  await mongo.stop();
});

test('the course page total equals the dashboard tile, and every breakdown adds up', async () => {
  const summary = await (await fetch(`${base}/summary?days=1`)).json();
  const course = await (await fetch(`${base}/course/data-analyst?days=1`)).json();

  assert.equal(course.total, summary.current['data-analyst']);
  assert.equal(course.total, 3, 'only Data Analyst jobs');
  const sum = (values) => values.reduce((a, b) => a + b, 0);
  assert.equal(sum(course.platforms.map((p) => p.counted)), course.total, 'platform rows add up to the total');
  assert.equal(sum(Object.values(course.postingAge)), course.total, 'posting-age buckets add up to the total');

  assert.deepEqual(course.postingAge, { day: 1, '3days': 1, unknown: 1 });
  const naukri = course.platforms.find((p) => p.platform === 'Naukri');
  assert.deepEqual([naukri.counted, naukri.listed], [2, 2]);
  assert.equal(course.platforms.find((p) => p.platform === 'Indeed').listed, 1, 'listed there, though counted under Naukri');
  assert.equal(course.multiPlatform, 1);
  assert.deepEqual(course.experience, { 2: 2, 4: 1 }, 'jobs per year of experience asked');
  assert.equal(course.salaryShown, 1, '"Not Disclosed" is not a salary');
  assert.equal(course.freshness.storedTotal, 3);
});

test('each course page card opens a job list holding exactly the jobs it counts', async () => {
  const course = await (await fetch(`${base}/course/data-analyst?days=1`)).json();
  const list = async (params) => (await fetch(`${base}/jobs?course=data-analyst&days=1&limit=100&${params}`)).json();

  assert.equal((await list('')).total, course.total, 'New jobs');

  const several = await list('sites=2');
  assert.equal(several.total, course.multiPlatform, 'Listed on 2+ sites');
  assert.ok(several.total > 0 && several.total < course.total, 'the test data has some such jobs, not all');
  assert.ok(several.items.every((job) => job.platforms.length >= 2));

  const salary = await list('salary=shown');
  assert.equal(salary.total, course.salaryShown, 'Salary shown');
  assert.ok(salary.total > 0 && salary.total < course.total);
  assert.ok(salary.items.every((job) => job.salaryText && !/not disclosed/i.test(job.salaryText)), '"Not Disclosed" is not a salary');

  for (const [band, count] of Object.entries(course.experience)) {
    assert.equal((await list(`exp=${band}`)).total, count, `${band} years' experience`);
  }
});

test('an unknown course gives a clear 404', async () => {
  const res = await fetch(`${base}/course/astrology`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Unknown course/);
});

test('HR phone, email and remarks can be typed in for a job, and are shown instead of what the posting says', async () => {
  const [job1, job2] = await Promise.all([Job.findOne({ fingerprint: 'f1' }).lean(), Job.findOne({ fingerprint: 'f2' }).lean()]);
  const put = (id, body) =>
    fetch(`${base}/jobs/${id}/follow-up`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rows = async () => Object.fromEntries((await (await fetch(`${base}/jobs?days=1`)).json()).items.map((j) => [j._id, j.contact]));

  let contact = (await rows())[job2._id];
  assert.deepEqual([contact.phone, contact.phoneSource, contact.email, contact.emailSource], ['+91 98450 12345', 'posting', 'careers@company2.in', 'posting']);
  contact = (await rows())[job1._id];
  assert.deepEqual([contact.phone, contact.phoneSource], ['', null]);

  const bad = await put(job1._id, { phone: '98765', email: 'hr@company', remarks: '' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /^Phone:/);
  assert.match((await (await put(job1._id, { email: 'hr at company.com' })).json()).error, /^Email:/);

  const saved = await put(job1._id, { phone: ' 98765  43210 ', email: 'hr@company1.com, anil@company1.com', remarks: 'Called; send CVs Monday' });
  assert.equal(saved.status, 200);
  const row = await saved.json();
  assert.deepEqual(
    [row.contact.phone, row.contact.phoneSource, row.contact.email, row.contact.remarks],
    ['98765 43210', 'manual', 'hr@company1.com, anil@company1.com', 'Called; send CVs Monday'],
  );
  assert.ok(row.contact.updatedAt);
  assert.equal(row.title, 'Data Analyst 1', 'the whole row comes back');
  assert.equal((await rows())[job1._id].phone, '98765 43210', 'saved in the database');

  // Typed in for job 2: it replaces the posting's phone; the posting's email still shows.
  contact = (await (await put(job2._id, { phone: '+91 70000 12345' })).json()).contact;
  assert.deepEqual([contact.phone, contact.phoneSource, contact.email, contact.emailSource], ['+91 70000 12345', 'manual', 'careers@company2.in', 'posting']);

  const csv = await (await fetch(`${base}/jobs.csv?days=1`)).text();
  assert.match(csv.split('\r\n')[0], /Listed on,HR name,HR profile,Phone,Email,Assigned to,Remarks,/);
  assert.match(csv, /98765 43210,"hr@company1.com, anil@company1.com",,Called; send CVs Monday/);

  // Clearing everything removes the typed-in details.
  contact = (await (await put(job1._id, { phone: '', email: '', remarks: '' })).json()).contact;
  assert.deepEqual([contact.phone, contact.email, contact.remarks, contact.updatedAt], ['', '', '', null]);
  assert.equal((await Job.findById(job1._id).lean()).manual, undefined);

  assert.equal((await put('not-an-id', {})).status, 404);
  assert.equal((await put('0123456789abcdef01234567', { phone: '9876543210' })).status, 404);
  const broken = await fetch(`${base}/jobs/${job1._id}/follow-up`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(broken.status, 400, 'unreadable JSON is a bad request, not a server error');
});

test('a phone number already on another job is refused with "This number already exists."', async () => {
  const [job1, job2, job3] = await Promise.all(['f1', 'f2', 'f3'].map((f) => Job.findOne({ fingerprint: f }).lean()));
  const put = (id, body) =>
    fetch(`${base}/jobs/${id}/follow-up`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // Job 2: +91 70000 12345 typed in; its posting says +91 98450 12345.
  assert.equal((await put(job2._id, { phone: '+91 70000 12345' })).status, 200);

  let res = await put(job1._id, { phone: '070000-12345', remarks: 'x' });
  assert.equal(res.status, 409, 'the same number, written differently');
  assert.deepEqual(await res.json(), {
    error: 'This number already exists.',
    detail: '070000-12345 is already saved on "Data Analyst 2" at Company 2.',
  });
  res = await put(job1._id, { phone: '91234 56780, 9845012345' });
  assert.equal(res.status, 409, "a number found in another job's posting counts too");
  assert.match((await res.json()).detail, /^9845012345 is already saved on "Data Analyst 2"/);
  assert.equal((await Job.findById(job1._id).lean()).manual, undefined, 'nothing was saved');

  // A job may save its own numbers again, e.g. when only the remarks change.
  res = await put(job2._id, { phone: '+91 70000 12345, 98450 12345', remarks: 'Updated' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).contact.remarks, 'Updated');

  // A new number is accepted, and is then taken; once cleared it is free again.
  assert.equal((await put(job1._id, { phone: '91234 56780' })).status, 200);
  assert.equal((await put(job3._id, { phone: '+91 91234 56780' })).status, 409);
  assert.equal((await put(job1._id, { phone: '' })).status, 200);
  assert.equal((await put(job3._id, { phone: '+91 91234 56780' })).status, 200);
});

test('the same number typed twice in one entry is kept once', () => {
  assert.deepEqual(parseFollowUpInput({ phone: '98450 12345, +91 98450-12345, 080 4123 4567' }).value.phone, '98450 12345, 080 4123 4567');
  assert.deepEqual(parseFollowUpInput({ phone: '98450 12345' }).value.phoneKeys, ['9845012345']);
});

test('several phone numbers and emails, one per box: up to 10 each, kept once, a wrong one named', () => {
  const ok = parseFollowUpInput({
    phone: ['98450 12345', '', ' 080 4123 4567 ', '+91 98450-12345'],
    email: ['hr@acme.in', 'HR@acme.in', 'anil@acme.in', ''],
  }).value;
  assert.equal(ok.phone, '98450 12345, 080 4123 4567', 'empty boxes are ignored, the same number twice kept once');
  assert.deepEqual(ok.phoneKeys, ['9845012345', '8041234567']);
  assert.equal(ok.email, 'hr@acme.in, anil@acme.in', 'the same address in other capitals is kept once');

  assert.equal(parseFollowUpInput({ phone: ['98450 12345', '12345'] }).error, 'Phone: "12345" is not a phone number. Enter it like 98765 43210.');
  assert.equal(parseFollowUpInput({ email: ['hr@acme.in', 'hr at acme.in'] }).error, 'Email: "hr at acme.in" is not an email address. Enter it like hr@company.com.');
  assert.equal(parseFollowUpInput({ email: 'a@acme.in b@acme.in' }).value.email, 'a@acme.in, b@acme.in', 'pasted with spaces');

  const eleven = Array.from({ length: 11 }, (_, i) => `90000 000${String(i + 10)}`);
  assert.equal(parseFollowUpInput({ phone: eleven.slice(0, 10) }).value.phoneKeys.length, 10);
  assert.equal(parseFollowUpInput({ phone: eleven }).error, 'Phone: at most 10 numbers per job.');
  assert.equal(parseFollowUpInput({ email: eleven.slice(0, 10).map((_, i) => `hr${i}@acme.in`) }).value.email.split(', ').length, 10);
  assert.equal(parseFollowUpInput({ email: eleven.map((_, i) => `hr${i}@acme.in`) }).error, 'Email: at most 10 addresses per job.');
});

test('a job can be assigned to several students: saved, shown, searched, in the CSV, not counted as HR details', async () => {
  const parsed = parseFollowUpInput({ assignedTo: ['Riya Sharma', '', ' Aman  Gupta ', 'riya sharma'] }).value;
  assert.deepEqual(parsed.assignedTo, ['Riya Sharma', 'Aman Gupta'], 'trimmed, empty boxes ignored, each name once');
  assert.match(parseFollowUpInput({ assignedTo: ['x'.repeat(61)] }).error, /^Assign to: ".*" is too long for a name/);
  assert.equal(parseFollowUpInput({ assignedTo: Array.from({ length: 21 }, (_, i) => `Student ${i}`) }).error, 'Assign to: at most 20 students per job.');

  const job1 = await Job.findOne({ fingerprint: 'f1' }).lean();
  const put = (body) =>
    fetch(`${base}/jobs/${job1._id}/follow-up`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const list = async (q = '') => (await fetch(`${base}/jobs?days=1&limit=100${q}`)).json();
  const before = (await list()).withContact;

  const saved = await put({ phone: [], email: [], remarks: '', assignedTo: ['Riya Sharma', 'Aman Gupta'] });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).contact.assignedTo, ['Riya Sharma', 'Aman Gupta']);
  assert.deepEqual((await Job.findById(job1._id).lean()).manual.assignedTo, ['Riya Sharma', 'Aman Gupta'], 'stored');
  assert.equal((await list()).withContact, before, 'students alone are not HR details');

  const found = await list('&q=aman');
  assert.deepEqual(found.items.map((j) => j.title), ['Data Analyst 1'], "searching a student's name finds the jobs assigned to them");

  const csv = await (await fetch(`${base}/jobs.csv?days=1`)).text();
  assert.match(csv.split('\r\n')[0], /Phone,Email,Assigned to,Remarks/);
  assert.match(csv, /Riya Sharma; Aman Gupta/);

  // Other details saved later keep the students only if they are sent again (the dashboard always sends them).
  await put({ phone: [], email: [], remarks: 'Called', assignedTo: ['Riya Sharma'] });
  assert.deepEqual((await Job.findById(job1._id).lean()).manual.assignedTo, ['Riya Sharma']);
  assert.equal((await list()).withContact, before + 1, 'a note counts');

  await put({ phone: [], email: [], remarks: '', assignedTo: [] });
  assert.equal((await Job.findById(job1._id).lean()).manual, undefined, 'nothing left: removed');
});

test('HR names and profile links: checked, saved, shown, searched, in the CSV and the activity record, counted as HR details', async () => {
  // Checked: names once each; links are web addresses ("https://" added), each page once.
  const parsed = parseFollowUpInput({
    hrName: ['Riya Sharma', '', ' riya  sharma ', 'Anil Kumar'],
    hrProfile: ['linkedin.com/in/riya-sharma', 'https://www.linkedin.com/in/riya-sharma/', 'https://naukri.com/recruiters/anil'],
  }).value;
  assert.deepEqual(parsed.hrNames, ['Riya Sharma', 'Anil Kumar']);
  assert.deepEqual(parsed.hrProfiles, ['https://linkedin.com/in/riya-sharma', 'https://naukri.com/recruiters/anil']);
  for (const bad of ['javascript:alert(1)', 'mailto:hr@acme.in', 'riya', 'https://user:pass@acme.in']) {
    assert.match(parseFollowUpInput({ hrProfile: [bad] }).error, /^HR profile: ".*" is not a web link/, bad);
  }
  assert.match(parseFollowUpInput({ hrName: ['x'.repeat(81)] }).error, /^HR name: ".*" is too long/);
  assert.equal(parseFollowUpInput({ hrName: Array.from({ length: 11 }, (_, i) => `HR ${i}`) }).error, 'HR name: at most 10 names per job.');
  assert.equal(parseFollowUpInput({ hrProfile: Array.from({ length: 11 }, (_, i) => `acme.in/hr/${i}`) }).error, 'HR profile: at most 10 links per job.');

  const job1 = await Job.findOne({ fingerprint: 'f1' }).lean();
  await putAs(job1._id, empty);
  const list = async (q = '') => (await fetch(`${base}/jobs?days=1&limit=100${q}`)).json();
  const before = (await list()).withContact;

  const res = await putAs(job1._id, { ...empty, hrName: ['Riya Sharma'], hrProfile: ['linkedin.com/in/riya-sharma'] }, 'RESEARCH_TEAM:asha@example.com');
  assert.equal(res.status, 200);
  const { contact } = await res.json();
  assert.deepEqual([contact.hrNames, contact.hrProfiles], [['Riya Sharma'], ['https://linkedin.com/in/riya-sharma']]);
  assert.deepEqual((await Job.findById(job1._id).lean()).manual.hrNames, ['Riya Sharma'], 'stored');
  assert.equal((await list()).withContact, before + 1, 'an HR name or profile counts as HR details');
  assert.deepEqual((await list('&q=riya%20sharma')).items.map((j) => j.title), ['Data Analyst 1'], "an HR person's name finds their jobs");

  const csv = await (await fetch(`${base}/jobs.csv?days=1&q=riya`)).text();
  assert.match(csv.split('\r\n')[1], /,Riya Sharma,https:\/\/linkedin\.com\/in\/riya-sharma,/);

  const [entry] = await Activity.find().sort({ at: -1 }).limit(1).lean();
  assert.deepEqual(entry.changes.map((c) => [c.field, c.change, c.added]), [['hrName', 'added', ['Riya Sharma']], ['hrProfile', 'added', ['https://linkedin.com/in/riya-sharma']]]);
  const perf = await (await fetch(`${base}/performance?days=1`)).json();
  assert.ok(perf.rows.every((r) => r.field === 'phone' || r.field === 'email'), 'the performance report counts phone numbers and emails only');

  // Not sent again: removed (the dashboard always sends every field).
  await putAs(job1._id, { ...empty, remarks: 'Called' });
  assert.equal((await Job.findById(job1._id).lean()).manual.hrNames, undefined);
  await putAs(job1._id, empty);
});

test('a second number already on another job is refused, naming that number', async () => {
  const [job1, job2] = await Promise.all(['f1', 'f2'].map((f) => Job.findOne({ fingerprint: f }).lean()));
  const put = (id, body) =>
    fetch(`${base}/jobs/${id}/follow-up`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put(job2._id, { phone: ['+91 70000 12345'] })).status, 200);
  const res = await put(job1._id, { phone: ['93333 44444', '70000 12345'] });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'This number already exists.', detail: '70000 12345 is already saved on "Data Analyst 2" at Company 2.' });

  const saved = await put(job1._id, { phone: ['93333 44444', '93333 55555'], email: ['hr@company1.com', 'anil@company1.com'] });
  assert.equal(saved.status, 200);
  assert.deepEqual([(await saved.json()).contact.phone, (await Job.findById(job1._id).lean()).manual.phoneKeys], ['93333 44444, 93333 55555', ['9333344444', '9333355555']]);
  assert.equal((await put(job2._id, { phone: ['+91 70000 12345', '93333 55555'] })).status, 409, 'each saved number is taken');
  await Promise.all([put(job1._id, { phone: [], email: [] }), put(job2._id, { phone: [] })]);
});

test('skill gaps: counted from the period\'s postings against what the course teaches, with the source', async () => {
  const now = Date.now();
  const support = (n, skills) => ({
    fingerprint: `ps${n}`, title: `Production Support Engineer ${n}`, company: `Support Co ${n}`, course: 'production-support',
    cities: ['Chennai'], firstSeenAt: new Date(now - 2 * HOUR), lastSeenAt: new Date(now - 2 * HOUR), sourceKeys: [`PS:${n}`],
    primaryPlatform: 'Naukri', platforms: ['Naukri'], skills,
  });
  await Job.create([
    support(1, ['Linux/Unix', 'SQL']), // all taught
    support(2, ['Linux/Unix', 'Splunk']), // only Splunk missing
    support(3, ['SQL', 'Splunk', 'Kafka']), // two missing
    support(4, []), // names no skill
  ]);

  const gaps = await (await fetch(`${base}/skill-gaps?course=production-support&days=1`)).json();
  const course = COURSES.find((c) => c.id === 'production-support');
  assert.deepEqual(gaps.teaches, course.teaches);
  assert.deepEqual([gaps.postings, gaps.named, gaps.coveredNow], [4, 3, 1]);
  assert.deepEqual(gaps.skills, [
    { skill: 'Splunk', asking: 2, gained: 1, coveredAfter: 2 },
    { skill: 'Kafka', asking: 1, gained: 0, coveredAfter: 1 },
  ]);
  assert.deepEqual(gaps.source.platforms, ['Naukri']);
  assert.ok(gaps.source.lastRefreshed && gaps.source.firstSeenFrom && gaps.trackedSkillCount > 40);
  assert.equal((await fetch(`${base}/skill-gaps?course=nope`)).status, 404);
});

test('every skill a course teaches is one the collector looks for', () => {
  for (const course of COURSES) {
    assert.deepEqual(course.teaches.filter((s) => !SKILL_NAMES.includes(s)), [], course.id);
  }
});

const putFollowUp = (id, body) =>
  fetch(`${base}/jobs/${id}/follow-up`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('the 7-day comparison appears only once every day of both weeks was collected', async () => {
  const now = Date.now();
  const acme = (n, company) => ({
    fingerprint: `acme${n}`, title: `BI Analyst ${n}`, company, course: 'data-analyst', cities: n === 1 ? ['Pune'] : ['India (city not stated)'],
    firstSeenAt: new Date(now - 3 * HOUR), lastSeenAt: new Date(now - 3 * HOUR), sourceKeys: [`AC:${n}`],
    primaryPlatform: 'LinkedIn', platforms: ['LinkedIn'], skills: ['SQL', 'Power BI'],
  });
  // One employer spelled two ways (the hiring partners test below counts them as one).
  await Job.create([acme(1, 'Acme Analytics Pvt Ltd'), acme(2, 'Acme Analytics')]);
  const week = async () => (await fetch(`${base}/summary?days=7`)).json();

  let summary = await week();
  assert.equal(summary.comparable, false, 'collection started inside the earlier week');
  assert.deepEqual(summary.previous, {});

  // Daily collection began 20 days ago, with a run every day of the last two weeks.
  await CollectorRun.create({ startedAt: new Date(now - 20 * 24 * HOUR), finishedAt: new Date(now - 20 * 24 * HOUR), status: 'success' });
  summary = await week();
  assert.equal(summary.comparable, false, 'one early run is not daily collection');
  await CollectorRun.create(
    Array.from({ length: 14 }, (_, k) => ({ startedAt: new Date(now - k * 24 * HOUR), finishedAt: new Date(now - k * 24 * HOUR), status: 'success' })),
  );
  summary = await week();
  assert.equal(summary.comparable, true);
});

test('hiring partners: employers with 2+ openings and their HR contacts', async () => {
  const acme = await Job.findOne({ fingerprint: 'acme1' }).lean();
  assert.equal((await putFollowUp(acme._id, { phone: '91234 00001', email: 'hr@acme.in' })).status, 200);
  await Job.updateOne({ fingerprint: 'acme2' }, { $set: { foundEmails: ['careers@acme.in'] } });

  const list = await (await fetch(`${base}/partners`)).json();
  assert.equal(list.minOpenings, 2);
  assert.deepEqual(list.partners.map((p) => p.name), ['Acme Analytics'], 'one-off employers are not listed');
  const [partner] = list.partners;
  assert.equal(partner.openings, 2);
  assert.equal(partner.courses['data-analyst'], 2);
  assert.deepEqual(partner.cities, ['Pune']);
  assert.deepEqual(partner.phones, ['91234 00001']);
  assert.deepEqual(partner.emails, ['hr@acme.in', 'careers@acme.in'], 'typed in first, then found in postings');

  const csv = await (await fetch(`${base}/partners.csv`)).text();
  assert.match(csv.split('\r\n')[0], /^\uFEFF?Company,Openings,Data Analyst,.*,HR phones,HR emails$/);
  assert.match(csv, /Acme Analytics,2,2,0,0,0,Pune,\d{4}-\d\d-\d\d,91234 00001,hr@acme.in; careers@acme.in\r?$/m);
});

test('a dashboard hosted elsewhere can use the API only if its address is in CORS_ORIGINS', async () => {
  const dashboard = 'https://dash.example.com';
  const plain = await fetch(`${base}/meta`, { headers: { Origin: dashboard } });
  assert.equal(plain.headers.get('access-control-allow-origin'), null, 'not allowed unless configured');

  const saved = config.corsOrigins;
  config.corsOrigins = [dashboard];
  const server2 = createApp({ identify: fakeIdentify }).listen(0);
  try {
    const api = `http://localhost:${server2.address().port}/api`;
    const preflight = await fetch(`${api}/jobs/0123456789abcdef01234567/follow-up`, {
      method: 'OPTIONS',
      headers: { Origin: dashboard, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), dashboard);
    assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
    assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/, 'deleting an IJF AI chat');
    assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/i);

    const read = await fetch(`${api}/meta`, { headers: { Origin: dashboard } });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('access-control-allow-origin'), dashboard);
    const stranger = await fetch(`${api}/meta`, { headers: { Origin: 'https://someone-else.example' } });
    assert.equal(stranger.headers.get('access-control-allow-origin'), null, 'other sites are not allowed');
  } finally {
    server2.close();
    config.corsOrigins = saved;
  }
});

test('dashboard pages answer GET and HEAD, with or without a trailing slash', async () => {
  // A stand-in for the built dashboard: the build has a folder named like each page (performance/),
  // which must not hide the page itself (performance.html). The dashboard's links send HEAD
  // /performance/ before prefetching a page.
  const root = await mkdtemp(path.join(os.tmpdir(), 'ijf-out-'));
  const out = path.join(root, 'client', 'out');
  await mkdir(path.join(out, 'performance'), { recursive: true });
  await writeFile(path.join(out, 'performance.html'), '<p>performance</p>');
  await writeFile(path.join(out, 'index.html'), '<p>home</p>');
  const saved = config.rootDir;
  config.rootDir = root;
  const server2 = createApp({ identify: fakeIdentify }).listen(0);
  try {
    const site = `http://localhost:${server2.address().port}`;
    for (const url of ['/performance', '/performance/']) {
      const page = await fetch(site + url);
      assert.equal(page.status, 200, `GET ${url}`);
      assert.equal(await page.text(), '<p>performance</p>');
      assert.equal((await fetch(site + url, { method: 'HEAD' })).status, 200, `HEAD ${url}`);
    }
    assert.equal((await fetch(`${site}/no-such-page`, { method: 'HEAD' })).status, 200, 'other addresses get the dashboard, as with GET');
  } finally {
    server2.close();
    config.rootDir = saved;
    await rm(root, { recursive: true, force: true });
  }
});

test('periods are compared only when collected every day; backfilled days are marked', async () => {
  const now = Date.now();
  const DAY = 24 * HOUR;
  // A 30-day backfill that ran long ago doesn't count as daily collection.
  await CollectorRun.create({ startedAt: new Date(now - 90 * DAY), finishedAt: new Date(now - 90 * DAY), status: 'success', lookbackDays: 30 });
  await Job.create({
    fingerprint: 'backfilled-1', title: 'ML Engineer', company: 'Old Co', course: 'data-science', firstSeenAt: new Date(now - 25 * DAY),
    lastSeenAt: new Date(now - 25 * DAY), primaryPlatform: 'Naukri', platforms: ['Naukri'], sourceKeys: ['BF:old1'],
  });

  // Daily collection began 20 days ago and ran every day of the last two weeks (an earlier test's
  // runs): 7 days vs the 7 before is comparable, 30 days vs the 30 before is not, even though the
  // backfill has jobs from then.
  const week = await (await fetch(`${base}/summary?days=7`)).json();
  assert.equal(week.comparable, true);
  const month = await (await fetch(`${base}/summary?days=30`)).json();
  assert.equal(month.comparable, false);
  assert.deepEqual(month.previous, {});
  const course = await (await fetch(`${base}/course/data-science?days=30`)).json();
  assert.equal(course.previous, 0, 'the course page does not compare either');

  const trends = await (await fetch(`${base}/trends?days=30`)).json();
  const dailyStart = new Date(now - 20 * DAY + 330 * 60_000).toISOString().slice(0, 10);
  assert.equal(trends.backfilledBefore, dailyStart, 'days before daily collection began are marked as backfill');
});

// Every number on the charts against the job list it opens, in one view ('' = Filtered).
async function checkChartNumbers(view = '') {
  const withView = (path) => (view ? `${path}${path.includes('?') ? '&' : '?'}view=${view}` : path);
  const get = async (path) => (await fetch(`${base}/${withView(path)}`)).json();
  let checked = 0;
  const same = async (params, expected, what) => {
    assert.equal((await get(`jobs?limit=1&${new URLSearchParams(params)}`)).total, expected, `${view || 'filtered'}: ${what}`);
    checked++;
  };

  // Where the jobs come from: each bar segment (site x course) and each site's total.
  const platforms = await get('platforms?days=7');
  for (const row of platforms.platforms.filter((r) => r.total)) {
    await same({ days: 7, primary: row.platform }, row.total, `${row.platform} total`);
    for (const [course, count] of Object.entries(row.byCourse).filter(([, n]) => n)) {
      await same({ days: 7, primary: row.platform, course }, count, `${row.platform} x ${course}`);
    }
  }

  // Top companies and cities, experience levels, and each course's most requested skills.
  const insights = await get('insights?days=7');
  // Each also split by course (the hover card): the parts add up, and each part is that course's jobs.
  const sumOfParts = (byCourse) => Object.values(byCourse).reduce((n, v) => n + v, 0);
  for (const { name, count, byCourse } of insights.companies) {
    await same({ days: 7, company: name }, count, `company ${name}`);
    assert.equal(sumOfParts(byCourse), count, `company ${name}: courses add up`);
    for (const [course, n] of Object.entries(byCourse)) await same({ days: 7, company: name, course }, n, `company ${name} x ${course}`);
  }
  for (const { name, count, byCourse } of insights.cities) {
    await same({ days: 7, city: name }, count, `city ${name}`);
    assert.equal(sumOfParts(byCourse), count, `city ${name}: courses add up`);
    for (const [course, n] of Object.entries(byCourse)) await same({ days: 7, city: name, course }, n, `city ${name} x ${course}`);
  }
  for (const [band, count] of Object.entries(insights.experience).filter(([band]) => band !== 'null')) {
    await same({ days: 7, exp: band }, count, `${band} years`);
    assert.equal(sumOfParts(insights.experienceByCourse[band]), count, `${band} years: courses add up`);
    for (const [course, n] of Object.entries(insights.experienceByCourse[band])) await same({ days: 7, exp: band, course }, n, `${band} years x ${course}`);
  }
  for (const [course, skills] of Object.entries(insights.skills)) {
    for (const { name, count } of skills) await same({ days: 7, course, skill: name }, count, `${course}: ${name}`);
  }

  // A course page: how fresh the posts were, and each site's counted and listed jobs.
  const course = await get('course/data-analyst?days=7');
  for (const [age, count] of Object.entries(course.postingAge)) await same({ days: 7, course: 'data-analyst', age }, count, `posted ${age}`);
  for (const p of course.platforms) {
    await same({ days: 7, course: 'data-analyst', primary: p.platform }, p.counted, `${p.platform} counted`);
    await same({ days: 7, course: 'data-analyst', platform: p.platform }, p.listed, `${p.platform} listed`);
  }

  // New jobs per day: each course on each day of the trend chart (a day replaces the period).
  const trends = await get('trends?days=30');
  for (const point of trends.series) {
    for (const { id } of COURSES) if (point[id]) await same({ days: 1, day: point.day, course: id }, point[id], `${point.day} ${id}`);
  }
  return checked;
}

test('every number on a chart opens a list holding exactly those jobs', async () => {
  const checked = await checkChartNumbers();
  assert.ok(checked >= 20, `checked ${checked} numbers`);
});

test('the Non-filtered view shows only the non-filtered jobs, and the Filtered view is exactly as before', async () => {
  const get = async (path) => (await fetch(`${base}/${path}`)).json();
  const filteredPaths = ['meta', 'summary?days=7', 'platforms?days=7', 'trends?days=30', 'insights?days=7', 'course/data-analyst?days=7',
    'skill-gaps?course=data-analyst&days=7', 'partners', 'jobs?days=30&limit=100'];
  const before = await Promise.all(filteredPaths.map(get));

  const now = Date.now();
  const left = (n, extra) => ({
    fingerprint: `nf${n}`, title: `Data Engineer ${n}`, company: `Left Out ${n}`, course: 'data-engineering', cities: ['Pune'],
    firstSeenAt: new Date(now - 2 * HOUR), lastSeenAt: new Date(now - 2 * HOUR), primaryPlatform: 'Naukri', platforms: ['Naukri'],
    sourceKeys: [`NF:${n}`], links: { Naukri: `https://example.com/nf${n}` }, ...extra,
  });
  const docs = await NonFilteredJob.create([
    left(1, { company: 'Infosys', leftOutBy: 'big-company', experienceMin: 3, experienceBand: '3' }),
    left(2, { leftOutBy: 'experience', experienceMin: 0, experienceBand: 'fresher', skills: ['SQL'] }),
    left(3, { leftOutBy: 'no-experience', experienceBand: 'unknown', course: 'data-analyst', primaryPlatform: 'Indeed', platforms: ['Indeed'], links: { Indeed: 'https://example.com/nf3' } }),
  ]);
  try {
    const after = await Promise.all(filteredPaths.map(get));
    filteredPaths.forEach((path, i) => assert.deepEqual(after[i], before[i], `the Filtered view did not change: ${path}`));

    const summary = await get('summary?days=7&view=nonfiltered');
    assert.deepEqual(summary.current, { 'data-engineering': 2, 'data-analyst': 1 });
    const list = await get('jobs?days=7&limit=100&view=nonfiltered');
    assert.equal(list.total, 3);
    assert.deepEqual(list.items.map((j) => j.leftOutBy).sort(), ['big-company', 'experience', 'no-experience'], 'each says why it is left out');
    const ids = new Set(docs.map((d) => String(d._id)));
    assert.ok(!before.at(-1).items.some((j) => ids.has(j._id)), 'none of them in the Filtered list');

    // HR details can be typed into a non-filtered job, and a number is never on two jobs across both views.
    const put = (id, body) => fetch(`${base}/jobs/${id}/follow-up`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const saved = await put(docs[0]._id, { phone: '97000 11111', email: '', remarks: 'Non-filtered' });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).contact.remarks, 'Non-filtered');
    const kept = await Job.findOne({ fingerprint: 'f1' }).lean();
    const clash = await put(kept._id, { phone: '97000 11111', email: '', remarks: '' });
    assert.equal(clash.status, 409);
    assert.equal((await clash.json()).error, 'This number already exists.');
    await put(docs[0]._id, { phone: '', email: '', remarks: '' });

    const csv = await (await fetch(`${base}/jobs.csv?days=7&view=nonfiltered`)).text();
    assert.match(csv, /Left out because/);
    assert.match(csv, /Large IT services firm/);

    const checked = await checkChartNumbers('nonfiltered');
    assert.ok(checked >= 10, `checked ${checked} numbers`);
  } finally {
    await NonFilteredJob.deleteMany({});
  }
});

test('the All view shows the Filtered and Non-filtered jobs together: each number is the sum, each list holds both', async () => {
  const get = async (path) => (await fetch(`${base}/${path}`)).json();
  const now = Date.now();
  const left = (n, extra) => ({
    fingerprint: `all${n}`, title: `Data Engineer A${n}`, company: `Left Out A${n}`, course: 'data-engineering', cities: ['Nagpur'],
    firstSeenAt: new Date(now - 2 * HOUR), lastSeenAt: new Date(now - 2 * HOUR), primaryPlatform: 'Naukri', platforms: ['Naukri'],
    sourceKeys: [`ALL:${n}`], links: { Naukri: `https://example.com/all${n}` }, ...extra,
  });
  const docs = await NonFilteredJob.create([
    left(1, { company: 'Infosys', leftOutBy: 'big-company', experienceMin: 3, experienceBand: '3', postedAt: new Date(now - 3 * HOUR) }),
    left(2, { leftOutBy: 'experience', experienceMin: 0, experienceBand: 'fresher', skills: ['SQL'], course: 'data-analyst', cities: ['Pune'] }),
    left(3, { leftOutBy: 'no-experience', experienceBand: 'unknown', course: 'data-analyst', primaryPlatform: 'Indeed', platforms: ['Indeed', 'Naukri'], links: { Indeed: 'https://example.com/a3' }, firstSeenAt: new Date(now - 30 * HOUR) }),
    left(4, { leftOutBy: 'experience', experienceMin: 0, experienceBand: 'fresher', firstSeenAt: new Date(now - 5 * 24 * HOUR), manual: { phone: '97000 22222' } }),
  ]);
  const views = async (path) => {
    const [f, nf, all] = await Promise.all(['', '&view=nonfiltered', '&view=all'].map((v) => get(`${path}${path.includes('?') ? '' : '?'}${v}`)));
    return { f, nf, all };
  };
  const sumBy = (a = {}, b = {}) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)]));
  try {
    let v = await views('summary?days=7');
    assert.deepEqual(v.all.current, sumBy(v.f.current, v.nf.current), 'summary: each course');
    assert.ok(v.nf.current['data-engineering'] > 0 && v.f.current['data-analyst'] > 0, 'both sets have jobs in the period');

    v = await views('platforms?days=7');
    const totals = (r) => Object.fromEntries(r.platforms.map((p) => [p.platform, p.total]));
    assert.deepEqual(totals(v.all), sumBy(totals(v.f), totals(v.nf)), 'platforms: each site');
    assert.equal(v.all.multiPlatform, v.f.multiPlatform + v.nf.multiPlatform);

    v = await views('trends?days=30');
    for (const point of v.all.series) {
      const f = v.f.series.find((p) => p.day === point.day) ?? {};
      const nf = v.nf.series.find((p) => p.day === point.day) ?? {};
      for (const { id } of COURSES) assert.equal(point[id], (f[id] ?? 0) + (nf[id] ?? 0), `trends: ${point.day} ${id}`);
    }

    v = await views('insights?days=7');
    assert.equal(v.all.total, v.f.total + v.nf.total, 'insights: total');
    assert.deepEqual(v.all.experience, sumBy(v.f.experience, v.nf.experience), 'insights: experience levels');

    v = await views('course/data-analyst?days=7');
    assert.equal(v.all.total, v.f.total + v.nf.total, 'course page: total');
    assert.equal(v.all.freshness.storedTotal, v.f.freshness.storedTotal + v.nf.freshness.storedTotal, 'course page: stored');

    v = await views('meta');
    assert.deepEqual(v.all.cities, [...new Set([...v.f.cities, ...v.nf.cities])].sort((a, b) => a.localeCompare(b)), 'meta: cities of both');
    assert.ok(v.all.cities.includes('Nagpur') && v.all.cities.includes(v.f.cities[0]));

    v = await views('partners');
    assert.equal(v.all.jobs, v.f.jobs + v.nf.jobs, 'partners: the jobs looked at');

    // The job list: both sets, one order (newest first, as each list), paged without gaps or repeats.
    v = await views('jobs?days=30&limit=100');
    assert.equal(v.all.total, v.f.total + v.nf.total, 'jobs: total');
    assert.equal(v.all.withContact, v.f.withContact + v.nf.withContact, 'jobs: with HR details');
    assert.deepEqual(new Set(v.all.items.map((j) => j._id)), new Set([...v.f.items, ...v.nf.items].map((j) => j._id)), 'jobs: every job of both');
    const order = v.all.items.map((j) => [Date.parse(j.firstSeenAt), j.postedAt ? Date.parse(j.postedAt) : -Infinity, j._id]);
    assert.ok(order.every((o, i) => i === 0 || order[i - 1][0] > o[0] || (order[i - 1][0] === o[0] && (order[i - 1][1] > o[1] || (order[i - 1][1] === o[1] && order[i - 1][2] < o[2])))), 'jobs: newest first');
    assert.deepEqual(v.all.items.filter((j) => j.leftOutBy).map((j) => j._id).sort(), docs.map((d) => String(d._id)).sort(), 'the left-out ones say why');
    const pages = await Promise.all([1, 2, 3].map((page) => get(`jobs?days=30&limit=2&page=${page}&view=all`)));
    assert.deepEqual(pages.flatMap((p) => p.items.map((j) => j._id)), v.all.items.slice(0, 6).map((j) => j._id), 'jobs: pages in order');
    for (const [filter, what] of [['age=day', 'how old'], ['q=Left%20Out', 'search words'], ['exp=fresher', 'experience'], ['city=Pune', 'city'], ['sites=2', 'on several sites'], ['hr=some', 'with HR details']]) {
      v = await views(`jobs?days=30&limit=1&${filter}`);
      assert.equal(v.all.total, v.f.total + v.nf.total, `jobs filtered by ${what}`);
    }
    for (const doc of [docs[1], await Job.findOne({ fingerprint: 'f1' }).lean()]) {
      const one = await get(`jobs?id=${doc._id}&days=1&view=all`);
      assert.deepEqual(one.items.map((j) => j._id), [String(doc._id)], 'one job by id, from either set');
    }

    const csv = async (view) => (await (await fetch(`${base}/jobs.csv?days=30${view}`)).text()).trim().split('\n').length - 1;
    assert.equal(await csv('&view=all'), (await csv('')) + (await csv('&view=nonfiltered')), 'CSV: the rows of both');
    const allCsv = await fetch(`${base}/jobs.csv?days=30&view=all`);
    assert.match(allCsv.headers.get('content-disposition'), /filename="all-jobs-/);
    assert.match(await allCsv.text(), /Left out because.*\r?\n[\s\S]*Large IT services firm/, 'CSV: why each left-out job is left out');

    v = await views('role-jobs?role=sre&days=30');
    assert.equal(v.all.view, 'all');
    assert.equal(v.all.total, v.all.filtered + v.all.nonFiltered, 'a role box: both sets');

    const checked = await checkChartNumbers('all');
    assert.ok(checked >= 20, `checked ${checked} numbers`);
  } finally {
    await NonFilteredJob.deleteMany({ fingerprint: /^all/ });
  }
});

test('a day without a collection run is never compared (it would look like a huge jump)', async () => {
  const DAY = 24 * HOUR;
  const IST = 330 * 60_000;
  const todayStart = Math.floor((Date.now() + IST) / DAY) * DAY - IST; // midnight IST, as a timestamp
  const yesterday = { startedAt: { $gte: new Date(todayStart - DAY), $lt: new Date(todayStart) } };
  const runs = await CollectorRun.find(yesterday).lean();
  assert.ok(runs.length, 'the earlier tests collected yesterday');
  assert.equal((await (await fetch(`${base}/summary?days=1`)).json()).comparable, true, 'collected yesterday and today');

  await CollectorRun.deleteMany(yesterday);
  const comparable = async () => (await (await fetch(`${base}/summary?days=1`)).json()).comparable;
  const catchUp = (extra) => CollectorRun.create({ startedAt: new Date(), finishedAt: new Date(), status: 'success', ...extra });
  try {
    const summary = await (await fetch(`${base}/summary?days=1`)).json();
    assert.equal(summary.comparable, false, 'nothing was collected yesterday');
    assert.deepEqual(summary.previous, {});
    assert.equal((await (await fetch(`${base}/course/data-analyst?days=1`)).json()).previous, 0);

    // A catch-up today that reached back over yesterday (`--days 2`) makes up for it; one of only some
    // courses, or a long backfill (its days miss the postings already taken down), doesn't.
    let run = await catchUp({ lookbackDays: 2, onlyCourses: ['production-support'] });
    assert.equal(await comparable(), false, 'a catch-up of one course');
    await CollectorRun.deleteOne({ _id: run._id });
    run = await catchUp({ lookbackDays: 30 });
    assert.equal(await comparable(), false, 'a 30-day backfill');
    await CollectorRun.deleteOne({ _id: run._id });
    run = await catchUp({ lookbackDays: 2 });
    assert.equal(await comparable(), true, 'a 2-day catch-up covers yesterday');
    await CollectorRun.deleteOne({ _id: run._id });
  } finally {
    await CollectorRun.deleteMany({ startedAt: { $gte: new Date(todayStart) }, lookbackDays: { $in: [2, 30] } });
    await CollectorRun.insertMany(runs);
  }
});

test('the latest day is the latest daily run\'s: a backfill or a run of some courses after it does not move it', async () => {
  const DAY = 24 * HOUR;
  const anchor = async () => (await (await fetch(`${base}/summary?days=1`)).json()).anchor;
  const custom = async (day) => (await (await fetch(`${base}/summary?from=${day}&to=${day}`)).json()).anchor;
  const before = await anchor();
  const later = new Date(Date.now() + DAY); // the IST day after the daily run
  const laterDay = new Date(later.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const run = (extra) => CollectorRun.create({ startedAt: later, finishedAt: later, status: 'success', ...extra });
  try {
    await run({ lookbackDays: 30 });
    await run({ lookbackDays: 2, onlyCourses: ['production-support'] });
    await run({ lookbackDays: 30, onlyCourses: ['data-analyst'] });
    assert.equal(await anchor(), before, 'backfills and one-course runs leave it');
    assert.equal(await custom(before), before, 'the same for a chosen day');
    await CollectorRun.create({ startedAt: later, finishedAt: later, status: 'failed', lookbackDays: 1 });
    assert.equal(await anchor(), before, 'a failed run leaves it');
    await run({ lookbackDays: 2 });
    assert.equal(await anchor(), laterDay, 'a short catch-up of every course moves it');
  } finally {
    await CollectorRun.deleteMany({ startedAt: later });
  }
});

test('the summary says how many of the period\'s jobs have HR details: each number is the job list\'s ?hr=some, the rest its ?hr=none', async () => {
  const get = async (path) => (await fetch(`${base}/${path}`)).json();
  const now = Date.now();
  const left = (n, extra) => ({
    fingerprint: `hrsum${n}`, title: `Data Analyst H${n}`, company: `HR Sum ${n}`, course: 'data-analyst', cities: ['Pune'], leftOutBy: 'experience',
    firstSeenAt: new Date(now - 2 * HOUR), lastSeenAt: new Date(now - 2 * HOUR), primaryPlatform: 'Naukri', platforms: ['Naukri'], sourceKeys: [`HS:${n}`], ...extra,
  });
  await NonFilteredJob.create([left(1, { manual: { remarks: 'Called' } }), left(2, { foundEmails: ['hr@example.com'] }), left(3, {})]);
  try {
    for (const view of ['', '&view=nonfiltered', '&view=all']) {
      const summary = await get(`summary?days=7${view}`);
      assert.ok(summary.withHrDetails && typeof summary.withHrDetails === 'object', `withHrDetails is sent${view}`);
      for (const { id } of COURSES) {
        const total = summary.current[id] ?? 0;
        const withHr = summary.withHrDetails[id] ?? 0;
        assert.ok(withHr <= total, `${id}${view}: no more than its jobs`);
        assert.equal((await get(`jobs?days=7&limit=1&course=${id}&hr=some${view}`)).total, withHr, `${id}${view}: with HR details`);
        assert.equal((await get(`jobs?days=7&limit=1&course=${id}&hr=none${view}`)).total, total - withHr, `${id}${view}: without`);
      }
    }
    const [f, nf, all] = await Promise.all(['', '&view=nonfiltered', '&view=all'].map((v) => get(`summary?days=7${v}`)));
    assert.equal(nf.withHrDetails['data-analyst'], 2, 'a note typed in, or an email found in the post, counts; nothing does not');
    assert.ok(f.withHrDetails['data-analyst'] > 0, 'the Filtered set has some too (a phone found in a post)');
    assert.equal(all.withHrDetails['data-analyst'], f.withHrDetails['data-analyst'] + nf.withHrDetails['data-analyst'], 'All: both sets');
  } finally {
    await NonFilteredJob.deleteMany({ fingerprint: /^hrsum/ });
  }
});

test('the job list says how many of its jobs have an HR contact', async () => {
  const now = Date.now();
  const job = await Job.create({
    fingerprint: 'contact-count-1', title: 'Production Analyst', company: 'Count Co', course: 'production-support',
    firstSeenAt: new Date(now - HOUR), lastSeenAt: new Date(now - HOUR), primaryPlatform: 'Naukri', platforms: ['Naukri'],
    sourceKeys: ['CC:1'],
  });
  const count = async () => (await (await fetch(`${base}/jobs?days=1&q=Count%20Co`)).json()).withContact;
  assert.equal(await count(), 0);
  await fetch(`${base}/jobs/${job._id}/follow-up`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remarks: 'Called HR' }),
  });
  assert.equal(await count(), 1, 'a typed-in note counts');
  await Job.updateOne({ _id: job._id }, { $unset: { manual: 1 }, $set: { foundEmails: ['hr@countco.in'] } });
  assert.equal(await count(), 1, 'an email found in the post counts too');
});

const putAs = (id, body, auth) =>
  fetch(`${base}/jobs/${id}/follow-up`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
const empty = { phone: [], email: [], assignedTo: [], remarks: '' };

test('every change to HR details is recorded: who (email), which job, and what was added, edited or removed', async () => {
  const job = await Job.findOne({ fingerprint: 'f1' }).lean();
  await putAs(job._id, empty); // start from nothing typed in
  await Activity.deleteMany({});
  const riya = 'PLACEMENT_STAFF:riya@example.com';

  // Added: a phone and an email.
  assert.equal((await putAs(job._id, { ...empty, phone: ['93456 70011'], email: ['hr@acme.in'] }, riya)).status, 200);
  let [entry] = await Activity.find().sort({ at: -1 }).lean();
  assert.deepEqual(entry.actor, { userId: 'user_riya@example.com', email: 'riya@example.com', name: '', role: 'PLACEMENT_STAFF' });
  assert.equal(entry.action, 'added');
  assert.deepEqual({ id: String(entry.job.id), set: entry.job.set, title: entry.job.title }, { id: String(job._id), set: 'filtered', title: job.title });
  assert.deepEqual(entry.changes.map((c) => [c.field, c.change, c.added]), [['phone', 'added', ['93456 70011']], ['email', 'added', ['hr@acme.in']]]);

  // Edited: a second number, the email removed, a student and a note added.
  await putAs(job._id, { phone: ['93456 70011', '080 5555 0101'], email: [], assignedTo: ['Riya Sharma'], remarks: 'Called HR' }, 'ADMIN:aman@example.com');
  [entry] = await Activity.find().sort({ at: -1 }).lean();
  assert.equal(entry.actor.email, 'aman@example.com');
  assert.equal(entry.action, 'edited');
  const byField = Object.fromEntries(entry.changes.map((c) => [c.field, c]));
  assert.deepEqual([byField.phone.change, byField.phone.added, byField.phone.removed], ['edited', ['080 5555 0101'], []]);
  assert.deepEqual([byField.email.change, byField.email.before, byField.email.after], ['removed', ['hr@acme.in'], []]);
  assert.deepEqual([byField.assignedTo.change, byField.remarks.change, byField.remarks.after], ['added', 'added', ['Called HR']]);

  // Saving it again as it is: nothing changed, nothing recorded. Refused saves aren't recorded either.
  const count = await Activity.countDocuments();
  await putAs(job._id, { phone: ['93456 70011', '080 5555 0101'], email: [], assignedTo: ['Riya Sharma'], remarks: 'Called HR' }, riya);
  assert.equal((await putAs(job._id, { ...empty, phone: ['98450 12345'] }, riya)).status, 409, "a number in another job's posting");
  assert.equal((await putAs(job._id, { ...empty, phone: ['12345'] }, riya)).status, 400);
  assert.equal(await Activity.countDocuments(), count, 'no record without a change');

  // Removed: everything cleared.
  await putAs(job._id, empty, riya);
  [entry] = await Activity.find().sort({ at: -1 }).lean();
  assert.equal(entry.action, 'removed');
  assert.deepEqual(entry.changes.map((c) => c.field).sort(), ['assignedTo', 'phone', 'remarks']);

  // Reading the record: newest first, by job, by person, page by page.
  const get = async (q, auth) => fetch(`${base}/activity?${q}`, auth ? { headers: { Authorization: `Bearer ${auth}` } } : {});
  const all = await (await get(`job=${job._id}`)).json();
  assert.deepEqual(all.items.map((i) => i.action), ['removed', 'edited', 'added']);
  assert.equal(all.next, null);
  const mine = await (await get('email=RIYA@example.com')).json();
  assert.deepEqual(mine.items.map((i) => i.action), ['removed', 'added'], 'email matched ignoring case');
  const first = await (await get(`job=${job._id}&limit=1`)).json();
  assert.equal(first.items.length, 1);
  const second = await (await get(`job=${job._id}&limit=1&before=${encodeURIComponent(first.next)}`)).json();
  assert.equal(second.items[0].action, 'edited');
  assert.equal((await get('job=nope')).status, 400);
  assert.equal((await get('', 'expired')).status, 401, 'reading it needs a sign-in too');
  assert.equal((await get('', 'STUDENT:x@example.com')).status, 403);
});

test('the server accepts changes only from a Clerk sign-in with an allowed role, and takes the email from Clerk', async () => {
  // The real check (src/auth.js) with its two calls to Clerk replaced: tokens "good-<userId>" are valid.
  const users = {
    user_ok: { firstName: 'Riya', lastName: 'Sharma', primaryEmailAddress: { emailAddress: 'riya@ijf.example' }, publicMetadata: { role: 'research_team' } },
    user_norole: { primaryEmailAddress: { emailAddress: 'guest@ijf.example' }, publicMetadata: {} },
  };
  const identify = createClerkIdentify({
    secretKey: 'sk_test_fake',
    verify: async (token) => {
      if (token.startsWith('good-')) return { sub: token.slice(5) };
      throw Object.assign(new Error('JWT is expired'), { reason: 'token-expired' });
    },
    getUser: async (id) => users[id],
  });
  const server2 = createApp({ identify }).listen(0);
  try {
    const api = `http://localhost:${server2.address().port}/api`;
    const job = await Job.findOne({ fingerprint: 'f1' }).lean();
    const put = (auth, body) =>
      fetch(`${api}/jobs/${job._id}/follow-up`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify(body),
      });
    const before = await Activity.countDocuments();
    const body = { ...empty, remarks: 'From the test', actor: { email: 'someone-else@example.com' } };

    let res = await put(null, body);
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /sign in/i);
    assert.equal((await put('Bearer stale', body)).status, 401, 'an expired or made-up token');
    res = await put('Bearer good-user_norole', body);
    assert.equal(res.status, 403, 'signed in, but no allowed role');
    assert.match((await res.json()).error, /role/);
    assert.equal(await Activity.countDocuments(), before, 'refused: nothing recorded');
    assert.equal((await Job.findById(job._id).lean()).manual, undefined, 'refused: nothing saved');

    assert.equal((await put('Bearer good-user_ok', body)).status, 200);
    const [entry] = await Activity.find().sort({ at: -1 }).lean();
    assert.deepEqual(
      entry.actor,
      { userId: 'user_ok', email: 'riya@ijf.example', name: 'Riya Sharma', role: 'RESEARCH_TEAM' },
      'the email comes from Clerk, not from what the browser sent',
    );
    await put('Bearer good-user_ok', empty);

    // A dashboard hosted elsewhere may send the sign-in header.
    const saved = config.corsOrigins;
    config.corsOrigins = ['https://dash.example.com'];
    const server3 = createApp({ identify }).listen(0);
    try {
      const preflight = await fetch(`http://localhost:${server3.address().port}/api/jobs/${job._id}/follow-up`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://dash.example.com', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' },
      });
      assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
    } finally {
      server3.close();
      config.corsOrigins = saved;
    }
  } finally {
    server2.close();
  }
});

test('without CLERK_SECRET_KEY on the server, changes are refused with a clear message', async () => {
  const server2 = createApp({ identify: createClerkIdentify({ secretKey: '' }) }).listen(0);
  try {
    const job = await Job.findOne({ fingerprint: 'f1' }).lean();
    const res = await fetch(`http://localhost:${server2.address().port}/api/jobs/${job._id}/follow-up`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' },
      body: JSON.stringify({ ...empty, remarks: 'x' }),
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /CLERK_SECRET_KEY/);
  } finally {
    server2.close();
  }
});

test('the activity list can be filtered (person, kind of change, job) and paged without skipping records', async () => {
  await Activity.deleteMany({});
  const [job1, job2] = await Promise.all(['f1', 'f2'].map((f) => Job.findOne({ fingerprint: f }).lean()));
  const at = new Date();
  const entry = (n, actor, action, job, when = at) => ({
    at: when,
    actor: { userId: `u_${actor}`, email: `${actor}@example.com`, name: actor === 'riya' ? 'Riya Sharma' : '', role: 'ADMIN' },
    action,
    job: { id: job._id, set: 'filtered', title: job.title, company: job.company, course: job.course },
    changes: [{ field: 'remarks', change: action, before: [], after: [`note ${n}`], added: [], removed: [] }],
  });
  // Five records, three of them saved in the same millisecond.
  await Activity.create([
    entry(1, 'riya', 'added', job1, new Date(at.getTime() - 60_000)),
    entry(2, 'riya', 'edited', job1),
    entry(3, 'aman', 'edited', job2),
    entry(4, 'riya', 'removed', job2),
    entry(5, 'aman', 'added', job1, new Date(at.getTime() - 120_000)),
  ]);
  const get = async (q) => (await fetch(`${base}/activity?${q}`)).json();

  const all = await get('');
  assert.equal(all.total, 5);
  assert.deepEqual(all.people, [{ email: 'riya@example.com', name: 'Riya Sharma', count: 3 }, { email: 'aman@example.com', name: '', count: 2 }]);
  assert.equal((await get('action=edited')).total, 2);
  assert.equal((await get(`q=${encodeURIComponent(job2.company)}`)).total, 2, 'by company');
  assert.equal((await get('email=aman@example.com&action=added')).total, 1);

  // Two at a time: every record exactly once, even the three saved in the same millisecond.
  const seen = [];
  let next = '';
  do {
    const page = await get(`limit=2${next ? `&before=${encodeURIComponent(next)}` : ''}`);
    seen.push(...page.items.map((i) => i.changes[0].after[0]));
    if (next) assert.equal(page.total, undefined, 'total and people only on the first page');
    next = page.next;
  } while (next);
  assert.deepEqual(seen.slice(3), ['note 1', 'note 5']);
  assert.deepEqual(seen.slice(0, 3).sort(), ['note 2', 'note 3', 'note 4']);
  assert.equal((await fetch(`${base}/activity?before=nonsense`)).status, 400);
  await Activity.deleteMany({});

  // A record's job can be opened: the job list finds one job by id, whenever it was found.
  const one = await (await fetch(`${base}/jobs?id=${job2._id}&days=1`)).json();
  assert.deepEqual(one.items.map((j) => j._id), [String(job2._id)]);
});

test('a custom period (from–to, IST days, both included) counts exactly the jobs found on those days', async () => {
  const get = async (path) => {
    const res = await fetch(`${base}/${path}`);
    return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  const DAY = 24 * HOUR;
  const sumOf = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
  const istDay = (ms) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
  const noonIst = (day) => new Date(`${day}T12:00:00+05:30`);
  const { anchor } = (await get('summary?days=1')).body;
  const daysBefore = (n) => istDay(noonIst(anchor).getTime() - n * DAY);

  // Covering the same days as a preset gives the same numbers.
  const latest = await get(`summary?from=${anchor}&to=${anchor}`);
  assert.deepEqual(latest.body.current, (await get('summary?days=1')).body.current, 'one day = Latest day');
  assert.equal(latest.body.days, 1);
  assert.deepEqual([latest.body.from, latest.body.to], [anchor, anchor]);
  const week = (await get(`summary?from=${daysBefore(6)}&to=${anchor}`)).body;
  const preset = (await get('summary?days=7')).body;
  assert.deepEqual([week.current, week.previous, week.comparable, week.days], [preset.current, preset.previous, preset.comparable, 7], '7 days = Last 7 days');

  // Two jobs found on two days 40 and 41 days ago: a range holds both, one day holds one, Last 30 days neither.
  const [d41, d40] = [daysBefore(41), daysBefore(40)];
  await Job.create(
    [d41, d40].map((day, i) => ({
      fingerprint: `range-${i}`, title: `Range Analyst ${i}`, company: 'Range Co', course: 'data-analyst', cities: ['Pune'],
      firstSeenAt: noonIst(day), lastSeenAt: noonIst(day), primaryPlatform: 'Naukri', platforms: ['Naukri'], sourceKeys: [`RANGE:${i}`],
    })),
  );
  const total = async (params) => (await get(`jobs?limit=1&company=Range+Co&${params}`)).body.total;
  assert.equal(await total(`from=${d41}&to=${d40}`), 2);
  assert.equal(await total(`from=${d40}&to=${d40}`), 1);
  assert.equal(await total('days=30'), 0);

  // Every number for the range agrees with its job list.
  const range = `from=${d41}&to=${d40}`;
  const summary = (await get(`summary?${range}`)).body;
  assert.equal(sumOf(summary.current), (await get(`jobs?limit=1&${range}`)).body.total, 'tiles = job list');
  const course = (await get(`course/data-analyst?${range}`)).body;
  assert.equal(course.total, summary.current['data-analyst'], 'course page = its tile');
  const platforms = (await get(`platforms?${range}`)).body;
  assert.equal(platforms.platforms.reduce((n, p) => n + p.total, 0), sumOf(summary.current), 'platforms add up');
  assert.equal((await get(`insights?${range}`)).body.total, sumOf(summary.current));
  assert.equal((await get(`skill-gaps?course=data-analyst&${range}`)).body.postings, course.total);

  const csv = await get(`jobs.csv?company=Range+Co&${range}`);
  assert.match(csv.headers.get('content-disposition'), new RegExp(`jobs-${d41}-to-${d40}\.csv`));
  assert.equal(csv.body.trim().split('\r\n').length, 3, 'header + 2 jobs');

  // The custom date picker's limits: the oldest and newest day with jobs.
  const meta = (await get('meta')).body;
  assert.ok(meta.dataDays.first <= d41 && meta.dataDays.last >= anchor, JSON.stringify(meta.dataDays));

  // Mistakes get a clear 400.
  for (const [params, message] of [
    ['from=2026-02-31&to=2026-03-01', /dates like/],
    ['from=yesterday', /dates like/],
    [`from=${d40}&to=${d41}`, /on or before/],
    ['from=2020-01-01&to=2026-01-01', /at most 366 days/],
  ]) {
    const res = await get(`summary?${params}`);
    assert.equal(res.status, 400, params);
    assert.match(res.body.error, message, params);
  }
});

test('performance report: each phone number and email a person added, once, with when and on which job', async () => {
  const [job1, job2, job4] = await Promise.all(['f1', 'f2', 'f4'].map((f) => Job.findOne({ fingerprint: f }).lean()));
  for (const job of [job1, job2, job4]) await putAs(job._id, empty); // start from nothing typed in
  await Activity.deleteMany({});
  const riya = 'PLACEMENT_STAFF:Riya@Example.com';
  const aman = 'ADMIN:aman@example.com';

  // Riya adds a phone and an email to job 1: two contact details.
  assert.equal((await putAs(job1._id, { ...empty, phone: ['93456 70021'], email: ['hr@acme.in'] }, riya)).status, 200);
  // Aman keeps the number and email that job 2's posting already had, and adds one number: one detail.
  assert.equal((await putAs(job2._id, { ...empty, phone: ['+91 98450 12345', '93456 70022'], email: ['careers@company2.in'] }, aman)).status, 200);
  // Riya rewrites her number the long way and removes the email: nothing added.
  assert.equal((await putAs(job1._id, { ...empty, phone: ['+91 93456 70021'], email: [] }, riya)).status, 200);
  // Riya writes a note on job 4 (not a contact detail), then adds a number there: one detail.
  assert.equal((await putAs(job4._id, { ...empty, remarks: 'Called HR' }, riya)).status, 200);
  assert.equal((await putAs(job4._id, { ...empty, remarks: 'Called HR', phone: ['93456 70023'] }, riya)).status, 200);

  const get = async (q, auth) => {
    const res = await fetch(`${base}/performance?${q}`, auth ? { headers: { Authorization: `Bearer ${auth}` } } : {});
    return { status: res.status, body: await res.json() };
  };
  const { body } = await get('days=1');
  const rows = body.rows.map((r) => [r.actor.email, r.field, r.value, r.job.title, r.job.course]).sort();
  assert.deepEqual(rows, [
    ['aman@example.com', 'phone', '93456 70022', job2.title, 'data-analyst'],
    ['riya@example.com', 'email', 'hr@acme.in', job1.title, 'data-analyst'],
    ['riya@example.com', 'phone', '93456 70021', job1.title, 'data-analyst'],
    ['riya@example.com', 'phone', '93456 70023', job4.title, 'data-science'],
  ]);
  assert.ok(body.rows.every((r) => r.at && r.record && String(r.job.id) && r.actor.role), 'when, which change, which job, their role');
  assert.ok(Date.parse(body.rows[0].at) >= Date.parse(body.rows.at(-1).at), 'newest first');
  assert.ok(body.since, 'says when the activity record began');
  assert.equal(body.truncated, false);

  // The period: today and chosen days (IST); yesterday had none.
  const istDay = (ms) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
  const today = istDay(Date.now());
  assert.deepEqual([body.from, body.to], [today, today]);
  assert.equal((await get(`from=${today}&to=${today}`)).body.rows.length, 4);
  const yesterday = istDay(Date.now() - 24 * HOUR);
  assert.equal((await get(`from=${yesterday}&to=${yesterday}`)).body.rows.length, 0);
  assert.equal((await get('days=7')).body.rows.length, 4);
  assert.equal((await get('from=2026-02-30')).status, 400);

  // Only for signed-in people with an allowed role.
  assert.equal((await get('days=1', 'expired')).status, 401);
  assert.equal((await get('days=1', 'STUDENT:x@example.com')).status, 403);
});

test('follow-up of each number/email: given to several students, each call with its own remark; on the job too, recorded, shown in the report', async () => {
  const job4 = await Job.findOne({ fingerprint: 'f4' }).lean();
  await putAs(job4._id, empty);
  assert.equal((await putAs(job4._id, { ...empty, phone: ['93456 70041'], email: ['hr@zeta.in'] }, 'RESEARCH_TEAM:asha@example.com')).status, 200);
  const caller = 'PLACEMENT_STAFF:caller@example.com';
  const put = async (body, auth = caller) => {
    const res = await fetch(`${base}/outcomes`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const phone = { job: String(job4._id), field: 'phone', value: '93456 70041' };
  const email = { job: String(job4._id), field: 'email', value: 'hr@zeta.in' };
  const latest = async () => (await Activity.find().sort({ at: -1, _id: -1 }).limit(1).lean())[0];
  const students = async () => (await Job.findById(job4._id).lean()).manual?.assignedTo ?? [];
  const followUps = (res) => res.body.outcomes.map((o) => [o.student, o.status, o.note]);

  // Given to a student: saved, and on the job's "Assigned to" list; recorded under the caller's email.
  let res = await put({ ...phone, student: 'Kavya Rao', add: true });
  assert.equal(res.status, 200);
  assert.deepEqual([followUps(res), res.body.assignedTo], [[['Kavya Rao', '', '']], ['Kavya Rao']]);
  assert.deepEqual(await students(), ['Kavya Rao']);
  let entry = await latest();
  assert.equal(entry.actor.email, 'caller@example.com');
  assert.deepEqual(entry.changes.map((c) => [c.field, c.change, c.before, c.after, c.contact?.value]), [
    ['contactStudent', 'added', [], ['Kavya Rao'], '93456 70041'],
    ['assignedTo', 'added', [], ['Kavya Rao'], undefined],
  ]);

  // ...and to a second student: both have it. The same student again, in any case, changes nothing.
  res = await put({ ...phone, student: 'Aman Gupta', add: true });
  assert.deepEqual(followUps(res), [['Kavya Rao', '', ''], ['Aman Gupta', '', '']]);
  assert.deepEqual(await students(), ['Kavya Rao', 'Aman Gupta']);
  assert.deepEqual((await latest()).changes.map((c) => [c.field, c.change, c.before, c.after, c.added]), [
    ['contactStudent', 'added', ['Kavya Rao'], ['Kavya Rao', 'Aman Gupta'], ['Aman Gupta']],
    ['assignedTo', 'edited', ['Kavya Rao'], ['Kavya Rao', 'Aman Gupta'], ['Aman Gupta']],
  ]);
  const count0 = await Activity.countDocuments();
  res = await put({ ...phone, student: 'aman GUPTA', add: true });
  assert.deepEqual([followUps(res).length, await Activity.countDocuments()], [2, count0], 'the same student: nothing new');

  // Each student's call has its own remark (recorded with whose call it was, as their name is stored).
  await put({ ...phone, student: 'Kavya Rao', status: 'dnp' });
  res = await put({ ...phone, student: 'aman gupta', status: 'cv-shared' });
  assert.deepEqual(followUps(res), [['Kavya Rao', 'dnp', ''], ['Aman Gupta', 'cv-shared', '']]);
  assert.deepEqual((await latest()).changes.map((c) => [c.field, c.change, c.after, c.contact.student]), [['contactRemark', 'added', ['CV shared'], 'Aman Gupta']]);
  // "Others" in their own words (which must be typed); the same remark again records nothing.
  assert.deepEqual((await put({ ...phone, student: 'Kavya Rao', status: 'other', note: '  ' })).body, { error: 'Remark: type what happened (Others).' });
  await put({ ...phone, student: 'Kavya Rao', status: 'other', note: 'Call after 5 pm' });
  entry = await latest();
  assert.deepEqual(entry.changes.map((c) => [c.field, c.change, c.before, c.after, c.contact.student]), [['contactRemark', 'edited', ['DNP'], ['Others: Call after 5 pm'], 'Kavya Rao']]);
  const count = await Activity.countDocuments();
  await put({ ...phone, student: 'Kavya Rao', status: 'other', note: 'Call after 5 pm' });
  assert.equal(await Activity.countDocuments(), count, 'saved as it was: nothing recorded');

  // A remark for a student who doesn't have it yet gives it to them first.
  res = await put({ ...phone, student: 'Neha Verma', status: 'busy' });
  assert.deepEqual(followUps(res).at(-1), ['Neha Verma', 'busy', '']);
  assert.deepEqual((await latest()).changes.map((c) => c.field), ['contactStudent', 'contactRemark', 'assignedTo']);
  assert.ok((await students()).includes('Neha Verma'));

  // The email: a remark before anyone has it ("Wrong number" reads "Wrong email"); the first student given it
  // takes that remark.
  res = await put({ ...email, student: '', status: 'wrong' });
  assert.deepEqual(followUps(res), [['', 'wrong', '']]);
  assert.deepEqual((await latest()).changes[0].after, ['Wrong email']);
  res = await put({ ...email, student: 'Aman Gupta', add: true });
  assert.deepEqual(followUps(res), [['Aman Gupta', 'wrong', '']], 'the remark is now his call');
  // As the report sent before a number could go to several students: a remark alone is the only student's.
  res = await put({ ...email, status: 'dnp' });
  assert.deepEqual(followUps(res), [['Aman Gupta', 'dnp', '']]);

  // The report: each number with all its follow-ups (the first given first), and the students to suggest.
  const report = await (await fetch(`${base}/performance?days=1`)).json();
  const rowOf = (value) => report.rows.find((r) => r.value === value && String(r.job.id) === String(job4._id));
  assert.deepEqual(rowOf('93456 70041').outcomes.map((o) => [o.student, o.status, o.note, o.updatedBy.email]), [
    ['Kavya Rao', 'other', 'Call after 5 pm', 'caller@example.com'],
    ['Aman Gupta', 'cv-shared', '', 'caller@example.com'],
    ['Neha Verma', 'busy', '', 'caller@example.com'],
  ]);
  assert.equal(rowOf('93456 70041').outcome.student, 'Kavya Rao', 'the first, for a dashboard built before');
  assert.deepEqual(rowOf('hr@zeta.in').outcomes.map((o) => [o.student, o.status]), [['Aman Gupta', 'dnp']]);
  assert.ok(['Kavya Rao', 'Aman Gupta', 'Neha Verma'].every((s) => report.students.includes(s)));
  assert.ok(report.rows.every((r) => r.field === 'phone' || r.field === 'email'), 'follow-ups are not counted as contact details added');

  // Taken back from Kavya (the same number written another way): her follow-up goes, its remark too
  // (recorded), and she leaves the job's list (no other number of it is hers).
  res = await put({ ...phone, value: '+91 93456 70041', student: 'kavya rao', remove: true });
  assert.deepEqual(followUps(res).map((f) => f[0]), ['Aman Gupta', 'Neha Verma']);
  assert.deepEqual(await students(), ['Aman Gupta', 'Neha Verma']);
  assert.deepEqual((await latest()).changes.map((c) => [c.field, c.change, c.removed]), [
    ['contactStudent', 'removed', ['Kavya Rao']],
    ['contactRemark', 'removed', []],
    ['assignedTo', 'edited', ['Kavya Rao']],
  ]);
  // Taken back from Aman, he stays on the job: the email is still his. A student who doesn't have it: nothing.
  await put({ ...phone, student: 'Aman Gupta', remove: true });
  assert.ok((await students()).includes('Aman Gupta'));
  const count2 = await Activity.countDocuments();
  await put({ ...phone, student: 'Kavya Rao', remove: true });
  assert.equal(await Activity.countDocuments(), count2);
  await put({ ...phone, student: 'Neha Verma', remove: true });
  assert.equal(await ContactOutcome.countDocuments({ job: job4._id, field: 'phone' }), 0, 'nothing left on the phone');

  // Editing the job's details in its window leaves the follow-ups alone.
  await putAs(job4._id, { ...empty, phone: ['93456 70041'], email: ['hr@zeta.in'], assignedTo: ['Aman Gupta'], remarks: 'Called' });
  assert.equal((await ContactOutcome.findOne({ job: job4._id, field: 'email' }).lean()).status, 'dnp');

  // Mistakes and sign-in.
  assert.equal((await put({ ...phone, student: 'X', status: 'constructor' })).status, 400);
  assert.equal((await put({ ...phone, field: 'fax', status: 'dnp' })).status, 400);
  assert.equal((await put({ ...phone })).status, 400, 'nothing to change');
  assert.deepEqual((await put({ ...phone, student: '', remove: true })).body, { error: 'Say which student to take it back from.' });
  assert.deepEqual((await put({ ...phone, student: ' ', add: true })).body, { error: 'Say which student to give it to.' });
  assert.equal((await put({ ...phone, job: '0123456789abcdef01234567', status: 'dnp' })).status, 404);
  assert.equal((await put({ ...phone, status: 'dnp' }, 'expired')).status, 401);
  assert.equal((await put({ ...phone, status: 'dnp' }, 'STUDENT:x@example.com')).status, 403);
});

test('saved at the same moment: a student and their remark are both kept; two students both get the number', async () => {
  const job2 = await Job.findOne({ fingerprint: 'f2' }).lean();
  const put = (body) =>
    fetch(`${base}/outcomes`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer PLACEMENT_STAFF:caller@example.com' }, body: JSON.stringify({ job: String(job2._id), field: 'phone', value: '98450 12345', ...body }) });
  const followUps = async () => (await ContactOutcome.find({ job: job2._id, field: 'phone' }).sort({ student: 1 }).lean()).map((o) => [o.student, o.status ?? '']);
  const [a, b] = await Promise.all([put({ student: 'Neha Verma', add: true }), put({ student: 'Neha Verma', status: 'cv-shared' })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual(await followUps(), [['Neha Verma', 'cv-shared']], 'one follow-up, with the remark');
  assert.ok((await Job.findById(job2._id).lean()).manual.assignedTo.includes('Neha Verma'));
  const [c, d] = await Promise.all([put({ student: 'Riya Sen', add: true }), put({ student: 'Dev Patel', add: true })]);
  assert.deepEqual([c.status, d.status], [200, 200]);
  assert.deepEqual(await followUps(), [['Dev Patel', ''], ['Neha Verma', 'cv-shared'], ['Riya Sen', '']]);
  const list = (await Job.findById(job2._id).lean()).manual.assignedTo;
  assert.ok(['Neha Verma', 'Riya Sen', 'Dev Patel'].every((s) => list.includes(s)), list);
  // As it was for the tests after this one: Neha only.
  await put({ student: 'Riya Sen', remove: true });
  await put({ student: 'Dev Patel', remove: true });
  assert.deepEqual(await followUps(), [['Neha Verma', 'cv-shared']]);
});

test('search box: companies however spelled, HR names, emails and phone numbers written any way, kept and left-out jobs', async () => {
  const now = Date.now();
  const job = (n, extra) => ({
    fingerprint: `srch${n}`, title: `Search Analyst ${n}`, company: 'Quokka Data Labs Pvt Ltd', course: 'data-analyst', cities: ['Pune'],
    firstSeenAt: new Date(now - n * HOUR), lastSeenAt: new Date(now - n * HOUR), primaryPlatform: 'Naukri', platforms: ['Naukri'],
    sourceKeys: [`SR:${n}`], links: { Naukri: `https://example.com/sr${n}` }, ...extra,
  });
  const [kept] = await Job.create([
    job(1, { manual: { phone: '+91 97001 23456', phoneKeys: ['9700123456'], email: 'meera.hr@quokka.in', hrNames: ['Meera Pillai'], updatedAt: new Date() } }),
    job(2, { company: 'Quokka Data Labs', course: 'data-science' }),
  ]);
  const [left] = await NonFilteredJob.create([job(3, { company: 'Quokka Data Labs India', leftOutBy: 'experience', foundPhones: ['080-4123-9876'] })]);
  const search = async (q, token = '') => {
    const res = await fetch(`${base}/search?q=${encodeURIComponent(q)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };
  try {
    // A company: once, all its spellings, kept and left out.
    let { body } = await search('quokka');
    assert.equal(body.kind, 'text');
    assert.deepEqual(body.companies.map((c) => [c.name, c.openings, c.leftOut]), [['Quokka Data Labs', 2, 1]], 'a tie between spellings: the shortest');
    assert.equal(body.companies[0].courses['data-science'], 1);
    assert.deepEqual(body.contacts.map((h) => h.matches), [[{ field: 'email', value: 'meera.hr@quokka.in' }]], 'its email matches the word too');

    // An HR name, any case.
    ({ body } = await search('meera'));
    assert.deepEqual(body.companies, []);
    assert.equal(body.contacts.length, 1);
    assert.equal(body.contacts[0].job._id, String(kept._id));
    assert.equal(body.contacts[0].set, 'filtered');
    assert.deepEqual(body.contacts[0].matches.map((m) => m.field), ['hrName', 'email']);
    assert.equal(body.contacts[0].job.contact.phone, '+91 97001 23456', 'the job comes as the job list shows it');

    // A phone number: with or without the country code, spaces or dashes, or just a part of it.
    for (const q of ['9700123456', '+91 97001-23456', '097001 23456', '001 2345']) {
      ({ body } = await search(q));
      assert.equal(body.kind, 'phone', q);
      assert.deepEqual(body.contacts.map((h) => h.matches[0].value), ['+91 97001 23456'], q);
    }
    ({ body } = await search('41239876'));
    assert.deepEqual(body.contacts.map((h) => [h.set, h.job._id, h.matches[0].value]), [['nonfiltered', String(left._id), '080-4123-9876']], 'a number from a left-out post');

    // Too short, nothing, signed out or a role that can't see.
    ({ body } = await search('9'));
    assert.equal(body.kind, 'short');
    assert.deepEqual([body.companies, body.contacts], [[], []]);
    ({ body } = await search('zzzz-nothing'));
    assert.deepEqual([body.companies, body.contacts], [[], []]);
    assert.equal((await search('quokka', 'expired')).status, 401);
    assert.equal((await search('quokka', 'STUDENT:x@example.com')).status, 403);

    // A company's openings (the search result, or a hiring partner): every spelling, newest first.
    const key = (await search('quokka')).body.companies[0].key;
    const jobsOf = async (params) => (await fetch(`${base}/companies/jobs?${new URLSearchParams({ key, ...params })}`)).json();
    let list = await jobsOf({ all: '1' });
    assert.deepEqual(list.items.map((j) => j.title), ['Search Analyst 1', 'Search Analyst 2', 'Search Analyst 3']);
    assert.equal(list.total, 3);
    assert.equal(list.name, 'Quokka Data Labs');
    assert.equal(list.items[2].leftOutBy, 'experience');
    list = await jobsOf({ days: '90' });
    assert.deepEqual(list.items.map((j) => j.title), ['Search Analyst 1', 'Search Analyst 2'], 'one set: the view\'s');
    assert.equal(list.days, 90);
    list = await jobsOf({ view: 'nonfiltered' });
    assert.deepEqual(list.items.map((j) => j.title), ['Search Analyst 3']);
    assert.equal((await fetch(`${base}/companies/jobs`)).status, 400);

    // Hiring partners say which key is theirs.
    const partner = (await (await fetch(`${base}/partners`)).json()).partners.find((p) => p.name.startsWith('Quokka'));
    assert.equal(partner.key, key);
  } finally {
    await Job.deleteMany({ fingerprint: /^srch/ });
    await NonFilteredJob.deleteMany({ fingerprint: /^srch/ });
  }
});

test('SRE Openings: SRE jobs of the period in the view\'s set (Filtered or Non-filtered), newest first, with both counts', async () => {
  const now = Date.now();
  const job = (n, title, hoursAgo, extra = {}) => ({
    fingerprint: `sre${n}`, title, company: `Reliable Co ${n}`, course: 'production-support', cities: ['Pune'],
    firstSeenAt: new Date(now - hoursAgo * HOUR), lastSeenAt: new Date(now - hoursAgo * HOUR), primaryPlatform: 'LinkedIn',
    platforms: ['LinkedIn'], sourceKeys: [`SRE:${n}`], links: { LinkedIn: `https://example.com/sre${n}` }, experienceMin: 3, ...extra,
  });
  await Job.create([
    job(1, 'Site Reliability Engineer', 1),
    job(2, 'Senior SRE - Kubernetes', 3),
    job(3, 'Systems Reliability Engineer II', 5),
    job(4, 'Quality & Reliability Engineer', 2), // hardware quality: not SRE
    job(5, 'Production Support Engineer', 2), // not SRE
    job(6, 'Site Reliability Lead', 24 * 20), // too old for the last day / 7 days
    job(9, 'Site Reliability Engineer III', 24 * 9), // the 7 days before the last 7
  ]);
  await NonFilteredJob.create([
    job(7, 'Site Reliability Engineer (SRE)', 4, { leftOutBy: 'extra-search', fromExtraSearch: true }),
    job(8, 'SRE Associate', 6, { leftOutBy: 'experience', experienceMin: 0 }),
  ]);
  const get = async (q, token = '') => {
    const res = await fetch(`${base}/role-jobs?${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };
  try {
    let { body } = await get('role=sre&days=7');
    assert.equal(body.role.name, 'SRE Openings');
    assert.equal(body.view, 'filtered');
    assert.deepEqual(body.items.map((j) => j.title), ['Site Reliability Engineer', 'Senior SRE - Kubernetes', 'Systems Reliability Engineer II']);
    assert.deepEqual([body.total, body.filtered, body.nonFiltered], [3, 3, 2], 'the view\'s count, and both sets\'');
    assert.ok(body.items.every((j) => j.leftOutBy === undefined));
    assert.ok(body.items[0].contact && body.items[0].links, 'jobs as the job list sends them');
    assert.deepEqual([body.previous, body.comparable], [1, true], 'the 7 days before, for "▲ vs previous 7 days"');

    ({ body } = await get('role=sre&days=7&view=nonfiltered'));
    assert.equal(body.view, 'nonfiltered');
    assert.deepEqual(body.items.map((j) => `${j.title}: ${j.leftOutBy}`), ['Site Reliability Engineer (SRE): extra-search', 'SRE Associate: experience']);
    assert.deepEqual([body.total, body.filtered, body.nonFiltered], [2, 3, 2]);

    ({ body } = await get('role=sre&days=30'));
    assert.equal(body.total, 5, 'the 9- and 20-day-old ones are in the last 30 days');
    assert.deepEqual([body.previous, body.comparable], [null, false], 'no daily collection 31-60 days ago');
    ({ body } = await get('role=sre&days=7&limit=2&page=2'));
    assert.deepEqual([body.items.map((j) => j.title), body.pages], [['Systems Reliability Engineer II'], 2]);

    // ServiceNow Openings (Hiring partners' count): ServiceNow in the title however it is spelled.
    await Job.create([job(20, 'ServiceNow Developer', 2), job(21, 'Package Consultant-ServiceNow', 30), job(22, 'Snowflake Data Engineer', 3)]);
    await NonFilteredJob.create([job(23, 'Service Now ITOM Admin', 4, { leftOutBy: 'big-company' })]);
    ({ body } = await get('role=servicenow&days=90&limit=1'));
    assert.equal(body.role.name, 'ServiceNow Openings');
    assert.deepEqual([body.total, body.filtered, body.nonFiltered, body.items.length], [2, 2, 1, 1], 'not Snowflake; a page of one is enough for a count');
    ({ body } = await get('role=servicenow&days=90&view=nonfiltered'));
    assert.deepEqual(body.items.map((j) => j.title), ['Service Now ITOM Admin']);
    ({ body } = await get('role=sre&days=7'));
    assert.equal(body.total, 3, 'ServiceNow jobs are not SRE');

    assert.equal((await get('role=nope&days=7')).status, 400);
    assert.equal((await get('role=sre&days=7', 'expired')).status, 401);
    assert.equal((await get('role=sre&days=7', 'STUDENT:x@example.com')).status, 403);
  } finally {
    await Job.deleteMany({ fingerprint: /^sre/ });
    await NonFilteredJob.deleteMany({ fingerprint: /^sre/ });
  }
});

test('"Remote" is never shown as a city (top cities, the city list, course pages); the stored jobs keep it', async () => {
  const now = Date.now();
  const remote = (n, cities) => ({
    fingerprint: `remote${n}`, title: `Data Analyst R${n}`, company: `Remote Co ${n}`, course: 'data-analyst', cities, isRemote: true,
    firstSeenAt: new Date(now - HOUR), lastSeenAt: new Date(now - HOUR), primaryPlatform: 'Indeed', platforms: ['Indeed'], sourceKeys: [`R:${n}`],
  });
  // Enough remote jobs to top the city ranking if it were counted.
  await Job.create([...Array.from({ length: 6 }, (_, i) => remote(i, ['Remote'])), remote(9, ['Jaipur', 'Remote'])]);
  await NonFilteredJob.create(remote(10, ['Remote']));
  const get = async (path) => (await fetch(`${base}/${path}`)).json();
  try {
    for (const view of ['filtered', 'nonfiltered']) {
      const insights = await get(`insights?days=1&view=${view}`);
      assert.ok(!insights.cities.some((c) => c.name === 'Remote'), `top cities (${view}): ${JSON.stringify(insights.cities)}`);
      assert.ok(!(await get(`meta?view=${view}`)).cities.includes('Remote'), `the city list (${view})`);
      assert.ok(!(await get(`course/data-analyst?days=1&view=${view}`)).cities.some((c) => c.name === 'Remote'), `course page (${view})`);
    }
    assert.ok((await get('insights?days=1')).cities.some((c) => c.name === 'Jaipur'), 'the other cities of a remote job still count');
    assert.equal(await Job.countDocuments({ cities: 'Remote' }), 7, 'stored jobs are unchanged');
    assert.equal(await NonFilteredJob.countDocuments({ cities: 'Remote' }), 1);
  } finally {
    await Job.deleteMany({ fingerprint: /^remote/ });
    await NonFilteredJob.deleteMany({ fingerprint: /^remote/ });
  }
});

test('a remark from the words the activity record keeps (remarkLabel the other way)', () => {
  assert.deepEqual(remarkOf('DNP'), { status: 'dnp', note: '' });
  assert.deepEqual(remarkOf('Wrong email'), { status: 'wrong', note: '' });
  assert.deepEqual(remarkOf('Others: call after 5 pm'), { status: 'other', note: 'call after 5 pm' });
  assert.deepEqual(remarkOf('Others'), { status: 'other', note: '' });
  assert.deepEqual([remarkOf('Busy'), remarkOf('Switched off')], [{ status: 'busy', note: '' }, { status: 'switched-off', note: '' }]);
  assert.equal(remarkOf(''), null);
  for (const status of Object.keys(REMARKS)) {
    for (const field of ['phone', 'email']) assert.equal(remarkOf(remarkLabel(field, status, status === 'other' ? 'x' : '')).status, status, `${status} (${field})`);
  }
});

test('Busy and Switched off are remarks: saved, recorded in words, shown in the report', async () => {
  const job = await Job.create({
    fingerprint: 'busy1', title: 'Data Analyst B', company: 'Busy Co', course: 'data-analyst', cities: ['Pune'],
    firstSeenAt: new Date(Date.now() - HOUR), lastSeenAt: new Date(Date.now() - HOUR), primaryPlatform: 'Naukri', platforms: ['Naukri'], sourceKeys: ['BZ:1'],
  });
  const put = async (body) => {
    const res = await fetch(`${base}/outcomes`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job: String(job._id), field: 'phone', ...body }) });
    return { status: res.status, body: await res.json() };
  };
  try {
    let res = await put({ value: '94000 00001', status: 'busy' });
    assert.deepEqual([res.status, res.body.outcome.status], [200, 'busy']);
    let entry = await Activity.findOne({ 'job.id': job._id }).sort({ at: -1, _id: -1 }).lean();
    assert.deepEqual(entry.changes.map((c) => [c.field, c.after]), [['contactRemark', ['Busy']]]);
    res = await put({ value: '94000 00001', status: 'switched-off' });
    assert.equal(res.body.outcome.status, 'switched-off');
    entry = await Activity.findOne({ 'job.id': job._id }).sort({ at: -1, _id: -1 }).lean();
    assert.deepEqual(entry.changes.map((c) => [c.field, c.before, c.after]), [['contactRemark', ['Busy'], ['Switched off']]]);
    assert.equal((await put({ value: '94000 00001', status: 'asleep' })).body.error, 'Remark: choose one from the list.', 'only the list');
  } finally {
    await Job.deleteOne({ _id: job._id });
    await Activity.deleteMany({ 'job.id': job._id });
    await ContactOutcome.deleteMany({ job: job._id });
  }
});

test('review board: each number with each student it was given to (or with feedback) in the period, and the numbers not given out yet', async () => {
  const DAY = 24 * HOUR;
  const job = await Job.create({
    fingerprint: 'review1', title: 'Data Analyst R', company: 'Review Co', course: 'data-analyst', cities: ['Pune'],
    firstSeenAt: new Date(Date.now() - HOUR), lastSeenAt: new Date(Date.now() - HOUR), primaryPlatform: 'Naukri', platforms: ['Naukri'],
    sourceKeys: ['RV:1'], foundPhones: ['+91 90000 11111'],
  });
  const caller = 'PLACEMENT_STAFF:caller2@example.com';
  const outcome = async (body) => {
    const res = await fetch(`${base}/outcomes`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${caller}` }, body: JSON.stringify({ job: String(job._id), ...body }) });
    assert.equal(res.status, 200, JSON.stringify(body));
  };
  const review = async (query) => (await fetch(`${base}/review?${query}`)).json();
  try {
    // A researcher adds two numbers and an email to the job (one number is never given out); its post had a
    // number of its own.
    assert.equal((await putAs(job._id, { ...empty, phone: ['93000 00001', '93000 00002'], email: ['hr@review.in'] }, 'RESEARCH_TEAM:finder@example.com')).status, 200);
    // Given out and called today.
    await outcome({ field: 'phone', value: '93000 00001', student: 'Riya' });
    await outcome({ field: 'phone', value: '93000 00001', status: 'cv-shared' });
    // ...and to a second student, whose call has a remark of its own.
    await outcome({ field: 'phone', value: '93000 00001', student: 'Sam', add: true });
    await outcome({ field: 'phone', value: '93000 00001', student: 'Sam', status: 'dnp' });
    await outcome({ field: 'email', value: 'hr@review.in', student: 'Aman' });
    await outcome({ field: 'phone', value: '90000 11111', student: 'Neha' });
    await outcome({ field: 'phone', value: '90000 11111', status: 'other', note: 'Out of service' });
    // Given out, then taken back: not given out.
    await outcome({ field: 'phone', value: '98888 77777', student: 'Dev' });
    await outcome({ field: 'phone', value: '98888 77777', student: 'Dev', remove: true });
    // Given out three days ago (an older record); its feedback today.
    const old = new Date(Date.now() - 3 * DAY);
    await Activity.create({
      at: old,
      actor: { userId: 'user_old', email: 'Old.Caller@example.com', name: 'Old Caller', role: 'PLACEMENT_STAFF' },
      action: 'added',
      job: { id: job._id, set: 'filtered', title: job.title, company: job.company, course: job.course },
      changes: [{ field: 'contactStudent', change: 'added', before: [], after: ['Kiran'], added: ['Kiran'], removed: [], contact: { field: 'email', value: 'old@review.in' } }],
    });
    await ContactOutcome.create({ job: job._id, field: 'email', key: 'old@review.in', value: 'old@review.in', student: 'Kiran', updatedAt: old });
    await outcome({ field: 'email', value: 'old@review.in', status: 'wrong' }); // a remark alone: the only student's

    const today = await review('days=1');
    const mine = today.rows.filter((r) => String(r.job.id) === String(job._id));
    const rowOf = (value, student) => mine.find((r) => r.value === value && r.student === student);
    assert.deepEqual(mine.map((r) => `${r.value} ${r.student}`).sort(), [
      '90000 11111 Neha', '93000 00001 Riya', '93000 00001 Sam', '93000 00002 ', 'hr@review.in Aman', 'old@review.in Kiran',
    ], 'a row per number and student; the number taken back from Dev is not there');
    assert.equal(today.rows[0].value, 'old@review.in', 'the latest first');
    const a = rowOf('93000 00001', 'Riya');
    assert.deepEqual([a.found.source, a.found.by.email], ['team', 'finder@example.com'], 'found by the person who added it');
    assert.deepEqual([a.given.student, a.given.by.email, a.given.inPeriod], ['Riya', 'caller2@example.com', true]);
    assert.deepEqual([a.feedback.status, a.feedback.label, a.feedback.by.email], ['cv-shared', 'CV shared', 'caller2@example.com']);
    assert.ok(a.feedback.hours >= 0 && a.feedback.hours < 0.1, `called right after it was given out: ${a.feedback.hours} h`);
    assert.deepEqual([a.now.student, a.now.status, a.job.course, a.job.company, a.withStudents], ['Riya', 'cv-shared', 'data-analyst', 'Review Co', 2]);
    const sam = rowOf('93000 00001', 'Sam');
    assert.deepEqual([sam.given.student, sam.feedback.status, sam.now.status, sam.contact], ['Sam', 'dnp', 'dnp', a.contact], "the same number, Sam's own call");
    const b = rowOf('hr@review.in', 'Aman');
    assert.deepEqual([b.given.student, b.feedback, b.now.status], ['Aman', null, ''], 'given out, no feedback yet');
    assert.deepEqual([a.added.by.email, b.added.by.email], ['finder@example.com', 'finder@example.com'], 'added by the team today');
    const n = rowOf('93000 00002', '');
    assert.deepEqual([n.added.by.email, n.found.source, n.given, n.feedback, n.now, n.withStudents], ['finder@example.com', 'team', null, null, null, 0], 'added today, not given out yet');
    const c = rowOf('90000 11111', 'Neha');
    assert.deepEqual([c.found.source, c.found.by, c.feedback.status, c.feedback.note, c.added], ['post', null, 'other', 'Out of service', null], 'found in the job post: not added by anyone');
    const d = rowOf('old@review.in', 'Kiran');
    assert.deepEqual([d.found.source, d.given.student, d.given.inPeriod, d.given.by.email, d.feedback.label, d.feedback.status], ['earlier', 'Kiran', false, 'old.caller@example.com', 'Wrong email', 'wrong']);
    assert.ok(Math.abs(d.feedback.hours - 72) < 0.1, `hours from given out to feedback: ${d.feedback.hours}`);

    // That day three days ago: given out then; today's feedback is not in that period.
    const day = new Date(old.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const then = await review(`from=${day}&to=${day}`);
    const e = then.rows.find((r) => r.value === 'old@review.in');
    assert.deepEqual([e.given.inPeriod, e.given.student, e.feedback], [true, 'Kiran', null]);
    assert.ok(!then.rows.some((r) => r.value === '93000 00001'));
    assert.equal((await review('days=7')).rows.filter((r) => String(r.job.id) === String(job._id)).length, 6);

    assert.equal((await fetch(`${base}/review?days=1`, { headers: { Authorization: 'Bearer expired' } })).status, 401, 'signed-in people only');
  } finally {
    await Job.deleteOne({ _id: job._id });
    await Activity.deleteMany({ 'job.id': job._id });
    await ContactOutcome.deleteMany({ job: job._id });
  }
});
