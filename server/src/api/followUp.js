// What the team records by hand for a job: the `manual` field, which only the dashboard writes, so a
// collection never overwrites it.
//   - HR contact: phone, email, remarks. The collector also finds contacts written in the postings
//     (foundPhones, foundEmails); what was typed in is shown instead of those.
//   - Placement: how far the team got with this opening (status), the students sent, and how many
//     were placed (placedCount, from the day it was first marked placed: placedAt).
// A phone number can be typed in only if no other job has it yet (findPhoneOwner).

import { Job } from '../models.js';
import { formatIndianPhone, phoneKey } from '../normalize.js';

export const PHONE_EXISTS = 'This number already exists.';
// In the order a placement moves through; 'closed' = ended without a placement.
export const PLACEMENT_STATUSES = ['contacted', 'cvs-sent', 'interview', 'placed', 'closed'];

const LIMITS = { phone: 100, email: 200, remarks: 1000, students: 300 };
const LABELS = { phone: 'Phone', email: 'Email', remarks: 'Remarks', students: 'Students' };
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

// The contact columns of one job row: value, and where it came from ('manual', 'posting' or null).
export function contactView({ foundPhones, foundEmails, manual }) {
  const pick = (typed, found) =>
    typed ? [typed, 'manual'] : found?.length ? [found.join(', '), 'posting'] : ['', null];
  const [phone, phoneSource] = pick(manual?.phone, foundPhones);
  const [email, emailSource] = pick(manual?.email, foundEmails);
  return { phone, phoneSource, email, emailSource, remarks: manual?.remarks ?? '', updatedAt: manual?.updatedAt ?? null };
}

export const placementView = (manual) => ({
  status: manual?.status ?? '',
  students: manual?.students ?? '',
  placedCount: manual?.status === 'placed' ? (manual.placedCount ?? 1) : 0,
  placedAt: manual?.status === 'placed' ? (manual.placedAt ?? null) : null,
});

// A stored job as the API sends it: the hand-entered and found contact fields replaced by `contact`
// and `placement`.
export const jobRow = ({ foundPhones, foundEmails, manual, ...job }) => ({
  ...job,
  contact: contactView({ foundPhones, foundEmails, manual }),
  placement: placementView(manual),
});

// Checks what was typed in. Returns { value: { phone, phoneKeys, email, remarks, status, students,
// placedCount } } or { error: 'message' }. Two phones or emails may be given, separated by commas (the
// same number twice is kept once). Empty = nothing entered. placedCount (default 1) only for 'placed'.
export function parseFollowUpInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the details as JSON.' };
  const text = (key) => (body[key] == null ? '' : String(body[key]));
  const input = {
    phone: text('phone').replace(/\s+/g, ' ').trim(),
    email: text('email').trim(),
    remarks: text('remarks').replace(/\r\n?/g, '\n').trim(),
    students: text('students').replace(/\s+/g, ' ').trim(),
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

  const status = text('status').trim();
  if (status && !PLACEMENT_STATUSES.includes(status)) return { error: 'Status: pick one from the list.' };
  let placedCount = null;
  if (status === 'placed') {
    placedCount = body.placedCount == null || body.placedCount === '' ? 1 : Number(body.placedCount);
    if (!Number.isInteger(placedCount) || placedCount < 1 || placedCount > 50) {
      return { error: 'Placed: enter how many students got the job (1 to 50).' };
    }
  }
  return {
    value: {
      phone: phones.join(', '),
      phoneKeys: phones.map(phoneKey),
      email: emails.join(', '),
      remarks: input.remarks,
      status,
      students: input.students,
      placedCount,
    },
  };
}

// The `manual` field to store, from what was typed in and what is stored now (`current`), or null
// when nothing is entered (the field is removed). statusAt / placedAt keep the day the job first
// reached its status, so saving again (e.g. a new remark) doesn't move a placement to another month.
export function manualRecord(input, current, now) {
  const { phone, phoneKeys, email, remarks, status, students, placedCount } = input;
  if (!phone && !email && !remarks && !status && !students) return null;
  const record = { phone, phoneKeys, email, remarks, students, status, updatedAt: now };
  if (status) record.statusAt = status === current?.status ? (current.statusAt ?? now) : now;
  if (status === 'placed') {
    record.placedCount = placedCount;
    record.placedAt = current?.status === 'placed' ? (current.placedAt ?? now) : now;
  }
  return record;
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
