// Feedback on an interview: how the student did, written after the interview is over.
//
// There is ONE review per interview, and it is the one the trainers already write on the LMS's trainer
// dashboard (lms-backend: lib/interviewReviews.js). Both pages write the same fields on the same document in
// all_interviews, so a review written in either place is read in both:
//
//   feedback     the remark, as plain text (null when nobody has written one)
//   rank         the overall: 'Good' | 'Average' | 'Bad' | null — a person's own verdict, not a sum
//   ratings      { communication, readability, confidence, technical }, each 'Good' | 'Average' | 'Bad' | null
//   reviewedBy   who wrote it ({ userId, name, email }); reviewedAt, when
//   trainer      who ran the interview, from the sheet — NOT touched here, it is not who is typing
//   feedbackSource  set on the reviews imported from the paper feedback sheets
//
// The database holds the ratings in words ('Good'); this API speaks in capitals ('GOOD'), which is what the
// page's buttons and the picture use. The two are converted at the edges here and nowhere else.
//
// The score is worked out on the way out and never stored: the points below may be re-thought, and a stored
// score would then disagree with the ratings it was made from.

// What an interview is rated on, in the order the form shows them. These are the trainer dashboard's four:
// the ids are keys inside `ratings` in the database, so they cannot be renamed without the reviews already
// written being renamed with them.
export const FEEDBACK_CRITERIA = [
  { id: 'communication', label: 'Communication' },
  { id: 'readability', label: 'Readability' },
  { id: 'confidence', label: 'Confidence' },
  { id: 'technical', label: 'Technical' },
];

export const RATINGS = ['GOOD', 'AVERAGE', 'BAD'];
// The same three as the database writes them. Reading forgives any casing; writing always uses these.
const STORED = { GOOD: 'Good', AVERAGE: 'Average', BAD: 'Bad' };
const CRITERION_IDS = new Set(FEEDBACK_CRITERIA.map((c) => c.id));

export const NOTES_LIMIT = 2000;

// What each rating is worth, out of 100. AVERAGE is halfway so a day of average interviews scores 50, not 67.
const POINTS = { GOOD: 100, AVERAGE: 50, BAD: 0 };

/** A stored or sent rating -> 'GOOD' | 'AVERAGE' | 'BAD', null for "not rated", undefined for "not one of them". */
export function ratingOf(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) return null;
  return RATINGS.includes(text) ? text : undefined;
}

/** How many of the criteria were rated each way. */
export function countsOf(ratings = {}) {
  const counts = { good: 0, average: 0, bad: 0, rated: 0 };
  for (const { id } of FEEDBACK_CRITERIA) {
    const rating = ratingOf(ratings?.[id]);
    if (rating === 'GOOD') counts.good++;
    else if (rating === 'AVERAGE') counts.average++;
    else if (rating === 'BAD') counts.bad++;
    else continue;
    counts.rated++;
  }
  return counts;
}

/** 0-100 over the criteria that were rated, or null when none were (a remark on its own). */
export function scoreOf(ratings = {}) {
  let total = 0;
  let rated = 0;
  for (const { id } of FEEDBACK_CRITERIA) {
    const rating = ratingOf(ratings?.[id]);
    if (!rating) continue;
    total += POINTS[rating];
    rated++;
  }
  return rated ? Math.round(total / rated) : null;
}

/** The one word for a score, for an interview nobody gave an overall to. */
export const bandOf = (score) => (score === null || score === undefined ? null : score >= 75 ? 'GOOD' : score >= 40 ? 'AVERAGE' : 'BAD');

const cleanNotes = (v) => String(v ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/**
 * A request's `feedback` -> { value } (the review, or null to take it off) or { error }.
 *
 * Nothing is compulsory on its own: an interview with only a remark, or only an overall, is a review worth
 * keeping. Blank throughout is null — clearing the form is how a review is taken back off.
 */
export function parseFeedback(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The feedback was not understood.' };

  const ratings = {};
  const given = raw.ratings && typeof raw.ratings === 'object' && !Array.isArray(raw.ratings) ? raw.ratings : {};
  for (const key of Object.keys(given)) {
    if (!CRITERION_IDS.has(key)) return { error: `The feedback mentions something nobody is rated on (${key}).` };
    const rating = ratingOf(given[key]);
    if (rating === undefined) return { error: 'Rate each one Good, Average or Bad, or leave it blank.' };
    if (rating) ratings[key] = rating;
  }

  const rank = ratingOf(raw.rank);
  if (rank === undefined) return { error: 'The overall must be Good, Average or Bad, or left blank.' };

  const notes = cleanNotes(raw.notes);
  if (notes.length > NOTES_LIMIT) return { error: `The remark is too long (at most ${NOTES_LIMIT} characters).` };

  // Nothing rated, no overall and nothing written: the form was cleared, which takes the review off.
  if (!Object.keys(ratings).length && !rank && !notes) return { value: null };
  return { value: { ratings, rank, notes } };
}

/**
 * The fields a review writes on the interview — the same ones the trainer dashboard's save writes, so the two
 * cannot drift. null clears the review; `trainer` is left alone either way, since it names whoever ran the
 * interview rather than whoever is typing now.
 */
export function feedbackFields(value, person, now = new Date()) {
  const ratings = Object.fromEntries(
    FEEDBACK_CRITERIA.map(({ id }) => [id, value && value.ratings[id] ? STORED[value.ratings[id]] : null]),
  );
  if (!value) return { feedback: null, rank: null, ratings, reviewedBy: null, reviewedAt: null };
  return {
    feedback: value.notes || null,
    rank: value.rank ? STORED[value.rank] : null,
    ratings,
    reviewedBy: person ?? null,
    reviewedAt: now,
  };
}

/**
 * One interview's review for the page, with the score worked out. Null when nobody has written one.
 *
 * Takes the whole interview, not a field of it: the review is spread across the document's own fields, which
 * is what lets the trainer dashboard and this page read each other's work.
 */
export function feedbackView(doc) {
  if (!doc || typeof doc !== 'object') return null;
  // Briefly — between this feature going out and the two being joined up — a review written on Today's
  // Interviews was stored as an object under `feedback`. Read it so none of those remarks is lost; the next
  // save rewrites it into the shared shape. Nothing writes this shape any more.
  const legacy = doc.feedback && typeof doc.feedback === 'object' && !Array.isArray(doc.feedback) ? doc.feedback : null;
  const given = legacy ? legacy.ratings : doc.ratings;

  const ratings = {};
  for (const { id } of FEEDBACK_CRITERIA) {
    const rating = ratingOf(given?.[id]);
    if (rating) ratings[id] = rating;
  }
  const notes = cleanNotes(legacy ? legacy.notes : doc.feedback);
  const rank = ratingOf(doc.rank) ?? null;
  if (!Object.keys(ratings).length && !notes && !rank) return null;

  const score = scoreOf(ratings);
  return {
    ratings,
    notes,
    // The person's own verdict where they gave one; otherwise the one the ratings come to.
    rank,
    score,
    band: rank ?? bandOf(score),
    counts: countsOf(ratings),
    by: doc.reviewedBy?.name ?? doc.reviewedBy?.email ?? legacy?.by?.name ?? null,
    at: doc.reviewedAt ?? legacy?.at ?? null,
    // Set on the reviews that came from the paper feedback sheets rather than being typed by anyone.
    from: doc.feedbackSource ?? null,
  };
}
