// The interview sheet's copy in the LMS database (src/allInterviews.js): one document per interview, rewritten
// only when it changed, never deleted, and nothing else in that database touched.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import mongoose from 'mongoose';
import { interviewDocs, lmsDatabaseName, LMS_COLLECTION, syncInterviews } from '../src/allInterviews.js';
import { courseOfTab, parseInterviews } from '../src/interviews.js';

const HEADER = ['S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'];
const OCTOBER = [
  ['INTERVIEW SCHEDULED REPORT 01/10/2026'],
  ['PS'],
  HEADER,
  ['1', '01/10/2026', 'RAVI KUMAR', '4:00 PM', 'ALPHA SYSTEMS', 'R-01', '105'],
  ['2', '01/10/2026', 'ANIL VERMA', 'ANYTIME', 'BETA SOFT', 'ASSESSMENT', 'HYDERABAD', 'PLACED'],
  ['3', '01/10/2026', 'RAVI KUMAR', '4:00 PM', 'ALPHA SYSTEMS', 'ROUND 1', '105'], // written twice: kept twice
];
const DA_TAB = [
  HEADER,
  ['1', '01/10/2026', 'Anil  Verma', '', 'BETA SOFT', 'ASSESSMENT', 'HYDERABAD'], // in the month tab already
  ['2', '15/07/2026', 'MEERA NAIR', '11:00 AM', 'GAMMA MEDIA', 'R-02', 'MUMBAI'], // only here
  ['3', '15/07/2026', 'MEERA NAIR', '11:00 AM', 'GAMMA MEDIA', 'R-2', 'MUMBAI'], // the same again: once
];
const reading = (month = OCTOBER, da = DA_TAB) => ({
  items: parseInterviews('OCTOBER 2026', month),
  courseItems: parseInterviews('DA INTERVIEW', da).map((i) => ({ ...i, course: courseOfTab('DA INTERVIEW') })),
});

