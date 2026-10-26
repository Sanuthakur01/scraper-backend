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
    job(3, { primaryPlatform: 'Naukri', platforms: ['Naukri'], postedAt: null, experienceMin: 2, experienceBand: '2', cities: ['Remote'], isRemote: true }),
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
  assert.equal(course.remote, 1);
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

test('a day without a collection run is never compared (it would look like a huge jump)', async () => {
  const DAY = 24 * HOUR;
  const IST = 330 * 60_000;
  const todayStart = Math.floor((Date.now() + IST) / DAY) * DAY - IST; // midnight IST, as a timestamp
  const yesterday = { startedAt: { $gte: new Date(todayStart - DAY), $lt: new Date(todayStart) } };
  const runs = await CollectorRun.find(yesterday).lean();
  assert.ok(runs.length, 'the earlier tests collected yesterday');
  assert.equal((await (await fetch(`${base}/summary?days=1`)).json()).comparable, true, 'collected yesterday and today');

  await CollectorRun.deleteMany(yesterday);
  try {
    const summary = await (await fetch(`${base}/summary?days=1`)).json();
    assert.equal(summary.comparable, false, 'nothing was collected yesterday');
    assert.deepEqual(summary.previous, {});
    assert.equal((await (await fetch(`${base}/course/data-analyst?days=1`)).json()).previous, 0);
  } finally {
    await CollectorRun.insertMany(runs);
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

test('follow-up of each number/email: a student and a remark, saved one at a time, on the job too, recorded, shown in the report', async () => {
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

  // A student: saved, and put on the job's "Assigned to" list; recorded under the caller's email.
  let res = await put({ ...phone, student: 'Kavya Rao' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.outcome.student, res.body.outcome.status, res.body.assignedTo], ['Kavya Rao', '', ['Kavya Rao']]);
  assert.deepEqual(await students(), ['Kavya Rao']);
  let entry = await latest();
  assert.equal(entry.actor.email, 'caller@example.com');
  assert.deepEqual(entry.changes.map((c) => [c.field, c.change, c.after, c.contact?.value]), [
    ['contactStudent', 'added', ['Kavya Rao'], '93456 70041'],
    ['assignedTo', 'added', ['Kavya Rao'], undefined],
  ]);

  // A remark, then "Others" in their own words (which must be typed).
  res = await put({ ...phone, status: 'dnp' });
  assert.deepEqual([res.body.outcome.student, res.body.outcome.status], ['Kavya Rao', 'dnp'], 'the student is kept');
  assert.deepEqual((await latest()).changes.map((c) => [c.field, c.change, c.after]), [['contactRemark', 'added', ['DNP']]]);
  assert.deepEqual((await put({ ...phone, status: 'other', note: '  ' })).body, { error: 'Remark: type what happened (Others).' });
  res = await put({ ...phone, status: 'other', note: 'Call after 5 pm' });
  entry = await latest();
  assert.deepEqual(entry.changes.map((c) => [c.field, c.change, c.before, c.after]), [['contactRemark', 'edited', ['DNP'], ['Others: Call after 5 pm']]]);
  const count = await Activity.countDocuments();
  await put({ ...phone, status: 'other', note: 'Call after 5 pm' });
  assert.equal(await Activity.countDocuments(), count, 'saved as it was: nothing recorded');

  // The email: "Wrong number" reads "Wrong email"; given to Aman.
  await put({ ...email, status: 'wrong' });
  assert.deepEqual((await latest()).changes[0].after, ['Wrong email']);
  await put({ ...email, student: 'Aman Gupta' });
  assert.deepEqual(await students(), ['Kavya Rao', 'Aman Gupta']);

  // The report: each row with its follow-up, and the students to suggest.
  const report = await (await fetch(`${base}/performance?days=1`)).json();
  const rowOf = (value) => report.rows.find((r) => r.value === value && String(r.job.id) === String(job4._id));
  assert.deepEqual(
    [rowOf('93456 70041').key, rowOf('93456 70041').outcome.student, rowOf('93456 70041').outcome.status, rowOf('93456 70041').outcome.note, rowOf('93456 70041').outcome.updatedBy.email],
    ['9345670041', 'Kavya Rao', 'other', 'Call after 5 pm', 'caller@example.com'],
  );
  assert.deepEqual([rowOf('hr@zeta.in').outcome.student, rowOf('hr@zeta.in').outcome.status], ['Aman Gupta', 'wrong']);
  assert.ok(report.students.includes('Kavya Rao') && report.students.includes('Aman Gupta'));
  assert.ok(report.rows.every((r) => r.field === 'phone' || r.field === 'email'), 'follow-ups are not counted as contact details added');

  // The same number written another way is the same number; the phone goes to Aman: Kavya leaves the
  // job's list (no other number/email of it is hers), Aman stays once.
  res = await put({ ...phone, value: '+91 93456 70041', student: 'aman gupta' });
  assert.equal(res.body.outcome.status, 'other', 'same record');
  assert.deepEqual(await students(), ['Aman Gupta']);
  entry = await latest();
  assert.deepEqual(entry.changes.map((c) => [c.field, c.change, c.added, c.removed]), [
    ['contactStudent', 'edited', ['aman gupta'], ['Kavya Rao']],
    ['assignedTo', 'edited', [], ['Kavya Rao']],
  ]);
  // Taken off the phone, Aman stays on the job: the email is still his.
  await put({ ...phone, student: '' });
  assert.deepEqual(await students(), ['Aman Gupta']);
  // Nothing left on the phone: its follow-up is removed.
  res = await put({ ...phone, status: '' });
  assert.equal(res.body.outcome, null);
  assert.equal(await ContactOutcome.countDocuments({ job: job4._id, field: 'phone' }), 0);

  // Editing the job's details in its window leaves the follow-ups alone.
  await putAs(job4._id, { ...empty, phone: ['93456 70041'], email: ['hr@zeta.in'], assignedTo: ['Aman Gupta'], remarks: 'Called' });
  assert.equal((await ContactOutcome.findOne({ job: job4._id, field: 'email' }).lean()).status, 'wrong');

  // Mistakes and sign-in.
  assert.equal((await put({ ...phone, status: 'constructor' })).status, 400);
  assert.equal((await put({ ...phone, field: 'fax', status: 'dnp' })).status, 400);
  assert.equal((await put({ ...phone })).status, 400, 'nothing to change');
  assert.equal((await put({ ...phone, job: '0123456789abcdef01234567', status: 'dnp' })).status, 404);
  assert.equal((await put({ ...phone, status: 'dnp' }, 'expired')).status, 401);
  assert.equal((await put({ ...phone, status: 'dnp' }, 'STUDENT:x@example.com')).status, 403);
});

test('a student and a remark saved at the same moment are both kept', async () => {
  const job2 = await Job.findOne({ fingerprint: 'f2' }).lean();
  const put = (body) =>
    fetch(`${base}/outcomes`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer PLACEMENT_STAFF:caller@example.com' }, body: JSON.stringify({ job: String(job2._id), field: 'phone', value: '98450 12345', ...body }) });
  const [a, b] = await Promise.all([put({ student: 'Neha Verma' }), put({ status: 'cv-shared' })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const saved = await ContactOutcome.findOne({ job: job2._id, field: 'phone' }).lean();
  assert.deepEqual([saved.student, saved.status], ['Neha Verma', 'cv-shared']);
  assert.ok((await Job.findById(job2._id).lean()).manual.assignedTo.includes('Neha Verma'));
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

    ({ body } = await get('role=sre&days=7&view=nonfiltered'));
    assert.equal(body.view, 'nonfiltered');
    assert.deepEqual(body.items.map((j) => `${j.title}: ${j.leftOutBy}`), ['Site Reliability Engineer (SRE): extra-search', 'SRE Associate: experience']);
    assert.deepEqual([body.total, body.filtered, body.nonFiltered], [2, 3, 2]);

    ({ body } = await get('role=sre&days=30'));
    assert.equal(body.total, 4, 'the 20-day-old one is in the last 30 days');
    ({ body } = await get('role=sre&days=7&limit=2&page=2'));
    assert.deepEqual([body.items.map((j) => j.title), body.pages], [['Systems Reliability Engineer II'], 2]);

    assert.equal((await get('role=nope&days=7')).status, 400);
    assert.equal((await get('role=sre&days=7', 'expired')).status, 401);
    assert.equal((await get('role=sre&days=7', 'STUDENT:x@example.com')).status, 403);
  } finally {
    await Job.deleteMany({ fingerprint: /^sre/ });
    await NonFilteredJob.deleteMany({ fingerprint: /^sre/ });
  }
});
