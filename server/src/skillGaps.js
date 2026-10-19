// Which skill, if a course started teaching it, would let its students match the most additional
// postings. Everything is a count of real postings; nothing is estimated or projected:
//
//   named       postings that name at least one skill we track (normalize.js SKILLS). Postings that
//               name none can't be judged, so they are left out, and every share is "of named".
//   coveredNow  named postings whose every named skill is already taught
//   for each skill the course doesn't teach, named by at least one posting:
//     asking       postings that name it
//     gained       postings where it is the ONLY named skill the course doesn't teach, so teaching it
//                  would cover every skill they name
//     coveredAfter coveredNow + gained
//
// Skills sort by gained, then asking.
export function skillGaps(postings, taught) {
  const teaches = new Set(taught);
  const named = postings.filter((p) => p.skills?.length);
  let coveredNow = 0;
  const bySkill = new Map();
  for (const posting of named) {
    const missing = [...new Set(posting.skills)].filter((s) => !teaches.has(s));
    if (!missing.length) coveredNow++;
    for (const skill of missing) {
      if (!bySkill.has(skill)) bySkill.set(skill, { skill, asking: 0, gained: 0 });
      const row = bySkill.get(skill);
      row.asking++;
      if (missing.length === 1) row.gained++;
    }
  }
  const skills = [...bySkill.values()]
    .map((row) => ({ ...row, coveredAfter: coveredNow + row.gained }))
    .sort((a, b) => b.gained - a.gained || b.asking - a.asking || a.skill.localeCompare(b.skill));
  return { postings: postings.length, named: named.length, coveredNow, skills };
}

// Adding several skills: postings missing more than this many untaught skills are out of reach.
export const MAX_ADD = 4;

// The skills to add, one after another, that let students match the most extra postings, and the
// postings within reach (missing 1..maxAdd untaught skills) so any other combination can be tried.
//   ladder[i] = { skill, added, total }: adding the first i+1 skills newly matches `total` postings,
//               `added` of them thanks to this step's skill.
// Each step takes the skill that matches the most postings together with the skills already chosen;
// on a tie, the one named by more of the postings still in reach, then alphabetical.
export function skillPlan(postings, taught, { maxAdd = MAX_ADD, steps = 5 } = {}) {
  const teaches = new Set(taught);
  const reachable = [];
  for (const posting of postings) {
    if (!posting.skills?.length) continue;
    const missing = [...new Set(posting.skills)].filter((s) => !teaches.has(s));
    if (missing.length && missing.length <= maxAdd) reachable.push({ posting, missing });
  }
  const candidates = [...new Set(reachable.flatMap((r) => r.missing))];
  const matchedWith = (set) => reachable.filter((r) => r.missing.every((s) => set.has(s))).length;

  const chosen = [];
  const ladder = [];
  let matched = 0;
  while (ladder.length < steps) {
    let best = null;
    for (const skill of candidates) {
      if (chosen.includes(skill)) continue;
      const total = matchedWith(new Set([...chosen, skill]));
      const near = reachable.filter((r) => r.missing.includes(skill)).length;
      const better =
        !best ||
        total > best.total ||
        (total === best.total && (near > best.near || (near === best.near && skill.localeCompare(best.skill) < 0)));
      if (better) best = { skill, total, near };
    }
    if (!best) break;
    chosen.push(best.skill);
    ladder.push({ skill: best.skill, added: best.total - matched, total: best.total });
    matched = best.total;
  }
  return { ladder, maxAdd, reachable };
}
