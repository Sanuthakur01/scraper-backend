// Incoming calls: logging one adds the HR number to the opening (so it can be given out), says which companies are
// in our HR database, and marks the calling companies' numbers for Assign numbers.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { connectDb, disconnectDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { Activity, IncomingCall, Job, NonFilteredJob } from '../src/models.js';
import { forgetPortalKeys, parseCallInput } from '../src/incomingCalls.js';
import { roleFrom } from '../src/config/access.js';

// No Authorization header: a signed-in admin; "Bearer <role>:<email>" signs in that person.
const TESTER = { userId: 'user_tester', email: 'tester@example.com', name: 'Test Admin', role: 'ADMIN' };
async function fakeIdentify(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!token) return TESTER;
  const [role, email] = token.split(':');
  return { userId: `user_${email}`, email, name: '', role: roleFrom({ role }) };
}

const HOUR = 3_600_000;
let mongo;
let server;
let base;
let alpha; // Alpha Analytics: a stored job with a number found in its post
let beta; // Beta Systems: a stored job whose HR number is already typed in

before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  await Promise.all([Job.init(), NonFilteredJob.init()]);
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
  [alpha, beta] = await Job.create([
    job(1, { company: 'Alpha Analytics Pvt Ltd', foundPhones: ['+91 98450 12345'] }),
    job(2, { company: 'Beta Systems', manual: { phone: '91234 56780', phoneKeys: ['9123456780'], foundBy: 'apollo', updatedAt: new Date(now - HOUR) } }),
  ]);
  await NonFilteredJob.create(job(3, { company: 'Gamma Tech', title: 'Production Support Engineer', course: 'production-support' }));
  forgetPortalKeys();
  server = createApp({ identify: fakeIdentify }).listen(0);
  base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  await disconnectDb();
  await mongo?.stop();
});

