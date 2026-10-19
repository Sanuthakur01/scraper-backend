import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillGaps, skillPlan } from '../src/skillGaps.js';

const postings = [
  { skills: ['SQL', 'Excel'] }, // covered now
  { skills: ['SQL', 'Azure'] }, // only Azure missing
  { skills: ['Power BI', 'Azure'] }, // only Azure missing
  { skills: ['SQL', 'Azure', 'Alteryx'] }, // two missing: neither alone covers it
  { skills: ['Alteryx'] }, // only Alteryx missing
  { skills: [] }, // names no skill: left out of every share
  {},
];

test('counts, for each skill not taught, the postings asking for it and the postings it alone would cover', () => {
  const result = skillGaps(postings, ['SQL', 'Excel', 'Power BI']);
  assert.equal(result.postings, 7);
  assert.equal(result.named, 5, 'postings naming no skill are not counted');
  assert.equal(result.coveredNow, 1);
  assert.deepEqual(result.skills, [
    { skill: 'Azure', asking: 3, gained: 2, coveredAfter: 3 },
    { skill: 'Alteryx', asking: 2, gained: 1, coveredAfter: 2 },
  ]);
});

test('skills already taught are never suggested, and a repeated skill in one posting counts once', () => {
  const result = skillGaps([{ skills: ['Azure', 'Azure', 'SQL'] }], ['SQL', 'Azure']);
  assert.deepEqual([result.coveredNow, result.skills], [1, []]);
  assert.deepEqual(skillGaps([{ skills: ['Kafka', 'Kafka'] }], []).skills, [{ skill: 'Kafka', asking: 1, gained: 1, coveredAfter: 1 }]);
});

test('the plan adds skills one after another, each time the one that matches the most extra postings', () => {
  const jobs = [
    { skills: ['SQL', 'AWS'] }, // AWS alone
    { skills: ['AWS'] }, // AWS alone
    { skills: ['AWS', 'Docker'] }, // AWS + Docker
    { skills: ['Docker', 'Kafka'] }, // Docker + Kafka
    { skills: ['Azure'] }, // Azure alone
    { skills: ['A', 'B', 'C', 'D', 'E'] }, // 5 missing: out of reach
  ];
  const { ladder, reachable, maxAdd } = skillPlan(jobs, ['SQL'], { steps: 3 });
  assert.equal(maxAdd, 4);
  assert.deepEqual(ladder, [
    { skill: 'AWS', added: 2, total: 2 },
    { skill: 'Docker', added: 1, total: 3 },
    { skill: 'Azure', added: 1, total: 4 },
  ]);
  assert.equal(reachable.length, 5, 'the posting missing 5 skills is out of reach');
  assert.deepEqual(reachable.find((r) => r.posting === jobs[3]).missing, ['Docker', 'Kafka']);
});
