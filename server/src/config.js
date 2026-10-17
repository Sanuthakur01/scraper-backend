import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Settings come from D:\ijf\.env or D:\ijf\server\.env (either works). Values already set in the
// environment win, which is how GitHub Actions and Render pass them in.
for (const envFile of [path.join(rootDir, '.env'), path.join(rootDir, 'server', '.env')]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // File not there: fine.
  }
}

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  rootDir,
  port: int(process.env.PORT, 3000),
  mongoUri: process.env.MONGODB_URI,
  apifyToken: process.env.APIFY_TOKEN,
  limitPerSearch: int(process.env.APIFY_LIMIT_PER_SEARCH, 100),
  apifyConcurrency: int(process.env.APIFY_CONCURRENCY, 3),
  retentionDays: int(process.env.RETENTION_DAYS, 90),
  // Only jobs whose minimum experience is within this range are kept (see config/filters.js).
  experience: { min: int(process.env.EXPERIENCE_MIN, 2), max: int(process.env.EXPERIENCE_MAX, 5) },
  dedupeWindowDays: int(process.env.DEDUPE_WINDOW_DAYS, 14),
  disabledSources: (process.env.DISABLED_SOURCES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // Naukri, Indeed and Glassdoor come from our Python scraper in naukri-scraper/, not Apify.
  scraper: {
    dir: process.env.NAUKRI_SCRAPER_DIR || path.join(rootDir, 'naukri-scraper'),
    python: process.env.NAUKRI_SCRAPER_PYTHON || '', // empty = the scraper's own .venv
    headless: process.env.SCRAPER_HEADLESS === '1', // Naukri blocks hidden browsers, so off by default
    timeoutMinutes: int(process.env.SCRAPER_TIMEOUT_MINUTES, 30),
    limitPerSearch: {
      Naukri: int(process.env.NAUKRI_LIMIT_PER_SEARCH, 200),
      Indeed: int(process.env.INDEED_LIMIT_PER_SEARCH, 100),
      Glassdoor: int(process.env.GLASSDOOR_LIMIT_PER_SEARCH, 100),
    },
  },
  // Every platform's raw results are written here before they are saved to the database, so nothing
  // is lost if saving fails; `npm run replay` loads them again. Kept 14 days.
  rawDir: path.join(rootDir, 'data', 'raw'),
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '',
  scheduleLabel: process.env.SCHEDULE_LABEL || 'Updated daily at 07:00 IST',
  brandName: process.env.BRAND_NAME || 'IJF', // on the weekly report image and WhatsApp text
  demo: process.env.DEMO_MODE === '1',
};
