// The LMS's "Today's Interviews" (src/lmsInterviews.js): a day's interviews, add one, change one (its status:
// rescheduled, cancelled, placed), take one out (added by mistake). The LMS (ijfpc_frontend) calls these through
// its own route (app/api/lms-interviews), with the person's Clerk sign-in: the same Clerk as this dashboard, so
// their role is read from it here. Needs manage-interviews (the roles the LMS's placement page lets in).
import express from 'express';
import mongoose from 'mongoose';
import { requirePermission } from '../auth.js';
import {
  changeSet,
  COURSE_ORDER,
  dayOrder,
  IN_USE,
  interviewView,
  istToday,
  newInterviewDoc,
  parseInterviewInput,
  sameInterview,
  STATUSES,
} from '../lmsInterviews.js';
import { FEEDBACK_CRITERIA, NOTES_LIMIT, RATINGS } from '../interviewFeedback.js';
import { COURSES } from '../config/courses.js';
import { MIN_QUERY, searchStudents } from '../lmsStudents.js';

const router = express.Router();
const wrap = (handler) => (req, res, next) => handler(req, res).catch(next);
const can = requirePermission('manage-interviews');

// The collection, or a 503 saying why not (LMS_MONGO_URI not set, or the LMS database can't be reached).
async function interviewsOf(req, res) {
  const store = req.app.locals.lms;
  if (!store) {
    res.status(503).json({ error: "The LMS database isn't connected on the HR server (LMS_MONGO_URI)." });
    return null;
  }
  try {
    return await store.collection();
  } catch (err) {
    console.error(`LMS database: ${err.message}`);
    res.status(503).json({ error: 'Could not reach the LMS database. Try again in a minute.' });
    return null;
  }
}

// The LMS database itself (its users/courses), for the name picker.
async function lmsDbOf(req, res) {
  const store = req.app.locals.lms;
  if (!store || typeof store.db !== 'function') {
    res.status(503).json({ error: "The LMS database isn't connected on the HR server (LMS_MONGO_URI)." });
    return null;
  }
  try {
    return await store.db();
  } catch (err) {
    console.error(`LMS database: ${err.message}`);
    res.status(503).json({ error: 'Could not reach the LMS database. Try again in a minute.' });
    return null;
  }
}

const idOf = (req) => (/^[a-f\d]{24}$/i.test(req.params.id) ? new mongoose.Types.ObjectId(req.params.id) : null);
const describe = (d) => `${d.studentName} already has this interview on ${d.date.split('-').reverse().join('/')} (${[d.company, d.round].filter(Boolean).join(', ')}).`;

// The same interview already in the list (not this one): a second person adding it, or a typo'd copy.
async function duplicateOf(col, fields, exceptId = null) {
  const sameDay = await col.find({ date: fields.date, ...IN_USE, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).toArray();
  return sameDay.find((d) => sameInterview(d, fields)) ?? null;
}

// GET /api/lms-interviews?date=YYYY-MM-DD (default: today, IST): the day's interviews in the sheet's order.
router.get('/lms-interviews', can, wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date ?? '')) ? String(req.query.date) : istToday();
  const col = await interviewsOf(req, res);
  if (!col) return;
  const docs = (await col.find({ date, ...IN_USE }).toArray()).sort(dayOrder);
  res.json({
    date,
    today: istToday(),
    items: docs.map(interviewView),
    courses: COURSE_ORDER.map((id) => ({ id, name: COURSES.find((c) => c.id === id)?.name ?? id })),
    statuses: STATUSES,
    // What an interview is rated on, and how. Sent with the day so the LMS's feedback form and its picture are
    // always the server's list: adding a criterion here does not need the LMS to be changed too.
    feedback: { criteria: FEEDBACK_CRITERIA, ratings: RATINGS, notesLimit: NOTES_LIMIT },
  });
}));

// GET /api/lms-interviews/students?q=...: LMS students whose name matches, for the add form's picker. Declared
// before the /:id routes so "students" is never read as an interview id.
router.get('/lms-interviews/students', can, wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < MIN_QUERY) return res.json({ query: q, items: [] });
  const db = await lmsDbOf(req, res);
  if (!db) return;
  res.json({ query: q, items: await searchStudents(db, q) });
}));

// POST /api/lms-interviews: add one. 409 when the same interview is already there.
router.post('/lms-interviews', can, express.json({ limit: '4kb' }), wrap(async (req, res) => {
  const parsed = parseInterviewInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const col = await interviewsOf(req, res);
  if (!col) return;
  const doc = newInterviewDoc(parsed.value, req.person);
  const twin = await duplicateOf(col, doc);
  if (twin) return res.status(409).json({ error: describe(twin), item: interviewView(twin) });
  await col.insertOne(doc);
  res.status(201).json({ item: interviewView(doc) });
}));

// PATCH /api/lms-interviews/:id: change any of its fields (the status most often).
router.patch('/lms-interviews/:id', can, express.json({ limit: '4kb' }), wrap(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(404).json({ error: 'That interview was not found.' });
  const parsed = parseInterviewInput(req.body, { partial: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const col = await interviewsOf(req, res);
  if (!col) return;
  const old = await col.findOne({ _id: id, ...IN_USE });
  if (!old) return res.status(404).json({ error: 'That interview was not found (removed by someone else?).' });
  const changed = { ...old, ...parsed.value };
  if (['date', 'studentName', 'company', 'round'].some((f) => f in parsed.value)) {
    const twin = await duplicateOf(col, { ...changed, roundGroup: undefined }, id);
    if (twin) return res.status(409).json({ error: describe(twin), item: interviewView(twin) });
  }
  const updated = await col.findOneAndUpdate({ _id: id }, { $set: changeSet(parsed.value, req.person) }, { returnDocument: 'after' });
  res.json({ item: interviewView(updated) });
}));

// DELETE /api/lms-interviews/:id: take out an interview added by mistake (a cancelled one is marked, not taken out).
router.delete('/lms-interviews/:id', can, wrap(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(404).json({ error: 'That interview was not found.' });
  const col = await interviewsOf(req, res);
  if (!col) return;
  const old = await col.findOneAndDelete({ _id: id });
  if (!old) return res.status(404).json({ error: 'That interview was not found (removed by someone else?).' });
  console.log(`LMS interview ${id} (${old.date}) removed by ${req.person.email}`);
  res.status(204).end();
}));

export default router;
