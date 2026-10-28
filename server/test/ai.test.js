// IJF AI (src/ai/), with a stand-in for OpenAI that asks for tools the way the real model does. Checks that
// no phone number or email ever reaches it, that its numbers are the dashboard's, that nothing changes
// before the person confirms, the daily limit, the chat history, reminders and the briefing.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { config } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { Activity, AiBriefing, Chat, CollectorRun, ContactOutcome, Job } from '../src/models.js';
import { AuthError } from '../src/auth.js';
import { roleFrom } from '../src/config/access.js';
import { AiError } from '../src/ai/openai.js';
import { createRevealer, hasContacts, hideContacts, protect, reveal } from '../src/ai/privacy.js';

const HOUR = 3_600_000;
const ADMIN = { userId: 'user_admin', email: 'admin@example.com', name: 'Asha Admin', role: 'ADMIN' };
async function identify(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!token) return ADMIN;
  if (token === 'expired') throw new AuthError(401, 'Your sign-in has expired. Reload the page, then try again.');
  const [role, email] = token.split(':');
  return { userId: `user_${email}`, email, name: email.split('@')[0], role: roleFrom({ role }) };
}

// The stand-in model. Each call takes the next step of `script`: { tools: [{ name, args }] } or { text }
// (text or args may be functions of what it was sent). `sent` keeps everything it was given.
let script = [];
let calls = 0;
const sent = [];
async function fakeAi({ messages, toolChoice, onText }) {
  calls++;
  sent.push(JSON.stringify(messages));
  const step = script.shift() ?? { text: 'Done.' };
  if (step.during) await step.during();
  if (step.fail) throw step.fail;
  if (step.tools && toolChoice !== 'none') {
    return {
      content: '',
      toolCalls: step.tools.map((t, n) => ({ id: `call_${calls}_${n}`, name: t.name, arguments: JSON.stringify(typeof t.args === 'function' ? t.args(messages) : (t.args ?? {})) })),
      usage: { prompt: 100, completion: 10 },
    };
  }
  const text = typeof step.text === 'function' ? step.text(messages) : (step.text ?? 'Done.');
  for (const piece of text.match(/[\s\S]{1,5}/g) ?? []) onText(piece); // in small pieces, as it streams
  return { content: text, toolCalls: [], usage: { prompt: 100, completion: 20 } };
}
const lastTool = (messages) => JSON.parse(messages.filter((m) => m.role === 'tool').at(-1).content);

let mongo;
let server;
let base;
let job1;
let job2;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  await Promise.all([Job.init(), ContactOutcome.init()]);
  const now = Date.now();
  await CollectorRun.create({ startedAt: new Date(now - HOUR), finishedAt: new Date(now - HOUR), status: 'success', searches: [{ platform: 'Indeed', term: 'data analyst', status: 'error' }] });
  const job = (n, extra) => ({
    fingerprint: `f${n}`, title: `Data Analyst ${n}`, company: `Company ${n}`, course: 'data-analyst', cities: ['Pune'],
    firstSeenAt: new Date(now - 2 * HOUR), lastSeenAt: new Date(now - 2 * HOUR), sourceKeys: [`X:${n}`],
    primaryPlatform: 'Naukri', platforms: ['Naukri'], links: { Naukri: `https://example.com/${n}` }, experienceMin: 3, experienceBand: '3', ...extra,
  });
  [job1, job2] = await Job.create([
    job(1, { company: 'Acme Analytics', manual: { phone: '98450 12345', phoneKeys: ['9845012345'], email: 'hr@acme.in', hrNames: ['Riya Sharma'], remarks: 'Call after 5 pm on 080 4123 45678', updatedAt: new Date(now) } }),
    job(2, { company: 'Zeta Labs' }),
    job(3, { course: 'data-science', company: 'Crown', foundPhones: ['+91 99866 00010'] }),
  ]);
  server = createApp({ identify, ai: (...args) => fakeAi(...args) }).listen(0);
  base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server.close();
  await disconnectDb();
  await mongo.stop();
});

