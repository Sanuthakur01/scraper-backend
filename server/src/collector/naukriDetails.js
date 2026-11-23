// After a collection: the new Naukri jobs' full descriptions, for the contact details written in them.
//
// Naukri's search API gives only the first ~500 characters of a description, and recruiters write their phone
// number or email at the end of the full one ("Share your CV at hr@acme.in / call 98765 43210"). Naukri hides
// the recruiter's own details from job seekers (showRecruiterDetail is false on every posting), so the full
// description is the one place a posting's contact details can be found: on 18 Nov 2026, 3 of 45 postings had
// one there, none of them in the snippet.
//
// So after each collection the Python scraper opens the page of each new Naukri job (scraper_file/
// naukri_details.py: one page at a time, like a reader, images and fonts not downloaded) and the contact
// details in the full description go into the job's foundPhones / foundEmails, the fields the collector fills
// from the snippet when it finds the job (normalize.js extractContacts). Each job's page is read once:
// naukriDetail records that it was ('ok', or 'gone': the posting was no longer on Naukri). A page that
// couldn't be read this time (blocked, timeout) is tried again next run, while the job is new enough (`days`).
// Kept jobs come first, then the non-filtered ones, newest first, up to `limit` pages a run.
import fs from 'node:fs';
import path from 'node:path';
import { CollectorRun, Job, NonFilteredJob } from '../models.js';
import { extractContacts, stripHtml } from '../normalize.js';
import { defaultPython, parseJsonLines, runPython } from './scraperFeed.js';

const DAY_MS = 86_400_000;
const SECONDS_PER_PAGE = 15; // the time limit allows this much per page (a page takes 3-5 seconds)

// The two sets a Naukri job can be in: kept (Job, the Filtered jobs) and non-filtered (NonFilteredJob).
export const SETS = [[Job, 'kept'], [NonFilteredJob, 'non-filtered']];

// The jobs whose Naukri page hasn't been read yet, among those first seen in the last `days` days; of one course
// when `course` is given. not: ids already tried in this run (pages that failed), so a run never asks for them twice.
export const candidateFilter = (now, days, { course = null, not = [] } = {}) => ({
  sourceKeys: { $regex: '^Naukri:' },
  'links.Naukri': { $exists: true },
  firstSeenAt: { $gte: new Date(now.getTime() - days * DAY_MS) },
  naukriDetail: { $exists: false },
  ...(course ? { course } : {}),
  ...(not.length ? { _id: { $nin: not } } : {}),
});

// Up to `limit` jobs to read: kept jobs first, then non-filtered ones, newest first in each. `sets` chooses which
// of 'kept' / 'non-filtered' to read (default both), so a run can be kept the Filtered jobs only.
export async function findCandidates(now, { days, limit, course = null, not = [], sets = ['kept', 'non-filtered'] }) {
  const found = [];
  for (const [model, kind] of SETS) {
    if (!sets.includes(kind) || found.length >= limit) continue;
    const docs = await model
      .find(candidateFilter(now, days, { course, not }), { title: 1, company: 1, links: 1, foundPhones: 1, foundEmails: 1, firstSeenAt: 1 })
      .sort({ firstSeenAt: -1 })
      .limit(limit - found.length)
      .lean();
    for (const doc of docs) found.push({ model, kind, doc });
  }
  return found;
}

// The contact details written in a posting's full description: { phones, emails } (normalize.js).
export const detailContacts = (result) => extractContacts(stripHtml(result.description), stripHtml(result.shortDescription));

// What one job's result changes: { operation (for bulkWrite), phones, emails } with the contact details the job
// didn't have yet, or null for a page not read this time (nothing is written, so it is tried again next run).
export function detailChange(doc, result, now) {
  if (result.status !== 'ok' && result.status !== 'gone') return null;
  const naukriDetail = { at: now, status: result.status, ...(result.website ? { website: String(result.website) } : {}) };
  let phones = [];
  let emails = [];
  if (result.status === 'ok') {
    const found = detailContacts(result);
    phones = found.phones.filter((p) => !(doc.foundPhones ?? []).includes(p));
    emails = found.emails.filter((e) => !(doc.foundEmails ?? []).includes(e));
  }
  const addToSet = {
    ...(phones.length ? { foundPhones: { $each: phones } } : {}),
    ...(emails.length ? { foundEmails: { $each: emails } } : {}),
  };
  const update = { $set: { naukriDetail }, ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}) };
  return { operation: { updateOne: { filter: { _id: doc._id }, update } }, phones, emails };
}

