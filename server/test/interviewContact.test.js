// Where an interview came from (src/interviewContact.js), the page's "Source": an outgoing call, an incoming
// call or a mail, with the number or address it came through. Names, numbers and addresses are made up.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { LMS_COLLECTION } from '../src/allInterviews.js';
import { istToday } from '../src/lmsInterviews.js';
import { contactView, parseContact } from '../src/interviewContact.js';

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

test('a source is a way in and the number or address it came through', () => {
  assert.deepEqual(parseContact({ via: 'OUTGOING', detail: ' 98765 43210 ' }), { value: { via: 'OUTGOING', detail: '98765 43210' } });
  assert.deepEqual(parseContact({ via: 'incoming', detail: '+91 (22) 4000 1234' }), { value: { via: 'INCOMING', detail: '+91 (22) 4000 1234' } });
  // A number is kept as it was written — it is dialled by a person, not matched by a machine.
  assert.deepEqual(parseContact({ via: 'MAIL', detail: 'HR@Gamma.example' }), { value: { via: 'MAIL', detail: 'hr@gamma.example' } });
  // Nothing written is "not recorded": clearing the fields is how a source entered by mistake comes off.
  assert.deepEqual(parseContact({ via: '', detail: '' }), { value: null });
  assert.deepEqual(parseContact(null), { value: null });
});

test('a way in without the number or address is refused, and so is a number that is not one', () => {
  assert.match(parseContact({ via: 'OUTGOING', detail: '' }).error, /Write the outgoing number/);
  assert.match(parseContact({ via: 'MAIL', detail: '  ' }).error, /Write the email address/);
  assert.match(parseContact({ via: '', detail: '9876543210' }).error, /Choose how the interview came in/);
  assert.match(parseContact({ via: 'WHATSAPP', detail: '9876543210' }).error, /outgoing call, an incoming call or a mail/);
  assert.match(parseContact({ via: 'INCOMING', detail: '12345' }).error, /7 to 15/);
  assert.match(parseContact({ via: 'INCOMING', detail: '9876543210987654' }).error, /7 to 15/);
  assert.match(parseContact({ via: 'OUTGOING', detail: 'ask reception' }).error, /in digits/);
  assert.match(parseContact({ via: 'MAIL', detail: 'hr@gamma' }).error, /name@company\.com/);
  assert.match(parseContact({ via: 'MAIL', detail: `${'x'.repeat(115)}@gamma.example` }).error, /too long/);
  assert.match(parseContact('outgoing').error, /not understood/);
  // Half a source on an older record is shown as none, not as a source with nothing to go on.
  assert.equal(contactView(null), null);
  assert.equal(contactView({ via: 'OUTGOING', detail: '' }), null);
  assert.equal(contactView({ via: 'CARRIER PIGEON', detail: '9876543210' }), null);
});

test('write the source with the interview, change it, and take it off', async () => {
  const added = await call('POST', '/lms-interviews', { ...ENTRY, contact: { via: 'OUTGOING', detail: '98765 43210' } });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.item.contact, { via: 'OUTGOING', label: 'Outgoing call', detail: '98765 43210', detailKind: 'phone' });

  // An interview added without one has none, rather than being held up for it.
  const plain = await call('POST', '/lms-interviews', { ...ENTRY, studentName: 'Neha Rao', company: 'Delta Retail' });
  assert.equal(plain.body.item.contact, null);

  const id = added.body.item.id;
  const changed = await call('PATCH', `/lms-interviews/${id}`, { contact: { via: 'MAIL', detail: 'hr@gamma.example' } });
  assert.deepEqual([changed.body.item.contact.via, changed.body.item.contact.detail], ['MAIL', 'hr@gamma.example']);

  // Changing something else leaves the source where it is.
  const moved = await call('PATCH', `/lms-interviews/${id}`, { time: '5:00 PM' });
  assert.equal(moved.body.item.contact.detail, 'hr@gamma.example');

  // The day's list carries it, along with the ways an interview can come in.
  const day = await call('GET', `/lms-interviews?date=${today}`);
  assert.equal(day.body.items.find((i) => i.id === id).contact.label, 'Mail');
  assert.deepEqual(day.body.contact.vias.map((v) => v.id), ['OUTGOING', 'INCOMING', 'MAIL']);

  const cleared = await call('PATCH', `/lms-interviews/${id}`, { contact: null });
  assert.equal(cleared.body.item.contact, null);
  assert.equal((await col.findOne({ _id: new mongoose.Types.ObjectId(id) })).contact, null);

  assert.equal((await call('PATCH', `/lms-interviews/${id}`, { contact: { via: 'OUTGOING' } })).status, 400);
  assert.equal((await call('POST', '/lms-interviews', { ...ENTRY, studentName: 'Vikram Shah', contact: { via: 'MAIL', detail: 'nope' } })).status, 400);
});
