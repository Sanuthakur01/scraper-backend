# India Job Tracker

A dashboard of new job openings in India for our four courses: Data Analyst, Data Science, Data Engineering and Production Support.

**One command does everything:** `npm run collect` scrapes all four platforms and saves the jobs to the database. Every morning at 07:00 IST, Windows Task Scheduler on an always-on PC runs it through [collect-daily.cmd](collect-daily.cmd).

```
npm run collect ──┬─► LinkedIn   (Apify)                                     ─┐  as each platform finishes:
                  ├─► Naukri     (naukri-scraper/scraper_file/naukri_feed.py)  ├─► raw results → data/raw/
                  ├─► Indeed     (naukri-scraper/scraper_file/indeed_feed.py)  │   clean → sort by course → merge duplicates
                  └─► Glassdoor  (naukri-scraper/scraper_file/glassdoor_feed.py)┘   → save to MongoDB Atlas
                                                    Browser ◄─ Next.js dashboard ◄─ Express API ◄─ MongoDB
```

1. **Search:** all four platforms run **at the same time**, with 9 search terms each, for jobs posted in the last day.
   - **LinkedIn** through an Apify actor. Apify is used only for LinkedIn.
   - **Naukri, Indeed and Glassdoor** through our own Python scraper in `naukri-scraper/`. Each one runs as its own Python process with its own Chrome window, so one can't break another. See [scraperFeed.js](server/src/collector/scraperFeed.js).
     - `naukri_feed.py` reads Naukri's own search API, reusing `NaukriSearch` from `naukri_bulk.py`.
     - `indeed_feed.py` reads the job data Indeed embeds in its search pages.
     - `glassdoor_feed.py` reads Glassdoor's job cards, reusing the Glassdoor code in `scraper.py`.
2. **Save each platform as soon as it finishes**, without waiting for the slower ones.
   1. Its raw results are written to `data/raw/` first (kept 14 days), so nothing is lost even if the database step fails.
   2. Then the jobs are cleaned, kept if in India, sorted into a course by title, merged with duplicates, and saved.
3. **Merge duplicates.** Each opening is stored once with **every platform's link**, using the rules in [jobPool.js](server/src/collector/jobPool.js):
   - **Same listing:** the same platform listing (same listing ID) is always the same job.
   - **Same company, title and city:** also catches reposts within 14 days.
   - **Written differently on another platform:** for example "HSBC" = "HSBC Holdings plc", "Hennes & Mauritz AB" = "H&M", "GCP Data Engineer" = "Walk-in || GCP Data Engineer - S", or a missing city.

   Different seniority ("Data Engineer" vs "Senior Data Engineer") or different cities keep openings apart. Two listings on the same platform are never merged by similarity alone. Each opening counts once, under the platform where it was posted first.

**Reliability, all automatic:**

| Risk | What happens |
|---|---|
| A search fails (e.g. Indeed "too many requests") | Retried once automatically (5 minutes later for "too many requests"). Other searches carry on |
| A whole platform fails (blocked, scraper crash, Apify down) | The other platforms are still saved. The run ends "partial" and the dashboard header shows the failed searches |
| The database is unreachable while saving | Saving is retried 3 times. Still failing: the next platform's save writes those jobs too. Still failing: the raw file in `data/raw/` keeps them, and `npm run replay` loads them later, free |
| A save is repeated | New jobs get their database ID before the first attempt, so a retry can't create a second record |
| Two collections at once (scheduler + manual) | The second one stops: "Another collection is already running" |
| A collection is stopped halfway (Ctrl+C, window closed, crash) | Ctrl+C or closing the window closes the scraper browsers and releases the lock; jobs already saved stay saved. After a crash, the next run on the same PC sees the old process is gone and starts at once. A run on another PC is released when it hasn't sent a heartbeat for 3 minutes |
| The same listing saved twice by mistake | The database itself refuses a second record for the same platform listing |

The dashboard reads from MongoDB. It is a Next.js + TypeScript app in `client/`, built to static files that the Express API in `server/` serves, so one Render service hosts both.