// fetchDetails(jobs) for the real run: runs scraper_file/naukri_details.py with the jobs ({ id, url }) on its
// stdin and returns Map(id -> { status, description, ... }). Pages the script didn't get to are simply missing.
export function createDetailsFetcher({ dir, python, headless, delaySeconds = 1.5 }, log = console.log) {
  const pythonPath = python || defaultPython(dir);
  return async function fetchDetails(jobs) {
    const script = path.join('scraper_file', 'naukri_details.py');
    if (!fs.existsSync(path.join(dir, script))) {
      throw new Error(`Naukri details script not found: ${path.join(dir, script)} (set NAUKRI_SCRAPER_DIR)`);
    }
    if (!python && !fs.existsSync(pythonPath)) {
      throw new Error(`The scraper's Python environment is missing (${pythonPath}). See README: "Scraper setup".`);
    }
    const { stdout, problem } = await runPython(pythonPath, [script, '--delay', String(delaySeconds), ...(headless ? ['--headless'] : [])], {
      cwd: dir,
      input: jobs.map((job) => JSON.stringify(job)).join('\n') + '\n',
      timeoutMs: (jobs.length * SECONDS_PER_PAGE + 120) * 1000,
      onLog: (line) => log(`    ${line}`),
      label: 'Naukri details',
    });
    const results = parseJsonLines(stdout, 'id');
    if (!results.size) throw new Error(`The Naukri details scraper returned nothing (${problem || 'no output'})`);
    if (problem) log(`    ${problem}`);
    return results;
  };
}

// Reads the new Naukri jobs' pages and saves the contact details found. Returns the summary it logs:
// { candidates, read, gone, failed, jobsWithNewContacts, phones, emails, durationMs }. runId: the collection's
// run record, which gets the summary (naukriDetails). fetchDetails is injected (createDetailsFetcher for the
// real run), so the tests can run without Python or Naukri.
// For `npm run naukri-details`: course reads only that course's jobs; batchSize pages are read per browser run
// (default: all `limit` in one); stopAfterContacts stops once that many contacts were found (the pages read
// after that are left unread for next time); onFound({ model, doc, phones, emails }) is called for each job with
// new contact details BEFORE they are written (so it can save them as HR details: the activity record compares
// what the job showed before and after), and returns how many of them count towards stopAfterContacts.
export async function enrichNaukriDetails({
  fetchDetails,
  now = new Date(),
  log = console.log,
  limit,
  days,
  runId = null,
  course = null,
  sets = ['kept', 'non-filtered'],
  batchSize = limit,
  stopAfterContacts = Infinity,
  onFound = null,
}) {
  const started = Date.now();
  const summary = { candidates: 0, read: 0, gone: 0, failed: 0, jobsWithNewContacts: 0, phones: 0, emails: 0, durationMs: 0 };
  const tried = [];
  let contacts = 0;
  while (tried.length < limit && contacts < stopAfterContacts) {
    const candidates = await findCandidates(now, { days, limit: Math.min(batchSize, limit - tried.length), course, not: tried, sets });
    if (!candidates.length) {
      if (!tried.length) log(`Naukri job pages: every new ${course ? `${course} ` : ''}Naukri job has been read already.`);
      break;
    }
    summary.candidates += candidates.length;
    tried.push(...candidates.map((c) => c.doc._id));
    const kept = candidates.filter((c) => c.kind === 'kept').length;
    log(`Naukri job pages: reading ${candidates.length} new jobs' full descriptions for contact details (${kept} kept, ${candidates.length - kept} non-filtered)...`);

    const results = await fetchDetails(candidates.map(({ doc }) => ({ id: String(doc._id), url: doc.links.Naukri })));
    const operations = new Map([[Job, []], [NonFilteredJob, []]]);
    for (const { model, doc } of candidates) {
      if (contacts >= stopAfterContacts) break; // enough: the rest of this batch stays unread
      const result = results.get(String(doc._id)) ?? { status: 'failed', error: 'not reached' };
      const change = detailChange(doc, result, now);
      if (!change) {
        summary.failed++;
        continue;
      }
      summary[result.status === 'ok' ? 'read' : 'gone']++;
      if (change.phones.length || change.emails.length) {
        summary.jobsWithNewContacts++;
        summary.phones += change.phones.length;
        summary.emails += change.emails.length;
        log(`  + ${[doc.company, doc.title].filter(Boolean).join(' | ')}: ${[...change.phones, ...change.emails].join(', ')}`);
        contacts += onFound ? await onFound({ model, doc, phones: change.phones, emails: change.emails }) : change.phones.length + change.emails.length;
      }
      operations.get(model).push(change.operation);
    }
    for (const [model, ops] of operations) if (ops.length) await model.bulkWrite(ops, { ordered: false });
    if (candidates.length < batchSize) break; // that was the last of them
  }

  summary.durationMs = Date.now() - started;
  log(
    `  ✓ Naukri job pages: ${summary.read} read, ${summary.gone} no longer on Naukri, ${summary.failed} not read (tried again next run); ` +
      `${summary.phones} phone number(s) and ${summary.emails} email(s) found in ${summary.jobsWithNewContacts} jobs, in ${Math.round(summary.durationMs / 60_000)} min.`,
  );
  if (runId) await CollectorRun.updateOne({ _id: runId }, { $set: { naukriDetails: summary } }).catch(() => {});
  return summary;
}
