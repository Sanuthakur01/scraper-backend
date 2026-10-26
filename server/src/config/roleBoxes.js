// Boxes that gather one role's openings by job title, from the Filtered and Non-filtered jobs alike
// (GET /api/role-jobs?role=). Added 24 Oct 2026 for SRE (the dashboard tile and its page), 26 Oct for
// ServiceNow (a count on Hiring partners).
//   title: the job titles that are this role; not (optional): titles that look like it but aren't.

export const ROLE_BOXES = [
  {
    id: 'sre',
    name: 'SRE Openings',
    // "Site Reliability Engineer", "SRE", "Service Reliability Engineer", and the "... Reliability Engineer"
    // family (Systems, Database, Cloud, Platform); not hardware quality jobs ("Quality & Reliability Engineer").
    title: /site\s*reliability|\bsre\b|service reliability|reliability engineer/i,
    not: /quality|qlty/i,
  },
  {
    id: 'servicenow',
    name: 'ServiceNow Openings',
    // "ServiceNow Developer", "Servicenow Admin", "Service Now ITOM Consultant", "Package Consultant-ServiceNow".
    // Not the short "SNOW": in the stored titles it only ever stood for Snowflake.
    title: /service\s*-?now/i,
  },
];

// The Mongo query for a role's job titles.
export const roleTitleQuery = (role) => (role.not ? { $and: [{ title: role.title }, { title: { $not: role.not } }] } : { title: role.title });
