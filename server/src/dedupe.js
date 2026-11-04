// Merges duplicate openings already stored (`npm run dedupe`, scripts/dedupe.js): for example, ones saved before
// the matching rules improved. Uses the same rules as the collector (collector/jobPool.js).
// The earliest-found copy is kept and gains the other copies' platforms, links and contact details
// (HR details typed in on the dashboard too); the rest are deleted. A job the team added by hand (addedBy) is
// never merged into another one, so it is never deleted: it stays a job of its own, and a later collected copy can
// still be merged into it.
import { config } from './config.js';
import { JobPool, openingFromDoc } from './collector/jobPool.js';
import { Job } from './models.js';

const DAY_MS = 86_400_000;

// The fields a kept job gains from its copies.
const MERGED_FIELDS = [
  'platforms', 'links', 'sourceKeys', 'fingerprints', 'cities', 'experienceMin', 'experienceMax', 'experienceText',
  'experienceBand', 'salaryText', 'skills', 'foundPhones', 'foundEmails', 'lastSeenAt', 'manual',
];

// HR details typed in on both copies: each field keeps the kept copy's value, or else the other's;
// different remarks are both kept.
export function mergeManual(keep, other) {
  if (!other) return keep;
  if (!keep) return other;
  const remarks = [keep.remarks, other.remarks].filter(Boolean);
  const both = (field) => [...new Set([...(keep[field] ?? []), ...(other[field] ?? [])])];
  return {
    hrNames: both('hrNames'), // both copies' HR names and profile links
    hrProfiles: both('hrProfiles'),
    phone: keep.phone || other.phone || '',
    phoneKeys: (keep.phone ? keep.phoneKeys : other.phoneKeys) ?? [],
    email: keep.email || other.email || '',
    assignedTo: [...new Set([...(keep.assignedTo ?? []), ...(other.assignedTo ?? [])])], // both copies' students
    remarks: [...new Set(remarks)].join('\n'),
    updatedAt: keep.updatedAt > other.updatedAt ? keep.updatedAt : other.updatedAt,
  };
}

// The merges for the stored jobs `docs` (earliest found first), worked out without the database:
// { kept: the jobs that gained copies, with their merged fields; removed: the copies' ids }. log: each merge.
export function findMerges(docs, { windowDays = config.dedupeWindowDays, log = () => {} } = {}) {
  const pool = new JobPool();
  const removed = [];
  for (const doc of docs) {
    const copy = openingFromDoc(doc);
    const windowStart = doc.firstSeenAt.getTime() - windowDays * DAY_MS;
    // A job added by hand is never merged away: it is added as a job of its own.
    const keep = copy.addedBy ? null : pool.find(copy, (o) => o.lastSeenAt.getTime() >= windowStart);
    if (!keep) {
      pool.add(copy);
      continue;
    }
    log(`  "${doc.title}" @ ${doc.company} [${doc.platforms.join('+')}]  ->  "${keep.title}" @ ${keep.company} [${keep.platforms.join('+')}]`);
    pool.merge(keep, copy);
    keep.manual = mergeManual(keep.manual, copy.manual);
    removed.push(doc._id);
  }
  return { kept: pool.openings.filter((o) => o.touched), removed };
}

// Merges the stored kept jobs (Job). dryRun: only say what would be merged. Returns how many jobs there were, how
// many copies were (or would be) removed, and into how many jobs.
export async function dedupeJobs({ dryRun = false, log = console.log } = {}) {
  const docs = await Job.find().sort({ firstSeenAt: 1, _id: 1 }).lean();
  const { kept, removed } = findMerges(docs, { log });
  log(`\n${docs.length} stored jobs: ${removed.length} duplicates found, merged into ${kept.length} jobs.`);
  const result = { total: docs.length, removed: removed.length, mergedInto: kept.length };
  if (dryRun || !removed.length) {
    if (dryRun) log('Dry run: nothing changed.');
    return result;
  }
  // A listing key is stored on one job only (a unique index), so in three steps, each safe to run again: the copies
  // let go of their listing keys, the kept jobs take them (with the rest of what they gained), then the copies go.
  // Stopped after the first step, a copy still matches its kept job by its company, title and city next time.
  const set = (o) => Object.fromEntries(MERGED_FIELDS.filter((f) => o[f] !== undefined).map((f) => [f, o[f]]));
  await Job.updateMany({ _id: { $in: removed } }, { $set: { sourceKeys: [] } });
  await Job.bulkWrite(kept.map((o) => ({ updateOne: { filter: { _id: o._id }, update: { $set: set(o) } } })));
  await Job.deleteMany({ _id: { $in: removed } });
  log(`Done: ${docs.length - removed.length} jobs remain.`);
  return result;
}
