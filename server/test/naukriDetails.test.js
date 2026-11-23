import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { connectDb, disconnectDb } from '../src/db.js';
import { CREDIT_VIA, createCrediting, personByEmail } from '../src/collector/creditFound.js';
import { createDetailsFetcher, detailChange, enrichNaukriDetails, findCandidates } from '../src/collector/naukriDetails.js';
import { Activity, CollectorRun, Job, NonFilteredJob } from '../src/models.js';

let mongo;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  await Job.init();
  await NonFilteredJob.init();
});
after(async () => {
  await disconnectDb();
  await mongo.stop();
});

const now = new Date('2026-11-18T07:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000);
let count = 0;
// A stored job found on Naukri (a kept or a non-filtered one), with its own listing id.
const naukriJob = (over = {}) => {
  const id = `N${++count}`;
  return {
    fingerprint: `acme|data analyst|pune|${id}`,
    title: 'Data Analyst',
    company: 'Acme',
    course: 'data-analyst',
    firstSeenAt: now,
    lastSeenAt: now,
    primaryPlatform: 'Naukri',
    platforms: ['Naukri'],
    links: { Naukri: `https://www.naukri.com/job-listings-data-analyst-acme-${id}` },
    sourceKeys: [`Naukri:${id}`],
    ...over,
  };
};
// A full description as Naukri's job API gives it, with the contact details at the end.
const FULL = '<p>Role: SQL, Power BI dashboards.</p><p>Interested? Share your CV at hr@acme.in or call 98450 12345.</p>';

test('detailChange: the contact details in the full description are added once; a page not read changes nothing', () => {
  const doc = { _id: 'j1', foundPhones: ['+91 98450 12345'], foundEmails: [] };
  const change = detailChange(doc, { status: 'ok', description: FULL, website: 'https://acme.in' }, now);
  assert.deepEqual(change.phones, [], 'the phone number was already found in the snippet');
  assert.deepEqual(change.emails, ['hr@acme.in']);
  assert.deepEqual(change.operation.updateOne, {
    filter: { _id: 'j1' },
    update: { $set: { naukriDetail: { at: now, status: 'ok', website: 'https://acme.in' } }, $addToSet: { foundEmails: { $each: ['hr@acme.in'] } } },
  });

  const nothingNew = detailChange(doc, { status: 'ok', description: '<p>Apply on the portal.</p>' }, now);
  assert.deepEqual(nothingNew.operation.updateOne.update, { $set: { naukriDetail: { at: now, status: 'ok' } } }, 'read, but nothing to add');

  const gone = detailChange(doc, { status: 'gone' }, now);
  assert.deepEqual(gone.operation.updateOne.update, { $set: { naukriDetail: { at: now, status: 'gone' } } });
  assert.equal(detailChange(doc, { status: 'failed', error: 'HTTP 403' }, now), null, 'tried again next run');
});

test('enrichNaukriDetails: kept jobs first, newest first, then non-filtered; read pages are marked, a failed one is left for the next run', async () => {
  await Promise.all([Job.deleteMany({}), NonFilteredJob.deleteMany({}), CollectorRun.deleteMany({})]);
  const [newest, older, alreadyRead, tooOld, unlucky] = await Job.insertMany([
    naukriJob({ firstSeenAt: now }),
    naukriJob({ firstSeenAt: daysAgo(1), foundPhones: ['+91 98450 12345'] }),
    naukriJob({ naukriDetail: { at: daysAgo(1), status: 'ok' } }),
    naukriJob({ firstSeenAt: daysAgo(10) }),
    naukriJob({ firstSeenAt: daysAgo(2) }),
  ]);
  const [nonFiltered] = await NonFilteredJob.insertMany([naukriJob({ leftOutBy: 'experience' })]);
  await Job.create(naukriJob({ links: { LinkedIn: 'https://www.linkedin.com/jobs/view/1' }, sourceKeys: ['LinkedIn:1'], primaryPlatform: 'LinkedIn', platforms: ['LinkedIn'] }));

  const first = await findCandidates(now, { days: 7, limit: 1 });
  assert.deepEqual(first.map((c) => String(c.doc._id)), [String(newest._id)], 'the limit cuts the list, newest kept job first');

  const asked = [];
  const fetchDetails = async (jobs) => {
    asked.push(...jobs.map((j) => j.id));
    assert.ok(jobs.every((j) => j.url.startsWith('https://www.naukri.com/job-listings-')), 'the script gets each job\'s Naukri link');
    return new Map(
      jobs.map((j) => {
        if (j.id === String(unlucky._id)) return [j.id, { status: 'failed', error: 'HTTP 403' }];
        if (j.id === String(nonFiltered._id)) return [j.id, { status: 'gone' }];
        return [j.id, { status: 'ok', description: FULL, shortDescription: '', website: '' }];
      }),
    );
  };
  const run = await CollectorRun.create({ startedAt: now, status: 'success' });
  const logs = [];
  const summary = await enrichNaukriDetails({ fetchDetails, now, log: (l) => logs.push(l), limit: 10, days: 7, runId: run._id });

  assert.deepEqual(
    asked,
    [newest, older, unlucky, nonFiltered].map((d) => String(d._id)),
    'kept jobs newest first, then non-filtered; jobs already read, older than `days` or not from Naukri are not asked',
  );
  assert.deepEqual({ ...summary, durationMs: 0 }, { candidates: 4, read: 2, gone: 1, failed: 1, jobsWithNewContacts: 2, phones: 1, emails: 2, durationMs: 0 });
  assert.ok(logs.some((l) => /2 read, 1 no longer on Naukri, 1 not read/.test(l)), 'the summary is logged');

  const fresh = await Job.findById(newest._id).lean();
  assert.deepEqual([fresh.foundPhones, fresh.foundEmails], [['+91 98450 12345'], ['hr@acme.in']], 'the contact details from the full description');
  assert.equal(fresh.naukriDetail.status, 'ok');
  const known = await Job.findById(older._id).lean();
  assert.deepEqual([known.foundPhones, known.foundEmails], [['+91 98450 12345'], ['hr@acme.in']], 'a number found in the snippet is not added twice');
  assert.equal((await Job.findById(unlucky._id).lean()).naukriDetail, undefined, 'a page not read this time stays unread');
  assert.equal((await Job.findById(alreadyRead._id).lean()).naukriDetail.status, 'ok', 'untouched');
  assert.equal((await Job.findById(tooOld._id).lean()).naukriDetail, undefined, 'untouched');
  assert.equal((await NonFilteredJob.findById(nonFiltered._id).lean()).naukriDetail.status, 'gone');
  assert.equal((await CollectorRun.findById(run._id).lean()).naukriDetails.read, 2, 'the run record keeps the summary');

  const nextRun = await findCandidates(now, { days: 7, limit: 10 });
  assert.deepEqual(nextRun.map((c) => String(c.doc._id)), [String(unlucky._id)], 'next run: only the page that failed is read again');

  await Job.updateOne({ _id: unlucky._id }, { $set: { naukriDetail: { at: now, status: 'ok' } } });
  const nothing = await enrichNaukriDetails({ fetchDetails: async () => assert.fail('not called'), now, log: () => {}, limit: 10, days: 7 });
  assert.equal(nothing.candidates, 0, 'nothing left to read: the script is not started');
});

test('one course, read in batches until enough contacts are found; onFound runs before the contacts are written', async () => {
  await Promise.all([Job.deleteMany({}), NonFilteredJob.deleteMany({})]);
  const jobs = await Job.insertMany([
    naukriJob({ course: 'production-support', firstSeenAt: now }),
    naukriJob({ course: 'production-support', firstSeenAt: daysAgo(1) }),
    naukriJob({ course: 'production-support', firstSeenAt: daysAgo(2) }),
    naukriJob({ course: 'production-support', firstSeenAt: daysAgo(3) }),
    naukriJob({ course: 'data-analyst', firstSeenAt: now }),
  ]);
  const id = (doc) => String(doc._id);
  const batches = [];
  const fetchDetails = async (list) => {
    batches.push(list.map((j) => j.id));
    return new Map(list.map((j) => [j.id, { status: 'ok', description: FULL }]));
  };
  const seen = [];
  const onFound = async ({ model, doc, phones, emails }) => {
    const stored = await model.findById(doc._id).lean();
    seen.push({ id: id(doc), foundBefore: (stored.foundPhones?.length ?? 0) + (stored.foundEmails?.length ?? 0), phones, emails });
    return 1; // one contact counted per job
  };
  const summary = await enrichNaukriDetails({ fetchDetails, now, log: () => {}, limit: 10, days: 7, course: 'production-support', batchSize: 2, stopAfterContacts: 3, onFound });

  assert.deepEqual(batches, [[id(jobs[0]), id(jobs[1])], [id(jobs[2]), id(jobs[3])]], 'two batches of two production-support jobs; the data-analyst job is never asked');
  assert.deepEqual(seen.map((s) => s.id), [id(jobs[0]), id(jobs[1]), id(jobs[2])], 'stopped once 3 were counted');
  assert.deepEqual(seen.map((s) => s.foundBefore), [0, 0, 0], 'onFound saw each job before its found contacts were written');
  assert.deepEqual(seen[0].phones, ['+91 98450 12345']);
  assert.equal(summary.read, 3);
  assert.equal((await Job.findById(jobs[2]._id).lean()).naukriDetail.status, 'ok');
  assert.equal((await Job.findById(jobs[3]._id).lean()).naukriDetail, undefined, 'the page read after the target was reached is left unread for next time');
  assert.equal((await Job.findById(jobs[4]._id).lean()).naukriDetail, undefined, 'another course: not read');
});

test("sets: 'filtered' reads only kept jobs, never a non-filtered one, even under the limit", async () => {
  await Promise.all([Job.deleteMany({}), NonFilteredJob.deleteMany({})]);
  const kept = await Job.insertMany([naukriJob({ firstSeenAt: now }), naukriJob({ firstSeenAt: daysAgo(1) })]);
  await NonFilteredJob.insertMany([naukriJob({ firstSeenAt: now }), naukriJob({ firstSeenAt: daysAgo(1) })]);

  const onlyKept = await findCandidates(now, { days: 7, limit: 100, sets: ['kept'] });
  assert.deepEqual(onlyKept.map((c) => c.kind), ['kept', 'kept'], 'non-filtered jobs are not read');
  assert.deepEqual(new Set(onlyKept.map((c) => String(c.doc._id))), new Set(kept.map((k) => String(k._id))));

  const asked = [];
  await enrichNaukriDetails({
    fetchDetails: async (list) => (asked.push(...list.map((j) => j.id)), new Map(list.map((j) => [j.id, { status: 'ok', description: '<p>no contacts</p>' }]))),
    now, log: () => {}, limit: 100, days: 7, sets: ['kept'],
  });
  assert.deepEqual(asked.sort(), kept.map((k) => String(k._id)).sort(), 'the run reads the kept jobs only');
  for (const k of kept) assert.equal((await Job.findById(k._id).lean()).naukriDetail.status, 'ok');
  for (const nf of await NonFilteredJob.find().lean()) assert.equal(nf.naukriDetail, undefined, 'non-filtered jobs stay unread');
});

test('--credit: the contacts found are saved as HR details under the person, recorded for the Performance report', async () => {
  await Promise.all([Job.deleteMany({}), NonFilteredJob.deleteMany({}), Activity.deleteMany({})]);
  const actor = { userId: 'user_dev', email: 'dev@example.com', name: 'developer', role: 'ADMIN' };
  await Activity.create({ at: daysAgo(1), actor: { ...actor, name: 'Data Developer' }, action: 'added', job: { id: new (await import('mongoose')).default.Types.ObjectId(), set: 'filtered', title: 'x', company: 'y' }, changes: [] });
  await Activity.create({ at: now, actor, action: 'added', job: { id: new (await import('mongoose')).default.Types.ObjectId(), set: 'filtered', title: 'x', company: 'y' }, changes: [] });
  assert.deepEqual(await personByEmail('DEV@example.com'), actor, 'the latest record names the person');
  assert.equal(await personByEmail('nobody@example.com'), null);

  const [plain, typed, taken, already] = await Job.insertMany([
    naukriJob({ company: 'Acme' }),
    naukriJob({ company: 'Beta Ltd', firstSeenAt: daysAgo(1), manual: { hrNames: ['Riya'], foundBy: 'linkedin', phone: '+91 90000 00001', phoneKeys: ['9000000001'], email: '', remarks: 'called', updatedAt: daysAgo(1) } }),
    naukriJob({ company: 'Gamma', firstSeenAt: daysAgo(2) }),
    naukriJob({ company: 'Delta', firstSeenAt: daysAgo(3), manual: { foundBy: 'naukri', phone: '95000 11111', phoneKeys: ['9500011111'], email: '', remarks: '', updatedAt: daysAgo(2) } }),
  ]);
  await Job.create(naukriJob({ company: 'Other Co', firstSeenAt: daysAgo(4), naukriDetail: { at: now, status: 'ok' }, foundPhones: ['+91 77777 66666'] }));
  const descriptions = new Map([
    [String(plain._id), FULL],
    [String(typed._id), '<p>Walk in. Call 90000 00001 or 88888 77777, mail jobs@beta.in</p>'],
    [String(taken._id), '<p>Contact 77777 66666</p>'], // a number on Other Co's job already
    [String(already._id), '<p>Call 95000 11111</p>'], // the team typed this one in already
  ]);
  const fetchDetails = async (list) => new Map(list.map((j) => [j.id, { status: 'ok', description: descriptions.get(j.id) }]));
  const logs = [];
  const crediting = createCrediting(actor, (l) => logs.push(l));
  await enrichNaukriDetails({ fetchDetails, now, log: () => {}, limit: 10, days: 7, onFound: crediting.onFound });

  assert.deepEqual(crediting.stats, { jobs: 2, contacts: 4, copies: 0, refused: 1 });
  const acme = await Job.findById(plain._id).lean();
  assert.equal(acme.manual.phone, '+91 98450 12345');
  assert.equal(acme.manual.email, 'hr@acme.in');
  assert.equal(acme.manual.foundBy, 'naukri');
  assert.deepEqual([acme.foundPhones, acme.foundEmails], [['+91 98450 12345'], ['hr@acme.in']], 'also kept as found contacts');
  const beta = await Job.findById(typed._id).lean();
  assert.equal(beta.manual.phone, '+91 90000 00001, +91 88888 77777', 'added to the HR details typed in before');
  assert.equal(beta.manual.email, 'jobs@beta.in');
  assert.deepEqual([beta.manual.hrNames, beta.manual.foundBy, beta.manual.remarks], [['Riya'], 'linkedin', 'called'], 'what was typed in stays');
  const gamma = await Job.findById(taken._id).lean();
  assert.equal(gamma.manual, undefined, "a number another company's job has is not saved as HR details");
  assert.deepEqual(gamma.foundPhones, ['+91 77777 66666'], 'but it stays a found contact');
  assert.ok(logs.some((l) => /not saved as HR details: .*already saved on/.test(l)));
  const delta = await Job.findById(already._id).lean();
  assert.equal(delta.manual.updatedAt.toISOString(), daysAgo(2).toISOString(), 'a contact the team typed in already: not saved again, so its HR details are not marked as updated');
  assert.equal(delta.manual.phone, '95000 11111', 'left as typed');
  assert.deepEqual(delta.foundPhones, ['+91 95000 11111'], 'still recorded as found in the posting');
  assert.ok(logs.some((l) => /already in its HR details/.test(l)));

  const records = await Activity.find({ via: CREDIT_VIA }).sort({ at: 1 }).lean();
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.actor.email === 'dev@example.com' && r.actor.name === 'developer'));
  const added = records.flatMap((r) => r.changes.filter((c) => ['phone', 'email'].includes(c.field)).flatMap((c) => c.added));
  assert.deepEqual(added.sort(), ['+91 88888 77777', '+91 98450 12345', 'hr@acme.in', 'jobs@beta.in'].sort(), 'the 4 new contacts, as the Performance report counts them');
});

