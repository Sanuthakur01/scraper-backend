// What IJF AI can look up and propose (OpenAI "tools"). Each runs the dashboard's own route code in-process
// (callRoute), so the chat's numbers are always the dashboard's numbers. Results go to OpenAI only after
// privacy.js has replaced every phone number and email; the real values reach the person in cards.
// Nothing here changes data: a change is only proposed (a card with Confirm), and done when confirmed.

import { COURSES } from '../config/courses.js';
import { experienceRangeText } from '../config/filters.js';
import { routeHandlers } from '../api/routes.js';
import { contactView, findPhoneOwner, parseFollowUpInput, PHONE_EXISTS } from '../api/followUp.js';
import { ContactOutcome, Job, NonFilteredJob } from '../models.js';
import { shownCities } from '../normalize.js';
import { contactKey, parseOutcomeInput, REMARKS, remarkLabel } from '../outcomes.js';
import { reveal } from './privacy.js';

// A number with no remark at all, or one of whose students hasn't said how their call went (the report's
// "No remark yet").
export const needsRemark = (row) => !row.outcomes.some((o) => o.status) || row.outcomes.some((o) => o.student && !o.status);

const COURSE_IDS = COURSES.map((c) => c.id);
const courseName = (id) => COURSES.find((c) => c.id === id)?.name ?? id ?? '';
// { 'data-analyst': 3 } -> { 'Data Analyst': 3 }
const byCourseName = (counts = {}) => Object.fromEntries(Object.entries(counts).map(([id, n]) => [courseName(id), n]));
const split = (value) => String(value ?? '').split(/\s*,\s*/).filter(Boolean);
const DAY_MS = 86_400_000;

// Runs one of the API's routes in-process (same code, same checks, same numbers as the dashboard).
export function callRoute(method, path, { query = {}, params = {}, body, person, via } = {}) {
  const handler = routeHandlers.get(`${method} ${path}`);
  if (!handler) return Promise.reject(new Error(`No route ${method} ${path}`));
  const q = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(code) {
        status = code;
        return res;
      },
      set() {
        return res;
      },
      json(data) {
        if (status >= 400) reject(Object.assign(new Error(data?.error ?? `Error ${status}`), { status, detail: data?.detail ?? '' }));
        else resolve(data);
      },
      send(data) {
        resolve(data);
      },
    };
    handler({ query: q, params, body, person, via }, res, (err) => reject(err ?? new Error('No answer')));
  });
}

// ---------- the period, view and course a tool is asked about ----------

const PERIOD = {
  days: { type: 'integer', description: 'The last N days (1 = the latest day). Use 1, 7 or 30 unless the person asks for something else.' },
  from: { type: 'string', description: 'First day, YYYY-MM-DD (India time), for a chosen day or range (with to).' },
  to: { type: 'string', description: 'Last day, YYYY-MM-DD, included.' },
};
const VIEW = {
  view: {
    type: 'string',
    enum: ['filtered', 'nonfiltered', 'all'],
    description: `filtered (default): the kept jobs (${experienceRangeText()} years, no big IT services firms). nonfiltered: the jobs those rules leave out (fresher jobs too). all: both together.`,
  },
};
const COURSE = { course: { type: 'string', enum: COURSE_IDS, description: `The course: ${COURSES.map((c) => `${c.id} = ${c.name}`).join(', ')}.` } };

// Period: what the tool was given, or the page the person is on, or the latest day.
function periodOf(args, ctx) {
  if (args.from) return { from: args.from, to: args.to || args.from };
  if (args.days) return { days: Math.min(Math.max(Number(args.days) || 1, 1), 366) };
  const page = ctx.context?.period ?? {};
  if (page.from) return { from: page.from, to: page.to || page.from };
  return { days: page.days || 1 };
}
const viewOf = (args, ctx) => {
  const view = args.view ?? ctx.context?.view;
  return view === 'nonfiltered' || view === 'all' ? view : undefined;
};
const courseOf = (value) => {
  if (!value) return undefined;
  const found = COURSES.find((c) => c.id === value || c.name.toLowerCase() === String(value).toLowerCase());
  if (!found) throw new Error(`Unknown course "${value}". Courses: ${COURSE_IDS.join(', ')}.`);
  return found.id;
};
const periodWords = (r) => ({ from: r.from, to: r.to, days: r.days });

