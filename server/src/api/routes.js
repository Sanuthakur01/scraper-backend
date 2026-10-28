import mongoose from 'mongoose';
import express from 'express';
import { config } from '../config.js';
import { COURSES } from '../config/courses.js';
import { EXCLUDED_COMPANIES, underExperienceText } from '../config/filters.js';
import { enabledSources } from '../config/sources.js';
import { Activity, CollectorRun, ContactOutcome, Job, NonFilteredJob, STUDENT_COLLATION } from '../models.js';
import { contactChanges, overallAction } from '../activity.js';
import { contactKey, parseOutcomeInput, remarkChange, remarkOf, studentChange } from '../outcomes.js';
import { requirePermission } from '../auth.js';
import { HIDDEN_CITIES, SKILL_NAMES, companyKey, phoneKey } from '../normalize.js';
import { hiringPartners } from '../companies.js';
import { skillGaps, skillPlan } from '../skillGaps.js';
import { contactView, findPhoneOwner, FOUND_BY_REQUIRED, jobRow, manualRecord, MAX_STUDENTS, parseFollowUpInput, PHONE_EXISTS } from './followUp.js';
// The HR contact details "Found by" is about (activity.js field names).
const CONTACT_DETAILS = ['hrName', 'hrProfile', 'phone', 'email'];
import { searchEverything } from './search.js';
import { AllJobs } from './allJobs.js';
import { ROLE_BOXES, roleTitleQuery } from '../config/roleBoxes.js';

const router = express.Router();

// Every route's handler, by "GET /summary", so IJF AI's tools can run the same code in-process (src/ai/
// tools.js: callRoute) and always give the same numbers as the dashboard.
export const routeHandlers = new Map();
for (const method of ['get', 'put', 'post', 'delete']) {
  const register = router[method].bind(router);
  router[method] = (path, ...handlers) => {
    routeHandlers.set(`${method.toUpperCase()} ${path}`, handlers.at(-1));
    return register(path, ...handlers);
  };
}
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;
const IST = 'Asia/Kolkata';

// Which jobs a request reads: the kept (filtered) jobs; with ?view=nonfiltered the jobs the keep rules
// leave out (NonFilteredJob); with ?view=all both together (allJobs.js). Every route that reads jobs uses
// this, so the dashboard's Filtered / Non-filtered / All switch changes every number and list the same way.
const viewOf = (req) => (req.query.view === 'nonfiltered' || req.query.view === 'all' ? req.query.view : 'filtered');
const jobsFor = (req) => ({ filtered: Job, nonfiltered: NonFilteredJob, all: AllJobs })[viewOf(req)];

const wrap = (handler) => (req, res, next) => handler(req, res).catch(next);
const clampDays = (value, fallback, max) => Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const istDate = (date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istDayStart = (dateStr) => new Date(Date.parse(`${dateStr}T00:00:00Z`) - IST_OFFSET_MS);
const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const latestRun = () =>
  CollectorRun.findOne({ status: { $in: ['success', 'partial'] } })
    .sort({ startedAt: -1 })
    .lean();

// When the daily collection started. Counts from before it come from a one-off backfill (if any),
// which fetches the newest postings first and may be incomplete for older days, so the trend chart
// marks those days.
async function dailySince() {
  const run = await CollectorRun.findOne(
    { status: { $in: ['success', 'partial'] }, $or: [{ lookbackDays: { $exists: false } }, { lookbackDays: { $lte: 1 } }] },
    { startedAt: 1 },
  )
    .sort({ startedAt: 1 })
    .lean();
  return run?.startedAt ?? null;
}

// A period is compared with the one before only when every IST day of both was collected (any
// finished run). A day without a run has almost no new jobs, and the next run's count then holds two
// days, so comparing would show a huge jump that didn't happen ("+5900% vs previous day"). Days
// before the daily collection began have no runs, so they are never compared either.
// A missed day still counts when a short catch-up (`--days 2` or `--days 3`, every course) ran within
// those days after it: it dates its jobs by when they were posted, and a posting from a day or two ago is
// almost always still listed. A longer backfill (e.g. 30 days) doesn't: the postings already taken down
// by then are missing, so its days would look quieter than they were.
const CATCH_UP_DAYS = 3;

async function collectedEveryDay(from, to) {
  const runs = await CollectorRun.find(
    { status: { $in: ['success', 'partial'] }, startedAt: { $gte: from, $lt: new Date(to.getTime() + CATCH_UP_DAYS * DAY_MS) } },
    { startedAt: 1, lookbackDays: 1, onlyCourses: 1 },
  ).lean();
  const collected = new Set();
  for (const run of runs) {
    const lookback = run.lookbackDays ?? 1;
    const reachesBack = lookback <= CATCH_UP_DAYS && !run.onlyCourses?.length ? lookback - 1 : 0;
    const day = istDayStart(istDate(run.startedAt)).getTime();
    for (let k = 0; k <= reachesBack; k++) collected.add(istDate(new Date(day - k * DAY_MS)));
  }
  for (let day = from.getTime(); day < to.getTime(); day += DAY_MS) {
    if (!collected.has(istDate(new Date(day)))) return false;
  }
  return true;
}

// The latest finished run of every course that searched the newest postings: a daily run or a short
// catch-up. A backfill (e.g. 30 days) or a run of only some courses doesn't count: run after midnight,
// it made "the latest day" a day the daily run hadn't collected yet (27 Oct 2026: an overnight backfill
// left it showing 7 kept and 0 non-filtered jobs). With no such run, the latest run of any kind.
const latestDailyRun = async () =>
  (await CollectorRun.findOne({
    status: { $in: ['success', 'partial'] },
    'onlyCourses.0': { $exists: false },
    $or: [{ lookbackDays: { $exists: false } }, { lookbackDays: { $lte: CATCH_UP_DAYS } }],
  })
    .sort({ startedAt: -1 })
    .lean()) ?? latestRun();

// Days are IST calendar days ending on the day of the latest daily run, so the dashboard
// shows the latest daily update even before today's run has happened.
async function dayRange(days) {
  const run = await latestDailyRun();
  const anchor = istDate(run?.startedAt ?? new Date());
  const end = new Date(istDayStart(anchor).getTime() + DAY_MS);
  const start = new Date(end.getTime() - days * DAY_MS);
  return { anchor, start, end, run };
}

// Used both to count what the dashboard shows (cards, charts) and to list the jobs behind a number
// (the job list's filters below), so a number and its list always agree.
const ON_SEVERAL_SITES = { 'platforms.1': { $exists: true } };
// HR details: an HR name, profile link, phone, email or note typed in, or a phone or email found in the
// posting. Students assigned alone don't count.
const typedIn = (field) => ({ [`manual.${field}`]: { $nin: [null, ''] } });
const listedIn = (field) => ({ [`manual.${field}.0`]: { $exists: true } });
const HAS_HR_DETAILS = {
  $or: [listedIn('hrNames'), listedIn('hrProfiles'), typedIn('phone'), typedIn('email'), typedIn('remarks'), { 'foundPhones.0': { $exists: true } }, { 'foundEmails.0': { $exists: true } }],
};
const SALARY_SHOWN = { salaryText: { $nin: [null, ''], $not: /not disclosed/i } };

// How old a posting was when our collector first found it: 'day' (up to 24 hours), '3days', 'week',
// 'month', 'older', or 'unknown' when the site shows no posting date.
const AGE_HOURS = { $divide: [{ $subtract: ['$firstSeenAt', '$postedAt'] }, 3_600_000] };
const POSTING_AGE = {
  $switch: {
    branches: [
      { case: { $not: [{ $ifNull: ['$postedAt', false] }] }, then: 'unknown' },
      { case: { $lte: [AGE_HOURS, 24] }, then: 'day' },
      { case: { $lte: [AGE_HOURS, 72] }, then: '3days' },
      { case: { $lte: [AGE_HOURS, 168] }, then: 'week' },
      { case: { $lte: [AGE_HOURS, 720] }, then: 'month' },
    ],
    default: 'older',
  },
};
const POSTING_AGES = ['day', '3days', 'week', 'month', 'older', 'unknown'];

// "2026-10-17" -> the start of that IST day, or null when it isn't a real date.
const dayParam = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return null;
  const start = istDayStart(String(value));
  return Number.isNaN(start.getTime()) ? null : start;
};

