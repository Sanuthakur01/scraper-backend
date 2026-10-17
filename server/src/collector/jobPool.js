// Decides when two listings are the same job opening, and merges them into one stored job that keeps
// every platform's listing (platform name + link).
//
// A listing joins an opening when, in this order:
//   1. it is the same platform listing (same platform + listing ID) seen before, or
//   2. its company + title + city key matches one the opening already has (also catches reposts), or
//   3. it is on a platform the opening isn't on yet, and the company, title and city agree after
//      allowing for how platforms write them differently:
//        company: "HSBC" = "HSBC Holdings plc", "Nielsen" = "Nielsen Holdings B.V."
//        title:   every word of the shorter title is in the longer one, and the seniority words match:
//                 "GCP Data Engineer" = "Walk-in || GCP Data Engineer - S", but "Data Engineer" is not
//                 "Senior Data Engineer"
//        city:    a shared city, or one side doesn't say ("India", "Remote")
// Rule 3 never merges two listings from the same platform: a company posting twice on one site
// usually means two openings.

import { companyKey, titleKey } from '../normalize.js';

const VAGUE_CITIES = new Set(['India (city not stated)', 'Remote']);
const SENIORITY = new Set([
  'senior', 'junior', 'lead', 'principal', 'staff', 'head', 'manager', 'director', 'vp', 'avp', 'president',
  'chief', 'intern', 'internship', 'trainee', 'associate', 'ii', 'iii', 'iv',
]);

const specificCities = (cities) => (cities ?? []).filter((c) => !VAGUE_CITIES.has(c));
const union = (a = [], b = []) => [...new Set([...a, ...b])];

export function companiesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 2 && long.startsWith(`${short} `);
}

export function titlesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const A = new Set(a.split(' '));
  const B = new Set(b.split(' '));
  const seniority = (set) => [...set].filter((t) => SENIORITY.has(t)).sort().join(' ');
  if (seniority(A) !== seniority(B)) return false;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  return small.size >= 2 && [...small].every((t) => large.has(t));
}

export function citiesMatch(a, b) {
  const A = specificCities(a);
  const B = specificCities(b);
  return !A.length || !B.length || A.some((c) => B.includes(c));
}

// One listing from a collector run, shaped like an opening with a single platform.
export const listingFromJob = (job) => {
  const { platform, url, sourceKey, fingerprint, ...fields } = job;
  return {
    ...fields,
    platforms: [platform],
    links: { [platform]: url },
    sourceKeys: [sourceKey],
    fingerprints: [fingerprint],
    primaryPlatform: platform,
  };
};

// A stored job, shaped as an opening.
export const openingFromDoc = (doc) => ({
  ...doc,
  links: { ...(doc.links ?? {}) },
  fingerprints: doc.fingerprints?.length ? [...doc.fingerprints] : [doc.fingerprint],
  sourceKeys: [...(doc.sourceKeys ?? [])],
  platforms: [...(doc.platforms ?? [])],
  isNew: false,
});

// Adds a listing's platforms, links and details to an opening.
// touched = has changes not yet written to the database; seenThisRun = found by this collection.
export function mergeListing(opening, listing) {
  opening.touched = true;
  opening.seenThisRun = true;
  for (const platform of listing.platforms) {
    if (!opening.platforms.includes(platform)) opening.platforms.push(platform);
    if (listing.links?.[platform]) opening.links[platform] = listing.links[platform];
  }
  opening.sourceKeys = union(opening.sourceKeys, listing.sourceKeys);
  opening.fingerprints = union(opening.fingerprints, listing.fingerprints);

  const cities = union(specificCities(opening.cities), specificCities(listing.cities));
  opening.cities = cities.length ? cities : union(opening.cities, listing.cities);
  if (opening.experienceMin == null && listing.experienceMin != null) {
    for (const key of ['experienceMin', 'experienceMax', 'experienceText', 'experienceBand']) opening[key] = listing[key];
  }
  if (!opening.salaryText && listing.salaryText) opening.salaryText = listing.salaryText;
  opening.skills = union(opening.skills, listing.skills);
  opening.foundPhones = union(opening.foundPhones, listing.foundPhones);
  opening.foundEmails = union(opening.foundEmails, listing.foundEmails);
  if (listing.lastSeenAt && (!opening.lastSeenAt || listing.lastSeenAt > opening.lastSeenAt)) opening.lastSeenAt = listing.lastSeenAt;

  // Only an opening first found by this collection may change which platform gets the count: the
  // platform where it was posted first. Jobs from earlier days keep their platform.
  if ((opening.isNew || opening.createdThisRun) && listing.postedAt && (!opening.postedAt || listing.postedAt < opening.postedAt)) {
    opening.postedAt = listing.postedAt;
    opening.primaryPlatform = listing.primaryPlatform;
  }
}

export class JobPool {
  openings = [];
  #byId = new Map();
  #bySourceKey = new Map();
  #byFingerprint = new Map();
  #byCompany = new Map(); // first word of the company -> openings

  has(id) {
    return this.#byId.has(String(id));
  }

  hasSourceKey(key) {
    return this.#bySourceKey.has(key);
  }

  // Adds an opening without matching (a stored job, or a new opening).
  add(opening) {
    opening.companyKey = companyKey(opening.company);
    opening.titleKey = titleKey(opening.title);
    this.openings.push(opening);
    if (opening._id) this.#byId.set(String(opening._id), opening);
    if (opening.companyKey) {
      const block = opening.companyKey.split(' ')[0];
      if (!this.#byCompany.has(block)) this.#byCompany.set(block, []);
      this.#byCompany.get(block).push(opening);
    }
    this.#indexKeys(opening);
    return opening;
  }

  #indexKeys(opening) {
    for (const key of opening.sourceKeys) this.#bySourceKey.set(key, opening);
    for (const key of opening.fingerprints) this.#byFingerprint.set(key, opening);
  }

  // The opening this listing belongs to, or null. isEligible can exclude openings (e.g. too old).
  find(listing, isEligible = () => true) {
    const ok = (o) => o && o !== listing && isEligible(o);
    for (const key of listing.sourceKeys) if (ok(this.#bySourceKey.get(key))) return this.#bySourceKey.get(key);
    for (const key of listing.fingerprints) if (ok(this.#byFingerprint.get(key))) return this.#byFingerprint.get(key);

    const company = companyKey(listing.company);
    if (!company) return null;
    const title = titleKey(listing.title);
    let best = null;
    let bestScore = 0;
    for (const opening of this.#byCompany.get(company.split(' ')[0]) ?? []) {
      if (!ok(opening) || opening.platforms.some((p) => listing.platforms.includes(p))) continue;
      if (!companiesMatch(opening.companyKey, company) || !titlesMatch(opening.titleKey, title)) continue;
      if (!citiesMatch(opening.cities, listing.cities)) continue;
      const sameCity = specificCities(opening.cities).some((c) => specificCities(listing.cities).includes(c));
      const score = (opening.titleKey === title ? 2 : 1) + (sameCity ? 1 : 0);
      if (score > bestScore) {
        best = opening;
        bestScore = score;
      }
    }
    return best;
  }

  merge(opening, listing) {
    mergeListing(opening, listing);
    this.#indexKeys(opening);
    return opening;
  }

  // Adds one listing from a run: joins its opening, or starts a new one.
  // newId() gives a new opening its database id up front, so saving it twice can never make two records.
  addListing(listing, newId = () => undefined) {
    const opening = this.find(listing);
    if (opening) return this.merge(opening, listing);
    return this.add({ ...listing, _id: newId(), isNew: true, createdThisRun: true, touched: true, seenThisRun: true });
  }
}
