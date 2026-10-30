// Which jobs we keep, besides matching a course. Applied before saving, so other jobs never reach the
// database. After changing anything here, run `npm run reclassify` to apply it to stored jobs too.

import { config } from '../config.js';
import { companyKey } from '../normalize.js';

// Large IT services firms, left out of the dashboard. Same list as COMPANY_BLACKLIST in
// naukri-scraper/scraper_file/scraper.py. A name also matches its longer forms and known aliases:
// "TCS" catches "Tata Consultancy Services", "IBM" catches "IBM India Pvt Ltd",
// "Infosys" catches "Infosys BPM".
// The dashboard names the first four, so keep the best-known first.
export const EXCLUDED_COMPANIES = [
  'TCS', 'Infosys', 'IBM', 'Wipro', 'Accenture', 'Cognizant', 'HCL', 'Tech Mahindra', 'Capgemini',
  'LTIMindtree', 'Genpact', 'Tata Consultancy Services', 'CTS', 'HCLTech', 'LTI', 'Mindtree',
  'Teleperformance', 'Sutherland',
  'LTM', // LTIMindtree's newer name in job posts
];

const excludedKeys = [...new Set(EXCLUDED_COMPANIES.map(companyKey))];

export function isExcludedCompany(name) {
  const key = companyKey(name);
  return Boolean(key) && excludedKeys.some((excluded) => key === excluded || key.startsWith(`${excluded} `));
}

// The minimum experience a job asks for must be at least EXPERIENCE_MIN years (default 1) and at most
// EXPERIENCE_MAX (default 5, since 30 Oct 2026; none before): "1-3 yrs", "1-5 yrs", "3-6 yrs" and "5-8 yrs" are
// kept; fresher jobs ("0-2 yrs", "Fresher") and those asking for more than 5 years ("6-10 yrs", "8+ yrs") are not.
export const experienceInRange = (min) =>
  min != null && min >= config.experience.min && (config.experience.max == null || min <= config.experience.max);

// A stated minimum outside the range: 'experience' (under it: freshers) or 'senior' (over it: 5+ years).
export const experienceReason = (min) => (min == null || experienceInRange(min) ? null : min < config.experience.min ? 'experience' : 'senior');

// Why a job that fits a course is left out (a non-filtered job), from its details: the rules above, in
// the order buildJob checks them. null = it passes them (a kept, filtered job).
export function leftOutReason({ company, experienceMin }) {
  if (isExcludedCompany(company)) return 'big-company';
  if (experienceMin == null) return 'no-experience';
  return experienceReason(experienceMin);
}

// A non-filtered job's leftOutBy: what the keep rules say, else 'extra-search' when it passes them but an
// extra search found it and no main search kept it (fromExtraSearch; extraSearchTerms in config/courses.js).
export const nonFilteredReason = (job) => leftOutReason(job) ?? (job.fromExtraSearch ? 'extra-search' : null);

// A Non-filtered job's experience reason (leftOutBy 'experience') in words: with a 1-year minimum these are
// the fresher jobs.
export const underExperienceText = () =>
  config.experience.min <= 1 ? 'Fresher (asks for no experience)' : `Asks for under ${config.experience.min} years`;
// leftOutBy 'senior' in words: the jobs asking for more than EXPERIENCE_MAX years.
export const overExperienceText = () => `Asks for more than ${config.experience.max} years`;

// "1+" (no upper limit) or "1-5", for messages.
export const experienceRangeText = () =>
  config.experience.max == null ? `${config.experience.min}+` : `${config.experience.min}-${config.experience.max}`;
