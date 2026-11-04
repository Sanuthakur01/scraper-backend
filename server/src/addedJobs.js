// Jobs added by the team: an opening the collector missed (a company, or one of its postings), added by hand on the
// dashboard with its link and, when found, its HR contact (POST /added-jobs in api/routes.js). It is stored as an
// ordinary job, in Filtered or Non-filtered by the keep rules (addedJobReason: experience not stated doesn't leave it
// out), on the site "Added by team", with `addedBy`: who added it and when. When its link is a LinkedIn, Naukri,
// Indeed or Glassdoor listing, the listing's key is stored as the collector stores it, so a later collection that
// finds the listing adds its site to this job instead of storing the opening twice; any other link is stored with a
// key of its own (addedJobKey), so the same link is never stored twice either.

import { classifyTitle } from './classify.js';
import { COURSES } from './config/courses.js';
import { addedJobReason } from './config/filters.js';
import { FOUND_BY_REQUIRED, parseFollowUpInput, profileUrl } from './api/followUp.js';
import { Job, NonFilteredJob } from './models.js';
import { cleanText, companyKey, experienceBand, extractSkills, fingerprintFor, matchText, parseExperience, parseLocation, titleKey } from './normalize.js';
import { companySpellings, hasTypedHr } from './sameCompany.js';

export const TEAM_PLATFORM = 'Added by team';

const COMPANY_LIMIT = 120;
const TITLE_LIMIT = 200;
const LINK_LIMIT = 1000;
const LOCATION_LIMIT = 120;
const EXPERIENCE_LIMIT = 60;
const SIMILAR_DAYS = 30; // the company's same opening found this recently may be this one under another link
const SIMILAR_MAX = 5;
const DAY_MS = 86_400_000;
const SETS = [['filtered', Job], ['nonfiltered', NonFilteredJob]];

export const EXPERIENCE_UNREADABLE = 'Experience: write it like 2-5 years or 3+ years.';

