// The interview sheet (src/interviews.js): the staff's day-by-day layout read into interviews, the Google sign-in
// and reading, and GET /api/interviews. Names, companies and the key are made up.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { courseOfTab, createInterviewSource, labelCourses, minutesOf, monthOfTab, parseDay, parseInterviews } from '../src/interviews.js';

// Like the staff's October tab: a block per day, a course row, a header row, "PLACED" after some rows.
const OCTOBER = [
  [],
  ['', 'INTERVIEW SCHEDULED REPORT 01/10/2026'],
  ['', 'PS'],
  ['', 'S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'],
  ['', '1', '01/10/2026', 'RAVI KUMAR', 'ANYTIME', 'ALPHA SYSTEMS', 'ASSESSMENT', 'HYDERABAD'],
  ['', '2', '01/10/2026', 'NEHA SINGH', '4:00 PM', 'BETA SOFT', 'R-01', 'HYDERABAD'],
  [],
  ['', 'DA'],
  ['', 'S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'],
  ['', '1', '01/10/2026', 'ANIL VERMA', '12:00 PM', 'GAMMA MEDIA', 'R-01', 'MUMBAI'],
  ['', 'DS'],
  ['', 'S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'],
  ['', '1', '01/10/2026', 'PRIYA SHAH', '11:00 AM', 'DELTA FINSERV', 'R-02', 'BANGALORE'],
  [],
  ['', 'INTERVIEW SCHEDULED REPORT 03/10/2026'],
  ['', 'PS'],
  ['', 'S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'],
  ['', '1', '03/10/2026', 'KARAN JOSHI', '12:30 PM', '', 'R-01', 'HYDERABAD', 'PLACED'],
  ['', '2', '', 'MEERA NAIR', '5:00 PM', 'EPSILON HR', 'HR ROUND', 'PUNE', '', 'PLACED'],
  ['', '3', '03/10/2026', '', '5:45 PM', 'ZETA', 'R-01', 'PUNE'], // no name: not an interview
];

test('Interview sheet: each day block, course row and header row read into interviews', () => {
  const items = parseInterviews('OCTOBER 2026', OCTOBER);
  assert.deepEqual(
    items.map((i) => [i.date, i.course, i.name, i.time, i.minutes, i.company, i.round, i.room, i.status, i.placed]),
    [
      ['2026-10-01', 'production-support', 'RAVI KUMAR', 'ANYTIME', null, 'ALPHA SYSTEMS', 'ASSESSMENT', 'HYDERABAD', '', false],
      ['2026-10-01', 'production-support', 'NEHA SINGH', '4:00 PM', 960, 'BETA SOFT', 'R-01', 'HYDERABAD', '', false],
      ['2026-10-01', 'data-analyst', 'ANIL VERMA', '12:00 PM', 720, 'GAMMA MEDIA', 'R-01', 'MUMBAI', '', false],
      ['2026-10-01', 'data-science', 'PRIYA SHAH', '11:00 AM', 660, 'DELTA FINSERV', 'R-02', 'BANGALORE', '', false],
      ['2026-10-03', 'production-support', 'KARAN JOSHI', '12:30 PM', 750, '', 'R-01', 'HYDERABAD', 'PLACED', true],
      // No date in its row: the block's date; "PLACED" two cells after ROOM still counts.
      ['2026-10-03', 'production-support', 'MEERA NAIR', '5:00 PM', 1020, 'EPSILON HR', 'HR ROUND', 'PUNE', 'PLACED', true],
    ],
  );
  assert.equal(items[0].id, 'OCTOBER 2026!5', 'tab and sheet row');
});

test('Interview sheet: dates are day first; month tabs only; times read for sorting', () => {
  assert.deepEqual(monthOfTab('OCTOBER 2026'), { year: 2026, month: 10 });
  assert.equal(monthOfTab('DA INTERVIEW'), null);
  assert.equal(monthOfTab('Sheet12'), null);
  assert.equal(parseDay('05/10/2026'), '2026-10-05');
  assert.equal(parseDay('5-10-26'), '2026-10-05');
  assert.equal(parseDay('5 Oct 2026'), '2026-10-05');
  assert.equal(parseDay('10/05/2026', { year: 2026, month: 10 }), '2026-10-05', 'written month first, in the October tab');
  assert.equal(parseDay('31/02/2026'), null);
  assert.equal(parseDay('ANYTIME'), null);
  assert.equal(minutesOf('11.30 am'), 690);
  assert.equal(minutesOf('12:15 AM'), 15);
  assert.equal(minutesOf('5:30'), 17 * 60 + 30, 'no am/pm: office hours, so pm');
  assert.equal(minutesOf('10:00'), 600);
  assert.equal(minutesOf('ANYTIME'), null);
  assert.equal(minutesOf('NC'), null);
  assert.equal(courseOfTab('DA INTERVIEW'), 'data-analyst');
  assert.equal(courseOfTab('DS INTERVIEW'), 'data-science');
  assert.equal(courseOfTab('Sheet12'), null);
});