// A job as the AI sees it (contacts as numbers of each; the real ones only in cards).
const jobBrief = (job) => ({
  id: job._id,
  title: job.title,
  company: job.company || '',
  course: courseName(job.course),
  cities: shownCities(job.cities),
  experience: job.experienceMin == null ? job.experienceText || 'not stated' : job.experienceMax != null ? `${job.experienceMin}-${job.experienceMax} yrs` : `${job.experienceMin}+ yrs`,
  salary: job.salaryText || '',
  sites: job.platforms,
  postedAt: job.postedAt ?? null,
  foundAt: job.firstSeenAt,
  hrDetails: {
    hrNames: job.contact?.hrNames ?? [],
    phones: split(job.contact?.phone).length,
    emails: split(job.contact?.email).length,
    students: job.contact?.assignedTo ?? [],
    note: job.contact?.remarks || '',
  },
});

// A job's HR contacts for a card (real values: the card goes only to the person's screen).
const contactCard = (job) => ({
  id: job._id,
  title: job.title,
  company: job.company || '',
  course: job.course,
  set: job.leftOutBy ? 'nonfiltered' : 'filtered',
  hrNames: job.contact?.hrNames ?? [],
  hrProfiles: job.contact?.hrProfiles ?? [],
  phones: split(job.contact?.phone),
  emails: split(job.contact?.email),
  fromPost: { phone: job.contact?.phoneSource === 'posting', email: job.contact?.emailSource === 'posting' },
  students: job.contact?.assignedTo ?? [],
});

// The job list on a course page with these filters (the "Show in job list" link of a jobs card).
const JOB_FILTER_KEYS = ['company', 'city', 'platform', 'primary', 'skill', 'exp', 'sites', 'salary', 'q', 'hr'];
function jobListHref(course, period, filters) {
  const params = new URLSearchParams(period.from ? { from: period.from, to: period.to } : { days: String(period.days) });
  for (const key of JOB_FILTER_KEYS) if (filters[key]) params.set(key, filters[key]);
  return `/course/${course}?${params}`;
}

async function findJob(id) {
  if (!/^[a-f\d]{24}$/i.test(String(id ?? ''))) throw new Error('job_id must be a job id from a search.');
  const fields = { title: 1, company: 1, course: 1, foundPhones: 1, foundEmails: 1, manual: 1, leftOutBy: 1 };
  const job = (await Job.findById(id, fields).lean()) ?? (await NonFilteredJob.findById(id, fields).lean());
  if (!job) throw new Error('That job is no longer stored.');
  return job;
}

// ---------- the tools ----------

