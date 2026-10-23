// The dashboard's search box: type a company, an HR person's name, a phone number (any part of it,
// written any way) or an email address, and see where it is. Kept and left-out jobs alike, and every
// stored job (jobs with HR details are never removed), so a number that calls back can always be found.

import { COURSES } from '../config/courses.js';
import { Job, NonFilteredJob } from '../models.js';
import { companyKey, phoneKey } from '../normalize.js';
import { contactView, jobRow } from './followUp.js';

const MAX_COMPANIES = 6;
const MAX_JOBS = 20;
const SETS = [
  [Job, 'filtered'],
  [NonFilteredJob, 'nonfiltered'],
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const split = (value) => String(value ?? '').split(/\s*,\s*/).filter(Boolean);

// What was typed: a phone number (digits, maybe with + ( ) - . and spaces), words, or too little.
export function parseQuery(text) {
  const q = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const digits = q.replace(/\D/g, '');
  if (/^[\d\s+().-]+$/.test(q)) {
    if (digits.length < 3) return { q, kind: 'short' };
    // "+91 98765 43210" and "098765 43210" find "98765 43210": the country code or 0 in front doesn't
    // matter, and neither do the spaces or dashes in how it was saved.
    const core = digits.length >= 10 ? phoneKey(digits) : digits;
    return { q, kind: 'phone', rx: new RegExp(core.split('').join('[\\s().+-]*')) };
  }
  if (q.length < 2) return { q, kind: 'short' };
  return { q, kind: 'text', rx: new RegExp(escapeRegex(q), 'i') };
}

// The values of a job that match, as the dashboard shows them (typed-in details, else the post's).
function matchesOf(job, { kind, rx }) {
  const c = contactView(job);
  if (kind === 'phone') return split(c.phone).filter((v) => rx.test(v)).map((value) => ({ field: 'phone', value }));
  return [
    ...c.hrNames.filter((v) => rx.test(v)).map((value) => ({ field: 'hrName', value })),
    ...split(c.email).filter((v) => rx.test(v)).map((value) => ({ field: 'email', value })),
  ];
}

// Companies whose name matches, each once however it is spelled (companyKey, as in Hiring partners):
// openings kept and left out, per course, and when it last posted. Names starting with the words first.
async function findCompanies({ q, rx }) {
  const names = [...new Set((await Promise.all(SETS.map(([J]) => J.distinct('company', { company: { $nin: [null, ''] } })))).flat())];
  const keys = new Set(names.filter((name) => rx.test(name)).map(companyKey).filter(Boolean));
  if (!keys.size) return { companies: [], moreCompanies: 0 };
  const spellings = names.filter((name) => keys.has(companyKey(name)));
  const counted = await Promise.all(
    SETS.map(([J, set]) =>
      J.aggregate([
        { $match: { company: { $in: spellings } } },
        { $group: { _id: { company: '$company', course: '$course' }, n: { $sum: 1 }, last: { $max: '$firstSeenAt' } } },
      ]).then((rows) => rows.map((row) => ({ ...row, set }))),
    ),
  );
  const groups = new Map();
  for (const row of counted.flat()) {
    const key = companyKey(row._id.company);
    if (!groups.has(key)) groups.set(key, { key, spellings: new Map(), openings: 0, leftOut: 0, courses: Object.fromEntries(COURSES.map((c) => [c.id, 0])), last: null });
    const g = groups.get(key);
    g.spellings.set(row._id.company, (g.spellings.get(row._id.company) ?? 0) + row.n);
    if (row.set === 'filtered') g.openings += row.n;
    else g.leftOut += row.n;
    g.courses[row._id.course] = (g.courses[row._id.course] ?? 0) + row.n;
    if (!g.last || row.last > g.last) g.last = row.last;
  }
  const starts = new RegExp(`(^|\\s)${escapeRegex(q)}`, 'i');
  const list = [...groups.values()]
    .map(({ spellings: s, last, ...g }) => ({
      ...g,
      name: [...s].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0],
      lastPosted: last,
    }))
    .sort(
      (a, b) =>
        Number(starts.test(b.name)) - Number(starts.test(a.name)) ||
        b.openings + b.leftOut - (a.openings + a.leftOut) ||
        a.name.localeCompare(b.name),
    );
  return { companies: list.slice(0, MAX_COMPANIES), moreCompanies: Math.max(0, list.length - MAX_COMPANIES) };
}

// Jobs with a matching phone number, or a matching HR name or email: the job, which set it is in, and
// what matched. Most recently updated first.
async function findContacts(query, fields) {
  const filter =
    query.kind === 'phone'
      ? { $or: [{ 'manual.phone': query.rx }, { foundPhones: query.rx }] }
      : { $or: [{ 'manual.hrNames': query.rx }, { 'manual.email': query.rx }, { foundEmails: query.rx }] };
  const found = await Promise.all(
    SETS.map(([J, set]) =>
      J.find(filter, fields)
        .sort({ 'manual.updatedAt': -1, firstSeenAt: -1, _id: 1 })
        .limit(MAX_JOBS + 1)
        .lean()
        .then((jobs) => jobs.map((job) => ({ job, set }))),
    ),
  );
  const at = ({ job }) => (job.manual?.updatedAt ?? job.firstSeenAt)?.getTime() ?? 0;
  const hits = found
    .flat()
    .map(({ job, set }) => ({ job, set, matches: matchesOf(job, query) }))
    .filter((hit) => hit.matches.length)
    .sort((a, b) => at(b) - at(a));
  return {
    contacts: hits.slice(0, MAX_JOBS).map(({ job, set, matches }) => ({ job: jobRow(job), set, matches })),
    moreContacts: hits.length > MAX_JOBS,
  };
}

export async function searchEverything(text, { fields }) {
  const query = parseQuery(text);
  if (query.kind === 'short') return { q: query.q, kind: query.kind, companies: [], moreCompanies: 0, contacts: [], moreContacts: false };
  const [companies, contacts] = await Promise.all([
    query.kind === 'text' ? findCompanies(query) : { companies: [], moreCompanies: 0 },
    findContacts(query, fields),
  ]);
  return { q: query.q, kind: query.kind, ...companies, ...contacts };
}
