'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { issueSessionCookie } = require('../netlify/functions/_admin-session');
const { hashPassword, verifyPassword, hasValidCredential } = require('../netlify/functions/lib/member-password.cjs');
const { authenticateMember, verifyMemberSession, auditMemberMigration } = require('../netlify/functions/lib/member-auth.cjs');
const loginRoute = require('../netlify/functions/member-login').handler;
const sessionRoute = require('../netlify/functions/member-session').handler;
const logoutRoute = require('../netlify/functions/member-logout').handler;
const dataRoute = require('../netlify/functions/member-data').handler;
const body = response => JSON.parse(response.body);

async function fixture(run) {
  const env = {
    MEMBER_ACCESS_MODE: 'rehearsal', MEMBER_REHEARSAL_IDS: 'fixture-alice,fixture-bob',
    MEMBER_SESSION_SECRET: 'fixture-member-signing-secret-only-1234567890',
    ADMIN_SESSION_SECRET: 'fixture-admin-signing-secret-only-1234567890',
    ADMIN_MASTER_CODE: 'fixture-admin-master-only',
    SUPABASE_URL: 'https://chffnolrtxfoehegnecj.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_fixture_only_not_a_real_secret_123456789'
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const row = { id: 'main', members: ['alice', 'bob'].map(name => ({
    id: 'fixture-' + name, password: 'test-only-' + name, status: 'active', paid: true,
    memo: name + '-private-admin-memo', history: [{ id: name + '-reading', q: name + '-question',
      readingHtml: '<p>' + name + '-archive</p>', cardsHtml: '<div>card</div>',
      fullSummary: name + '-full-reading', unexpectedSecret: name + '-private-extra', favorite: true, time: 123 }]
  })), logs: [
    { id: 'fixture-alice', userId: 'fixture-alice', action: 'Private consult message', consultId: 'shared-id', role: 'user', message: 'alice-message', time: 10 },
    { id: 'fixture-bob', userId: 'fixture-bob', action: 'Private consult message', consultId: 'shared-id', role: 'admin', message: 'bob-private-answer', time: 20 },
    { id: 'fixture-alice', userId: 'fixture-bob', action: 'Private consult message', consultId: 'shared-id', role: 'user', message: 'bob-conflicting-owner', time: 30 },
    { id: 'fixture-alice', userId: 'fixture-alice', action: 'Admin audit', message: 'private-admin-log', time: 40 }
  ], guest_codes: [{ secret: 'guest-private' }] };
  const originalFetch = global.fetch;
  const calls = [];
  let upstream = () => new Response(JSON.stringify([row]));
  global.fetch = async (...args) => { calls.push(args); return upstream(...args); };
  const adminCookie = issueSessionCookie(env.ADMIN_SESSION_SECRET).split(';')[0];
  const event = (method = 'GET', memberCookie = '') => ({ httpMethod: method, headers: {
    cookie: adminCookie + (memberCookie ? '; ' + memberCookie.split(';')[0] : ''),
    origin: 'https://pjtarot.netlify.app', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin'
  } });
  const login = (name = 'alice') => loginRoute({ ...event('POST'), body: JSON.stringify({
    id: 'fixture-' + name, password: 'test-only-' + name
  }) });
  try { await run({ env, row, calls, event, login, setUpstream: fn => { upstream = fn; } }); }
  finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

test('new endpoints default disabled; no production bypass or invalid configuration access', () => fixture(async ({ login, calls }) => {
  for (const mode of ['', 'production', 'true', 'rehearsal ']) {
    process.env.MEMBER_ACCESS_MODE = mode;
    assert.equal((await login()).statusCode, 503);
  }
  process.env.MEMBER_ACCESS_MODE = 'rehearsal';
  for (const ids of ['', ',', 'fixture-alice,', Array(21).fill('x').join(',')]) {
    process.env.MEMBER_REHEARSAL_IDS = ids;
    assert.equal((await login()).statusCode, 503);
  }
  assert.equal(calls.length, 0);
}));

test('all four routes require an admin cookie before DB; methods and origin are constrained', () => fixture(async ({ calls, event }) => {
  for (const [route, method] of [[loginRoute, 'POST'], [sessionRoute, 'GET'], [dataRoute, 'GET'], [logoutRoute, 'POST']]) {
    const request = event(method);
    request.headers.cookie = '';
    assert.equal((await route(request)).statusCode, 401);
    assert.equal((await route({ ...event(), httpMethod: 'DELETE' })).statusCode, 405);
  }
  for (const route of [loginRoute, logoutRoute]) {
    const request = event('POST');
    request.headers.origin = 'https://evil.example';
    assert.equal((await route(request)).statusCode, 403);
    request.headers.origin = 'https://pjtarot.netlify.app';
    request.headers['content-type'] = 'text/plain';
    assert.equal((await route(request)).statusCode, 415);
  }
  assert.equal(calls.length, 0);
}));

test('non-test accounts and malformed bodies never reach DB', () => fixture(async ({ calls, event }) => {
  for (const payload of [{ id: 'real-member', password: 'test' }, { id: null }, {}]) {
    assert.equal((await loginRoute({ ...event('POST'), body: JSON.stringify(payload) })).statusCode, 401);
  }
  assert.equal((await loginRoute({ ...event('POST'), body: '[' })).statusCode, 400);
  assert.equal((await loginRoute({ ...event('POST'), body: 'x'.repeat(17000) })).statusCode, 413);
  assert.equal(calls.length, 0);
}));

test('HTTP login/session return only identity; cookie only in Set-Cookie, never JSON', () => fixture(async ({ login, event, row }) => {
  const result = await login();
  assert.equal(result.statusCode, 200);
  assert.deepEqual(body(result), { ok: true, code: 'MEMBER_AUTHENTICATED', member: { type: 'member', id: 'fixture-alice' } });
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=1200']) assert.ok(result.headers['Set-Cookie'].includes(flag));
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
  assert.ok(!result.body.includes(row.members[0].password));
  assert.equal((await sessionRoute(event('GET', result.headers['Set-Cookie']))).statusCode, 200);
  row.members[0].password = 'new-password';
  assert.equal((await sessionRoute(event('GET', result.headers['Set-Cookie']))).statusCode, 401);
}));

test('each test member can read only their own account/history/reading/consultations', () => fixture(async ({ row, calls, login, event }) => {
  const original = JSON.stringify(row);
  for (const name of ['alice', 'bob']) {
    const other = name === 'alice' ? 'bob' : 'alice';
    const signed = await login(name);
    const request = event('GET', signed.headers['Set-Cookie']);
    for (const resource of ['account', 'history', 'reading', 'consultations']) {
      calls.length = 0;
      const query = { resource, ...(resource === 'reading' ? { readingId: name + '-reading' } : {}) };
      const result = await dataRoute({ ...request, queryStringParameters: query });
      assert.equal(result.statusCode, 200);
      for (const forbidden of [other, 'password', 'private-admin', 'private-extra', 'guest-private']) {
        assert.ok(!result.body.includes(forbidden), result.body);
      }
      assert.equal(calls.length, 1, 'authorization and projection use one snapshot');
      assert.ok(calls[0][0].includes(resource === 'consultations' ? 'select=id,members,logs&' : 'select=id,members&'));
      assert.equal(calls[0][1].method, 'GET');
      if (resource === 'history') assert.ok(!result.body.includes('readingHtml'));
      if (resource === 'reading') assert.equal(body(result).data.readingHtml, '<p>' + name + '-archive</p>');
    }
    const missing = await dataRoute({ ...request, queryStringParameters: { resource: 'reading', readingId: other + '-reading' } });
    assert.equal(missing.statusCode, 404);
  }
  assert.equal(JSON.stringify(row), original, 'no record edits, initialization, password or status migration');
}));

test('query impersonation and unsigned callers fail before DB access', () => fixture(async ({ calls, login, event }) => {
  const signed = await login();
  const request = event('GET', signed.headers['Set-Cookie']);
  calls.length = 0;
  for (const query of [{ id: 'fixture-bob' }, { userId: 'fixture-bob' }, { table: 'app_state' },
    { resource: 'unknown' }, { resource: 'reading' }, { resource: 'reading', readingId: 'x'.repeat(257) }, { readingId: 'x' }]) {
    assert.equal((await dataRoute({ ...request, queryStringParameters: query })).statusCode, 400);
  }
  assert.equal((await dataRoute(event())).statusCode, 401);
  process.env.MEMBER_REHEARSAL_IDS = 'fixture-bob';
  assert.equal((await dataRoute(request)).statusCode, 401);
  assert.equal((await sessionRoute(request)).statusCode, 401);
  assert.equal(calls.length, 0);
}));

test('deleted/disabled members and malformed history/logs fail closed without writes', () => fixture(async ({ row, login, event, calls }) => {
  const signed = await login();
  const request = event('GET', signed.headers['Set-Cookie']);
  row.members[0].status = 'blocked';
  assert.equal((await dataRoute(request)).statusCode, 401);
  row.members[0].status = 'active';
  row.members[0].history.push(row.members[0].history[0]);
  assert.equal((await dataRoute({ ...request, queryStringParameters: { resource: 'history' } })).statusCode, 503);
  row.logs = null;
  assert.equal((await dataRoute({ ...request, queryStringParameters: { resource: 'consultations' } })).statusCode, 503);
  row.members.shift();
  assert.equal((await dataRoute(request)).statusCode, 401);
  assert.ok(calls.every(([, options]) => options.method === 'GET' && !options.body));
}));

test('admin session expiration during upstream work discards result/cookie', () => fixture(async ({ row, login, setUpstream }) => {
  const originalNow = Date.now;
  setUpstream(() => { Date.now = () => originalNow() + 1201000; return new Response(JSON.stringify([row])); });
  try {
    const result = await login();
    assert.equal(result.statusCode, 401);
    assert.equal(result.headers['Set-Cookie'], undefined);
  } finally { Date.now = originalNow; }
}));

test('logout clears only member cookie and never accesses or mutates DB', () => fixture(async ({ calls, event }) => {
  const result = await logoutRoute(event('POST'));
  assert.equal(result.statusCode, 200);
  assert.match(result.headers['Set-Cookie'], /^pjo_member_session=;/);
  assert.ok(result.headers['Set-Cookie'].includes('Max-Age=0'));
  assert.equal(body(result).cookie, undefined);
  assert.equal(calls.length, 0);
}));

test('oversized own archive and upstream errors produce bounded, redacted responses', () => fixture(async ({ row, login, event, setUpstream }) => {
  const signed = await login();
  const request = { ...event('GET', signed.headers['Set-Cookie']), queryStringParameters: { resource: 'reading', readingId: 'alice-reading' } };
  row.members[0].history[0].readingHtml = 'x'.repeat(4 * 1024 * 1024);
  assert.equal(body(await dataRoute(request)).code, 'MEMBER_RESPONSE_TOO_LARGE');
  setUpstream(() => { throw new Error('private-upstream-error-and-credentials'); });
  const failed = await dataRoute(request);
  assert.equal(failed.statusCode, 503);
  assert.ok(!failed.body.includes('private-upstream'));
}));

test('salted scrypt hashes differ, preserve Unicode/spaces exactly and reject invalid formats', async () => {
  const password = '  비밀번호-é-🔐  ';
  const first = await hashPassword(password), second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, { passwordHash: first }), true);
  for (const wrong of [password.trim(), password.normalize('NFD'), 'wrong']) {
    assert.equal(await verifyPassword(wrong, { passwordHash: first }), false);
  }
  for (const malformed of ['', null, {}, first.replace('v1', 'v999'), first + ' ', 'scrypt$999999999$8$3']) {
    const member = { password, passwordHash: malformed };
    assert.equal(hasValidCredential(member), false);
    assert.equal(await verifyPassword(password, member), false, 'never fall back to plaintext');
  }
  for (const invalid of ['', null, 'x'.repeat(4097)]) await assert.rejects(hashPassword(invalid));
});

test('hash-only fixture login works; changed hash invalidates cookie; audit does not migrate credentials', () => fixture(async ({ row, event }) => {
  const member = row.members[0];
  member.passwordHash = await hashPassword(member.password);
  delete member.password;
  const original = JSON.stringify(row);
  const signed = await authenticateMember({ id: member.id, password: 'test-only-alice' });
  assert.equal(signed.status, 200);
  assert.equal((await verifyMemberSession(event('GET', signed.cookie))).status, 200);
  assert.equal(JSON.stringify(row), original);
  const audit = await auditMemberMigration();
  assert.equal(audit.counts.hashedPassword, 1);
  assert.equal(audit.counts.legacyPlaintextPassword, 1);
  assert.equal(audit.counts.invalidPasswordFormat, 0);
  member.passwordHash = await hashPassword('replacement');
  assert.equal((await verifyMemberSession(event('GET', signed.cookie))).status, 401);
}));
