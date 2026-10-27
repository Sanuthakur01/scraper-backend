// IJF AI's endpoints (/api/chat…), all for signed-in people with an allowed role:
//   POST   /chat                              ask (the answer streams back as server-sent events)
//   GET    /chat/conversations                one's own chats, newest first
//   GET    /chat/conversations/:id            one of them
//   DELETE /chat/conversations/:id
//   POST   /chat/conversations/:id/messages/:messageId/feedback   { value: 'up' | 'down' | '' }
//   POST   /chat/conversations/:id/actions/:actionId              { decision: 'confirm' | 'cancel' }
//   GET    /chat/briefing                     today's briefing (written once a day, for everyone)
//   GET    /chat/reminders                    what needs attention (counted, no AI)
//   GET    /chat/usage                        questions and tokens per person (admins)

import express from 'express';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { requirePermission } from '../auth.js';
import { can } from '../config/access.js';
import { AiBriefing, AiUsage, Chat } from '../models.js';
import { AiError } from './openai.js';
import { runChat } from './chat.js';
import { BRIEFING_REQUEST } from './prompt.js';
import { callRoute, doAction, needsRemark } from './tools.js';
import { hideContacts, reveal } from './privacy.js';

const router = express.Router();
const wrap = (handler) => (req, res, next) => handler(req, res).catch(next);
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const today = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const MAX_QUESTION = 2000;
const MAX_MESSAGES = 200; // in one chat; older ones are dropped

const LIMIT_REACHED = "You've asked IJF AI a lot today. It will be ready for you again tomorrow.";
const NOT_SET_UP = "IJF AI isn't set up on the server (OPEN_AI_API_KEY is missing).";

const aiOf = (req) => req.app.locals.ai;
const isId = (id) => mongoose.isValidObjectId(id);
const own = (req) => ({ userId: req.person.userId });

// A chat as the person sees it (no stand-ins, no secrets).
const shownMessage = (m) => ({
  id: m._id,
  role: m.role,
  content: m.content,
  at: m.at,
  cards: m.cards ?? [],
  actions: (m.actions ?? []).map((a) => ({ id: a._id, type: a.type, summary: a.summary, status: a.status, error: a.error ?? '' })),
  feedback: m.feedback ?? '',
  error: m.error ?? '',
});

// ---------- asking ----------

router.post('/chat', requirePermission('view'), express.json({ limit: '32kb' }), wrap(async (req, res) => {
  const complete = aiOf(req);
  if (!complete) return res.status(503).json({ error: NOT_SET_UP });
  const question = String(req.body?.message ?? '').trim();
  if (!question) return res.status(400).json({ error: 'Type a question.' });
  if (question.length > MAX_QUESTION) return res.status(400).json({ error: `Keep a question under ${MAX_QUESTION} characters.` });
  const context = req.body?.context && typeof req.body.context === 'object' ? req.body.context : {};

  // The daily limit (counted before asking, so stopping an answer doesn't get round it).
  const usage = await AiUsage.findOneAndUpdate({ email: req.person.email, day: today() }, { $setOnInsert: { questions: 0 } }, { upsert: true, returnDocument: 'after' });
  if (usage.questions >= config.ai.dailyLimit) return res.status(429).json({ error: LIMIT_REACHED });
  await AiUsage.updateOne({ _id: usage._id }, { $inc: { questions: 1 } });

  // The chat it belongs to; one that can't be found (deleted in another tab) starts a new one.
  let chat = isId(req.body?.chatId) ? await Chat.findOne({ _id: req.body.chatId, ...own(req) }) : null;
  chat ??= new Chat({ userId: req.person.userId, email: req.person.email, name: req.person.name, title: question.slice(0, 80), messages: [], secrets: {} });

  // The question is saved first, so the chat the browser is told about exists even if the server stops
  // before the answer is done (e.g. a restart); the next question then carries on in it.
  const secrets = { ...(chat.secrets ?? {}) };
  const modelQuestion = hideContacts(question, secrets);
  const earlier = [...chat.messages];
  chat.messages.push({ role: 'user', content: question, modelContent: modelQuestion, context, at: new Date() });
  chat.secrets = secrets;
  chat.markModified('secrets');
  await chat.save();

  // Server-sent events from here on.
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const emit = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const stop = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) stop.abort();
  });
  emit('start', { chatId: chat._id });

  let result;
  let failure = '';
  try {
    result = await runChat({ complete, chat: { messages: earlier, secrets }, question, request: modelQuestion, context, person: req.person, emit, signal: stop.signal });
  } catch (err) {
    failure = stop.signal.aborted ? 'Stopped.' : err instanceof AiError ? err.message : "IJF AI couldn't answer that. Please try again.";
    if (!(err instanceof AiError) && !stop.signal.aborted) console.error('IJF AI failed:', err);
  }

  chat.messages.push({
    role: 'assistant',
    content: result?.content ?? '',
    modelContent: result?.modelContent,
    cards: result?.cards?.length ? result.cards : undefined,
    actions: result?.actions?.length ? result.actions : undefined,
    tools: result?.tools?.length ? result.tools : undefined,
    tokens: result?.usage,
    error: failure || undefined,
    at: new Date(),
  });
  if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
  chat.secrets = result?.secrets ?? secrets;
  chat.markModified('secrets');
  await chat.save();
  if (result) await AiUsage.updateOne({ _id: usage._id }, { $inc: { promptTokens: result.usage.prompt, completionTokens: result.usage.completion } });

  const answer = chat.messages.at(-1);
  if (failure) emit('error', { message: failure });
  emit('done', { chatId: chat._id, title: chat.title, message: shownMessage(answer) });
  res.end();
}));

