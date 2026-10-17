// Runs the whole dashboard with fake data in a temporary in-memory database.
// No Apify token or MongoDB Atlas account needed. Nothing is saved when it stops.
import { MongoMemoryServer } from 'mongodb-memory-server-core';

process.env.DEMO_MODE = '1';

const { config } = await import('../src/config.js');
const { connectDb } = await import('../src/db.js');
const { collect, perSearch } = await import('../src/collector/collect.js');
const { createApp } = await import('../src/app.js');
const { createDemoFetcher } = await import('./demo-data.js');

const DAY_MS = 86_400_000;
const DAYS = 21;

console.log('Starting a temporary MongoDB (the first run downloads it, which can take a minute)...');
const mongo = await MongoMemoryServer.create();
await connectDb(mongo.getUri());

console.log(`Collecting ${DAYS} days of demo jobs...`);
for (let dayIndex = DAYS - 1; dayIndex >= 0; dayIndex--) {
  const now = new Date(Date.now() - dayIndex * DAY_MS);
  await collect({ fetchSearches: perSearch(createDemoFetcher(now, dayIndex), 4), now, log: () => {}, rawDir: null });
}

createApp().listen(config.port, () => {
  console.log(`Demo dashboard running at http://localhost:${config.port}  (Ctrl+C to stop)`);
});
