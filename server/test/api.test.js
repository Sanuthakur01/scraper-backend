// The course page's numbers must agree with the dashboard tile and add up.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { config } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { CollectorRun, Job } from '../src/models.js';
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
  await Job.init();
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
  assert.match(csv.split('\r\n')[0], /Listed on,Phone,Email,Remarks,/);
  assert.match(csv, /98765 43210,"hr@company1.com, anil@company1.com",Called; send CVs Monday/);

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

test('placement: status, students and number placed are saved; the placed date stays when saved again', async () => {
  const job3 = await Job.findOne({ fingerprint: 'f3' }).lean();
  assert.match((await (await putFollowUp(job3._id, { status: 'hired' })).json()).error, /^Status:/);
  assert.match((await (await putFollowUp(job3._id, { status: 'placed', placedCount: 0 })).json()).error, /^Placed:/);

  let row = await (await putFollowUp(job3._id, { status: 'cvs-sent', students: 'Asha, Ravi' })).json();
  assert.deepEqual(row.placement, { status: 'cvs-sent', students: 'Asha, Ravi', placedCount: 0, placedAt: null });

  row = await (await putFollowUp(job3._id, { status: 'placed', students: 'Asha, Ravi', placedCount: 2 })).json();
  assert.equal(row.placement.placedCount, 2);
  const placedAt = row.placement.placedAt;
  assert.ok(placedAt);
  row = await (await putFollowUp(job3._id, { status: 'placed', students: 'Asha, Ravi', placedCount: 2, remarks: 'Joining 1 Nov' })).json();
  assert.equal(row.placement.placedAt, placedAt, 'saving again keeps the placed date');
  assert.equal(row.contact.remarks, 'Joining 1 Nov');

  const placements = await (await fetch(`${base}/placements`)).json();
  const analyst = placements.courses.find((c) => c.id === 'data-analyst');
  assert.equal(analyst.placedThisMonth, 2);
  assert.equal(analyst.placedTotal, 2);
  assert.equal(placements.total.placedThisMonth, 2);

  // A status filter lists jobs from any date (placement work goes on after a job is new).
  await Job.updateOne({ _id: job3._id }, { $set: { firstSeenAt: new Date(Date.now() - 60 * 24 * HOUR) } });
  const inPeriod = await (await fetch(`${base}/jobs?days=1`)).json();
  assert.ok(!inPeriod.items.some((j) => j._id === String(job3._id)), 'old job not in the 1-day list');
  const working = await (await fetch(`${base}/jobs?days=1&status=any`)).json();
  assert.ok(working.items.some((j) => j._id === String(job3._id)), 'but listed with a status filter');
  const placedOnly = await (await fetch(`${base}/jobs?days=1&status=placed`)).json();
  assert.deepEqual(placedOnly.items.map((j) => j._id), [String(job3._id)]);
  const csv = await (await fetch(`${base}/jobs.csv?days=1&status=placed`)).text();
  assert.match(csv.split('\r\n')[0], /Remarks,Placement status,Students,Placed,/);
  assert.match(csv, /Placed,"Asha, Ravi",2,/);
  await Job.updateOne({ _id: job3._id }, { $set: { firstSeenAt: new Date(Date.now() - HOUR) } });

  // Clearing everything removes the typed-in details, placement included.
  row = await (await putFollowUp(job3._id, {})).json();
  assert.deepEqual(row.placement, { status: '', students: '', placedCount: 0, placedAt: null });
  assert.equal((await fetch(`${base}/placements`).then((r) => r.json())).total.placedTotal, 0);
});

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

  await CollectorRun.create({ startedAt: new Date(now - 20 * 24 * HOUR), finishedAt: new Date(now - 20 * 24 * HOUR), status: 'success' });
  report = await (await fetch(`${base}/report`)).json();
  assert.equal(report.comparable, true);
  assert.equal(report.courses.find((c) => c.id === 'data-analyst').previous, 0);
});

test('hiring partners: employers with 2+ openings, their HR contacts and placements', async () => {
  const acme = await Job.findOne({ fingerprint: 'acme1' }).lean();
  assert.equal((await putFollowUp(acme._id, { phone: '91234 00001', email: 'hr@acme.in', status: 'placed', placedCount: 1 })).status, 200);
  await Job.updateOne({ fingerprint: 'acme2' }, { $set: { foundEmails: ['careers@acme.in'], manual: { status: 'interview', statusAt: new Date() } } });

  const list = await (await fetch(`${base}/partners`)).json();
  assert.equal(list.minOpenings, 2);
  assert.deepEqual(list.partners.map((p) => p.name), ['Acme Analytics'], 'one-off employers are not listed');
  const [partner] = list.partners;
  assert.equal(partner.openings, 2);
  assert.equal(partner.courses['data-analyst'], 2);
  assert.deepEqual(partner.cities, ['Pune']);
  assert.deepEqual(partner.phones, ['91234 00001']);
  assert.deepEqual(partner.emails, ['hr@acme.in', 'careers@acme.in'], 'typed in first, then found in postings');
  assert.deepEqual([partner.placed, partner.inProgress], [1, 1]);

  const csv = await (await fetch(`${base}/partners.csv`)).text();
  assert.match(csv.split('\r\n')[0], /^\uFEFF?Company,Openings,Data Analyst,/);
  assert.match(csv, /Acme Analytics,2,2,0,0,0,Pune,\d{4}-\d\d-\d\d,91234 00001,hr@acme.in; careers@acme.in,1,1/);
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
