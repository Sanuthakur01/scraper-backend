import mongoose from 'mongoose';
import express from 'express';
import { config } from '../config.js';
import { COURSES } from '../config/courses.js';
import { EXCLUDED_COMPANIES } from '../config/filters.js';
import { enabledSources } from '../config/sources.js';
import { Activity, CollectorRun, Job, NonFilteredJob } from '../models.js';
import { contactChanges, overallAction } from '../activity.js';
import { requirePermission } from '../auth.js';
import { SKILL_NAMES, phoneKey } from '../normalize.js';
import { hiringPartners } from '../companies.js';
import { skillGaps, skillPlan } from '../skillGaps.js';
import { PHONE_EXISTS, contactView, findPhoneOwner, jobRow, manualRecord, parseFollowUpInput } from './followUp.js';

const router = express.Router();
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;
const IST = 'Asia/Kolkata';

// Which jobs a request reads: the kept (filtered) jobs, or with ?view=nonfiltered the jobs the keep rules
// leave out (NonFilteredJob). Every route that reads jobs uses this, so the dashboard's Filtered /
// Non-filtered switch changes every number and list the same way.
const jobsFor = (req) => (req.query.view === 'nonfiltered' ? NonFilteredJob : Job);

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

// A period is compared with the one before only when a collection ran on every IST day of both (any
// finished run). A day without a run has almost no new jobs, and the next run's count then holds two
// days, so comparing would show a huge jump that didn't happen ("+5900% vs previous day"). Days
// before the daily collection began have no runs, so they are never compared either.
async function collectedEveryDay(from, to) {
  const runs = await CollectorRun.find({ status: { $in: ['success', 'partial'] }, startedAt: { $gte: from, $lt: to } }, { startedAt: 1 }).lean();
  const collected = new Set(runs.map((run) => istDate(run.startedAt)));
  for (let day = from.getTime(); day < to.getTime(); day += DAY_MS) {
    if (!collected.has(istDate(new Date(day)))) return false;
  }
  return true;
}

// Days are IST calendar days ending on the day of the latest collection run, so the dashboard
// shows the latest daily update even before today's run has happened.
async function dayRange(days) {
  const run = await latestRun();
  const anchor = istDate(run?.startedAt ?? new Date());
  const end = new Date(istDayStart(anchor).getTime() + DAY_MS);
  const start = new Date(end.getTime() - days * DAY_MS);
  return { anchor, start, end, run };
}

// Used both to count what the dashboard shows (cards, charts) and to list the jobs behind a number
// (the job list's filters below), so a number and its list always agree.
const ON_SEVERAL_SITES = { 'platforms.1': { $exists: true } };
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
    const run = await latestRun();
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
  const search = String(query.q ?? '').trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ title: rx }, { company: rx }, { 'manual.assignedTo': rx }]; // a student's name finds the jobs assigned to them
  }
  return filter;
}

const countBy = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]));

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
    // The days jobs are stored for (oldest to newest): what a custom period can choose from.
    dataDays: { first: oldest ? istDate(oldest.firstSeenAt) : null, last: newestDay > lastRunDay ? newestDay : lastRunDay },
    demo: config.demo,
  });
}));

