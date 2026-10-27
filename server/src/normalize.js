// Turns messy job fields (titles, locations, experience text) into clean, comparable values.

// Lowercase, accents removed, punctuation turned into spaces, padded with one space on each side
// so phrases can be matched as whole words: hasPhrase(matchText('Sr. Data-Analyst'), 'data analyst').
export function matchText(value) {
  const text = String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents: "Hyderābād" -> "hyderabad", not "hydera bad"
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
  return text ? ` ${text} ` : ' ';
}

export const hasPhrase = (text, phrase) => text.includes(` ${phrase} `);

export const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export const stripHtml = (html) =>
  cleanText(
    String(html ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&'),
  );

const titleCase = (value) => value.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// ---------- Locations ----------

const CITY_GROUPS = [
  ['Bengaluru', ['bengaluru', 'bangalore']],
  ['Hyderabad', ['hyderabad', 'secunderabad']],
  ['Pune', ['pune', 'pimpri chinchwad']],
  ['Chennai', ['chennai', 'madras']],
  ['Mumbai', ['mumbai', 'bombay', 'navi mumbai', 'thane']],
  ['Delhi NCR', ['delhi', 'new delhi', 'noida', 'greater noida', 'gurugram', 'gurgaon', 'faridabad', 'ghaziabad', 'ncr']],
  ['Kolkata', ['kolkata', 'calcutta']],
  ['Ahmedabad', ['ahmedabad', 'gandhinagar']],
  ['Kochi', ['kochi', 'cochin', 'ernakulam']],
  ['Thiruvananthapuram', ['thiruvananthapuram', 'trivandrum']],
  ['Coimbatore', ['coimbatore']],
  ['Jaipur', ['jaipur']],
  ['Chandigarh', ['chandigarh', 'mohali', 'panchkula']],
  ['Indore', ['indore']],
  ['Nagpur', ['nagpur']],
  ['Vadodara', ['vadodara', 'baroda']],
  ['Surat', ['surat']],
  ['Bhubaneswar', ['bhubaneswar', 'bhubaneshwar']],
  ['Lucknow', ['lucknow']],
  ['Mysuru', ['mysuru', 'mysore']],
  ['Mangaluru', ['mangaluru', 'mangalore']],
  ['Visakhapatnam', ['visakhapatnam', 'vizag']],
  ['Vijayawada', ['vijayawada']],
  ['Madurai', ['madurai']],
  ['Bhopal', ['bhopal']],
  ['Nashik', ['nashik']],
  ['Patna', ['patna']],
  ['Ranchi', ['ranchi']],
  ['Guwahati', ['guwahati']],
  ['Dehradun', ['dehradun']],
  ['Hosur', ['hosur']],
  ['Goa', ['goa', 'panaji']],
];

const CITY_ALIASES = CITY_GROUPS.flatMap(([city, aliases]) => aliases.map((alias) => ({ city, alias })));

// Single words that name a place; dropped from titles when building the duplicate key.
export const PLACE_WORDS = new Set(CITY_ALIASES.flatMap(({ alias }) => alias.split(' ')).concat('india'));

const INDIA_STATES = [
  'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'gujarat', 'haryana',
  'himachal pradesh', 'jharkhand', 'karnataka', 'kerala', 'madhya pradesh', 'maharashtra', 'manipur',
  'meghalaya', 'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab', 'rajasthan', 'sikkim', 'tamil nadu',
  'telangana', 'tripura', 'uttar pradesh', 'uttarakhand', 'west bengal', 'jammu', 'kashmir', 'ladakh',
  'puducherry', 'pondicherry',
];

const REMOTE_WORDS = ['remote', 'work from home', 'wfh', 'anywhere in india'];

// Cities the dashboard doesn't show (user request, 27 Oct 2026). A remote job that names no city is
// stored with the city "Remote" (parseLocation); the stored jobs keep it, only city lists and job
// details leave it out.
export const HIDDEN_CITIES = ['Remote'];
export const shownCities = (cities) => (cities ?? []).filter((city) => !HIDDEN_CITIES.includes(city));

// Returns every known city named in the text, in the order they appear.
// Unknown places keep their first comma-separated part, e.g. "Hosur, Tamil Nadu" -> "Hosur".
export function parseLocation(locationText) {
  const text = matchText(locationText);
  const found = [];
  for (const { city, alias } of CITY_ALIASES) {
    const at = text.indexOf(` ${alias} `);
    if (at !== -1) found.push({ city, at });
  }
  found.sort((a, b) => a.at - b.at);
  const cities = [...new Set(found.map((f) => f.city))];
  const isRemote = REMOTE_WORDS.some((word) => hasPhrase(text, word));

  if (!cities.length) {
    const first = cleanText(String(locationText ?? '').split(/[,;|]/)[0]);
    if (isRemote) cities.push('Remote');
    else if (/^india$/i.test(first)) cities.push('India (city not stated)');
    else if (first) cities.push(titleCase(first));
  }
  return { cities, isRemote };
}

// True when the location looks Indian. An empty location counts as India because every search is India-only.
export function isIndiaLocation(locationText) {
  const text = matchText(locationText);
  if (!text.trim()) return true;
  return (
    hasPhrase(text, 'india') ||
    REMOTE_WORDS.some((word) => hasPhrase(text, word)) ||
    CITY_ALIASES.some(({ alias }) => hasPhrase(text, alias)) ||
    INDIA_STATES.some((state) => hasPhrase(text, state))
  );
}

// ---------- Experience ----------

const YEARS = String.raw`(?:yrs?|years?)`;
const EXPERIENCE_PATTERNS = [
  // "3-6 yrs", "2 to 5 years", "0–3 Yrs"
  { re: new RegExp(String.raw`(?<![\d.])(\d{1,2})(?:\.\d)?\s*(?:-|–|—|to)\s*(\d{1,2})(?:\.\d)?\s*\+?\s*${YEARS}`, 'i'), hasMax: true },
  // "5+ years"
  { re: new RegExp(String.raw`(?<![\d.])(\d{1,2})\s*\+\s*${YEARS}`, 'i'), hasMax: false },
  // "minimum 3 years", "at least 2 yrs"
  { re: new RegExp(String.raw`(?:minimum|min\.?|at\s*least|atleast)\s*(?:of\s*)?(\d{1,2})\s*${YEARS}`, 'i'), hasMax: false },
  // "4 years of relevant experience"
  { re: new RegExp(String.raw`(?<![\d.])(\d{1,2})\s*${YEARS}\s*(?:of\s*)?(?:[a-z-]+\s+){0,2}?(?:experience|exp)\b`, 'i'), hasMax: false },
];
const FRESHER = /\bfreshers?\b|\bentry[\s-]level\b|\binternship\b|\bgraduate trainee\b/i;

// LinkedIn gives a seniority level instead of years; used only when no years are written anywhere.
const LEVEL_MIN_YEARS = [
  ['internship', 0],
  ['entry level', 0],
  ['associate', 2],
  ['mid senior level', 5],
  ['director', 10],
  ['executive', 12],
];

export function parseExperience(...texts) {
  for (const raw of texts) {
    const text = String(raw ?? '').slice(0, 5000);
    if (!text) continue;
    for (const { re, hasMax } of EXPERIENCE_PATTERNS) {
      const m = text.match(re);
      if (!m) continue;
      const min = Number(m[1]);
      const max = hasMax ? Number(m[2]) : null;
      if (min > 30) continue;
      return { min, max: max != null && max >= min ? max : null };
    }
    if (FRESHER.test(text)) return { min: 0, max: null };
  }
  return { min: null, max: null };
}

export function experienceFromLevel(level) {
  const text = matchText(level);
  const hit = LEVEL_MIN_YEARS.find(([name]) => hasPhrase(text, name));
  return hit ? { min: hit[1], max: null } : { min: null, max: null };
}

// The minimum years a job asks for, as a filter value: 'fresher', '1' ... '5', '5+' (more than 5 years,
// i.e. 6 or more) or 'unknown'.
export function experienceBand(min) {
  if (min == null) return 'unknown';
  if (min <= 0) return 'fresher';
  if (min > 5) return '5+';
  return String(min);
}

// ---------- Duplicate detection ----------

const COMPANY_NOISE = new Set([
  'private', 'pvt', 'limited', 'ltd', 'llp', 'llc', 'inc', 'incorporated', 'corporation', 'corp', 'co',
  'company', 'india', 'in', 'the', 'plc', 'gmbh',
]);

const TITLE_NOISE = new Set([
  'urgent', 'urgently', 'hiring', 'opening', 'openings', 'immediate', 'immediately', 'joiner', 'joiners',
  'wfh', 'remote', 'hybrid', 'onsite', 'office', 'work', 'from', 'home', 'for', 'with', 'job', 'jobs',
  'position', 'role', 'opportunity', 'required', 'requirement', 'and', 'in', 'at', 'of', 'the', 'a', 'an',
  'contract', 'permanent', 'full', 'time', 'fulltime', 'c2h', 'new', 'yrs', 'yr', 'years', 'year', 'exp',
  'walk', 'walkin', 'drive',
]);

const TITLE_SYNONYMS = { sr: 'senior', snr: 'senior', jr: 'junior', engg: 'engineer', eng: 'engineer', dev: 'developer' };

// Legal names (often used by Glassdoor) -> the name other platforms use. Matched on whole leading
// words after cleaning, so "Hennes & Mauritz AB" ("hennes mauritz ab") -> "h m ab", which matches "H&M".
// Add a line here when the same employer keeps showing up twice under different names.
const COMPANY_ALIASES = [
  ['hennes mauritz', 'h m'],
  ['ernst young', 'ey'],
  ['citigroup', 'citi'],
  ['ual', 'united airlines'],
  ['j c penney', 'jcpenney'],
  ['jp morgan chase', 'jpmorganchase'],
  ['jpmorgan chase', 'jpmorganchase'],
  ['j p morgan', 'jpmorganchase'],
  ['jpmorgan', 'jpmorganchase'],
  ['tata consultancy services', 'tcs'],
  ['international business machines', 'ibm'],
  ['pricewaterhousecoopers', 'pwc'],
  ['larsen toubro', 'l t'],
  ['hcl technologies', 'hcltech'],
];

export function companyKey(name) {
  const key = matchText(name)
    .trim()
    .split(' ')
    .filter((word) => word && !COMPANY_NOISE.has(word))
    .join(' ');
  for (const [alias, canonical] of COMPANY_ALIASES) {
    if (key === alias || key.startsWith(`${alias} `)) return canonical + key.slice(alias.length);
  }
  return key;
}

// Order-insensitive: "Data Analyst (SQL, Power BI)" and "Power BI / SQL Data Analyst" give the same key.
export function titleKey(title) {
  const withoutYears = String(title ?? '').replace(
    /(?<![\d.])\d{1,2}(?:\.\d)?\s*(?:-|–|to)?\s*\d{0,2}\s*\+?\s*(?:yrs?|years?)/gi,
    ' ',
  );
  const words = matchText(withoutYears)
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => TITLE_SYNONYMS[word] ?? word)
    .filter((word) => !TITLE_NOISE.has(word) && !PLACE_WORDS.has(word));
  return [...new Set(words)].sort().join(' ');
}

