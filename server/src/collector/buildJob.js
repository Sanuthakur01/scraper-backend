import { classifyTitle } from '../classify.js';
import { experienceInRange, isExcludedCompany } from '../config/filters.js';
import {
  cleanText,
  experienceBand,
  experienceFromLevel,
  extractContacts,
  extractSkills,
  fingerprintFor,
  isIndiaLocation,
  parseExperience,
  parseLocation,
} from '../normalize.js';

// Turns one raw item into a clean job, or returns { skip: reason }:
//   incomplete · outside-india · no-course · big-company (config/filters.js) · experience (under the minimum)
// The rules are checked in that order. big-company and experience come back with the job too
// ({ skip, job }): the collector keeps those apart as non-filtered jobs.
// A job that doesn't state its experience comes back with experienceUnknown: the collector keeps it only
// if it is the same job as one that does state its experience on another platform (else non-filtered).
export function buildJob(source, rawItem, now) {
  const raw = source.map(rawItem, now);
  const title = cleanText(raw.title);
  const url = cleanText(raw.url);
  if (!title || !url) return { skip: 'incomplete' };

  const inIndia = raw.countryCode ? raw.countryCode.toUpperCase() === 'IN' : isIndiaLocation(raw.locationText);
  if (!inIndia) return { skip: 'outside-india' };

  const course = classifyTitle(title);
  if (!course) return { skip: 'no-course' };

  const company = cleanText(raw.company);
  const bigCompany = isExcludedCompany(company);

  let experience = { min: raw.experienceMin ?? null, max: raw.experienceMax ?? null };
  if (experience.min == null) experience = parseExperience(title, raw.experienceText, raw.description);
  if (experience.min == null) experience = experienceFromLevel(raw.experienceText);

  const { cities, isRemote } = parseLocation(raw.locationText);
  const sourceId = String(raw.sourceId ?? url);
  const contacts = extractContacts(raw.description, raw.contactText);

  const built = {
    job: {
      fingerprint: fingerprintFor({ company, title, city: cities[0], platform: source.platform, sourceId }),
      title,
      company,
      course,
      cities,
      isRemote,
      experienceMin: experience.min,
      experienceMax: experience.max,
      experienceText: cleanText(raw.experienceText),
      experienceBand: experienceBand(experience.min),
      salaryText: cleanText(raw.salaryText),
      skills: extractSkills(`${title} ${raw.description ?? ''}`, raw.skills ?? []),
      postedAt: raw.postedAt ?? null,
      foundPhones: contacts.phones,
      foundEmails: contacts.emails,
      platform: source.platform,
      url,
      sourceKey: `${source.platform}:${sourceId}`,
      experienceUnknown: experience.min == null,
    },
  };
  if (bigCompany) return { skip: 'big-company', ...built };
  if (experience.min != null && !experienceInRange(experience.min)) return { skip: 'experience', ...built };
  return built;
}
