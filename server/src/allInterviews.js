// The staff's interview sheet (src/interviews.js), kept in the LMS's main database as one collection,
// all_interviews (config.lms; `npm run sync-interviews`). That collection is the only thing this writes there:
// the LMS's own collections (students, interviews, interviewschedules, ...) are never touched.
//
// One document per interview: every interview in the month tabs ("OCTOBER 2026"), plus the ones only listed in a
// per-course tab ("DA INTERVIEW": 117 from Jun-Sep 2026 aren't in the month tabs). Its key is the interview itself
// (day, student, company, round), not its row, so rows added or moved in the sheet don't mix interviews up. The same
// interview written twice in the month tabs is kept twice (key "...#2"), as the dashboard counts it.
//
// A sync adds new interviews, updates changed ones (status "PLACED" written later, a time fixed) and marks the ones
// no longer in the sheet inSheet: false with removedFromSheetAt (kept, never deleted); one back in the sheet is
// marked inSheet: true again. Unchanged interviews aren't written. updatedAt: when the document last changed.
//
// Since 11 Nov 2026 the LMS is where interviews are entered (src/lmsInterviews.js) and the sheet is no longer the
// source: a sync never touches an interview added or changed in the LMS (source: 'lms'), and the script refuses to
// run once there are any, unless told to (--force).
import mongoose from 'mongoose';
import { COURSES } from './config/courses.js';
import { withPublicDnsRetry } from './db.js';

export const LMS_COLLECTION = 'all_interviews';
// The LMS's connection string names no database, so its data is in MongoDB's default one, "test" (checked
// 11 Nov 2026: 70 collections there: students, users, courses, interviews, ...).
export const LMS_DEFAULT_DB = 'test';

const COURSE_NAMES = new Map(COURSES.map((c) => [c.id, c.name]));
// What the sheet says about an interview: when one of these changed, the document is rewritten (updatedAt). Where
// it is in the sheet (sheet: tab, row) is only brought up to date: rows move whenever one is added above them.
const CONTENT_FIELDS = ['date', 'interviewDate', 'studentName', 'course', 'courseName', 'company', 'time', 'minutes', 'round', 'roundGroup', 'room', 'status', 'placed', 'rescheduled'];

const lettersOnly = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '');
const lettersAndDigits = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// The same student on the same day (as src/interviews.js labelCourses matches the per-course tabs).
const studentDay = (item) => `${item.date}|${lettersOnly(item.name)}`;
// The interview: day, student, company and round group ("R-01" and "ROUND 1" are the same round).
const interviewKey = (item) => [item.date, lettersOnly(item.name), lettersAndDigits(item.company), lettersAndDigits(item.roundGroup)].join('|');

// The database a connection string names ("...mongodb.net/lms?..." -> "lms"), else the LMS's default.
export function lmsDatabaseName(uri) {
  try {
    const name = decodeURIComponent(new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1));
    return name || LMS_DEFAULT_DB;
  } catch {
    return LMS_DEFAULT_DB;
  }
}

function toDoc(item, key, kind) {
  const at = item.id.lastIndexOf('!');
  return {
    key,
    date: item.date, // "2026-10-01"
    interviewDate: new Date(`${item.date}T00:00:00.000Z`), // the same day as a date (midnight UTC), for date queries
    studentName: item.name,
    course: item.course ?? null, // 'data-analyst', ...; null: the sheet doesn't say (most blocks until Sep 2026)
    courseName: COURSE_NAMES.get(item.course) ?? null,
    company: item.company,
    time: item.time, // as written: "4:00 PM", "ANYTIME"
    minutes: item.minutes, // minutes after midnight (960 = 4 pm); null: no time
    round: item.round, // as written: "R-01"
    roundGroup: item.roundGroup, // "Round 1", "Assessment", "HR", ...
    room: item.room, // a room number ("105") or a city
    status: item.status, // how it went, as written: "PLACED", "RESCHEDULED", ''
    placed: item.placed,
    rescheduled: item.rescheduled, // moved to another day: not counted as an interview that day
    sheet: { tab: item.id.slice(0, at), row: Number(item.id.slice(at + 1)), kind }, // kind: 'month' or 'course' tab
  };
}