// A mistake in the request: answered with 400 and this message (app.js).
const badRequest = (message) => Object.assign(new Error(message), { status: 400, publicMessage: message });

const MAX_RANGE_DAYS = 366;

// The period a request asks for, as IST days:
// - ?from=2026-10-12&to=2026-10-15: those days, both included (a custom range; from=to is one day);
// - otherwise ?days=N: the last N days up to the latest collection day (see dayRange).
// days = how many days it covers, so "the period before" is the same length.
async function periodRange(query, fallbackDays, maxDays = 90) {
  const custom = customRange(query);
  if (custom) {
    const run = await latestDailyRun();
    return { ...custom, anchor: istDate(run?.startedAt ?? new Date()), run };
  }
  const days = clampDays(query.days, fallbackDays, maxDays);
  const range = await dayRange(days);
  return { days, ...range, from: istDate(range.start), to: range.anchor, custom: false };
}

// ?from=&to= (IST days, both included; from alone is one day) as { days, start, end, from, to, custom },
// or null when the request has neither. A date that doesn't exist, from after to, or too long: 400.
function customRange(query) {
  if (!query.from && !query.to) return null;
  const start = dayParam(query.from);
  const last = dayParam(query.to ?? query.from);
  const real = (date, value) => date && istDate(date) === String(value); // not "2026-02-31"
  if (!real(start, query.from) || !real(last, query.to ?? query.from)) throw badRequest('from and to must be dates like 2026-10-21.');
  if (start > last) throw badRequest('from must be on or before to.');
  const days = Math.round((last.getTime() - start.getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw badRequest(`Choose at most ${MAX_RANGE_DAYS} days.`);
  return { days, start, end: new Date(last.getTime() + DAY_MS), from: istDate(start), to: istDate(last), custom: true };
}

// A period of the activity record (people's changes, not collected jobs), so its days end today (IST),
// not on the latest collection day: ?days=N is today and the N-1 days before; or ?from=&to=.
function activityRange(query) {
  const custom = customRange(query);
  if (custom) return custom;
  const days = clampDays(query.days, 1, MAX_RANGE_DAYS);
  const end = new Date(istDayStart(istDate(new Date())).getTime() + DAY_MS);
  const start = new Date(end.getTime() - days * DAY_MS);
  return { days, start, end, from: istDate(start), to: istDate(new Date(end.getTime() - DAY_MS)), custom: false };
}

function jobFilter(query, { start, end }) {
  // id: one job, whenever it was found (e.g. opened from the activity record).
  if (query.id && /^[a-f\d]{24}$/i.test(String(query.id))) return { _id: String(query.id) };
  // day: one IST day (a day clicked on the trend chart) instead of the period.
  const day = dayParam(query.day);
  const filter = { firstSeenAt: day ? { $gte: day, $lt: new Date(day.getTime() + DAY_MS) } : { $gte: start, $lt: end } };
  if (query.course) filter.course = String(query.course);
  if (query.platform) filter.platforms = String(query.platform); // listed on that site
  if (query.primary) filter.primaryPlatform = String(query.primary); // counted there: posted there first
  if (query.company) filter.company = String(query.company);
  if (query.city) filter.cities = String(query.city);
  if (query.skill) filter.skills = String(query.skill);
  if (query.exp) filter.experienceBand = String(query.exp);
  if (POSTING_AGES.includes(query.age)) filter.$expr = { $eq: [POSTING_AGE, query.age] };
  if (query.sites === '2') Object.assign(filter, ON_SEVERAL_SITES);
  if (query.salary === 'shown') Object.assign(filter, SALARY_SHOWN);
  // hr: 'none' = no HR details yet, 'some' = has them (the same test as the job list's withContact).
  if (query.hr === 'none') filter.$nor = [HAS_HR_DETAILS];
  if (query.hr === 'some') filter.$and = [...(filter.$and ?? []), HAS_HR_DETAILS];
  const search = String(query.q ?? '').trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    // A student's name finds the jobs assigned to them; an HR person's name finds their jobs.
    filter.$or = [{ title: rx }, { company: rx }, { 'manual.assignedTo': rx }, { 'manual.hrNames': rx }];
  }
  return filter;
}

const countBy = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]));
// Group jobs by a field, keeping each value's jobs per course: { _id, count, byCourse: [{ k: course, v: n }] }.
const byCourseGroup = (field) => [
  { $group: { _id: { value: field, course: '$course' }, count: { $sum: 1 } } },
  { $group: { _id: '$_id.value', count: { $sum: '$count' }, byCourse: { $push: { k: '$_id.course', v: '$count' } } } },
];

// Platforms searched now, plus any switched off that still have jobs in the window
// (so platform totals always add up to the overall total).
async function platformsInUse(match, J = Job) {
  const searched = enabledSources(config.disabledSources).map((s) => s.platform);
  const inData = await J.distinct('platforms', match);
  return [...searched, ...inData.filter((p) => !searched.includes(p)).sort()];
}

const runSummary = (run) =>
  run && {
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    totals: run.totals,
    failedSearches: [
      ...(run.searches ?? [])
        .filter((s) => s.status === 'error')
        .map((s) => `${s.platform}: ${s.term}${s.location ? ` in ${s.location}` : ''}`),
      ...(run.platforms ?? [])
        .filter((p) => p.saveError)
        .map((p) => `${p.platform}: results not saved (run npm run replay)`),
    ],
  };

