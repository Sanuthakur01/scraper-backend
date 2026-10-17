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
