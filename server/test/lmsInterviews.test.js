// The LMS's "Today's Interviews" (src/lmsInterviews.js, src/api/lmsInterviews.js): a day's interviews in the LMS
// database's all_interviews, added and changed by the placement staff; the HR dashboard's Interviews page reading
// them; and the sheet copy never overwriting them. Names and companies are made up.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { LMS_COLLECTION, syncInterviews } from '../src/allInterviews.js';
import { parseInterviews } from '../src/interviews.js';
import { istToday, parseInterviewInput } from '../src/lmsInterviews.js';

const today = istToday();
const [y, m, d] = today.split('-');
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const TAB = `${MONTHS[Number(m) - 1]} ${y}`;
// Today's block in the sheet before the switch: one PS interview, one written "CANCEL FORM OUR SIDE".
const SHEET = [
  [`INTERVIEW SCHEDULED REPORT ${d}/${m}/${y}`],
  ['PS'],
  ['S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'],
  ['1', `${d}/${m}/${y}`, 'RAVI KUMAR', '4:00 PM', 'ALPHA SYSTEMS', 'R-01', '105'],
  ['2', `${d}/${m}/${y}`, 'NEHA SINGH', '11:00 AM', 'BETA SOFT', 'R-02', '106', 'CANCEL FORM OUR SIDE'],
];
const reading = () => ({ items: parseInterviews(TAB, SHEET), courseItems: [] });

let mongo;
let conn;
let col;
let server;
let base;
let role = 'PRE_PLACEMENT_STAFF';
const identify = async () => ({ userId: 'user_riya', email: 'riya@ijf.example', name: 'Riya', role });

before(async () => {
  mongo = await MongoMemoryServer.create();
  conn = await mongoose.createConnection(mongo.getUri()).asPromise();
  col = conn.getClient().db('lms').collection(LMS_COLLECTION);
  server = createApp({ identify, ai: null, interviews: null, lms: { collection: async () => col } }).listen(0);
  base = `http://localhost:${server.address().port}/api`;
});
after(async () => {
  server.close();
  await conn.close();
  await mongo.stop();
});
beforeEach(async () => {
  role = 'PRE_PLACEMENT_STAFF';
  await col.deleteMany({});
  await syncInterviews(col, reading()); // the backfill from the sheet
});

const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const ENTRY = { date: today, course: 'data-analyst', studentName: '  aman   gupta ', time: '2:30 pm', company: 'Gamma Media', round: 'r-1', room: '105', status: '' };

test('input: what a new interview needs, and what a change may send', () => {
  // studentClerkId: who the name is in the LMS. null here because this entry doesn't name one;
  // the add form always does, so the interview is linked rather than matched by spelling.
  assert.deepEqual(parseInterviewInput(ENTRY).value, { date: today, course: 'data-analyst', studentName: 'AMAN GUPTA', company: 'GAMMA MEDIA', time: '2:30 PM', round: 'R-1', room: '105', studentClerkId: null, status: '', estimatedDurationMins: null });
  assert.equal(parseInterviewInput({ ...ENTRY, studentClerkId: 'user_2abcDEF45678' }).value.studentClerkId, 'user_2abcDEF45678');
  assert.match(parseInterviewInput({ ...ENTRY, studentClerkId: 'not-a-clerk-id' }).error, /Pick the student/);
  assert.equal(Object.hasOwn(parseInterviewInput({ status: 'cancelled' }, { partial: true }).value, 'studentClerkId'), false);
  assert.equal(parseInterviewInput({ ...ENTRY, course: '' }).error, 'Choose the course.');
  assert.equal(parseInterviewInput({ ...ENTRY, date: '2026-02-30' }).error, 'Choose the day of the interview.');
  assert.equal(parseInterviewInput({ ...ENTRY, studentName: ' ' }).error, "Write the student's name.");
  assert.equal(parseInterviewInput({ ...ENTRY, company: '' }).error, 'Write the company.');
  assert.equal(parseInterviewInput({ ...ENTRY, status: 'DONE' }).error, 'Choose Scheduled, Rescheduled, Cancelled, Placed or Completed.');
  assert.match(parseInterviewInput({ ...ENTRY, studentName: 'A'.repeat(81) }).error, /too long/);
  assert.deepEqual(parseInterviewInput({ status: 'cancelled' }, { partial: true }).value, { status: 'CANCELLED' });
  assert.equal(parseInterviewInput({}, { partial: true }).error, 'Nothing to change.');
  assert.equal(parseInterviewInput({ company: '' }, { partial: true }).error, 'Write the company.');

  // How long the interview is expected to take. Optional: thousands of
  // interviews predate the field, and one added without an estimate is still
  // a perfectly good interview.
  assert.equal(parseInterviewInput({ ...ENTRY, estimatedDurationMins: 45 }).value.estimatedDurationMins, 45);
  assert.equal(parseInterviewInput({ ...ENTRY, estimatedDurationMins: '45' }).value.estimatedDurationMins, 45);
  for (const blank of [null, undefined, '', '   ']) {
    assert.equal(parseInterviewInput({ ...ENTRY, estimatedDurationMins: blank }).value.estimatedDurationMins, null, `blank: ${JSON.stringify(blank)}`);
  }
  for (const bad of [0, 4, 481, 2.5, 'soon', -30, Number.NaN, Infinity]) {
    assert.match(parseInterviewInput({ ...ENTRY, estimatedDurationMins: bad }).error, /whole number of minutes/, `bad: ${String(bad)}`);
  }
  // On a change it is only touched when sent, so marking one cancelled does
  // not quietly wipe the estimate.
  assert.equal(Object.hasOwn(parseInterviewInput({ status: 'cancelled' }, { partial: true }).value, 'estimatedDurationMins'), false);
  assert.deepEqual(parseInterviewInput({ estimatedDurationMins: 30 }, { partial: true }).value, { estimatedDurationMins: 30 });
  assert.deepEqual(parseInterviewInput({ estimatedDurationMins: '' }, { partial: true }).value, { estimatedDurationMins: null });
});

