// Which jobs count for each course. A job's course is decided from its title only.
//
// searchTerms: what we search for on every platform (each term = one Apify run per platform).
// linkedinSearchTerms: the searches LinkedIn runs, a few of searchTerms. LinkedIn is the expensive platform
//              ($0.40 per 1,000 results on Apify), so it runs the titles that find the most there; Naukri and
//              Glassdoor (free) and Indeed (Apify, $0.10 per 1,000) run every search. Picked on 24 Oct 2026 from
//              which searches found jobs no other search found: on LinkedIn, Production Support's 37 searches
//              mostly return the same jobs, while each Data Science / Data Analyst / Data Engineering search
//              finds many of its own. About $0.90 a day on LinkedIn, plus about $0.88 on Indeed.
// searchLimits (optional): results to read per search on these platforms, instead of the usual
//              (APIFY_LIMIT_PER_SEARCH, NAUKRI_LIMIT_PER_SEARCH, ...), for a course whose searches have more.
// extraSearchTerms: searched every day too, to find more of a course's jobs; but what these find is a
//              non-filtered job (leftOutBy 'extra-search' when it passes the keep rules), so the dashboard's
//              main (Filtered) numbers come from searchTerms alone. A job a searchTerms search keeps is a
//              kept job as usual.
// strong:      phrases that clearly name the role. The longest matching phrase wins across courses,
//              so "data analytics engineer" goes to Data Engineering ("analytics engineer" is longer).
// weak:        used only when no course has a strong match.
// exclude:     titles containing these never go to that course.
// teaches:     the skills the course teaches (names from SKILLS in src/normalize.js). The dashboard's
//              "Skills that would open up more jobs" card ranks the skills NOT in this list.
//
// Phrases are lowercase words separated by spaces. Punctuation in titles is ignored,
// so "AI/ML Engineer" matches "ai ml engineer" and "L2/L3 Support" matches "l2 l3 support".
// After changing these rules, run `npm run reclassify` to re-sort the jobs already stored.