// Asks a question; returns the events, the answer as streamed, and the final message.
async function ask(message, { chatId, context = { path: '/', period: { days: 1 }, view: 'filtered' }, auth } = {}) {
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ message, chatId, context }),
  });
  if (!res.headers.get('content-type')?.includes('text/event-stream')) return { status: res.status, body: await res.json() };
  const raw = await res.text();
  const events = raw
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({ event: block.match(/^event: (.*)$/m)?.[1], data: JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? 'null') }));
  const done = events.find((e) => e.event === 'done')?.data;
  return { status: res.status, events, streamed: events.filter((e) => e.event === 'text').map((e) => e.data).join(''), done };
}
const json = async (path, options = {}) => {
  const res = await fetch(`${base}/${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } });
  return { status: res.status, body: await res.json() };
};

test('privacy: phone numbers and emails become stand-ins, the same one each time; dates, counts and ids stay', () => {
  const secrets = {};
  const text = hideContacts('Call 98450 12345 or +91 98450-12345, mail HR@acme.in, then hr@acme.in. On 2026-10-22 we had 4,513 jobs; id 6523a1b2c3d4e5f601234567.', secrets);
  assert.equal(text, 'Call [phone 1] or [phone 1], mail [email 1], then [email 1]. On 2026-10-22 we had 4,513 jobs; id 6523a1b2c3d4e5f601234567.');
  assert.ok(!hasContacts(text));
  assert.equal(reveal('Ring [phone 1]', secrets), 'Ring 98450 12345');
  assert.deepEqual(protect({ list: ['x 080 4123 4567 y'], n: 3 }, secrets), { list: ['x [phone 2] y'], n: 3 });
  const r = createRevealer(secrets);
  assert.equal(r.push('Call [pho') + r.push('ne 1] now') + r.flush(), 'Call 98450 12345 now', 'a stand-in split while streaming');
});

test('a question: its numbers come from the tools, no contact ever reaches the AI, the person sees the real ones', async () => {
  sent.length = 0;
  script = [
    { tools: [{ name: 'get_summary', args: { days: 1 } }] },
    { tools: [{ name: 'show_contacts', args: { company: 'Acme Analytics' } }] },
    { text: (m) => `Today: ${lastTool(m).shownToThePerson[0].phones[0]} and ${lastTool(m).shownToThePerson[0].emails[0]} are Acme's HR. You asked about [phone 1].` },
  ];
  const summary = (await json('summary?days=1')).body;
  const answer = await ask('How many jobs today? Also who is HR at Acme? My number is 93456 70061');
  assert.equal(answer.status, 200);
  const toolResult = JSON.parse(JSON.parse(sent[1]).at(-1).content);
  assert.equal(toolResult.total, Object.values(summary.current).reduce((a, b) => a + b, 0), "the dashboard's numbers");
  for (const words of sent) assert.ok(!hasContacts(words), `nothing with a contact is sent: ${words.match(/\d{5} \d{5}|\S+@\S+\.\w+/)}`);
  assert.ok(!sent.join('').includes('98450') && !sent.join('').includes('acme.in') && !sent.join('').includes('93456'), 'not even in pieces');
  const card = answer.events.find((e) => e.event === 'card' && e.data.type === 'contacts').data;
  assert.deepEqual([card.jobs[0].phones, card.jobs[0].emails], [['98450 12345'], ['hr@acme.in']], 'the card has the real contacts');
  assert.equal(answer.done.message.content, "Today: 98450 12345 and hr@acme.in are Acme's HR. You asked about 93456 70061.", 'the stand-ins put back');
  assert.equal(answer.streamed.trim(), answer.done.message.content, 'and while streaming');
  const status = answer.events.filter((e) => e.event === 'status').map((e) => e.data);
  assert.deepEqual(status, ['Counting new jobs', 'Getting HR contacts']);
});