const tool = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const TOOLS = [
  tool('get_summary', 'New jobs per course in a period, and the same number of days just before (when both were fully collected).', { ...PERIOD, ...VIEW }),
  tool('get_sources', 'Which sites (LinkedIn, Naukri, Indeed, Glassdoor) the new jobs came from, per course.', { ...PERIOD, ...VIEW }),
  tool('get_daily_trend', 'New jobs per day for the last N days (up to 90), per course.', { days: PERIOD.days, ...COURSE, ...VIEW }),
  tool('get_insights', 'Top hiring companies, cities, experience levels and most requested skills in a period (optionally one course).', { ...PERIOD, ...VIEW, ...COURSE }),
  tool('get_course', "Everything on a course's page: new jobs and the period before, sites, how old the posts were, experience, salary shown, top companies, cities and skills.", { ...COURSE, ...PERIOD, ...VIEW }, ['course']),
  tool(
    'search_jobs',
    'Search the stored jobs. Returns the total and up to `limit` jobs (newest first) with their HR details counts. Also shows the person a card with the jobs and a link to the job list.',
    {
      ...COURSE,
      ...PERIOD,
      ...VIEW,
      q: { type: 'string', description: 'Words in the job title or company, or a student or HR name.' },
      company: { type: 'string', description: 'Exact company name (as in get_insights).' },
      city: { type: 'string' },
      platform: { type: 'string', description: 'Listed on this site: LinkedIn, Naukri, Indeed or Glassdoor.' },
      skill: { type: 'string', description: 'A skill, e.g. SQL, Power BI, Python.' },
      exp: { type: 'string', enum: ['fresher', '1', '2', '3', '4', '5', '5+', 'unknown'], description: "Minimum years asked ('5+' = more than 5)." },
      sites: { type: 'string', enum: ['2'], description: "'2': listed on two or more sites." },
      salary: { type: 'string', enum: ['shown'], description: "'shown': the post shows a salary." },
      hr: { type: 'string', enum: ['none', 'some'], description: "'none': no HR details yet; 'some': has HR details." },
      limit: { type: 'integer', description: 'How many jobs to return (1-20, default 10).' },
    },
  ),
  tool('get_job', "One job's details: title, company, course, cities, experience, salary, sites, dates, and its HR details (names, numbers, emails as stand-ins, students, notes, follow-ups).", { job_id: { type: 'string' } }, ['job_id']),
  tool(
    'show_contacts',
    "Show the person the HR contacts (names, profile links, phone numbers, emails) of one job, or of a company's jobs (up to 5), in a card on their screen. Use whenever they ask for contacts.",
    { job_id: { type: 'string' }, company: { type: 'string', description: 'Company name, when there is no job_id.' } },
  ),
  tool('get_skill_gaps', "The skill planner for a course: which skills the course doesn't teach would match the most extra job posts, in order.", { ...COURSE, ...PERIOD, ...VIEW }, ['course']),
  tool('get_partners', 'Hiring partners: companies with 2+ openings in the last 90 days, their openings, courses, cities and HR contacts.', { ...VIEW, q: { type: 'string', description: 'Part of a company name.' }, limit: { type: 'integer', description: '1-25, default 10.' } }),
  tool(
    'get_performance',
    "The performance report: how many HR phone numbers and emails each person added in a period (days end today), on how many jobs, and their follow-up (given to a student, remark). Counts only.",
    { ...PERIOD, ...COURSE, person: { type: 'string', description: 'Part of a staff name.' } },
  ),
  tool(
    'list_follow_ups',
    'The HR numbers and emails added in a period with their follow-up: the student each was given to and its remark. Filter by status. Also shows the person a card with them.',
    {
      days: { type: 'integer', description: 'Added in the last N days, ending today (default 30).' },
      status: { type: 'string', enum: ['all', 'no-remark', 'unassigned', ...Object.keys(REMARKS)], description: "'no-remark', 'unassigned' (no student), or one remark." },
      older_than_days: { type: 'integer', description: 'Only those added at least this many days ago.' },
      ...COURSE,
      person: { type: 'string', description: 'Added by (part of a staff name).' },
      limit: { type: 'integer', description: '1-30, default 15.' },
    },
  ),
  tool(
    'get_activity',
    'The activity record: who added, changed or removed which HR details, students and follow-ups, and when. Newest first.',
    {
      days: { type: 'integer', description: 'Only the last N days.' },
      action: { type: 'string', enum: ['added', 'edited', 'removed'] },
      q: { type: 'string', description: 'Words in the job title or company.' },
      person: { type: 'string', description: 'Part of a staff name.' },
      limit: { type: 'integer', description: '1-20, default 10.' },
    },
  ),
  tool('get_collection_status', 'The latest daily collection: when it ran, whether it worked, new jobs per site, and any searches that failed.'),
  tool(
    'propose_hr_details',
    "Propose adding HR details to a job: phone numbers, emails, HR names, HR profile links, students, a note. Nothing is saved until the person clicks Confirm on the card. Use stand-ins such as [phone 1] exactly as given.",
    {
      job_id: { type: 'string' },
      phones: { type: 'array', items: { type: 'string' } },
      emails: { type: 'array', items: { type: 'string' } },
      hr_names: { type: 'array', items: { type: 'string' } },
      hr_profiles: { type: 'array', items: { type: 'string' } },
      students: { type: 'array', items: { type: 'string' } },
      note: { type: 'string', description: "Added under the job's notes." },
    },
    ['job_id'],
  ),
  tool(
    'propose_follow_up',
    "Propose a follow-up for one of a job's HR numbers or emails: give it to a student (a number can go to several students), take it back from one, or the remark of a student's call (each student's call has its own). Nothing is saved until the person clicks Confirm on the card.",
    {
      job_id: { type: 'string' },
      contact: { type: 'string', description: 'The number or email, as its stand-in, e.g. [phone 2].' },
      student: { type: 'string', description: "The student's name: given the number, or whose call the remark is about ('' with a remark: the number's own, while no student has it)." },
      take_back: { type: 'boolean', description: 'true: take the number back from this student (their remark goes with it).' },
      remark: { type: 'string', enum: ['', ...Object.keys(REMARKS)], description: `${Object.entries(REMARKS).map(([id, label]) => `${id} = ${label}`).join('; ')}; '' to clear.` },
      note: { type: 'string', description: 'The words of an "other" remark.' },
    },
    ['job_id', 'contact'],
  ),
];