export const COURSES = [
  {
    id: 'data-analyst',
    name: 'Data Analyst',
    // Job titles, each searched on its own (added 24 Oct 2026, like Production Support's): a narrower
    // search finds jobs a broad one misses once it reaches its result limit. Each is a title the rules
    // below already put in this course.
    searchTerms: [
      'data analyst', 'power bi developer', 'mis analyst',
      'business intelligence analyst', 'business intelligence developer', 'reporting analyst', 'product analyst',
      'tableau developer', 'power bi analyst', 'power bi consultant', 'insights analyst', 'data analytics specialist',
      'analytics consultant',
    ],
    linkedinSearchTerms: [
      'data analyst', 'power bi developer', 'mis analyst', 'business intelligence analyst', 'reporting analyst',
      'product analyst',
    ],
    extraSearchTerms: ['mis executive', 'business analyst'],
    strong: [
      'data analyst', 'data analytics', 'mis analyst', 'mis executive', 'bi analyst', 'bi developer',
      'business intelligence', 'reporting analyst', 'power bi', 'powerbi', 'tableau developer',
      'analytics analyst', 'product analyst', 'insights analyst', 'sql analyst', 'business data analyst',
    ],
    // "business analyst" only when no course has a strong match: "Business Analyst - Production Support"
    // stays Production Support.
    weak: ['tableau', 'mis', 'analytics', 'reporting', 'dashboard', 'business analyst'],
    exclude: [],
    teaches: ['SQL', 'Python', 'Excel', 'Power BI', 'Tableau', 'Data Visualization', 'Statistics', 'Pandas'],
  },
  {
    id: 'data-science',
    name: 'Data Science',
    // Job titles, each searched on its own (added 24 Oct 2026); each one the rules below put in this course.
    searchTerms: [
      'data scientist', 'machine learning engineer',
      'ai engineer', 'ai ml engineer', 'generative ai engineer', 'llm engineer', 'deep learning engineer',
      'computer vision engineer', 'nlp engineer', 'mlops engineer', 'applied scientist', 'machine learning scientist',
      'data science consultant',
    ],
    linkedinSearchTerms: ['data scientist', 'machine learning engineer', 'ai engineer', 'generative ai engineer', 'computer vision engineer'],
    strong: [
      'data scientist', 'data science', 'machine learning engineer', 'ml engineer', 'ai engineer',
      'ai ml engineer', 'ai ml developer', 'ai developer', 'mlops', 'ml ops', 'nlp engineer',
      'computer vision engineer', 'deep learning engineer', 'applied scientist', 'generative ai engineer',
      'gen ai engineer', 'genai engineer', 'llm engineer',
    ],
    weak: [
      'machine learning', 'deep learning', 'artificial intelligence', 'generative ai', 'gen ai', 'genai',
      'llm', 'nlp', 'computer vision', 'ai ml', 'ml',
    ],
    exclude: [],
    teaches: [
      'SQL', 'Python', 'Statistics', 'Pandas', 'NumPy', 'Machine Learning', 'Deep Learning', 'NLP', 'TensorFlow',
      'Scikit-learn',
    ],
  },
  {
    id: 'data-engineering',
    name: 'Data Engineering',
    // Job titles, each searched on its own (added 24 Oct 2026); each one the rules below put in this course.
    searchTerms: [
      'data engineer', 'etl developer',
      'big data engineer', 'azure data engineer', 'aws data engineer', 'gcp data engineer', 'databricks engineer',
      'pyspark developer', 'spark developer', 'snowflake developer', 'informatica developer', 'analytics engineer',
      'data warehouse developer', 'data platform engineer', 'data architect',
    ],
    linkedinSearchTerms: ['data engineer', 'etl developer', 'azure data engineer', 'aws data engineer', 'databricks engineer'],
    strong: [
      'data engineer', 'data engineering', 'etl developer', 'etl engineer', 'big data', 'analytics engineer',
      'data warehouse', 'dwh', 'databricks', 'pyspark', 'spark developer', 'snowflake developer',
      'snowflake engineer', 'informatica', 'data pipeline', 'azure data factory', 'adf developer',
      'data platform engineer', 'data integration',
    ],
    weak: ['spark', 'snowflake', 'etl', 'airflow', 'kafka', 'hadoop', 'hive', 'dbt', 'data architect'],
    exclude: ['etl tester', 'etl testing'],
    // Saved by the team on the dashboard on 17 Oct 2026.
    teaches: [
      'SQL', 'Python', 'Spark', 'Databricks', 'Airflow', 'Hadoop', 'ETL', 'Data Warehousing', 'Azure',
      'Azure Data Factory', 'GCP',
    ],
  },
  {
    id: 'production-support',
    name: 'Production Support',
    // The team's Production Support titles (23 Oct 2026), each searched on its own: a narrower search
    // finds jobs a broad one misses once it reaches its result limit.
    searchTerms: [
      'production support', 'application support',
      'production support engineer', 'application support engineer', 'production support analyst',
      'application support analyst', 'l1 support engineer', 'l2 support engineer', 'l3 support engineer',
      'technical support engineer', 'it support engineer', 'systems support engineer', 'software support engineer',
      'product support engineer', 'operations support engineer', 'it operations engineer',
      'application operations engineer', 'run support engineer', 'support analyst', 'incident management engineer',
      'major incident manager', 'noc engineer', 'command center analyst', 'devops support engineer',
      'cloud support engineer', 'middleware support engineer', 'batch support engineer', 'mainframe support engineer',
      'erp support analyst', 'sap support consultant', 'database support engineer', 'release support engineer',
      'production control analyst', 'platform support engineer', 'service desk engineer', 'technical operations engineer',
    ],
    extraSearchTerms: ['site reliability engineer'],
    linkedinSearchTerms: [
      'production support', 'major incident manager', 'product support engineer', 'service desk engineer',
      'incident management engineer', 'technical support engineer',
    ],
    // Naukri lists about 450-500 new postings a day for "production support", "application support" and
    // "site reliability engineer" (23 Oct 2026); 200 read only the newest 40%. Both are free (no Apify).
    searchLimits: { Naukri: 500, Glassdoor: 200 },
    strong: [
      'production support', 'application support', 'prod support', 'l1 support', 'l2 support',
      'l3 support', 'l2 l3 support', 'support analyst', 'application operations', 'it operations',
      'site reliability engineer', 'sre', 'incident manager', 'incident management', 'major incident',
      'sap support', 'production control analyst', 'service desk engineer', 'technical operations',
      'run support', 'batch support', 'mainframe support', 'middleware support', 'devops support', 'database support',
      'release support', 'platform support', 'operations support engineer', 'systems support engineer',
      'system support engineer', 'noc engineer', 'command center analyst',
      // Support titles the searches found that matched nothing (23 Oct 2026)
      'site reliability', 'service reliability engineer', 'reliability ops', 'application maintenance',
      'applications support', 'level 2 support', 'level 3 support', 'second level support', 'third level support',
      'sql support', 'siebel support', 'dynamics 365 support', 'erp support', 'crm support', 'service operations engineer',
      // ServiceNow roles are this course's (it teaches ServiceNow), also "ServiceNow Business Analyst"
      'servicenow',
    ],
    weak: ['support engineer', 'technical support', 'itil', 'monitoring', 'noc', 'command center', 'reliability engineer'],
    exclude: [
      'customer', 'voice', 'non voice', 'chat process', 'bpo', 'kpo', 'call center', 'call centre',
      'telecaller', 'tele caller', 'sales', 'desktop support', 'hardware', 'field support', 'inbound', 'outbound',
    ],
    teaches: [
      'SQL', 'Linux/Unix', 'Shell scripting', 'Incident management', 'ServiceNow', 'ITIL', 'Jira', 'Control-M',
      'Autosys', 'PL/SQL',
    ],
  },
];

// Every search a course runs: its searchTerms, then its extraSearchTerms (extra: true). On a platform that
// runs only some (source.onlyTerms, e.g. LinkedIn: linkedinSearchTerms), only those.
export const searchesOf = (course, source = null) => {
  const all = [
    ...course.searchTerms.map((term) => ({ term, extra: false })),
    ...(course.extraSearchTerms ?? []).map((term) => ({ term, extra: true })),
  ];
  const only = source?.onlyTerms?.(course);
  return only ? all.filter((s) => only.includes(s.term)) : all;
};

// Titles containing these never count for any course.
export const GLOBAL_EXCLUDE = ['data entry', 'trainer', 'faculty', 'tutor', 'teacher', 'professor', 'lecturer'];
