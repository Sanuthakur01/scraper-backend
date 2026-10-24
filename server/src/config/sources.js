// One entry per job platform.
//   via                               -> who fetches it: 'apify' (an Apify Store actor, actorId) or 'scraper'
//                                        (our Python scraper in naukri-scraper/, feedScript; see collector/scraperFeed.js)
//   enabled                           -> false = never searched (DISABLED_SOURCES can also switch one off)
//   buildInput(term, limit, location, { days, skipIds }) -> the input for one search: postings from
//                                        the last `days` days; skipIds = listing ids not to fetch again
//   map(item, now)                    -> our common job shape, from one item of that source's output
//                                        (description and contactText are searched for phones and emails)
//   locations (optional)              -> search each term once per location, for sources that can't search all of India
//   minTimeoutMinutes, minutesPerSearch (scraper, optional) -> its Python process may run at least this long, and
//                                        at least minutesPerSearch per search (SCRAPER_TIMEOUT_MINUTES otherwise)
//   pricePerResult (apify)            -> what one result costs, for the credit check before a run
//   onlyTerms(course) (optional)      -> run only these of the course's searches here (default: all of them)
// LinkedIn and Indeed come from Apify; Naukri and Glassdoor from our own scraper. (Indeed came from the
// scraper's indeed_feed.py until 24 Oct 2026; it still works: via 'scraper', feedScript 'indeed_feed.py'
// and its old map in git history.)
// For the Apify sources, field names come from the actors' READMEs on apify.com. Check them against a
// real run in the Apify Console if one suddenly returns 0 jobs.

import { stripHtml } from '../normalize.js';

const DAY_MS = 86_400_000;

// The smallest of a site's date filters that covers `days` (the sites only offer a few).
const coverDays = (days, offered) => offered.find((d) => d >= days) ?? offered.at(-1);
// LinkedIn's date filter: past 24 hours, past week, past month.
const linkedinDatePosted = (days) => ({ 1: 'r86400', 7: 'r604800', 30: 'r2592000' })[coverDays(days, [1, 7, 30])];

const toDate = (value) => {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toNumber = (value) => (value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value));

// Glassdoor card ages: "24h" -> 24 hours ago, "3d" -> 3 days ago, "30d+" -> 30 days ago.
const ageToDate = (age, now) => {
  const m = String(age ?? '').match(/(\d+)\s*([hd])/i);
  if (!m) return null;
  return new Date(now.getTime() - Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3_600_000 : DAY_MS));
};

// Indeed's place codes (location.admin3Code, mostly airport codes; seen on 24 Oct 2026) -> a city name our
// city groups know. Its location.city is usually empty. An unknown code: "city not stated", never a guess.
const INDEED_CITIES = {
  BLR: 'Bengaluru', HYD: 'Hyderabad', PNQ: 'Pune', MAA: 'Chennai', BOM: 'Mumbai', NVM: 'Navi Mumbai',
  DEL: 'New Delhi', GRG: 'Gurugram', CCU: 'Kolkata', AMD: 'Ahmedabad', COK: 'Kochi', TRV: 'Thiruvananthapuram',
  CJB: 'Coimbatore', JAI: 'Jaipur', IXC: 'Chandigarh', IDR: 'Indore', NAG: 'Nagpur', BDQ: 'Vadodara', STV: 'Surat',
  BBI: 'Bhubaneswar', LKO: 'Lucknow', MYQ: 'Mysuru', IXE: 'Mangaluru', VTZ: 'Visakhapatnam', VGA: 'Vijayawada',
  IXM: 'Madurai', BHO: 'Bhopal', ISK: 'Nashik', PAT: 'Patna', IXR: 'Ranchi', GAU: 'Guwahati', DED: 'Dehradun',
  GOI: 'Goa',
};
// A state code that is one city by itself (location.admin1Code, when there is no place code).
const INDEED_STATE_CITIES = { DL: 'New Delhi', CH: 'Chandigarh', GA: 'Goa' };

// "Pune", "Pune (Remote)", "Remote" or "India" (city not stated), for parseLocation.
function indeedLocation({ location = {}, attributes = {} }) {
  const place = location?.city || INDEED_CITIES[location?.admin3Code] || INDEED_STATE_CITIES[location?.admin1Code] || 'India';
  const remote = Object.values(attributes ?? {}).some((tag) => /^(remote|work from home)$/i.test(String(tag).trim()));
  if (!remote || /remote/i.test(place)) return place;
  return place === 'India' ? 'Remote' : `${place} (Remote)`;
}

// { min: 600000, max: 1000000, unitOfWork: 'YEAR', currencyCode: 'INR' } -> "₹6,00,000 - ₹10,00,000 a year",
// as Indeed itself writes it.
const PAY_PERIODS = { YEAR: 'a year', MONTH: 'a month', WEEK: 'a week', DAY: 'a day', HOUR: 'an hour' };
function indeedSalary(pay) {
  if (!pay || (pay.min == null && pay.max == null)) return '';
  const money = (n) => `${!pay.currencyCode || pay.currencyCode === 'INR' ? '₹' : `${pay.currencyCode} `}${Math.round(n).toLocaleString('en-IN')}`;
  const amount =
    pay.min != null && pay.max != null && pay.min !== pay.max
      ? `${money(pay.min)} - ${money(pay.max)}`
      : pay.min != null && pay.max == null
        ? `From ${money(pay.min)}`
        : pay.min == null
          ? `Up to ${money(pay.max)}`
          : money(pay.min);
  return PAY_PERIODS[pay.unitOfWork] ? `${amount} ${PAY_PERIODS[pay.unitOfWork]}` : amount;
}