const post = (body, token) =>
  fetch(`${base}/incoming-calls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = async (path) => (await fetch(`${base}/${path}`)).json();

test('the form: number, company and course needed; a phone number, a known course, a time not ahead or too late', () => {
  const now = new Date('2026-11-02T10:00:00Z');
  const ok = { phone: '98765 43210', company: 'Alpha Analytics', course: 'data-analyst' };
  assert.match(parseCallInput({ ...ok, phone: '' }, now).error, /^HR number: enter/);
  assert.match(parseCallInput({ ...ok, phone: 'call me' }, now).error, /is not a phone number/);
  assert.match(parseCallInput({ ...ok, company: ' ' }, now).error, /^Company: enter/);
  assert.match(parseCallInput({ ...ok, company: 'Pvt Ltd' }, now).error, /is not a company name/);
  assert.match(parseCallInput({ ...ok, course: 'cooking' }, now).error, /^Course:/);
  assert.match(parseCallInput({ ...ok, email: 'hr@' }, now).error, /^HR email:/);
  assert.match(parseCallInput({ ...ok, source: 'fax' }, now).error, /^Found on:/);
  assert.match(parseCallInput({ ...ok, outcome: 'maybe' }, now).error, /^Outcome:/);
  assert.match(parseCallInput({ ...ok, at: '2026-11-02T12:00:00Z' }, now).error, /future/);
  assert.match(parseCallInput({ ...ok, at: '2026-10-20T10:00:00Z' }, now).error, /up to 7 days/);
  const { value } = parseCallInput({ ...ok, hrName: '  Riya  Shah ' }, now);
  assert.equal(value.hrName, 'Riya Shah');
  assert.equal(value.source, 'naukri', 'Naukri unless said');
  assert.equal(value.companyKey, 'alpha analytics');
  assert.equal(value.phoneKey, '9876543210');
  assert.equal(value.addToJob, true);
  assert.equal(value.at, now);
});

test('a call about a stored opening: its HR number, name and email are added to it (Found by "Incoming call"), recorded', async () => {
  const res = await post({
    phone: '98111 22233',
    hrName: 'Riya Shah',
    email: 'riya@alpha.in',
    company: 'Alpha Analytics',
    jobId: String(alpha._id),
    course: 'data-analyst',
    student: 'Aman Verma',
    outcome: 'interview',
  });
  assert.equal(res.status, 201);
  const call = await res.json();
  assert.equal(call.inPortal, true);
  assert.deepEqual(call.number, { added: true, job: { id: String(alpha._id), set: 'filtered', title: 'Data Analyst 1', company: 'Alpha Analytics Pvt Ltd' } });
  assert.deepEqual(call.job, { id: String(alpha._id), set: 'filtered', title: 'Data Analyst 1', course: 'data-analyst' });
  assert.equal(call.createdBy.email, 'tester@example.com');

  const stored = await Job.findById(alpha._id).lean();
  assert.equal(stored.manual.phone, '+91 98450 12345, 98111 22233', "the post's number kept, the caller's added");
  assert.deepEqual(stored.manual.hrNames, ['Riya Shah']);
  assert.equal(stored.manual.email, 'riya@alpha.in');
  assert.equal(stored.manual.foundBy, 'incoming-call');
  const record = await Activity.findOne({ 'job.id': alpha._id }).lean();
  assert.equal(record.actor.email, 'tester@example.com');
  assert.deepEqual(record.changes.find((c) => c.field === 'phone').added, ['98111 22233'], 'only the new number counts as added');

  // Logging another call from the same number: it's on the opening already, nothing added twice.
  const again = await (await post({ phone: '+91 98111 22233', company: 'Alpha Analytics', jobId: String(alpha._id), course: 'data-analyst' })).json();
  assert.equal(again.number.added, false);
  assert.equal(again.number.job.id, String(alpha._id));
  assert.equal(await Activity.countDocuments({ 'job.id': alpha._id }), 1);
});

test('a number already saved on another job is not added again: the call says which job has it', async () => {
  const call = await (await post({ phone: '91234 56780', company: 'Alpha Analytics', jobId: String(alpha._id), course: 'data-analyst' })).json();
  assert.equal(call.number.added, false);
  assert.equal(call.number.job.company, 'Beta Systems');
  assert.doesNotMatch((await Job.findById(alpha._id).lean()).manual.phone, /91234/);
  // No opening chosen: the call still finds where the number is.
  const loose = await (await post({ phone: '91234 56780', company: 'Beta Systems', course: 'data-analyst' })).json();
  assert.equal(loose.number.job.id, String(beta._id));
  assert.equal(loose.inPortal, true, 'Beta Systems is in our HR database');
});

test('companies in our HR database however spelled (left-out jobs too); a new company is kept, marked not in it', async () => {
  const typed = await (await post({ phone: '99887 76655', company: 'gamma tech pvt. ltd.', course: 'production-support' })).json();
  assert.equal(typed.inPortal, true);
  assert.equal(typed.number, null, 'no opening chosen and the number is new: nothing to add');
  const fresh = await (await post({ phone: '90000 11111', company: 'Zeta Fintech', course: 'data-science', source: 'linkedin' })).json();
  assert.equal(fresh.inPortal, false);
  const wrongJob = await post({ phone: '90000 11112', company: 'Zeta Fintech', jobId: String(alpha._id), course: 'data-analyst' });
  assert.equal(wrongJob.status, 400);
  assert.match((await wrongJob.json()).error, /is not at Zeta Fintech/);
  const list = await get('incoming-calls?days=1');
  assert.equal(list.items[0].company, 'Zeta Fintech', 'newest first');
  assert.deepEqual(
    list.items.filter((c) => !c.inPortal).map((c) => c.company),
    ['Zeta Fintech'],
  );
  assert.ok(list.students.includes('Aman Verma'), "the calls' students are suggested");
});

test('Assign numbers: the companies in our HR database that called, and their numbers added lately', async () => {
  const hot = await get('incoming-calls/hot');
  assert.equal(hot.days, 7);
  assert.deepEqual(hot.companies.map((c) => c.key).sort(), ['alpha analytics', 'beta systems', 'gamma tech']);
  const alphaCompany = hot.companies.find((c) => c.key === 'alpha analytics');
  assert.equal(alphaCompany.calls, 3);
  assert.deepEqual(alphaCompany.students, ['Aman Verma']);
  assert.deepEqual(
    hot.rows.map((r) => [r.job.company, r.field, r.value]).sort(),
    [
      ['Alpha Analytics Pvt Ltd', 'email', 'riya@alpha.in'],
      ['Alpha Analytics Pvt Ltd', 'phone', '98111 22233'],
    ],
  );
  assert.equal(hot.rows[0].foundBy, 'Incoming call', "the Found by label, as the Performance report shows it");
});

test('the outcome can be set later; only the person who logged a call, or an admin, removes it', async () => {
  const { id } = await (await post({ phone: '90000 22222', company: 'Zeta Fintech', course: 'data-science' }, 'PLACEMENT_STAFF:priya@ijf.in')).json();
  const changed = await (await fetch(`${base}/incoming-calls/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'cv-shared' }) })).json();
  assert.equal(changed.outcome, 'cv-shared');
  const bad = await fetch(`${base}/incoming-calls/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'soon' }) });
  assert.equal(bad.status, 400);
  const other = await fetch(`${base}/incoming-calls/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer RESEARCH_TEAM:ravi@ijf.in' } });
  assert.equal(other.status, 403);
  const own = await fetch(`${base}/incoming-calls/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer PLACEMENT_STAFF:priya@ijf.in' } });
  assert.equal(own.status, 200);
  assert.equal(await IncomingCall.countDocuments({ _id: id }), 0);
});