// ---------- the person's chats ----------

router.get('/chat/conversations', requirePermission('view'), wrap(async (req, res) => {
  const chats = await Chat.find(own(req), { title: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(30).lean();
  res.json({ items: chats.map((c) => ({ id: c._id, title: c.title, updatedAt: c.updatedAt })) });
}));

router.get('/chat/conversations/:id', requirePermission('view'), wrap(async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'That chat is no longer there.' });
  const chat = await Chat.findOne({ _id: req.params.id, ...own(req) }).lean();
  if (!chat) return res.status(404).json({ error: 'That chat is no longer there.' });
  res.json({ id: chat._id, title: chat.title, messages: chat.messages.map(shownMessage) });
}));

router.delete('/chat/conversations/:id', requirePermission('view'), wrap(async (req, res) => {
  if (isId(req.params.id)) await Chat.deleteOne({ _id: req.params.id, ...own(req) });
  res.json({ ok: true });
}));

router.post('/chat/conversations/:id/messages/:messageId/feedback', requirePermission('view'), express.json({ limit: '1kb' }), wrap(async (req, res) => {
  const value = ['up', 'down'].includes(req.body?.value) ? req.body.value : '';
  if (!isId(req.params.id) || !isId(req.params.messageId)) return res.status(404).json({ error: 'Not found.' });
  const done = await Chat.updateOne({ _id: req.params.id, ...own(req), 'messages._id': req.params.messageId }, { $set: { 'messages.$.feedback': value } });
  if (!done.matchedCount) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true, value });
}));

// A change IJF AI proposed: done (through the dashboard's own routes, recorded as via IJF AI) or cancelled.
router.post('/chat/conversations/:id/actions/:actionId', requirePermission('view'), express.json({ limit: '1kb' }), wrap(async (req, res) => {
  if (!isId(req.params.id) || !isId(req.params.actionId)) return res.status(404).json({ error: 'Not found.' });
  const chat = await Chat.findOne({ _id: req.params.id, ...own(req) });
  const message = chat?.messages.find((m) => m.actions?.some((a) => String(a._id) === req.params.actionId));
  const action = message?.actions.find((a) => String(a._id) === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'That change is no longer there.' });
  if (action.status !== 'pending') return res.json({ action: shownMessage(message).actions.find((a) => String(a.id) === req.params.actionId) });

  if (req.body?.decision === 'cancel') {
    action.status = 'cancelled';
  } else {
    // The person's role must allow the change itself (as on the dashboard).
    const permission = action.type === 'set-follow-up' ? 'record-outcomes' : 'edit-hr-details';
    if (!can(req.person.role, permission)) return res.status(403).json({ error: "Your role can't make this change." });
    try {
      await doAction({ type: action.type, payload: action.payload }, req.person);
      action.status = 'done';
      action.doneAt = new Date();
    } catch (err) {
      action.status = 'failed';
      action.error = [err.message, err.detail].filter(Boolean).join(' ');
    }
  }
  chat.markModified('messages');
  await chat.save();
  res.json({ action: { id: action._id, type: action.type, summary: action.summary, status: action.status, error: action.error ?? '' } });
}));

// ---------- the day's briefing and reminders ----------