test('a proposed change waits for Confirm; then it is saved like on the dashboard and recorded as via IJF AI', async () => {
  script = [{ tools: [{ name: 'propose_hr_details', args: { job_id: String(job2._id), phones: ['[phone 1]'], hr_names: ['Anil Kumar'], found_by: 'apollo' } }] }, { text: 'Check the card and click Confirm.' }];
  const first = await ask('Add 93456 70071 and HR Anil Kumar to the Zeta Labs job');
  const action = first.done.message.actions[0];
  assert.equal(action.status, 'pending');
  assert.match(action.summary, /93456 70071/, 'the person sees the real number');
  assert.equal((await Job.findById(job2._id).lean()).manual, undefined, 'nothing saved yet');

  const confirm = await json(`chat/conversations/${first.done.chatId}/actions/${action.id}`, { method: 'POST', body: JSON.stringify({ decision: 'confirm' }) });
  assert.equal(confirm.body.action.status, 'done');
  const saved = (await Job.findById(job2._id).lean()).manual;
  assert.deepEqual([saved.phone, saved.hrNames], ['93456 70071', ['Anil Kumar']]);
  const record = await Activity.findOne({ 'job.id': job2._id }).sort({ at: -1 }).lean();
  assert.deepEqual([record.via, record.actor.email], ['ai', ADMIN.email]);
  const again = await json(`chat/conversations/${first.done.chatId}/actions/${action.id}`, { method: 'POST', body: JSON.stringify({ decision: 'confirm' }) });
  assert.equal(again.body.action.status, 'done', 'confirmed once only');
  assert.equal(await Activity.countDocuments({ 'job.id': job2._id }), 1);

  // The AI knows what happened, in the next turn.
  script = [{ text: 'Noted.' }];
  sent.length = 0;
  await ask('thanks', { chatId: first.done.chatId });
  assert.match(sent[0], /confirmed and saved/);

  // A number another job has: no change proposed; the AI is told why.
  script = [{ tools: [{ name: 'propose_hr_details', args: { job_id: String(job2._id), phones: ['[phone 1]'], found_by: 'apollo' } }] }, { text: (m) => lastTool(m).error }];
  const taken = await ask('Add 98450 12345 to Zeta Labs');
  assert.equal(taken.done.message.actions.length, 0);
  assert.match(taken.done.message.content, /This number already exists/);

  // A follow-up for one of a job's numbers (named by its stand-in), then cancelled.
  script = [
    { tools: [{ name: 'show_contacts', args: { job_id: String(job1._id) } }] },
    { tools: [{ name: 'propose_follow_up', args: (m) => ({ job_id: String(job1._id), contact: lastTool(m).shownToThePerson[0].phones[0], student: 'Kavya Rao', remark: 'cv-shared' }) }] },
    { text: 'Click Confirm.' },
  ];
  const follow = await ask("Mark Acme's number as CV shared and give it to Kavya Rao");
  const proposal = follow.done.message.actions[0];
  assert.match(proposal.summary, /^98450 12345 \(Data Analyst 1 at Acme Analytics\): give it to Kavya Rao; remark "CV shared"/);
  await json(`chat/conversations/${follow.done.chatId}/actions/${proposal.id}`, { method: 'POST', body: JSON.stringify({ decision: 'confirm' }) });
  const outcome = await ContactOutcome.findOne({ job: job1._id }).lean();
  assert.deepEqual([outcome.student, outcome.status], ['Kavya Rao', 'cv-shared']);

  script = [{ tools: [{ name: 'propose_hr_details', args: { job_id: String(job1._id), students: ['Neha'] } }] }, { text: 'Confirm?' }];
  const cancel = await ask('Give the Acme job to Neha too');
  const c = await json(`chat/conversations/${cancel.done.chatId}/actions/${cancel.done.message.actions[0].id}`, { method: 'POST', body: JSON.stringify({ decision: 'cancel' }) });
  assert.equal(c.body.action.status, 'cancelled');
  assert.ok(!(await Job.findById(job1._id).lean()).manual.assignedTo?.includes('Neha'));
});

test('chats are kept per person, with feedback; nobody else can open them', async () => {
  script = [{ text: 'Hello.' }];
  const a = await ask('hi', { auth: 'RESEARCH_TEAM:riya@example.com' });
  const list = await json('chat/conversations', { headers: { Authorization: 'Bearer RESEARCH_TEAM:riya@example.com' } });
  assert.deepEqual(list.body.items.map((c) => c.title), ['hi']);
  const open = await json(`chat/conversations/${a.done.chatId}`, { headers: { Authorization: 'Bearer RESEARCH_TEAM:riya@example.com' } });
  assert.deepEqual(open.body.messages.map((m) => [m.role, m.content]), [['user', 'hi'], ['assistant', 'Hello.']]);
  assert.ok(!JSON.stringify(open.body).includes('modelContent') && !JSON.stringify(open.body).includes('secrets'));
  assert.equal((await json(`chat/conversations/${a.done.chatId}`)).status, 404, "someone else's chat");
  const fb = await json(`chat/conversations/${a.done.chatId}/messages/${a.done.message.id}/feedback`, { method: 'POST', headers: { Authorization: 'Bearer RESEARCH_TEAM:riya@example.com' }, body: JSON.stringify({ value: 'up' }) });
  assert.equal(fb.body.value, 'up');
  assert.equal((await Chat.findById(a.done.chatId).lean()).messages[1].feedback, 'up');
  await json(`chat/conversations/${a.done.chatId}`, { method: 'DELETE', headers: { Authorization: 'Bearer RESEARCH_TEAM:riya@example.com' } });
  assert.equal(await Chat.countDocuments({ _id: a.done.chatId }), 0);
});

