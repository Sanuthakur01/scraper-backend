import { ApifyClient } from 'apify-client';

// Runs one actor, waits for it to finish and returns its dataset items.
export function createApifyFetcher(token, { waitSecs = 900 } = {}) {
  const client = new ApifyClient({ token });
  return async function fetchItems(actorId, input) {
    const run = await client.actor(actorId).call(input, { waitSecs });
    if (run.status !== 'SUCCEEDED') {
      throw new Error(`Apify run ${run.id} ended with status ${run.status}`);
    }
    const { items } = await client.dataset(run.defaultDatasetId).listItems({ clean: true });
    return { runId: run.id, items };
  };
}
