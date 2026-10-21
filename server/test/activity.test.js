// The activity record's two parts: who made a request (src/auth.js, Clerk replaced by stand-ins) and
// what changed in a job's HR details (src/activity.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { verifyToken } from '@clerk/backend';
import { contactChanges, overallAction } from '../src/activity.js';
import { AuthError, createClerkIdentify } from '../src/auth.js';
import { can, roleFrom } from '../src/config/access.js';

const view = (contact) => ({ phone: '', email: '', remarks: '', assignedTo: [], ...contact });

test('changes: added, edited (with what was added and removed) and removed, field by field', () => {
  assert.deepEqual(contactChanges(view({}), view({})), [], 'nothing changed');
  let changes = contactChanges(view({}), view({ phone: '98765 43210', remarks: 'Called HR' }));
  assert.deepEqual(changes.map((c) => [c.field, c.change, c.added, c.after]), [
    ['phone', 'added', ['98765 43210'], ['98765 43210']],
    ['remarks', 'added', [], ['Called HR']],
  ]);
  assert.equal(overallAction(changes), 'added');

  changes = contactChanges(
    view({ phone: '98765 43210', email: 'a@x.in', assignedTo: ['Riya'], remarks: 'Called HR' }),
    view({ phone: '98765 43210, 080 4123 4567', email: '', assignedTo: ['Aman'], remarks: 'Called HR twice' }),
  );
  const by = Object.fromEntries(changes.map((c) => [c.field, c]));
  assert.deepEqual([by.phone.change, by.phone.added, by.phone.removed], ['edited', ['080 4123 4567'], []]);
  assert.deepEqual([by.email.change, by.email.before, by.email.after], ['removed', ['a@x.in'], []]);
  assert.deepEqual([by.assignedTo.change, by.assignedTo.added, by.assignedTo.removed], ['edited', ['Aman'], ['Riya']]);
  assert.deepEqual([by.remarks.change, by.remarks.before, by.remarks.after], ['edited', ['Called HR'], ['Called HR twice']]);
  assert.equal(overallAction(changes), 'edited');

  changes = contactChanges(view({ phone: '98765 43210', assignedTo: ['Riya'] }), view({}));
  assert.equal(overallAction(changes), 'removed');
});

test('changes: the same number written differently is not removed and added again', () => {
  const [change] = contactChanges(view({ phone: '98765 43210' }), view({ phone: '+91 98765-43210' }));
  assert.deepEqual([change.change, change.added, change.removed, change.after], ['edited', [], [], ['+91 98765-43210']]);
  const [email] = contactChanges(view({ email: 'HR@Acme.in' }), view({ email: 'hr@acme.in' }));
  assert.deepEqual([email.added, email.removed], [[], []], 'emails compared ignoring case');
});

const user = (role, email = 'riya@ijf.example') => ({ firstName: 'Riya', lastName: '', primaryEmailAddress: { emailAddress: email }, publicMetadata: { role } });
const request = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
// What Clerk's verifyToken throws for a bad token: an error with a `reason`.
const rejected = (reason, message) => Object.assign(new Error(message), { reason });

test('sign-in check: no token, a bad token, or Clerk unreachable are refused with the right status', async () => {
  const identify = createClerkIdentify({
    secretKey: 'sk_test_fake',
    verify: async (token) => {
      if (token === 'down') throw rejected('jwk-remote-failed-to-load', 'fetch failed');
      if (token === 'throws') throw new Error('network');
      if (token === 'malformed') throw rejected('token-invalid', 'Invalid JWT form');
      if (token === 'nosub') return {};
      if (token === 'good') return { sub: 'user_1' };
      throw rejected('token-expired', 'JWT is expired');
    },
    getUser: async () => user('ADMIN'),
  });
  const status = async (token) => identify(request(token)).then(() => 200, (err) => (err instanceof AuthError ? err.status : err));
  assert.equal(await status(null), 401);
  assert.equal(await status('expired'), 401);
  assert.equal(await status('down'), 503, "Clerk's keys can't be loaded: not the person's fault");
  assert.equal(await status('throws'), 503, 'the check broke (no reason given)');
  assert.equal(await status('malformed'), 401, "Clerk throws for a malformed token: still the token's fault");
  assert.equal(await status('nosub'), 401, 'a token without a user');
  assert.equal(await status('good'), 200);
});

test('sign-in check: the email, name and role come from Clerk, and are reused for a minute', async () => {
  let lookups = 0;
  const parties = [];
  const identify = createClerkIdentify({
    secretKey: 'sk_test_fake',
    authorizedParties: ['https://dash.example.com'],
    verify: async (token, options) => {
      parties.push(options.authorizedParties);
      return { sub: token };
    },
    getUser: async (id) => {
      lookups++;
      return id === 'user_norole' ? user(undefined, 'guest@ijf.example') : user('placement staff');
    },
  });
  assert.deepEqual(await identify(request('user_1')), { userId: 'user_1', email: 'riya@ijf.example', name: 'Riya', role: 'PLACEMENT_STAFF' });
  await identify(request('user_1'));
  assert.equal(lookups, 1, 'looked up once');
  assert.deepEqual(parties[0], ['https://dash.example.com'], 'only sign-ins from the dashboard addresses');
  assert.equal((await identify(request('user_norole'))).role, null);

  const failing = createClerkIdentify({ secretKey: 'sk', verify: async () => ({ sub: 'u' }), getUser: async () => { throw new Error('down'); } });
  await assert.rejects(failing(request('t')), (err) => err instanceof AuthError && err.status === 503);
});

// Clerk's own verifyToken (not a stand-in), on tokens signed here: checked with a local public key
// (jwtKey), so no network. Catches a wrong idea of what verifyToken returns.
test("sign-in check with Clerk's real verifyToken: a valid token gets in, an expired or forged one doesn't", async () => {
  const keys = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { privateKey, publicKey } = keys();
  const jwtKey = publicKey.export({ type: 'spki', format: 'pem' });
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const sign = (claims, key = privateKey) => {
    const body = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'ins_test' })}.${b64(claims)}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: 'user_real', iss: 'https://clerk.example.com', iat: now - 5, nbf: now - 5, exp: now + 60, azp: 'https://dash.example.com' };
  const identify = createClerkIdentify({
    secretKey: 'sk_test_fake',
    authorizedParties: ['https://dash.example.com'],
    verify: (token, options) => verifyToken(token, { ...options, jwtKey }),
    getUser: async () => user('RESEARCH_TEAM'),
  });
  const status = async (token) => identify(request(token)).then(() => 200, (err) => (err instanceof AuthError ? err.status : err));

  assert.deepEqual(await identify(request(sign(claims))), { userId: 'user_real', email: 'riya@ijf.example', name: 'Riya', role: 'RESEARCH_TEAM' });
  assert.equal(await status(sign({ ...claims, iat: now - 300, nbf: now - 300, exp: now - 120 })), 401, 'expired');
  assert.equal(await status(sign(claims, keys().privateKey)), 401, 'signed with another key');
  assert.equal(await status(sign({ ...claims, azp: 'https://elsewhere.example.com' })), 401, 'from another site');
});

test('the server knows the same four roles and permissions as the dashboard', () => {
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'PLACEMENT_STAFF', 'RESEARCH_TEAM']) {
    assert.equal(roleFrom({ role }), role);
    assert.ok(can(role, 'view') && can(role, 'edit-hr-details'), role);
  }
  assert.equal(roleFrom({ role: 'STUDENT' }), null);
  assert.equal(can(null, 'view'), false);
});