router.get('/chat/briefing', requirePermission('view'), wrap(async (req, res) => {
  const complete = aiOf(req);
  if (!complete) return res.status(503).json({ error: NOT_SET_UP });
  const day = today();
  const found = await AiBriefing.findOne({ day }).lean();
  if (found?.text) return res.json({ day, text: found.text, createdAt: found.createdAt });
  if (found) return res.json({ day, writing: true }); // someone's request is writing it
  try {
    await AiBriefing.create({ day });
  } catch {
    return res.json({ day, writing: true });
  }
  try {
    const secrets = {};
    const result = await runChat({
      complete,
      chat: { messages: [], secrets },
      question: BRIEFING_REQUEST,
      request: BRIEFING_REQUEST,
      context: { path: '/', period: { days: 1 } },
      person: { name: 'the team', role: '' },
      emit: () => {},
    });
    const text = reveal(result.modelContent, secrets).trim();
    await AiBriefing.updateOne({ day }, { $set: { text, createdAt: new Date(), tokens: result.usage } });
    res.json({ day, text, createdAt: new Date() });
  } catch (err) {
    await AiBriefing.deleteOne({ day, text: { $in: [null, ''] } });
    res.status(503).json({ error: err instanceof AiError ? err.message : "Today's briefing couldn't be written. Please try again later." });
  }
}));

// What needs attention, counted from the data (no AI, no cost). Each with a link and a question to ask.
router.get('/chat/reminders', requirePermission('view'), wrap(async (req, res) => {
  const [perf, jobsToday, meta] = await Promise.all([
    callRoute('GET', '/performance', { query: { days: 30 } }),
    callRoute('GET', '/jobs', { query: { days: 1, limit: 1 } }),
    callRoute('GET', '/meta'),
  ]);
  const seen = new Set();
  const contacts = perf.rows.filter((row) => {
    const key = `${row.job.id}|${row.field}|${row.key}`;
    return seen.has(key) ? false : seen.add(key);
  });
  const stale = contacts.filter((row) => needsRemark(row) && Date.now() - Date.parse(row.at) >= 3 * DAY_MS).length;
  const unassigned = contacts.filter((row) => !row.outcomes.some((o) => o.student)).length;
  const noDetails = jobsToday.total - jobsToday.withContact;
  const failed = meta.lastRun?.failedSearches?.length ?? 0;
  const items = [
    stale && { id: 'stale', text: `${stale} HR ${stale === 1 ? 'number or email has' : 'numbers and emails have'} had no remark for 3+ days`, href: '/performance?days=30&show=contacts&filter=no-remark', ask: 'Which HR numbers and emails have had no remark for 3 or more days?' },
    unassigned && { id: 'unassigned', text: `${unassigned} HR ${unassigned === 1 ? 'contact isn’t' : 'contacts aren’t'} given to a student yet`, href: '/assign?days=30', ask: "Which HR numbers and emails aren't given to a student yet?" },
    noDetails > 0 && { id: 'no-details', text: `${noDetails} of the latest day's ${jobsToday.total} new jobs ${noDetails === 1 ? 'has' : 'have'} no HR details yet`, ask: "Which of the latest day's new jobs have no HR details yet?" },
    failed && { id: 'collection', text: `The last collection had ${failed} failed ${failed === 1 ? 'search' : 'searches'}`, ask: 'Did the last collection work? What failed?' },
  ].filter(Boolean);
  res.json({ items });
}));

// ---------- usage, for admins ----------

router.get('/chat/usage', requirePermission('view-ai-usage'), wrap(async (req, res) => {
  const since = new Date(Date.now() + IST_OFFSET_MS - 30 * DAY_MS).toISOString().slice(0, 10);
  const [usage, feedback] = await Promise.all([
    AiUsage.aggregate([
      { $match: { day: { $gte: since } } },
      { $group: { _id: '$email', questions: { $sum: '$questions' }, promptTokens: { $sum: '$promptTokens' }, completionTokens: { $sum: '$completionTokens' }, days: { $sum: 1 } } },
      { $sort: { questions: -1 } },
    ]),
    Chat.aggregate([{ $unwind: '$messages' }, { $match: { 'messages.feedback': { $in: ['up', 'down'] } } }, { $group: { _id: { email: '$email', value: '$messages.feedback' }, n: { $sum: 1 } } }]),
  ]);
  const thumbs = (email, value) => feedback.find((f) => f._id.email === email && f._id.value === value)?.n ?? 0;
  const briefings = await AiBriefing.find({ day: { $gte: since } }, { tokens: 1 }).lean();
  res.json({
    since,
    model: config.ai.model,
    people: usage.map((u) => ({ email: u._id, questions: u.questions, promptTokens: u.promptTokens, completionTokens: u.completionTokens, activeDays: u.days, up: thumbs(u._id, 'up'), down: thumbs(u._id, 'down') })),
    briefings: { count: briefings.length, promptTokens: briefings.reduce((n, b) => n + (b.tokens?.prompt ?? 0), 0), completionTokens: briefings.reduce((n, b) => n + (b.tokens?.completion ?? 0), 0) },
  });
}));

export default router;