**Course pages:** click any course tile on the dashboard to open its page, e.g. `/course/data-analyst?days=7`. The page uses the same period as the dashboard and shows:
- that course's new jobs and the change vs the previous period
- where they came from: jobs per platform, plus how many were listed on several
- how old the postings were when found, and how fresh the data is
- the daily trend, top companies, cities, experience levels and skills
- the course's own filterable job list

The data comes from `GET /api/course/:id?days=1|7|30`, and its total always equals the dashboard tile.

**Skills that would open up more jobs** (on the dashboard, below "Most-requested skills by course"). For each course, the card ranks the skills it doesn't teach yet by how many more real postings students would match if the course added that skill. The numbers are counts of the postings this dashboard collected, not estimates. [server/src/skillGaps.js](server/src/skillGaps.js) defines them:
- **Fully automatic:** it's recalculated from the collected postings after every collection, with nothing to click or set on the dashboard.
- **What each course teaches:** the `teaches` list of each course in [server/src/config/courses.js](server/src/config/courses.js), shown on the card. All the numbers depend on it. When a syllabus changes, edit that list once; the next page load uses it.
- **Postings naming it:** how many of the course's postings name the skill.
- **More postings fully covered:** postings where this is the *only* skill they name that the course doesn't teach. Adding it would cover every skill they name.
- **Fully covered after adding:** the course's coverage before and after, as a count and a share.
- **What's included:**
  - The postings are the same ones the course's tile counts for the selected period.
  - Only postings that name at least one of the 79 tracked skills are included; the card says how many name none.
  - The card shows the date range, the platforms, and when the data was last updated.
  - With fewer than 30 postings it warns that the numbers are only a rough signal.
- **Limits, also stated on the card:**
  - Skills are found by name in the posting text we collect. Indeed and Glassdoor give only a short summary, so some of their skills are missed.
  - It counts postings, not hiring results.
- The skill list is `SKILLS` in [server/src/normalize.js](server/src/normalize.js). After changing it, run `npm run refresh-skills -- --dry-run`, then `npm run refresh-skills`. That re-reads stored jobs' skills from `data/raw/` (kept 14 days).

**HR contact columns (Phone number, Email ID, Remarks):** the job list on each course page has these three columns. Click a course tile to get there. The main dashboard has no job list.
- **Filled in automatically:** the collector reads phone numbers and emails that the posting itself contains, such as "Share your CV at hr@acme.in / 98765 43210", or Naukri's "hiring for" line. These show with the label "from the job post".
  - It skips job IDs, salaries, dates, numbers inside links, placeholder numbers like 9876543210, and mailboxes that aren't for applying (accommodations@, compliance@, privacy@ …).
  - Only postings that contain contact details get them. That's roughly 1 in 20 on LinkedIn and 1 in 40 on Naukri. Indeed and Glassdoor search results only include a short snippet, so they almost never have contacts.
- **Typed in by hand:** click **Add** (or **Edit**) on a row, type the HR phone, email and a remark, then click **Submit** or press Enter. It's saved to the database at once through `PUT /api/jobs/:id/contact`. Escape cancels. Two numbers or emails can be separated by a comma. A wrong format is refused with a message saying what to fix.
- **No phone number twice:** a number that another job already has is refused with **"This number already exists."**, plus a line naming that job. That covers numbers typed in or found in a posting, however they are written ("+91 98450-12345" = "098450 12345" = "9845012345").
  - A job can always save its own numbers again, e.g. when only the remarks change.
  - When a job's number is cleared, it can be used elsewhere.
- **Typed-in details always win and are never lost:**
  - They are shown instead of what the posting says.
  - They are stored separately (`manual` on the job), and collections never write that field.
  - The 90-day cleanup, `npm run reclassify` and `npm run dedupe` never delete them; dedupe moves them to the kept copy.
  - Clearing all three fields and clicking Submit removes them.
- The **Download CSV** file includes the three columns.
- Anyone who can open the dashboard can edit these. Once it's online, set `DASHBOARD_PASSWORD`.

