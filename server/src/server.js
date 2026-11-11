import { config } from './config.js';
import { connectDb } from './db.js';
import { createApp } from './app.js';
import { createLmsStore } from './lmsInterviews.js';
import { ContactOutcome } from './models.js';

await connectDb();
// The follow-ups' unique index: one per number and student (it was one per number until 27 Oct 2026, when a
// number could first go to several students). syncIndexes drops the old one and builds the new; it changes no
// document, and does nothing once done.
await ContactOutcome.syncIndexes().catch((err) => console.error(`Could not update the follow-ups' index: ${err.message}`));
// The LMS database (LMS_MONGO_URI): given here only, so tests (which create the app themselves) never reach it.
const lms = createLmsStore(config.lms.mongoUri);
createApp({ lms }).listen(config.port, () => {
  console.log(`Dashboard running at http://localhost:${config.port}`);
  console.log(lms ? 'Interviews: from the LMS database (all_interviews).' : 'Interviews: from the interview sheet (LMS_MONGO_URI not set).');
});
