// Feedback on an interview (src/interviewFeedback.js), written after it is over: each of the things a student
// is rated on Good, Average or Bad, an overall, and a remark. There is one review per interview, shared with
// the LMS's trainer dashboard (lms-backend: lib/interviewReviews.js), so these tests also pin the shape that
// dashboard writes. Names and remarks are made up.
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
  assert.equal(scoreOf({ communication: 'GOOD', readability: 'AVERAGE', technical: 'BAD' }), 50);
  // The database's own casing reads the same as the API's: one review, written by two pages.
  assert.equal(scoreOf({ communication: 'Good', technical: 'Bad' }), 50);
  // The unrated ones are left out rather than counted as bad: nothing to judge it on is not a failure.
  assert.equal(scoreOf({ communication: 'GOOD', technical: '' }), 100);
  assert.equal(scoreOf({}), null);
  assert.deepEqual(countsOf({ communication: 'Good', technical: 'Bad', confidence: 'Bad' }), { good: 1, average: 0, bad: 2, rated: 3 });
  assert.deepEqual([bandOf(100), bandOf(75), bandOf(74), bandOf(40), bandOf(39), bandOf(null)], ['GOOD', 'GOOD', 'AVERAGE', 'AVERAGE', 'BAD', null]);
});

test('input: ratings, an overall and a remark are kept; anything else is refused; blank throughout is "no feedback"', () => {
  assert.deepEqual(parseFeedback({ ratings: { communication: 'good' }, rank: 'Average', notes: '  Needs   SQL practice  ' }), {
    value: { ratings: { communication: 'GOOD' }, rank: 'AVERAGE', notes: 'Needs SQL practice' },
  });
  // Clearing the form is how a review is taken back off, so a blank one is null rather than an empty review.
  assert.deepEqual(parseFeedback({ ratings: { communication: '' }, rank: '', notes: '' }), { value: null });
  assert.deepEqual(parseFeedback(null), { value: null });
  assert.match(parseFeedback({ ratings: { charisma: 'GOOD' } }).error, /nobody is rated on/);
  assert.match(parseFeedback({ ratings: { communication: 'EXCELLENT' } }).error, /Good, Average or Bad/);
  assert.match(parseFeedback({ rank: 'EXCELLENT' }).error, /overall must be/);
  assert.match(parseFeedback({ notes: 'x'.repeat(2001) }).error, /too long/);
  assert.match(parseFeedback('good').error, /not understood/);
  assert.equal(feedbackView(null), null);
  assert.equal(feedbackView({ studentName: 'Aman Gupta' }), null, 'an interview nobody has written about has no feedback');
});

test('write, change and take off the feedback on an interview', async () => {
  const item = await add();
  assert.equal(item.feedback, null, 'a newly added interview has none: nobody can say yet how it went');

  const written = await call('PATCH', `/lms-interviews/${item.id}`, {
    feedback: { ratings: { communication: 'GOOD', readability: 'AVERAGE', technical: 'BAD' }, notes: 'Clear on dashboards, shaky on joins.' },
  });
  assert.equal(written.status, 200);
  const fb = written.body.item.feedback;
  assert.deepEqual([fb.score, fb.band, fb.notes], [50, 'AVERAGE', 'Clear on dashboards, shaky on joins.']);
  assert.deepEqual(fb.counts, { good: 1, average: 1, bad: 1, rated: 3 });
  // Who wrote it is the signed-in staff member, never what the request said.
  assert.equal(fb.by, 'Riya');
  assert.ok(fb.at, 'when it was written is kept');

  // It is stored the way the trainer dashboard stores it, so that dashboard reads this one back.
  const doc = await col.findOne({ key: `lms|${item.id}` });
  assert.equal(doc.feedback, 'Clear on dashboards, shaky on joins.', 'the remark is plain text, not an object');
  assert.deepEqual(doc.ratings, { communication: 'Good', readability: 'Average', confidence: null, technical: 'Bad' });
  assert.equal(doc.rank, null);
  assert.equal(doc.reviewedBy.email, 'riya@ijf.example');

  // Changing something else leaves the review where it is.
  const moved = await call('PATCH', `/lms-interviews/${item.id}`, { time: '5:00 PM' });
  assert.equal(moved.body.item.feedback.score, 50);

  // The day's list carries it, along with what interviews are rated on.
  const day = await call('GET', `/lms-interviews?date=${today}`);
  assert.equal(day.body.items[0].feedback.score, 50);
  assert.equal(day.body.feedback.criteria.length > 0, true);
  assert.deepEqual(day.body.feedback.ratings, ['GOOD', 'AVERAGE', 'BAD']);

  // Clearing every rating, the overall and the remark takes it off.
  const cleared = await call('PATCH', `/lms-interviews/${item.id}`, { feedback: { ratings: {}, rank: '', notes: '' } });
  assert.equal(cleared.body.item.feedback, null);
  const off = await col.findOne({ key: `lms|${item.id}` });
  assert.deepEqual([off.feedback, off.rank, off.reviewedAt], [null, null, null]);

  assert.equal((await call('PATCH', `/lms-interviews/${item.id}`, { feedback: { ratings: { charisma: 'GOOD' } } })).status, 400);
});