// What the screen shows while a tool runs.
export const TOOL_STATUS = {
  get_summary: 'Counting new jobs',
  get_sources: 'Checking the sites',
  get_daily_trend: 'Looking at the days',
  get_insights: 'Finding top companies and skills',
  get_course: 'Opening the course',
  search_jobs: 'Searching jobs',
  get_job: 'Opening the job',
  show_contacts: 'Getting HR contacts',
  get_skill_gaps: 'Planning skills',
  get_partners: 'Checking hiring partners',
  get_performance: 'Checking the performance report',
  list_follow_ups: 'Checking follow-ups',
  get_activity: 'Checking the activity record',
  get_collection_status: 'Checking the last collection',
  propose_hr_details: 'Preparing the change',
  propose_follow_up: 'Preparing the change',
};

const RUN = {
  async get_summary(args, ctx) {
    const r = await callRoute('GET', '/summary', { query: { ...periodOf(args, ctx), view: viewOf(args, ctx) } });
    const total = Object.values(r.current).reduce((a, b) => a + b, 0);
    return {
      period: periodWords(r),
      view: viewOf(args, ctx) ?? 'filtered',
      total,
      perCourse: COURSES.map((c) => ({ course: c.name, newJobs: r.current[c.id] ?? 0, periodBefore: r.comparable ? (r.previous[c.id] ?? 0) : null })),
      comparedWithPeriodBefore: r.comparable,
      latestCollectionDay: r.anchor,
    };
  },

  async get_sources(args, ctx) {
    const r = await callRoute('GET', '/platforms', { query: { ...periodOf(args, ctx), view: viewOf(args, ctx) } });
    return {
      period: periodWords(r),
      sites: r.platforms.map((p) => ({ site: p.platform, newJobs: p.total, perCourse: Object.fromEntries(Object.entries(p.byCourse).map(([id, n]) => [courseName(id), n])) })),
      listedOnTwoOrMoreSites: r.multiPlatform,
    };
  },

  async get_daily_trend(args, ctx) {
    const days = Math.min(Math.max(Number(args.days) || 30, 1), 90);
    const r = await callRoute('GET', '/trends', { query: { days, view: viewOf(args, ctx) } });
    const course = courseOf(args.course);
    return {
      days: r.series.map((p) => ({ day: p.day, ...(course ? { [courseName(course)]: p[course] } : { total: COURSE_IDS.reduce((n, id) => n + (p[id] ?? 0), 0), ...Object.fromEntries(COURSE_IDS.map((id) => [courseName(id), p[id] ?? 0])) }) })),
      backfilledBefore: r.backfilledBefore,
    };
  },

  async get_insights(args, ctx) {
    const r = await callRoute('GET', '/insights', { query: { ...periodOf(args, ctx), view: viewOf(args, ctx), course: courseOf(args.course) } });
    return {
      period: periodWords(r),
      jobs: r.total,
      topCompanies: r.companies.map((c) => ({ ...c, byCourse: byCourseName(c.byCourse) })),
      topCities: r.cities.map((c) => ({ ...c, byCourse: byCourseName(c.byCourse) })),
      experience: r.experience,
      topSkills: Object.fromEntries(Object.entries(r.skills).map(([id, list]) => [courseName(id), list])),
    };
  },

  async get_course(args, ctx) {
    const course = courseOf(args.course);
    const r = await callRoute('GET', '/course/:id', { params: { id: course }, query: { ...periodOf(args, ctx), view: viewOf(args, ctx) } });
    return {
      course: r.course.name,
      period: periodWords(r),
      newJobs: r.total,
      periodBefore: r.previous,
      sites: r.platforms,
      listedOnTwoOrMoreSites: r.multiPlatform,
      postAgeWhenFound: r.postingAge,
      experience: r.experience,
      salaryShown: r.salaryShown,
      topCompanies: r.companies,
      topCities: r.cities,
      topSkills: r.skills,
      link: jobListHref(course, periodOf(args, ctx), {}),
    };
  },

  async search_jobs(args, ctx) {
    const course = courseOf(args.course);
    const period = periodOf(args, ctx);
    const view = viewOf(args, ctx);
    const filters = Object.fromEntries(JOB_FILTER_KEYS.map((k) => [k, args[k] ? String(args[k]) : '']));
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
    const r = await callRoute('GET', '/jobs', { query: { ...period, view, course, ...filters, limit } });
    // Per course, for "Show in job list" (each course has its own list).
    const courses = course ? [course] : COURSE_IDS;
    const counts = course
      ? { [course]: r.total }
      : Object.fromEntries(await Promise.all(courses.map(async (id) => [id, (await callRoute('GET', '/jobs', { query: { ...period, view, course: id, ...filters, limit: 1 } })).total])));
    ctx.cards.push({
      type: 'jobs',
      total: r.total,
      withHrDetails: r.withContact,
      period: periodWords(r),
      view: view ?? 'filtered',
      // Each job's own set (in the All view a left-out job is the one with a reason).
      items: r.items.slice(0, 10).map((j) => ({ id: j._id, title: j.title, company: j.company || '', course: j.course, cities: shownCities(j.cities), set: (view === 'all' ? (j.leftOutBy ? 'nonfiltered' : 'filtered') : view) ?? 'filtered' })),
      links: Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([id, n]) => ({ label: `${courseName(id)} · ${n}`, href: jobListHref(id, period, filters), view: view ?? 'filtered' })),
    });
    return { period: periodWords(r), total: r.total, withHrDetails: r.withContact, perCourse: Object.fromEntries(Object.entries(counts).map(([id, n]) => [courseName(id), n])), jobs: r.items.map(jobBrief) };
  },

  async get_job(args) {
    const r = await callRoute('GET', '/jobs', { query: { id: args.job_id, days: 1 } });
    const job = r.items[0] ?? (await callRoute('GET', '/jobs', { query: { id: args.job_id, days: 1, view: 'nonfiltered' } })).items[0];
    if (!job) throw new Error('That job is no longer stored.');
    const outcomes = (await callRoute('GET', '/performance', { query: { days: 366 } })).rows.filter((row) => String(row.job.id) === String(job._id) && row.outcomes.length);
    return {
      ...jobBrief(job),
      skills: job.skills ?? [],
      links: job.links,
      leftOutBecause: job.leftOutBy ?? null,
      hrDetails: {
        hrNames: job.contact.hrNames ?? [],
        hrProfiles: job.contact.hrProfiles ?? [],
        phones: split(job.contact.phone),
        emails: split(job.contact.email),
        fromThePost: { phones: job.contact.phoneSource === 'posting', emails: job.contact.emailSource === 'posting' },
        students: job.contact.assignedTo,
        note: job.contact.remarks,
        lastUpdated: job.contact.updatedAt,
      },
      followUps: outcomes.flatMap((row) => row.outcomes.map((o) => ({ contact: row.value, student: o.student, remark: remarkLabel(row.field, o.status, o.note) }))),
    };
  },

  async show_contacts(args, ctx) {
    let jobs = [];
    if (args.job_id) {
      const r = await callRoute('GET', '/jobs', { query: { id: args.job_id, days: 1 } });
      jobs = r.items.length ? r.items : (await callRoute('GET', '/jobs', { query: { id: args.job_id, days: 1, view: 'nonfiltered' } })).items;
    } else if (args.company) {
      const found = [];
      for (const view of [undefined, 'nonfiltered']) {
        const r = await callRoute('GET', '/jobs', { query: { q: args.company, days: 90, limit: 50, view } });
        found.push(...r.items);
      }
      jobs = found.filter((j) => j.contact.phone || j.contact.email || j.contact.hrNames?.length || j.contact.hrProfiles?.length).slice(0, 5);
      if (!jobs.length) return { shown: 0, note: `No HR contacts are stored for "${args.company}" in the last 90 days.` };
    } else {
      throw new Error('Give job_id or company.');
    }
    if (!jobs.length) throw new Error('That job is no longer stored.');
    ctx.cards.push({ type: 'contacts', jobs: jobs.map(contactCard) });
    return {
      shownToThePerson: jobs.map((j) => ({ job: j.title, company: j.company, hrNames: j.contact.hrNames ?? [], phones: split(j.contact.phone), emails: split(j.contact.email), profiles: (j.contact.hrProfiles ?? []).length })),
      note: 'The person sees these in a card with call, email and copy buttons.',
    };
  },

  async get_skill_gaps(args, ctx) {
    const course = courseOf(args.course);
    const r = await callRoute('GET', '/skill-gaps', { query: { course, ...periodOf(args, ctx), view: viewOf(args, ctx) } });
    return {
      course: r.course.name,
      period: periodWords(r),
      teaches: r.teaches,
      jobPosts: r.postings,
      postsNamingSkills: r.named,
      studentsMatchNow: r.coveredNow,
      skillsToAdd: r.skills.slice(0, 10).map((s) => ({ skill: s.skill, postsAskingForIt: s.asking, extraPostsIfAdded: s.gained })),
      bestOrder: r.plan.ladder,
    };
  },

  async get_partners(args, ctx) {
    const r = await callRoute('GET', '/partners', { query: { view: viewOf(args, ctx) } });
    const q = String(args.q ?? '').toLowerCase();
    const list = r.partners.filter((p) => !q || p.name.toLowerCase().includes(q));
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
    return {
      partners: list.length,
      withHrContact: list.filter((p) => p.phones.length || p.emails.length).length,
      top: list.slice(0, limit).map((p) => ({ company: p.name, openings: p.openings, courses: Object.fromEntries(Object.entries(p.courses).map(([id, n]) => [courseName(id), n])), cities: shownCities(p.cities), lastPosted: p.lastPosted, phones: p.phones, emails: p.emails })),
    };
  },

  async get_performance(args, ctx) {
    const period = args.from || args.days ? periodOf(args, ctx) : { days: ctx.context?.path?.startsWith('/performance') ? (ctx.context.period?.days ?? 1) : 7 };
    const r = await callRoute('GET', '/performance', { query: period });
    const course = courseOf(args.course);
    const person = String(args.person ?? '').toLowerCase();
    const rows = r.rows.filter((row) => (!course || row.job.course === course) && (!person || `${row.actor.name} ${row.actor.email}`.toLowerCase().includes(person)));
    const people = new Map();
    for (const row of rows) {
      const p = people.get(row.actor.email) ?? { person: row.actor.name || row.actor.email, phones: 0, emails: 0, jobs: new Set(), givenToStudent: 0, withRemark: 0 };
      p[row.field === 'phone' ? 'phones' : 'emails']++;
      p.jobs.add(String(row.job.id));
      if (row.outcomes.some((o) => o.student)) p.givenToStudent++;
      if (row.outcomes.some((o) => o.status)) p.withRemark++;
      people.set(row.actor.email, p);
    }
    const byRemark = {};
    for (const row of rows) for (const o of row.outcomes) if (o.status) byRemark[REMARKS[o.status]] = (byRemark[REMARKS[o.status]] ?? 0) + 1;
    return {
      period: { from: r.from, to: r.to },
      countingSince: r.since,
      contactDetailsAdded: rows.length,
      people: [...people.values()].map((p) => ({ ...p, total: p.phones + p.emails, jobs: p.jobs.size })).sort((a, b) => b.total - a.total),
      remarks: byRemark,
      withoutRemark: rows.filter((row) => needsRemark(row)).length,
      notGivenToStudent: rows.filter((row) => !row.outcomes.some((o) => o.student)).length,
    };
  },

  async list_follow_ups(args, ctx) {
    const days = Math.min(Math.max(Number(args.days) || 30, 1), 366);
    const r = await callRoute('GET', '/performance', { query: { days } });
    const course = courseOf(args.course);
    const person = String(args.person ?? '').toLowerCase();
    const status = args.status ?? 'all';
    const older = Number(args.older_than_days) || 0;
    const seen = new Set();
    const rows = r.rows.filter((row) => {
      const key = `${row.job.id}|${row.field}|${row.key}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (course && row.job.course !== course) return false;
      if (person && !`${row.actor.name} ${row.actor.email}`.toLowerCase().includes(person)) return false;
      if (older && Date.now() - Date.parse(row.at) < older * DAY_MS) return false;
      if (status === 'no-remark') return needsRemark(row);
      if (status === 'unassigned') return !row.outcomes.some((o) => o.student);
      if (status !== 'all') return row.outcomes.some((o) => o.status === status);
      return true;
    });
    const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 30);
    const items = rows.slice(0, limit).map((row) => ({
      jobId: row.job.id,
      job: row.job.title,
      company: row.job.company || '',
      course: row.job.course,
      field: row.field,
      contact: row.value,
      student: row.outcomes.map((o) => o.student).filter(Boolean).join(', '),
      remark: row.outcomes
        .filter((o) => o.status)
        .map((o) => `${row.outcomes.length > 1 && o.student ? `${o.student}: ` : ''}${remarkLabel(row.field, o.status, o.note)}`)
        .join('; '),
      addedBy: row.actor.name || row.actor.email,
      addedAt: row.at,
    }));
    ctx.cards.push({ type: 'followups', total: rows.length, items });
    return { total: rows.length, shownToThePerson: items.map(({ course: id, ...item }) => ({ ...item, course: courseName(id) })) };
  },

  async get_activity(args) {
    const r = await callRoute('GET', '/activity', { query: { q: args.q, action: args.action, limit: 200 } });
    const since = args.days ? Date.now() - Number(args.days) * DAY_MS : 0;
    const person = String(args.person ?? '').toLowerCase();
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
    const items = r.items.filter((i) => Date.parse(i.at) >= since && (!person || `${i.actor.name} ${i.actor.email}`.toLowerCase().includes(person)));
    return {
      matching: items.length,
      items: items.slice(0, limit).map((i) => ({
        at: i.at,
        by: i.actor.name || i.actor.email,
        action: i.action,
        viaIjfAi: i.via === 'ai',
        job: `${i.job.title} at ${i.job.company ?? ''}`,
        changes: i.changes.map((c) => ({ field: c.field, change: c.change, before: c.before, after: c.after, about: c.contact?.value })),
      })),
    };
  },

  async get_collection_status() {
    const meta = await callRoute('GET', '/meta');
    const run = meta.lastRun;
    return run
      ? { startedAt: run.startedAt, finishedAt: run.finishedAt, status: run.status, totals: run.totals, failedSearches: run.failedSearches, sitesSearched: meta.platforms, schedule: meta.scheduleLabel }
      : { status: 'no collection has run yet' };
  },

  async propose_hr_details(args, ctx) {
    const job = await findJob(args.job_id);
    const add = reveal(
      { phones: args.phones ?? [], emails: args.emails ?? [], hrNames: args.hr_names ?? [], hrProfiles: args.hr_profiles ?? [], students: args.students ?? [] },
      ctx.secrets,
    );
    const note = args.note ? reveal(String(args.note), ctx.secrets).trim() : '';
    const body = hrDetailsBody(job, add, note);
    const parsed = parseFollowUpInput(body);
    if (parsed.error) return { error: parsed.error };
    const owner = await findPhoneOwner(parsed.value.phoneKeys, job);
    if (owner) return { error: `${PHONE_EXISTS} It is already saved on "${owner.job.title}"${owner.job.company ? ` at ${owner.job.company}` : ''}.` };
    const parts = [
      add.phones.length && `phone ${add.phones.join(', ')}`,
      add.emails.length && `email ${add.emails.join(', ')}`,
      add.hrNames.length && `HR name ${add.hrNames.join(', ')}`,
      add.hrProfiles.length && `profile ${add.hrProfiles.join(', ')}`,
      add.students.length && `student ${add.students.join(', ')}`,
      note && `note "${note}"`,
    ].filter(Boolean);
    if (!parts.length) return { error: 'Nothing to add.' };
    const summary = `Add to ${job.title}${job.company ? ` at ${job.company}` : ''}: ${parts.join('; ')}`;
    ctx.actions.push({ type: 'add-hr-details', summary, payload: { jobId: String(job._id), add, note } });
    return { proposed: true, summary, next: 'Tell the person to check the card and click Confirm. Nothing is saved until they do.' };
  },

  async propose_follow_up(args, ctx) {
    const job = await findJob(args.job_id);
    const value = reveal(String(args.contact ?? ''), ctx.secrets).trim();
    const field = value.includes('@') ? 'email' : 'phone';
    const view = contactView(job);
    const has = (field === 'phone' ? split(view.phone) : split(view.email)).some((v) => contactKey(field, v) === contactKey(field, value));
    if (!has) return { error: `That ${field === 'phone' ? 'number' : 'email'} isn't one of this job's HR contacts.` };
    const student = args.student === undefined ? '' : reveal(String(args.student), ctx.secrets).trim();
    const body = { job: String(job._id), field, value, student };
    if (args.take_back) body.remove = true;
    else if (args.remark !== undefined) Object.assign(body, { status: args.remark, note: args.note ?? '' });
    else body.add = true;
    const parsed = parseOutcomeInput(body);
    if (parsed.error) return { error: parsed.error };
    // Whether the student has it already, for the words.
    const theirs = student && (await ContactOutcome.exists({ job: job._id, field, key: contactKey(field, value), student: new RegExp(`^${student.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }));
    const parts = [
      body.remove && `take it back from ${student}`,
      !body.remove && student && !theirs && `give it to ${student}`,
      'status' in body && (body.status ? `remark "${remarkLabel(field, body.status, parsed.value.note)}"${student && theirs ? ` for ${student}'s call` : ''}` : `clear ${student ? `${student}'s` : 'its'} remark`),
    ].filter(Boolean);
    const summary = `${value} (${job.title}${job.company ? ` at ${job.company}` : ''}): ${parts.join('; ')}`;
    ctx.actions.push({ type: 'set-follow-up', summary, payload: body });
    return { proposed: true, summary, next: 'Tell the person to check the card and click Confirm. Nothing is saved until they do.' };
  },
};

