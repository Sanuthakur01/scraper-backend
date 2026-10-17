import express from 'express';
import { config } from '../config.js';
import { COURSES } from '../config/courses.js';
import { EXCLUDED_COMPANIES } from '../config/filters.js';
import { enabledSources } from '../config/sources.js';
import { CollectorRun, Job } from '../models.js';
import { SKILL_NAMES, phoneKey } from '../normalize.js';
import { groupByCompany, hiringPartners } from '../companies.js';
import { skillGaps } from '../skillGaps.js';
import { PHONE_EXISTS, PLACEMENT_STATUSES, findPhoneOwner, jobRow, manualRecord, parseFollowUpInput } from './followUp.js';

const router = express.Router();
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;
const IST = 'Asia/Kolkata';

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

// Days are IST calendar days ending on the day of the latest collection run, so the dashboard
// shows the latest daily update even before today's run has happened.
async function dayRange(days) {
  const run = await latestRun();
  const anchor = istDate(run?.startedAt ?? new Date());
  const end = new Date(istDayStart(anchor).getTime() + DAY_MS);
  const start = new Date(end.getTime() - days * DAY_MS);
  return { anchor, start, end, run };
}

const STATUS_LABELS = {
  contacted: 'Contacted',
  'cvs-sent': 'CVs sent',
  interview: 'Interview',
  placed: 'Placed',
  closed: 'Closed',
};

// status: a placement status, or 'any' for every job the team has a status on. Placement work goes on
// after a job is new, so with a status the period is ignored: all dates.
function jobFilter(query, { start, end }) {
  const status = query.status === 'any' || PLACEMENT_STATUSES.includes(query.status) ? query.status : null;
  const filter = status ? { 'manual.status': status === 'any' ? { $in: PLACEMENT_STATUSES } : status } : {};
  if (!status) filter.firstSeenAt = { $gte: start, $lt: end };
  if (query.course) filter.course = String(query.course);
  if (query.platform) filter.platforms = String(query.platform);
  if (query.city) filter.cities = String(query.city);
  if (query.exp) filter.experienceBand = String(query.exp);
  const search = String(query.q ?? '').trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ title: rx }, { company: rx }];
  }
  return filter;
}

const countBy = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]));

