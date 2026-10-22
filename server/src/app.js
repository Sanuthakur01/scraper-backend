import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import apiRoutes from './api/routes.js';
import { createClerkIdentify } from './auth.js';
import { createOpenAi } from './ai/openai.js';
import aiRoutes from './ai/routes.js';

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
// the API names that address: CORS_ORIGINS. Answers the browser's preflight check for saving (PUT), IJF AI
// (POST, streamed answers) and deleting a chat (DELETE) too.
function allowOrigins(origins) {
  return (req, res, next) => {
    res.vary('Origin');
    const origin = req.headers.origin;
    if (!origin || !origins.includes(origin)) return next();
    res.set('Access-Control-Allow-Origin', origin);
    if (req.method !== 'OPTIONS') return next();
    res.set({
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization', // Authorization: the Clerk sign-in
      'Access-Control-Max-Age': '600',
    });
    res.status(204).end();
  };
}

// identify: who sent a request (src/auth.js); by default checked with Clerk. Tests pass their own.
export function createApp({ identify = createClerkIdentify(config.clerk), ai = config.ai.apiKey ? createOpenAi(config.ai) : null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.identify = identify;
  app.locals.ai = ai; // IJF AI's model call (src/ai/openai.js), null when OPEN_AI_API_KEY isn't set

  // Before the login check, which a browser's preflight request can't pass.
  if (config.corsOrigins.length) app.use('/api', allowOrigins(config.corsOrigins));

  // Before the login check so the host's health checks work.
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  if (config.dashboardPassword) app.use(basicAuth(config.dashboardPassword));

  app.use('/api', aiRoutes);
  app.use('/api', apiRoutes);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built Next.js dashboard (npm run build writes static files to client/out).
  const out = path.join(config.rootDir, 'client', 'out');
  if (fs.existsSync(out)) {
    // Pages are built as files: /course/data-analyst -> course/data-analyst.html. Checked before the
    // static files because the build also has a folder of the same name, which would win otherwise.
    // HEAD as well as GET: the dashboard's links ask whether a page exists (HEAD /partners/) before
    // prefetching it.
    const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';
    app.use((req, res, next) => {
      if (!isRead(req) || path.extname(req.path)) return next();
      const page = path.join(out, `${req.path.replace(/\/+$/, '')}.html`);
      if (page.startsWith(out + path.sep) && fs.existsSync(page)) return res.sendFile(page);
      next();
    });
    app.use(express.static(out));
    app.use((req, res, next) => (isRead(req) ? res.sendFile(path.join(out, 'index.html')) : next()));
  }

  app.use((err, req, res, next) => {
    // A bad request (e.g. unreadable JSON, a date that doesn't exist) is the sender's mistake, not a
    // server error. publicMessage: what to tell them (set by our own checks).
    if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.publicMessage ?? 'The request could not be read.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs.' });
  });

  return app;
}
