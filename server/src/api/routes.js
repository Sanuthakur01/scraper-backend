import express from 'express';
import { config } from '../config.js';
import { COURSES } from '../config/courses.js';
import { EXCLUDED_COMPANIES } from '../config/filters.js';
import { enabledSources } from '../config/sources.js';
import { CollectorRun, Job, NonFilteredJob } from '../models.js';
import { SKILL_NAMES, phoneKey } from '../normalize.js';
import { groupByCompany, hiringPartners } from '../companies.js';
import { skillGaps, skillPlan } from '../skillGaps.js';
import { PHONE_EXISTS, findPhoneOwner, jobRow, manualRecord, parseFollowUpInput } from './followUp.js';

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

function jobFilter(query, { start, end }) {
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
  const [run, cities, platforms] = await Promise.all([
    latestRun(),
    J.aggregate([
      { $match: { firstSeenAt: { $gte: since } } },
      { $unwind: '$cities' },
      { $group: { _id: '$cities', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 60 },
    ]),
    platformsInUse({ firstSeenAt: { $gte: since } }, J),
  ]);
  res.json({
    courses: COURSES.map(({ id, name }) => ({ id, name })),
    platforms,
    cities: cities.map((c) => c._id).sort((a, b) => a.localeCompare(b)),
    scheduleLabel: config.scheduleLabel,
    // The rules jobs must pass to be kept (config/filters.js), shown on the dashboard.
    filters: { experience: config.experience, excludedCompanies: EXCLUDED_COMPANIES },
    lastRun: runSummary(run),
    demo: config.demo,
  });
}));

// New jobs per course in the chosen window, plus the window before it for "vs previous" (empty when
// the two can't be compared fairly: see collectedEveryDay).
router.get('/summary', wrap(async (req, res) => {
  const J = jobsFor(req);
  const days = clampDays(req.query.days, 1, 90);
  const { anchor, start, end } = await dayRange(days);
  const prevStart = new Date(start.getTime() - days * DAY_MS);
  const byCourse = (from, to) =>
    J.aggregate([
      { $match: { firstSeenAt: { $gte: from, $lt: to } } },
      { $group: { _id: '$course', count: { $sum: 1 } } },
    ]).then(countBy);
  const [current, previous, comparable] = await Promise.all([byCourse(start, end), byCourse(prevStart, start), collectedEveryDay(prevStart, end)]);
  res.json({ days, anchor, current, previous: comparable ? previous : {}, comparable });
}));

// New jobs per platform and course. Each job counts once, under its primary platform.
router.get('/platforms', wrap(async (req, res) => {
  const J = jobsFor(req);
  const days = clampDays(req.query.days, 1, 90);
  const range = await dayRange(days);
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
  res.json({ days, anchor: range.anchor, multiPlatform, platforms: result.sort((a, b) => b.total - a.total) });
}));

// New jobs per IST day and course, with every day present (zeros included).
router.get('/trends', wrap(async (req, res) => {
  const J = jobsFor(req);
  const days = clampDays(req.query.days, 30, 90);
  const range = await dayRange(days);
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
  res.json({ days, anchor: range.anchor, series, backfilledBefore });
}));