export const SOURCES = [
  {
    platform: 'LinkedIn',
    via: 'apify',
    actorId: 'valig/linkedin-jobs-scraper',
    pricePerResult: 0.0004, // $0.40 per 1,000 results on Apify's free plan (23 Oct 2026)
    // The expensive platform: only each course's linkedinSearchTerms (config/courses.js), not every search.
    onlyTerms: (course) => course.linkedinSearchTerms,
    // datePosted r86400 = posted in the past 24 hours (r604800 week, r2592000 month)
    buildInput: (term, limit, location, { days = 1, skipIds = [] } = {}) => ({
      keywords: term,
      location: 'India',
      datePosted: linkedinDatePosted(days),
      limit,
      ...(skipIds.length ? { skipJobId: skipIds } : {}),
    }),
    map: (item) => ({
      sourceId: item.id,
      title: item.title,
      company: item.companyName,
      locationText: item.location,
      url: item.url,
      postedAt: toDate(item.postedDate),
      experienceText: item.experienceLevel,
      salaryText: item.salary,
      description: item.description,
    }),
  },
  {
    platform: 'Naukri',
    via: 'scraper',
    feedScript: 'naukri_feed.py',
    minutesPerSearch: 1, // about 15 seconds each on 23 Oct 2026
    // Newest first, posted in the last day, all of India. Items are Naukri's own search API job objects.
    // Naukri's jobAge filter offers 1, 3, 7, 15 or 30 days.
    buildInput: (term, limit, location, { days = 1 } = {}) => ({ keyword: term, days: coverDays(days, [1, 3, 7, 15, 30]), limit }),
    map: (item) => {
      const label = Object.fromEntries((item.placeholders ?? []).map((p) => [p.type, p.label]));
      return {
        sourceId: item.jobId,
        title: item.title,
        company: item.companyName,
        locationText: label.location, // "Hybrid - Hyderabad, Pune"
        url: item.jdURL ? new URL(item.jdURL, 'https://www.naukri.com').href : '',
        postedAt: toDate(item.createdDate),
        experienceMin: toNumber(item.minimumExperience),
        experienceMax: toNumber(item.maximumExperience),
        experienceText: item.experienceText ?? label.experience,
        salaryText: label.salary,
        description: stripHtml(item.jobDescription),
        contactText: item.hiringFor, // consultants sometimes put a phone here: "Call Neha 9845011122"
        skills: String(item.tagsAndSkills ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };
    },
  },
  {
    platform: 'Indeed',
    via: 'apify',
    actorId: 'valig/indeed-jobs-scraper',
    pricePerResult: 0.0001, // $0.10 per 1,000 results on Apify's free plan (23 Oct 2026), a quarter of LinkedIn's
    // in.indeed.com (country 'in'), all of India. Its date filter offers 1, 3, 7 or 14 days, so a 30-day
    // backfill reaches 14 days back on Indeed. Items carry the full job description (our old scraper only
    // got a snippet), so most Indeed jobs now say how much experience they ask for.
    buildInput: (term, limit, location, { days = 1 } = {}) => ({
      country: 'in',
      title: term,
      location: '',
      limit,
      datePosted: String(coverDays(days, [1, 3, 7, 14])),
    }),
    map: (item) => ({
      sourceId: item.key, // Indeed's job key, as our old scraper saved it: the same job matches
      title: item.title,
      company: item.employer?.name,
      locationText: indeedLocation(item),
      countryCode: item.location?.countryCode || 'IN',
      url: item.key ? `https://in.indeed.com/viewjob?jk=${item.key}` : item.url,
      postedAt: toDate(item.dateOnIndeed ?? item.datePublished), // when it appeared on Indeed (reposts: again)
      salaryText: indeedSalary(item.baseSalary),
      description: item.description?.text ?? stripHtml(item.description?.html),
      skills: Object.values(item.attributes ?? {}), // Indeed's own tags: "Python", "Power BI", "Full-time"...
    }),
  },
  {
    platform: 'Glassdoor',
    via: 'scraper',
    feedScript: 'glassdoor_feed.py',
    minutesPerSearch: 1, // about 12 seconds each on 23 Oct 2026
    // Searches all of India (Glassdoor location id 115), newest first, posted in the last day.
    // Items are job cards read by glassdoor_feed.py.
    // Glassdoor's fromAge filter offers 1, 3, 7, 14 or 30 days.
    buildInput: (term, limit, location, { days = 1 } = {}) => ({ keyword: term, days: coverDays(days, [1, 3, 7, 14, 30]), limit }),
    map: (item, now) => ({
      sourceId: item.jobId,
      title: item.title,
      company: item.company,
      locationText: item.location, // a city, state, locality or "Remote"
      countryCode: 'IN', // the search itself is India-only, so localities like "Hauz Khas" count too
      url: item.url,
      postedAt: ageToDate(item.age, now),
      salaryText: item.salary,
      description: item.snippet,
    }),
  },
];

export const enabledSources = (disabled = []) =>
  SOURCES.filter((source) => source.enabled !== false && !disabled.includes(source.platform.toLowerCase()));