// Same company + same title + same first city = the same job, whichever platform it came from.
// Without a company name we can't tell jobs apart, so the platform's own ID is used instead.
export function fingerprintFor({ company, title, city, platform, sourceId }) {
  const companyPart = companyKey(company);
  if (!companyPart) return `${platform}:${sourceId}`.toLowerCase();
  const titlePart = titleKey(title) || matchText(title).trim();
  return `${companyPart}|${titlePart}|${String(city ?? '').toLowerCase()}`;
}

// ---------- Skills ----------

// The skills we look for in postings: [name, phrases that mean it]. Short or common words are matched
// only in phrases that can't mean anything else ("R" only as "r programming", "python and r", ...).
// After changing this list, run `npm run refresh-skills` to re-read the stored jobs' raw postings.
const SKILLS = [
  // Analysis and reporting
  ['SQL', ['sql']],
  ['Python', ['python']],
  ['R', ['r programming', 'r language', 'rstudio', 'r studio', 'python r', 'python and r', 'python or r', 'r and python', 'r or python', 'sql r', 'r sql']],
  ['Excel', ['excel', 'advanced excel']],
  ['Excel VBA/Macros', ['vba', 'excel macros', 'macros']],
  ['Power BI', ['power bi', 'powerbi']],
  ['DAX', ['dax']],
  ['Power Query', ['power query']],
  ['Tableau', ['tableau']],
  ['Looker', ['looker']],
  ['Qlik', ['qlik', 'qlikview', 'qlik sense']],
  ['Alteryx', ['alteryx']],
  ['Microsoft Fabric', ['microsoft fabric', 'ms fabric']],
  ['Google Analytics', ['google analytics', 'ga4']],
  ['Data Visualization', ['data visualization', 'data visualisation']],
  ['SAS', ['sas']],
  ['Statistics', ['statistics', 'statistical']],
  // Data science and AI
  ['Pandas', ['pandas']],
  ['NumPy', ['numpy']],
  ['Machine Learning', ['machine learning']],
  ['Deep Learning', ['deep learning']],
  ['NLP', ['nlp', 'natural language processing']],
  ['Computer Vision', ['computer vision', 'opencv']],
  ['Generative AI', ['generative ai', 'gen ai', 'genai']],
  ['LLM', ['llm', 'llms', 'large language model', 'large language models']],
  ['RAG', ['retrieval augmented generation', 'rag pipeline', 'rag pipelines', 'rag based', 'rag systems', 'rag applications']],
  ['LangChain', ['langchain', 'lang chain']],
  ['Hugging Face', ['hugging face', 'huggingface']],
  ['TensorFlow', ['tensorflow']],
  ['Keras', ['keras']],
  ['PyTorch', ['pytorch']],
  ['Scikit-learn', ['scikit learn', 'sklearn']],
  ['MLOps', ['mlops', 'ml ops', 'mlflow']],
  // Data engineering
  ['Spark', ['spark', 'pyspark', 'apache spark']],
  ['Scala', ['scala']],
  ['Databricks', ['databricks']],
  ['Snowflake', ['snowflake']],
  ['Airflow', ['airflow']],
  ['Kafka', ['kafka']],
  ['Hadoop', ['hadoop', 'hive']],
  ['dbt', ['dbt']],
  ['ETL', ['etl']],
  ['Informatica', ['informatica']],
  ['SSIS', ['ssis']],
  ['Talend', ['talend']],
  ['Data Warehousing', ['data warehouse', 'data warehouses', 'data warehousing', 'dwh']],
  ['Data Modeling', ['data modeling', 'data modelling']],
  ['Redshift', ['redshift']],
  ['Azure Synapse', ['synapse']],
  ['NoSQL', ['nosql', 'no sql']],
  ['MongoDB', ['mongodb', 'mongo db']],
  ['PostgreSQL', ['postgresql', 'postgres']],
  ['MySQL', ['mysql']],
  // Cloud and DevOps
  ['Azure', ['azure']],
  ['Azure Data Factory', ['azure data factory', 'adf']],
  ['AWS', ['aws', 'amazon web services']],
  ['GCP', ['gcp', 'google cloud', 'bigquery']],
  ['Git', ['git', 'github', 'gitlab']],
  ['CI/CD', ['ci cd', 'jenkins']],
  ['Terraform', ['terraform']],
  ['Kubernetes', ['kubernetes', 'k8s']],
  ['Docker', ['docker']],
  // Production support
  ['Linux/Unix', ['linux', 'unix']],
  ['Shell scripting', ['shell scripting', 'shell script', 'bash']],
  ['PowerShell', ['powershell']],
  ['Windows Server', ['windows server']],
  ['Incident management', ['incident management']],
  ['Problem management', ['problem management']],
  ['Change management', ['change management']],
  ['Root cause analysis', ['root cause analysis', 'root cause', 'rca', 'postmortem', 'post mortem', 'post incident review']],
  ['Log analysis', ['log analysis', 'log monitoring', 'analyzing logs', 'analysing logs', 'log files']],
  ['Hotfix deployment', ['hotfix', 'hotfixes', 'hot fix', 'hot fixes']],
  ['Ticket handling', ['ticket resolution', 'ticketing', 'ticket management', 'ticketing tool', 'ticketing tools']],
  ['SLA management', ['sla', 'slas', 'service level agreement', 'service level agreements']],
  ['Escalation management', ['escalation management', 'escalations', 'escalation handling']],
  ['On-call support', ['on call', 'oncall', 'on call support']],
  ['24x7 support', ['24x7', '24 7', '24 x 7']],
  ['Rotational shifts', ['rotational shift', 'rotational shifts', 'rotating shifts', 'shift support']],
  ['Batch monitoring', ['batch monitoring', 'batch job monitoring', 'batch jobs monitoring', 'batch support']],
  ['Job scheduling', ['job scheduling', 'job scheduler', 'job schedulers', 'scheduling tools']],
  ['Health checks', ['health check', 'health checks']],
  ['Monitoring and alerting', ['system monitoring', 'application monitoring', 'proactive monitoring', 'alert management', 'alerting', 'monitoring tools']],
  ['Performance tuning', ['performance tuning']],
  ['Capacity planning', ['capacity planning']],
  ['Disaster recovery', ['disaster recovery', 'business continuity', 'bcp']],
  ['Release management', ['release management', 'deployment support', 'release support']],
  ['Hypercare', ['hypercare', 'hyper care', 'post production support']],
  // Not "knowledge base": AI posts use it for RAG.
  ['Runbooks and SOPs', ['runbook', 'runbooks', 'run book', 'run books', 'sop', 'sops', 'knowledge articles', 'kb articles']],
  ['Outage management', ['outage management', 'service restoration', 'outages']],
  ['Data fixes', ['data fix', 'data fixes']],
  ['Configuration management', ['configuration management', 'cmdb']],
  ['Patch management', ['patch management', 'patching']],
  ['Environment management', ['environment management']],
  ['UAT support', ['uat support', 'uat']],
  ['ServiceNow', ['servicenow', 'service now']],
  ['ITIL', ['itil']],
  ['Splunk', ['splunk']],
  ['Grafana', ['grafana']],
  ['Dynatrace', ['dynatrace']],
  ['AppDynamics', ['appdynamics']],
  ['Jira', ['jira']],
  ['Control-M', ['control m']],
  ['Autosys', ['autosys']],
  ['Oracle', ['oracle']],
  ['PL/SQL', ['pl sql', 'plsql']],
  ['Java', ['java']],
];

