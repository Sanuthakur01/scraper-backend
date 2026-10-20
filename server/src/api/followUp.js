// The HR contact the team records by hand for a job: phone, email and remarks, in the `manual` field,
// which only the dashboard writes, so a collection never overwrites it. The collector also finds
// contacts written in the postings (foundPhones, foundEmails); what was typed in is shown instead.
// A phone number can be typed in only if no other job has it yet (findPhoneOwner).

import { Job, NonFilteredJob } from '../models.js';
import { formatIndianPhone, phoneKey } from '../normalize.js';

export const PHONE_EXISTS = 'This number already exists.';

// Phone numbers, and email addresses, a job can have typed in (the dashboard has a box for each).
export const MAX_ENTRIES = 5;
const REMARKS_LIMIT = 1000;
const EMAIL_LIMIT = 120; // one address
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

// A phone or email field as sent: one string (several values separated by commas, e.g. from an older
// dashboard or the API) or a list with one string per box. Returns the values, trimmed, empty ones dropped.
const entriesOf = (value, separators) =>
  (Array.isArray(value) ? value : [value])
    .flatMap((v) => (v == null ? [] : String(v).split(separators)))
    .map((v) => v.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

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
// Up to MAX_ENTRIES phone numbers and as many email addresses, each sent in its own box (a list) or
// separated by commas; they are stored as one comma-separated text ("98765 43210, 080 4123 4567").
// The same number or address twice is kept once. A wrong entry is named in the message. Empty = nothing entered.
export function parseFollowUpInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the details as JSON.' };
  const remarks = (body.remarks == null ? '' : String(body.remarks)).replace(/\r\n?/g, '\n').trim();
  if (remarks.length > REMARKS_LIMIT) return { error: `Remarks is too long (at most ${REMARKS_LIMIT} characters).` };

  const typedPhones = entriesOf(body.phone, /[,;/]/);
  const digits = (p) => p.replace(/\D/g, '').length;
  const badPhone = typedPhones.find((p) => !/^\+?[\d\s().-]+$/.test(p) || digits(p) < 7 || digits(p) > 15);
  if (badPhone) return { error: `Phone: "${clip(badPhone)}" is not a phone number. Enter it like 98765 43210.` };
  const phones = typedPhones.filter((p, i) => typedPhones.findIndex((q) => phoneKey(q) === phoneKey(p)) === i);
  if (phones.length > MAX_ENTRIES) return { error: `Phone: at most ${MAX_ENTRIES} numbers per job.` };

  // A box holds one address; addresses separated by spaces (pasted from somewhere) are split too.
  const parts = entriesOf(body.email, /[,;]/);
  const typedEmails = parts.flatMap((part) => (part.split(' ').every((e) => EMAIL.test(e)) ? part.split(' ') : [part]));
  const badEmail = typedEmails.find((e) => !EMAIL.test(e) || e.length > EMAIL_LIMIT);
  if (badEmail) return { error: `Email: "${clip(badEmail)}" is not an email address. Enter it like hr@company.com.` };
  const emails = typedEmails.filter((e, i) => typedEmails.findIndex((f) => f.toLowerCase() === e.toLowerCase()) === i);
  if (emails.length > MAX_ENTRIES) return { error: `Email: at most ${MAX_ENTRIES} addresses per job.` };

  return { value: { phone: phones.join(', '), phoneKeys: phones.map(phoneKey), email: emails.join(', '), remarks } };
}

const clip = (text) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

// The `manual` field to store from what was typed in, or null when nothing is entered (the field is removed).
export function manualRecord({ phone, phoneKeys, email, remarks }, now) {
  if (!phone && !email && !remarks) return null;
  return { phone, phoneKeys, email, remarks, updatedAt: now };
}

// Every phone number a stored job has, as phoneKeys: typed in, and found in its postings.
const phoneKeysOf = (job) => new Set([...(job.manual?.phoneKeys ?? []), ...(job.foundPhones ?? []).map(phoneKey)]);

// Another job that already has one of these numbers, as { job, key }, or null: a kept job or a
// non-filtered one, so a number is never on two jobs whichever view it was typed into. Numbers the job
// itself already has don't count, so its details can be saved again (e.g. after changing only the remarks).
export async function findPhoneOwner(keys, job) {
  const own = phoneKeysOf(job);
  const fresh = keys.filter((k) => !own.has(k));
  if (!fresh.length) return null;
  const asFound = fresh.filter((k) => k.length === 10).map(formatIndianPhone);
  const query = { _id: { $ne: job._id }, $or: [{ 'manual.phoneKeys': { $in: fresh } }, { foundPhones: { $in: asFound } }] };
  const fields = { title: 1, company: 1, foundPhones: 1, 'manual.phoneKeys': 1 };
  const other = (await Job.findOne(query, fields).lean()) ?? (await NonFilteredJob.findOne(query, fields).lean());
  if (!other) return null;
  const otherKeys = phoneKeysOf(other);
  return { job: other, key: fresh.find((k) => otherKeys.has(k)) };
}
