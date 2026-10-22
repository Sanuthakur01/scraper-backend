// What the calling team records about each HR phone number and email in the performance report: the
// student it was given to, and how the call went (a remark from a fixed list, or "Others" in their own
// words). One record per job and number/email (ContactOutcome in models.js), apart from the job's typed-in
// details, so editing those never touches it. The student is also on the job's "Assigned to" list.

import { phoneKey } from './normalize.js';

// The remarks to choose from, as stored (id) and shown.
export const REMARKS = {
  dnp: 'DNP',
  wrong: 'Wrong number',
  'not-person': 'Not the correct person',
  'cv-shared': 'CV shared',
  'no-openings': 'No openings',
  other: 'Others',
};
export const STUDENT_LIMIT = 60; // as for the students of a job (api/followUp.js)
export const NOTE_LIMIT = 300; // an "Others" remark

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const clip = (text) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

// What a number or email is matched by: its bare national digits, or the address in lower case.
export const contactKey = (field, value) => (field === 'phone' ? phoneKey(value) || clean(value) : clean(value).toLowerCase());

// A remark in words: "DNP", "Wrong email" (for an email), "Others: call after 5 pm"; '' when there is none.
export function remarkLabel(field, status, note) {
  if (!status) return '';
  if (status === 'other') return note ? `Others: ${note}` : 'Others';
  if (status === 'wrong' && field === 'email') return 'Wrong email';
  return REMARKS[status] ?? status;
}

// Checks one change from the report: { job, field: 'phone' | 'email', value, student?, status?, note? }.
// Only what is sent changes (the report saves the student and the remark separately); '' clears it.
// Returns { value: { job, field, value, key, student?, status?, note? } } or { error: 'message' }.
export function parseOutcomeInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the details as JSON.' };
  const job = String(body.job ?? '');
  if (!/^[a-f\d]{24}$/i.test(job)) return { error: 'job must be a job id.' };
  if (body.field !== 'phone' && body.field !== 'email') return { error: 'field must be phone or email.' };
  const value = clean(body.value);
  if (!value || value.length > 120) return { error: 'value must be the phone number or email.' };
  const out = { job, field: body.field, value, key: contactKey(body.field, value) };

  if ('student' in body) {
    const student = clean(body.student);
    if (student.length > STUDENT_LIMIT) return { error: `Assigned to: "${clip(student)}" is too long for a name (at most ${STUDENT_LIMIT} characters).` };
    out.student = student;
  }
  if ('status' in body) {
    const status = String(body.status ?? '');
    if (status && !Object.hasOwn(REMARKS, status)) return { error: 'Remark: choose one from the list.' };
    const note = status === 'other' ? clean(body.note) : '';
    if (status === 'other' && !note) return { error: 'Remark: type what happened (Others).' };
    if (note.length > NOTE_LIMIT) return { error: `Remark: at most ${NOTE_LIMIT} characters.` };
    out.status = status;
    out.note = note;
  }
  if (!('student' in out) && !('status' in out)) return { error: 'Send a student or a remark.' };
  return { value: out };
}

// The changes for the activity record (src/activity.js format), from the outcome before and after, each
// naming the number or email it is about. Empty when nothing changed.
export function outcomeChanges(field, value, was, next) {
  const contact = { field, value };
  const kind = (before, after) => (!before ? 'added' : !after ? 'removed' : 'edited');
  const changes = [];
  if (next.student !== was.student) {
    const sameName = next.student.toLowerCase() === was.student.toLowerCase();
    changes.push({
      field: 'contactStudent',
      change: kind(was.student, next.student),
      before: was.student ? [was.student] : [],
      after: next.student ? [next.student] : [],
      added: next.student && !sameName ? [next.student] : [],
      removed: was.student && !sameName ? [was.student] : [],
      contact,
    });
  }
  const [before, after] = [remarkLabel(field, was.status, was.note), remarkLabel(field, next.status, next.note)];
  if (before !== after) {
    changes.push({ field: 'contactRemark', change: kind(before, after), before: before ? [before] : [], after: after ? [after] : [], added: [], removed: [], contact });
  }
  return changes;
}
