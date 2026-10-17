// Re-reads the skills of stored jobs from their raw postings in data/raw/ (kept 14 days), with the
// current skill list (SKILLS in src/normalize.js). Run it after changing that list, so the skill
// counts on the dashboard use the new list for older jobs too.
// A job's skills become the skills named in any of its listings, when every listing's raw posting is
// on disk. When only some are, it only gains skills (the missing listings' skills can't be checked),
// and jobs with none on disk keep the skills they have.
// Run with --dry-run to only print what would change.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { buildJob } from '../src/collector/buildJob.js';
import { SOURCES } from '../src/config/sources.js';
import { Job } from '../src/models.js';

const dryRun = process.argv.includes('--dry-run');

// Platform listing ("Naukri:123") -> skills named in it, from every raw file.
const skillsByListing = new Map();
const files = fs.existsSync(config.rawDir) ? fs.readdirSync(config.rawDir).filter((f) => f.endsWith('.json')) : [];
for (const name of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(config.rawDir, name), 'utf8'));
  const source = SOURCES.find((s) => s.platform === raw.platform);
  if (!source) continue;
  const savedAt = new Date(raw.startedAt);
  for (const item of (raw.searches ?? []).flatMap((s) => s.items ?? [])) {
    const { job } = buildJob(source, item, savedAt);
    if (!job) continue;
    const known = skillsByListing.get(job.sourceKey) ?? [];
    skillsByListing.set(job.sourceKey, [...new Set([...known, ...job.skills])]);
  }
}
console.log(`Read ${files.length} raw files: ${skillsByListing.size} listings.`);

await connectDb();
try {
  const ops = [];
  let found = 0;
  let changed = 0;
  let added = 0;
  let removed = 0;
  for await (const job of Job.find({}, { sourceKeys: 1, skills: 1 }).lean().cursor()) {
    const keys = job.sourceKeys ?? [];
    const lists = keys.map((key) => skillsByListing.get(key)).filter(Boolean);
    if (!lists.length) continue;
    found++;
    const before = new Set(job.skills ?? []);
    const complete = lists.length === keys.length;
    const skills = [...new Set([...(complete ? [] : before), ...lists.flat()])];
    const plus = skills.filter((s) => !before.has(s)).length;
    const minus = [...before].filter((s) => !skills.includes(s)).length;
    if (!plus && !minus) continue;
    changed++;
    added += plus;
    removed += minus;
    ops.push({ updateOne: { filter: { _id: job._id }, update: { $set: { skills } } } });
  }
  const total = await Job.countDocuments();
  console.log(`${found} of ${total} stored jobs have their raw postings on disk; ${changed} get new skills (${added} skills added, ${removed} removed).`);
  if (dryRun) console.log('Dry run: nothing changed.');
  else if (ops.length) {
    await Job.bulkWrite(ops, { ordered: false });
    console.log('Saved.');
  }
} finally {
  await disconnectDb();
}
