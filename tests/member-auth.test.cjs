'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { authenticateMember, verifyMemberSession, clearMemberSessionCookie } =
  require('../netlify/functions/lib/member-auth.cjs');

async function fixture(run) {
  const values = {
    MEMBER_SESSION_SECRET: 'fixture-member-signing-secret-only-1234567890',
    ADMIN_SESSION_SECRET: 'fixture-admin-signing-secret-only-1234567890',
    SUPABASE_URL: 'https://chffnolrtxfoehegnecj.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_fixture_only_not_a_real_secret_123456789'
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const originalFetch = global.fetch;
  const members = [
    { id: 'fixture-alice', password: 'test-only-alice-密碼', status: 'active', paid: true,
      expiresAt: Date.now() + 86400000, memo: 'private-admin-note', tier: 'vip',
      history: [{ secret: 'own-history-not-returned-by-auth' }] },
    { id: 'fixture-bob', password: 'test-only-bob', status: 'active', paid: true,
      history: [{ secret: 'another-person-private-reading' }] }
  ];
  const calls = [];
  let upstream = async () => new Response(JSON.stringify([{ id: 'main', members }]));
  global.fetch = async (...args) => { calls.push(args); return upstream(...args); };
  const login = () => authenticateMember({ id: 'fixture-alice', password: 'test-only-alice-密碼' });
  const event = result => ({ headers: { cookie: result.cookie.split(';')[0] } });
  try { await run({ values, members, calls, login, event, setUpstream: fn => { upstream = fn; } }); }
  finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

test('missing/short/reused session secret fails closed before DB access', () => fixture(async ({ values, login, calls }) => {
  for (const secret of ['', 'short', values.ADMIN_SESSION_SECRET, values.MEMBER_SESSION_SECRET + ' ', 'x'.repeat(1025)]) {
    process.env.MEMBER_SESSION_SECRET = secret;
    assert.equal((await login()).status, 503);
    assert.equal((await verifyMemberSession({})).status, 503);
  }
  assert.equal(calls.length, 0);
}));

test('invalid credentials never query DB; ID trimming preserves legacy login behavior', () => fixture(async ({ calls }) => {
  for (const credentials of [null, [], 'bad', {}, { id: 'x', password: 12 },
    { id: ' ', password: 'x' }, { id: {}, password: 'x' },
    { id: 'x'.repeat(257), password: 'x' }, { id: 'x', password: 'x'.repeat(4097) }]) {
    assert.equal((await authenticateMember(credentials)).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal((await authenticateMember({ id: ' fixture-alice ', password: 'test-only-alice-密碼' })).status, 200);
}));

test('successful login returns only own identity, securely flagged cookie, no credentials/data writes', () => fixture(async ({ values, members, calls, login, event }) => {
  const original = JSON.stringify(members);
  const result = await login();
  assert.deepEqual(result.member, { type: 'member', id: 'fixture-alice' });
  assert.deepEqual(Object.keys(result).sort(), ['code', 'cookie', 'member', 'ok', 'status']);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/.netlify/functions/', 'Max-Age=1200']) {
    assert.ok(result.cookie.includes(flag));
  }
  const payload = JSON.parse(Buffer.from(result.cookie.split('=')[1].split('.')[0], 'base64url'));
  assert.equal(payload.role, 'member');
  assert.equal(payload.exp - payload.iat, 1200);
  const exposed = JSON.stringify([result, payload]);
  for (const value of [members[0].password, members[1].password, members[1].id,
    members[0].memo, 'own-history-not-returned-by-auth', 'another-person-private-reading', values.SUPABASE_SECRET_KEY]) {
    assert.ok(!exposed.includes(value));
  }
  const verified = await verifyMemberSession({ ...event(result), queryStringParameters: { id: 'fixture-bob' }, body: '{"id":"fixture-bob"}' });
  assert.deepEqual(verified.member, result.member);
  assert.equal(verified.cookie, undefined);
  assert.equal(JSON.stringify(members), original);
  assert.equal(calls.length, 2);
  for (const [url, options] of calls) {
    assert.equal(url, values.SUPABASE_URL + '/rest/v1/app_state?select=id,members&id=eq.main&limit=1');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { apikey: values.SUPABASE_SECRET_KEY, Accept: 'application/json' });
    assert.equal(options.body, undefined);
  }
}));

test('unknown IDs, wrong passwords, disabled/unpaid/expired accounts have identical failure responses', () => fixture(async ({ members, login }) => {
  const expected = { ok: false, status: 401, code: 'MEMBER_LOGIN_REQUIRED' };
  assert.deepEqual(await authenticateMember({ id: 'missing-id', password: 'x' }), expected);
  assert.deepEqual(await authenticateMember({ id: members[0].id, password: 'wrong' }), expected);
  for (const status of ['pending', 'expired', 'blocked', 'disabled', 'deleted', 'admin', undefined]) {
    members[0].status = status;
    assert.deepEqual(await login(), expected);
  }
  members[0].status = 'active';
  members[0].paid = false;
  assert.deepEqual(await login(), expected);
  members[0].paid = true;
  for (const expiresAt of [0, Date.now() - 1000, '4102444800000', {}]) {
    members[0].expiresAt = expiresAt;
    assert.equal((await login()).status, 401);
  }
}));

test('approved/active/expiring-soon legacy states with absent/null expiry remain explicit supported cases', () => fixture(async ({ members, login }) => {
  for (const status of ['approved', 'active', 'expiring_soon']) {
    members[0].status = status;
    for (const expiresAt of [undefined, null, Date.now() + 86400000]) {
      members[0].expiresAt = expiresAt;
      assert.equal((await login()).status, 200);
    }
  }
}));

test('session verification rejects fake/duplicate/admin/bearer cookies before DB access', () => fixture(async ({ login, event, calls }) => {
  const result = await login();
  const valid = event(result).headers.cookie;
  calls.length = 0;
  for (const headers of [{}, { authorization: 'Bearer ' + valid }, { 'x-member-id': 'fixture-alice' },
    { cookie: valid + 'x' }, { cookie: valid + '; ' + valid },
    { cookie: valid.replace('pjo_member_session=', 'pjo_admin_session=') },
    { cookie: 'pjo_member_session=bad' }, { cookie: 'x'.repeat(16385) }]) {
    assert.equal((await verifyMemberSession({ headers })).status, 401);
  }
  assert.equal(calls.length, 0);
}));

test('signed invalid claims and wrong signing domain/secret are rejected before DB access', () => fixture(async ({ values, login, calls }) => {
  const result = await login();
  const payload = JSON.parse(Buffer.from(result.cookie.split('=')[1].split('.')[0], 'base64url'));
  const signed = (claims, secret = values.MEMBER_SESSION_SECRET, domain = 'pjo-member-v1:session\0') => {
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(domain).update(encoded).digest('base64url');
    return { headers: { cookie: 'pjo_member_session=' + encoded + '.' + signature } };
  };
  calls.length = 0;
  for (const mutation of [{ role: 'admin' }, { v: 2 }, { iat: payload.iat + 60, exp: payload.exp + 60 },
    { iat: 1, exp: 1201 }, { exp: payload.exp + 1 }, { sub: {} }, { cv: '' }, { jti: '' }]) {
    assert.equal((await verifyMemberSession(signed({ ...payload, ...mutation }))).status, 401);
  }
  assert.equal((await verifyMemberSession(signed(payload, values.ADMIN_SESSION_SECRET))).status, 401);
  assert.equal((await verifyMemberSession(signed(payload, values.MEMBER_SESSION_SECRET, ''))).status, 401);
  assert.equal(calls.length, 0);
}));

test('each valid session rechecks DB: deletion, password change, disabled status and expiry invalidate it', () => fixture(async ({ members, login, event }) => {
  const result = await login();
  const original = { ...members[0] };
  for (const mutation of [{ password: 'changed' }, { status: 'blocked' }, { paid: false }, { expiresAt: 1 }]) {
    Object.assign(members[0], original, mutation);
    assert.equal((await verifyMemberSession(event(result))).status, 401);
  }
  members.shift();
  assert.equal((await verifyMemberSession(event(result))).status, 401);
}));

test('session expiring while DB is loading is rejected', () => fixture(async ({ login, event, setUpstream, members }) => {
  const result = await login();
  const originalNow = Date.now;
  setUpstream(async () => {
    Date.now = () => originalNow() + 1201000;
    return new Response(JSON.stringify([{ id: 'main', members }]));
  });
  try { assert.equal((await verifyMemberSession(event(result))).status, 401); }
  finally { Date.now = originalNow; }
}));

test('duplicate IDs/malformed data/oversized response never authenticate or initialize DB', () => fixture(async ({ members, login, setUpstream, calls }) => {
  for (const rows of [[], {}, null, [{ id: 'other', members }], [{ id: 'main', members: {} }],
    [{ id: 'main', members: [null] }], [{ id: 'main', members: [members[0], members[0]] }],
    [{ id: 'main', members: Array(10001).fill(members[0]) }]]) {
    setUpstream(async () => new Response(JSON.stringify(rows)));
    assert.equal((await login()).status, 503);
  }
  for (const body of ['invalid JSON', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    setUpstream(async () => new Response(body));
    assert.equal((await login()).status, 503);
  }
  assert.ok(calls.every(([,options]) => options.method === 'GET'));
}));

test('invalid server config never transmits credentials; upstream details never escape', () => fixture(async ({ values, login, calls, setUpstream }) => {
  process.env.SUPABASE_URL = 'https://example.com';
  assert.equal((await login()).status, 503);
  assert.equal(calls.length, 0);
  process.env.SUPABASE_URL = values.SUPABASE_URL;
  for (const status of [401, 403, 429, 500]) {
    setUpstream(async () => new Response('private DB details ' + values.SUPABASE_SECRET_KEY, { status }));
    assert.deepEqual(await login(), { ok: false, status: 503, code: 'MEMBER_AUTH_UNAVAILABLE' });
  }
  setUpstream(async () => { throw Error(values.SUPABASE_SECRET_KEY); });
  assert.deepEqual(await login(), { ok: false, status: 503, code: 'MEMBER_AUTH_UNAVAILABLE' });
}));

test('eight-second timeout covers streamed body and clears timer', () => fixture(async ({ login, setUpstream }) => {
  const originalTimer = global.setTimeout, originalClear = global.clearTimeout;
  let requestedTimeout, cleared = false;
  global.setTimeout = (fn, ms) => { requestedTimeout = ms; return originalTimer(fn, 5); };
  global.clearTimeout = timer => { cleared = true; return originalClear(timer); };
  setUpstream(async (_, options) => new Response(new ReadableStream({
    start(controller) { options.signal.addEventListener('abort', () => controller.error(Error('timeout')), { once: true }); }
  })));
  try {
    assert.equal((await login()).status, 503);
    assert.equal(requestedTimeout, 8000);
    assert.equal(cleared, true);
  } finally { global.setTimeout = originalTimer; global.clearTimeout = originalClear; }
}));

test('logout helper only clears member cookie; it does not delete data or expose an HTTP handler', () => {
  const cookie = clearMemberSessionCookie();
  assert.ok(cookie.startsWith('pjo_member_session=;'));
  assert.ok(cookie.includes('Max-Age=0'));
  assert.ok(!cookie.includes('admin'));
  assert.equal(require('../netlify/functions/lib/member-auth.cjs').handler, undefined);
});
