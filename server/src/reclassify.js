// Applies the current rules to the jobs already stored, kept (Job) and non-filtered (NonFilteredJob),
// after any of these change: course rules (config/courses.js), excluded companies or the experience
// range (config/filters.js).
//   - A job that fits no course any more is removed (unless HR details were typed in for it).
//   - A kept job the rules now leave out moves to the non-filtered jobs, and a non-filtered job the
//     rules now keep moves to the kept jobs, with everything in it (HR details too). Nothing else is lost.
//   - Each job's course, experience group and (non-filtered) reason are brought up to date.
// dryRun: count what would change, change nothing.
import { classifyTitle } from './classify.js';
import { leftOutReason } from './config/filters.js';
import { Job, NonFilteredJob } from './models.js';
import { experienceBand } from './normalize.js';

export async function reclassifyJobs({ dryRun = false } = {}) {
  const counts = {
    kept: 0, // kept jobs that stay kept
    nonFiltered: 0, // non-filtered jobs that stay non-filtered
    toNonFiltered: { 'big-company': 0, experience: 0, 'no-experience': 0 }, // kept -> non-filtered, by reason
    toKept: 0, // non-filtered -> kept
    noCourse: 0, // removed: fit no course
    keptManual: 0, // fit no course, but kept because HR details were typed in
    courseChanged: 0,
    bandChanged: 0,
    moveFailed: 0, // the other set already has one of its listings: left where it was
  };
  const examples = { toNonFiltered: [], toKept: [] };
  const updates = new Map([[Job, []], [NonFilteredJob, []]]);
  const removals = new Map([[Job, []], [NonFilteredJob, []]]);
  const moves = []; // { doc, from, to }

  for (const [model, isKept] of [[Job, true], [NonFilteredJob, false]]) {
    for await (const job of model.find({}).lean().cursor()) {
      const course = classifyTitle(job.title);
      if (!course) {
        if (job.manual) counts.keptManual++;
        else {
          counts.noCourse++;
          removals.get(model).push(job._id);
        }
        continue;
      }
      const set = {};
      if (course !== job.course) {
        set.course = course;
        counts.courseChanged++;
      }
      const band = experienceBand(job.experienceMin);
      if (band !== job.experienceBand) {
        set.experienceBand = band;
        counts.bandChanged++;
      }
      const reason = leftOutReason(job);
      const label = `"${job.title}" at ${job.company || 'company not shown'}`;
      if (isKept && reason) {
        counts.toNonFiltered[reason]++;
        if (examples.toNonFiltered.length < 4) examples.toNonFiltered.push(`${label} (${reason})`);
        moves.push({ doc: { ...job, ...set, leftOutBy: reason }, from: Job, to: NonFilteredJob });
      } else if (!isKept && !reason) {
        counts.toKept++;
        if (examples.toKept.length < 4) examples.toKept.push(label);
        const { leftOutBy: _gone, ...doc } = job;
        moves.push({ doc: { ...doc, ...set }, from: NonFilteredJob, to: Job });
      } else {
        counts[isKept ? 'kept' : 'nonFiltered']++;
        if (!isKept && reason !== job.leftOutBy) set.leftOutBy = reason;
        if (Object.keys(set).length) updates.get(model).push({ updateOne: { filter: { _id: job._id }, update: { $set: set } } });
      }
    }
  }

  if (!dryRun) {
    for (const model of [Job, NonFilteredJob]) {
      const ops = [...updates.get(model), ...removals.get(model).map((_id) => ({ deleteOne: { filter: { _id } } }))];
      for (let i = 0; i < ops.length; i += 500) await model.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
    // A move is a copy then a delete, so a job is never lost: if the copy fails it stays where it was.
    for (const { doc, from, to } of moves) {
      try {
        await to.collection.insertOne(doc);
      } catch (err) {
        if (err?.code !== 11000) throw err;
        counts.moveFailed++;
        continue;
      }
      await from.deleteOne({ _id: doc._id });
    }
  }
  return { counts, examples };
}
