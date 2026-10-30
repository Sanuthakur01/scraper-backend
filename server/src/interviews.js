import crypto from 'node:crypto';
import { COURSES } from './config/courses.js';

// Interviews from the staff's Google Sheet (config.interviews): read with a Google service account the sheet is
// shared with, view only. One tab per month ("OCTOBER 2026"); in it a block per day:
//
//   INTERVIEW SCHEDULED REPORT 01/10/2026
//   PS                                             <- the course of the rows below (PS, DA, DS, DE)
//   S.NO. | DATE | NAME | TIME | COMPANY | ROUND | ROOM
//   1 | 01/10/2026 | RAVI KUMAR | ANYTIME | ALPHA SYSTEMS | ASSESSMENT | HYDERABAD | PLACED
//
// Until September most blocks have "IT JOBS FACTORY" for a course row (no course; "IT JOBS FACTORY (PS)" names
// one). ROOM is a room number (105) or a city. After it the staff may write how it went ("PLACED", "RESCHEDULED").
// Dates are day/month/year; a row whose date disagrees with its block's title, when only the title fits the month
// of the tab, is a typo: the title's day counts. The per-course tabs ("DA INTERVIEW", "DS INTERVIEW") list the same
// interviews: they only give the month tabs' interviews without a course theirs (same day and student). Other tabs
// ("Sheet12") aren't read. The sheet is read again at most every 10 minutes (READ_EVERY_MS).

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const READ_EVERY_MS = 10 * 60_000;
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly';

// "PS" or "PRODUCTION SUPPORT" -> 'production-support'.
const COURSE_OF = new Map(
  COURSES.flatMap((c) => {
    const initials = c.name.split(/\s+/).map((w) => w[0]).join('').toUpperCase();
    return [[initials, c.id], [c.name.toUpperCase(), c.id]];
  }),
);
// A block's course row -> its course: "PS", "DATA ANALYST", "IT JOBS FACTORY (PS)"; null: "IT JOBS FACTORY" (a block
// without one); undefined: not a course row.
function courseIn(cell) {
  const s = text(cell).toUpperCase();
  if (COURSE_OF.has(s)) return COURSE_OF.get(s);
  const named = /\(([A-Z ]+)\)/.exec(s);
  if (named && COURSE_OF.has(named[1].trim())) return COURSE_OF.get(named[1].trim());
  return /^IT JOBS FACTORY$/.test(s) ? null : undefined;
}

// "DA INTERVIEW" -> 'data-analyst': a tab listing one course's interviews; any other -> null.
export function courseOfTab(title) {
  const m = /^\s*([A-Z ]+?)\s+INTERVIEWS?\s*$/i.exec(title);
  return (m && COURSE_OF.get(m[1].toUpperCase())) ?? null;
}

// A header cell, letters only ("S.NO." -> "SNO"), to the field it holds.
const HEADERS = {
  SNO: 'serial', DATE: 'date', NAME: 'name', STUDENT: 'name', STUDENTNAME: 'name', CANDIDATE: 'name', TIME: 'time',
  COMPANY: 'company', COMPANYNAME: 'company', ROUND: 'round', ROOM: 'room', CENTRE: 'room', CENTER: 'room', LOCATION: 'room',
  CITY: 'room', STATUS: 'status', RESULT: 'status', REMARK: 'status', REMARKS: 'status',
};

const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const realDay = (y, m, d) => {
  const day = `${y}-${pad(m)}-${pad(d)}`;
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day) ? day : null;
};

// "OCTOBER 2026" -> { year: 2026, month: 10 }; any other tab name -> null.
export function monthOfTab(title) {
  const m = /^\s*([A-Za-z]+)\s+(\d{4})\s*$/.exec(title);
  const month = m ? MONTHS.indexOf(m[1].toUpperCase()) + 1 : 0;
  return month ? { year: Number(m[2]), month } : null;
}

// "01/10/2026", "1-10-26", "1 Oct 2026" -> "2026-10-01" (day first). In a month's tab, a date that only fits the
// tab with day and month swapped ("10/01/2026" in OCTOBER) is read that way.
export function parseDay(value, tab = null) {
  const s = text(value);
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (tab && b !== tab.month && a === tab.month) return realDay(year, a, b);
    return realDay(year, b, a);
  }
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s,-]+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[2].toUpperCase().slice(0, 3))) + 1;
    return month ? realDay(Number(m[3]), month, Number(m[1])) : null;
  }
  return null;
}

// "4:00 PM" -> 960, "11.30 am" -> 690; without am/pm, office hours: "5:30" -> 5:30 pm, "10:00" -> 10 am. "ANYTIME"
// or blank -> null (listed after the timed ones).
export function minutesOf(value) {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(?:([AaPp])\.?\s*[Mm]\.?)?$/.exec(text(value));
  if (!m || (!m[3] && !m[2]) || Number(m[1]) > 12) return null;
  const pm = m[3] ? m[3].toUpperCase() === 'P' : Number(m[1]) < 8 || Number(m[1]) === 12;
  return ((Number(m[1]) % 12) + (pm ? 12 : 0)) * 60 + Number(m[2] ?? 0);
}

// The month tabs' interviews without a course get it from the per-course tabs: the same day and student there.
export function labelCourses(items, courseItems) {
  const key = (i) => `${i.date}|${i.name.toUpperCase().replace(/[^A-Z]/g, '')}`;
  const courseOf = new Map(courseItems.map((i) => [key(i), i.course]));
  return items.map((i) => (i.course || !courseOf.has(key(i)) ? i : { ...i, course: courseOf.get(key(i)) }));
}