test('documents: every month-tab interview, plus the ones only in a per-course tab, keyed by the interview', () => {
  const docs = interviewDocs(reading().items, reading().courseItems);
  assert.deepEqual(docs.map((d) => [d.key, d.sheet.tab, d.sheet.row, d.sheet.kind]), [
    ['2026-10-01|RAVIKUMAR|ALPHASYSTEMS|ROUND1', 'OCTOBER 2026', 4, 'month'],
    ['2026-10-01|ANILVERMA|BETASOFT|ASSESSMENT', 'OCTOBER 2026', 5, 'month'],
    ['2026-10-01|RAVIKUMAR|ALPHASYSTEMS|ROUND1#2', 'OCTOBER 2026', 6, 'month'],
    ['2026-07-15|MEERANAIR|GAMMAMEDIA|ROUND2', 'DA INTERVIEW', 3, 'course'],
  ]);
  const anil = docs[1];
  assert.deepEqual(
    [anil.studentName, anil.course, anil.courseName, anil.company, anil.time, anil.minutes, anil.round, anil.roundGroup, anil.room, anil.status, anil.placed, anil.rescheduled],
    ['ANIL VERMA', 'production-support', 'Production Support', 'BETA SOFT', 'ANYTIME', null, 'ASSESSMENT', 'Assessment', 'HYDERABAD', 'PLACED', true, false],
  );
  assert.equal(anil.date, '2026-10-01');
  assert.equal(anil.interviewDate.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.deepEqual([docs[3].course, docs[3].courseName], ['data-analyst', 'Data Analyst']);

  // A row added above them doesn't change which interview is which: only their row numbers.
  const moved = interviewDocs(parseInterviews('OCTOBER 2026', [...OCTOBER.slice(0, 3), ['0', '01/10/2026', 'NEW STUDENT', '', 'DELTA', 'HR', '106'], ...OCTOBER.slice(3)]));
  assert.deepEqual(moved.slice(1).map((d) => [d.key, d.sheet.row]), [
    ['2026-10-01|RAVIKUMAR|ALPHASYSTEMS|ROUND1', 5],
    ['2026-10-01|ANILVERMA|BETASOFT|ASSESSMENT', 6],
    ['2026-10-01|RAVIKUMAR|ALPHASYSTEMS|ROUND1#2', 7],
  ]);
});

test('the database: the one the connection string names, else the LMS default "test"', () => {
  assert.equal(lmsDatabaseName('mongodb+srv://u:p@lms.example.net/?retryWrites=true&w=majority'), 'test');
  assert.equal(lmsDatabaseName('mongodb+srv://u:p@lms.example.net'), 'test');
  assert.equal(lmsDatabaseName('mongodb://u:p@host:27017/lms_main?authSource=admin'), 'lms_main');
});

let mongo;
let conn;
let db;
before(async () => {
  mongo = await MongoMemoryServer.create();
  conn = await mongoose.createConnection(mongo.getUri()).asPromise();
  db = conn.getClient().db('lms');
});
after(async () => {
  await conn.close();
  await mongo.stop();
});
beforeEach(async () => {
  await db.dropDatabase();
  await db.collection('students').insertOne({ name: 'RAVI KUMAR', batch: 'PS-12' }); // the LMS's own data
});

const all = async () => (await db.collection(LMS_COLLECTION).find({}, { projection: { _id: 0 } }).sort({ key: 1 }).toArray());

test('sync: the backfill adds every interview; run again, nothing is written', async () => {
  const col = db.collection(LMS_COLLECTION);
  const t1 = new Date('2026-11-11T05:00:00Z');
  assert.deepEqual(await syncInterviews(col, reading(), { now: t1 }), { inSheet: 4, fromCourseTabsOnly: 1, added: 4, changed: 0, moved: 0, unchanged: 0, removed: 0, back: 0, keptAsLms: 0 });
  const saved = await all();
  assert.equal(saved.length, 4);
  assert.ok(saved.every((d) => d.inSheet === true && +d.firstSyncedAt === +t1 && +d.updatedAt === +t1));

  const t2 = new Date('2026-11-11T06:00:00Z');
  assert.deepEqual(await syncInterviews(col, reading(), { now: t2 }), { inSheet: 4, fromCourseTabsOnly: 1, added: 0, changed: 0, moved: 0, unchanged: 4, removed: 0, back: 0, keptAsLms: 0 });
  assert.ok((await all()).every((d) => +d.updatedAt === +t1), 'unchanged interviews are not rewritten');
  assert.deepEqual((await col.indexes()).map((i) => i.name).sort(), ['_id_', 'interviewDate', 'key_unique']);
});

test('sync: a status written later updates the interview; a row taken out is kept, marked not in the sheet, and comes back', async () => {
  const col = db.collection(LMS_COLLECTION);
  const t1 = new Date('2026-11-11T05:00:00Z');
  await syncInterviews(col, reading(), { now: t1 });

  const placed = OCTOBER.map((row) => (row[2] === 'RAVI KUMAR' && row[0] === '1' ? [...row, 'SELECTED'] : row));
  const withoutAnil = placed.filter((row) => row[2] !== 'ANIL VERMA');
  const daWithoutAnil = DA_TAB.filter((row) => row[2] !== 'Anil  Verma');
  const t2 = new Date('2026-11-12T05:00:00Z');
  const c = await syncInterviews(col, reading(withoutAnil, daWithoutAnil), { now: t2 });
  // Ravi's status changed; the rows below Anil's moved up one (only their row number written); Anil is gone.
  assert.deepEqual([c.added, c.changed, c.moved, c.unchanged, c.removed], [0, 1, 2, 0, 1]);
  const byKey = Object.fromEntries((await all()).map((d) => [d.key, d]));
  const twice = byKey['2026-10-01|RAVIKUMAR|ALPHASYSTEMS|ROUND1#2'];
  assert.deepEqual([twice.sheet.row, +twice.updatedAt], [5, +t1], 'moved up a row: the row number, not a change');
  const ravi = byKey['2026-10-01|RAVIKUMAR|ALPHASYSTEMS|ROUND1'];
  assert.deepEqual([ravi.status, ravi.placed, +ravi.updatedAt, +ravi.firstSyncedAt], ['SELECTED', true, +t2, +t1]);
  const anil = byKey['2026-10-01|ANILVERMA|BETASOFT|ASSESSMENT'];
  assert.deepEqual([anil.inSheet, +anil.removedFromSheetAt, anil.status], [false, +t2, 'PLACED'], 'kept as it was, marked removed');
  assert.equal((await all()).length, 4);

  const t3 = new Date('2026-11-13T05:00:00Z');
  const again = await syncInterviews(col, reading(placed), { now: t3 });
  assert.deepEqual([again.back, again.moved, again.unchanged, again.removed], [1, 2, 1, 0]);
  const back = (await all()).find((d) => d.key === anil.key);
  assert.deepEqual([back.inSheet, 'removedFromSheetAt' in back, +back.updatedAt], [true, false, +t3]);
});

test('sync: no month-tab interviews (a renamed or emptied sheet) or a dry run write nothing; the LMS\'s own data is untouched', async () => {
  const col = db.collection(LMS_COLLECTION);
  const dry = await syncInterviews(col, reading(), { dryRun: true });
  assert.equal(dry.added, 4);
  assert.deepEqual((await db.listCollections().toArray()).map((c) => c.name), ['students'], 'a dry run creates nothing');

  await syncInterviews(col, reading());
  await assert.rejects(syncInterviews(col, { items: [], courseItems: reading().courseItems }), /no interviews in its month tabs/);
  assert.ok((await all()).every((d) => d.inSheet), 'nothing marked removed');

  assert.deepEqual((await db.listCollections().toArray()).map((c) => c.name).sort(), [LMS_COLLECTION, 'students']);
  assert.deepEqual(await db.collection('students').find({}, { projection: { _id: 0 } }).toArray(), [{ name: 'RAVI KUMAR', batch: 'PS-12' }]);
  assert.deepEqual((await db.collection('students').indexes()).map((i) => i.name), ['_id_']);
});