// Platforms searched now, plus any switched off that still have jobs in the window
// (so platform totals always add up to the overall total).
async function platformsInUse(match) {
  const searched = enabledSources(config.disabledSources).map((s) => s.platform);
  const inData = await Job.distinct('platforms', match);
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
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [run, cities, platforms] = await Promise.all([
    latestRun(),
    Job.aggregate([
      { $match: { firstSeenAt: { $gte: since } } },
      { $unwind: '$cities' },
      { $group: { _id: '$cities', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 60 },
    ]),
    platformsInUse({ firstSeenAt: { $gte: since } }),
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

// New jobs per course in the chosen window, plus the window before it for "vs previous".
router.get('/summary', wrap(async (req, res) => {
  const days = clampDays(req.query.days, 1, 90);
  const { anchor, start, end } = await dayRange(days);
  const prevStart = new Date(start.getTime() - days * DAY_MS);
  const byCourse = (from, to) =>
    Job.aggregate([
      { $match: { firstSeenAt: { $gte: from, $lt: to } } },
      { $group: { _id: '$course', count: { $sum: 1 } } },
    ]).then(countBy);
  const [current, previous] = await Promise.all([byCourse(start, end), byCourse(prevStart, start)]);
  res.json({ days, anchor, current, previous });
}));

// New jobs per platform and course. Each job counts once, under its primary platform.
router.get('/platforms', wrap(async (req, res) => {
  const days = clampDays(req.query.days, 1, 90);
  const range = await dayRange(days);
  const inRange = { firstSeenAt: { $gte: range.start, $lt: range.end } };
  const [rows, multiPlatform] = await Promise.all([
    Job.aggregate([
      { $match: inRange },
      { $group: { _id: { platform: '$primaryPlatform', course: '$course' }, count: { $sum: 1 } } },
    ]),
    Job.countDocuments({ ...inRange, 'platforms.1': { $exists: true } }),
  ]);
  const platforms = await platformsInUse(inRange);
  const result = platforms.map((platform) => {
    const byCourse = Object.fromEntries(COURSES.map((c) => [c.id, 0]));
    for (const r of rows) if (r._id.platform === platform) byCourse[r._id.course] = r.count;
    return { platform, byCourse, total: Object.values(byCourse).reduce((a, b) => a + b, 0) };
  });
  res.json({ days, anchor: range.anchor, multiPlatform, platforms: result.sort((a, b) => b.total - a.total) });
}));

// New jobs per IST day and course, with every day present (zeros included).
router.get('/trends', wrap(async (req, res) => {
  const days = clampDays(req.query.days, 30, 90);
  const range = await dayRange(days);
  const rows = await Job.aggregate([
    { $match: { firstSeenAt: { $gte: range.start, $lt: range.end } } },
    {
      $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$firstSeenAt', timezone: IST } }, course: '$course' },
        count: { $sum: 1 },
      },
    },
  ]);
  // Start on the first day we have data, so days before collection began don't show as zero.
  const first = await Job.findOne({}, { firstSeenAt: 1 }).sort({ firstSeenAt: 1 }).lean();
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
  res.json({ days, anchor: range.anchor, series });
}));

// Top companies, cities, experience levels and skills in the window.
router.get('/insights', wrap(async (req, res) => {
  const days = clampDays(req.query.days, 7, 90);
  const range = await dayRange(days);
  const match = jobFilter(req.query, range);
  const [facets] = await Job.aggregate([
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
          { $sort: { count: -1 } },
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
  // How old a posting was when our collector first found it.
  const ageHours = { $divide: [{ $subtract: ['$firstSeenAt', '$postedAt'] }, 3_600_000] };

  const [[facets], previous, platforms, oldest, storedTotal] = await Promise.all([
    Job.aggregate([
      { $match: match },
      {
        $facet: {
          total: [{ $count: 'n' }],
          counted: [{ $group: { _id: '$primaryPlatform', count: { $sum: 1 } } }],
          listed: [{ $unwind: '$platforms' }, { $group: { _id: '$platforms', count: { $sum: 1 } } }],
          multiPlatform: [{ $match: { 'platforms.1': { $exists: true } } }, { $count: 'n' }],
          postingAge: [
            {
              $group: {
                _id: {
                  $switch: {
                    branches: [
                      { case: { $not: [{ $ifNull: ['$postedAt', false] }] }, then: 'unknown' },
                      { case: { $lte: [ageHours, 24] }, then: 'day' },
                      { case: { $lte: [ageHours, 72] }, then: '3days' },
                      { case: { $lte: [ageHours, 168] }, then: 'week' },
                      { case: { $lte: [ageHours, 720] }, then: 'month' },
                    ],
                    default: 'older',
                  },
                },
                count: { $sum: 1 },
              },
            },
          ],
          experience: [{ $group: { _id: '$experienceBand', count: { $sum: 1 } } }],
          salaryShown: [{ $match: { salaryText: { $nin: [null, ''], $not: /not disclosed/i } } }, { $count: 'n' }],
          remote: [{ $match: { $or: [{ isRemote: true }, { cities: 'Remote' }] } }, { $count: 'n' }],
          foundRange: [{ $group: { _id: null, first: { $min: '$firstSeenAt' }, last: { $max: '$firstSeenAt' } } }],
          companies: top('company'),
          cities: top('cities'),
          skills: top('skills'),
        },
      },
    ]),
    Job.countDocuments({ course: course.id, firstSeenAt: { $gte: prevStart, $lt: range.start } }),
    platformsInUse(match),
    Job.findOne({ course: course.id }, { firstSeenAt: 1 }).sort({ firstSeenAt: 1 }).lean(),
    Job.countDocuments({ course: course.id }),
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
  const course = COURSES.find((c) => c.id === req.query.course);
  if (!course) return res.status(404).json({ error: 'Unknown course.' });
  const days = clampDays(req.query.days, 1, 90);
  const range = await dayRange(days);
  const match = { course: course.id, firstSeenAt: { $gte: range.start, $lt: range.end } };
  const [postings, platforms] = await Promise.all([
    Job.find(match, { _id: 0, skills: 1, firstSeenAt: 1 }).lean(),
    Job.distinct('platforms', match),
  ]);
  const seen = postings.map((p) => p.firstSeenAt.getTime());
  res.json({
    course: { id: course.id, name: course.name },
    days,
    anchor: range.anchor,
    teaches: course.teaches,
    ...skillGaps(postings, course.teaches),
    trackedSkillCount: SKILL_NAMES.length,
    source: {
      platforms: platforms.sort(),
      firstSeenFrom: seen.length ? new Date(Math.min(...seen)) : null,
      firstSeenTo: seen.length ? new Date(Math.max(...seen)) : null,
      lastRefreshed: range.run?.finishedAt ?? null,
    },
  });
}));

// ---------- Placements ----------

// Placement progress per course: jobs at each status now, and students placed this month and last
// month (IST calendar months, by the day each job was first marked placed).
router.get('/placements', wrap(async (req, res) => {
  const thisMonth = istDate(new Date()).slice(0, 7);
  const lastMonth = istDate(new Date(istDayStart(`${thisMonth}-01`).getTime() - DAY_MS)).slice(0, 7);
  const jobs = await Job.find({ 'manual.status': { $in: PLACEMENT_STATUSES } }, { course: 1, manual: 1 }).lean();
  const empty = () => ({ contacted: 0, cvsSent: 0, interview: 0, closed: 0, placedThisMonth: 0, placedLastMonth: 0, placedTotal: 0 });
  const rows = Object.fromEntries(COURSES.map((c) => [c.id, empty()]));
  const total = empty();
  const key = { contacted: 'contacted', 'cvs-sent': 'cvsSent', interview: 'interview', closed: 'closed' };
  for (const job of jobs) {
    const row = rows[job.course];
    if (!row) continue;
    const { status, placedCount = 1, placedAt } = job.manual;
    for (const r of [row, total]) {
      if (key[status]) r[key[status]]++;
      if (status !== 'placed') continue;
      r.placedTotal += placedCount;
      const month = placedAt ? istDate(placedAt).slice(0, 7) : null;
      if (month === thisMonth) r.placedThisMonth += placedCount;
      if (month === lastMonth) r.placedLastMonth += placedCount;
    }
  }
  res.json({ thisMonth, lastMonth, courses: COURSES.map((c) => ({ id: c.id, name: c.name, ...rows[c.id] })), total });
}));

// ---------- Weekly report ----------

// The job market report to share (dashboard Report page): the last 7 days up to the latest collection
// day, and the 7 days before for comparison. `comparable` is false until collection had already
// started when that earlier week began, so a half-empty week is never compared.
const REPORT_DAYS = 7;
const VAGUE_CITIES = ['India (city not stated)', 'Remote'];

router.get('/report', wrap(async (req, res) => {
  const range = await dayRange(REPORT_DAYS);
  const prevStart = new Date(range.start.getTime() - REPORT_DAYS * DAY_MS);
  const inRange = { firstSeenAt: { $gte: range.start, $lt: range.end } };
  const [[facets], previousRows, firstRun, platforms, companies] = await Promise.all([
    Job.aggregate([
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
    Job.aggregate([
      { $match: { firstSeenAt: { $gte: prevStart, $lt: range.start } } },
      { $group: { _id: '$course', count: { $sum: 1 } } },
    ]).then(countBy),
    CollectorRun.findOne({ status: { $in: ['success', 'partial'] } }, { startedAt: 1 }).sort({ startedAt: 1 }).lean(),
    Job.distinct('platforms', inRange),
    Job.find(inRange, { _id: 0, company: 1 }).lean(),
  ]);
  const comparable = Boolean(firstRun && firstRun.startedAt <= prevStart);
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
// PARTNER_DAYS days (large IT services firms never reach the database), with HR contacts and the
// team's placements with them. See companies.js.
const PARTNER_DAYS = 90;
const PARTNER_MIN_OPENINGS = 2;

async function partnerList() {
  const range = await dayRange(PARTNER_DAYS);
  const jobs = await Job.find(
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

router.get('/partners', wrap(async (req, res) => res.json(await partnerList())));

router.get('/partners.csv', wrap(async (req, res) => {
  const list = await partnerList();
  const header = ['Company', 'Openings', ...COURSES.map((c) => c.name), 'Cities', 'Last posted (IST)', 'HR phones', 'HR emails', 'In progress', 'Placed'];
  const lines = list.partners.map((p) =>
    [
      p.name,
      p.openings,
      ...COURSES.map((c) => p.courses[c.id] ?? 0),
      p.cities.join('; '),
      istDate(p.lastPosted),
      p.phones.join('; '),
      p.emails.join('; '),
      p.inProgress,
      p.placed,
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
  primaryPlatform: 1, platforms: 1, links: 1, foundPhones: 1, foundEmails: 1, manual: 1,
};
const JOB_SORT = { firstSeenAt: -1, postedAt: -1, _id: 1 };

router.get('/jobs', wrap(async (req, res) => {
  const days = clampDays(req.query.days, 1, 90);
  const range = await dayRange(days);
  const filter = jobFilter(req.query, range);
  const pageSize = Math.min(clampDays(req.query.limit, 25, 100), 100);
  const page = clampDays(req.query.page, 1, 100_000);
  const [items, total] = await Promise.all([
    Job.find(filter, JOB_FIELDS).sort(JOB_SORT).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Job.countDocuments(filter),
  ]);
  res.json({ days, anchor: range.anchor, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), items: items.map(jobRow) });
}));

// Saves what the team typed in for one job (HR phone, email, remarks; placement status, students,
// number placed) and returns the updated row. An empty field clears it; when everything is empty the
// job has no typed-in details (and shows what its postings say, if anything). The collector never
// writes these, so the next run can't undo them.
// A phone number another job already has is refused (409) with PHONE_EXISTS, and `detail` says which job.
router.put('/jobs/:id/follow-up', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const notFound = () => res.status(404).json({ error: 'Job not found. It may have been removed.' });
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return notFound();
  const input = parseFollowUpInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  const current = await Job.findById(req.params.id, { foundPhones: 1, manual: 1 }).lean();
  if (!current) return notFound();
  const owner = await findPhoneOwner(input.value.phoneKeys, current);
  if (owner) {
    const number = input.value.phone.split(', ').find((p) => phoneKey(p) === owner.key);
    const where = `"${owner.job.title}"${owner.job.company ? ` at ${owner.job.company}` : ''}`;
    return res.status(409).json({ error: PHONE_EXISTS, detail: `${number} is already saved on ${where}.` });
  }

  const record = manualRecord(input.value, current.manual, new Date());
  const update = record ? { $set: { manual: record } } : { $unset: { manual: 1 } };
  const job = await Job.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after', projection: JOB_FIELDS }).lean();
  if (!job) return notFound();
  res.json(jobRow(job));
}));

const istDateTime = (date) => (date ? new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ') : '');
const experienceLabel = (job) =>
  job.experienceMin == null ? job.experienceText || '' : job.experienceMax != null ? `${job.experienceMin}-${job.experienceMax} yrs` : `${job.experienceMin}+ yrs`;

router.get('/jobs.csv', wrap(async (req, res) => {
  const days = clampDays(req.query.days, 1, 90);
  const range = await dayRange(days);
  const jobs = await Job.find(jobFilter(req.query, range), JOB_FIELDS).sort(JOB_SORT).limit(10_000).lean();
  const courseName = Object.fromEntries(COURSES.map((c) => [c.id, c.name]));
  const platforms = await platformsInUse({ firstSeenAt: { $gte: range.start, $lt: range.end } });
  const header = [
    'First seen (IST)', 'Posted (IST)', 'Course', 'Title', 'Company', 'Cities', 'Experience', 'Salary', 'Listed on',
    'Phone', 'Email', 'Remarks', 'Placement status', 'Students', 'Placed', ...platforms.map((p) => `${p} link`),
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
      job.contact.remarks,
      STATUS_LABELS[job.placement.status] ?? '',
      job.placement.students,
      job.placement.placedCount || '',
      ...platforms.map((p) => job.links?.[p] ?? ''),
    ]
      .map(csvCell)
      .join(','),
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="jobs-${range.anchor}-${days}d.csv"`);
  res.send(`﻿${[header.join(','), ...lines].join('\r\n')}`);
}));

export default router;
