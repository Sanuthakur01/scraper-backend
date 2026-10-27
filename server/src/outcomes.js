// What the calling team records about each HR phone number and email: the students it was given to, and
// how each one's call went (a remark from a fixed list, or "Others" in their own words). One record per job,
// number/email and student (ContactOutcome in models.js), apart from the job's typed-in details, so editing
// those never touches it. Each student is also on the job's "Assigned to" list.

import { phoneKey } from './normalize.js';

// The remarks to choose from, as stored (id) and shown. DNP, Busy and Switched off: the call didn't get through.
export const REMARKS = {
  dnp: 'DNP',
  busy: 'Busy',
  'switched-off': 'Switched off',
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

// The remark a label stands for (remarkLabel the other way, for the labels the activity record keeps):
// { status, note }, e.g. "Wrong email" -> wrong, "Others: call after 5 pm" -> other + its words; null for none.
export function remarkOf(label) {
  const text = String(label ?? '');
  if (!text) return null;
  if (text === 'Wrong email') return { status: 'wrong', note: '' };
  if (text === REMARKS.other || text.startsWith(`${REMARKS.other}: `)) return { status: 'other', note: text.slice(REMARKS.other.length + 1).trim() };
  const status = Object.keys(REMARKS).find((id) => REMARKS[id] === text);
  return status ? { status, note: '' } : { status: 'other', note: text };
}

// Checks one change to a number's or email's follow-up, from the performance report or the Assign page:
//   { job, field: 'phone' | 'email', value, student, add: true }     give it to the student
//   { job, field, value, student, remove: true }                     take it back (their remark goes with it)
//   { job, field, value, student, status, note? }                    the remark of the student's call ('' clears
//                                                                     it), giving it to them first if need be;
//                                                                     student '': the number's own remark while
//                                                                     no student has it
// A number can go to several students, each with a remark of their own. As the report sent before that: a
// student alone is "give", and a remark without a student is the only student's (studentSent: false).
// Returns { value: { job, field, value, key, student, studentSent, add?, remove?, status?, note? } } or { error }.
export function parseOutcomeInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the details as JSON.' };
  const job = String(body.job ?? '');
  if (!/^[a-f\d]{24}$/i.test(job)) return { error: 'job must be a job id.' };
  if (body.field !== 'phone' && body.field !== 'email') return { error: 'field must be phone or email.' };
  const value = clean(body.value);
  if (!value || value.length > 120) return { error: 'value must be the phone number or email.' };
  const student = clean(body.student);
  if (student.length > STUDENT_LIMIT) return { error: `Assigned to: "${clip(student)}" is too long for a name (at most ${STUDENT_LIMIT} characters).` };
  const out = { job, field: body.field, value, key: contactKey(body.field, value), student, studentSent: 'student' in body };

  if (body.remove === true) return student ? { value: { ...out, remove: true } } : { error: 'Say which student to take it back from.' };
  if ('status' in body) {
    const status = String(body.status ?? '');
    if (status && !Object.hasOwn(REMARKS, status)) return { error: 'Remark: choose one from the list.' };
    const note = status === 'other' ? clean(body.note) : '';
    if (status === 'other' && !note) return { error: 'Remark: type what happened (Others).' };
    if (note.length > NOTE_LIMIT) return { error: `Remark: at most ${NOTE_LIMIT} characters.` };
    out.status = status;
    out.note = note;
  }
  if (body.add === true || (student && !('status' in out))) {
    if (!student) return { error: 'Say which student to give it to.' };
    out.add = true;
  }
  if (!out.add && !('status' in out)) return { error: 'Send a student or a remark.' };
  return { value: out };
}

// The activity record's changes (src/activity.js format) for one number or email: the students it is with
// before and after (contactStudent), and the remark of one student's call (contactRemark; student '': the
// number's own remark). Each names the number or email. Empty when nothing changed.
export function studentChange(field, value, before, after) {
  const has = (list, name) => list.some((s) => s.toLowerCase() === name.toLowerCase());
  const added = after.filter((s) => !has(before, s));
  const removed = before.filter((s) => !has(after, s));
  if (!added.length && !removed.length) return [];
  const change = added.length && removed.length ? 'edited' : added.length ? 'added' : 'removed';
  return [{ field: 'contactStudent', change, before, after, added, removed, contact: { field, value } }];
}

export function remarkChange(field, value, student, was, next) {
  const [before, after] = [remarkLabel(field, was.status, was.note), remarkLabel(field, next.status, next.note)];
  if (before === after) return [];
  const change = !before ? 'added' : !after ? 'removed' : 'edited';
  return [{ field: 'contactRemark', change, before: before ? [before] : [], after: after ? [after] : [], added: [], removed: [], contact: { field, value, student } }];
}