// One month tab's rows (arrays of cell text, as Google Sheets shows them) -> its interviews, in sheet order.
export function parseInterviews(title, rows) {
  const tab = monthOfTab(title);
  const items = [];
  let course = null;
  let reportDay = null;
  let cols = null; // field -> column, from the latest header row
  rows.forEach((row, index) => {
    const cells = (row ?? []).map(text);
    const filled = cells.filter(Boolean);
    if (!filled.length) return;
    const report = /INTERVIEW.*?(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i.exec(filled.join(' '));
    if (report && filled.length <= 2) {
      reportDay = parseDay(report[1], tab);
      course = null;
      return;
    }
    if (filled.length === 1 && courseIn(filled[0]) !== undefined) {
      course = courseIn(filled[0]);
      return;
    }
    const keys = cells.map((c) => HEADERS[c.toUpperCase().replace(/[^A-Z]/g, '')]);
    if (keys.includes('date') && keys.includes('name')) {
      cols = {};
      keys.forEach((key, i) => key && cols[key] === undefined && (cols[key] = i));
      return;
    }
    if (!cols) return;
    const name = cells[cols.name] ?? '';
    const written = parseDay(cells[cols.date], tab);
    const inTab = (day) => Boolean(tab && day && day.startsWith(`${tab.year}-${pad(tab.month)}`));
    const date = written && reportDay && written !== reportDay && inTab(reportDay) && !inTab(written) ? reportDay : (written ?? reportDay);
    if (!name || !date) return;
    // How it went: its own column, else whatever is written after the last one ("PLACED").
    const last = Math.max(...Object.values(cols));
    const status = cols.status !== undefined ? cells[cols.status] ?? '' : cells.slice(last + 1).filter(Boolean).join(' ');
    const time = cells[cols.time] ?? '';
    items.push({
      id: `${title}!${index + 1}`,
      date,
      course,
      name,
      time,
      minutes: minutesOf(time),
      company: cells[cols.company] ?? '',
      round: cells[cols.round] ?? '',
      room: cells[cols.room] ?? '',
      status,
      placed: /\b(placed|selected)\b/i.test(status),
    });
  });
  return items;
}

// What Google's error means, for the people using the dashboard.
function sheetProblem(status, body, serviceAccount) {
  const reason = body?.error?.details?.find((d) => d.reason)?.reason ?? body?.error?.status ?? '';
  const message = String(body?.error?.message ?? '');
  if (reason === 'SERVICE_DISABLED') return 'The Google Sheets API is switched off in the Google Cloud project. Enable it there.';
  if (/not supported for this document/i.test(message)) return 'The interview file is an Excel file in Google Drive. Open it, choose File → Save as Google Sheets, and share that copy instead.';
  if (status === 403) return `The interview sheet isn't shared with ${serviceAccount}. Share it with that email as a Viewer.`;
  if (status === 404) return 'The interview sheet was not found. Check INTERVIEWS_SHEET_ID.';
  return `Google Sheets answered ${status}: ${message || 'no details'}`;
}

// Reads the interview sheet, at most every READ_EVERY_MS (callers in between share the last reading, and one
// reading in progress). A failed reading keeps the last good interviews and says why (error). null when the
// sheet or the service account isn't set up.
export function createInterviewSource({ sheetId, serviceAccount, privateKey }, { fetch: get = fetch, now = () => Date.now(), everyMs = READ_EVERY_MS } = {}) {
  if (!sheetId || !serviceAccount || !privateKey) return null;
  let token = null; // { value, until }
  let last = null; // { items, tabs, readAt, error }
  let pending = null;

  // A Google access token for the service account (a signed JWT exchanged at Google), kept until shortly before it ends.
  async function accessToken() {
    if (token && token.until > now()) return token.value;
    const iat = Math.floor(now() / 1000);
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: serviceAccount, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');
    const res = await get('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`Google sign-in for the interview sheet failed (${res.status}): ${body.error_description ?? body.error ?? 'no details'}`);
    token = { value: body.access_token, until: now() + (Number(body.expires_in) || 3600) * 1000 - 120_000 };
    return token.value;
  }

  async function sheets(path) {
    const res = await get(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}${path}`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(sheetProblem(res.status, body, serviceAccount));
    return body;
  }

  async function readNow() {
    const meta = await sheets('?fields=sheets.properties.title');
    const titles = meta.sheets.map((s) => s.properties.title);
    const tabs = titles.filter((title) => monthOfTab(title));
    const courseTabs = titles.filter((title) => courseOfTab(title));
    const read = [...tabs, ...courseTabs];
    const ranges = read.map((title) => `ranges=${encodeURIComponent(`'${title.replace(/'/g, "''")}'`)}`).join('&');
    const values = read.length ? await sheets(`/values:batchGet?${ranges}&valueRenderOption=FORMATTED_VALUE`) : { valueRanges: [] };
    const rowsOf = (title) => values.valueRanges[read.indexOf(title)]?.values ?? [];
    const courseItems = courseTabs.flatMap((title) => parseInterviews(title, rowsOf(title)).map((i) => ({ ...i, course: courseOfTab(title) })));
    const items = labelCourses(tabs.flatMap((title) => parseInterviews(title, rowsOf(title))), courseItems);
    return { items, tabs, readAt: new Date(now()).toISOString(), error: null };
  }

  return {
    async read() {
      if (last && !last.error && now() - Date.parse(last.readAt) < everyMs) return last;
      // After a failure, try again only once a minute (every request would otherwise wait for Google).
      if (last?.error && now() - last.failedAt < 60_000) return last;
      pending ??= readNow()
        .then((fresh) => (last = fresh))
        .catch((err) => (last = { items: last?.items ?? [], tabs: last?.tabs ?? [], readAt: last?.readAt ?? null, error: err.message, failedAt: now() }))
        .finally(() => (pending = null));
      return pending;
    },
  };
}
