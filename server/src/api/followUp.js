// What the team records by hand for a job: the HR person's name and profile link (e.g. LinkedIn), HR
// phone, email, remarks and the students it is assigned to, in the `manual` field, which only the dashboard writes, so a collection never overwrites it. The
// collector also finds contacts written in the postings (foundPhones, foundEmails); what was typed in
// is shown instead.
// A phone number can be typed in only if no other job has it yet (findPhoneOwner).

import { Job, NonFilteredJob } from '../models.js';
import { formatIndianPhone, phoneKey } from '../normalize.js';

export const PHONE_EXISTS = 'This number already exists.';

// Where the research team found a job's HR contact ("Found by"): needed whenever HR contact details (names,
// profile links, phones, emails) are added or changed; the dashboard has a dropdown of these.
export const HR_SOURCES = { signalhire: 'SignalHire', apollo: 'Apollo', linkedin: 'LinkedIn', naukri: 'Naukri', indeed: 'Indeed' };
export const FOUND_BY_REQUIRED = `Found by: choose where the HR contact was found (${Object.values(HR_SOURCES).join(', ')}).`;

// Phone numbers, email addresses, HR names and HR profile links a job can have typed in (each; the
// dashboard has a box for each value).
export const MAX_ENTRIES = 10;
// Students a job can be assigned to (one box each), and the longest name.
export const MAX_STUDENTS = 20;
const NAME_LIMIT = 60;
const REMARKS_LIMIT = 1000;
const EMAIL_LIMIT = 120; // one address
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
const HR_NAME_LIMIT = 80;
const PROFILE_LIMIT = 300; // one link

// "linkedin.com/in/riya" -> "https://linkedin.com/in/riya". A web address (http or https, with a
// domain), or null: never another kind of link (javascript:, mailto:…), which the dashboard would open.
export function profileUrl(text) {
  const value = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
// Two links to the same page: compared without "https://", "www." or a trailing slash, ignoring case.
const profileKey = (url) => url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');

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
  return {
    hrNames: manual?.hrNames ?? [],
    hrProfiles: manual?.hrProfiles ?? [],
    foundBy: manual?.foundBy ?? '', // where the HR contact was found (HR_SOURCES), '' = not said
    phone,
    phoneSource,
    email,
    emailSource,
    remarks: manual?.remarks ?? '',
    assignedTo: manual?.assignedTo ?? [],
    updatedAt: manual?.updatedAt ?? null,
  };
}

// A stored job as the API sends it: the typed-in and found contact fields replaced by `contact`.
export const jobRow = ({ foundPhones, foundEmails, manual, ...job }) => ({
  ...job,
  contact: contactView({ foundPhones, foundEmails, manual }),
});

// Checks what was typed in. Returns { value: { hrNames, hrProfiles, foundBy, phone, phoneKeys, email, remarks, assignedTo } }
// or { error: 'message' }. HR names and profile links: up to MAX_ENTRIES each, one per box.
// Up to MAX_ENTRIES phone numbers and as many email addresses, each sent in its own box (a list) or
// separated by commas; they are stored as one comma-separated text ("98765 43210, 080 4123 4567").
// The same number or address twice is kept once. A wrong entry is named in the message. Empty = nothing entered.
export function parseFollowUpInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the details as JSON.' };
  const remarks = (body.remarks == null ? '' : String(body.remarks)).replace(/\r\n?/g, '\n').trim();
  if (remarks.length > REMARKS_LIMIT) return { error: `Remarks is too long (at most ${REMARKS_LIMIT} characters).` };

  // The HR people's names, and links to their profiles (one per box; pasted ones split at spaces).
  const typedHrNames = entriesOf(body.hrName, /[,;\n]/);
  const longHrName = typedHrNames.find((n) => n.length > HR_NAME_LIMIT);
  if (longHrName) return { error: `HR name: "${clip(longHrName)}" is too long for a name (at most ${HR_NAME_LIMIT} characters).` };
  const hrNames = typedHrNames.filter((n, i) => typedHrNames.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i);
  if (hrNames.length > MAX_ENTRIES) return { error: `HR name: at most ${MAX_ENTRIES} names per job.` };

  const typedProfiles = entriesOf(body.hrProfile, /[\s,;]+/);
  const badProfile = typedProfiles.find((p) => p.length > PROFILE_LIMIT || !profileUrl(p));
  if (badProfile) return { error: `HR profile: "${clip(badProfile)}" is not a web link. Enter it like linkedin.com/in/name.` };
  const links = typedProfiles.map(profileUrl);
  const hrProfiles = links.filter((u, i) => links.findIndex((v) => profileKey(v) === profileKey(u)) === i);
  if (hrProfiles.length > MAX_ENTRIES) return { error: `HR profile: at most ${MAX_ENTRIES} links per job.` };

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

  // Where the HR contact was found: one of HR_SOURCES ('' = not sent; whether it is needed is the route's to say).
  const foundBy = body.foundBy == null ? '' : String(body.foundBy).trim().toLowerCase();
  if (foundBy && !HR_SOURCES[foundBy]) return { error: `Found by: "${clip(foundBy)}" is not one of ${Object.values(HR_SOURCES).join(', ')}.` };

  // Students the job is assigned to: one name per box (or separated by commas), each name once.
  const typedNames = entriesOf(body.assignedTo, /[,;\n]/);
  const longName = typedNames.find((n) => n.length > NAME_LIMIT);
  if (longName) return { error: `Assign to: "${clip(longName)}" is too long for a name (at most ${NAME_LIMIT} characters).` };
  const assignedTo = typedNames.filter((n, i) => typedNames.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i);
  if (assignedTo.length > MAX_STUDENTS) return { error: `Assign to: at most ${MAX_STUDENTS} students per job.` };

  return { value: { hrNames, hrProfiles, foundBy, phone: phones.join(', '), phoneKeys: phones.map(phoneKey), email: emails.join(', '), remarks, assignedTo } };
}

const clip = (text) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

// The `manual` field to store from what was typed in, or null when nothing is entered (the field is removed).
export function manualRecord({ hrNames = [], hrProfiles = [], foundBy = '', phone, phoneKeys, email, remarks, assignedTo = [] }, now) {
  if (!hrNames.length && !hrProfiles.length && !phone && !email && !remarks && !assignedTo.length) return null;
  const contacts = hrNames.length || hrProfiles.length || phone || email;
  return {
    ...(hrNames.length ? { hrNames } : {}),
    ...(hrProfiles.length ? { hrProfiles } : {}),
    ...(contacts && foundBy ? { foundBy } : {}), // kept only with HR contact details
    phone,
    phoneKeys,
    email,
    remarks,
    ...(assignedTo.length ? { assignedTo } : {}),
    updatedAt: now,
  };
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