**Placement tracking:** the same Edit button on a job also records placement progress. Pick a status (Contacted, CVs sent, Interview, Placed, Closed (no hire)), enter the students' names and, for Placed, how many got the job. One Submit saves everything (`PUT /api/jobs/:id/follow-up`).
- The **Placements** card on the dashboard shows, per course, how many jobs are at each stage, plus students placed this month and last month. A placement counts in the month it was first marked Placed; saving the job again later doesn't move it.
- In a course's job list, the first filter ("All jobs" / "Being worked on" / a status) shows the jobs at that stage **from all dates**, not only the period.
- Like HR contacts, placement data is never changed by a collection and never deleted by the 90-day cleanup, `reclassify` or `dedupe`.

**Weekly report** (menu: Weekly report, `/report`): the latest 7 days, ready to share, with nothing to prepare.
- It updates itself after every collection; on a Monday it covers the past week.
- **Download image** saves a 1080×1350 PNG (fits Instagram and LinkedIn). **Copy text for WhatsApp** copies the same report as a message.
- It shows new openings per course and their top skills, the top hiring companies (each company once, however it's spelled) and the top cities.
- The change against the week before appears only once collection has covered a full earlier week, so a half-empty week is never compared.
- The name at the top comes from `BRAND_NAME` (default IJF).

**Hiring partners** (menu: Hiring partners, `/partners`): companies with 2 or more openings for your courses in the last 90 days. Large IT services firms are already excluded.
- Each row shows what the company hires for, where, when it last posted, its HR contacts (from any of its jobs, typed-in ones first) and your placements with it.
- **Download CSV** for the sales team.

## Try it now with demo data

You don't need any accounts for this. It runs everything with fake data in a temporary database.

```
npm install
npm run build
npm run demo
```

Then open http://localhost:3000. The first run downloads a temporary MongoDB, which is large and takes a few minutes.

## Setup with real data

### 0. Get the code

The tracker is three folders side by side. This repository is the backend and goes at the top:

```
git clone https://github.com/Sanuthakur01/scraper-backend.git ijf
cd ijf
git clone https://github.com/Sanuthakur01/scraper-frontend.git client     # the dashboard
git clone https://github.com/Hyperion101010/naukri-scraper.git            # the Python scraper (Naukri, Indeed, Glassdoor)
npm install
```

Then copy `.env.example` to `.env` (or `server/.env`) and fill it in. The backend alone (without `client`) can still collect and serve the API; `npm run build` needs `client`.

### 1. Accounts and keys

| What | Where | Put it in |
|---|---|---|
| Apify API token | apify.com → Console → Settings → API & Integrations | `APIFY_TOKEN` |
| MongoDB connection string | mongodb.com/atlas → free M0 cluster (Mumbai region) → Connect → Drivers | `MONGODB_URI` |

In Atlas → Network Access, allow `0.0.0.0/0`. GitHub Actions and Render don't have fixed IP addresses. The database is still protected by its username and password.

### 2. Scraper setup (once per PC)

The `naukri-scraper` folder must sit next to `server/` (or set `NAUKRI_SCRAPER_DIR`). Google Chrome must be installed: Indeed and Glassdoor run in it with their own saved profiles (`indeed_profile`, `chrome_profile`). Then give the scraper its own Python environment:

```
cd naukri-scraper
python -m venv .venv
.venv\Scripts\python -m pip install playwright beautifulsoup4
.venv\Scripts\python -m playwright install chromium
```

Naukri answers hidden (headless) browsers with HTTP 403. So the scraper opens real Chrome windows for a few minutes each run, one each for Naukri, Indeed and Glassdoor. That's why collection runs on a normal Windows PC, not a cloud server.

**Logins are optional; everything works without them:**
- **Indeed** shows visitors who aren't logged in only the first page (about 15 jobs) per search. The scraper fills in with the first page for each big city, so each search still gets up to `INDEED_LIMIT_PER_SEARCH` jobs. Logging in once lets it page through all of India instead: `.venv\Scripts\python scraper_file\indeed_feed.py --login`.
- **Glassdoor** works without a login. If it ever shows a login or "verify you are human" page, run `.venv\Scripts\python scraper_file\glassdoor_feed.py --login` once.

Sessions are saved in `indeed_profile` and `chrome_profile`. These folders hold browser logins, so never commit or share them.

### 3. Run it on your laptop

```
copy .env.example .env        (then fill in APIFY_TOKEN and MONGODB_URI; server\.env also works)
npm install
npm run collect               (all four platforms, 9 searches each; about 7 minutes; three Chrome windows open)
npm run build
npm start                     (open http://localhost:3000)
```

For development with live reload, run `npm run dev:server` (Express API, port 3000) in one terminal and `npm run dev:client` (Next.js, port 3001) in another, then open http://localhost:3001. The Next.js dev server forwards `/api` calls to Express.

### 4. Daily schedule (Windows Task Scheduler)

Use a PC that stays on and logged in, such as an office desktop. Then:

1. Open **Task Scheduler** → **Create Task**.
2. **General:** name it "Job dashboard collection" and choose **"Run only when user is logged on"**. The scrapers need a visible desktop.
3. **Triggers:** Daily at 07:00.
4. **Actions:** Start a program → `D:\ijf\collect-daily.cmd`.
5. **Settings:** tick "Run task as soon as possible after a scheduled start is missed".

Each day's output is written to `data\logs\collect-YYYY-MM-DD.log`. The dashboard header shows if any searches failed.

If that PC is off, collect LinkedIn alone from GitHub. Push this folder to a **private** GitHub repo; the `naukri-scraper` folder is excluded. Add the `MONGODB_URI` and `APIFY_TOKEN` secrets. Then use Actions → "LinkedIn-only collection (manual)" → **Run workflow**.

### 5. Put the dashboard online (Render)

Render → New → Web Service → connect the repo, then:

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Environment: `MONGODB_URI`, and `DASHBOARD_PASSWORD` to require a login (any username, this password)
- Health check path: `/api/health`

The free plan sleeps after 15 minutes idle, so the first page load then takes 30-60 seconds. The $7/month Starter plan stays on.

## Cost

- **Naukri, Indeed and Glassdoor** (our scraper) are free.
- **LinkedIn** (Apify) is charged per job returned, about $0.30-0.40 per 1,000 jobs. One run fetches at most 9 searches × `APIFY_LIMIT_PER_SEARCH` (100) = 900 jobs, which is about $0.36, or roughly **$11 a month** daily. Apify's free plan includes $5 a month, so a paid plan (Starter, $29/month) is needed for daily runs.
- **Coverage:** raising `NAUKRI_LIMIT_PER_SEARCH` (default 200), `INDEED_LIMIT_PER_SEARCH` (100) or `GLASSDOOR_LIMIT_PER_SEARCH` (100) gets more jobs for free. Runs take a little longer.

## Which jobs are kept

Besides matching a course, a job must pass two rules. Both are applied **before saving**, so other jobs never reach the database:

- **No large IT services firms.** The list is `EXCLUDED_COMPANIES` in [server/src/config/filters.js](server/src/config/filters.js): TCS, Infosys, IBM, Wipro, Accenture, Cognizant, HCL, Tech Mahindra, Capgemini, LTIMindtree, Genpact and others. It's the same list as `COMPANY_BLACKLIST` in the scraper's `scraper.py`. Name variants match too: "Tata Consultancy Services" = TCS, "IBM India Pvt Ltd" = IBM, "Infosys BPM" = Infosys.
- **2–5 years of experience.** The *minimum* experience a job asks for must be between `EXPERIENCE_MIN` and `EXPERIENCE_MAX` (default 2 and 5). For example, "3–6 yrs" is kept, while "0–2 yrs", "1–3 yrs" and "6+ yrs" are not.
  - A job that doesn't state its experience is kept only if it's the same job as one that does state 2–5 years on another platform. Then its link is added to that job.

Each run's summary shows how many jobs each rule left out. After changing either rule, run `npm run reclassify -- --dry-run` to preview the effect on stored jobs, then `npm run reclassify` to apply it.

## Changing what counts for each course

Edit [server/src/config/courses.js](server/src/config/courses.js):

- `searchTerms`: what each platform is searched for
- `strong` / `weak`: title phrases that put a job in that course
- `exclude`: phrases that keep a job out of that course

Then run `npm test` to check nothing broke, and update the stored jobs:

- `npm run reclassify` re-sorts the jobs already stored and removes ones that no longer match.
- `npm run replay` re-reads every platform's latest raw results from `data\raw\` (kept 14 days) through the new rules, so jobs the old rules rejected get added. It searches nothing again, so it's free. Jobs already stored are matched, not duplicated. It's also how you load a platform whose run said "NOT SAVED".

## If the same opening still shows up twice

The usual cause is an employer whose legal name differs from its everyday name, like "Citigroup Inc." and "Citi". Add the pair to `COMPANY_ALIASES` in [server/src/normalize.js](server/src/normalize.js), then run `npm run dedupe -- --dry-run` to check the merges and `npm run dedupe` to apply them.

## If a platform returns 0 jobs

**LinkedIn (Apify):** Apify actors are maintained by third parties, and job sites change their pages.

1. Open the latest run in Apify Console → Runs and check its log.
2. Check the actor's input fields against [server/src/config/sources.js](server/src/config/sources.js).
3. If the actor is broken, swap `actorId` for another actor and adjust its `buildInput` and `map` functions. Nothing else changes.

**Naukri, Indeed or Glassdoor (our scraper):** the day's log in `data\logs\` shows the scraper's own messages, starting `[naukri]`, `[indeed]` or `[glassdoor]`.

- **Naukri "HTTP 403" or "never made its search call (blocked?)":** Naukri refused the browser. Check that `SCRAPER_HEADLESS` is 0 and the PC is logged in, then try again later.
- **Indeed "HTTP 429" / "too many requests":** Indeed limits how fast one visitor may open pages. The scraper already opens a page only every 6–10 seconds. After a 429 it waits 1 minute, then 2, and slows down for the rest of the run. If 3 pages in a row are still refused, it stops Indeed for that run and keeps the jobs it already read. The remaining searches then show as failed ("RateLimited"), and the collector retries them once 5 minutes later. The other platforms are not affected. Indeed usually lifts the limit within minutes, so the next run is normal. To catch up right away without a LinkedIn (Apify) run: `set DISABLED_SOURCES=LinkedIn,Naukri,Glassdoor && npm run collect`. If it happens every day, log in once (`indeed_feed.py --login`), which needs fewer pages per search, or lower `INDEED_LIMIT_PER_SEARCH`.
- **Indeed "asked to sign in on the first page":** run `indeed_feed.py --login` once.
- **Glassdoor "block page" or 0 jobs on every search:** log in once with `glassdoor_feed.py --login`.
- **To test a scraper on its own:** run `cd naukri-scraper`, then `.venv\Scripts\python scraper_file\indeed_feed.py --limit 20 "data analyst"` (or `naukri_feed.py`, `glassdoor_feed.py`).

To skip a platform until it's fixed, set `DISABLED_SOURCES` to its name, e.g. `DISABLED_SOURCES=Glassdoor`. The other platforms keep working.

The dashboard header shows how many searches failed in the last run. Hover over it to see which ones.

## Commands

| Command | What it does |
|---|---|
| `npm run collect` | The whole pipeline: LinkedIn (Apify) + Naukri, Indeed and Glassdoor (scraper) → database. Needs `APIFY_TOKEN`, `MONGODB_URI`, and the scraper setup |
| `npm start` | Start the dashboard server (serves the built dashboard from `client/out`) |
| `npm run build` | Build the Next.js dashboard to static files |
| `npm run typecheck -w client` | Type-check the dashboard |
| `npm run demo` | Dashboard with fake data, no accounts needed |
| `npm run reclassify` | Apply changed course rules, excluded companies or experience range to stored jobs (add `-- --dry-run` to preview) |
| `npm run refresh-skills` | Re-read stored jobs' skills from `data/raw/` after changing the skill list (add `-- --dry-run` to preview) |
| `npm run replay` | Re-process the latest saved results of every platform with the current rules (free, no new searches) |
| `npm run dedupe` | Merge duplicate openings already stored (add `-- --dry-run` to preview first) |
| `npm test` | 38 tests: course matching, cleaning, duplicate merging, the pipeline's retries, lock and recovery, and the course page numbers |