router.get('/meta', wrap(async (req, res) => {
  const J = jobsFor(req);
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [run, cities, platforms, oldest, newest] = await Promise.all([
    latestRun(),
    J.aggregate([
      { $match: { firstSeenAt: { $gte: since } } },
      { $unwind: '$cities' },
      { $match: { cities: { $nin: HIDDEN_CITIES } } },
      { $group: { _id: '$cities', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 60 },
    ]),
    platformsInUse({ firstSeenAt: { $gte: since } }, J),
    J.findOne({}, { firstSeenAt: 1 }).sort({ firstSeenAt: 1 }).lean(),
    J.findOne({}, { firstSeenAt: 1 }).sort({ firstSeenAt: -1 }).lean(),
  ]);
  const lastRunDay = istDate(run?.startedAt ?? new Date());
  const newestDay = newest ? istDate(newest.firstSeenAt) : lastRunDay;
  res.json({
    courses: COURSES.map(({ id, name }) => ({ id, name })),
    platforms,
    cities: cities.map((c) => c._id).sort((a, b) => a.localeCompare(b)),
    scheduleLabel: config.scheduleLabel,
    // The rules jobs must pass to be kept (config/filters.js), shown on the dashboard.
    filters: { experience: config.experience, excludedCompanies: EXCLUDED_COMPANIES },
    lastRun: runSummary(run),
    aiEnabled: Boolean(req.app?.locals.ai), // IJF AI is set up (OPEN_AI_API_KEY)
    // The days jobs are stored for (oldest to newest): what a custom period can choose from.
    dataDays: { first: oldest ? istDate(oldest.firstSeenAt) : null, last: newestDay > lastRunDay ? newestDay : lastRunDay },
    demo: config.demo,
  });
}));

// New jobs per course in the chosen window, plus the window before it for "vs previous" (empty when
// the two can't be compared fairly: see collectedEveryDay), and how many of the window's jobs have HR
// details (withHrDetails: the job list's test, so ?hr=some lists exactly those and ?hr=none the rest).
router.get('/summary', wrap(async (req, res) => {
  const J = jobsFor(req);
  const { days, anchor, start, end, from, to } = await periodRange(req.query, 1);
  const prevStart = new Date(start.getTime() - days * DAY_MS);
  const byCourse = (from, to, also = {}) =>
    J.aggregate([
      { $match: { firstSeenAt: { $gte: from, $lt: to }, ...also } },
      { $group: { _id: '$course', count: { $sum: 1 } } },
    ]).then(countBy);
  const [current, previous, comparable, withHrDetails] = await Promise.all([
    byCourse(start, end),
    byCourse(prevStart, start),
    collectedEveryDay(prevStart, end),
    byCourse(start, end, HAS_HR_DETAILS),
  ]);
  res.json({ days, anchor, from, to, current, previous: comparable ? previous : {}, comparable, withHrDetails });
}));

// New jobs per platform and course. Each job counts once, under its primary platform.
router.get('/platforms', wrap(async (req, res) => {
  const J = jobsFor(req);
  const range = await periodRange(req.query, 1);
  const { days } = range;
  const inRange = { firstSeenAt: { $gte: range.start, $lt: range.end } };
  const [rows, multiPlatform] = await Promise.all([
    J.aggregate([
      { $match: inRange },
      { $group: { _id: { platform: '$primaryPlatform', course: '$course' }, count: { $sum: 1 } } },
    ]),
    J.countDocuments({ ...inRange, ...ON_SEVERAL_SITES }),
  ]);
  const platforms = await platformsInUse(inRange, J);
  const result = platforms.map((platform) => {
    const byCourse = Object.fromEntries(COURSES.map((c) => [c.id, 0]));
    for (const r of rows) if (r._id.platform === platform) byCourse[r._id.course] = r.count;
    return { platform, byCourse, total: Object.values(byCourse).reduce((a, b) => a + b, 0) };
  });
  res.json({ days, anchor: range.anchor, from: range.from, to: range.to, multiPlatform, platforms: result.sort((a, b) => b.total - a.total) });
}));

// New jobs per IST day and course, with every day present (zeros included).
router.get('/trends', wrap(async (req, res) => {
  const J = jobsFor(req);
  const range = await periodRange(req.query, 30);
  const { days } = range;
  const rows = await J.aggregate([
    { $match: { firstSeenAt: { $gte: range.start, $lt: range.end } } },
    {
      $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$firstSeenAt', timezone: IST } }, course: '$course' },
        count: { $sum: 1 },
      },
    },
  ]);
  // Start on the first day we have data, so days before collection began don't show as zero.
  const first = await J.findOne({}, { firstSeenAt: 1 }).sort({ firstSeenAt: 1 }).lean();
  const firstDay = first ? istDayStart(istDate(first.firstSeenAt)).getTime() : range.end.getTime() - DAY_MS;
  const series = [];
  for (let t = Math.max(range.start.getTime(), firstDay); t < range.end.getTime(); t += DAY_MS) {
    const day = istDate(new Date(t));
    const point = { day };
    for (const c of COURSES) point[c.id] = 0;
    series.push(point);
  }
  const byDay = new Map(series.map((p) => [p.day, p]));
  for (const r of rows) {
    const point = byDay.get(r._id.day);
    if (point) point[r._id.course] = r.count;
  }
  // Days before the daily collection started came from a one-off backfill (may be incomplete).
  const since = await dailySince();
  const backfilledBefore = since && first && first.firstSeenAt < since ? istDate(since) : null;
  res.json({ days, anchor: range.anchor, from: range.from, to: range.to, series, backfilledBefore });
}));

// Top companies, cities, experience levels and skills in the window.
router.get('/insights', wrap(async (req, res) => {
  const J = jobsFor(req);
  const range = await periodRange(req.query, 7);
  const { days } = range;
  const match = jobFilter(req.query, range);
  const [facets] = await J.aggregate([
    { $match: match },
    {
      $facet: {
        // Each top company and city with its jobs per course too (shown when a bar is hovered).
        companies: [
          { $match: { company: { $nin: [null, ''] } } },
          ...byCourseGroup('$company'),
          { $sort: { count: -1, _id: 1 } },
          { $limit: 10 },
        ],
        cities: [
          { $unwind: '$cities' },
          { $match: { cities: { $nin: HIDDEN_CITIES } } },
          ...byCourseGroup('$cities'),
          { $sort: { count: -1, _id: 1 } },
          { $limit: 10 },
        ],
        experience: byCourseGroup('$experienceBand'),
        skills: [
          { $unwind: '$skills' },
          { $group: { _id: { course: '$course', skill: '$skills' }, count: { $sum: 1 } } },
          // Equal counts in name order, so the list doesn't change between page loads.
          { $sort: { count: -1, '_id.skill': 1 } },
        ],
        total: [{ $count: 'n' }],
      },
    },
  ]);
  const skillsByCourse = Object.fromEntries(COURSES.map((c) => [c.id, []]));
  for (const s of facets.skills) {
    const list = skillsByCourse[s._id.course];
    if (list && list.length < 8) list.push({ name: s._id.skill, count: s.count });
  }
  const courseCounts = (r) => Object.fromEntries(r.byCourse.map(({ k, v }) => [k, v]));
  const toList = (rows) => rows.map((r) => ({ name: r._id, count: r.count, byCourse: courseCounts(r) }));
  res.json({
    days,
    anchor: range.anchor,
    from: range.from,
    to: range.to,
    total: facets.total[0]?.n ?? 0,
    companies: toList(facets.companies),
    cities: toList(facets.cities),
    experience: countBy(facets.experience),
    experienceByCourse: Object.fromEntries(facets.experience.map((r) => [r._id, courseCounts(r)])),
    skills: skillsByCourse,
  });
}));

// Everything about one course's new jobs in the window: totals, where they came from, how old the
// postings were when found, how fresh the data is, and the usual breakdowns.
router.get('/course/:id', wrap(async (req, res) => {
  const J = jobsFor(req);
  const course = COURSES.find((c) => c.id === req.params.id);
  if (!course) return res.status(404).json({ error: 'Unknown course' });
  const range = await periodRange(req.query, 1);
  const { days } = range;
  const match = { course: course.id, firstSeenAt: { $gte: range.start, $lt: range.end } };
  const prevStart = new Date(range.start.getTime() - days * DAY_MS);
  const top = (field, limit = 10) => [
    ...(field === 'cities' || field === 'skills' ? [{ $unwind: `$${field}` }] : [{ $match: { [field]: { $nin: [null, ''] } } }]),
    ...(field === 'cities' ? [{ $match: { cities: { $nin: HIDDEN_CITIES } } }] : []),
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: limit },
  ];
  const [[facets], previous, platforms, oldest, storedTotal] = await Promise.all([
    J.aggregate([
      { $match: match },
      {
        $facet: {
          total: [{ $count: 'n' }],
          counted: [{ $group: { _id: '$primaryPlatform', count: { $sum: 1 } } }],
          listed: [{ $unwind: '$platforms' }, { $group: { _id: '$platforms', count: { $sum: 1 } } }],
          multiPlatform: [{ $match: ON_SEVERAL_SITES }, { $count: 'n' }],
          postingAge: [{ $group: { _id: POSTING_AGE, count: { $sum: 1 } } }],
          experience: [{ $group: { _id: '$experienceBand', count: { $sum: 1 } } }],
          salaryShown: [{ $match: SALARY_SHOWN }, { $count: 'n' }],
          foundRange: [{ $group: { _id: null, first: { $min: '$firstSeenAt' }, last: { $max: '$firstSeenAt' } } }],
          companies: top('company'),
          cities: top('cities'),
          skills: top('skills'),
        },
      },
    ]),
    J.countDocuments({ course: course.id, firstSeenAt: { $gte: prevStart, $lt: range.start } }).then(async (count) =>
      (await collectedEveryDay(prevStart, range.end)) ? count : 0,
    ),
    platformsInUse(match, J),
    J.findOne({ course: course.id }, { firstSeenAt: 1 }).sort({ firstSeenAt: 1 }).lean(),
    J.countDocuments({ course: course.id }),
  ]);

  const counted = countBy(facets.counted);
  const listed = countBy(facets.listed);
  const experience = countBy(facets.experience);
  const toList = (rows) => rows.map((r) => ({ name: r._id, count: r.count }));
  const n = (rows) => rows[0]?.n ?? 0;
  res.json({
    course: { id: course.id, name: course.name },
    days,
    anchor: range.anchor,
    from: range.from,
    to: range.to,
    total: n(facets.total),
    previous,
    platforms: platforms
      .map((platform) => ({ platform, counted: counted[platform] ?? 0, listed: listed[platform] ?? 0 }))
      .sort((a, b) => b.counted - a.counted || b.listed - a.listed),
    multiPlatform: n(facets.multiPlatform),
    postingAge: countBy(facets.postingAge),
    experience,
    salaryShown: n(facets.salaryShown),
    companies: toList(facets.companies),
    cities: toList(facets.cities),
    skills: toList(facets.skills),
    freshness: {
      lastRefreshed: range.run?.finishedAt ?? null,
      firstFoundInView: facets.foundRange[0]?.first ?? null,
      lastFoundInView: facets.foundRange[0]?.last ?? null,
      oldestKept: oldest?.firstSeenAt ?? null,
      storedTotal,
      retentionDays: config.retentionDays,
    },
  });
}));

