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
import { CollectorRun, Job, NonFilteredJob } from '../src/models.js';
import { parseFollowUpInput } from '../src/api/followUp.js';
import { COURSES } from '../src/config/courses.js';
import { SKILL_NAMES } from '../src/normalize.js';

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
  server = createApp().listen(0);
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
  assert.match(csv.split('\r\n')[0], /Listed on,Phone,Email,Assigned to,Remarks,/);
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

test('several phone numbers and emails, one per box: up to 5 each, kept once, a wrong one named', () => {
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

  const six = ['90000 00001', '90000 00002', '90000 00003', '90000 00004', '90000 00005', '90000 00006'];
  assert.equal(parseFollowUpInput({ phone: six.slice(0, 5) }).value.phoneKeys.length, 5);
  assert.equal(parseFollowUpInput({ phone: six }).error, 'Phone: at most 5 numbers per job.');
  assert.equal(parseFollowUpInput({ email: six.map((_, i) => `hr${i}@acme.in`) }).error, 'Email: at most 5 addresses per job.');
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

test('weekly report: the last 7 days per course, top companies by employer, real cities, and no comparison without a full earlier week', async () => {
  const now = Date.now();
  const acme = (n, company) => ({
    fingerprint: `acme${n}`, title: `BI Analyst ${n}`, company, course: 'data-analyst', cities: n === 1 ? ['Pune'] : ['India (city not stated)'],
    firstSeenAt: new Date(now - 3 * HOUR), lastSeenAt: new Date(now - 3 * HOUR), sourceKeys: [`AC:${n}`],
    primaryPlatform: 'LinkedIn', platforms: ['LinkedIn'], skills: ['SQL', 'Power BI'],
  });
  await Job.create([acme(1, 'Acme Analytics Pvt Ltd'), acme(2, 'Acme Analytics')]);

  let report = await (await fetch(`${base}/report`)).json();
  const analyst = report.courses.find((c) => c.id === 'data-analyst');
  const summary = await (await fetch(`${base}/summary?days=7`)).json();
  assert.equal(analyst.count, summary.current['data-analyst'], 'same count as the dashboard tile for 7 days');
  assert.equal(report.total, Object.values(summary.current).reduce((a, b) => a + b, 0));
  assert.equal(report.comparable, false, 'collection started inside the earlier week');
  assert.equal(analyst.previous, null);
  assert.deepEqual(analyst.skills.slice(0, 2), ['Power BI', 'SQL']);
  assert.deepEqual(report.companies[0], { name: 'Acme Analytics', count: 2 }, 'both spellings are one employer, shown by the shorter one');
  assert.ok(report.cities.every((c) => c.name !== 'India (city not stated)' && c.name !== 'Remote'));
  assert.ok(report.from && report.to && report.brand && report.lastRefreshed);

  // Daily collection began 20 days ago, with a run every day of the last two weeks.
  await CollectorRun.create({ startedAt: new Date(now - 20 * 24 * HOUR), finishedAt: new Date(now - 20 * 24 * HOUR), status: 'success' });
  report = await (await fetch(`${base}/report`)).json();
  assert.equal(report.comparable, false, 'one early run is not daily collection');
  await CollectorRun.create(
    Array.from({ length: 14 }, (_, k) => ({ startedAt: new Date(now - k * 24 * HOUR), finishedAt: new Date(now - k * 24 * HOUR), status: 'success' })),
  );
  report = await (await fetch(`${base}/report`)).json();
  assert.equal(report.comparable, true);
  assert.equal(report.courses.find((c) => c.id === 'data-analyst').previous, 0);
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
  const server2 = createApp().listen(0);
  try {
    const api = `http://localhost:${server2.address().port}/api`;
    const preflight = await fetch(`${api}/jobs/0123456789abcdef01234567/follow-up`, {
      method: 'OPTIONS',
      headers: { Origin: dashboard, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), dashboard);
    assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
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
  // A stand-in for the built dashboard: the build has a folder named like each page (report/), which
  // must not hide the page itself (report.html). The dashboard's links send HEAD /report/ before
  // prefetching a page.
  const root = await mkdtemp(path.join(os.tmpdir(), 'ijf-out-'));
  const out = path.join(root, 'client', 'out');
  await mkdir(path.join(out, 'report'), { recursive: true });
  await writeFile(path.join(out, 'report.html'), '<p>report</p>');
  await writeFile(path.join(out, 'index.html'), '<p>home</p>');
  const saved = config.rootDir;
  config.rootDir = root;
  const server2 = createApp().listen(0);
  try {
    const site = `http://localhost:${server2.address().port}`;
    for (const url of ['/report', '/report/']) {
      const page = await fetch(site + url);
      assert.equal(page.status, 200, `GET ${url}`);
      assert.equal(await page.text(), '<p>report</p>');
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
  for (const { name, count } of insights.companies) await same({ days: 7, company: name }, count, `company ${name}`);
  for (const { name, count } of insights.cities) await same({ days: 7, city: name }, count, `city ${name}`);
  for (const [band, count] of Object.entries(insights.experience).filter(([band]) => band !== 'null')) {
    await same({ days: 7, exp: band }, count, `${band} years`);
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
    'skill-gaps?course=data-analyst&days=7', 'report', 'partners', 'jobs?days=30&limit=100'];
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
