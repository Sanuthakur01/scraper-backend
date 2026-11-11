// Interviews entered in the LMS (ijfpc_frontend: "Today's Interviews", on the placement page), kept in the LMS
// database's all_interviews (src/allInterviews.js). Since 11 Nov 2026 that collection is where interviews come
// from: the staff add each day's interviews there, as they wrote them in the sheet (course, student, time,
// company, round, room), and mark one rescheduled, cancelled or placed. The HR dashboard's Interviews page reads
// the same collection (GET /api/interviews), and the sheet is no longer read.
//
// An interview from the sheet (the backfill) can be changed in the LMS too; it is then the LMS's (source: 'lms'),
// so a later copy of the sheet (npm run sync-interviews) never overwrites it.
import mongoose from 'mongoose';
import { COURSES } from './config/courses.js';
import { minutesOf, roundGroupOf } from './interviews.js';
import { connectLms } from './allInterviews.js';

// What the staff can mark an interview as: '' = scheduled (nothing written, as in the sheet).
export const STATUSES = ['', 'RESCHEDULED', 'CANCELLED', 'PLACED'];
// The courses, in the order of the sheet's blocks (PS, DA, DS, DE).
export const COURSE_ORDER = ['production-support', 'data-analyst', 'data-science', 'data-engineering'];
const COURSE_NAMES = new Map(COURSES.map((c) => [c.id, c.name]));
const LIMITS = { studentName: 80, company: 120, time: 20, round: 60, room: 60 };
const IST_OFFSET_MS = 330 * 60_000;

export const istToday = (now = new Date()) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const realDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s) && s >= '2020-01-01' && s <= '2099-12-31';
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase(); // written as in the sheet: capitals
const lettersOnly = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '');
const lettersAndDigits = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// The status flags, from the status as written. A sheet interview's status is free text ("RESCHEDULED FOR
// TOMORROW", "CANCEL FORM OUR SIDE"); the LMS writes one of STATUSES.
export const flagsOf = (status) => ({
  placed: /\b(placed|selected)\b/i.test(status),
  rescheduled: /\bre-?schedul/i.test(status),
  cancelled: /\bcancel/i.test(status),
});

// A request's fields -> { value } (cleaned) or { error } (what to fix). partial: only the fields sent (a change);
// otherwise a new interview: date, course, student and company are needed.
export function parseInterviewInput(body, { partial = false } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const value = {};
  const has = (field) => Object.hasOwn(input, field);
  if (!partial || has('date')) {
    const date = String(input.date ?? '').trim();
    if (!realDay(date)) return { error: 'Choose the day of the interview.' };
    value.date = date;
  }
  if (!partial || has('course')) {
    const course = String(input.course ?? '').trim();
    if (!COURSE_NAMES.has(course)) return { error: 'Choose the course.' };
    value.course = course;
  }
  for (const field of ['studentName', 'company', 'time', 'round', 'room']) {
    if (partial && !has(field)) continue;
    const text = clean(input[field]);
    if (text.length > LIMITS[field]) return { error: `${field === 'studentName' ? 'The name' : `The ${field}`} is too long (at most ${LIMITS[field]} characters).` };
    value[field] = text;
  }
  if (value.studentName !== undefined && !value.studentName) return { error: "Write the student's name." };
  if (value.company !== undefined && !value.company) return { error: 'Write the company.' };
  if (!partial || has('status')) {
    const status = clean(input.status);
    if (!STATUSES.includes(status)) return { error: 'Choose Scheduled, Rescheduled, Cancelled or Placed.' };
    value.status = status;
  }
  if (partial && !Object.keys(value).length) return { error: 'Nothing to change.' };
  return { value };
}

// The fields worked out from the ones typed (as the sheet copy works them out): minutes for sorting, the round's
// group, the course's name, the status flags, the day as a date.
function derived(fields) {
  const out = {};
  if (fields.date !== undefined) out.interviewDate = new Date(`${fields.date}T00:00:00.000Z`);
  if (fields.course !== undefined) out.courseName = COURSE_NAMES.get(fields.course) ?? null;
  if (fields.time !== undefined) out.minutes = minutesOf(fields.time);
  if (fields.round !== undefined) out.roundGroup = roundGroupOf(fields.round);
  if (fields.status !== undefined) Object.assign(out, flagsOf(fields.status));
  return out;
}

const personOf = (person) => ({ userId: person.userId, name: person.name || person.email, email: person.email });

