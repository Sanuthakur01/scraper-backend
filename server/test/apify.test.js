// LinkedIn via Apify: slow runs, an account out of credit, and the credit check before a collection.
// A fake Apify client stands in for the real one, so nothing is spent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkApifyCredit, createApifyFetcher } from '../src/collector/apify.js';
import { perSearch } from '../src/collector/collect.js';

function fakeClient({ callResult, waits = [], callError, limits, limitsError } = {}) {
  const calls = { call: 0, wait: 0, abort: 0 };
  return {
    calls,
    actor: () => ({
      call: async () => {
        calls.call++;
        if (callError) throw new Error(callError);
        return callResult;
      },
    }),
    run: () => ({
      waitForFinish: async () => waits[calls.wait++] ?? { id: 'r1', status: 'RUNNING' },
      abort: async () => {
        calls.abort++;
      },
    }),
    dataset: () => ({ listItems: async () => ({ items: [{ id: 1 }, { id: 2 }] }) }),
    user: () => ({
      limits: async () => {
        if (limitsError) throw new Error(limitsError);
        return limits;
      },
    }),
  };
}

test('a LinkedIn run still going after the first wait is waited for, not started again', async () => {
  const client = fakeClient({
    callResult: { id: 'r1', status: 'RUNNING' },
    waits: [{ id: 'r1', status: 'RUNNING' }, { id: 'r1', status: 'SUCCEEDED', defaultDatasetId: 'd1' }],
  });
  const fetchItems = createApifyFetcher('token', { client });
  const result = await fetchItems('actor', {});
  assert.deepEqual([result.runId, result.items.length, client.calls.call], ['r1', 2, 1], 'one paid run, its items returned');
});

test('a run still going after the longest wait is stopped, and not retried', async () => {
  const client = fakeClient({ callResult: { id: 'r1', status: 'RUNNING' } });
  const fetchItems = createApifyFetcher('token', { client, maxWaitMins: 0 });
  const search = perSearch((source, input) => fetchItems('actor', input), 1, { retries: 1, retryDelayMs: 0 });
  const [result] = await search({}, [{}]);
  assert.equal(result.status, 'error');
  assert.match(result.error, /still running after 0 minutes, so it was stopped/);
  assert.deepEqual([client.calls.call, client.calls.abort], [1, 1], 'stopped once, never started a second time');
});

test('an Apify account out of credit is not retried', async () => {
  const client = fakeClient({ callError: 'Monthly usage hard limit exceeded' });
  const fetchItems = createApifyFetcher('token', { client });
  const search = perSearch((source, input) => fetchItems('actor', input), 1, { retries: 1, retryDelayMs: 0 });
  const [result] = await search({}, [{}]);
  assert.equal(result.status, 'error');
  assert.equal(client.calls.call, 1, 'tried once');
});

test('other Apify errors are still retried once', async () => {
  const client = fakeClient({ callError: 'socket hang up' });
  const fetchItems = createApifyFetcher('token', { client });
  const search = perSearch((source, input) => fetchItems('actor', input), 1, { retries: 1, retryDelayMs: 0 });
  await search({}, [{}]);
  assert.equal(client.calls.call, 2);
});

test('the credit check: enough, not enough, and Apify not answering', async () => {
  const run = { searches: 9, limitPerSearch: 100 }; // 900 results = $0.36 + 9 starts = $0.369
  const at = (used, max) => ({ client: fakeClient({ limits: { current: { monthlyUsageUsd: used }, limits: { maxMonthlyUsageUsd: max }, monthlyUsageCycle: { endAt: '2026-11-19T23:59:59Z' } } }) });
  const enough = await checkApifyCredit('t', run, at(1, 19));
  assert.equal(enough.ok, true);
  assert.ok(Math.abs(enough.needed - 0.369) < 1e-9);
  const short = await checkApifyCredit('t', run, at(18.8, 19));
  assert.deepEqual([short.ok, short.resetsAt], [false, '2026-11-19T23:59:59Z']);
  assert.equal((await checkApifyCredit('t', run, { client: fakeClient({ limitsError: 'network down' }) })).ok, true, 'unknown: go ahead');
});
