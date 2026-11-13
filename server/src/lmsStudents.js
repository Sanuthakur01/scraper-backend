// The LMS's own students, for the name picker on "Today's Interviews".
//
// The staff used to type the student's name, so the interview was only ever
// linked to the LMS by however the name was spelled that day. Now they pick the
// student, and the interview keeps that student's Clerk id alongside the name.
//
// This reads the LMS's `users` and `courses` collections. It never writes to
// them: all_interviews remains the only collection this server writes there.
import { COURSES } from './config/courses.js';

const COURSE_NAMES = new Map(COURSES.map((c) => [c.id, c.name]));

// The LMS names a course by its title; the dashboard names it by id. There are
// four, and the titles ("Data Analyst Bootcamp", "Production Support Engineer")
// map cleanly. Matching the title rather than hard-coding the four ObjectIds
// means a course re-created in the LMS still resolves. Production Support is
// tested first: only it mentions support, and "Engineer" in its title must not
// be read as Data Engineering.
const COURSE_BY_TITLE = [
  [/production\s*support/i, 'production-support'],
  [/data\s*engineer/i, 'data-engineering'],
  [/data\s*scien/i, 'data-science'],
  [/data\s*analy/i, 'data-analyst'],
];

export const courseIdFromTitle = (title) => {
  const text = String(title ?? '');
  for (const [pattern, id] of COURSE_BY_TITLE) if (pattern.test(text)) return id;
  return null;
};

// Course id per LMS course _id, re-read now and then: courses change about
// never, and a stale entry here would only mislabel a course in the picker.
const COURSE_CACHE_MS = 5 * 60_000;
let courseCache = { at: 0, byId: new Map() };

async function courseIndex(db) {
  if (Date.now() - courseCache.at < COURSE_CACHE_MS && courseCache.byId.size) return courseCache.byId;
  const docs = await db.collection('courses').find({}, { projection: { title: 1 } }).toArray();
  const byId = new Map(docs.map((d) => [String(d._id), courseIdFromTitle(d.title)]));
  courseCache = { at: Date.now(), byId };
  return byId;
}

/** Only for tests: forget the cached courses. */
export const resetCourseCache = () => {
  courseCache = { at: 0, byId: new Map() };
};

// A user's course. purchasedCourses holds ObjectIds for most students and plain
// strings for a few, so both are compared as strings. No student in the LMS has
// more than one course; if that ever changes, the first that resolves is used.
export function courseOf(user, byId) {
  for (const raw of user?.purchasedCourses ?? []) {
    const id = byId.get(String(raw));
    if (id) return id;
  }
  return null;
}

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Where the query matches, best first: the start of the name, then the start of
// any word in it, then anywhere, then the email alone. Someone typing "ra" wants
// Ravi before Sachi Rajput, and Mishra last.
export function rankOf(user, query) {
  const name = String(user.fullName ?? '').toLowerCase();
  const q = query.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (new RegExp(`\\b${escapeRegex(q)}`, 'i').test(name)) return 1;
  if (name.includes(q)) return 2;
  return 3;
}

export const studentView = (user, courseId) => ({
  clerkId: user.clerkId,
  name: user.fullName,
  email: user.email ?? null,
  course: courseId,
  courseName: courseId ? COURSE_NAMES.get(courseId) ?? null : null,
  placed: user.isPlaced === true,
  paused: user.isPaused === true,
});

// Someone still studying comes before someone already placed or on a break.
// The LMS clears a student's course when they are placed, so placed entries also
// have no course line to confirm against — and they are rarely who the day's
// interviews are for. They are ranked down rather than hidden: a placed student
// does sometimes interview again, and the list marks them so it is obvious.
export const statusWeight = (user) => (user?.isPlaced === true || user?.isPaused === true ? 1 : 0);

export const MIN_QUERY = 2;
const FETCH_LIMIT = 60;
export const RESULT_LIMIT = 8;

/**
 * Students whose name (or email) matches `query`, best match first.
 *
 * Students with no Clerk id are left out: the whole point is to store one, and
 * an entry that cannot be linked would just be the old typed name again.
 */
export async function searchStudents(db, query, { limit = RESULT_LIMIT } = {}) {
  const text = String(query ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < MIN_QUERY) return [];

  const pattern = escapeRegex(text);
  const users = await db
    .collection('users')
    .find(
      {
        role: 'student',
        isRealUser: { $ne: true },
        clerkId: { $nin: [null, ''] },
        $or: [
          { fullName: { $regex: pattern, $options: 'i' } },
          { email: { $regex: pattern, $options: 'i' } },
        ],
      },
      {
        projection: { fullName: 1, clerkId: 1, email: 1, purchasedCourses: 1, isPlaced: 1, isPaused: 1 },
        limit: FETCH_LIMIT,
      },
    )
    .toArray();

  const byId = await courseIndex(db);
  return users
    .map((user) => ({ user, rank: rankOf(user, text) }))
    // How well the text matches comes first, so typing a placed student's name
    // in full still finds them ahead of a loose match on someone active.
    .sort((a, b) =>
      a.rank - b.rank ||
      statusWeight(a.user) - statusWeight(b.user) ||
      String(a.user.fullName ?? '').localeCompare(String(b.user.fullName ?? ''), 'en', { sensitivity: 'base' }),
    )
    .slice(0, limit)
    .map(({ user }) => studentView(user, courseOf(user, byId)));
}

/** One student by Clerk id — used to check a pick before it is saved. */
export async function studentByClerkId(db, clerkId) {
  if (!clerkId) return null;
  const user = await db.collection('users').findOne(
    { clerkId: String(clerkId), role: 'student' },
    { projection: { fullName: 1, clerkId: 1, email: 1, purchasedCourses: 1, isPlaced: 1, isPaused: 1 } },
  );
  if (!user) return null;
  return studentView(user, courseOf(user, await courseIndex(db)));
}
