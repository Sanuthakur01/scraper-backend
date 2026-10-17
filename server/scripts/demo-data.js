// Fake actor output for the demo, shaped like each real Apify actor's items so it runs through
// the real cleaning, course-matching and duplicate-merging code. Company names are clearly fake.
import { COURSES } from '../src/config/courses.js';

const TITLES = {
  'data-analyst': ['Data Analyst', 'Senior Data Analyst', 'MIS Analyst', 'Power BI Developer', 'Business Intelligence Analyst', 'Reporting Analyst - SQL', 'Data Analyst (Excel, SQL)'],
  'data-science': ['Data Scientist', 'Senior Data Scientist', 'Machine Learning Engineer', 'AI/ML Engineer', 'NLP Engineer', 'Generative AI Engineer'],
  'data-engineering': ['Data Engineer', 'Senior Data Engineer', 'Azure Data Engineer', 'ETL Developer', 'Big Data Engineer', 'PySpark Developer'],
  'production-support': ['Production Support Engineer', 'Application Support Analyst', 'L2 Support Engineer', 'L3 Application Support', 'Site Reliability Engineer', 'Production Support Analyst - Unix/SQL'],
};
// Titles the course rules should reject.
const NOISE_TITLES = ['Customer Support Executive', 'Data Entry Operator', 'Voice Process Associate', 'Data Science Trainer'];

const SKILLS = {
  'data-analyst': ['SQL', 'Excel', 'Power BI', 'Tableau', 'Python'],
  'data-science': ['Python', 'Machine Learning', 'Deep Learning', 'NLP', 'TensorFlow', 'LLM', 'SQL'],
  'data-engineering': ['SQL', 'Python', 'Spark', 'Databricks', 'Azure Data Factory', 'Airflow', 'Snowflake', 'AWS'],
  'production-support': ['Linux', 'Unix', 'SQL', 'ServiceNow', 'ITIL', 'Splunk', 'Shell scripting', 'Control-M'],
};

const CITIES = [
  ['Bengaluru', 'Karnataka', 24], ['Hyderabad', 'Telangana', 15], ['Pune', 'Maharashtra', 13], ['Chennai', 'Tamil Nadu', 11],
  ['Gurugram', 'Haryana', 9], ['Mumbai', 'Maharashtra', 9], ['Noida', 'Uttar Pradesh', 7], ['Kolkata', 'West Bengal', 4],
  ['Ahmedabad', 'Gujarat', 3], ['Kochi', 'Kerala', 2], ['Coimbatore', 'Tamil Nadu', 2],
];
const COMPANIES = Array.from({ length: 45 }, (_, i) => `Demo Company ${String(i + 1).padStart(2, '0')} Pvt Ltd`);
// Jobs per search.
const PLATFORM_VOLUME = { LinkedIn: 15, Naukri: 14, Indeed: 7, Glassdoor: 4 };
const LEVELS = ['Entry level', 'Associate', 'Mid-Senior level'];

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (text) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

// fetchOne(source, input) for perSearch(): one search's fake results in that source's own format.
export function createDemoFetcher(now, dayIndex) {
  return async function fetchOne(source, input) {
    const { platform } = source;
    const term = input.keywords ?? input.title ?? input.keyword;
    const course = COURSES.find((c) => c.searchTerms.includes(term));
    const rand = seededRandom(hash(`${platform}|${term}|${dayIndex}`));
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const pickCity = () => {
      let r = rand() * CITIES.reduce((sum, c) => sum + c[2], 0);
      for (const c of CITIES) if ((r -= c[2]) < 0) return c;
      return CITIES[0];
    };

    const weekday = new Date(now).getUTCDay();
    const weekFactor = weekday === 0 || weekday === 6 ? 0.45 : 1;
    const growth = 1 + (20 - dayIndex) * 0.012;
    const count = Math.round(PLATFORM_VOLUME[platform] * weekFactor * growth * (0.7 + rand() * 0.6));

    const items = Array.from({ length: count }, (_, i) => {
      const noise = rand() < 0.08;
      const title = noise ? pick(NOISE_TITLES) : pick(TITLES[course.id]);
      const company = pick(COMPANIES);
      const [city, state] = pickCity();
      const minYears = Math.floor(rand() * 7);
      const maxYears = minYears + 2 + Math.floor(rand() * 4);
      const skills = SKILLS[course.id].filter(() => rand() < 0.45);
      const id = `${dayIndex}${i}${Math.floor(rand() * 1e6)}`;
      const posted = new Date(now.getTime() - Math.floor(rand() * 20) * 3_600_000);
      const description = `Demo listing. Skills: ${skills.join(', ')}. ${minYears}-${maxYears} years of experience.`;
      switch (platform) {
        case 'LinkedIn':
          return { id, url: `https://www.linkedin.com/jobs/view/${id}`, title, companyName: company, location: `${city}, ${state}, India`, experienceLevel: pick(LEVELS), postedDate: posted.toISOString().slice(0, 10), salary: '', description };
        case 'Naukri': // Naukri's own search API format, as naukri_feed.py returns it
          return { jobId: id, jdURL: `/job-listings-demo-${id}`, title: `${title} (${minYears}-${maxYears} yrs)`, companyName: company, minimumExperience: String(minYears), maximumExperience: String(maxYears), createdDate: posted.getTime(), placeholders: [{ type: 'experience', label: `${minYears}-${maxYears} Yrs` }, { type: 'salary', label: 'Not disclosed' }, { type: 'location', label: city }], tagsAndSkills: skills.join(','), jobDescription: `<p>${description}</p>` };
        case 'Indeed':
          return { key: id, url: `https://in.indeed.com/viewjob?jk=${id}`, title, datePublished: posted.toISOString(), location: { city, countryCode: 'IN', countryName: 'India' }, employer: { name: company.replace(' Pvt Ltd', '') }, baseSalary: rand() < 0.3 ? { min: 400000, max: 900000, unitOfWork: 'YEAR', currencyCode: 'INR' } : null, description: { text: description } };
        default: // Glassdoor job cards, as glassdoor_feed.py returns them
          return { jobId: id, url: `https://www.glassdoor.co.in/job-listing/j?jl=${id}`, title, company, location: city, age: `${1 + Math.floor(rand() * 23)}h`, salary: '', snippet: description };
      }
    });
    return { runId: `demo-${platform}-${dayIndex}`, items };
  };
}
