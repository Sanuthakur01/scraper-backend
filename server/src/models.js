import mongoose from 'mongoose';

// One document per unique job. The same job seen on several platforms is one document
// with several entries in `platforms` and `links`.
const jobSchema = new mongoose.Schema(
  {
    fingerprint: { type: String, required: true }, // company|title|city of the first listing, see normalize.js
    fingerprints: [String], // the same key for every listing merged into this job
    title: { type: String, required: true },
    company: String,
    course: { type: String, required: true },
    cities: [String],
    isRemote: Boolean,
    experienceMin: Number,
    experienceMax: Number,
    experienceText: String,
    experienceBand: String, // fresher | 1-2 | 3-5 | 6+ | unknown
    salaryText: String,
    skills: [String],
    postedAt: Date, // the platform's own posting date (best effort)
    firstSeenAt: { type: Date, required: true }, // when our collector first found it: drives "new jobs"
    lastSeenAt: { type: Date, required: true },
    primaryPlatform: { type: String, required: true }, // the one platform that gets the count
    platforms: [String],
    links: mongoose.Schema.Types.Mixed, // { LinkedIn: url, Naukri: url, ... }
    sourceKeys: [String], // "Naukri:120526025748": every platform listing merged into this job
    // Contact details written in the postings themselves. Only the collector changes these.
    foundPhones: [String], // "+91 98765 43210"
    foundEmails: [String],
    // HR contact typed in on the dashboard (api/followUp.js). Only the dashboard changes this, so a
    // collection never overwrites it. Shown instead of the found phone/email. Absent = nothing entered.
    // phoneKeys: the phone number(s) as bare digits (see phoneKey), so a number can't be entered twice.
    manual: {
      type: new mongoose.Schema(
        { phone: String, phoneKeys: { type: [String], default: undefined }, email: String, remarks: String, updatedAt: Date },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { versionKey: false, minimize: false },
);

// A platform listing ("Naukri:120526025748") can belong to only one stored job: the database itself
// refuses a second record for it, as a last guard against duplicates.
jobSchema.index({ sourceKeys: 1 }, { unique: true, partialFilterExpression: { sourceKeys: { $type: 'string' } } });
jobSchema.index({ fingerprint: 1, lastSeenAt: -1 });
jobSchema.index({ firstSeenAt: -1 });
jobSchema.index({ course: 1, firstSeenAt: -1 });
jobSchema.index({ lastSeenAt: 1 });
// "Is this phone number already on another job?" (api/followUp.js)
jobSchema.index({ 'manual.phoneKeys': 1 });
jobSchema.index({ foundPhones: 1 });

export const Job = mongoose.model('Job', jobSchema);

// One document per collector run, so the dashboard can show "last refreshed" and failures can be traced.
const searchSchema = new mongoose.Schema(
  {
    platform: String,
    course: String,
    term: String,
    location: String, // only for platforms searched city by city
    status: String, // ok | error
    items: Number,
    error: String,
    note: String,
    actorRunId: String,
    durationMs: Number,
  },
  { _id: false },
);

// One per platform, written as soon as that platform's results are saved.
const platformSchema = new mongoose.Schema(
  {
    platform: String,
    via: String, // apify | scraper
    searches: Number,
    failedSearches: Number,
    fetched: Number,
    inIndia: Number,
    matched: Number, // matched a course
    bigCompany: Number, // left out: excluded company (config/filters.js)
    outsideExperience: Number, // left out: minimum experience outside the 2-5 year range
    noExperience: Number, // didn't state experience...
    noExperienceKept: Number, // ...but matched a 2-5 year job on another platform, so added to it
    kept: Number,
    newJobs: Number,
    knownJobs: Number,
    rawFile: String, // raw results on disk; `npm run replay` can load them again
    saveError: String,
    savedLater: Boolean, // the first save failed; a later retry in the same run saved it
    savedAt: Date,
  },
  { _id: false },
);

const collectorRunSchema = new mongoose.Schema(
  {
    startedAt: { type: Date, required: true },
    // The run lock: stops two collections running at once (see startRun in collector/collect.js).
    lockedAt: Date, // real start time
    lockedBy: { host: String, pid: Number }, // the PC and process running it
    heartbeatAt: Date, // updated every 30 seconds while it runs
    finishedAt: Date,
    lookbackDays: Number, // postings searched from the last N days (1 = daily; more = a backfill)
    coverageFrom: Date, // startedAt minus lookbackDays: the earliest posting date this run looked for
    status: { type: String, enum: ['running', 'success', 'partial', 'failed'], default: 'running' },
    platforms: [platformSchema],
    searches: [searchSchema],
    totals: {
      fetched: Number,
      inIndia: Number,
      matched: Number,
      bigCompany: Number,
      outsideExperience: Number,
      noExperience: Number,
      noExperienceKept: Number,
      unique: Number,
      inserted: Number,
      updated: Number,
      removedOld: Number,
    },
    error: String,
  },
  { versionKey: false },
);

collectorRunSchema.index({ startedAt: -1 });

export const CollectorRun = mongoose.model('CollectorRun', collectorRunSchema);
