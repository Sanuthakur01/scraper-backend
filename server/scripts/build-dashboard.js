// `npm run build`: builds the dashboard in client/ (the scraper-frontend repository) when it is there.
// A host that deploys this repository on its own (the API only, e.g. Railway or Render) runs
// `npm run build` too; then there is nothing to build and it succeeds.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const client = path.resolve(import.meta.dirname, '..', '..', 'client');

if (!fs.existsSync(path.join(client, 'package.json'))) {
  console.log('No dashboard in client/ (scraper-frontend): deploying the API only, nothing to build.');
  process.exit(0);
}

const result = spawnSync('npm', ['--prefix', client, 'run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