// ---------- Skills that would open up more jobs ----------

// For one course and period: which skill the course doesn't teach (COURSES[].teaches) would let
// students match the most additional postings (counts from skillGaps.js), and where the postings came from.
router.get('/skill-gaps', wrap(async (req, res) => {
  const J = jobsFor(req);
  const course = COURSES.find((c) => c.id === req.query.course);
  if (!course) return res.status(404).json({ error: 'Unknown course.' });
  const range = await periodRange(req.query, 1);
  const { days } = range;
  const match = { course: course.id, firstSeenAt: { $gte: range.start, $lt: range.end } };
  const [postings, platforms] = await Promise.all([
    J.find(match, { skills: 1, firstSeenAt: 1, title: 1, company: 1, cities: 1, primaryPlatform: 1, links: 1 }).lean(),
    J.distinct('platforms', match),
  ]);
  const seen = postings.map((p) => p.firstSeenAt.getTime());
  const plan = skillPlan(postings, course.teaches);
  res.json({
    course: { id: course.id, name: course.name },
    days,
    anchor: range.anchor,
    from: range.from,
    to: range.to,
    teaches: course.teaches,
    ...skillGaps(postings, course.teaches),
    // Adding skills one after another, and the jobs within reach (for trying other combinations and
    // seeing which jobs a choice would open up).
    plan: {
      ladder: plan.ladder,
      maxAdd: plan.maxAdd,
      jobs: plan.reachable.map(({ posting, missing }) => ({
        id: posting._id,
        title: posting.title,
        company: posting.company ?? '',
        cities: posting.cities ?? [],
        platform: posting.primaryPlatform,
        url: posting.links?.[posting.primaryPlatform] ?? Object.values(posting.links ?? {})[0] ?? '',
        missing,
      })),
    },
    trackedSkillCount: SKILL_NAMES.length,
    source: {
      platforms: platforms.sort(),
      firstSeenFrom: seen.length ? new Date(seen.reduce((a, b) => Math.min(a, b))) : null,
      firstSeenTo: seen.length ? new Date(seen.reduce((a, b) => Math.max(a, b))) : null,
      lastRefreshed: range.run?.finishedAt ?? null,
    },
  });
}));

// ---------- Hiring partners ----------

// Companies that posted at least PARTNER_MIN_OPENINGS openings for the courses in the last
// PARTNER_DAYS days (large IT services firms never reach the database), with their HR contacts and
// how recently they posted. See companies.js.
const PARTNER_DAYS = 90;
const PARTNER_MIN_OPENINGS = 2;

async function partnerList(J = Job) {
  const range = await dayRange(PARTNER_DAYS);
  const jobs = await J.find(
    { firstSeenAt: { $gte: range.start, $lt: range.end }, company: { $nin: [null, ''] } },
    { _id: 0, company: 1, course: 1, cities: 1, firstSeenAt: 1, foundPhones: 1, foundEmails: 1, manual: 1 },
  ).lean();
  const first = jobs.length ? new Date(Math.min(...jobs.map((j) => j.firstSeenAt.getTime()))) : null;
  return {
    days: PARTNER_DAYS,
    minOpenings: PARTNER_MIN_OPENINGS,
    from: first ? istDate(first) : null,
    to: range.anchor,
    jobs: jobs.length,
    partners: hiringPartners(jobs, { minOpenings: PARTNER_MIN_OPENINGS }),
    lastRefreshed: range.run?.finishedAt ?? null,
  };
}

router.get('/partners', wrap(async (req, res) => res.json(await partnerList(jobsFor(req)))));

