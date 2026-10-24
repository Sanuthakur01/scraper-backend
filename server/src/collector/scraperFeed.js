// Naukri, Indeed and Glassdoor postings come from our Python scraper in naukri-scraper/. Each platform
// has a feed script there (source.feedScript: naukri_feed.py, indeed_feed.py, glassdoor_feed.py in
// scraper_file/) that searches every term in one browser session and prints one JSON line per term:
//   {"keyword": "data analyst", "status": "ok", "items": [...]}  or  {"keyword": ..., "status": "error", "error": ...}
// Each platform runs as its own Python process with its own browser, so one can't break another.
// Searches that fail are retried once, in a fresh process.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Running scraper processes, so a stopped collection can close them (and their Chrome windows).
const running = new Set();

// Stops a scraper and everything it started: on Windows, killing only python.exe would leave
// Playwright's driver and the Chrome window running.
function killTree(child) {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

export function stopScrapers() {
  for (const child of running) killTree(child);
}

export const defaultPython = (dir) =>
  path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');

// stdout of a feed script -> Map(keyword -> { status, items, error })
export function parseFeedOutput(stdout) {
  const results = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const result = JSON.parse(line);
      if (result.keyword) results.set(result.keyword, result);
    } catch {
      // A partial line from a killed process: ignore it.
    }
  }
  return results;
}

function runPython(python, args, { cwd, timeoutMs, onLog, label }) {
  return new Promise((resolve) => {
    const child = spawn(python, args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    });
    running.add(child);
    let stdout = '';
    let stderrTail = '';
    let problem = '';
    const timer = setTimeout(() => {
      problem = `${label} scraper stopped after ${Math.round(timeoutMs / 60_000)} minutes (SCRAPER_TIMEOUT_MINUTES)`;
      killTree(child);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLog(line.trimEnd());
    });
    child.on('error', (err) => {
      problem = `Could not start the ${label} scraper (${python}): ${err.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(child);
      // Results printed before a timeout or crash are kept.
      if (!problem && code && PROFILE_IN_USE.test(stderrTail)) {
        problem = `${label}'s Chrome profile is open in another Chrome window (left from a login or an earlier run). Close that window and run again`;
      }
      resolve({ code, stdout, problem: problem || (code ? `exit code ${code}: ${stderrTail.trim().split('\n').pop()}` : '') });
    });
  });
}

// Reads one keyword's items back from a feed file saved by an older version (used by `npm run replay`).
// If the file was moved, it is looked for by name in feedDir.
export function readSavedFeed(file, keyword, feedDir) {
  const found = fs.existsSync(file) || !feedDir ? file : path.join(feedDir, path.basename(file));
  const saved = JSON.parse(fs.readFileSync(found, 'utf8'));
  return saved[keyword]?.items ?? [];
}

// The site refused us for asking too often (HTTP 429) or is blocking us for a while (HTTP 403):
// retrying soon would be refused again.
const RATE_LIMITED = /ratelimited|http 429|too many requests|http 403/i;

// Chrome refuses to open a profile another Chrome window is using (e.g. a `--login` window left open).
const PROFILE_IN_USE = /ProcessSingleton|user data directory is already in use|profile (?:directory )?is (?:already )?in use/i;

// How long one run of a platform's scraper may take, in minutes, for this many searches. scale: how many
// times the usual number of results each search reads (minutesPerSearch is for the usual number).
export const scraperTimeoutMinutes = (source, timeoutMinutes, searches, scale = 1) =>
  Math.max(timeoutMinutes, source.minTimeoutMinutes ?? 0, searches * (source.minutesPerSearch ?? 0) * Math.max(1, scale));

// fetchSearches(source, inputs) for the collector: runs source.feedScript for all inputs, one Python process
// per result limit (a course can read more per search: searchLimits in config/courses.js), retries the
// failed ones once, and returns one result per input. After a rate-limit error the retry waits
// rateLimitDelayMs instead of retryDelayMs.
export function createScraperFeedFetcher(
  { dir, python, headless, timeoutMinutes, limitPerSearch = {}, retryDelayMs = 15_000, rateLimitDelayMs = 5 * 60_000 },
  log = console.log,
) {
  const pythonPath = python || defaultPython(dir);

  return async function fetchFromScraper(source, inputs) {
    const script = path.join('scraper_file', source.feedScript);
    if (!fs.existsSync(path.join(dir, script))) {
      throw new Error(`${source.platform} feed script not found: ${path.join(dir, script)} (set NAUKRI_SCRAPER_DIR)`);
    }
    if (!python && !fs.existsSync(pythonPath)) {
      throw new Error(`The scraper's Python environment is missing (${pythonPath}). See README: "Scraper setup".`);
    }

    // One group's searches (all with the same limit) -> { results: Map(keyword -> result), problem }.
    const fetchGroup = async (group) => {
      const { days, limit } = group[0];
      // minutesPerSearch is for the platform's usual number of results; more results get more time.
      const scale = limit / (limitPerSearch[source.platform] ?? limit);
      const run = (keywords) =>
        runPython(pythonPath, [script, '--days', String(days), '--limit', String(limit), ...(headless ? ['--headless'] : []), ...keywords], {
          cwd: dir,
          // SCRAPER_TIMEOUT_MINUTES, or longer for a platform that needs it (source.minTimeoutMinutes), and
          // longer for more searches (source.minutesPerSearch each) and for more results per search.
          timeoutMs: scraperTimeoutMinutes(source, timeoutMinutes, keywords.length, scale) * 60_000,
          onLog: (line) => log(`    ${line}`),
          label: source.platform,
        });

      const keywords = group.map((input) => input.keyword);
      const first = await run(keywords);
      const results = parseFeedOutput(first.stdout);
      let problem = first.problem;

      const failed = keywords.filter((k) => results.get(k)?.status !== 'ok');
      if (failed.length) {
        const rateLimited = failed.some((k) => RATE_LIMITED.test(results.get(k)?.error ?? ''));
        const delayMs = rateLimited ? rateLimitDelayMs : retryDelayMs;
        log(
          `    [${source.platform.toLowerCase()}] retrying ${failed.length} failed search(es) in ${Math.round(delayMs / 1000)}s` +
            (rateLimited ? ` (${source.platform} is limiting how often we can ask, so waiting longer)` : first.problem ? ` (${first.problem})` : ''),
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const second = await run(failed);
        for (const [keyword, result] of parseFeedOutput(second.stdout)) {
          if (result.status === 'ok' || !results.has(keyword)) results.set(keyword, result);
        }
        problem = second.problem || problem;
      }
      return { results, problem };
    };

    // The searches by limit, in the order they come (usually one group: every search reads the same).
    const groups = new Map();
    for (const input of inputs) {
      if (!groups.has(input.limit)) groups.set(input.limit, []);
      groups.get(input.limit).push(input);
    }
    const done = new Map(); // limit -> { results, problem }
    for (const [limit, group] of groups) done.set(limit, await fetchGroup(group));

    if (![...done.values()].some((d) => d.results.size)) {
      const problem = [...done.values()].map((d) => d.problem).find(Boolean);
      throw new Error(`${source.platform} scraper returned no results (${problem || 'no output'})`);
    }
    return inputs.map((input) => {
      const { results, problem } = done.get(input.limit);
      const result = results.get(input.keyword);
      if (!result) return { status: 'error', items: [], error: `The ${source.platform} scraper stopped before this search${problem ? ` (${problem})` : ''}` };
      if (result.status !== 'ok') return { status: 'error', items: [], error: result.error };
      return { status: 'ok', items: result.items ?? [], note: result.note };
    });
  };
}