test('the daily limit stops more questions without saying the number', async () => {
  const saved = config.ai.dailyLimit;
  config.ai.dailyLimit = 2;
  try {
    script = [{ text: 'One.' }, { text: 'Two.' }];
    for (const q of ['q1', 'q2']) assert.equal((await ask(q, { auth: 'PLACEMENT_STAFF:limit@example.com' })).status, 200);
    const third = await ask('q3', { auth: 'PLACEMENT_STAFF:limit@example.com' });
    assert.equal(third.status, 429);
    assert.equal(third.body.error, "You've asked IJF AI a lot today. It will be ready for you again tomorrow.");
    assert.ok(!/\d/.test(third.body.error), 'no number in it');
  } finally {
    config.ai.dailyLimit = saved;
  }
});

test('when the AI fails or is stopped: a clear message, kept in the chat', async () => {
  script = [{ fail: new AiError('IJF AI is busy right now. Please try again in a minute.') }];
  const r = await ask('anything');
  assert.deepEqual(r.events.find((e) => e.event === 'error').data, { message: 'IJF AI is busy right now. Please try again in a minute.' });
  assert.equal(r.done.message.error, 'IJF AI is busy right now. Please try again in a minute.');
});

test('reminders are counted from the data; the briefing is written once a day', async () => {
  await Job.create({ fingerprint: 'f4', title: 'Data Analyst 4', company: 'Nova', course: 'data-analyst', firstSeenAt: new Date(Date.now() - HOUR), lastSeenAt: new Date(), sourceKeys: ['X:4'], primaryPlatform: 'Naukri', platforms: ['Naukri'] });
  const reminders = (await json('chat/reminders')).body.items;
  assert.ok(reminders.some((r) => r.id === 'collection' && /1 failed search/.test(r.text)), JSON.stringify(reminders));
  assert.ok(reminders.some((r) => r.id === 'no-details' && /1 of the latest day's 4 new jobs has no HR details/.test(r.text)));

  await AiBriefing.deleteMany({});
  script = [{ tools: [{ name: 'get_summary', args: { days: 1 } }, { name: 'get_collection_status' }] }, { text: '- 3 new jobs today.\n- Indeed had a failed search.' }];
  const before = calls;
  const first = (await json('chat/briefing')).body;
  assert.equal(first.text, '- 3 new jobs today.\n- Indeed had a failed search.');
  const usedCalls = calls - before;
  const second = (await json('chat/briefing')).body;
  assert.equal(second.text, first.text);
  assert.equal(calls - before, usedCalls, 'the second time costs nothing');
});

test('sign-in, roles, usage for admins, and a server without a key', async () => {
  assert.equal((await ask('hi', { auth: 'expired' })).status, 401);
  assert.equal((await ask('hi', { auth: 'STUDENT:x@example.com' })).status, 403);
  assert.equal((await json('chat/usage', { headers: { Authorization: 'Bearer RESEARCH_TEAM:riya@example.com' } })).status, 403, 'usage is for admins');
  const usage = (await json('chat/usage')).body;
  assert.ok(usage.people.some((p) => p.email === ADMIN.email && p.questions > 0 && p.promptTokens > 0));

  const plain = createApp({ identify, ai: null }).listen(0);
  try {
    const url = `http://localhost:${plain.address().port}/api`;
    const meta = await (await fetch(`${url}/meta`)).json();
    assert.equal(meta.aiEnabled, false);
    const res = await fetch(`${url}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /isn't set up/);
  } finally {
    plain.close();
  }
});

test('the question is saved before the answer, and a chat that is gone starts a new one', async () => {
  let savedWhileAnswering = null;
  script = [{ during: async () => (savedWhileAnswering = await Chat.findOne({ 'messages.content': 'saved first?' }).lean()), text: 'Yes.' }];
  const r = await ask('saved first?', { auth: 'RESEARCH_TEAM:keep@example.com' });
  assert.ok(savedWhileAnswering, 'the chat and its question exist while the AI is still answering (a restart then loses only the answer)');
  assert.deepEqual(savedWhileAnswering.messages.map((m) => m.role), ['user']);
  assert.deepEqual((await Chat.findById(r.done.chatId).lean()).messages.map((m) => m.role), ['user', 'assistant']);

  script = [{ text: 'New chat.' }];
  const gone = await ask('after a restart', { chatId: '0123456789abcdef01234567', auth: 'RESEARCH_TEAM:keep@example.com' });
  assert.equal(gone.status, 200);
  assert.notEqual(String(gone.done.chatId), '0123456789abcdef01234567');
  assert.equal(gone.done.message.content, 'New chat.');
});
