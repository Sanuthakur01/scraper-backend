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
    experienceBand: String, // fresher | 1 … 5 | 5+ (more than 5) | unknown (normalize.js experienceBand)
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
    // HR contact and the students the job is assigned to, typed in on the dashboard (api/followUp.js).
    // Only the dashboard changes this, so a collection never overwrites it, and a job with it is never
    // removed by the cleanup. Shown instead of the found phone/email. Absent = nothing entered.
    // phoneKeys: the phone number(s) as bare digits (see phoneKey), so a number can't be entered twice.
    manual: {
      type: new mongoose.Schema(
        {
          hrNames: { type: [String], default: undefined }, // the HR people's names
          hrProfiles: { type: [String], default: undefined }, // links to their profiles (e.g. LinkedIn)
          phone: String,
          phoneKeys: { type: [String], default: undefined },
          email: String,
          remarks: String,
          assignedTo: { type: [String], default: undefined }, // students this job is assigned to
          updatedAt: Date,
        },
        { _id: false },
      ),
      default: undefined,
    },
    // NonFilteredJob only: why the keep rules leave it out: 'big-company' | 'experience' (under the
    // minimum) | 'no-experience' (not stated, and not the same job as a kept one). See leftOutReason.
    leftOutBy: String,
    // NonFilteredJob only: one of a course's extra searches (extraSearchTerms) found it, and no main search
    // kept it (else it would be a kept job). Such a job that passes the keep rules has leftOutBy 'extra-search'.
    fromExtraSearch: Boolean,
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

// "Non-filtered" jobs: openings that fit a course but that the keep rules leave out (a large IT
// services firm, under the minimum experience, or experience not stated). Same shape and indexes as
// Job, in their own collection, so the filtered jobs above are never mixed with them; the dashboard's
// Filtered / Non-filtered switch picks the collection. A platform listing is never in both.
export const NonFilteredJob = mongoose.model('NonFilteredJob', jobSchema.clone(), 'nonfilteredjobs');

// One document per collector run, so the dashboard can show "last refreshed" and failures can be traced.
const searchSchema = new mongoose.Schema(
  {
    platform: String,
    course: String,
    term: String,
    extra: Boolean, // one of the course's extraSearchTerms
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
    extraSearch: Number, // matched a course in an extra search: non-filtered unless a main search also found it
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
    onlyCourses: { type: [String], default: undefined }, // `--course`: the only courses searched (none = all)
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
      extraSearch: Number, // matched a course in an extra search (non-filtered unless a main search found it too)
      unique: Number,
      inserted: Number,
      updated: Number,
      removedOld: Number,
      // Non-filtered jobs (NonFilteredJob) saved by this run. alreadyKept: left-out listings that are
      // the same opening as a kept job, so not added; removedAsKept: stored non-filtered jobs that
      // turned out to be the same opening as a kept job, so removed (the kept job wins).
      nonFiltered: {
        inserted: Number,
        updated: Number,
        alreadyKept: Number,
        removedAsKept: Number,
        removedOld: Number,
      },
    },
    nonFilteredError: String, // the non-filtered save failed (the kept jobs are saved regardless)
    error: String,
  },
  { versionKey: false },
);

collectorRunSchema.index({ startedAt: -1 });

export const CollectorRun = mongoose.model('CollectorRun', collectorRunSchema);

// One document per change someone made on the dashboard: who (from their Clerk sign-in, not from the
// browser), when, which job, and what changed in its HR details (src/activity.js). Kept for good, also
// after the job itself is removed, so the job's title and company are copied in.
const changeSchema = new mongoose.Schema(
  {
    // hrName | hrProfile | phone | email | assignedTo | remarks, or about one number/email in the
    // performance report: contactStudent (who it was given to) | contactRemark (how it went)
    field: { type: String, required: true },
    change: { type: String, required: true }, // added | edited | removed
    before: [String], // the values before (the notes as one value)
    after: [String],
    added: [String], // in a list: values that are new …
    removed: [String], // … and values that are gone
    // contactStudent / contactRemark: which number or email; for contactRemark also whose call (student; '' or
    // missing: a remark made before anyone was given it, or from before a number could go to several students)
    contact: { type: new mongoose.Schema({ field: String, value: String, student: String }, { _id: false }), default: undefined },
  },
  { _id: false },
);

const activitySchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    actor: {
      userId: { type: String, required: true }, // Clerk user id
      email: { type: String, required: true },
      name: String,
      role: String, // their role at the time
    },
    action: { type: String, required: true }, // added | edited | removed: all the changes together
    via: String, // 'ai': made with IJF AI (confirmed by the person in the chat)
    job: {
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
      set: String, // filtered | nonfiltered
      title: String,
      company: String,
      course: String,
    },
    changes: { type: [changeSchema], required: true },
  },
  { versionKey: false },
);

activitySchema.index({ at: -1 });
activitySchema.index({ 'job.id': 1, at: -1 });
activitySchema.index({ 'actor.email': 1, at: -1 });

export const Activity = mongoose.model('Activity', activitySchema);

// The follow-up of one HR phone number or email of a job given to one student (src/outcomes.js): the student
// and how their call went. A number can go to several students, each with a remark of their own: one per job,
// number/email (key: bare digits, or the address in lower case) and student (the same name in any case is the
// same student); student '' (or missing) holds a remark made before anyone was given it. Kept apart from the
// job's typed-in details, so editing those never touches it.
const contactOutcomeSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, required: true },
    field: { type: String, required: true }, // phone | email
    key: { type: String, required: true },
    value: String, // as written
    student: String,
    status: String, // dnp | busy | switched-off | wrong | not-person | cv-shared | no-openings | other (outcomes.js REMARKS)
    note: String, // the words of an "Others" remark
    updatedAt: Date,
    updatedBy: { email: String, name: String },
  },
  { versionKey: false },
);
export const STUDENT_COLLATION = { locale: 'en', strength: 2 }; // "Riya" and "riya" are one student
contactOutcomeSchema.index({ job: 1, field: 1, key: 1, student: 1 }, { unique: true, collation: STUDENT_COLLATION });

export const ContactOutcome = mongoose.model('ContactOutcome', contactOutcomeSchema);

// ---------- IJF AI (src/ai/) ----------

// A change IJF AI suggested in a chat, done only when the person clicks Confirm.
const chatActionSchema = new mongoose.Schema({
  type: { type: String, required: true }, // add-hr-details | set-follow-up
  summary: String, // what it will do, in words (contacts written as the person typed them)
  summaryForModel: String, // the same with stand-ins, for the AI's next turns
  payload: mongoose.Schema.Types.Mixed, // what is sent when confirmed (real values, never shown to the AI)
  status: { type: String, default: 'pending' }, // pending | done | failed | cancelled
  error: String,
  doneAt: Date,
});

const chatMessageSchema = new mongoose.Schema({
  role: { type: String, required: true }, // user | assistant
  content: { type: String, default: '' }, // as shown to the person
  modelContent: String, // a question as sent to the AI: phone numbers and emails replaced by [phone 1], [email 1]
  at: { type: Date, default: Date.now },
  cards: { type: [mongoose.Schema.Types.Mixed], default: undefined }, // what the screen shows beside the answer (contacts, jobs…)
  actions: { type: [chatActionSchema], default: undefined },
  tools: { type: [{ name: String, args: mongoose.Schema.Types.Mixed, _id: false }], default: undefined }, // what it looked up
  context: mongoose.Schema.Types.Mixed, // the page the question was asked on
  feedback: String, // up | down
  tokens: { prompt: Number, completion: Number },
  error: String,
});

// One conversation with IJF AI, kept for its person (only they can open it).
const chatSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    email: { type: String, required: true },
    name: String,
    title: String, // the first question, shortened
    messages: { type: [chatMessageSchema], default: [] },
    // [phone 1] / [email 1] -> the number or address the person typed (only on this server).
    secrets: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false },
);
chatSchema.index({ userId: 1, updatedAt: -1 });

export const Chat = mongoose.model('Chat', chatSchema);

// Questions and tokens per person per IST day: the daily limit, and the usage for admins.
const aiUsageSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    day: { type: String, required: true }, // 2026-10-22 (IST)
    questions: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
  },
  { versionKey: false },
);
aiUsageSchema.index({ email: 1, day: 1 }, { unique: true });

export const AiUsage = mongoose.model('AiUsage', aiUsageSchema);

// The day's briefing ("what changed since yesterday"), written once per IST day for everyone.
const aiBriefingSchema = new mongoose.Schema(
  {
    day: { type: String, required: true, unique: true },
    text: String,
    createdAt: Date,
    tokens: { prompt: Number, completion: Number },
  },
  { versionKey: false },
);

export const AiBriefing = mongoose.model('AiBriefing', aiBriefingSchema);
