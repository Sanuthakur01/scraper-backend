// The HR contact the team records by hand for a job: phone, email and remarks, in the `manual` field,
// which only the dashboard writes, so a collection never overwrites it. The collector also finds
// contacts written in the postings (foundPhones, foundEmails); what was typed in is shown instead.
// A phone number can be typed in only if no other job has it yet (findPhoneOwner).

import { Job } from '../models.js';
import { formatIndianPhone, phoneKey } from '../normalize.js';

export const PHONE_EXISTS = 'This number already exists.';

const LIMITS = { phone: 100, email: 200, remarks: 1000 };
const LABELS = { phone: 'Phone', email: 'Email', remarks: 'Remarks' };
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

// The contact columns of one job row: value, and where it came from ('manual', 'posting' or null).
export function contactView({ foundPhones, foundEmails, manual }) {
  const pick = (typed, found) =>
    typed ? [typed, 'manual'] : found?.length ? [found.join(', '), 'posting'] : ['', null];
  const [phone, phoneSource] = pick(manual?.phone, foundPhones);
  const [email, emailSource] = pick(manual?.email, foundEmails);
  return { phone, phoneSource, email, emailSource, remarks: manual?.remarks ?? '', updatedAt: manual?.updatedAt ?? null };
}

// A stored job as the API sends it: the typed-in and found contact fields replaced by `contact`.
export const jobRow = ({ foundPhones, foundEmails, manual, ...job }) => ({
  ...job,
  contact: contactView({ foundPhones, foundEmails, manual }),
});

// Checks what was typed in. Returns { value: { phone, phoneKeys, email, remarks } } or { error: 'message' }.
// Two phones or emails may be given, separated by commas (the same number twice is kept once).
// Empty = nothing entered.
export function parseFollowUpInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the details as JSON.' };
  const text = (key) => (body[key] == null ? '' : String(body[key]));
  const input = {
    phone: text('phone').replace(/\s+/g, ' ').trim(),
    email: text('email').trim(),
    remarks: text('remarks').replace(/\r\n?/g, '\n').trim(),
  };
  for (const [key, value] of Object.entries(input)) {
    if (value.length > LIMITS[key]) return { error: `${LABELS[key]} is too long (at most ${LIMITS[key]} characters).` };
  }

  const typed = input.phone.split(/\s*[,;/]\s*/).filter(Boolean);
  const digits = (p) => p.replace(/\D/g, '').length;
  if (typed.some((p) => !/^\+?[\d\s().-]+$/.test(p) || digits(p) < 7 || digits(p) > 15)) {
    return { error: 'Phone: enter a phone number, e.g. 98765 43210. Separate two numbers with a comma.' };
  }
  const phones = typed.filter((p, i) => typed.findIndex((q) => phoneKey(q) === phoneKey(p)) === i);
  const emails = input.email.split(/[\s,;]+/).filter(Boolean);
  if (emails.some((e) => !EMAIL.test(e))) {
    return { error: 'Email: enter an email address, e.g. hr@company.com. Separate two addresses with a comma.' };
  }
  return { value: { phone: phones.join(', '), phoneKeys: phones.map(phoneKey), email: emails.join(', '), remarks: input.remarks } };
}

// The `manual` field to store from what was typed in, or null when nothing is entered (the field is removed).
export function manualRecord({ phone, phoneKeys, email, remarks }, now) {
  if (!phone && !email && !remarks) return null;
  return { phone, phoneKeys, email, remarks, updatedAt: now };
}

// Every phone number a stored job has, as phoneKeys: typed in, and found in its postings.
const phoneKeysOf = (job) => new Set([...(job.manual?.phoneKeys ?? []), ...(job.foundPhones ?? []).map(phoneKey)]);

// Another job that already has one of these numbers, as { job, key }, or null. Numbers the job itself
// already has don't count, so its details can be saved again (e.g. after changing only the remarks).
export async function findPhoneOwner(keys, job) {
  const own = phoneKeysOf(job);
  const fresh = keys.filter((k) => !own.has(k));
  if (!fresh.length) return null;
  const asFound = fresh.filter((k) => k.length === 10).map(formatIndianPhone);
  const other = await Job.findOne(
    { _id: { $ne: job._id }, $or: [{ 'manual.phoneKeys': { $in: fresh } }, { foundPhones: { $in: asFound } }] },
    { title: 1, company: 1, foundPhones: 1, 'manual.phoneKeys': 1 },
  ).lean();
  if (!other) return null;
  const otherKeys = phoneKeysOf(other);
  return { job: other, key: fresh.find((k) => otherKeys.has(k)) };
}
