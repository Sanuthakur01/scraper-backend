# IJF HR Database

A dashboard of new job openings in India for our four courses: Data Analyst, Data Science, Data Engineering and Production Support.

**One command does everything:** `npm run collect` scrapes all four platforms and saves the jobs to the database. Every morning at 07:00 IST, Windows Task Scheduler on an always-on PC runs it through [collect-daily.cmd](collect-daily.cmd).

```
npm run collect ──┬─► LinkedIn   (Apify: valig/linkedin-jobs-scraper)        ─┐  as each platform finishes:
                  ├─► Indeed     (Apify: valig/indeed-jobs-scraper)          ├─► raw results → data/raw/
                  ├─► Naukri     (naukri-scraper/scraper_file/naukri_feed.py)  │   clean → sort by course → merge duplicates
                  └─► Glassdoor  (naukri-scraper/scraper_file/glassdoor_feed.py)┘   → save to MongoDB Atlas
                                                    Browser ◄─ Next.js dashboard ◄─ Express API ◄─ MongoDB
```

1. **Search:** all four platforms run **at the same time**. Naukri, Glassdoor and Indeed search all 80 search terms (77 main ones: job titles, 13 for Data Analyst, 13 for Data Science, 15 for Data Engineering and 36 for Production Support; and 3 **extra searches**, see [Filtered and Non-filtered data](#filtered-and-non-filtered-data)). LinkedIn, the expensive one, searches only 22 of them (`linkedinSearchTerms` in [courses.js](server/src/config/courses.js)): the titles that found the most jobs there. All look for jobs posted in the last day.
   - **LinkedIn and Indeed** through Apify actors, one Apify run per search, a few at a time (`APIFY_CONCURRENCY`).
     - Indeed moved from our scraper to Apify on 24 Oct 2026 (`valig/indeed-jobs-scraper`, $0.10 per 1,000 results). It no longer opens a Chrome window or hits Indeed's "too many requests" limit, and it gets each job's **full description**, so most Indeed jobs now say how much experience they ask for (the scraper only got a two-line snippet). Its date filter goes back at most 14 days, so a 30-day backfill reaches 14 days on Indeed. Job keys and links are the same as before, so Indeed jobs already saved are matched, not added again.
   - **Naukri and Glassdoor** through our own Python scraper in `naukri-scraper/`. Each one runs as its own Python process with its own Chrome window, so one can't break another. See [scraperFeed.js](server/src/collector/scraperFeed.js).
     - `naukri_feed.py` reads Naukri's own search API, reusing `NaukriSearch` from `naukri_bulk.py`.
     - `glassdoor_feed.py` reads Glassdoor's job cards, reusing the Glassdoor code in `scraper.py`.
     - `indeed_feed.py` (Indeed from its search pages) is still there, unused; to go back to it, see the comment at the top of [sources.js](server/src/config/sources.js).
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
| A search fails (e.g. a scraper is refused, "too many requests") | Retried once automatically (5 minutes later for "too many requests" or "blocked"). Other searches carry on |
| LinkedIn and Indeed can't run: no `APIFY_TOKEN`, or not enough Apify credit left this month | Checked before anything starts, with each platform's own price (the log says e.g. "this run uses about $1.78: LinkedIn $0.90, Indeed $0.88"). Both are skipped with the reason (credit left, what the run needs, when it resets); Naukri and Glassdoor are collected as usual |
| An Apify run takes longer than 15 minutes | It is waited for (up to 30 minutes) instead of being started again, so you never pay for the same search twice; one still going after that is stopped |
| The database can't be reached when the collection starts | Tried again after 20 seconds and 60 seconds before giving up |
| A scraper's Chrome profile is still open in another window (e.g. a `--login` window) | That platform's searches fail with "Close that window and run again"; the others carry on |
| A scraper runs too long | It is stopped after `SCRAPER_TIMEOUT_MINUTES` (default 30), or longer for more searches: Naukri and Glassdoor get at least 1 minute a search, more when a search reads more results (`minTimeoutMinutes` / `minutesPerSearch` in sources.js). Results already read are kept, and its unfinished searches are retried once in a fresh window |
| A whole platform fails (blocked, scraper crash, Apify down) | The other platforms are still saved. The run ends "partial" and each page's header names the sites that gave no new data (hover for the failed searches) |
| The database is unreachable while saving | Saving is retried 3 times. Still failing: the next platform's save writes those jobs too. Still failing: the raw file in `data/raw/` keeps them, and `npm run replay` loads them later, free |
| A save is repeated | New jobs get their database ID before the first attempt, so a retry can't create a second record |
| Two collections at once (scheduler + manual) | The second one stops: "Another collection is already running" |
| A collection is stopped halfway (Ctrl+C, window closed, crash) | Ctrl+C or closing the window closes the scraper browsers and releases the lock; jobs already saved stay saved. After a crash, the next run on the same PC sees the old process is gone and starts at once. A run on another PC is released when it hasn't sent a heartbeat for 3 minutes |
| The same listing saved twice by mistake | The database itself refuses a second record for the same platform listing |

The dashboard reads from MongoDB. It is a Next.js + TypeScript app in `client/`, built to static files that the Express API in `server/` serves, so one Render service hosts both.

**Sign-in and roles (Clerk).** The dashboard opens with a sign-in box; nothing of it, and none of its data, loads before someone has signed in with an allowed role.
- Only users whose Clerk **public metadata** has one of these roles get in: `SUPER_ADMIN`, `ADMIN`, `PLACEMENT_STAFF`, `RESEARCH_TEAM`, e.g. `{ "role": "RESEARCH_TEAM" }` (Clerk dashboard → Users → the user → Metadata → Public). Letter case, spaces and hyphens are forgiven.
- Anyone else who signs in sees **No access yet**, with their email and their current role, a **Sign out** button and **Check again** (for after an admin has set the role).
- Sign-ups are restricted in Clerk, so the sign-in box offers no sign-up; accounts are created or invited in Clerk.
- The top bar shows the signed-in person's role and an account menu (profile, sign out).
- What each role may do is in [client/lib/access.ts](client/lib/access.ts) (`PERMISSIONS`): every role may view and edit HR details for now. Taking `edit-hr-details` out of a role makes the details window read-only for it ("View only for your role").
- Setup: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in `client/.env.local` (or the host's settings), then rebuild (see [client/.env.example](client/.env.example)). The dashboard is static files, so it signs in in the browser and never uses the secret key.
- **Changes are checked on the server too.** Saving HR details sends the person's Clerk sign-in with it; the backend checks it with Clerk (`CLERK_SECRET_KEY`, see [.env.example](.env.example)), looks up their email and role, and refuses the save without an allowed role (401 not signed in, 403 no allowed role, 503 Clerk can't be reached). The server's rules are in [server/src/config/access.js](server/src/config/access.js) (keep them the same as `client/lib/access.ts`). Reading the job data doesn't need a sign-in yet.

**Activity record.** Every change to a job's HR details is recorded in the `activities` collection: who (their email, name, Clerk user id and role, all from Clerk, never from the browser), when, which job (its title, company and course are copied in, so the record survives the job), and, field by field (phone, email, assigned students, notes), whether it was **added**, **edited** or **removed**, with the values before and after and, for lists, which values were added and removed.
- The record is written before the change is saved, so no change is ever saved without one; if the save then fails, the record is removed again. Saving without changing anything, and refused saves (a wrong number, "This number already exists."), aren't recorded.
- A phone number only written differently ("98765 43210" → "+91 98765 43210") counts as edited, not removed and added.
- **The Activity tab** (top bar → Activity, `/activity`) shows it to everyone signed in: newest first, by day (Today, Yesterday, then dates, India time), each change with the person's name, email and role, the job (click it to open its details window; a job no longer stored says so) and, per field, the values added (green +), removed (red, struck out) or before → after. Filter by person, by kind (Added / Edited / Removed) or by job title or company; 30 at a time, **Show older** for more. A save made from a job opened there shows at the top straight away.
- `GET /api/activity` lists it, newest first (signed-in, allowed roles only): `?job=<id>` one job, `?email=` one person, `?action=added|edited|removed`, `?q=` job title or company, `?limit=` (up to 200), `?before=<the previous page's next>` the next page. The first page also has `total` and `people` (everyone who made changes, for the filter).
- Changes made by scripts (`reclassify`, `dedupe`, the collector moving details to a matching kept job) aren't recorded: only what people do on the dashboard.
- Trying the dashboard locally without a Clerk account: `NEXT_PUBLIC_TEST_SIGN_IN=1` (and `NEXT_PUBLIC_TEST_ROLE`, default `ADMIN`) with `npm run dev` in `client` skips the sign-in box and shows a yellow "Test sign-in (development only)" bar. It works only under `next dev`: a normal build leaves it out completely. The real backend refuses its token, so saving and the Activity tab need a real sign-in.

**Every page** has the same top bar (Dashboard, Performance report, Hiring partners, Activity) and a light/dark switch at the top right. Until someone picks one, the computer's own setting applies; the choice is remembered in that browser. Under each page title, "Updated today, 4:28 pm" says when the last collection finished.

**Dashboard** (`/`): the period buttons (Latest day, Last 7 days, Last 30 days, **Custom**), one number card for all courses and one coloured card per course, then three sections:
- **Market activity:** jobs per site (chart or table, with the biggest source, jobs listed on 2+ sites and how many sites had new jobs) and new jobs per day.
- **Who is hiring:** top companies, top cities, and the experience asked for (with the most common level called out).
- **Skills and curriculum:** the skill planner (below).

Each course keeps its colour everywhere; the indigo brand colour stands for all courses together.

**SRE Openings** (`/sre`, from the "SRE Openings" button at the top right of every page, under the Filtered / Non-filtered switch): every Site Reliability Engineer opening of the chosen period (its own Latest day / 7 / 30 days / Custom buttons), newest first, 25 at a time (Previous / Next). Like every page it follows the Filtered / Non-filtered switch: Filtered shows the Filtered SRE openings, Non-filtered the Non-filtered ones, each tagged with why ("Extra search", "Fresher"…). The box says how many the other set has ("+86 in Non-filtered →"), and one click switches. A job opens its details window, to add HR details as anywhere else.
- It finds them by job title: "Site Reliability…", "SRE", "Service Reliability…" and the "… Reliability Engineer" family (Systems, Database, Cloud), but not "Quality & Reliability Engineer" (hardware). The titles are in [roleBoxes.js](server/src/config/roleBoxes.js); another role's list is one more entry there and a page like [SreOpenings.tsx](client/components/SreOpenings.tsx).
- `GET /api/role-jobs?role=sre&days=7` (or `from`/`to`, `page`, `limit`, `view=nonfiltered`; signed-in only) answers it, with both sets' counts.

**Search box** (under the dashboard's title, for quick work): type a company, an HR person's name, a phone number or an email. Results appear as you type, in two groups:
- **Companies**: each company once, however the sites spell it, with its openings, how many the filters leave out, and per course. Click (or Enter) opens a side panel with all its stored openings and a pill per course (All courses, Data Analyst 3, …); a job opens its details window.
- **HR names and emails**, or **Phone numbers** when digits are typed: the jobs whose HR name, email or number matches, the matching part marked, with the job, company, course and HR names. Click (or Enter) opens the job's details window, where its details can be edited.
- A number is found however it was written: "+91 98765 43210", "098765-43210" and "98765 43210" are the same, and any part of it works (3 digits or more). Words need 2 letters or more.
- It searches every stored job, kept and left out by the filters (marked "Fresher", "Large IT services firm"…), in every course and period. ↑ ↓ move, Enter opens, Esc closes; **/** anywhere on the page jumps to the box.
- `GET /api/search?q=` (signed-in, allowed roles only) answers it: `companies` (at most 6, `moreCompanies`) and `contacts` (the 20 most recently updated jobs, each with `set` and `matches`, `moreContacts`).

**Custom period:** the **Custom** button (calendar icon) opens a small panel: **One day** (one date) or **Date range** (From and To, both days included). It opens on the days shown now and says which days have stored jobs; **Show** applies it, Esc or Cancel closes it. Every number on the page then counts the jobs first found on those days (India time): the cards, the charts, the side panel, the skill planner, the course pages and their job lists and CSV downloads. The button then shows the dates ("9–12 Oct"), and the cards compare with the same number of days just before ("vs the 4 days before"), when every one of those days was collected. The dates are in the page address (`/?from=2026-10-09&to=2026-10-12`), so a link or a reload keeps them, and they carry over to the course pages and back. The "New jobs per day" chart always shows the last 30 days.

**Every number on a chart is clickable** and shows the jobs it counts: a bar segment (one course on one site), a site's name or total, a cell of the platform table, "Biggest source" and "Listed on 2+ sites", a day on the trend chart, a company, a city, an experience column, or a most-requested skill.
- On the dashboard a panel opens on the right with those jobs (title, course, company, city, experience, salary, site links, HR contact), 20 at a time, with a CSV download. Esc, ✕ or a click outside closes it.
- On a course page the job list on the same page shows them instead and scrolls into view, with a chip naming the filter ("Company: EY", "Found on 17 Oct", "Skill: SQL"…) and × to remove it.
- The list always holds exactly the number that was clicked: the server counts the charts and filters the list with the same conditions (`/api/jobs` filters `primary`, `platform`, `company`, `city`, `skill`, `exp`, `age`, `day`, `sites`, `salary`; a test checks every chart number against its list).

**"▲ 12% vs previous 7 days"** appears only when a collection ran on every day of both periods. A day without a run (no schedule that day, PC off) has almost no new jobs, and the next run's count then holds two days, so the change would be a jump that didn't happen. Until both periods are fully collected, the card shows no % at all.

**Course pages:** click any course tile on the dashboard to open its page, e.g. `/course/data-analyst?days=7` (or `?from=…&to=…` for chosen dates). The page uses the same period as the dashboard, has buttons at the top to switch to another course, and shows:
- four cards: that course's **New jobs** (and the change vs the previous period, when it can be compared), jobs **Listed on 2+ sites**, the **Most asked experience**, and how many show a **Salary**. Click a card to see exactly the jobs it counts in the job list below; the list scrolls into view, and its number matches the card. **New jobs** shows them all again (so does the × on the filter, or Clear filters). The CSV download follows the same filter.
- where they came from: jobs per platform, plus how many were listed on several
- how old the postings were when found, and how fresh the data is
- the daily trend, top companies, cities, experience levels and skills
- the course's own filterable job list. After Job, Experience, Found on and Posted come the **HR columns**: Phone, Email, HR name, Assigned to and Notes (tinted headers; Phone and Email with their icons). **HR profile** is the last column, shown with Expand. Each cell shows what the job has as plain text, one value per line with a thin line between them: phone numbers (phone icon, click to call) and emails (mail icon, click to write), the first 3 and "+2 more" ("from the post" when they came from the job post); a notes cell shows its first two lines; an empty cell shows "—". Only the **pencil** beside a cell opens it for editing: the cell grows into a box to write in, one value per line (notes: as written), with ✓ Save and ✕ Cancel; only ✓ saves, and Esc, ✕ or a click outside put it back. Another cell's pencil switches to that cell. The same checks and limits as the details window apply (wrong numbers, "This number already exists.", up to 10 numbers / emails / names / links, 20 students), each change is recorded in the activity record, and "HR details for X of Y jobs" follows. The ← → buttons scroll the wider table while the Job column stays put; the company name still opens the job's details window.

The data comes from `GET /api/course/:id?days=1|7|30`, and its total always equals the dashboard tile.

**Periods in the API:** every endpoint with a period takes either `?days=N` (the last N days up to the day of the latest collection run) or `?from=YYYY-MM-DD&to=YYYY-MM-DD` (those IST days, both included; up to 366 days; `from` alone is one day). A date that doesn't exist or `from` after `to` is refused with 400 and says why. Answers include the period's `from` and `to`; `/api/meta` has `dataDays` (the oldest and newest day with stored jobs).

**Skill planner** (dashboard, "Skills and curriculum"). Pick a course: on the left, the skills its job posts ask for most; on the right, **Plan new skills**, which answers "if the course also taught 1, 2, 3… more skills, how many more job posts could students apply to?". The numbers are counts of the postings this dashboard collected, not estimates. [server/src/skillGaps.js](server/src/skillGaps.js) defines them:
- **Best skills to add, in order:** step 1 is the skill that matches the most extra job posts; each next step adds the skill that matches the most extra posts together with the ones before (e.g. "1. Oracle +10 jobs (+31%) · 2. + Java +15 (+47%)"). The % is compared with the posts the course matches now. Click a step to see its jobs.
- **Or try your own combination:** click up to 4 skill pills (each shows how many posts name it) to see how many posts that set would add.
- **The jobs it opens up:** each one with title, company, city, site link and the skills it needs.
- **Fully automatic:** it's recalculated from the collected postings after every collection, with nothing to click or set on the dashboard.
- **What each course teaches:** the `teaches` list of each course in [server/src/config/courses.js](server/src/config/courses.js), shown on the card. All the numbers depend on it. When a syllabus changes, edit that list once; the next page load uses it.
- A post counts as matched when the course teaches every skill it names. Posts needing more than 4 new skills are left out of the plan.
- **What's included:**
  - The postings are the same ones the course's tile counts for the selected period.
  - Only postings that name at least one of the 79 tracked skills are included; the card says how many name none.
  - The card shows the date range, the platforms, and when the data was last updated.
  - With fewer than 30 postings it warns that the numbers are only a rough signal.
- **Limits, also stated on the card:**
  - Skills are found by name in the posting text we collect. Glassdoor gives only a short summary, so some of its skills are missed. (Indeed gives the full description and its own skill tags since 24 Oct 2026.)
  - It counts postings, not hiring results.
- The skill list is `SKILLS` in [server/src/normalize.js](server/src/normalize.js). After changing it, run `npm run refresh-skills -- --dry-run`, then `npm run refresh-skills`. That re-reads stored jobs' skills from `data/raw/` (kept 14 days).

**Job list (course pages):** 4 columns: Job (title, company · city), Experience, Found on, Posted. Click a course card to get there; the main dashboard has no job list.
- **Click a company name** to open the job's details window (the same window opens from company names in the dashboard's chart panel). It shows:
  - the company and the job (course, city, experience, why it's left out in Non-filtered);
  - **HR contact & follow-up**: phone numbers and emails (click to call or email, or copy them), the students it is **assigned to**, and **notes**, with when they were last saved;
  - **Job details**: salary, work mode, when it was posted and found, the sites it's listed on (with links) and all its skills;
  - **More from the company**: its other openings under the same name in the last 90 days (click one to open it), and the HR contacts known from them.
- **Edit details** (or an "Add phone number" / "Add another …" button) turns the HR section into a form. **Save** saves it; it's greyed out until something changes. **Cancel** or Escape goes back without saving; Close, Escape again or a click outside the window closes it, discarding unsaved changes. Pressing Enter in a box never saves. While editing, other openings can't be opened until the changes are saved or cancelled.
  - Mistakes are shown under the box they're about, before anything is sent ("12345" is not a phone number…), and so are the server's refusals, such as "This number already exists.".
- Under each company name, small icons show what the job already has (📞 2 ✉ 1 👥 3 📝); clicking them opens the window too.
- Above the list, "HR details for 28 of 696 jobs" (a phone, email or note) shows how far the team has got. It moves as soon as details are saved.
- **Expand** adds Salary, Skills, Work mode and "Found by us"; **Fewer columns** goes back.
- **← →** next to Expand scroll the columns sideways when they don't all fit (greyed out when there's nothing more that way). On wider screens the Job column stays in place while the others scroll under it.
- Every site's fields are mapped to the same columns (see `map` in [server/src/config/sources.js](server/src/config/sources.js)); a value a site doesn't give shows "—" or "Not shown".
- **Filled in automatically:** the collector reads phone numbers and emails that the posting itself contains, such as "Share your CV at hr@acme.in / 98765 43210", or Naukri's "hiring for" line. These show with the label "from the job post".
  - It skips job IDs, salaries, dates, numbers inside links, placeholder numbers like 9876543210, and mailboxes that aren't for applying (accommodations@, compliance@, privacy@ …).
  - Only postings that contain contact details get them. That's roughly 1 in 20 on LinkedIn and 1 in 40 on Naukri. Glassdoor search results only include a short snippet, so they almost never have contacts. Indeed gives the full description since 24 Oct 2026, so its postings' contacts are found too.
- **Typed in by hand** (in the details window): the HR people's names and profile links, HR phone numbers, emails, students and notes, saved per job to the database at once through `PUT /api/jobs/:id/follow-up`. A wrong format is refused with a message naming the wrong entry.
  - **Assigned to:** the students the job is assigned to, one box per student (**+ Add another student**, up to 20; × removes one; the same name twice is kept once). They show as name tags, are kept in `manual.assignedTo`, in the CSV ("Assigned to"), and shown in the dashboard's job panel. Typing a student's name in the job search finds every job assigned to them. Students alone don't count towards "HR details for X of Y jobs".
  - **HR name** and **HR profile** (shown first): the HR person's name, and a link to their profile (LinkedIn, Naukri…), one box each, up to 10 of each per job. A link may be typed without "https://" ("linkedin.com/in/riya-sharma"), which is added; anything that isn't a web address (javascript:, mailto:, a plain word) is refused. Links show short ("linkedin.com/in/riya-sharma ↗") and open in a new tab. Kept in `manual.hrNames` / `manual.hrProfiles`, in the CSV ("HR name", "HR profile"), in the activity record, and they count towards "HR details for X of Y jobs". Typing an HR person's name in the job search finds their jobs. The performance report counts phone numbers and emails only.
  - **Several numbers and emails:** each phone number and email has its own box. **+ Add another number** / **+ Add another email** adds a box (up to 10 of each), and × removes one; empty boxes are ignored. The same number or address twice is kept once, and every number is checked against other jobs.
  - They're stored as one comma-separated text ("98765 43210, 080 4123 4567"), so the CSV and Hiring partners show all of them. The API also still accepts them that way.
- **No phone number twice:** a number that another job already has is refused with **"This number already exists."**, plus a line naming that job. That covers numbers typed in or found in a posting, however they are written ("+91 98450-12345" = "098450 12345" = "9845012345").
  - A job can always save its own numbers again, e.g. when only the remarks change.
  - When a job's number is cleared, it can be used elsewhere.
- **Typed-in details always win and are never lost:**
  - They are shown instead of what the posting says.
  - They are stored separately (`manual` on the job), and collections never write that field.
  - The 90-day cleanup, `npm run reclassify` and `npm run dedupe` never delete them; dedupe moves them to the kept copy.
  - Clearing every field and clicking Save removes them.
- The **Download CSV** file includes these columns (HR name, HR profile, Phone, Email, Assigned to, Remarks).
- Only signed-in people with an allowed role can open the dashboard and edit these (see **Sign-in and roles** above).

**IJF AI** (the **Ask IJF AI** button at the bottom right of every page, or Ctrl+K): ask anything about the dashboard's data in plain English or Hinglish and get the answer, without clicking through pages.
- **What it knows:** it looks things up with the dashboard's own code (the same numbers as the pages): new jobs per course and site, daily trend, top companies, cities, experience and skills, course pages, a job search (including "no HR details yet"), one job's details, the skill planner, hiring partners, the performance report and follow-ups, the activity record and the last collection. Every number comes from these look-ups; it says which period and view (Filtered / Non-filtered) it used. It knows the page it was opened on ("this course", "these jobs").
- **Contacts never go to OpenAI.** Every phone number and email, in a question or in anything it looks up (staff emails too), is replaced by a stand-in like `[phone 3]` on the server before anything is sent; the real value stays on the server and is put back only in what the person sees. HR contacts appear in a card with call, email and copy buttons. The tests check every request sent to the model.
- **Answers** stream in word by word ("Searching jobs…" while it looks), with cards: jobs (click one to open it; **Show in the job list** opens the course page with those filters, e.g. `/course/data-analyst?days=1&hr=none`), HR contacts, follow-ups. Small tables and lists are drawn as such; links go only to dashboard pages. **Stop** ends an answer.
- **Changes only with Confirm:** ask it to add HR details (numbers, emails, HR names, profile links, students, a note) or record a follow-up (student, remark), and it shows a card with exactly what will change. Nothing is saved until **Confirm**; then it goes through the same checks as the dashboard ("This number already exists." etc.) and is recorded in the activity record under the person's email, tagged **via IJF AI**. Every role can do this (as on the dashboard).
- **When opened:** **Today's briefing** (what changed since yesterday, written once a day for everyone and kept), **Needs attention** (counted without AI: numbers with no remark for 3+ days, contacts not given to a student, today's jobs without HR details, failed searches; click to ask, or **Open** the list), and questions to start with for that page.
- **Chats are kept** on the server for each person (**Your chats**: reopen or delete; **+** starts a new one). 👍 / 👎 and copy on each answer. Admins and super admins see **Usage** (questions and tokens per person in the last 30 days, 👍/👎).
- **Limits:** 50 questions per person per day (`AI_DAILY_LIMIT`); after that it says it will be ready again tomorrow, without a number. At most 6 look-ups per question, a 45-second time limit with one retry, and a plain message when OpenAI is busy. Set a monthly budget in the OpenAI dashboard as well.
- **Setup:** `OPEN_AI_API_KEY` on the backend (Render) only; optional `OPENAI_MODEL` (default `gpt-5.4-mini`), `OPENAI_REASONING_EFFORT` (default `low`). Without a key the button isn't shown. Code: [server/src/ai/](server/src/ai/) (`privacy.js` stand-ins, `tools.js` look-ups and proposals, `chat.js` the loop, `openai.js` the only call to OpenAI, `routes.js` `/api/chat…`), [client/components/AiChat.tsx](client/components/AiChat.tsx).

**Performance report** (menu: Performance report, `/performance`): how many HR contact details (phone numbers and emails) each person added, from the activity record. It replaced the weekly job market report.
- Period: **Today**, **Last 7 days**, **Last 30 days** or **Custom** (one day or a range), counted in India time up to today.
- Four cards: contact details added, phone numbers, emails, and the jobs they were added to (by how many people).
- **Who added what** is a drill-down table: each person (name, email, role), then their courses, then companies, then jobs, then each number and email itself with when it was added. Every level shows Phones, Emails, Total, Jobs, Given to students, CV shared and **Mostly found by**, most first, and adds up to the level above; the All row at the bottom equals the cards. **Mostly found by**: where most of that level's numbers and emails were found (the Found by chosen when adding them: SignalHire, Apollo, LinkedIn, Naukri, Indeed) and how many ("Apollo · 12 of 20"; two tied: both; more: "Mixed"; the whole split in its tooltip); "—" for those added before Found by was asked for (28 Oct 2026). Each number shows its own. Click a row to open the next level (**Expand all** / **Collapse all**); the ↗ next to a job opens its details window.
- What counts: each phone number or email a person added, once. A number only written differently ("98765 43210" → "+91 98765 43210"), one the job's posting already had, removed ones, notes and students don't count.
- **Download CSV**: one line per number or email (when, who, course, company, job, Filtered / Non-filtered, the value, Found by, students, remarks).
- Counting began when the activity record began; work before that isn't included (the page says from when).
- `GET /api/performance?days=N` or `?from=&to=` (signed-in, allowed roles only): one row per number or email added, newest first, each with its follow-ups (`outcomes`) and where it was found (`foundBy`: the job's Found by as it stood when it was added, '' if none), plus `students` (every student name used so far, to suggest).
- **Follow-up of each number and email** (for the team that gives the contacts to students): its students and the **Remark** on each one's call, under every number/email in the drill-down (open a job, or **Expand all**), and in **All contacts**.
  - **Assigned to:** the student the number/email was given to. Type a few letters and pick a suggested name (saved at once), or type a new name and press Enter or move on (saved). Esc puts it back. One student per number/email; the student is also put on the job's **Assigned to** list (the details window), and taken off it again when none of the job's numbers/emails is theirs any more.
  - **Remark:** pick **DNP**, **Busy**, **Switched off**, **Wrong number** ("Wrong email" for an email), **Not the correct person**, **CV shared**, **No openings** or **Others…**; it saves as soon as it is picked and shows in its colour (green: CV shared; amber: DNP, Busy, Switched off; red: wrong number / wrong person). **Others…** opens a box for their own words, saved on Enter (left empty, nothing changes). **No remark** clears it.
  - No Save button: each choice saves by itself, with "Saving…" / "✓ Saved" beside it; if the server refuses (e.g. the job was removed since), it says why and puts the old value back. A student and a remark changed in quick succession are both kept.
  - **All contacts** (switch at the top of the table): every number/email once, newest first, with its company and job (click to open the job), who added it, the student and the remark. Filters: a **course** (All courses, or one course, each with its count), **All**, **No remark yet**, **Not assigned** and each remark (counted within the chosen course); a search box (number, company, job, student). They work together. A number given a remark under "No remark yet" stays in view until the filter changes.
  - Recorded in the **activity record** under the person's email ("Added follow-up on …", **Student** / **Remark** with the number or email), and in the CSV (**Assigned to**, **Remark** columns). Stored per job and number/email in `contactoutcomes`, apart from the job's typed-in details, so editing the details never touches it; the same number written another way is the same number. `PUT /api/outcomes` (`{ job, field: 'phone'|'email', value, student? , status?, note? }`, needs the `record-outcomes` permission, which every role has).

**Home** (`/`, the first page; the **Dashboard** tab and the IJF logo open it): today at a glance, five glass boxes, each counted from the same data as the page it opens. On laptops and desktops all five fit the screen without scrolling (from a 1366×768 laptop up).
- **Job postings added today**: the latest collection's new jobs, the change from the day before and each course's count. Opens the **Dashboard**, now at `/dashboard` (old `/?days=7` links go there).
- **Contacts found today**: HR phone numbers and emails added today and by how many people. Opens the Performance report.
- **CV shared today**: calls whose feedback today is CV shared (the Review board's count), with the latest few. Opens **CV shared** (`/cv-shared`): each one with when and who recorded it, the student, the HR number or email (copy), the company and job (opens its window), who found the number and who gave it to the student and when; Today / 7 / 30 days / Custom and a search.
- **Incoming calls today**: coming soon.
- **Interviews today**: from the staff's interview sheet (below): today's count, companies, how many placed and the next few by time. Opens **Interviews** (`/interviews`): Today / 7 / 30 days / Custom, totals (interviews, students, companies, placed), course filter, search, and a table by day and time (student, course, company, round, room).

**Interviews from the staff's Google Sheet:** the backend reads the sheet (view only) with a Google service account, at most every 10 minutes, so the staff's edits show within 10 minutes; they keep working in the sheet as before. It reads every month tab ("OCTOBER 2026"): each day's block ("INTERVIEW SCHEDULED REPORT 01/10/2026"), the course row above each table (PS, DA, DS; "IT JOBS FACTORY (PS)" in older months; plain "IT JOBS FACTORY" = no course), the header row (S.NO., DATE, NAME, TIME, COMPANY, ROUND, ROOM) and "PLACED" written after a row. Dates are day/month/year; a row dated outside its block's month, in a block titled within the tab's month, takes the block's date. The per-course tabs ("DA INTERVIEW", "DS INTERVIEW") only give a course to month-tab interviews without one (same day and student); other tabs aren't read. Setup: `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `INTERVIEWS_SHEET_ID` on the backend (see `.env.example`). `GET /api/interviews?days=N` or `?from=&to=` (signed-in). Code: [server/src/interviews.js](server/src/interviews.js), [client/components/Interviews.tsx](client/components/Interviews.tsx).

**Hiring partners** (menu: Hot Desk, `/partners`): companies with 2 or more openings for your courses in the last 90 days. Large IT services firms are already excluded.
- Each row shows its openings (with a bar), what the company hires for, where, when it last posted, and its HR contacts (from any of its jobs, typed-in ones first), or "No contact yet".
- **Click a company's row** (or its name) and its openings open right under it: a pill per course on top (All courses, and each course with its count) to see one course's postings, then a table of the jobs (title, course, experience, posted, sites, which HR details it has). A job opens its details window. Click the row again, or another company, to close it. It follows the Filtered / Non-filtered switch and the same 90 days (`GET /api/companies/jobs?key=<the partner's key>&days=90`; without `days`, every stored job; `all=1`, kept and left-out together).
- Filter buttons: **All**, **With HR contact**, **No contact yet** (each with its count), plus a company search.
- **Download CSV** for the sales team.

## Try it now with demo data

You don't need any accounts for this. It runs everything with fake data in a temporary database.

```
npm install
npm install --prefix client
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
git clone https://github.com/Hyperion101010/naukri-scraper.git            # the Python scraper (Naukri, Glassdoor)
npm install                     # the backend's packages
npm install --prefix client     # the dashboard's packages (its own project, with its own lock file)
```

Then copy `.env.example` to `.env` (or `server/.env`) and fill it in. The backend alone (without `client`) can still collect and serve the API; `npm run build` needs `client`.

### 1. Accounts and keys

| What | Where | Put it in |
|---|---|---|
| Apify API token | apify.com → Console → Settings → API & Integrations | `APIFY_TOKEN` |
| MongoDB connection string | mongodb.com/atlas → free M0 cluster (Mumbai region) → Connect → Drivers | `MONGODB_URI` |

In Atlas → Network Access, allow `0.0.0.0/0`. GitHub Actions and Render don't have fixed IP addresses. The database is still protected by its username and password.

### 2. Scraper setup (once per PC)

The `naukri-scraper` folder must sit next to `server/` (or set `NAUKRI_SCRAPER_DIR`). Google Chrome must be installed: Glassdoor runs in it with its own saved profile (`chrome_profile`). Then give the scraper its own Python environment:

```
cd naukri-scraper
python -m venv .venv
.venv\Scripts\python -m pip install playwright beautifulsoup4
.venv\Scripts\python -m playwright install chromium
```

Naukri answers hidden (headless) browsers with HTTP 403. So the scraper opens real Chrome windows for a few minutes each run, one each for Naukri and Glassdoor. That's why collection runs on a normal Windows PC, not a cloud server.

**Logins are optional; everything works without them:**
- **Glassdoor** works without a login. If it ever shows a login or "verify you are human" page, run `.venv\Scripts\python scraper_file\glassdoor_feed.py --login` once.

Sessions are saved in `chrome_profile` (and `indeed_profile`, from when Indeed used the scraper). These folders hold browser logins, so never commit or share them.

### 3. Run it on your laptop

```
copy .env.example .env        (then fill in APIFY_TOKEN and MONGODB_URI; server\.env also works)
npm install
npm install --prefix client
npm run collect               (80 searches each on Naukri, Glassdoor and Indeed, 22 on LinkedIn; two Chrome windows open, for Naukri and Glassdoor)
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

### 5. Put the dashboard online

Collection keeps running on the Windows PC (step 4). Online you host the API and the dashboard, in one of two ways.

**A. One service on Render (simplest; the dashboard password works).** Render → New → Web Service → connect `scraper-backend`, then:

- Build command: `npm ci && git clone --depth 1 https://github.com/Sanuthakur01/scraper-frontend.git client && npm ci --prefix client && npm run build`
- Start command: `npm start`
- Environment: `MONGODB_URI`, and `DASHBOARD_PASSWORD` to require a login (any username, this password)
- Health check path: `/api/health`

**B. Dashboard and API hosted apart** (e.g. dashboard on Vercel, API on Render):

- API (Railway or Render, `scraper-backend`): the defaults work: `npm ci`, then `npm run build` (nothing to build without the dashboard), then `npm start`. Health check `/api/health`. Variables: `MONGODB_URI` (the same as in your `.env`), and `CORS_ORIGINS` = the dashboard's address (e.g. `https://ijf-jobs.vercel.app`). No `APIFY_TOKEN` is needed there: collection runs on the Windows PC.
- Dashboard (Vercel, `scraper-frontend`): environment `NEXT_PUBLIC_API_URL` = the API's address (e.g. `https://scraper-backend.onrender.com`). See that repo's `.env.example`.
- `DASHBOARD_PASSWORD` doesn't apply here: protect the dashboard with the host's own access settings.

Render's free plan sleeps after 15 minutes idle, so the first page load then takes 30-60 seconds. The $7/month Starter plan stays on.

## Cost

- **Naukri and Glassdoor** (our scraper) are free.
- **Indeed** (Apify, `valig/indeed-jobs-scraper`) costs $0.10 per 1,000 results plus $0.001 a search: at most 80 searches × `INDEED_LIMIT_PER_SEARCH` (100) = 8,000 results, about **$0.88 a run**, roughly $26 a month daily. Together with LinkedIn, a daily run costs up to about **$1.78** (the 24 Oct run cost $2.03 of its $2.39 estimate, as some searches return fewer results); the run prints the estimate for both before it starts.
- **LinkedIn** (Apify) is charged per job returned, about $0.30-0.40 per 1,000 jobs. LinkedIn runs only each course's `linkedinSearchTerms` (22 searches since 24 Oct 2026), so one run fetches at most 22 × `APIFY_LIMIT_PER_SEARCH` (100) = 2,200 jobs, about **$0.90**. They were picked by which searches found jobs no other search found on LinkedIn: Production Support's 37 searches mostly return the same jobs there, while each Data Science, Data Analyst and Data Engineering search finds many of its own. To run a title on LinkedIn too, add it to its course's `linkedinSearchTerms` (each one costs up to $0.04 a run). Apify's free plan includes $5 a month and Starter ($29/month) about $29 of usage, so daily runs at this size need more credit than Starter, or a lower `APIFY_LIMIT_PER_SEARCH`. When the month's credit runs short, the run skips LinkedIn and says so; the other platforms are collected as usual.
- **Coverage:** raising `NAUKRI_LIMIT_PER_SEARCH` (default 200) or `GLASSDOOR_LIMIT_PER_SEARCH` (100) gets more jobs for free; `INDEED_LIMIT_PER_SEARCH` (100) costs on Apify. Runs take a little longer.
  - A course can read more per search than the others (`searchLimits` in [courses.js](server/src/config/courses.js)). Production Support reads **500 per search on Naukri** and **200 on Glassdoor** (since 23 Oct 2026): Naukri lists about 450–500 new postings a day for "production support", "application support" and "site reliability engineer", and 200 read only the newest 40%. Both are free; LinkedIn (paid) stays at `APIFY_LIMIT_PER_SEARCH`. A scraper reading more per search gets proportionally more time.

## Which jobs are kept

Besides matching a course, a job must pass two rules. Both are applied **before saving**. Jobs that match a course but fail a rule are not thrown away: they are saved apart as **Non-filtered** jobs (see the next section). Jobs outside India or matching no course are not saved at all:

- **No large IT services firms.** The list is `EXCLUDED_COMPANIES` in [server/src/config/filters.js](server/src/config/filters.js): TCS, Infosys, IBM, Wipro, Accenture, Cognizant, HCL, Tech Mahindra, Capgemini, LTIMindtree, Genpact and others. It's the same list as `COMPANY_BLACKLIST` in the scraper's `scraper.py`. Name variants match too: "Tata Consultancy Services" = TCS, "IBM India Pvt Ltd" = IBM, "Infosys BPM" = Infosys.
- **1 or more years of experience: no fresher jobs.** The *minimum* experience a job asks for must be at least `EXPERIENCE_MIN` (default 1). There is no upper limit unless `EXPERIENCE_MAX` is set. For example, "1–3 yrs", "1–5 yrs", "3–6 yrs" and "8–12 yrs" are kept, while fresher jobs ("0–2 yrs", "Fresher") are not.
  - On the dashboard, experience is grouped as 1 yr, 2 yrs, 3 yrs, 4 yrs, 5 yrs and **5+ yrs** (more than 5 years, i.e. 6 or more), in the Experience filter, the chart and the course cards. Each job is in exactly one group.
  - Until 24 Oct 2026 the minimum was 2 years. That day `npm run reclassify` moved the 476 saved jobs asking for 1 year from Non-filtered to Filtered (HR details with them).
  - A job that doesn't state its experience is kept only if it's the same job as one that does state it (and is kept) on another platform. Then its link is added to that job. Otherwise it's a Non-filtered job.
  - Until 20 Oct 2026 the limit was 2–5 years. The jobs asking for more that the 19 Oct collection had found were added back with `npm run replay`, dated by their posting dates.

Each run's summary shows how many jobs each rule left out. After changing either rule, run `npm run reclassify -- --dry-run` to preview the effect on stored jobs, then `npm run reclassify` to apply it: kept jobs the rules now leave out move to Non-filtered, and Non-filtered jobs the rules now keep move to Filtered (HR details move with them). Only jobs that match no course any more are removed. `npm run replay` re-reads the saved results (no new searches) as of the collection that found them, so new jobs keep that collection's dates.

## Filtered and Non-filtered data

The switch at the top right, next to light/dark, changes the job pages (dashboard, course pages, hiring partners) between two separate sets of jobs:

| | Filtered (left, the default) | Non-filtered (right) |
|---|---|---|
| What | The jobs the rules above keep, from the main searches | Jobs that match one of the 4 courses but the rules leave out, and every job from the extra searches |
| Why there | Pass every rule | One reason each, shown on the job: **Large IT services firm**, **Fresher** (asks for no experience, i.e. under the 1-year minimum), **Experience not stated** (and not the same job as a kept one), or **Extra search** (passes the rules, but came from an extra search) |
| Stored in | `jobs` | `nonfilteredjobs` (same fields, plus `leftOutBy`, and `fromExtraSearch` for the extra searches' jobs) |

- Click the switch (or Space/Enter) to flip it, swipe it right or left, or use the ← → keys. The choice is remembered in that browser; everyone else still starts on Filtered.
- While Non-filtered is on, a yellow note under the top bar says so on every page, the switch turns amber, and CSV downloads are named `non-filtered-…` with a "Left out because" column.
- In Non-filtered the experience groups also include Fresher, 1 yr and Not stated, since these jobs can ask for anything.
- **Never in both:** a listing belongs to one set. A left-out listing that is the same opening as a kept job isn't added to Non-filtered, and a Non-filtered job that later turns up as a kept job leaves Non-filtered (HR details typed into it move to the kept job). The Filtered data is collected exactly as before.
- **Extra searches** (`extraSearchTerms` in [courses.js](server/src/config/courses.js)): **"mis executive"** and **"business analyst"** for Data Analyst, **"site reliability engineer"** for Production Support. They run every day on all four platforms, but everything they find goes to Non-filtered, so the main (Filtered) numbers come from the main searches alone. Their jobs are still sorted into courses by title (a "Data Engineer" an extra search turns up counts as Data Engineering), and the usual rules still apply first (an extra-search fresher job says "Fresher"). A job a main search also finds and keeps is a Filtered job as usual, and leaves Non-filtered if it was there. Each run's summary counts them (`extraSearch`), and each search in the run record says whether it was an extra one (`extra`).
- Typing HR details works in both, and a phone number can't be on two jobs in either set ("This number already exists.").
- The API takes `?view=nonfiltered` on every route that reads jobs; without it, everything is exactly as before.
- On 20 Oct 2026 Non-filtered was first filled from the saved 19 Oct results with `npm run replay` (1,747 jobs; the 4,040 Filtered jobs unchanged). Every collection since saves both.

## Changing what counts for each course

Edit [server/src/config/courses.js](server/src/config/courses.js):

- `searchTerms`: what each platform is searched for (the main searches)
- `extraSearchTerms`: more searches, whose jobs go to Non-filtered (see above)
- `strong` / `weak`: title phrases that put a job in that course. A weak phrase counts only when no course has a strong one: "Business Analyst" is a weak Data Analyst phrase, so "Business Analyst" is Data Analyst but "Business Analyst - Production Support" stays Production Support.
- `exclude`: phrases that keep a job out of that course
- `searchLimits` (optional): results to read per search on some platforms, for a course whose searches have more (see Cost)

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

**Indeed (Apify):** as for LinkedIn above (Apify Console → Runs; the actor is `valig/indeed-jobs-scraper`).

**Naukri or Glassdoor (our scraper):** the day's log in `data\logs\` shows the scraper's own messages, starting `[naukri]` or `[glassdoor]`.

- **Naukri "HTTP 403" or "never made its search call (blocked?)":** Naukri refused the browser. Check that `SCRAPER_HEADLESS` is 0 and the PC is logged in, then try again later.
- **Glassdoor "block page" or 0 jobs on every search:** log in once with `glassdoor_feed.py --login`.
- **To test a scraper on its own:** run `cd naukri-scraper`, then `.venv\Scripts\python scraper_file\naukri_feed.py --limit 20 "data analyst"` (or `glassdoor_feed.py`).

To skip a platform until it's fixed, set `DISABLED_SOURCES` to its name, e.g. `DISABLED_SOURCES=Glassdoor`. The other platforms keep working.

Under each page title, a yellow note names the sites that gave no new data in the last run. Hover over it to see the failed searches.

## Commands

| Command | What it does |
|---|---|
| `npm run collect` | The whole pipeline: LinkedIn and Indeed (Apify) + Naukri and Glassdoor (scraper) → database. Needs `APIFY_TOKEN`, `MONGODB_URI`, and the scraper setup |
| `npm run collect -- --days 30 --course production-support --limit Naukri=3000,Glassdoor=300` | A one-course catch-up: that course's searches only, postings from the last 30 days (the sites offer no more), reading up to 3,000 per search on Naukri (as far as Naukri pages) and 300 on Glassdoor. `--limit 300` sets every platform. New jobs are dated by when they were posted; jobs already stored are matched, not added again, and LinkedIn skips them (Apify doesn't charge for them). Add `DISABLED_SOURCES=Indeed` in front to leave out a platform. Done for Production Support on 23 Oct 2026 |
| `npm start` | Start the dashboard server (serves the built dashboard from `client/out`) |
| `npm run build` | Build the Next.js dashboard (in `client/`) to static files. Needs `npm install --prefix client` once |
| `npm --prefix client run typecheck` | Type-check the dashboard |
| `npm run demo` | Dashboard with fake data, no accounts needed |
| `npm run reclassify` | Apply changed course rules, excluded companies or experience range to stored jobs (add `-- --dry-run` to preview) |
| `npm run refresh-skills` | Re-read stored jobs' skills from `data/raw/` after changing the skill list (add `-- --dry-run` to preview) |
| `npm run replay` | Re-process the latest saved results of every platform with the current rules (free, no new searches). New jobs get the dates that collection would have given them, never today |
| `npm run dedupe` | Merge duplicate openings already stored (add `-- --dry-run` to preview first) |
| `npm test` | 125 tests: course matching, cleaning, contact details, duplicate merging, the pipeline's retries, lock, recovery and backfill, scraper time limits and blocks, Apify slow runs and credit, the skill planner, and Filtered vs Non-filtered (kept apart, never the same listing in both, moves when rules change), the API (course page numbers, every chart number against its job list in both views, HR contacts, partners, serving the dashboard pages, sign-in checks, the activity record, custom periods, the performance report and IJF AI: stand-ins for contacts, no contact sent to the model, numbers from the tools, changes only on Confirm, the daily limit, chats, reminders and the briefing) |
