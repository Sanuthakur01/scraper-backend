import { config } from './config.js';
import { connectDb } from './db.js';
import { createApp } from './app.js';

await connectDb();
createApp().listen(config.port, () => {
  console.log(`Dashboard running at http://localhost:${config.port}`);
});
