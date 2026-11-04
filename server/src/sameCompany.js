// The same company's other jobs, for the job list (GET /jobs): a new opening from a company we found jobs from
// before ("Hiring again"), and the HR contact the team already saved on one of its other jobs, which "Use this HR"
// copies to the new one (POST /jobs/:id/copy-hr). A company is the same however it is spelled (companyKey), in the
// kept and the left-out jobs alike.

import { Job, NonFilteredJob } from './models.js';
import { companyKey } from './normalize.js';

const IST_OFFSET_MS = 330 * 60_000;
const istDay = (date) => new Date(new Date(date).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const HR_JOBS_MAX = 200; // per set and page: jobs with HR contact read for the page's companies

// Every stored job's company name, by companyKey (key -> Set of spellings). Read again at most every NAMES_MS
// (about 10,000 names take a tenth of a second).
const NAMES_MS = 2 * 60_000;
let names = null; // { byKey, at }
export async function companySpellings() {
  if (names && Date.now() - names.at < NAMES_MS) return names.byKey;
  const all = (await Promise.all([Job, NonFilteredJob].map((J) => J.distinct('company', { company: { $nin: [null, ''] } })))).flat();
  const byKey = new Map();
  for (const name of all) {
    const key = companyKey(name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(name);
  }
  names = { byKey, at: Date.now() };
  return byKey;
}
export const forgetCompanySpellings = () => {
  names = null;
};

// HR contact typed in on the dashboard: an HR name, profile link, phone or email (notes or students alone aren't).
const TYPED_HR = {
  $or: [{ 'manual.hrNames.0': { $exists: true } }, { 'manual.hrProfiles.0': { $exists: true } }, { 'manual.phone': { $nin: [null, ''] } }, { 'manual.email': { $nin: [null, ''] } }],
};
export const hasTypedHr = (manual) => Boolean(manual && (manual.hrNames?.length || manual.hrProfiles?.length || manual.phone || manual.email));

// The HR contact saved on one of the company's jobs, as the job list shows it.
const knownHrView = (doc) => ({
  id: String(doc._id),
  set: doc.set,
  title: doc.title,
  cities: doc.cities ?? [],
  firstSeenAt: doc.firstSeenAt,
  hrNames: doc.manual.hrNames ?? [],
  hrProfiles: doc.manual.hrProfiles ?? [],
  phone: doc.manual.phone ?? '',
  email: doc.manual.email ?? '',
  foundBy: doc.manual.foundBy ?? '',
  savedAt: doc.manual.updatedAt ?? null,
});

// For stored jobs (as the job list reads them, with `manual`): a Map of job id -> { earlier, firstAt, hr }, only for
// the jobs with something to say:
//   earlier: how many of the company's jobs were first found on an earlier IST day than this one; firstAt: the first;
//   hr: when this job has no HR contact typed in, the one the team saved on another of the company's jobs (the
//       latest saved), else null.
export async function sameCompanyOf(jobs) {
  const result = new Map();
  const keyOf = new Map(jobs.map((job) => [String(job._id), companyKey(job.company)]));
  const keys = new Set([...keyOf.values()].filter(Boolean));
  if (!keys.size) return result;

  const byKey = await companySpellings();
  const spellings = new Set(jobs.map((job) => job.company).filter(Boolean)); // also a company first found minutes ago
  for (const key of keys) for (const name of byKey.get(key) ?? []) spellings.add(name);
  const company = { $in: [...spellings] };
  const sets = [['filtered', Job], ['nonfiltered', NonFilteredJob]];
  const [days, withHr] = await Promise.all([
    Promise.all(
      sets.map(([, J]) =>
        J.aggregate([
          { $match: { company } },
          {
            $group: {
              _id: { company: '$company', day: { $dateToString: { format: '%Y-%m-%d', date: '$firstSeenAt', timezone: 'Asia/Kolkata' } } },
              n: { $sum: 1 },
              first: { $min: '$firstSeenAt' },
            },
          },
        ]),
      ),
    ),
    Promise.all(
      sets.map(([set, J]) =>
        J.find({ company, ...TYPED_HR }, { title: 1, company: 1, cities: 1, firstSeenAt: 1, manual: 1 })
          .sort({ 'manual.updatedAt': -1, _id: 1 })
          .limit(HR_JOBS_MAX)
          .lean()
          .then((docs) => docs.map((doc) => ({ ...doc, set }))),
      ),
    ),
  ]);

  const daysOf = new Map(); // key -> [{ day, n, first }]
  for (const group of days.flat()) {
    const key = companyKey(group._id.company);
    if (!daysOf.has(key)) daysOf.set(key, []);
    daysOf.get(key).push({ day: group._id.day, n: group.n, first: group.first });
  }
  const hrOf = new Map(); // key -> the company's jobs with HR contact, the latest saved first
  for (const doc of withHr.flat().sort((a, b) => (b.manual.updatedAt ?? 0) - (a.manual.updatedAt ?? 0))) {
    const key = companyKey(doc.company);
    if (!hrOf.has(key)) hrOf.set(key, []);
    hrOf.get(key).push(doc);
  }

  for (const job of jobs) {
    const id = String(job._id);
    const key = keyOf.get(id);
    if (!key) continue;
    const day = istDay(job.firstSeenAt);
    const before = (daysOf.get(key) ?? []).filter((d) => d.day < day);
    const source = hasTypedHr(job.manual) ? null : (hrOf.get(key) ?? []).find((doc) => String(doc._id) !== id);
    if (!before.length && !source) continue;
    result.set(id, {
      earlier: before.reduce((n, d) => n + d.n, 0),
      firstAt: before.length ? new Date(Math.min(...before.map((d) => d.first.getTime()))) : null,
      hr: source ? knownHrView(source) : null,
    });
  }
  return result;
}
