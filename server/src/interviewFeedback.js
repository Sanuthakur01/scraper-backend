// Feedback on an interview: how the student did, written by the placement staff after the interview is over.
//
// It lives on the interview itself (all_interviews, src/allInterviews.js), under `feedback`, so a day's feedback
// is read with the day's interviews and nothing else has to be kept in step. An interview is rated on a handful
// of fixed things (FEEDBACK_CRITERIA), each GOOD, AVERAGE or BAD, plus a free remark. Nothing is compulsory: an
// interview with only a remark, or only one thing rated, is still feedback worth keeping.
//
// The score is worked out here and never stored: the points below may be re-thought, and a stored score would
// then disagree with the ratings it was made from.

// What an interview is rated on, in the order the form shows them. Short ids: they are object keys in the
// database and in the page's state, and are never shown to anyone.
export const FEEDBACK_CRITERIA = [
  { id: 'communication', label: 'Communication' },
  { id: 'technical', label: 'Technical knowledge' },
  { id: 'problemSolving', label: 'Problem solving' },
  { id: 'confidence', label: 'Confidence' },
  { id: 'projects', label: 'Projects & resume' },
];

export const RATINGS = ['GOOD', 'AVERAGE', 'BAD'];
// '' is "not rated": the staff member had nothing to say about that one, which is not the same as BAD.
const RATING_VALUES = new Set(['', ...RATINGS]);
const CRITERION_IDS = new Set(FEEDBACK_CRITERIA.map((c) => c.id));

export const NOTES_LIMIT = 2000;

// What each rating is worth, out of 100. AVERAGE is halfway so a day of average interviews scores 50, not 67.
const POINTS = { GOOD: 100, AVERAGE: 50, BAD: 0 };

/** How many of the criteria were rated each way. */
export function countsOf(ratings = {}) {
  const counts = { good: 0, average: 0, bad: 0, rated: 0 };
  for (const { id } of FEEDBACK_CRITERIA) {
    const rating = ratings?.[id];
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
    const rating = ratings?.[id];
    if (!RATINGS.includes(rating)) continue;
    total += POINTS[rating];
    rated++;
  }
  return rated ? Math.round(total / rated) : null;
}

/** The one word for a score: a day's cards and the picture group interviews by this. */
export const bandOf = (score) => (score === null || score === undefined ? null : score >= 75 ? 'GOOD' : score >= 40 ? 'AVERAGE' : 'BAD');

const cleanNotes = (v) => String(v ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/**
 * A request's `feedback` -> { value } (the feedback, or null to take it off the interview) or { error }.
 * Blank throughout is null: clearing every rating and the remark is how feedback is removed.
 */
export function parseFeedback(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The feedback was not understood.' };

  const ratings = {};
  const given = raw.ratings && typeof raw.ratings === 'object' && !Array.isArray(raw.ratings) ? raw.ratings : {};
  for (const key of Object.keys(given)) {
    if (!CRITERION_IDS.has(key)) return { error: `The feedback mentions something nobody is rated on (${key}).` };
    const rating = String(given[key] ?? '').trim().toUpperCase();
    if (!RATING_VALUES.has(rating)) return { error: 'Rate each one Good, Average or Bad, or leave it blank.' };
    if (rating) ratings[key] = rating;
  }

  const notes = cleanNotes(raw.notes);
  if (notes.length > NOTES_LIMIT) return { error: `The remark is too long (at most ${NOTES_LIMIT} characters).` };

  // Nothing rated and nothing written: the staff member cleared the form, which takes the feedback off.
  if (!Object.keys(ratings).length && !notes) return { value: null };
  return { value: { ratings, notes } };
}

/** One interview's feedback for the page, with the score worked out. Null when there is none. */
export function feedbackView(feedback) {
  if (!feedback || typeof feedback !== 'object') return null;
  const ratings = {};
  for (const { id } of FEEDBACK_CRITERIA) {
    const rating = feedback.ratings?.[id];
    if (RATINGS.includes(rating)) ratings[id] = rating;
  }
  const notes = typeof feedback.notes === 'string' ? feedback.notes : '';
  if (!Object.keys(ratings).length && !notes) return null;
  const score = scoreOf(ratings);
  return {
    ratings,
    notes,
    score,
    band: bandOf(score),
    counts: countsOf(ratings),
    by: feedback.by?.name ?? feedback.by?.email ?? null,
    at: feedback.at ?? null,
  };
}