test('createDetailsFetcher: the jobs go to the script on stdin, its JSON lines come back by id, progress is logged', async () => {
  // A stand-in for naukri_details.py (a small Node script with the .py name), so the test needs neither Python nor Naukri.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naukri-details-test-'));
  fs.mkdirSync(path.join(dir, 'scraper_file'));
  fs.writeFileSync(
    path.join(dir, 'scraper_file', 'naukri_details.py'),
    `let input = '';
     process.stdin.on('data', (chunk) => (input += chunk));
     process.stdin.on('end', () => {
       console.error('[naukri-details] args: ' + process.argv.slice(2).join(' '));
       for (const line of input.trim().split('\\n')) {
         const job = JSON.parse(line);
         console.log(JSON.stringify(job.id === 'b' ? { id: job.id, status: 'gone' } : { id: job.id, status: 'ok', description: 'Call ' + job.url }));
       }
     });`,
  );
  const logs = [];
  const fetchDetails = createDetailsFetcher({ dir, python: process.execPath, headless: true, delaySeconds: 0 }, (line) => logs.push(line));
  const results = await fetchDetails([
    { id: 'a', url: 'https://www.naukri.com/job-listings-a-1' },
    { id: 'b', url: 'https://www.naukri.com/job-listings-b-2' },
  ]);
  assert.equal(results.size, 2);
  assert.equal(results.get('a').description, 'Call https://www.naukri.com/job-listings-a-1');
  assert.equal(results.get('b').status, 'gone');
  assert.ok(logs.some((l) => l.includes('[naukri-details] args: --delay 0 --headless')), 'progress is passed through to the log');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing details script gives a clear error', async () => {
  const fetchDetails = createDetailsFetcher({ dir: path.join(os.tmpdir(), 'no-such-scraper'), python: '', headless: false });
  await assert.rejects(fetchDetails([{ id: 'a', url: 'https://www.naukri.com/job-listings-a-1' }]), /Naukri details script not found/);
});
