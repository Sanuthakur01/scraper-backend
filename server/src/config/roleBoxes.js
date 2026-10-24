// Boxes on the dashboard that gather one role's openings by job title, from the Filtered and Non-filtered
// jobs alike (GET /api/role-jobs?role=). Added 24 Oct 2026 for SRE.
//   title: the job titles that are this role; not: titles that look like it but aren't.

export const ROLE_BOXES = [
  {
    id: 'sre',
    name: 'SRE Openings',
    // "Site Reliability Engineer", "SRE", "Service Reliability Engineer", and the "... Reliability Engineer"
    // family (Systems, Database, Cloud, Platform); not hardware quality jobs ("Quality & Reliability Engineer").
    title: /site\s*reliability|\bsre\b|service reliability|reliability engineer/i,
    not: /quality|qlty/i,
  },
];

// The Mongo query for a role's job titles.
export const roleTitleQuery = (role) => ({ $and: [{ title: role.title }, { title: { $not: role.not } }] });
