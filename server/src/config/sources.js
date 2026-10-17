// One entry per job platform.
//   via                               -> who fetches it: 'apify' (an Apify Store actor, actorId) or 'scraper'
//                                        (our Python scraper in naukri-scraper/, feedScript; see collector/scraperFeed.js)
//   enabled                           -> false = never searched (DISABLED_SOURCES can also switch one off)
//   buildInput(term, limit, location) -> the input for one search
//   map(item, now)                    -> our common job shape, from one item of that source's output
//                                        (description and contactText are searched for phones and emails)
//   locations (optional)              -> search each term once per location, for sources that can't search all of India
// Apify is used only for LinkedIn. Naukri, Indeed and Glassdoor come from our own scraper.
// For the Apify source, field names come from the actor's README on apify.com. Check them against a
// real run in the Apify Console if it suddenly returns 0 jobs.

import { stripHtml } from '../normalize.js';

const DAY_MS = 86_400_000;

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

export const SOURCES = [
  {
    platform: 'LinkedIn',
    via: 'apify',
    actorId: 'valig/linkedin-jobs-scraper',
    // datePosted r86400 = posted in the past 24 hours
    buildInput: (term, limit) => ({ keywords: term, location: 'India', datePosted: 'r86400', limit }),
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
    // Newest first, posted in the last day, all of India. Items are Naukri's own search API job objects.
    buildInput: (term, limit) => ({ keyword: term, days: 1, limit }),
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
    via: 'scraper',
    feedScript: 'indeed_feed.py',
    // in.indeed.com, newest first, posted in the last day. Items are the job objects Indeed embeds
    // in its search pages.
    buildInput: (term, limit) => ({ keyword: term, days: 1, limit }),
    map: (item) => ({
      sourceId: item.jobkey,
      title: item.displayTitle || item.title,
      company: item.company,
      locationText: item.formattedLocation, // "Chennai, Tamil Nadu", "Remote in Mumbai, Maharashtra"
      countryCode: 'IN', // the search itself is India-only
      url: item.jobkey ? `https://in.indeed.com/viewjob?jk=${item.jobkey}` : '',
      postedAt: toDate(item.pubDate ?? item.createDate),
      salaryText: item.salarySnippet?.text,
      description: stripHtml(item.snippet),
    }),
  },
  {
    platform: 'Glassdoor',
    via: 'scraper',
    feedScript: 'glassdoor_feed.py',
    // Searches all of India (Glassdoor location id 115), newest first, posted in the last day.
    // Items are job cards read by glassdoor_feed.py.
    buildInput: (term, limit) => ({ keyword: term, days: 1, limit }),
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
