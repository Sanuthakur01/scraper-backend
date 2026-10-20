import { ApifyClient } from 'apify-client';

// Apify run states that aren't finished yet.
const UNFINISHED = new Set(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']);
// Apify refusing because the account's monthly credit is used up: retrying can't help.
const OUT_OF_CREDIT = /monthly usage|usage hard limit|exceed(?:s|ed)? (?:your|the) (?:monthly|plan)|not enough (?:credit|usage)|insufficient (?:credit|funds)/i;

// What one LinkedIn result and one actor start cost on Apify's free plan (valig/linkedin-jobs-scraper's
// "FREE" tier; paid plans are cheaper), for estimating a run before it starts.
const PRICE_PER_RESULT = 0.0004;
const PRICE_PER_START = 0.001;

// Runs one actor, waits for it to finish and returns its dataset items.
// A run still going after waitSecs is waited for (up to maxWaitMins in all) rather than treated as failed,
// because a retry would start a second, paid run while the first one carries on. A run that is still
// going after that is stopped. client: for tests.
export function createApifyFetcher(token, { waitSecs = 900, maxWaitMins = 30, client = new ApifyClient({ token }) } = {}) {
  return async function fetchItems(actorId, input) {
    let run;
    try {
      run = await client.actor(actorId).call(input, { waitSecs });
    } catch (err) {
      if (OUT_OF_CREDIT.test(err.message)) err.noRetry = true;
      throw err;
    }
    const deadline = Date.now() + maxWaitMins * 60_000;
    while (UNFINISHED.has(run.status) && Date.now() < deadline) {
      run = await client.run(run.id).waitForFinish({ waitSecs: 120 });
    }
    if (UNFINISHED.has(run.status)) {
      await client.run(run.id).abort().catch(() => {});
      const err = new Error(`Apify run ${run.id} was still running after ${maxWaitMins} minutes, so it was stopped`);
      err.noRetry = true;
      throw err;
    }
    if (run.status !== 'SUCCEEDED') {
      throw new Error(`Apify run ${run.id} ended with status ${run.status}`);
    }
    const { items } = await client.dataset(run.defaultDatasetId).listItems({ clean: true });
    return { runId: run.id, items };
  };
}

// Before a collection: is there enough Apify credit left this month for its LinkedIn searches?
// Returns { ok, left, needed, resetsAt }. If Apify can't be asked, ok is true (the searches then report
// any problem themselves).
export async function checkApifyCredit(token, { searches, limitPerSearch }, { client = new ApifyClient({ token }) } = {}) {
  const needed = searches * (limitPerSearch * PRICE_PER_RESULT + PRICE_PER_START);
  try {
    const info = await client.user('me').limits();
    const max = info?.limits?.maxMonthlyUsageUsd;
    if (max == null) return { ok: true, needed };
    const left = max - (info.current?.monthlyUsageUsd ?? 0);
    return { ok: left >= needed, left, needed, resetsAt: info.monthlyUsageCycle?.endAt ?? null };
  } catch {
    return { ok: true, needed };
  }
}