const textOf = (value) => cleanText(value == null ? '' : String(value));
const clip = (text) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "careers.acme.com/jobs/12#apply" -> "https://careers.acme.com/jobs/12": a web address (checked as an HR profile
// link is: http or https, a domain, no user name or password), without the part after #; or null. A part after #
// that is a page of the site ("careers.acme.com/#/job/101", "#!/jobs/7": the job is named there) is kept.
export function jobLink(text) {
  const href = profileUrl(text);
  if (!href) return null;
  const url = new URL(href);
  if (!/^#!?\//.test(url.hash)) url.hash = '';
  return url.href;
}

// The job sites the collector reads, and how their links name a listing: the listing id the collector stores for it
// (config/sources.js; checked against the links it saved, 4 Nov 2026):
//   LinkedIn   linkedin.com/jobs/view/data-analyst-at-acme-4487004709 (or /jobs/view/4487004709, /comm/jobs/view/…),
//              also with more after it (/jobs/view/4487004709/apply/?openSDUIApplyFlow=true), the Apply button's
//              /jobs/view/externalApply/4487004709?url=…, or a jobs page showing one: ?currentJobId=4487004709
//   Naukri     naukri.com/job-listings-data-analyst-acme-pune-2-to-5-years-031126021521 (leading zeros kept)
//   Indeed     in.indeed.com/viewjob?jk=c6b760be703ab600, or a search page showing one: ?vjk=
//   Glassdoor  glassdoor.co.in/job-listing/...htm?jl=1010316347152 (or ?jobListingId=)
const digitsId = (value) => (/^\d{6,}$/.test(value ?? '') ? value : null);
const SITES = [
  {
    platform: 'LinkedIn',
    host: /(^|\.)linkedin\.com$/,
    id: (url) =>
      url.pathname.match(/^\/(?:comm\/)?jobs\/view\/(?:externalApply\/)?(?:[^/]*-)?(\d{6,})(?:\/|$)/i)?.[1] ?? digitsId(url.searchParams.get('currentJobId')),
  },
  { platform: 'Naukri', host: /(^|\.)naukri\.com$/, id: (url) => url.pathname.match(/^\/job-listings-(?:.*-)?(\d{6,})\/?$/)?.[1] },
  {
    platform: 'Indeed',
    host: /(^|\.)indeed\.com$/,
    id: (url) => [url.searchParams.get('jk'), url.searchParams.get('vjk')].find((key) => /^[a-f\d]{16}$/i.test(key ?? ''))?.toLowerCase(),
  },
  {
    platform: 'Glassdoor',
    host: /(^|\.)glassdoor\.(com|co\.in)$/,
    id: (url) => [url.searchParams.get('jl'), url.searchParams.get('jobListingId')].map(digitsId).find(Boolean),
  },
];

// The job site listing a link is, as { platform, sourceId } (its sourceKey is `${platform}:${sourceId}`), or null:
// another site, or a page of one that names no listing.
export function siteFromUrl(link) {
  const href = jobLink(String(link ?? ''));
  if (!href) return null;
  const url = new URL(href);
  const site = SITES.find((s) => s.host.test(url.hostname));
  const sourceId = site?.id(url);
  return sourceId ? { platform: site.platform, sourceId } : null;
}

// The experience typed in ("2-5 years", "3+ yrs", "Fresher", also "4 years" or "2-5") as { experience: { min, max },
// unreadable: false }; nothing typed: experience null. Read as a posting's is (parseExperience).
export function readExperience(text) {
  if (!text) return { experience: null, unreadable: false };
  const { min, max } = parseExperience(text, `${text} years`, `${text} years of experience`);
  return min == null ? { experience: null, unreadable: true } : { experience: { min, max }, unreadable: false };
}

// What the form sent: { value } or { error: 'message' } starting with its box's name, so the dashboard can show it
// there. Needed: the company, the job title, the link and the course. The location, the experience and the HR
// contact (HR names, profile links, phones, emails, checked as on a job's HR details; Found by needed with any of
// them) are optional.
export function parseAddedJobInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the job as JSON.' };
  const company = textOf(body.company);
  if (!company) return { error: 'Company: enter the company name.' };
  if (company.length > COMPANY_LIMIT) return { error: `Company: at most ${COMPANY_LIMIT} characters.` };
  const key = companyKey(company);
  if (!key) return { error: `Company: "${company}" is not a company name.` };

  const title = textOf(body.title);
  if (!title) return { error: 'Job title: enter the job position.' };
  if (title.length > TITLE_LIMIT) return { error: `Job title: at most ${TITLE_LIMIT} characters.` };

  const typedLink = textOf(body.url);
  if (!typedLink) return { error: 'Job link: paste the link to the job opening.' };
  if (typedLink.length > LINK_LIMIT) return { error: `Job link: at most ${LINK_LIMIT} characters.` };
  const url = jobLink(typedLink);
  if (!url) return { error: `Job link: "${clip(typedLink)}" is not a web link. Paste it like https://careers.company.com/jobs/123.` };

  const course = textOf(body.course);
  if (!COURSES.some((c) => c.id === course)) return { error: `Course: choose one of ${COURSES.map((c) => c.name).join(', ')}.` };

  const location = textOf(body.location);
  if (location.length > LOCATION_LIMIT) return { error: `Location: at most ${LOCATION_LIMIT} characters.` };

  const experienceText = textOf(body.experience);
  if (experienceText.length > EXPERIENCE_LIMIT) return { error: `Experience: at most ${EXPERIENCE_LIMIT} characters.` };
  const { experience, unreadable } = readExperience(experienceText);
  if (unreadable) return { error: EXPERIENCE_UNREADABLE };

  const hr = parseFollowUpInput({ hrName: body.hrName, hrProfile: body.hrProfile, phone: body.phone, email: body.email, foundBy: body.foundBy });
  if (hr.error) return hr;
  if (hasTypedHr(hr.value) && !hr.value.foundBy) return { error: FOUND_BY_REQUIRED };

  return { value: { company, companyKey: key, title, url, site: siteFromUrl(url), course, location, experienceText, experience, hr: hr.value } };
}

// The listing key a job added by hand is stored with (sourceKeys, which the database keeps unique in each set): a job
// site listing's, as the collector stores it ("LinkedIn:4487004709"), so a later collection joins it; any other link's
// own ("Added by team:careers.acme.com/jobs/12", canonicalLink), so the same link can't be stored twice at once.
export const addedJobKey = (value) => (value.site ? `${value.site.platform}:${value.site.sourceId}` : `${TEAM_PLATFORM}:${canonicalLink(value.url)}`);

// The job to store for a parsed form (parseAddedJobInput's value), shaped like a collected one: on the site "Added by
// team", first and last seen now, no posting date. leftOutBy: its addedJobReason (null: a Filtered job). The HR
// contact isn't in it: it is saved after, as any job's HR details are (api/routes.js saveFollowUp).
export function addedJobDoc(value, { _id, person, now, leftOutBy = null }) {
  const { cities, isRemote } = parseLocation(value.location);
  const fingerprint = fingerprintFor({ company: value.company, title: value.title, city: cities[0], platform: TEAM_PLATFORM, sourceId: String(_id) });
  const min = value.experience?.min ?? null;
  return {
    _id,
    fingerprint,
    fingerprints: [fingerprint],
    title: value.title,
    company: value.company,
    course: value.course,
    cities,
    isRemote,
    experienceMin: min,
    experienceMax: value.experience?.max ?? null,
    experienceText: value.experienceText,
    experienceBand: experienceBand(min),
    skills: extractSkills(value.title),
    firstSeenAt: now,
    lastSeenAt: now,
    primaryPlatform: TEAM_PLATFORM,
    platforms: [TEAM_PLATFORM],
    links: { [TEAM_PLATFORM]: value.url },
    sourceKeys: [addedJobKey(value)],
    foundPhones: [],
    foundEmails: [],
    addedBy: { userId: person.userId, email: person.email, name: person.name ?? '', at: now },
    ...(leftOutBy ? { leftOutBy } : {}),
  };
}

// ---------- Is it stored already? ----------

const MATCH_FIELDS = { title: 1, company: 1, cities: 1, firstSeenAt: 1, leftOutBy: 1, 'addedBy.email': 1, 'addedBy.name': 1, 'addedBy.at': 1 };

// A stored job as the form is told about it: the same posting, or the company's same opening.
const matchView = (doc, set) => ({
  _id: String(doc._id),
  set,
  title: doc.title,
  company: doc.company ?? '',
  cities: doc.cities ?? [],
  firstSeenAt: doc.firstSeenAt,
  ...(doc.leftOutBy ? { leftOutBy: doc.leftOutBy } : {}),
  ...(doc.addedBy ? { addedBy: { email: doc.addedBy.email ?? '', name: doc.addedBy.name ?? '', at: doc.addedBy.at } } : {}),
});

// A link as jobLink writes it, in its parts that name the page: the host without "www.", the port, the path without
// a slash at the end, and the rest (?query and a kept #page).
function linkParts(link) {
  const url = new URL(link);
  return { host: url.hostname.replace(/^www\./, ''), port: url.port ? `:${url.port}` : '', path: url.pathname.replace(/\/+$/, ''), rest: `${url.search}${url.hash}` };
}

// One spelling for every way linkSpellings writes the same page: "https://www.acme.com/jobs/12/?a=1" ->
// "acme.com/jobs/12?a=1" (no http or https, no "www.", no slash at the end; "acme.com/" for the home page).
export function canonicalLink(link) {
  const { host, port, path, rest } = linkParts(link);
  return `${host}${port}${path || '/'}${rest}`;
}

// Every way the same page's link may be stored by jobLink: http or https, with or without "www.", with or without a
// slash at the end.
function linkSpellings(link) {
  const { host: bare, port, path, rest } = linkParts(link);
  const spellings = [];
  for (const protocol of ['https:', 'http:']) {
    for (const host of [bare, `www.${bare}`]) {
      for (const pathname of path ? [path, `${path}/`] : ['/']) spellings.push(`${protocol}//${host}${port}${pathname}${rest}`);
    }
  }
  return spellings;
}

// The same posting stored already, in either set (Filtered first), or null: the same job site listing (its key, as
// the collector stores it), or the same link added by the team before (its key, or its link however written). link:
// as jobLink writes it.
export async function findDuplicate(link) {
  const key = addedJobKey({ site: siteFromUrl(link), url: link });
  const sameLink = { 'addedBy.at': { $exists: true }, [`links.${TEAM_PLATFORM}`]: { $in: linkSpellings(link) } };
  for (const [set, J] of SETS) {
    const doc = (await J.findOne({ sourceKeys: key }, MATCH_FIELDS).lean()) || (await J.findOne(sameLink, MATCH_FIELDS).lean());
    if (doc) return matchView(doc, set);
  }
  return null;
}

// Two people adding the same posting at the same moment, to different sets (e.g. "2-5 years" and "8+ years"): each
// set keeps its listing keys unique, but not the two together. So once a job added by hand is stored (doc: its
// _id and sourceKeys, in `set`), the other set's job with one of its keys and an earlier id, or null. When there is
// one, the later job is taken back (POST /added-jobs), so only the first stays.
export async function findEarlierInOtherSet(doc, set) {
  const [otherSet, J] = SETS.find(([s]) => s !== set);
  if (!doc.sourceKeys?.length) return null;
  const earlier = await J.findOne({ sourceKeys: { $in: doc.sourceKeys }, _id: { $lt: doc._id } }, MATCH_FIELDS).sort({ _id: 1 }).lean();
  return earlier ? matchView(earlier, otherSet) : null;
}

// A title's words as a job's fingerprint has them (normalize.js fingerprintFor): the same in any order or case.
const titleWords = (title) => titleKey(title) || matchText(title).trim();

// The company's jobs (either set) with the same title, first found in the last SIMILAR_DAYS: maybe the same opening
// under another link. Newest first, at most SIMILAR_MAX; never `except` (the id of the duplicate, said already).
export async function findSimilar({ company, title }, { except = null, now = new Date() } = {}) {
  const key = companyKey(company);
  const words = titleWords(title);
  if (!key || !words) return [];
  // A job's fingerprint starts with its company and title keys ("acme|analyst data|pune"), and is indexed.
  const filter = { fingerprint: new RegExp(`^${escapeRegex(`${key}|${words}|`)}`), firstSeenAt: { $gte: new Date(now.getTime() - SIMILAR_DAYS * DAY_MS) } };
  const found = await Promise.all(
    SETS.map(([set, J]) =>
      J.find(filter, MATCH_FIELDS)
        .sort({ firstSeenAt: -1, _id: 1 })
        .limit(SIMILAR_MAX + 1)
        .lean()
        .then((docs) => docs.map((doc) => ({ doc, set }))),
    ),
  );
  return found
    .flat()
    .filter(({ doc }) => String(doc._id) !== except && companyKey(doc.company) === key && titleWords(doc.title) === words)
    .sort((a, b) => b.doc.firstSeenAt - a.doc.firstSeenAt)
    .slice(0, SIMILAR_MAX)
    .map(({ doc, set }) => matchView(doc, set));
}

// What the form shows while it is filled in (GET /added-jobs/check), from what has been typed so far: each part only
// from the boxes it needs (no link: no duplicate and no site; no company: not known, nothing similar).
export async function checkAddedJob(query, now = new Date()) {
  const param = (name, limit) => textOf(Array.isArray(query[name]) ? query[name][0] : query[name]).slice(0, limit);
  const company = param('company', COMPANY_LIMIT);
  const title = param('title', TITLE_LIMIT);
  const link = param('url', LINK_LIMIT);
  const url = link ? jobLink(link) : null;
  const { experience, unreadable } = readExperience(param('experience', EXPERIENCE_LIMIT));
  const key = companyKey(company);
  const leftOutBy = addedJobReason({ company, experienceMin: experience?.min ?? null });
  const [duplicate, spellings] = await Promise.all([url ? findDuplicate(url) : null, key ? companySpellings() : null]);
  return {
    course: title ? classifyTitle(title) : null,
    site: url ? (siteFromUrl(url)?.platform ?? null) : null,
    set: leftOutBy ? 'nonfiltered' : 'filtered',
    leftOutBy,
    experience,
    experienceUnreadable: unreadable,
    knownCompany: Boolean(key && spellings?.has(key)),
    duplicate,
    similar: key && title ? await findSimilar({ company, title }, { except: duplicate?._id ?? null, now }) : [],
  };
}