test("today's list: the sheet's interviews in its order, with the courses and statuses to choose from", async () => {
  const { status, body } = await call('GET', '/lms-interviews');
  assert.equal(status, 200);
  assert.equal(body.date, today);
  assert.deepEqual(body.items.map((i) => [i.studentName, i.course, i.source, i.statusKey, i.cancelled, i.sheet.row]), [
    ['RAVI KUMAR', 'production-support', 'sheet', '', false, 4],
    ['NEHA SINGH', 'production-support', 'sheet', 'CANCELLED', true, 5],
  ]);
  assert.deepEqual(body.courses.map((c) => c.id), ['production-support', 'data-analyst', 'data-science', 'data-engineering']);
  assert.deepEqual(body.statuses, ['', 'RESCHEDULED', 'CANCELLED', 'PLACED', 'COMPLETED']);
  assert.deepEqual((await call('GET', '/lms-interviews?date=2020-01-01')).body.items, []);
});

test('add: saved as written in the sheet (capitals), with who added it; the same interview again is refused', async () => {
  const added = await call('POST', '/lms-interviews', ENTRY);
  assert.equal(added.status, 201);
  const item = added.body.item;
  assert.deepEqual(
    [item.studentName, item.company, item.time, item.minutes, item.round, item.roundGroup, item.courseName, item.source, item.createdBy, item.statusKey],
    ['AMAN GUPTA', 'GAMMA MEDIA', '2:30 PM', 870, 'R-1', 'Round 1', 'Data Analyst', 'lms', 'Riya', ''],
  );
  const saved = await col.findOne({ _id: new mongoose.Types.ObjectId(item.id) });
  assert.equal(saved.key, `lms|${item.id}`);
  assert.deepEqual(saved.createdBy, { userId: 'user_riya', name: 'Riya', email: 'riya@ijf.example' });
  assert.equal(saved.interviewDate.toISOString(), `${today}T00:00:00.000Z`);

  // Someone else adds the same one, written a little differently: refused, with the one already there.
  const again = await call('POST', '/lms-interviews', { ...ENTRY, studentName: 'Aman Gupta', company: 'GAMMA  MEDIA', round: 'ROUND 1' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /AMAN GUPTA already has this interview/);
  // Another round or another company the same day is another interview.
  assert.equal((await call('POST', '/lms-interviews', { ...ENTRY, round: 'R-2' })).status, 201);
  assert.equal((await call('POST', '/lms-interviews', { ...ENTRY, company: 'Delta' })).status, 201);
  assert.equal((await call('POST', '/lms-interviews', { ...ENTRY, course: 'sql' })).status, 400);

  const list = (await call('GET', '/lms-interviews')).body.items;
  assert.deepEqual(list.map((i) => i.studentName), ['RAVI KUMAR', 'NEHA SINGH', 'AMAN GUPTA', 'AMAN GUPTA', 'AMAN GUPTA'], 'PS block first, then DA as added');
});

test('change: mark rescheduled, cancelled, placed or completed; a sheet interview changed here is the LMS\'s, and the sheet copy leaves it', async () => {
  const { item } = (await call('POST', '/lms-interviews', ENTRY)).body;
  const cancelled = await call('PATCH', `/lms-interviews/${item.id}`, { status: 'CANCELLED' });
  assert.equal(cancelled.status, 200);
  assert.deepEqual([cancelled.body.item.statusKey, cancelled.body.item.cancelled, cancelled.body.item.rescheduled, cancelled.body.item.updatedBy], ['CANCELLED', true, false, 'Riya']);
  assert.equal((await col.findOne({ key: `lms|${item.id}` })).cancelled, true);

  const ravi = (await call('GET', '/lms-interviews')).body.items[0];
  const placed = await call('PATCH', `/lms-interviews/${ravi.id}`, { status: 'PLACED', time: '5:00 PM' });
  assert.deepEqual([placed.body.item.placed, placed.body.item.minutes, placed.body.item.source], [true, 1020, 'lms']);

  // The sheet still says 4:00 PM and no status: copying it again leaves the LMS's version.
  const sync = await syncInterviews(col, reading());
  assert.equal(sync.keptAsLms, 1);
  assert.equal(sync.removed, 0, 'an interview added in the LMS is not "no longer in the sheet"');
  const after = await col.findOne({ _id: new mongoose.Types.ObjectId(ravi.id) });
  assert.deepEqual([after.status, after.time, after.inSheet], ['PLACED', '5:00 PM', true]);

  // Completed is the staff's own mark that the interview happened. It is neither
  // rescheduled nor cancelled, so it still counts as an interview given.
  const done = await call('PATCH', `/lms-interviews/${item.id}`, { status: 'COMPLETED' });
  assert.deepEqual([done.body.item.statusKey, done.body.item.cancelled, done.body.item.rescheduled, done.body.item.placed], ['COMPLETED', false, false, false]);

  // A change that makes it the same as another interview is refused.
  const twin = await call('PATCH', `/lms-interviews/${item.id}`, { studentName: 'Ravi Kumar', company: 'Alpha Systems', round: 'R-01', date: today });
  assert.equal(twin.status, 409);
  assert.equal((await call('PATCH', `/lms-interviews/${item.id}`, { status: 'DONE' })).status, 400);
  assert.equal((await call('PATCH', '/lms-interviews/000000000000000000000000', { status: 'PLACED' })).status, 404);
  assert.equal((await call('PATCH', '/lms-interviews/not-an-id', { status: 'PLACED' })).status, 404);
});

test('take out: an interview added by mistake goes; asking again is 404', async () => {
  const { item } = (await call('POST', '/lms-interviews', ENTRY)).body;
  assert.equal((await call('DELETE', `/lms-interviews/${item.id}`)).status, 204);
  assert.equal(await col.countDocuments({ key: `lms|${item.id}` }), 0);
  assert.equal((await call('DELETE', `/lms-interviews/${item.id}`)).status, 404);
  assert.equal(await col.countDocuments({}), 2, "the sheet's interviews are still there");
});

test('who may: the LMS placement page roles; others are refused; no LMS database: 503', async () => {
  for (const r of ['SUPER_ADMIN', 'ADMIN', 'PLACEMENT_STAFF', 'PRE_PLACEMENT_STAFF']) {
    role = r;
    assert.equal((await call('GET', '/lms-interviews')).status, 200, r);
  }
  for (const r of ['RESEARCH_TEAM', 'STUDENT_MANAGEMENT']) {
    role = r;
    const res = await call('POST', '/lms-interviews', ENTRY);
    assert.deepEqual([res.status, res.body.error], [403, "Your role can't add or change interviews."], r);
  }
  role = null;
  assert.equal((await call('GET', '/lms-interviews')).status, 403);

  const plain = createApp({ identify, ai: null, interviews: null }).listen(0);
  try {
    role = 'ADMIN';
    const res = await fetch(`http://localhost:${plain.address().port}/api/lms-interviews`);
    assert.equal(res.status, 503);
  } finally {
    plain.close();
  }
});

test("GET /api/interviews (the HR dashboard): from the LMS database, cancelled ones marked, ones taken out of the sheet left out", async () => {
  await call('POST', '/lms-interviews', { ...ENTRY, time: '' });
  await col.insertOne({ key: 'old', date: today, studentName: 'GONE', company: 'X', status: '', inSheet: false });
  const res = await call('GET', '/interviews?days=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'lms');
  assert.deepEqual(res.body.items.map((i) => [i.name, i.course, i.time, i.cancelled, i.rescheduled]), [
    ['NEHA SINGH', 'production-support', '11:00 AM', true, false],
    ['RAVI KUMAR', 'production-support', '4:00 PM', false, false],
    ['AMAN GUPTA', 'data-analyst', '', false, false],
  ]);
});
