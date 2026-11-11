// Who may use the dashboard, and what each role may do. The same rules as the dashboard's
// client/lib/access.ts (keep the two the same): the dashboard hides what a role can't do, and this
// server refuses it.
//
// A person's role is in their Clerk public metadata, e.g. { "role": "RESEARCH_TEAM" }.

export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'PLACEMENT_STAFF', 'RESEARCH_TEAM', 'STUDENT_MANAGEMENT', 'PRE_PLACEMENT_STAFF'];

// Other spellings of a role that mean the same role (after case, spaces and hyphens are forgiven).
const ROLE_ALIASES = new Map([
  ['PREPLACEMENT_STAFF', 'PRE_PLACEMENT_STAFF'],
  ['PREEPLACEMENT_STAFF', 'PRE_PLACEMENT_STAFF'],
]);

// view             - read the dashboard's data (here: the activity record)
// edit-hr-details  - add or change a job's HR phone numbers, emails, students and notes
// record-outcomes  - in the performance report: give an HR number or email to a student, and record how it went
// view-ai-usage    - see how much each person uses IJF AI (questions, tokens)
// add-jobs         - add a job opening the collector missed (with its HR contact), and remove one they added
// manage-interviews - the LMS's "Today's Interviews": add, change and take out the day's interviews (the roles the
//                     LMS's placement page lets in; src/api/lmsInterviews.js)
export const PERMISSIONS = {
  SUPER_ADMIN: ['view', 'edit-hr-details', 'record-outcomes', 'view-ai-usage', 'add-jobs', 'manage-interviews'],
  ADMIN: ['view', 'edit-hr-details', 'record-outcomes', 'view-ai-usage', 'add-jobs', 'manage-interviews'],
  PLACEMENT_STAFF: ['view', 'edit-hr-details', 'record-outcomes', 'add-jobs', 'manage-interviews'],
  RESEARCH_TEAM: ['view', 'edit-hr-details', 'record-outcomes', 'add-jobs'],
  STUDENT_MANAGEMENT: ['view', 'edit-hr-details', 'record-outcomes', 'add-jobs'], // since 4 Nov 2026, as Placement staff
  PRE_PLACEMENT_STAFF: ['view', 'edit-hr-details', 'record-outcomes', 'add-jobs', 'manage-interviews'], // since 10 Nov 2026, as Placement staff
};

// The role written in public metadata, as typed there.
export function rawRole(publicMetadata) {
  const value = publicMetadata && typeof publicMetadata === 'object' ? publicMetadata.role : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

// The person's role, or null when it is missing or not one of ROLES. Letter case, spaces and hyphens
// are forgiven: "research_team", "Research Team" and "RESEARCH-TEAM" all mean RESEARCH_TEAM; so are
// the other spellings in ROLE_ALIASES ("Preplacement staff" means PRE_PLACEMENT_STAFF).
export function roleFrom(publicMetadata) {
  const typed = rawRole(publicMetadata).toUpperCase().replace(/[\s-]+/g, '_');
  const role = ROLE_ALIASES.get(typed) ?? typed;
  return ROLES.includes(role) ? role : null;
}

export const can = (role, permission) => Boolean(role) && (PERMISSIONS[role] ?? []).includes(permission);
