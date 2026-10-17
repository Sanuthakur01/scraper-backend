import { COURSES, GLOBAL_EXCLUDE } from './config/courses.js';
import { hasPhrase, matchText } from './normalize.js';

const toPhrase = (p) => matchText(p).trim();

const RULES = COURSES.map((course) => ({
  id: course.id,
  strong: course.strong.map(toPhrase),
  weak: course.weak.map(toPhrase),
  exclude: course.exclude.map(toPhrase),
}));
const GLOBAL = GLOBAL_EXCLUDE.map(toPhrase);

// The course whose longest matching phrase is longest wins; ties go to the course listed first.
function bestMatch(text, kind) {
  let best = null;
  for (const rule of RULES) {
    if (rule.exclude.some((p) => hasPhrase(text, p))) continue;
    for (const phrase of rule[kind]) {
      if (hasPhrase(text, phrase) && (!best || phrase.length > best.length)) {
        best = { course: rule.id, length: phrase.length };
      }
    }
  }
  return best?.course ?? null;
}

// Returns a course id such as 'data-analyst', or null when the title doesn't belong to any course.
export function classifyTitle(title) {
  const text = matchText(title);
  if (!text.trim() || GLOBAL.some((p) => hasPhrase(text, p))) return null;
  return bestMatch(text, 'strong') ?? bestMatch(text, 'weak');
}
