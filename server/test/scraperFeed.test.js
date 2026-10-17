import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createScraperFeedFetcher, parseFeedOutput, readSavedFeed } from '../src/collector/scraperFeed.js';

test('feed output: JSON lines are read by keyword, anything else is ignored', () => {
  const stdout = [
    'some stray print',
    JSON.stringify({ keyword: 'data analyst', status: 'ok', total: 5, items: [{ jobId: '1' }] }),
    JSON.stringify({ keyword: 'data engineer', status: 'error', error: 'RuntimeError: blocked' }),
    '{"keyword": "cut off mid-li',
  ].join('\n');
  const results = parseFeedOutput(stdout);
  assert.equal(results.size, 2);
  assert.equal(results.get('data analyst').items.length, 1);
  assert.equal(results.get('data engineer').status, 'error');
});

// A stand-in feed script (a small Node script with the .py name), so the tests need neither Python
// nor the job sites. Each run is logged to calls.log. 'etl developer' always fails; 'data engineer'
// fails on the first run only. error is the message failed searches report.
function fakeScraper(error = 'RuntimeError: blocked') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-feed-test-'));
  fs.mkdirSync(path.join(dir, 'scraper_file'));
  fs.writeFileSync(
    path.join(dir, 'scraper_file', 'glassdoor_feed.py'),
    `const fs = require('fs');
     const keywords = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
     const firstRun = !fs.existsSync('calls.log');
     fs.appendFileSync('calls.log', keywords.join('|') + '\\n');
     for (const keyword of keywords) {
       console.error('[glassdoor] ' + keyword);
       const fails = keyword === 'etl developer' || (keyword === 'data engineer' && firstRun);
       console.log(JSON.stringify(fails
         ? { keyword, status: 'error', error: ${JSON.stringify(error)} }
         : { keyword, status: 'ok', total: 1, items: [{ jobId: keyword }] }));
     }`,
  );
  return dir;
}

test('a feed script runs once for all searches; failed searches are retried once, alone', async () => {
  const dir = fakeScraper();
  const logs = [];
  const fetchFromScraper = createScraperFeedFetcher(
    { dir, python: process.execPath, headless: false, timeoutMinutes: 1, retryDelayMs: 0 },
    (line) => logs.push(line),
  );
  const inputs = ['data analyst', 'etl developer', 'data engineer'].map((keyword) => ({ keyword, days: 1, limit: 20 }));
  const results = await fetchFromScraper({ platform: 'Glassdoor', feedScript: 'glassdoor_feed.py' }, inputs);

  assert.deepEqual(results.map((r) => r.status), ['ok', 'error', 'ok'], 'data engineer succeeded on the retry');
  assert.equal(results[2].items[0].jobId, 'data engineer');
  assert.match(results[1].error, /blocked/);
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['data analyst|etl developer|data engineer', 'etl developer|data engineer'], 'one run, then one retry of the failed ones');
  assert.ok(logs.some((l) => l.includes('[glassdoor] data analyst')), 'progress is passed through to the log');
  assert.ok(!logs.some((l) => l.includes('waiting longer')), 'an ordinary failure is retried soon');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('after a rate-limit error (HTTP 429) the retry waits longer', async () => {
  const dir = fakeScraper('RateLimited: Indeed kept refusing pages (HTTP 429, too many requests)');
  const logs = [];
  const fetchFromScraper = createScraperFeedFetcher(
    { dir, python: process.execPath, headless: false, timeoutMinutes: 1, retryDelayMs: 0, rateLimitDelayMs: 300 },
    (line) => logs.push(line),
  );
  const inputs = ['data analyst', 'data engineer'].map((keyword) => ({ keyword, days: 1, limit: 20 }));
  const started = Date.now();
  const results = await fetchFromScraper({ platform: 'Indeed', feedScript: 'glassdoor_feed.py' }, inputs);

  assert.deepEqual(results.map((r) => r.status), ['ok', 'ok']);
  assert.ok(Date.now() - started >= 300, 'waited rateLimitDelayMs before the retry');
  assert.ok(logs.some((l) => l.includes('Indeed is limiting how often we can ask, so waiting longer')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing feed script gives a clear error', async () => {
  const fetchFromScraper = createScraperFeedFetcher({ dir: path.join(os.tmpdir(), 'no-such-scraper'), python: '', headless: false, timeoutMinutes: 1 });
  await assert.rejects(
    fetchFromScraper({ platform: 'Naukri', feedScript: 'naukri_feed.py' }, [{ keyword: 'x', days: 1, limit: 20 }]),
    /Naukri feed script not found/,
  );
});

test('feed files saved by older runs can still be read, even after being moved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'old-feed-'));
  fs.writeFileSync(path.join(dir, 'naukri-old.json'), JSON.stringify({ 'data analyst': { status: 'ok', items: [{ jobId: '7' }] } }));
  assert.equal(readSavedFeed(path.join('gone', 'naukri-old.json'), 'data analyst', dir)[0].jobId, '7');
  fs.rmSync(dir, { recursive: true, force: true });
});