// The sheet reading (createInterviewSource().read(): items from the month tabs, courseItems from the per-course
// tabs) -> one document per interview, in sheet order.
export function interviewDocs(items, courseItems = []) {
  const docs = [];
  const seen = new Map(); // key -> times seen
  for (const item of items) {
    const base = interviewKey(item);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    docs.push(toDoc(item, n === 1 ? base : `${base}#${n}`, 'month'));
  }
  // The per-course tabs' interviews the month tabs don't have (no same student on the same day there), once each.
  const inMonthTabs = new Set(items.map(studentDay));
  for (const item of courseItems) {
    const key = interviewKey(item);
    if (inMonthTabs.has(studentDay(item)) || seen.has(key)) continue;
    seen.set(key, 1);
    docs.push(toDoc(item, key, 'course'));
  }
  return docs;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameContent = (a, b) => CONTENT_FIELDS.every((f) => same(a[f], b[f]));

// Brings the collection in line with the sheet reading. dryRun: works out the same counts, writes nothing.
// Refuses a reading without month-tab interviews (a renamed or emptied sheet would otherwise mark every interview
// removed).
export async function syncInterviews(collection, reading, { now = new Date(), dryRun = false } = {}) {
  if (!reading.items?.length) throw new Error('The interview sheet gave no interviews in its month tabs, so nothing was saved (check the tab names: "OCTOBER 2026").');
  const docs = interviewDocs(reading.items, reading.courseItems ?? []);
  const all = await collection.find({}, { projection: { _id: 0, firstSyncedAt: 0, updatedAt: 0, createdBy: 0, updatedBy: 0 } }).toArray();
  // The LMS's interviews (added there, or changed there since: src/lmsInterviews.js) are never written or marked.
  const lmsKeys = new Set(all.filter((d) => d.source === 'lms').map((d) => d.key));
  const stored = new Map(all.filter((d) => d.source !== 'lms').map((d) => [d.key, d]));
  const keys = new Set(docs.map((d) => d.key));
  const writes = [];
  const counts = { inSheet: docs.length, fromCourseTabsOnly: docs.filter((d) => d.sheet.kind === 'course').length, added: 0, changed: 0, moved: 0, unchanged: 0, removed: 0, back: 0, keptAsLms: 0 };
  for (const doc of docs) {
    if (lmsKeys.has(doc.key)) {
      counts.keptAsLms++; // changed in the LMS: the LMS's version stays
      continue;
    }
    const old = stored.get(doc.key);
    if (old && old.inSheet && sameContent(old, doc)) {
      if (same(old.sheet, doc.sheet)) {
        counts.unchanged++;
      } else {
        counts.moved++; // only its row (or tab): the row number brought up to date, nothing else
        writes.push({ updateOne: { filter: { key: doc.key }, update: { $set: { sheet: doc.sheet } } } });
      }
      continue;
    }
    if (!old) counts.added++;
    else if (!old.inSheet) counts.back++;
    else counts.changed++;
    writes.push({
      updateOne: {
        filter: { key: doc.key },
        update: { $set: { ...doc, inSheet: true, updatedAt: now }, $unset: { removedFromSheetAt: '' }, $setOnInsert: { firstSyncedAt: now } },
        upsert: true,
      },
    });
  }
  for (const [key, old] of stored) {
    if (keys.has(key) || !old.inSheet) continue;
    counts.removed++;
    writes.push({ updateOne: { filter: { key }, update: { $set: { inSheet: false, removedFromSheetAt: now, updatedAt: now } } } });
  }
  if (dryRun) return counts;
  await collection.createIndex({ key: 1 }, { unique: true, name: 'key_unique' });
  await collection.createIndex({ interviewDate: -1 }, { name: 'interviewDate' });
  if (writes.length) await collection.bulkWrite(writes, { ordered: false });
  return counts;
}

// The LMS database (its own connection; the dashboard's own database is untouched) and its all_interviews.
export async function connectLms(uri) {
  if (!uri) throw new Error('LMS_MONGO_URI is not set (in server/.env): the LMS database to copy the interview sheet into.');
  const options = { serverSelectionTimeoutMS: 20_000, autoIndex: false, autoCreate: false };
  const conn = await withPublicDnsRetry(uri, () => mongoose.createConnection(uri, options).asPromise());
  const db = conn.getClient().db(lmsDatabaseName(uri));
  return { db, collection: db.collection(LMS_COLLECTION), close: () => conn.close() };
}
