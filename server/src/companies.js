// Employers in the stored jobs: for the weekly report's top companies and the hiring partner list.

import { COURSES } from './config/courses.js';
import { companyKey, phoneKey } from './normalize.js';

const VAGUE_CITIES = new Set(['India (city not stated)', 'Remote']);
const MAX_CONTACTS = 3;

// Jobs grouped by employer, however a platform writes the name ("ABC Technologies Pvt Ltd" and "ABC
// Technologies India" are one employer). Each group: { key, name: the spelling used most, jobs }.
export function groupByCompany(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = companyKey(job.company);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, spellings: new Map(), jobs: [] });
    const group = groups.get(key);
    group.jobs.push(job);
    group.spellings.set(job.company, (group.spellings.get(job.company) ?? 0) + 1);
  }
  return [...groups.values()].map(({ key, spellings, jobs: list }) => ({
    key,
    name: [...spellings].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0],
    jobs: list,
  }));
}

// The HR phones and emails known for a set of jobs: typed in first, then found in postings; each once.
function contactsOf(jobs) {
  const phones = new Map(); // phoneKey -> as written
  const emails = new Map(); // lowercase -> as written
  const split = (value) => String(value ?? '').split(/\s*,\s*/).filter(Boolean);
  for (const typed of [true, false]) {
    for (const job of jobs) {
      for (const phone of typed ? split(job.manual?.phone) : (job.foundPhones ?? [])) {
        if (!phones.has(phoneKey(phone))) phones.set(phoneKey(phone), phone);
      }
      for (const email of typed ? split(job.manual?.email) : (job.foundEmails ?? [])) {
        if (!emails.has(email.toLowerCase())) emails.set(email.toLowerCase(), email);
      }
    }
  }
  return { phones: [...phones.values()].slice(0, MAX_CONTACTS), emails: [...emails.values()].slice(0, MAX_CONTACTS) };
}

// Companies with at least `minOpenings` openings among `jobs`, most openings first: what they hire
// for, where, how recently, and their HR contacts.
export function hiringPartners(jobs, { minOpenings = 2 } = {}) {
  return groupByCompany(jobs)
    .filter((group) => group.jobs.length >= minOpenings)
    .map(({ name, jobs: list }) => {
      const courses = Object.fromEntries(COURSES.map((c) => [c.id, 0]));
      const cities = new Map();
      for (const job of list) {
        courses[job.course] = (courses[job.course] ?? 0) + 1;
        for (const city of job.cities ?? []) if (!VAGUE_CITIES.has(city)) cities.set(city, (cities.get(city) ?? 0) + 1);
      }
      return {
        name,
        openings: list.length,
        courses,
        cities: [...cities].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([city]) => city),
        lastPosted: new Date(Math.max(...list.map((j) => j.firstSeenAt.getTime()))),
        ...contactsOf(list),
      };
    })
    .sort((a, b) => b.openings - a.openings || b.lastPosted - a.lastPosted || a.name.localeCompare(b.name));
}
