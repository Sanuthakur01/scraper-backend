// Incoming calls: an HR person calling one of our students directly (most often after seeing them on Naukri),
// logged by the team on the Assign numbers or Incoming calls page. The company is "in our HR database" when its
// name (companyKey, however it is spelled) is one of the stored jobs' companies. Such a call's HR number is added
// to the opening it was about, so it can be given to other students too, and on Assign numbers the numbers of the
// companies that called in the last HOT_DAYS come first, marked (api/routes.js).

import { COURSES } from './config/courses.js';
import { companyKey, phoneKey } from './normalize.js';
import { companySpellings, forgetCompanySpellings } from './sameCompany.js';

export const HOT_DAYS = 7; // a company that called a student this recently is "hot" on Assign numbers
export const LATE_DAYS = 7; // a call can be logged up to a week after it came

// Where the HR person found the student.
export const CALL_SOURCES = { naukri: 'Naukri', linkedin: 'LinkedIn', indeed: 'Indeed', glassdoor: 'Glassdoor', referral: 'Referral', other: 'Other' };
// What came of the call ('' = not said yet; it can be set later).
export const CALL_OUTCOMES = {
  interview: 'Interview scheduled',
  'cv-shared': 'CV shared',
  'call-back': 'Call back later',
  'not-interested': 'Not interested',
  'not-eligible': 'Not eligible',
  other: 'Other',
};

const HR_NAME_LIMIT = 80;
const COMPANY_LIMIT = 120;
const STUDENT_LIMIT = 60;
const NOTE_LIMIT = 500;
const EMAIL_LIMIT = 120;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

const textOf = (value) => (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();

// What the form sent: { value } or { error: 'message' } naming the box. Needed: the HR number, the company and the
// course. `now` bounds when the call came: not in the future (a few minutes' clock difference allowed), not more
// than LATE_DAYS ago; none sent: now.
export function parseCallInput(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the call as JSON.' };
  const phone = textOf(body.phone);
  const digits = phone.replace(/\D/g, '').length;
  if (!phone) return { error: 'HR number: enter the number the HR called from.' };
  if (!/^\+?[\d\s().-]+$/.test(phone) || digits < 7 || digits > 15) return { error: `HR number: "${phone.slice(0, 40)}" is not a phone number. Enter it like 98765 43210.` };

  const hrName = textOf(body.hrName);
  if (hrName.length > HR_NAME_LIMIT) return { error: `HR name: at most ${HR_NAME_LIMIT} characters.` };
  const email = textOf(body.email);
  if (email && (!EMAIL.test(email) || email.length > EMAIL_LIMIT)) return { error: `HR email: "${email.slice(0, 40)}" is not an email address. Enter it like hr@company.com.` };

  const company = textOf(body.company);
  if (!company) return { error: 'Company: enter the company that called.' };
  if (company.length > COMPANY_LIMIT) return { error: `Company: at most ${COMPANY_LIMIT} characters.` };
  const key = companyKey(company);
  if (!key) return { error: `Company: "${company}" is not a company name.` };

  const jobId = textOf(body.jobId);
  if (jobId && !/^[a-f\d]{24}$/i.test(jobId)) return { error: 'Opening: not one of the stored openings.' };

  const course = textOf(body.course);
  if (!COURSES.some((c) => c.id === course)) return { error: 'Course: choose the course of the student who got the call.' };

  const student = textOf(body.student);
  if (student.length > STUDENT_LIMIT) return { error: `Student: at most ${STUDENT_LIMIT} characters.` };

  const source = textOf(body.source || 'naukri').toLowerCase();
  if (!CALL_SOURCES[source]) return { error: `Found on: choose one of ${Object.values(CALL_SOURCES).join(', ')}.` };
  const outcome = textOf(body.outcome).toLowerCase();
  if (outcome && !CALL_OUTCOMES[outcome]) return { error: `Outcome: choose one of ${Object.values(CALL_OUTCOMES).join(', ')}.` };

  const note = (body.note == null ? '' : String(body.note)).replace(/\r\n?/g, '\n').trim();
  if (note.length > NOTE_LIMIT) return { error: `Note: at most ${NOTE_LIMIT} characters.` };

  let at = now;
  if (body.at != null && body.at !== '') {
    at = new Date(body.at);
    if (Number.isNaN(at.getTime())) return { error: 'When: not a date and time.' };
    if (at.getTime() > now.getTime() + 5 * 60_000) return { error: 'When: the call can\'t be in the future.' };
    if (at.getTime() < now.getTime() - LATE_DAYS * 86_400_000) return { error: `When: calls can be logged up to ${LATE_DAYS} days later.` };
  }

  return {
    value: { at, phone, phoneKey: phoneKey(phone), hrName, email, company, companyKey: key, jobId, course, student, source, outcome, note, addToJob: body.addToJob !== false },
  };
}

// A later change to a logged call: its outcome. { value: { outcome } } or { error }.
export function parseCallChange(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the change as JSON.' };
  const outcome = textOf(body.outcome).toLowerCase();
  if (outcome && !CALL_OUTCOMES[outcome]) return { error: `Outcome: choose one of ${Object.values(CALL_OUTCOMES).join(', ')}.` };
  return { value: { outcome } };
}

// The companyKey of every stored job's company (kept and left out): which companies are "in our HR database".
// Read again at most every 2 minutes (sameCompany.js).
export const portalKeys = async () => new Set((await companySpellings()).keys());
export const forgetPortalKeys = forgetCompanySpellings;

// A stored call as the dashboard gets it, with whether its company is in our HR database now.
export function callView(call, inPortal) {
  return {
    id: String(call._id),
    at: call.at,
    phone: call.phone,
    hrName: call.hrName ?? '',
    email: call.email ?? '',
    company: call.company,
    companyKey: call.companyKey,
    inPortal: Boolean(call.job?.id) || inPortal.has(call.companyKey),
    job: call.job?.id ? { id: String(call.job.id), set: call.job.set, title: call.job.title ?? '', course: call.job.course ?? '' } : null,
    course: call.course,
    student: call.student ?? '',
    source: call.source ?? '',
    outcome: call.outcome ?? '',
    note: call.note ?? '',
    number: call.number ?? null,
    createdAt: call.createdAt,
    createdBy: call.createdBy ?? null,
  };
}

// The companies in our HR database that called (calls: the period's, newest first), each once: its name as last
// written, how many calls, the latest, and the students called. For Assign numbers' hot list.
export function hotCompanies(calls, inPortal) {
  const companies = new Map();
  for (const call of calls) {
    if (!(call.job?.id || inPortal.has(call.companyKey))) continue;
    if (!companies.has(call.companyKey)) companies.set(call.companyKey, { key: call.companyKey, name: call.company, calls: 0, lastAt: call.at, students: [] });
    const c = companies.get(call.companyKey);
    c.calls += 1;
    if (call.student && !c.students.some((s) => s.toLowerCase() === call.student.toLowerCase())) c.students.push(call.student);
  }
  return [...companies.values()];
}
