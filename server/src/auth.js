// Who is making a request. The dashboard sends the signed-in person's Clerk session token
// ("Authorization: Bearer …"); it is checked with Clerk, and the person's email, name and role (Clerk
// public metadata) are looked up. The email comes from Clerk, never from the browser, so it can't be
// made up: this is the name an activity record shows.

import { createClerkClient, verifyToken } from '@clerk/backend';
import { can, roleFrom } from './config/access.js';

// A request that is refused for who sent it: 401 (not signed in), 403 (not allowed), 503 (sign-in
// can't be checked right now).
export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// How long a person's email and role are reused before asking Clerk again. Short, so a role taken
// away in Clerk stops working within a minute.
const PERSON_TTL_MS = 60_000;

// Token problems that are this server's or Clerk's, not the person's (e.g. Clerk can't be reached).
const SERVER_SIDE = /jwk-remote-failed-to-load|jwk-failed-to-resolve|secret-key-invalid|jwk-remote-invalid|jwk-remote-missing/i;

// A failed token check: 401 when the token itself is wrong (expired, made up, from another app: Clerk
// gives a reason), 503 when the check couldn't be done (a server-side reason, or none, e.g. no network).
const failedCheck = (error) => {
  const reason = String(error?.reason ?? '');
  if (reason && !SERVER_SIDE.test(reason)) return new AuthError(401, 'Your sign-in has expired. Reload the page, then try again.');
  console.error(`Clerk token check failed: ${reason} ${error?.message ?? ''}`);
  return new AuthError(503, "Your sign-in couldn't be checked right now. Please try again in a minute.");
};

const personFrom = (userId, user) => ({
  userId,
  email: user.primaryEmailAddress?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? '',
  name: [user.firstName, user.lastName].filter(Boolean).join(' '),
  role: roleFrom(user.publicMetadata),
});

// identify(req) -> { userId, email, name, role } (role null when it isn't an allowed one), or throws
// an AuthError. verify and getUser can be replaced (tests); by default they ask Clerk.
export function createClerkIdentify({ secretKey, authorizedParties = [], verify = verifyToken, getUser } = {}) {
  if (!secretKey) {
    return async () => {
      throw new AuthError(503, "Sign-in isn't set up on the server: CLERK_SECRET_KEY is missing. Changes can't be saved until it is set.");
    };
  }
  const loadUser = getUser ?? ((userId) => createClerkClient({ secretKey }).users.getUser(userId));
  const people = new Map(); // userId -> { at, person }

  return async function identify(req) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new AuthError(401, 'Please sign in again.');

    // Clerk's verifyToken returns the token's claims, and throws when the token is bad or can't be
    // checked (the error's `reason` says which).
    let claims;
    try {
      claims = await verify(token, { secretKey, ...(authorizedParties.length ? { authorizedParties } : {}) });
    } catch (err) {
      throw failedCheck(err);
    }
    const userId = claims?.sub;
    if (typeof userId !== 'string' || !userId) throw new AuthError(401, 'Please sign in again.');
    const known = people.get(userId);
    if (known && Date.now() - known.at < PERSON_TTL_MS) return known.person;
    let user;
    try {
      user = await loadUser(userId);
    } catch (err) {
      console.error(`Clerk user lookup failed: ${err.message}`);
      throw new AuthError(503, "Your account couldn't be checked right now. Please try again in a minute.");
    }
    const person = personFrom(userId, user);
    people.set(userId, { at: Date.now(), person });
    return person;
  };
}

// Express middleware: only a signed-in person whose role has `permission` gets through; they are on
// req.person afterwards. identify comes from app.locals (see createApp).
export function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const person = await req.app.locals.identify(req);
      if (!person.role) {
        return res.status(403).json({ error: "Your account doesn't have a role that can use the dashboard. Ask an admin to set it in Clerk." });
      }
      if (!can(person.role, permission)) {
        return res.status(403).json({
          error: permission === 'edit-hr-details' ? "Your role can't change HR details." : "Your role can't see this.",
        });
      }
      req.person = person;
      next();
    } catch (err) {
      if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };
}
