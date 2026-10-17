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

// The minimum experience a job asks for must be within EXPERIENCE_MIN..EXPERIENCE_MAX years
// (default 2..5): "3-6 yrs" is kept, "0-2 yrs", "1-3 yrs" and "6+ yrs" are not.
export const experienceInRange = (min) => min != null && min >= config.experience.min && min <= config.experience.max;
