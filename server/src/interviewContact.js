// Where an interview came from — the page calls it the Source: the call we made, the call they made, or the
// mail, together with the number or the address it came through. Entered with the interview and changed with it.
//
// Kept on the interview as `contact`, deliberately NOT as `source`: `source` on these documents already means
// which list the interview itself came from ('sheet' or 'lms'), and two fields of that name on one document
// would be read as each other sooner or later. The page labels this one "Source"; the database does not.

// What can be picked, and what has to be written alongside each. Sent to the page with the day, so adding a
// way an interview can come in is a change here alone.
export const CONTACT_VIAS = [
  { id: 'OUTGOING', label: 'Outgoing call', detail: 'phone', detailLabel: 'Outgoing number' },
  { id: 'INCOMING', label: 'Incoming call', detail: 'phone', detailLabel: 'Incoming number' },
  { id: 'MAIL', label: 'Mail', detail: 'email', detailLabel: 'Email address' },
];

const BY_ID = new Map(CONTACT_VIAS.map((via) => [via.id, via]));
export const DETAIL_LIMIT = 120;
// Numbers are kept as they were written (spaces, +91, brackets and all): a number is read back and dialled by a
// person, and rewriting it into one house style would only make it harder to recognise.
const PHONE_SHAPE = /^[0-9 ()+-]+$/;
const DIGITS = { min: 7, max: 15 }; // a local extension at the short end, a full international number at the long
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const digitsIn = (text) => (text.match(/\d/g) ?? []).length;

/**
 * A request's source -> { value } (cleaned, or null for "not recorded") or { error } (what to fix).
 *
 * Blank throughout is null rather than a half-written source: clearing the fields is how a source entered by
 * mistake is taken back off. A way in without the number or the address, though, is refused — "someone rang"
 * with no way of ringing back is the part nobody can fill in later.
 */
export function parseContact(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The source was not understood.' };

  const via = String(raw.via ?? '').trim().toUpperCase();
  const detail = String(raw.detail ?? '').replace(/\s+/g, ' ').trim();
  if (!via && !detail) return { value: null };
  if (!via) return { error: 'Choose how the interview came in: an outgoing call, an incoming call or a mail.' };

  const kind = BY_ID.get(via);
  if (!kind) return { error: 'The source must be an outgoing call, an incoming call or a mail.' };
  const what = kind.detailLabel.toLowerCase();
  if (!detail) return { error: `Write the ${what}.` };
  if (detail.length > DETAIL_LIMIT) return { error: `The ${what} is too long (at most ${DETAIL_LIMIT} characters).` };

  if (kind.detail === 'phone') {
    const digits = digitsIn(detail);
    if (!PHONE_SHAPE.test(detail) || digits < DIGITS.min || digits > DIGITS.max) {
      return { error: `Write the ${what} in digits (${DIGITS.min} to ${DIGITS.max} of them).` };
    }
    return { value: { via, detail } };
  }
  if (!EMAIL_SHAPE.test(detail)) return { error: 'Write the email address, as name@company.com.' };
  return { value: { via, detail: detail.toLowerCase() } };
}

/** One interview's source for the page: null until somebody records one. */
export function contactView(contact) {
  if (!contact) return null;
  const kind = BY_ID.get(contact.via);
  const detail = String(contact.detail ?? '').trim();
  // A half-written one can only come from an older document or a hand-edited record; it is shown as none
  // rather than as a source with nothing to go on.
  if (!kind || !detail) return null;
  return { via: kind.id, label: kind.label, detail, detailKind: kind.detail };
}
