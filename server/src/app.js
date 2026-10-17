import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import apiRoutes from './api/routes.js';

// Optional login: any username, the password from DASHBOARD_PASSWORD.
function basicAuth(password) {
  const expected = Buffer.from(password);
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    const supplied =
      scheme === 'Basic' && encoded
        ? Buffer.from(Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':'))
        : Buffer.alloc(0);
    if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Job dashboard"').status(401).send('Login required');
  };
}

// A dashboard hosted on another address (its NEXT_PUBLIC_API_URL points here) may only read this API if
// the API names that address: CORS_ORIGINS. Answers the browser's preflight check for saving (PUT) too.
function allowOrigins(origins) {
  return (req, res, next) => {
    res.vary('Origin');
    const origin = req.headers.origin;
    if (!origin || !origins.includes(origin)) return next();
    res.set('Access-Control-Allow-Origin', origin);
    if (req.method !== 'OPTIONS') return next();
    res.set({
      'Access-Control-Allow-Methods': 'GET, PUT',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    res.status(204).end();
  };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Before the login check, which a browser's preflight request can't pass.
  if (config.corsOrigins.length) app.use('/api', allowOrigins(config.corsOrigins));

  // Before the login check so the host's health checks work.
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  if (config.dashboardPassword) app.use(basicAuth(config.dashboardPassword));

  app.use('/api', apiRoutes);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built Next.js dashboard (npm run build writes static files to client/out).
  const out = path.join(config.rootDir, 'client', 'out');
  if (fs.existsSync(out)) {
    // Pages are built as files: /course/data-analyst -> course/data-analyst.html. Checked before the
    // static files because the build also has a folder of the same name, which would win otherwise.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || path.extname(req.path)) return next();
      const page = path.join(out, `${req.path.replace(/\/+$/, '')}.html`);
      if (page.startsWith(out + path.sep) && fs.existsSync(page)) return res.sendFile(page);
      next();
    });
    app.use(express.static(out));
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(out, 'index.html')) : next()));
  }

  app.use((err, req, res, next) => {
    // A bad request (e.g. unreadable JSON) is the sender's mistake, not a server error.
    if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'The request could not be read.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs.' });
  });

  return app;
}
