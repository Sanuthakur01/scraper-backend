// Merges duplicate openings already stored (for example, ones saved before the matching rules
// improved). Uses the same rules as the collector (src/collector/jobPool.js).
// The earliest-found copy is kept and gains the other copies' platforms, links and contact details
// (HR details typed in on the dashboard too); the rest are deleted.
// Run with --dry-run to only print what would be merged.
import { config } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { JobPool, openingFromDoc } from '../src/collector/jobPool.js';
import { Job } from '../src/models.js';

const DAY_MS = 86_400_000;
const dryRun = process.argv.includes('--dry-run');

// HR details typed in on both copies: each field keeps the kept copy's value, or else the other's;
// different remarks are both kept.
function mergeManual(keep, other) {
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

await connectDb();
try {
  const docs = await Job.find().sort({ firstSeenAt: 1, _id: 1 }).lean();
  const pool = new JobPool();
  const removed = [];

  for (const doc of docs) {
    const copy = openingFromDoc(doc);
    const windowStart = doc.firstSeenAt.getTime() - config.dedupeWindowDays * DAY_MS;
    const keep = pool.find(copy, (o) => o.lastSeenAt.getTime() >= windowStart);
    if (!keep) {
      pool.add(copy);
      continue;
    }
    console.log(`  "${doc.title}" @ ${doc.company} [${doc.platforms.join('+')}]  ->  "${keep.title}" @ ${keep.company} [${keep.platforms.join('+')}]`);
    pool.merge(keep, copy);
    keep.manual = mergeManual(keep.manual, copy.manual);
    removed.push(doc._id);
  }

  const kept = pool.openings.filter((o) => o.touched);
  console.log(`\n${docs.length} stored jobs: ${removed.length} duplicates found, merged into ${kept.length} jobs.`);
  if (dryRun || !removed.length) {
    if (dryRun) console.log('Dry run: nothing changed.');
  } else {
    const fields = [
      'platforms', 'links', 'sourceKeys', 'fingerprints', 'cities', 'experienceMin', 'experienceMax', 'experienceText',
      'experienceBand', 'salaryText', 'skills', 'foundPhones', 'foundEmails', 'lastSeenAt', 'manual',
    ];
    const set = (o) => Object.fromEntries(fields.filter((f) => o[f] !== undefined).map((f) => [f, o[f]]));
    await Job.bulkWrite(kept.map((o) => ({ updateOne: { filter: { _id: o._id }, update: { $set: set(o) } } })));
    await Job.deleteMany({ _id: { $in: removed } });
    console.log(`Done: ${docs.length - removed.length} jobs remain.`);
  }
} finally {
  await disconnectDb();
}