// A new interview's document (its key: "lms|<id>", unique like the sheet's; never one of the sheet's keys).
export function newInterviewDoc(value, person, now = new Date()) {
  const _id = new mongoose.Types.ObjectId();
  return {
    _id,
    key: `lms|${_id}`,
    ...value,
    ...derived(value),
    source: 'lms',
    createdBy: personOf(person),
    createdAt: now,
    updatedBy: personOf(person),
    updatedAt: now,
  };
}

// A change's $set: the fields changed, what follows from them, who changed it. The interview is the LMS's from now.
export const changeSet = (value, person, now = new Date()) => ({ ...value, ...derived(value), source: 'lms', updatedBy: personOf(person), updatedAt: now });

// The same interview: the same day, student, company and round (as the sheet copy's key).
export const sameInterview = (a, b) =>
  a.date === b.date &&
  lettersOnly(a.studentName) === lettersOnly(b.studentName) &&
  lettersAndDigits(a.company) === lettersAndDigits(b.company) &&
  lettersAndDigits(a.roundGroup ?? roundGroupOf(a.round)) === lettersAndDigits(b.roundGroup ?? roundGroupOf(b.round));

// Interviews still in use: a sheet interview taken out of the sheet before the switch is kept, marked inSheet: false.
export const IN_USE = { inSheet: { $ne: false } };

// The order of a day's list (and its picture): by course as the sheet's blocks, then as entered (the sheet's rows
// first, in row order; then the LMS's, by when they were added).
export function dayOrder(a, b) {
  const course = (d) => (COURSE_ORDER.includes(d.course) ? COURSE_ORDER.indexOf(d.course) : COURSE_ORDER.length);
  return course(a) - course(b) || (a.source === 'lms') - (b.source === 'lms') || (a.sheet?.row ?? 0) - (b.sheet?.row ?? 0) || +new Date(a.createdAt ?? 0) - +new Date(b.createdAt ?? 0);
}

// The status shown in the LMS's select: one of STATUSES, or 'OTHER' for a sheet interview's own words.
function statusKey(doc) {
  const status = doc.status ?? '';
  if (STATUSES.includes(status)) return status;
  const f = flagsOf(status);
  return f.cancelled ? 'CANCELLED' : f.rescheduled ? 'RESCHEDULED' : f.placed ? 'PLACED' : 'OTHER';
}

// One interview for the LMS page.
export function interviewView(doc) {
  const flags = flagsOf(doc.status ?? ''); // the LMS's statuses are words these read too
  return {
    id: String(doc._id),
    date: doc.date,
    course: doc.course ?? null,
    courseName: doc.courseName ?? COURSE_NAMES.get(doc.course) ?? null,
    studentName: doc.studentName,
    time: doc.time ?? '',
    minutes: doc.minutes ?? null,
    company: doc.company ?? '',
    round: doc.round ?? '',
    roundGroup: doc.roundGroup ?? '',
    room: doc.room ?? '',
    status: doc.status ?? '',
    statusKey: statusKey(doc),
    placed: Boolean(flags.placed),
    rescheduled: Boolean(flags.rescheduled),
    cancelled: Boolean(flags.cancelled),
    source: doc.source === 'lms' ? 'lms' : 'sheet',
    sheet: doc.sheet ? { tab: doc.sheet.tab, row: doc.sheet.row } : null,
    createdBy: doc.createdBy?.name ?? null,
    updatedBy: doc.updatedBy?.name ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
}

// One interview for the HR dashboard's Interviews page (the shape it had from the sheet, plus cancelled).
export function dashboardItem(doc) {
  const v = interviewView(doc);
  return {
    id: v.id,
    date: v.date,
    course: v.course,
    name: v.studentName,
    time: v.time,
    minutes: v.minutes,
    company: v.company,
    round: v.round,
    roundGroup: v.roundGroup,
    room: v.room,
    status: v.status,
    placed: v.placed,
    rescheduled: v.rescheduled,
    cancelled: v.cancelled,
  };
}

// The LMS database's all_interviews, connected on first use (and again after a failed try).
export function createLmsStore(uri) {
  if (!uri) return null;
  let pending = null;
  return {
    collection() {
      pending ??= connectLms(uri)
        .then((lms) => lms.collection)
        .catch((err) => {
          pending = null;
          throw err;
        });
      return pending;
    },
  };
}