test('Interview sheet: older blocks ("IT JOBS FACTORY", "(PS)"), a date typo in a block, courses from the per-course tabs', () => {
  const AUGUST = [
    ['INTERVIEW SCHEDULED REPORT 03/08/2026'],
    ['IT JOBS FACTORY'],
    ['S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'],
    ['1', '03/07/2026', 'ROHAN DAS', '1:00 PM', 'IOTA WORKS', 'R-02', '106'], // July written in August's 3 Aug block
    ['2', '03/08/2026', 'SARA KHAN', '5:30', 'KAPPA LTD', 'R-01', '106', 'RESCHEDULED'],
    [],
    ['INTERVIEW SCHEDULED REPORT 01/09/2026'], // the next month's first day, at the end of the tab: kept as written
    ['IT JOBS FACTORY (PS)'],
    ['S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'],
    ['1', '01/09/2026', 'VIJAY RAO', '11:00 AM', 'LAMBDA', 'R-01', '111'],
  ];
  const items = parseInterviews('AUGUST 2026', AUGUST);
  assert.deepEqual(
    items.map((i) => [i.date, i.course, i.name, i.minutes, i.room, i.status, i.placed]),
    [
      ['2026-08-03', null, 'ROHAN DAS', 780, '106', '', false],
      ['2026-08-03', null, 'SARA KHAN', 1050, '106', 'RESCHEDULED', false],
      ['2026-09-01', 'production-support', 'VIJAY RAO', 660, '111', '', false],
    ],
  );
  const DA_TAB = [
    ['S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'],
    ['1', '03/08/2026', 'Sara  Khan', '5:30 PM', 'KAPPA LTD', 'R-01', '106'],
    ['2', '04/08/2026', 'ROHAN DAS', '2:00 PM', 'MU', 'R-01', '106'], // another day: not the same interview
  ];
  const courseItems = parseInterviews('DA INTERVIEW', DA_TAB).map((i) => ({ ...i, course: courseOfTab('DA INTERVIEW') }));
  assert.deepEqual(
    labelCourses(items, courseItems).map((i) => [i.name, i.course]),
    [['ROHAN DAS', null], ['SARA KHAN', 'data-analyst'], ['VIJAY RAO', 'production-support']],
  );
});

// A stand-in for Google: the token endpoint (checks the signed JWT) and the Sheets API.
function fakeGoogle({ publicKey, tabs, failSheets = null }) {
  const calls = [];
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      const jwt = new URLSearchParams(options.body).get('assertion');
      const [head, claims, sig] = jwt.split('.');
      const ok = crypto.createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, Buffer.from(sig, 'base64url'));
      const c = JSON.parse(Buffer.from(claims, 'base64url').toString());
      if (!ok || c.iss !== 'reader@test.iam.gserviceaccount.com' || !c.scope.includes('spreadsheets.readonly')) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'token-1', expires_in: 3600 });
    }
    assert.equal(options.headers?.Authorization, 'Bearer token-1');
    if (failSheets) return json(failSheets.status, failSheets.body);
    if (String(url).includes('?fields=')) return json(200, { sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) });
    const asked = [...new URL(url).searchParams.getAll('ranges')].map((r) => r.slice(1, -1));
    return json(200, { valueRanges: asked.map((title) => ({ values: tabs[title] })) });
  };
  return { fetch, calls };
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SETUP = { sheetId: 'sheet-1', serviceAccount: 'reader@test.iam.gserviceaccount.com', privateKey: KEY };

test('Interview sheet: signs in as the service account, reads the month and per-course tabs only, again only after 10 minutes', async () => {
  let clock = Date.parse('2026-10-30T06:00:00Z');
  const DA_TAB = [['S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'], ['1', '01/10/2026', 'ANIL VERMA', '12:00 PM', 'GAMMA MEDIA', 'R-01', 'MUMBAI']];
  const google = fakeGoogle({ publicKey, tabs: { 'OCTOBER 2026': OCTOBER, 'DA INTERVIEW': DA_TAB, Sheet12: [['Some Co', '9800000000']] } });
  const source = createInterviewSource(SETUP, { fetch: google.fetch, now: () => clock });
  const first = await source.read();
  assert.equal(first.error, null);
  assert.deepEqual(first.tabs, ['OCTOBER 2026']);
  assert.equal(first.items.length, 6, "the per-course tab's interviews aren't counted again");
  assert.ok(google.calls.some((u) => u.includes('DA%20INTERVIEW')), 'the per-course tab is read');
  assert.ok(!google.calls.some((u) => u.includes('Sheet12')), 'other tabs are not read');
  const count = google.calls.length;
  clock += 9 * 60_000;
  assert.equal(await source.read(), first, 'within 10 minutes: the same reading');
  assert.equal(google.calls.length, count);
  clock += 2 * 60_000;
  await source.read();
  assert.equal(google.calls.length, count + 2, 'read again (the token is kept)');
  assert.equal(createInterviewSource({ ...SETUP, privateKey: '' }), null, 'not set up: none');
});

