// Which jobs count for each course. A job's course is decided from its title only.
//
// searchTerms: what we search for on every platform (each term = one Apify run per platform).
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
    searchTerms: ['data analyst', 'power bi developer', 'mis analyst'],
    strong: [
      'data analyst', 'data analytics', 'mis analyst', 'mis executive', 'bi analyst', 'bi developer',
      'business intelligence', 'reporting analyst', 'power bi', 'powerbi', 'tableau developer',
      'analytics analyst', 'product analyst', 'insights analyst', 'sql analyst', 'business data analyst',
    ],
    weak: ['tableau', 'mis', 'analytics', 'reporting', 'dashboard'],
    exclude: [],
    teaches: ['SQL', 'Python', 'Excel', 'Power BI', 'Tableau', 'Data Visualization', 'Statistics', 'Pandas'],
  },
  {
    id: 'data-science',
    name: 'Data Science',
    searchTerms: ['data scientist', 'machine learning engineer'],
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
    searchTerms: ['data engineer', 'etl developer'],
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
    searchTerms: ['production support', 'application support'],
    strong: [
      'production support', 'application support', 'prod support', 'l1 support', 'l2 support',
      'l3 support', 'l2 l3 support', 'support analyst', 'application operations', 'it operations',
      'site reliability engineer', 'sre', 'incident manager', 'incident management', 'major incident',
    ],
    weak: ['support engineer', 'technical support', 'servicenow', 'itil', 'monitoring', 'noc', 'command center'],
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

// Titles containing these never count for any course.
export const GLOBAL_EXCLUDE = ['data entry', 'trainer', 'faculty', 'tutor', 'teacher', 'professor', 'lecturer'];
