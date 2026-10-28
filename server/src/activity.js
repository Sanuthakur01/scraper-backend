// What changed in a job's HR details, for the activity record (models.js Activity): compared field
// by field between what the dashboard showed before a save and what it shows after.
//
// Lists (HR names, HR profile links, phone numbers, emails, students): which values were added and which removed. A phone number
// written differently ("98765 43210" -> "+91 98765 43210") is the same number, so it isn't counted as
// removed and added again; the field then shows as edited with its old and new spelling.

import { phoneKey } from './normalize.js';
import { HR_SOURCES } from './api/followUp.js';

const split = (value) => String(value ?? '').split(/\s*,\s*/).filter(Boolean);

// Each field: its values from a contact view (followUp.js contactView), and how two values are compared.
const FIELDS = [
  { field: 'hrName', values: (c) => c.hrNames ?? [], key: (v) => v.toLowerCase() },
  { field: 'hrProfile', values: (c) => c.hrProfiles ?? [], key: (v) => v.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '') },
  { field: 'phone', values: (c) => split(c.phone), key: (v) => phoneKey(v) || v },
  { field: 'email', values: (c) => split(c.email), key: (v) => v.toLowerCase() },
  { field: 'foundBy', values: (c) => (c.foundBy ? [HR_SOURCES[c.foundBy] ?? c.foundBy] : []), key: (v) => v },
  { field: 'assignedTo', values: (c) => c.assignedTo ?? [], key: (v) => v.toLowerCase() },
  { field: 'remarks', values: (c) => (c.remarks ? [c.remarks] : []), key: (v) => v },
];

// The changes between two contact views: [{ field, change, before, after, added, removed }], one per
// field that changed (none: []). change: 'added' (it was empty), 'removed' (it is empty now) or 'edited'.
export function contactChanges(before, after) {
  const changes = [];
  for (const { field, values, key } of FIELDS) {
    const was = values(before);
    const now = values(after);
    if (was.join('\n') === now.join('\n')) continue;
    const wasKeys = new Set(was.map(key));
    const nowKeys = new Set(now.map(key));
    const list = field !== 'remarks' && field !== 'foundBy'; // one value: before -> after
    changes.push({
      field,
      change: !was.length ? 'added' : !now.length ? 'removed' : 'edited',
      before: was,
      after: now,
      added: list ? now.filter((v) => !wasKeys.has(key(v))) : [],
      removed: list ? was.filter((v) => !nowKeys.has(key(v))) : [],
    });
  }
  return changes;
}

// All the changes of one save in a word: added (everything was new), removed (everything went), or edited.
export function overallAction(changes) {
  if (changes.every((c) => c.change === 'added')) return 'added';
  if (changes.every((c) => c.change === 'removed')) return 'removed';
  return 'edited';
}