test('Interview sheet: a Google error says what to do; a later failure keeps the last good interviews', async () => {
  let clock = Date.parse('2026-10-30T06:00:00Z');
  const disabled = { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'Google Sheets API has not been used', details: [{ reason: 'SERVICE_DISABLED' }] } } };
  const off = createInterviewSource(SETUP, { fetch: fakeGoogle({ publicKey, tabs: {}, failSheets: disabled }).fetch, now: () => clock });
  assert.match((await off.read()).error, /Google Sheets API is switched off/);
  const notShared = createInterviewSource(SETUP, { fetch: fakeGoogle({ publicKey, tabs: {}, failSheets: { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } } }).fetch });
  assert.match((await notShared.read()).error, /isn't shared with reader@test\.iam\.gserviceaccount\.com/);
  const excel = createInterviewSource(SETUP, { fetch: fakeGoogle({ publicKey, tabs: {}, failSheets: { status: 400, body: { error: { status: 'FAILED_PRECONDITION', message: 'This operation is not supported for this document' } } } }).fetch });
  assert.match((await excel.read()).error, /Excel file .* Save as Google Sheets/);

  const google = fakeGoogle({ publicKey, tabs: { 'OCTOBER 2026': OCTOBER } });
  let failing = false;
  const source = createInterviewSource(SETUP, { fetch: (url, o) => (failing && !String(url).includes('oauth2') ? Promise.reject(new Error('network down')) : google.fetch(url, o)), now: () => clock });
  const good = await source.read();
  failing = true;
  clock += 11 * 60_000;
  const stale = await source.read();
  assert.equal(stale.error, 'network down');
  assert.equal(stale.items.length, 6, 'the last good interviews');
  assert.equal(stale.readAt, good.readAt);
});

test('GET /api/interviews: the period (days end today), latest day first and by time; not set up; unreadable', async () => {
  const istDay = (offset) => new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
  const today = istDay(0);
  const [y, m, d] = today.split('-');
  const tab = `${['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'][Number(m) - 1]} ${y}`;
  const rows = [
    ['', 'DA'],
    ['', 'S.NO.', 'DATE', 'NAME', 'TIME', 'COMPANY', 'ROUND', 'ROOM'],
    ['', '1', `${d}/${m}/${y}`, 'LATE ONE', '5:00 PM', 'ACME', 'R-01', 'PUNE'],
    ['', '2', `${d}/${m}/${y}`, 'ANY TIME', 'ANYTIME', 'ACME', 'R-01', 'PUNE'],
    ['', '3', `${d}/${m}/${y}`, 'EARLY ONE', '10:00 AM', 'ACME', 'R-01', 'PUNE'],
    ['', '4', '01/01/2020', 'LONG AGO', '10:00 AM', 'ACME', 'R-01', 'PUNE'],
  ];
  const sheet = { read: async () => ({ items: parseInterviews(tab, rows), readAt: '2026-10-30T06:00:00.000Z', error: null }) };
  const identify = async () => ({ userId: 'u', email: 'staff@example.com', name: '', role: 'ADMIN' });
  const run = async (interviews, query = 'days=1') => {
    const server = createApp({ identify, ai: null, interviews }).listen(0);
    try {
      const res = await fetch(`http://localhost:${server.address().port}/api/interviews?${query}`);
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  };
  const { status, body } = await run(sheet);
  assert.equal(status, 200);
  assert.equal(body.from, today);
  assert.equal(body.to, today);
  assert.deepEqual(body.items.map((i) => i.name), ['EARLY ONE', 'LATE ONE', 'ANY TIME']);
  assert.equal(body.readAt, '2026-10-30T06:00:00.000Z');
  assert.deepEqual((await run(null)).body, { days: 1, from: today, to: today, configured: false, items: [], readAt: null, error: null });
  const broken = await run({ read: async () => ({ items: [], readAt: null, error: 'The Google Sheets API is switched off.' }) });
  assert.equal(broken.status, 503);
  assert.match(broken.body.error, /^Could not read the interview sheet\. The Google Sheets API is switched off/);
});
