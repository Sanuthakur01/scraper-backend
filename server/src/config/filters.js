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
];

const excludedKeys = [...new Set(EXCLUDED_COMPANIES.map(companyKey))];

export function isExcludedCompany(name) {
  const key = companyKey(name);
  return Boolean(key) && excludedKeys.some((excluded) => key === excluded || key.startsWith(`${excluded} `));
}

// The minimum experience a job asks for must be at least EXPERIENCE_MIN years (default 2), and at most
// EXPERIENCE_MAX when that is set (no upper limit by default): "3-6 yrs" and "8+ yrs" are kept,
// "0-2 yrs" and "1-3 yrs" are not.
export const experienceInRange = (min) =>
  min != null && min >= config.experience.min && (config.experience.max == null || min <= config.experience.max);

// Why a job that fits a course is left out (a non-filtered job), from its details: the rules above, in
// the order buildJob checks them. null = it passes them (a kept, filtered job).
export function leftOutReason({ company, experienceMin }) {
  if (isExcludedCompany(company)) return 'big-company';
  if (experienceMin == null) return 'no-experience';
  if (!experienceInRange(experienceMin)) return 'experience';
  return null;
}

// A non-filtered job's leftOutBy: what the keep rules say, else 'extra-search' when it passes them but an
// extra search found it and no main search kept it (fromExtraSearch; extraSearchTerms in config/courses.js).
export const nonFilteredReason = (job) => leftOutReason(job) ?? (job.fromExtraSearch ? 'extra-search' : null);

// "2+" (no upper limit) or "2-5", for messages.
export const experienceRangeText = () =>
  config.experience.max == null ? `${config.experience.min}+` : `${config.experience.min}-${config.experience.max}`;