// Every skill name we track, in the order above.
export const SKILL_NAMES = SKILLS.map(([name]) => name);

// "excel" as a verb ("you will excel in this role") is not the skill.
const NOT_A_SKILL = / (?:to excel|excel at|excel in (?:a|an|the|this|your|our|their|every|fast|dynamic|high)) /g;

export function extractSkills(text, extra = []) {
  const haystack = matchText([text, ...extra].join(' ')).replace(NOT_A_SKILL, '  ');
  return SKILLS.filter(([, patterns]) => patterns.some((p) => hasPhrase(haystack, p))).map(([name]) => name);
}

// ---------- Contact details ----------

// Recruiters sometimes write an email or phone number into the posting ("Share your CV at
// hr@acme.in / 98765 43210"). Only what the posting's own text says is used.
const MAX_CONTACTS = 3;
const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
// Mailboxes for something other than applying: disability adjustments, compliance, privacy, fraud...
const OTHER_MAILBOXES =
  /accommodat|disabilit|accessib|complian|privacy|gdpr|data.?protect|ethic|fraud|scam|security|legal|no.?reply|do.?not.?reply|unsubscribe|webmaster|postmaster|abuse|whistle/i;
const NOT_EMAIL = /\.(png|jpe?g|gif|svg|webp)$|@(example|domain|email|company)\.com$/i;
// "...reach hr@acme.com.Thanks" runs on into the next sentence: drop domain endings that aren't real.
const COMMON_TLDS = new Set([
  'com', 'in', 'co', 'org', 'net', 'ai', 'io', 'info', 'biz', 'edu', 'gov', 'ac', 'us', 'uk', 'au', 'ca', 'de',
  'fr', 'sg', 'ae', 'nl', 'jp', 'eu', 'me', 'tech', 'app', 'dev', 'global', 'jobs', 'careers', 'solutions',
  'consulting', 'services', 'digital', 'cloud', 'online', 'xyz', 'today', 'work', 'world', 'pro',
]);

