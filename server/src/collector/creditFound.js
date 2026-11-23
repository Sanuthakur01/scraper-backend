// `npm run naukri-details -- --credit <email>`: the contact details the Naukri pages give are also saved as each
// job's HR details under that person, through the same save as the dashboard (api/routes.js saveFollowUp: Found by
// Naukri, an activity record), so the Performance report counts them like contacts found by hand. The person is
// taken from their latest activity record (they must have saved HR details on the dashboard once).
//
// It runs before the contacts are written as found ones (enrichNaukriDetails' onFound): the activity record
// compares what the job showed before and after a save, so a number the job already showed would not count. As on
// the dashboard, a number another company's job already has is refused (the job then keeps it only as a found
// contact), and a number or email the same company's other job already has is recorded as copied: not a new contact.
// A contact the team typed into the job already is left as it is: nothing to add, so nothing is saved or recorded
// (the research team reads the same postings, so this is common).
import { contactView, parseFollowUpInput } from '../api/followUp.js';
import { saveFollowUp } from '../api/routes.js';
import { Activity } from '../models.js';
import { phoneKey } from '../normalize.js';

export const CREDIT_VIA = 'naukri-page'; // Activity.via of these records
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const split = (value) => String(value ?? '').split(/\s*,\s*/).filter(Boolean);

// The person as the activity record names them ({ userId, email, name, role }), from their latest record, or null.
export async function personByEmail(email) {
  const record = await Activity.findOne({ 'actor.email': new RegExp(`^${escapeRegex(String(email).trim())}$`, 'i') }, { actor: 1 })
    .sort({ at: -1 })
    .lean();
  if (!record) return null;
  const { userId, email: address, name, role } = record.actor;
  return { userId, email: address, name, role };
}

// onFound for enrichNaukriDetails, saving each job's new contact details as HR details by `person`; stats counts
// what was saved: jobs, contacts (new ones, as the Performance report counts them), copies, refused (jobs).
export function createCrediting(person, log = console.log) {
  const stats = { jobs: 0, contacts: 0, copies: 0, refused: 0 };
  async function onFound({ model, doc, phones, emails }) {
    const job = await model.findById(doc._id, { title: 1, company: 1, foundPhones: 1, foundEmails: 1, manual: 1 }).lean();
    if (!job) return 0;
    const shown = contactView(job);
    const had = new Set([...split(shown.phone).map(phoneKey), ...split(shown.email).map((e) => e.toLowerCase())]);
    const added = phones.filter((p) => !had.has(phoneKey(p))).length + emails.filter((e) => !had.has(e.toLowerCase())).length;
    if (!added) {
      log('    already in its HR details (typed in before): nothing to add');
      return 0;
    }
    const input = parseFollowUpInput({
      hrName: shown.hrNames,
      hrProfile: shown.hrProfiles,
      phone: [shown.phone, ...phones],
      email: [shown.email, ...emails],
      remarks: shown.remarks,
      assignedTo: shown.assignedTo,
      foundBy: shown.foundBy || 'naukri',
    });
    const saved = input.error ? input : await saveFollowUp(String(job._id), input.value, person, CREDIT_VIA);
    if (saved.error) {
      stats.refused++;
      log(`    not saved as HR details: ${saved.detail || saved.error} (kept as a found contact)`);
      return 0;
    }
    const copied = (saved.known?.phone?.length ?? 0) + (saved.known?.email?.length ?? 0);
    stats.jobs++;
    stats.contacts += added - copied;
    stats.copies += copied;
    return added - copied;
  }
  return { onFound, stats };
}
