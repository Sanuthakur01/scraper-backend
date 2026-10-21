// Who may use the dashboard, and what each role may do. The same rules as the dashboard's
// client/lib/access.ts (keep the two the same): the dashboard hides what a role can't do, and this
// server refuses it.
//
// A person's role is in their Clerk public metadata, e.g. { "role": "RESEARCH_TEAM" }.

export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'PLACEMENT_STAFF', 'RESEARCH_TEAM'];

// view             - read the dashboard's data (here: the activity record)
// edit-hr-details  - add or change a job's HR phone numbers, emails, students and notes
export const PERMISSIONS = {
  SUPER_ADMIN: ['view', 'edit-hr-details'],
  ADMIN: ['view', 'edit-hr-details'],
  PLACEMENT_STAFF: ['view', 'edit-hr-details'],
  RESEARCH_TEAM: ['view', 'edit-hr-details'],
};

// The role written in public metadata, as typed there.
export function rawRole(publicMetadata) {
  const value = publicMetadata && typeof publicMetadata === 'object' ? publicMetadata.role : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

// The person's role, or null when it is missing or not one of ROLES. Letter case, spaces and hyphens
// are forgiven: "research_team", "Research Team" and "RESEARCH-TEAM" all mean RESEARCH_TEAM.
export function roleFrom(publicMetadata) {
  const role = rawRole(publicMetadata).toUpperCase().replace(/[\s-]+/g, '_');
  return ROLES.includes(role) ? role : null;
}

export const can = (role, permission) => Boolean(role) && (PERMISSIONS[role] ?? []).includes(permission);
