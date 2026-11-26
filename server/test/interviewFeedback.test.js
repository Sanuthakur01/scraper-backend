// Feedback on an interview (src/interviewFeedback.js), written after it is over: each of the things a student is
// rated on Good, Average or Bad, plus a remark, saved on the interview itself. Names and remarks are made up.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { LMS_COLLECTION } from '../src/allInterviews.js';
import { istToday } from '../src/lmsInterviews.js';
import { bandOf, countsOf, feedbackView, parseFeedback, scoreOf } from '../src/interviewFeedback.js';

const today = istToday();

let mongo;
let conn;
let col;
let server;
let base;
const identify = async () => ({ userId: 'user_riya', email: 'riya@ijf.example', name: 'Riya', role: 'PLACEMENT_STAFF' });

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
beforeEach(() => col.deleteMany({}));

const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const ENTRY = { date: today, course: 'data-analyst', studentName: 'Aman Gupta', time: '2:30 pm', company: 'Gamma Media', round: 'R-01', room: '105', status: '' };
const add = async () => (await call('POST', '/lms-interviews', ENTRY)).body.item;

test('score: Good 100, Average 50, Bad 0, over what was rated; a remark on its own has no score', () => {
  assert.equal(scoreOf({ communication: 'GOOD', technical: 'GOOD' }), 100);
  assert.equal(scoreOf({ communication: 'GOOD', technical: 'BAD' }), 50);
  assert.equal(scoreOf({ communication: 'GOOD', technical: 'AVERAGE', projects: 'BAD' }), 50);
  // The unrated ones are left out rather than counted as bad: nothing to judge it on is not a failure.
  assert.equal(scoreOf({ communication: 'GOOD', technical: '' }), 100);
  assert.equal(scoreOf({}), null);
  assert.deepEqual(countsOf({ communication: 'GOOD', technical: 'BAD', projects: 'BAD' }), { good: 1, average: 0, bad: 2, rated: 3 });
  assert.deepEqual([bandOf(100), bandOf(75), bandOf(74), bandOf(40), bandOf(39), bandOf(null)], ['GOOD', 'GOOD', 'AVERAGE', 'AVERAGE', 'BAD', null]);
});

test('input: ratings and a remark are kept; anything else is refused; blank throughout is "no feedback"', () => {
  assert.deepEqual(parseFeedback({ ratings: { communication: 'good' }, notes: '  Needs   SQL practice  ' }), {
    value: { ratings: { communication: 'GOOD' }, notes: 'Needs SQL practice' },
  });
  // Clearing the form is how feedback is taken back off, so a blank one is null rather than an empty rating.
  assert.deepEqual(parseFeedback({ ratings: { communication: '' }, notes: '' }), { value: null });
  assert.deepEqual(parseFeedback(null), { value: null });
  assert.match(parseFeedback({ ratings: { charisma: 'GOOD' } }).error, /nobody is rated on/);
  assert.match(parseFeedback({ ratings: { communication: 'EXCELLENT' } }).error, /Good, Average or Bad/);
  assert.match(parseFeedback({ notes: 'x'.repeat(2001) }).error, /too long/);
  assert.match(parseFeedback('good').error, /not understood/);
  assert.equal(feedbackView(null), null);
  assert.equal(feedbackView({ ratings: {}, notes: '' }), null, 'nothing written is no feedback, not an empty one');
});

test('write, change and take off the feedback on an interview', async () => {
  const item = await add();
  assert.equal(item.feedback, null, 'a newly added interview has none: nobody can say yet how it went');

  const written = await call('PATCH', `/lms-interviews/${item.id}`, {
    feedback: { ratings: { communication: 'GOOD', technical: 'AVERAGE', projects: 'BAD' }, notes: 'Clear on dashboards, shaky on joins.' },
  });
  assert.equal(written.status, 200);
  const fb = written.body.item.feedback;
  assert.deepEqual([fb.score, fb.band, fb.notes], [50, 'AVERAGE', 'Clear on dashboards, shaky on joins.']);
  assert.deepEqual(fb.counts, { good: 1, average: 1, bad: 1, rated: 3 });
  // Who wrote it is the signed-in staff member, never what the request said.
  assert.equal(fb.by, 'Riya');
  assert.ok(fb.at, 'when it was written is kept');

  // Changing something else leaves the feedback where it is.
  const moved = await call('PATCH', `/lms-interviews/${item.id}`, { time: '5:00 PM' });
  assert.equal(moved.body.item.feedback.score, 50);

  // The day's list carries it, along with what interviews are rated on.
  const day = await call('GET', `/lms-interviews?date=${today}`);
  assert.equal(day.body.items[0].feedback.score, 50);
  assert.equal(day.body.feedback.criteria.length > 0, true);
  assert.deepEqual(day.body.feedback.ratings, ['GOOD', 'AVERAGE', 'BAD']);

  // Clearing every rating and the remark takes it off.
  const cleared = await call('PATCH', `/lms-interviews/${item.id}`, { feedback: { ratings: {}, notes: '' } });
  assert.equal(cleared.body.item.feedback, null);
  assert.equal((await col.findOne({ key: `lms|${item.id}` })).feedback, null);

  assert.equal((await call('PATCH', `/lms-interviews/${item.id}`, { feedback: { ratings: { charisma: 'GOOD' } } })).status, 400);
});

test('a remark on its own is feedback worth keeping, with no score', async () => {
  const item = await add();
  const only = await call('PATCH', `/lms-interviews/${item.id}`, { feedback: { notes: 'Panel will send written feedback tomorrow.' } });
  const fb = only.body.item.feedback;
  assert.deepEqual([fb.score, fb.band, fb.counts.rated], [null, null, 0]);
  assert.equal(fb.notes, 'Panel will send written feedback tomorrow.');
});
