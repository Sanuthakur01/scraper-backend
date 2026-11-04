// The same company's other jobs: "Hiring again" and the HR contact saved on another of its jobs, which "Use this
// HR" copies to a new opening. A number may then be on several jobs of the same company (never on another
// company's), and a copied number or email is not a new contact in the Performance report.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { connectDb, disconnectDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { Activity, Job, NonFilteredJob } from '../src/models.js';
import { forgetCompanySpellings } from '../src/sameCompany.js';

const TESTER = { userId: 'user_tester', email: 'tester@example.com', name: 'Test Admin', role: 'ADMIN' };
const DAY = 86_400_000;
let mongo;
let server;
let base;
let citiOld; // Citi, 10 days ago, with HR contact typed in
let citiNew; // "Citi Pvt. Ltd.", found a minute ago, no HR contact
let citiLeftOut; // Citi, 20 days ago, a non-filtered job without HR contact
let omega; // another company with a number typed in
let solo; // a company found only today

before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  await Promise.all([Job.init(), NonFilteredJob.init()]);
  const now = Date.now();
  const job = (n, company, ago, extra) => ({
    fingerprint: `f${n}`,
    title: `Data Analyst ${n}`,
    company,
    course: 'data-analyst',
    cities: ['Pune'],
    firstSeenAt: new Date(now - ago),
    lastSeenAt: new Date(now - ago),
    primaryPlatform: 'Naukri',
    platforms: ['Naukri'],
    sourceKeys: [`X:${n}`],
    ...extra,
  });
  const hr = (phone, extra) => ({ manual: { phone, phoneKeys: [phone.replace(/\D/g, '')], foundBy: 'apollo', updatedAt: new Date(now - 9 * DAY), ...extra } });
  [citiOld, citiNew, omega, solo] = await Job.create([
    job(1, 'Citi', 10 * DAY, { title: 'Business Analytics Analyst', ...hr('98765 43210', { hrNames: ['Priya S'], email: 'priya@citi.com' }) }),
    job(2, 'Citi Pvt. Ltd.', 60_000, { cities: ['Bengaluru'] }),
    job(3, 'Omega Corp', 5 * DAY, hr('90909 09090')),
    job(4, 'Solo Labs', 60_000),
  ]);
  citiLeftOut = await NonFilteredJob.create(job(5, 'CITI', 20 * DAY, { leftOutBy: 'no-experience' }));
  forgetCompanySpellings();
  server = createApp({ identify: async () => TESTER }).listen(0);
  base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  await disconnectDb();
  await mongo?.stop();
});