router.get('/partners.csv', wrap(async (req, res) => {
  const list = await partnerList(jobsFor(req));
  const header = ['Company', 'Openings', ...COURSES.map((c) => c.name), 'Cities', 'Last posted (IST)', 'HR phones', 'HR emails'];
  const lines = list.partners.map((p) =>
    [
      p.name,
      p.openings,
      ...COURSES.map((c) => p.courses[c.id] ?? 0),
      p.cities.join('; '),
      istDate(p.lastPosted),
      p.phones.join('; '),
      p.emails.join('; '),
    ]
      .map(csvCell)
      .join(','),
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="hiring-partners-${list.to}.csv"`);
  res.send(`﻿${[header.join(','), ...lines].join('\r\n')}`);
}));

// ---------- One role's openings (the dashboard's "SRE Openings" box) ----------

// The openings of one role (config/roleBoxes.js) found in the period, in the view's set (Filtered; with
// ?view=nonfiltered the Non-filtered jobs, each with its leftOutBy; with ?view=all both), newest first.
// ?role=sre, ?days= or ?from=&to=, ?page=, ?limit= (at most 100). Also how many each set has. Signed in only.
router.get('/role-jobs', requirePermission('view'), wrap(async (req, res) => {
  const role = ROLE_BOXES.find((r) => r.id === req.query.role);
  if (!role) return res.status(400).json({ error: `role must be one of: ${ROLE_BOXES.map((r) => r.id).join(', ')}.` });
  const range = await periodRange(req.query, 1);
  const match = { firstSeenAt: { $gte: range.start, $lt: range.end }, ...roleTitleQuery(role) };
  const pageSize = Math.min(clampDays(req.query.limit, 25, 100), 100);
  const page = clampDays(req.query.page, 1, 100_000);
  const J = jobsFor(req);
  // The same number for the period before (in the view's set), when the two can be compared.
  const prevStart = new Date(range.start.getTime() - range.days * DAY_MS);
  const [items, filtered, nonFiltered, comparable] = await Promise.all([
    J.find(match, JOB_FIELDS).sort(JOB_SORT).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Job.countDocuments(match),
    NonFilteredJob.countDocuments(match),
    collectedEveryDay(prevStart, range.end),
  ]);
  const previous = comparable ? await J.countDocuments({ ...match, firstSeenAt: { $gte: prevStart, $lt: range.start } }) : null;
  const view = viewOf(req);
  const total = { filtered, nonfiltered: nonFiltered, all: filtered + nonFiltered }[view];
  res.json({
    role: { id: role.id, name: role.name },
    view,
    days: range.days,
    from: range.from,
    to: range.to,
    total,
    filtered,
    nonFiltered,
    previous, // the period before, or null when it can't be compared
    comparable,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    items: items.map(jobRow),
  });
}));

// ---------- One company's openings, and the search box ----------

// One company's openings, newest first: every spelling of its name counts (companyKey), as in Hiring
// partners. ?key= the company's key (a hiring partner's `key`, or a search result's). ?days= only the
// jobs first found in the last N days (Hiring partners pass theirs); without it, every stored job.
// ?all=1: kept and left-out jobs together (the search box), else the view's set. Signed in only.
const COMPANY_JOBS_MAX = 300;

router.get('/companies/jobs', requirePermission('view'), wrap(async (req, res) => {
  const key = String(req.query.key ?? '').trim();
  if (!key || key.length > 200) return res.status(400).json({ error: 'key must be a company key.' });
  const days = req.query.days ? clampDays(req.query.days, PARTNER_DAYS, 90) : null;
  const range = days ? await dayRange(days) : null;
  const window = { company: { $nin: [null, ''] }, ...(range ? { firstSeenAt: { $gte: range.start, $lt: range.end } } : {}) };
  const sets = req.query.all === '1' ? [Job, NonFilteredJob] : [jobsFor(req)];
  const found = await Promise.all(
    sets.map(async (J) => {
      const spellings = (await J.distinct('company', window)).filter((name) => companyKey(name) === key);
      if (!spellings.length) return { items: [], total: 0 };
      const filter = { ...window, company: { $in: spellings } };
      const [items, total] = await Promise.all([J.find(filter, JOB_FIELDS).sort(JOB_SORT).limit(COMPANY_JOBS_MAX).lean(), J.countDocuments(filter)]);
      return { items, total };
    }),
  );
  const items = found
    .flatMap((f) => f.items)
    .sort((a, b) => b.firstSeenAt - a.firstSeenAt || String(a._id).localeCompare(String(b._id)))
    .slice(0, COMPANY_JOBS_MAX);
  const spellings = new Map();
  for (const job of items) spellings.set(job.company, (spellings.get(job.company) ?? 0) + 1);
  const name = [...spellings].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? '';
  res.json({ key, name, days, total: found.reduce((n, f) => n + f.total, 0), items: items.map(jobRow) });
}));

// The search box on the dashboard: companies, HR names, phone numbers and emails, in kept and left-out
// jobs alike (search.js). ?q= at least 2 letters or 3 digits. Signed in only.
router.get('/search', requirePermission('view'), wrap(async (req, res) => {
  res.json(await searchEverything(String(req.query.q ?? ''), { fields: JOB_FIELDS }));
}));

// ---------- Job lists ----------

const JOB_FIELDS = {
  title: 1, company: 1, course: 1, cities: 1, experienceMin: 1, experienceMax: 1,
  experienceText: 1, experienceBand: 1, salaryText: 1, skills: 1, postedAt: 1, firstSeenAt: 1,
  primaryPlatform: 1, platforms: 1, links: 1, foundPhones: 1, foundEmails: 1, manual: 1, leftOutBy: 1,
};
const JOB_SORT = { firstSeenAt: -1, postedAt: -1, _id: 1 };

router.get('/jobs', wrap(async (req, res) => {
  const J = jobsFor(req);
  const range = await periodRange(req.query, 1);
  const { days } = range;
  const filter = jobFilter(req.query, range);
  const pageSize = Math.min(clampDays(req.query.limit, 25, 100), 100);
  const page = clampDays(req.query.page, 1, 100_000);
  // withContact: how many of these jobs have HR details (HAS_HR_DETAILS).
  const hasContact = HAS_HR_DETAILS;
  const [items, total, withContact] = await Promise.all([
    J.find(filter, JOB_FIELDS).sort(JOB_SORT).skip((page - 1) * pageSize).limit(pageSize).lean(),
    J.countDocuments(filter),
    J.countDocuments({ $and: [filter, hasContact] }),
  ]);
  res.json({
    days,
    anchor: range.anchor,
    from: range.from,
    to: range.to,
    page,
    pageSize,
    total,
    withContact,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    items: items.map(jobRow),
  });
}));

// Saves the HR phone, email and remarks typed in for one job and returns the updated row. An empty
// field clears it; when all three are empty the job has no typed-in details (and shows what its
// postings say, if anything). The collector never writes these, so the next run can't undo them.
// A phone number another job already has is refused (409) with PHONE_EXISTS, and `detail` says which job.
// Only a signed-in person whose role may edit HR details (src/auth.js); every change is recorded under
// their email (Activity).
router.put('/jobs/:id/follow-up', requirePermission('edit-hr-details'), express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const notFound = () => res.status(404).json({ error: 'Job not found. It may have been removed.' });
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return notFound();
  const input = parseFollowUpInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  // A kept job, or a non-filtered one (ids are unique across both).
  const fields = { foundPhones: 1, foundEmails: 1, manual: 1, title: 1, company: 1, course: 1 };
  let model = Job;
  let current = await Job.findById(req.params.id, fields).lean();
  if (!current) {
    model = NonFilteredJob;
    current = await NonFilteredJob.findById(req.params.id, fields).lean();
  }
  if (!current) return notFound();
  const owner = await findPhoneOwner(input.value.phoneKeys, current);
  if (owner) {
    const number = input.value.phone.split(', ').find((p) => phoneKey(p) === owner.key);
    const where = `"${owner.job.title}"${owner.job.company ? ` at ${owner.job.company}` : ''}`;
    return res.status(409).json({ error: PHONE_EXISTS, detail: `${number} is already saved on ${where}.` });
  }

  const now = new Date();
  // Found by: the one chosen, else the one stored. Adding or changing HR contact details needs one; saving only
  // notes or students doesn't (older contacts may have none).
  const record = manualRecord({ ...input.value, foundBy: input.value.foundBy || current.manual?.foundBy || '' }, now);
  const update = record ? { $set: { manual: record } } : { $unset: { manual: 1 } };

  // What the dashboard shows before and after this save; nothing changed (e.g. saved as it was): no record.
  const changes = contactChanges(contactView(current), contactView({ ...current, manual: record ?? undefined }));
  const contactsChanged = changes.some((c) => CONTACT_DETAILS.includes(c.field));
  if (contactsChanged && (record?.hrNames || record?.hrProfiles || record?.phone || record?.email) && !record.foundBy) {
    return res.status(400).json({ error: FOUND_BY_REQUIRED });
  }
  // The record is written first, so a change is never saved without one. If the save then fails, the
  // record goes again.
  const entry = changes.length
    ? await Activity.create({
        at: now,
        actor: req.person,
        ...(req.via ? { via: req.via } : {}),
        action: overallAction(changes),
        job: { id: current._id, set: model === Job ? 'filtered' : 'nonfiltered', title: current.title, company: current.company, course: current.course },
        changes,
      })
    : null;
  const undoRecord = () => (entry ? Activity.deleteOne({ _id: entry._id }).catch((err) => console.error(`Could not remove activity ${entry._id}: ${err.message}`)) : null);
  let job;
  try {
    job = await model.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after', projection: JOB_FIELDS }).lean();
  } catch (err) {
    await undoRecord();
    throw err;
  }
  if (!job) {
    await undoRecord();
    return notFound();
  }
  res.json(jobRow(job));
}));

// The activity record: who changed which job's HR details, when, and what changed. Newest first.
// Filters: ?job=<id> · ?email= one person · ?action=added|edited|removed · ?q= words in the job title or
// company. ?limit= (at most 200). ?before= the `next` of the page before (its last record's time and id).
// The first page also says how many records match (total) and who has made changes (people).
// Only for signed-in people with an allowed role.
const ACTIONS = ['added', 'edited', 'removed'];
router.get('/activity', requirePermission('view'), wrap(async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
  const filter = {};
  if (req.query.job) {
    if (!/^[a-f\d]{24}$/i.test(String(req.query.job))) return res.status(400).json({ error: 'job must be a job id.' });
    filter['job.id'] = String(req.query.job);
  }
  if (req.query.email) filter['actor.email'] = new RegExp(`^${escapeRegex(String(req.query.email).trim())}$`, 'i');
  if (ACTIONS.includes(req.query.action)) filter.action = req.query.action;
  const search = String(req.query.q ?? '').trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ 'job.title': rx }, { 'job.company': rx }];
  }

  // The page after a record: older ones, or as old with a smaller id (two changes in the same millisecond).
  let page = filter;
  if (req.query.before) {
    const [time, id] = String(req.query.before).split('_');
    const at = new Date(time);
    if (Number.isNaN(at.getTime()) || (id && !/^[a-f\d]{24}$/i.test(id))) return res.status(400).json({ error: 'before must be the next value of a page.' });
    const older = id ? { $or: [{ at: { $lt: at } }, { at, _id: { $lt: new mongoose.Types.ObjectId(id) } }] } : { at: { $lt: at } };
    page = { $and: [filter, older] };
  }

  const first = !req.query.before;
  const [items, total, people] = await Promise.all([
    Activity.find(page).sort({ at: -1, _id: -1 }).limit(limit + 1).lean(),
    first ? Activity.countDocuments(filter) : null,
    first
      ? Activity.aggregate([
          { $sort: { at: -1 } },
          { $group: { _id: '$actor.email', name: { $first: '$actor.name' }, count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
        ])
      : null,
  ]);
  const shown = items.slice(0, limit);
  const last = shown.at(-1);
  res.json({
    items: shown,
    next: items.length > limit ? `${last.at.toISOString()}_${last._id}` : null,
    ...(first ? { total, people: people.map((p) => ({ email: p._id, name: p.name ?? '', count: p.count })) } : {}),
  });
}));

// ---------- Performance report ----------

// Who added how many HR contact details (phone numbers and emails) in a period, from the activity
// record: one row per number or email a person added, with when, on which job and where it was found
// (Found by). A number only
// written differently, or one the job's posting already had, isn't one (see activity.js). The
// dashboard groups the rows person → course → company → job. Signed-in people with an allowed role.
const CONTACT_FIELDS = ['phone', 'email'];
// One follow-up as the dashboard gets it (student '': a remark made before anyone was given the number).
const outcomeView = (o) => ({ student: o.student ?? '', status: o.status ?? '', note: o.note ?? '', updatedAt: o.updatedAt ?? null, updatedBy: o.updatedBy ?? null });
// The one follow-up a dashboard built before a number could go to several students reads (`outcome`): the first
// student's, else the number's own remark. Kept until every dashboard reads `outcomes`.
const firstOutcome = (outcomes) => outcomes.find((o) => o.student) ?? outcomes[0] ?? null;
const MAX_PERFORMANCE_ROWS = 20_000;

router.get('/performance', requirePermission('view'), wrap(async (req, res) => {
  const range = activityRange(req.query);
  const [rows, first] = await Promise.all([
    Activity.aggregate([
      { $match: { at: { $gte: range.start, $lt: range.end } } },
      { $sort: { at: -1, _id: -1 } },
      { $unwind: '$changes' },
      { $match: { 'changes.field': { $in: CONTACT_FIELDS } } },
      { $unwind: '$changes.added' },
      { $limit: MAX_PERFORMANCE_ROWS + 1 },
      {
        $project: {
          _id: 0,
          record: '$_id',
          at: 1,
          actor: { email: { $toLower: '$actor.email' }, name: '$actor.name', role: '$actor.role' },
          job: 1,
          field: '$changes.field',
          value: '$changes.added',
        },
      },
    ]),
    Activity.findOne({}, { at: 1 }).sort({ at: 1 }).lean(),
  ]);
  const shown = rows.slice(0, MAX_PERFORMANCE_ROWS);
  const jobIds = [...new Map(shown.map((r) => [String(r.job.id), r.job.id])).values()];
  const [outcomeDocs, sourceRecords] = await Promise.all([
    ContactOutcome.find({ job: { $in: jobIds.map(String) } }).sort({ _id: 1 }).lean(),
    Activity.find({ 'job.id': { $in: jobIds }, at: { $lt: range.end }, 'changes.field': 'foundBy' }, { at: 1, 'job.id': 1, changes: 1 }).sort({ at: 1, _id: 1 }).lean(),
  ]);
  // Each number/email's follow-ups (the students it was given to, how each call went; the first given first):
  // the same for every row of it.
  const outcomesOf = new Map();
  for (const o of outcomeDocs) {
    const id = `${o.job}|${o.field}|${o.key}`;
    outcomesOf.set(id, [...(outcomesOf.get(id) ?? []), outcomeView(o)]);
  }
  // Where each number/email was found ("Found by", one per job): the job's source as it stood when it was
  // added, from the record that added it or the latest one before that set it ('' = none: added before
  // Found by was asked for, 28 Oct 2026).
  const sourcesOf = new Map();
  for (const record of sourceRecords) {
    const change = record.changes.find((c) => c.field === 'foundBy');
    const list = sourcesOf.get(String(record.job.id)) ?? [];
    list.push({ at: record.at, source: change?.after?.[0] ?? '' });
    sourcesOf.set(String(record.job.id), list);
  }
  const foundByOf = (row) => (sourcesOf.get(String(row.job.id)) ?? []).filter((s) => s.at <= row.at).at(-1)?.source ?? '';
  res.json({
    days: range.days,
    from: range.from,
    to: range.to,
    since: first?.at ?? null, // when the activity record began: nothing before it can be counted
    rows: shown.map((row) => {
      const key = contactKey(row.field, row.value);
      const outcomes = outcomesOf.get(`${row.job.id}|${row.field}|${key}`) ?? [];
      return { ...row, key, outcomes, outcome: firstOutcome(outcomes), foundBy: foundByOf(row) };
    }),
    truncated: rows.length > MAX_PERFORMANCE_ROWS,
    students: await knownStudents(), // names to suggest when assigning
  });
}));

// ---------- Review board ----------

// The HR numbers and emails given to students in a period, and the feedback on each student's call (from the
// activity record; days end today, as in the Performance report). A number can go to several students, so a
// row is one number with one student: given to them in the period, or with feedback on their call recorded in
// it. Plus one row (student '') for each number the team added in the period that no student has now (still
// to give out); it also holds a remark recorded on the number before anyone was given it. Each row has: its
// job; when the team added the number (if in the period); who found it (the person who added it to the job,
// else the job post, else "earlier": before the record began); the latest time it was given to the student up
// to the period's end (by whom, whether in the period; none if taken back since); the feedback recorded in the
// period (the latest: its remark, by whom, when, and the hours since the number was given to the student);
// the student's follow-up now; and how many students have the number now. The dashboard counts, groups and
// filters these. A remark recorded before a number could go to several students names no student: it was the
// call of whoever had the number then. Signed-in people only.
const MAX_REVIEW_ROWS = 5_000;
const latestIn = (row) => Math.max(+(row.added?.at ?? 0), row.given?.inPeriod ? +row.given.at : 0, +(row.feedback?.at ?? 0));

router.get('/review', requirePermission('view'), wrap(async (req, res) => {
  const range = activityRange(req.query);
  const fields = ['contactStudent', 'contactRemark', ...CONTACT_FIELDS];
  const person = (actor) => ({ email: String(actor?.email ?? '').toLowerCase(), name: actor?.name ?? '' });
  const contactOf = (jobId, field, value) => `${jobId}|${field}|${contactKey(field, value)}`;
  const inPeriod = (at) => at >= range.start;

  // The jobs anything happened on in the period, then their whole record up to its end, oldest first.
  const [jobIds, first] = await Promise.all([
    Activity.distinct('job.id', { at: { $gte: range.start, $lt: range.end }, 'changes.field': { $in: fields } }),
    Activity.findOne({}, { at: 1 }).sort({ at: 1 }).lean(),
  ]);
  const [history, outcomes, posts] = await Promise.all([
    Activity.find({ 'job.id': { $in: jobIds }, at: { $lt: range.end }, 'changes.field': { $in: fields } }, { at: 1, actor: 1, job: 1, changes: 1 })
      .sort({ at: 1, _id: 1 })
      .lean(),
    ContactOutcome.find({ job: { $in: jobIds } }).lean(),
    Promise.all([Job, NonFilteredJob].map((model) => model.find({ _id: { $in: jobIds } }, { foundPhones: 1, foundEmails: 1 }).lean())),
  ]);

  // Each number's story as it happened: who added it, the students it is with, and each student's call (when
  // they were last given it, and the feedback recorded in the period).
  const contacts = new Map();
  const contactFor = (entry, field, value) => {
    const id = contactOf(entry.job.id, field, value);
    if (!contacts.has(id)) contacts.set(id, { id, job: entry.job, field, value, finder: null, added: null, students: new Map(), calls: new Map() });
    return contacts.get(id);
  };
  const callOf = (contact, student) => {
    const k = student.toLowerCase();
    if (!contact.calls.has(k)) contact.calls.set(k, { student, given: null, feedback: null });
    return contact.calls.get(k);
  };
  for (const entry of history) {
    const by = person(entry.actor);
    for (const change of entry.changes) {
      if (CONTACT_FIELDS.includes(change.field)) {
        // Added to the job by the team (a number only written differently isn't one: activity.js).
        for (const value of change.added ?? []) {
          const contact = contactFor(entry, change.field, value);
          contact.finder ??= by;
          if (inPeriod(entry.at)) contact.added ??= { at: entry.at, by };
        }
      } else if (change.contact && change.field === 'contactStudent') {
        const contact = contactFor(entry, change.contact.field, change.contact.value);
        for (const name of change.removed ?? []) {
          contact.students.delete(name.toLowerCase());
          callOf(contact, name).given = null; // taken back: not given out
        }
        for (const name of change.added ?? []) {
          contact.students.set(name.toLowerCase(), name);
          callOf(contact, name).given = { at: entry.at, by, student: name };
        }
      } else if (change.contact && change.field === 'contactRemark' && inPeriod(entry.at)) {
        const contact = contactFor(entry, change.contact.field, change.contact.value);
        const student = change.contact.student ?? (contact.students.size === 1 ? [...contact.students.values()][0] : '');
        const call = callOf(contact, student);
        const label = change.after?.[0] ?? '';
        call.feedback = label ? { at: entry.at, by, label, ...remarkOf(label), givenAt: call.given?.at ?? null } : null;
      }
    }
  }

  const inPost = new Set(
    posts.flat().flatMap((job) => [...(job.foundPhones ?? []).map((v) => contactOf(job._id, 'phone', v)), ...(job.foundEmails ?? []).map((v) => contactOf(job._id, 'email', v))]),
  );
  const outcomeOf = new Map(outcomes.map((o) => [`${o.job}|${o.field}|${o.key}|${(o.student ?? '').toLowerCase()}`, o]));
  const withStudents = new Map();
  for (const o of outcomes) if (o.student) withStudents.set(`${o.job}|${o.field}|${o.key}`, (withStudents.get(`${o.job}|${o.field}|${o.key}`) ?? 0) + 1);

  const rows = [];
  for (const contact of contacts.values()) {
    const { id, set, title, company, course } = contact.job;
    const base = {
      contact: contact.id,
      job: { id, set, title, company, course },
      field: contact.field,
      value: contact.value,
      key: contactKey(contact.field, contact.value),
      found: contact.finder ? { source: 'team', by: contact.finder } : { source: inPost.has(contact.id) ? 'post' : 'earlier', by: null },
      added: contact.added,
      withStudents: withStudents.get(contact.id) ?? 0,
    };
    const row = (call) => {
      const o = outcomeOf.get(`${contact.id}|${call.student.toLowerCase()}`);
      return {
        ...base,
        id: `${contact.id}|${call.student.toLowerCase()}`,
        student: call.student,
        given: call.given && { ...call.given, inPeriod: inPeriod(call.given.at) },
        feedback: call.feedback && {
          at: call.feedback.at,
          by: call.feedback.by,
          label: call.feedback.label,
          status: call.feedback.status,
          note: call.feedback.note,
          hours: call.feedback.givenAt ? (call.feedback.at - call.feedback.givenAt) / 3_600_000 : null,
        },
        now: o ? { student: o.student ?? '', status: o.status ?? '', note: o.note ?? '' } : null,
      };
    };
    const calls = [...contact.calls.values()].filter((call) => (call.given && inPeriod(call.given.at)) || call.feedback);
    rows.push(...calls.map(row));
    // Added in the period and no student has it now: still to give out.
    if (contact.added && !base.withStudents && !calls.some((call) => !call.student)) rows.push(row({ student: '', given: null, feedback: null }));
  }
  // The latest first: when it was added, given out or called in the period.
  rows.sort((a, b) => latestIn(b) - latestIn(a));
  res.json({
    days: range.days,
    from: range.from,
    to: range.to,
    since: first?.at ?? null, // when the activity record began: nothing before it can be counted
    rows: rows.slice(0, MAX_REVIEW_ROWS),
    truncated: rows.length > MAX_REVIEW_ROWS,
  });
}));

// Every student name used so far (jobs' "Assigned to" lists and the report's assignments), each once, A–Z.
async function knownStudents() {
  const lists = await Promise.all([Job.distinct('manual.assignedTo'), NonFilteredJob.distinct('manual.assignedTo'), ContactOutcome.distinct('student')]);
  const names = new Map();
  for (const name of lists.flat()) if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  return [...names.values()].sort((a, b) => a.localeCompare(b)).slice(0, 2000);
}

// One number or email's follow-up with one student, from the performance report or the Assign page (see
// parseOutcomeInput): give it to a student, take it back, or record how their call went. A number can go to
// several students, each with a remark of their own. A student given any of a job's numbers/emails is on the
// job's "Assigned to" list, and leaves it when none is theirs any more. Recorded in the activity record under
// the person's email, like any change. Answers with the number's follow-ups now and the job's list.
router.put('/outcomes', requirePermission('record-outcomes'), express.json({ limit: '4kb' }), wrap(async (req, res) => {
  const input = parseOutcomeInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const { job: jobId, field, value, key, remove } = input.value;
  const remarking = 'status' in input.value;
  const fields = { manual: 1, title: 1, company: 1, course: 1 };
  let model = Job;
  let job = await Job.findById(jobId, fields).lean();
  if (!job) {
    model = NonFilteredJob;
    job = await NonFilteredJob.findById(jobId, fields).lean();
  }
  if (!job) return res.status(404).json({ error: 'Job not found. It may have been removed.' });

  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const docs = await ContactOutcome.find({ job: job._id, field, key }).sort({ _id: 1 }).lean();
  const named = docs.filter((d) => d.student);
  const loose = docs.find((d) => !d.student) ?? null; // a remark made before anyone was given it
  // Whose follow-up: the student sent; a remark sent without one (as the report did before a number could go
  // to several students) is the only student's, else the number's own.
  const student = !input.value.studentSent && remarking && named.length === 1 ? named[0].student : input.value.student;
  const mine = student ? (named.find((d) => same(d.student, student)) ?? null) : loose;
  // The first student given it takes over a remark made before anyone was given it.
  const takeOver = student && !remove && !mine && !named.length ? loose : null;

  const before = named.map((d) => d.student);
  const after = remove ? before.filter((s) => !same(s, student)) : student && !mine ? [...before, student] : before;
  const kept = mine ?? takeOver;
  const was = { status: kept?.status ?? '', note: kept?.note ?? '' };
  const next = remove ? { status: '', note: '' } : remarking ? { status: input.value.status, note: input.value.note } : was;

  // The job's "Assigned to" list: the student on it; one taken back leaves it unless another of the job's
  // numbers/emails is still theirs.
  const students = job.manual?.assignedTo ?? [];
  let nextStudents = students;
  if (student && !remove && !students.some((s) => same(s, student))) nextStudents = [...students, student];
  if (remove && mine) {
    const stillGiven = await ContactOutcome.exists({ job: job._id, _id: { $ne: mine._id }, student: new RegExp(`^${escapeRegex(student)}$`, 'i') });
    if (!stillGiven) nextStudents = nextStudents.filter((s) => !same(s, student));
  }
  if (nextStudents.length > MAX_STUDENTS && nextStudents.length > students.length) {
    return res.status(400).json({ error: `Assigned to: this job already has ${MAX_STUDENTS} students.` });
  }

  // Recorded with the student's name as it is stored (as first given), whatever case it was sent in.
  const name = mine?.student ?? student;
  const changes = [...studentChange(field, value, before, after), ...remarkChange(field, value, name, was, next)];
  const added = nextStudents.filter((s) => !students.includes(s));
  const removed = students.filter((s) => !nextStudents.includes(s));
  if (added.length || removed.length) {
    changes.push({ field: 'assignedTo', change: !students.length ? 'added' : !nextStudents.length ? 'removed' : 'edited', before: students, after: nextStudents, added, removed });
  }
  const answer = async (assignedTo) => {
    const outcomes = (await ContactOutcome.find({ job: job._id, field, key }).sort({ _id: 1 }).lean()).map(outcomeView);
    return { outcomes, outcome: firstOutcome(outcomes), assignedTo };
  };
  if (!changes.length) return res.json(await answer(students));

  // As for HR details: the record first, so nothing changes without one; removed again if the save fails.
  const now = new Date();
  const entry = await Activity.create({
    at: now,
    actor: req.person,
    ...(req.via ? { via: req.via } : {}),
    action: overallAction(changes),
    job: { id: job._id, set: model === Job ? 'filtered' : 'nonfiltered', title: job.title, company: job.company, course: job.course },
    changes,
  });
  try {
    // Only what was sent is written (the student, or the remark), so a student and a remark saved at the same
    // moment don't undo each other.
    const set = { value, updatedAt: now, updatedBy: { email: req.person.email, name: req.person.name ?? '' }, ...(remarking ? { status: next.status, note: next.note } : {}) };
    if (remove) {
      if (mine) await ContactOutcome.deleteOne({ _id: mine._id });
    } else if (takeOver) {
      await ContactOutcome.updateOne({ _id: takeOver._id }, { $set: { ...set, student } });
    } else if (student) {
      // The student's follow-up, made if they have none: the unique index (one per number and student, in any
      // case) keeps the same student sent twice at once to one; the save that lost the race updates it.
      const filter = { job: job._id, field, key, student: name };
      const save = (upsert) => ContactOutcome.updateOne(filter, { $set: set }, { upsert, collation: STUDENT_COLLATION });
      await save(true).catch((err) => (err.code === 11000 ? save(false) : Promise.reject(err)));
    } else if (loose) {
      // The number's own remark (no student has it): cleared, nothing is left of it.
      if (next.status) await ContactOutcome.updateOne({ _id: loose._id }, { $set: set });
      else await ContactOutcome.deleteOne({ _id: loose._id });
    } else if (next.status) {
      await ContactOutcome.create({ job: job._id, field, key, student: '', ...set });
    }
    // The job's list: one name added or taken off at a time (not the whole list written back), then the job's
    // typed-in details removed if nothing at all is left in them.
    if (added.length) await model.updateOne({ _id: job._id }, { $addToSet: { 'manual.assignedTo': { $each: added } }, $set: { 'manual.updatedAt': now } });
    if (removed.length) {
      await model.updateOne({ _id: job._id }, { $pull: { 'manual.assignedTo': { $in: removed } }, $set: { 'manual.updatedAt': now } });
      const after = await model.findById(job._id, { manual: 1 }).lean();
      if (after?.manual && !manualRecord({ ...contactValue(after.manual), assignedTo: after.manual.assignedTo ?? [] }, now)) {
        await model.updateOne({ _id: job._id }, { $unset: { manual: 1 } });
      }
    }
    res.json(await answer(nextStudents));
  } catch (err) {
    await Activity.deleteOne({ _id: entry._id }).catch((e) => console.error(`Could not remove activity ${entry._id}: ${e.message}`));
    throw err;
  }
}));

// A job's stored typed-in details in manualRecord's form (to change only its students).
const contactValue = (manual) => ({
  hrNames: manual?.hrNames ?? [],
  hrProfiles: manual?.hrProfiles ?? [],
  phone: manual?.phone ?? '',
  phoneKeys: manual?.phoneKeys ?? [],
  email: manual?.email ?? '',
  remarks: manual?.remarks ?? '',
});

// A non-filtered job's leftOutBy, in words.
const LEFT_OUT_REASONS = {
  'big-company': 'Large IT services firm',
  experience: underExperienceText(),
  'no-experience': 'Experience not stated',
  'extra-search': 'From the extra searches',
};

const istDateTime = (date) => (date ? new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ') : '');
const experienceLabel = (job) =>
  job.experienceMin == null ? job.experienceText || '' : job.experienceMax != null ? `${job.experienceMin}-${job.experienceMax} yrs` : `${job.experienceMin}+ yrs`;

router.get('/jobs.csv', wrap(async (req, res) => {
  const J = jobsFor(req);
  const range = await periodRange(req.query, 1);
  const { days } = range;
  const jobs = await J.find(jobFilter(req.query, range), JOB_FIELDS).sort(JOB_SORT).limit(10_000).lean();
  const courseName = Object.fromEntries(COURSES.map((c) => [c.id, c.name]));
  const platforms = await platformsInUse({ firstSeenAt: { $gte: range.start, $lt: range.end } }, J);
  // Non-filtered and All say why each left-out job is left out (a kept job's cell is empty).
  const view = viewOf(req);
  const withReason = view !== 'filtered';
  const header = [
    'First seen (IST)', 'Posted (IST)', 'Course', 'Title', 'Company', 'Cities', 'Experience', 'Salary', 'Listed on',
    'HR name', 'HR profile', 'Phone', 'Email', 'Assigned to', 'Remarks', ...(withReason ? ['Left out because'] : []), ...platforms.map((p) => `${p} link`),
  ];
  const lines = jobs.map(jobRow).map((job) =>
    [
      istDateTime(job.firstSeenAt),
      istDateTime(job.postedAt),
      courseName[job.course] ?? job.course,
      job.title,
      job.company,
      (job.cities ?? []).join('; '),
      experienceLabel(job),
      job.salaryText,
      (job.platforms ?? []).join('; '),
      job.contact.hrNames.join('; '),
      job.contact.hrProfiles.join(' '),
      job.contact.phone,
      job.contact.email,
      job.contact.assignedTo.join('; '),
      job.contact.remarks,
      ...(withReason ? [LEFT_OUT_REASONS[job.leftOutBy] ?? ''] : []),
      ...platforms.map((p) => job.links?.[p] ?? ''),
    ]
      .map(csvCell)
      .join(','),
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${{ nonfiltered: 'non-filtered-', all: 'all-' }[view] ?? ''}jobs-${range.custom ? (range.from === range.to ? range.from : `${range.from}-to-${range.to}`) : `${range.anchor}-${days}d`}.csv"`);
  res.send(`﻿${[header.join(','), ...lines].join('\r\n')}`);
}));

export default router;