function trimEmail(email) {
  const [local, domain] = email.split('@');
  const labels = domain.split('.');
  while (labels.length > 2 && !COMMON_TLDS.has(labels.at(-1))) labels.pop();
  return `${local}@${labels.join('.')}`;
}
// 10 to 12 digits, with up to two spaces, dots, dashes or brackets between them, not inside a word or ID.
const PHONE_CANDIDATE = /(?<![\w@#=])\+?\d(?:[\s.()-]{0,2}\d){9,11}(?![\w@])/g;
const ID_BEFORE = /\b(?:job|req|requisition|ref|reference|code|id)\b[^0-9]{0,12}$/i;
const DUMMY_PHONE = /^(\d)\1{9}$|^9876543210$|^9123456789$|^9012345678$/;

// An Indian phone number as "+91 98765 43210", or null. Mobiles may be written alone; landlines need
// their STD code (080 41234567) and a 12-digit number needs its 91 (+91 80 4123 4567).
function indianPhone(written) {
  const digits = written.replace(/\D/g, '');
  let national = null;
  if (digits.length === 10 && /^[6-9]/.test(digits)) national = digits;
  else if (digits.length === 11 && /^0[1-9]/.test(digits)) national = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('91') && (written.includes('+') ? /^[1-9]/ : /^[6-9]/).test(digits.slice(2))) {
    national = digits.slice(2);
  }
  if (!national || DUMMY_PHONE.test(national)) return null;
  return formatIndianPhone(national);
}

// "9845012345" -> "+91 98450 12345": how found phone numbers are stored.
export const formatIndianPhone = (national) => `+91 ${national.slice(0, 5)} ${national.slice(5)}`;

// The same number however it is written: "+91 98450-12345", "098450 12345" and "9845012345" all give
// "9845012345". Indian numbers lose their +91 / 0 prefix; other numbers keep all their digits.
export function phoneKey(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 14 && digits.startsWith('0091')) return digits.slice(4);
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

// { phones: ['+91 98765 43210'], emails: ['hr@acme.in'] } from a posting's text (at most 3 of each).
export function extractContacts(...texts) {
  const text = texts
    .filter(Boolean)
    .join('\n')
    .replace(/&#0*64;|&#x0*40;/gi, '@')
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@') // hr [at] acme [dot] in
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.');

  const emails = [];
  for (const [match] of text.matchAll(EMAIL)) {
    const email = trimEmail(match.toLowerCase());
    if (OTHER_MAILBOXES.test(email.split('@')[0]) || NOT_EMAIL.test(email) || emails.includes(email)) continue;
    if (emails.push(email) >= MAX_CONTACTS) break;
  }

  const phones = [];
  const withoutLinks = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ').replace(EMAIL, ' ');
  for (const match of withoutLinks.matchAll(PHONE_CANDIDATE)) {
    if (ID_BEFORE.test(withoutLinks.slice(Math.max(0, match.index - 25), match.index))) continue;
    const phone = indianPhone(match[0]);
    if (!phone || phones.includes(phone)) continue;
    if (phones.push(phone) >= MAX_CONTACTS) break;
  }
  return { phones, emails };
}