test("a review written on the trainer dashboard is the one this page shows", async () => {
  const item = await add();
  // Exactly what lms-backend's saveReview writes: the remark as text, the overall and the ratings in words.
  await col.updateOne(
    { key: `lms|${item.id}` },
    {
      $set: {
        feedback: 'Explained the project well. Work on SQL joins.',
        rank: 'Good',
        ratings: { communication: 'Good', readability: 'Average', confidence: 'Good', technical: 'Average' },
        trainer: 'Mr Khanna',
        reviewedBy: { userId: 'user_khanna', name: 'Mr Khanna', email: 'khanna@ijf.example' },
        reviewedAt: new Date(),
      },
    },
  );

  const day = await call('GET', `/lms-interviews?date=${today}`);
  const fb = day.body.items[0].feedback;
  assert.ok(fb, 'the trainer wrote it, so the day shows it');
  assert.equal(fb.notes, 'Explained the project well. Work on SQL joins.');
  assert.equal(fb.score, 75);
  assert.deepEqual(fb.counts, { good: 2, average: 2, bad: 0, rated: 4 });
  // The overall is the trainer's own word on it, not the one the score would have landed on.
  assert.deepEqual([fb.rank, fb.band], ['GOOD', 'GOOD']);
  assert.equal(fb.by, 'Mr Khanna');
  assert.deepEqual(fb.ratings, { communication: 'GOOD', readability: 'AVERAGE', confidence: 'GOOD', technical: 'AVERAGE' });

  // And changing it here writes back the same shape, so the trainer dashboard keeps reading it.
  const changed = await call('PATCH', `/lms-interviews/${item.id}`, { feedback: { ratings: { communication: 'BAD' }, rank: 'BAD', notes: 'Second look: struggled.' } });
  assert.equal(changed.body.item.feedback.band, 'BAD');
  const doc = await col.findOne({ key: `lms|${item.id}` });
  assert.deepEqual([doc.feedback, doc.rank, doc.ratings.communication], ['Second look: struggled.', 'Bad', 'Bad']);
  assert.equal(doc.trainer, 'Mr Khanna', 'who ran the interview is left alone: it is not who is typing now');
});

test('an overall or a remark on its own is a review worth keeping', async () => {
  const item = await add();
  const only = await call('PATCH', `/lms-interviews/${item.id}`, { feedback: { notes: 'Panel will send written feedback tomorrow.' } });
  const fb = only.body.item.feedback;
  assert.deepEqual([fb.score, fb.band, fb.rank, fb.counts.rated], [null, null, null, 0]);
  assert.equal(fb.notes, 'Panel will send written feedback tomorrow.');

  // An overall with nothing else still bands the interview, so it counts on the day's cards.
  const ranked = await call('PATCH', `/lms-interviews/${item.id}`, { feedback: { rank: 'GOOD' } });
  assert.deepEqual([ranked.body.item.feedback.band, ranked.body.item.feedback.score], ['GOOD', null]);
});

test('a review written in the shape this page used at first is still read, and the next save moves it over', async () => {
  const item = await add();
  await col.updateOne(
    { key: `lms|${item.id}` },
    { $set: { feedback: { ratings: { communication: 'GOOD', technical: 'BAD' }, notes: 'Lost the thread on joins.', by: { name: 'Riya' }, at: new Date() } } },
  );
  const day = await call('GET', `/lms-interviews?date=${today}`);
  const fb = day.body.items[0].feedback;
  assert.equal(fb.notes, 'Lost the thread on joins.', 'nothing anybody wrote is thrown away');
  assert.deepEqual(fb.ratings, { communication: 'GOOD', technical: 'BAD' });

  const saved = await call('PATCH', `/lms-interviews/${item.id}`, { feedback: { ratings: { communication: 'GOOD', technical: 'BAD' }, notes: 'Lost the thread on joins.' } });
  assert.equal(saved.status, 200);
  assert.equal(typeof (await col.findOne({ key: `lms|${item.id}` })).feedback, 'string');
});