// A job's typed-in details as the follow-up PUT takes them, with these added (lists merged, the note
// added on a new line). Rebuilt from the job as it is when a change is confirmed.
export function hrDetailsBody(job, add, note) {
  const c = contactView(job);
  const merge = (list, extra) => [...list, ...extra.filter((v) => !list.some((x) => x.toLowerCase() === String(v).toLowerCase()))];
  return {
    hrName: merge(c.hrNames, add.hrNames ?? []),
    hrProfile: merge(c.hrProfiles, add.hrProfiles ?? []),
    phone: merge(split(c.phone), add.phones ?? []),
    email: merge(split(c.email), add.emails ?? []),
    assignedTo: merge(c.assignedTo, add.students ?? []),
    remarks: [c.remarks, note].filter(Boolean).join('\n'),
  };
}

// Runs one tool call. Returns what goes back to the AI (an error in words when it fails).
export async function runTool(call, ctx) {
  const run = RUN[call.name];
  if (!run) return { error: `There is no tool "${call.name}".` };
  let args;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return { error: 'The tool arguments were not valid JSON.' };
  }
  ctx.tools.push({ name: call.name, args });
  try {
    return await run(args, ctx);
  } catch (err) {
    return { error: err.message || 'That look-up failed.' };
  }
}

// Does a confirmed change (the same routes as the dashboard, recorded in the activity record as via IJF AI).
export async function doAction(action, person) {
  if (action.type === 'add-hr-details') {
    const job = await findJob(action.payload.jobId);
    const body = hrDetailsBody(job, action.payload.add, action.payload.note);
    return callRoute('PUT', '/jobs/:id/follow-up', { params: { id: action.payload.jobId }, body, person, via: 'ai' });
  }
  if (action.type === 'set-follow-up') return callRoute('PUT', '/outcomes', { body: action.payload, person, via: 'ai' });
  throw new Error('Unknown change.');
}