// Top companies, cities, experience levels and skills in the window.
router.get('/insights', wrap(async (req, res) => {
  const J = jobsFor(req);
  const days = clampDays(req.query.days, 7, 90);
  const range = await dayRange(days);
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
  const days = clampDays(req.query.days, 1, 90);
  const range = await dayRange(days);
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
  const days = clampDays(req.query.days, 1, 90);
  const range = await dayRange(days);
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

// ---------- Weekly report ----------

// The job market report to share (dashboard Report page): the last 7 days up to the latest collection
// day, and the 7 days before for comparison. `comparable` is false until collection had already
// started when that earlier week began, so a half-empty week is never compared.
const REPORT_DAYS = 7;
const VAGUE_CITIES = ['India (city not stated)', 'Remote'];

router.get('/report', wrap(async (req, res) => {
  const J = jobsFor(req);
  const range = await dayRange(REPORT_DAYS);
  const prevStart = new Date(range.start.getTime() - REPORT_DAYS * DAY_MS);
  const inRange = { firstSeenAt: { $gte: range.start, $lt: range.end } };
  const [[facets], previousRows, comparable, platforms, companies] = await Promise.all([
    J.aggregate([
      { $match: inRange },
      {
        $facet: {
          courses: [{ $group: { _id: '$course', count: { $sum: 1 } } }],
          skills: [
            { $unwind: '$skills' },
            { $group: { _id: { course: '$course', skill: '$skills' }, count: { $sum: 1 } } },
            { $sort: { count: -1, '_id.skill': 1 } },
          ],
          cities: [
            { $unwind: '$cities' },
            { $match: { cities: { $nin: VAGUE_CITIES } } },
            { $group: { _id: '$cities', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 5 },
          ],
        },
      },
    ]),
    J.aggregate([
      { $match: { firstSeenAt: { $gte: prevStart, $lt: range.start } } },
      { $group: { _id: '$course', count: { $sum: 1 } } },
    ]).then(countBy),
    collectedEveryDay(prevStart, range.end),
    J.distinct('platforms', inRange),
    J.find(inRange, { _id: 0, company: 1 }).lean(),
  ]);
  const current = countBy(facets.courses);
  const toList = (rows) => rows.map((r) => ({ name: r._id, count: r.count }));
  res.json({
    from: istDate(range.start),
    to: istDate(new Date(range.end.getTime() - DAY_MS)),
    total: Object.values(current).reduce((a, b) => a + b, 0),
    comparable,
    courses: COURSES.map((c) => ({
      id: c.id,
      name: c.name,
      count: current[c.id] ?? 0,
      previous: comparable ? (previousRows[c.id] ?? 0) : null,
      skills: facets.skills.filter((s) => s._id.course === c.id).slice(0, 3).map((s) => s._id.skill),
    })),
    companies: groupByCompany(companies)
      .map((g) => ({ name: g.name, count: g.jobs.length }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 5),
    cities: toList(facets.cities),
    platforms: platforms.sort(),
    experience: config.experience,
    brand: config.brandName,
    lastRefreshed: range.run?.finishedAt ?? null,
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
  const days = clampDays(req.query.days, 1, 90);
  const range = await dayRange(days);
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
router.put('/jobs/:id/follow-up', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const notFound = () => res.status(404).json({ error: 'Job not found. It may have been removed.' });
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return notFound();
  const input = parseFollowUpInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  // A kept job, or a non-filtered one (ids are unique across both).
  let model = Job;
  let current = await Job.findById(req.params.id, { foundPhones: 1, manual: 1 }).lean();
  if (!current) {
    model = NonFilteredJob;
    current = await NonFilteredJob.findById(req.params.id, { foundPhones: 1, manual: 1 }).lean();
  }
  if (!current) return notFound();
  const owner = await findPhoneOwner(input.value.phoneKeys, current);
  if (owner) {
    const number = input.value.phone.split(', ').find((p) => phoneKey(p) === owner.key);
    const where = `"${owner.job.title}"${owner.job.company ? ` at ${owner.job.company}` : ''}`;
    return res.status(409).json({ error: PHONE_EXISTS, detail: `${number} is already saved on ${where}.` });
  }

  const record = manualRecord(input.value, new Date());
  const update = record ? { $set: { manual: record } } : { $unset: { manual: 1 } };
  const job = await model.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after', projection: JOB_FIELDS }).lean();
  if (!job) return notFound();
  res.json(jobRow(job));
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
  const days = clampDays(req.query.days, 1, 90);
  const range = await dayRange(days);
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
  res.set('Content-Disposition', `attachment; filename="${nonFiltered ? 'non-filtered-' : ''}jobs-${range.anchor}-${days}d.csv"`);
  res.send(`﻿${[header.join(','), ...lines].join('\r\n')}`);
}));

export default router;