const get = async (path) => (await fetch(`${base}/${path}`)).json();
const send = (path, method, body) => fetch(`${base}/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const rowOf = (list, doc) => list.items.find((j) => j._id === String(doc._id));

test('the job list: a company found before is "hiring again", and a job without HR contact gets the one saved on its other job', async () => {
  const today = await get('jobs?days=1');
  const fresh = rowOf(today, citiNew);
  assert.equal(fresh.sameCompany.earlier, 2, 'the kept and the left-out job, however the name is spelled');
  assert.equal(new Date(fresh.sameCompany.firstAt).getTime(), citiLeftOut.firstSeenAt.getTime());
  assert.deepEqual(
    { ...fresh.sameCompany.hr, firstSeenAt: undefined, savedAt: undefined },
    {
      id: String(citiOld._id),
      set: 'filtered',
      title: 'Business Analytics Analyst',
      cities: ['Pune'],
      firstSeenAt: undefined,
      hrNames: ['Priya S'],
      hrProfiles: [],
      phone: '98765 43210',
      email: 'priya@citi.com',
      foundBy: 'apollo',
      savedAt: undefined,
    },
  );
  assert.equal(rowOf(today, solo).sameCompany, undefined, 'nothing to say about a company found only today');

  // The job with the HR contact: hiring again (the left-out job came first), nothing to copy.
  const old = (await get(`jobs?id=${citiOld._id}&days=30`)).items[0];
  assert.deepEqual({ earlier: old.sameCompany.earlier, hr: old.sameCompany.hr }, { earlier: 1, hr: null });
});

test('"Use this HR" copies the HR contact; the copy is recorded, and not counted as a new contact', async () => {
  const res = await send(`jobs/${citiNew._id}/copy-hr`, 'POST', { from: String(citiOld._id) });
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.deepEqual(row.contact.hrNames, ['Priya S']);
  assert.equal(row.contact.phone, '98765 43210');
  assert.equal(row.contact.email, 'priya@citi.com');
  assert.equal(row.contact.foundBy, 'apollo', "the Found by of the job it came from");
  assert.equal(row.sameCompany.earlier, 2, 'still hiring again');
  assert.equal(row.sameCompany.hr, null, 'it has HR contact now');

  const record = await Activity.findOne({ 'job.id': citiNew._id }).lean();
  assert.equal(String(record.copiedFrom.id), String(citiOld._id));
  assert.equal(record.copiedFrom.title, 'Business Analytics Analyst');
  assert.deepEqual(record.changes.find((c) => c.field === 'phone').known, ['98765 43210']);
  assert.deepEqual(record.changes.find((c) => c.field === 'email').known, ['priya@citi.com']);

  const mine = (rows) => rows.filter((r) => r.job.id === String(citiNew._id));
  assert.equal(mine((await get('performance?days=1')).rows).length, 0, 'the Performance report leaves copies out');
  const withCopies = mine((await get('performance?days=1&copies=1')).rows);
  assert.deepEqual(withCopies.map((r) => [r.field, r.value, r.copied]).sort(), [
    ['email', 'priya@citi.com', true],
    ['phone', '98765 43210', true],
  ]);
  const review = mine((await get('review?days=1')).rows);
  assert.ok(review.length);
  assert.ok(review.every((r) => r.found.source === 'copy'), 'the Review board: copied, not found by the person');
});

test('a number may be on several jobs of the same company, never on another company\'s; typed in again, it is a copy too', async () => {
  const save = (job, phone) => send(`jobs/${job._id}/follow-up`, 'PUT', { phone: [phone], foundBy: 'apollo' });
  const other = await save(solo, '98765 43210');
  assert.equal(other.status, 409, "Citi's number on Solo Labs");
  assert.match((await other.json()).detail, /^98765 43210 is already saved on ".+" at Citi/);
  assert.equal((await save(citiNew, '90909 09090')).status, 409, "Omega's number on a Citi job");

  const same = await save(citiLeftOut, '+91 98765-43210');
  assert.equal(same.status, 200, 'the same company');
  const record = await Activity.findOne({ 'job.id': citiLeftOut._id }).lean();
  assert.deepEqual(record.changes.find((c) => c.field === 'phone').known, ['+91 98765-43210']);
  assert.equal(record.copiedFrom, undefined);
  const rows = (await get('performance?days=1')).rows;
  assert.equal(rows.filter((r) => r.job.id === String(citiLeftOut._id)).length, 0);

  // A number nobody has is a new contact, as before.
  assert.equal((await save(solo, '91111 00000')).status, 200);
  const found = (await get('performance?days=1')).rows.filter((r) => r.job.id === String(solo._id));
  assert.deepEqual(found.map((r) => [r.value, r.copied]), [['91111 00000', false]]);
});

test('"Use this HR" refuses another company\'s job, a job without HR contact, and a missing job', async () => {
  const copy = (to, from) => send(`jobs/${to._id ?? to}/copy-hr`, 'POST', { from: String(from._id ?? from) });
  const otherCompany = await copy(solo, omega);
  assert.equal(otherCompany.status, 400);
  assert.match((await otherCompany.json()).error, /same company/);
  const empty = await NonFilteredJob.create({ ...citiLeftOut.toObject(), _id: undefined, sourceKeys: ['X:6'], manual: undefined });
  const nothing = await copy(citiOld, empty);
  assert.equal(nothing.status, 400);
  assert.match((await nothing.json()).error, /no HR contact/);
  assert.equal((await copy(citiOld, '0123456789abcdef01234567')).status, 404);
  assert.equal((await copy(citiOld, citiOld)).status, 400, 'not from itself');
});