// New jobs per course in the chosen window, plus the window before it for "vs previous" (empty when
// the two can't be compared fairly: see collectedEveryDay).
router.get('/summary', wrap(async (req, res) => {
  const J = jobsFor(req);
  const { days, anchor, start, end, from, to } = await periodRange(req.query, 1);
  const prevStart = new Date(start.getTime() - days * DAY_MS);
  const byCourse = (from, to) =>
    J.aggregate([
      { $match: { firstSeenAt: { $gte: from, $lt: to } } },
      { $group: { _id: '$course', count: { $sum: 1 } } },
    ]).then(countBy);
  const [current, previous, comparable] = await Promise.all([byCourse(start, end), byCourse(prevStart, start), collectedEveryDay(prevStart, end)]);
  res.json({ days, anchor, from, to, current, previous: comparable ? previous : {}, comparable });
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
        companies: [
          { $match: { company: { $nin: [null, ''] } } },
          { $group: { _id: '$company', count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: 10 },
        ],
        cities: [
          { $unwind: '$cities' },
          { $group: { _id: '$cities', count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: 10 },
        ],
        experience: [{ $group: { _id: '$experienceBand', count: { $sum: 1 } } }],
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
  const toList = (rows) => rows.map((r) => ({ name: r._id, count: r.count }));
  res.json({
    days,
    anchor: range.anchor,
    from: range.from,
    to: range.to,
    total: facets.total[0]?.n ?? 0,
    companies: toList(facets.companies),
    cities: toList(facets.cities),
    experience: countBy(facets.experience),
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
          remote: [{ $match: { $or: [{ isRemote: true }, { cities: 'Remote' }] } }, { $count: 'n' }],
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
    remote: n(facets.remote),
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

// ---------- Job lists ----------

const JOB_FIELDS = {
  title: 1, company: 1, course: 1, cities: 1, isRemote: 1, experienceMin: 1, experienceMax: 1,
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
  // withContact: how many of these jobs have an HR phone, email or note (typed in, or found in the post).
  // An HR phone, email or note (typed in, or found in the posting). Students assigned alone don't count.
  const typed = (field) => ({ [`manual.${field}`]: { $nin: [null, ''] } });
  const hasContact = { $or: [typed('phone'), typed('email'), typed('remarks'), { 'foundPhones.0': { $exists: true } }, { 'foundEmails.0': { $exists: true } }] };
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
  const record = manualRecord(input.value, now);
  const update = record ? { $set: { manual: record } } : { $unset: { manual: 1 } };

  // What the dashboard shows before and after this save; nothing changed (e.g. saved as it was): no record.
  const changes = contactChanges(contactView(current), contactView({ ...current, manual: record ?? undefined }));
  // The record is written first, so a change is never saved without one. If the save then fails, the
  // record goes again.
  const entry = changes.length
    ? await Activity.create({
        at: now,
        actor: req.person,
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
// record: one row per number or email a person added, with when and on which job. A number only
// written differently, or one the job's posting already had, isn't one (see activity.js). The
// dashboard groups the rows person → course → company → job. Signed-in people with an allowed role.
const CONTACT_FIELDS = ['phone', 'email'];
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
  res.json({
    days: range.days,
    from: range.from,
    to: range.to,
    since: first?.at ?? null, // when the activity record began: nothing before it can be counted
    rows: rows.slice(0, MAX_PERFORMANCE_ROWS),
    truncated: rows.length > MAX_PERFORMANCE_ROWS,
  });
}));

// A non-filtered job's leftOutBy, in words.
const LEFT_OUT_REASONS = {
  'big-company': 'Large IT services firm',
  experience: 'Asks for less experience than the minimum',
  'no-experience': 'Experience not stated',
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
  const nonFiltered = req.query.view === 'nonfiltered';
  const header = [
    'First seen (IST)', 'Posted (IST)', 'Course', 'Title', 'Company', 'Cities', 'Experience', 'Salary', 'Listed on',
    'Phone', 'Email', 'Assigned to', 'Remarks', ...(nonFiltered ? ['Left out because'] : []), ...platforms.map((p) => `${p} link`),
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
      job.contact.phone,
      job.contact.email,
      job.contact.assignedTo.join('; '),
      job.contact.remarks,
      ...(nonFiltered ? [LEFT_OUT_REASONS[job.leftOutBy] ?? ''] : []),
      ...platforms.map((p) => job.links?.[p] ?? ''),
    ]
      .map(csvCell)
      .join(','),
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${nonFiltered ? 'non-filtered-' : ''}jobs-${range.custom ? (range.from === range.to ? range.from : `${range.from}-to-${range.to}`) : `${range.anchor}-${days}d`}.csv"`);
  res.send(`﻿${[header.join(','), ...lines].join('\r\n')}`);
}));

export default router;
