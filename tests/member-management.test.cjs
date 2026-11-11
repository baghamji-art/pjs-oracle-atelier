'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('../netlify/functions/member-register').handler;
const read = require('../netlify/functions/admin-member').handler;
const update = require('../netlify/functions/admin-member-update').handler;
const { issueSessionCookie } = require('../netlify/functions/_admin-session');
const { managementRevision, managementSnapshot, PERMANENT_EXPIRY } = require('../netlify/functions/lib/member-management.cjs');
const { verifyPassword } = require('../netlify/functions/lib/member-password.cjs');

async function fixture(run) {
  const env = { MEMBER_ACCESS_MODE: 'rehearsal', MEMBER_ACCOUNT_WRITE_MODE: 'rehearsal', MEMBER_SIGNUP_POLICY: 'instant-permanent',
    MEMBER_REHEARSAL_IDS: 'fixture-new,fixture-existing', MEMBER_SESSION_SECRET: 'fixture-member-signing-secret-only-1234567890',
    ADMIN_SESSION_SECRET: 'fixture-admin-signing-secret-only-1234567890', ADMIN_MASTER_CODE: 'fixture-admin-master-only',
    SUPABASE_URL: 'https://chffnolrtxfoehegnecj.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_fixture_only_not_a_real_secret_123456789' };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  const member = { id: 'fixture-existing', password: 'existing-private', status: 'pending', paid: false,
    history: [{ text: 'private-reading' }], memo: 'admin note', createdAt: 1, extra: { keep: true } };
  const originalFetch = global.fetch; const calls = [];
  let rpc = url => new Response(JSON.stringify({ result: url.endsWith('pjo_member_register_v1') ? 'created' : 'saved' }));
  global.fetch = async (url, options) => {
    calls.push([url, options]);
    return options.method === 'GET' ? new Response(JSON.stringify([{ id: 'main', members: [member] }])) : rpc(url, options);
  };
  const request = (body, method = 'POST') => ({ httpMethod: method, headers: { cookie: issueSessionCookie(env.ADMIN_SESSION_SECRET).split(';')[0],
    origin: 'https://pjtarot.netlify.app', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const signup = { id: 'fixture-new', password: '  정확한 비밀번호🔐 ', requestId: 'fixture-request-0001' };
  const entitlement = { plan: 'permanent', tier: 'member', permanent: true, expiresAt: PERMANENT_EXPIRY };
  const command = () => ({ action: 'approve', memberId: member.id, revision: managementRevision(member), entitlement });
  try { await run({ member, calls, request, signup, command, entitlement, setRpc: fn => { rpc = fn; } }); }
  finally { global.fetch = originalFetch; for (const k of Object.keys(env)) if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
}

test('account writes need explicit rehearsal and confirmed policy; all routes need admin cookie', () => fixture(async ({ request, signup, command, calls }) => {
  for (const mode of ['', 'production', 'true']) {
    process.env.MEMBER_ACCOUNT_WRITE_MODE = mode;
    assert.equal((await register(request(signup))).statusCode, 503);
    assert.equal((await update(request(command()))).statusCode, 503);
  }
  process.env.MEMBER_ACCOUNT_WRITE_MODE = 'rehearsal'; process.env.MEMBER_SIGNUP_POLICY = 'pending';
  assert.equal((await register(request(signup))).statusCode, 503);
  for (const [route, method] of [[register,'POST'],[update,'POST'],[read,'GET']]) {
    const event = request(signup, method); event.headers.cookie = '';
    assert.equal((await route(event)).statusCode, 401);
    assert.equal((await route({ ...event, httpMethod: 'DELETE' })).statusCode, 405);
  }
  assert.equal(calls.length, 0);
}));

test('registration rejects privileged fields, real-user IDs and invalid credentials before DB', () => fixture(async ({ request, signup, calls }) => {
  for (const extra of [{ role: 'admin' }, { tier: 'vip' }, { paid: true }, { status: 'active' }, { expiresAt: 0 },
    { passwordHash: 'x' }, { history: [] }, { password: '' }, { id: ' x ' }, { id: '\n' }, { requestId: 'short' },
    { password: 'x'.repeat(4097) }]) assert.equal((await register(request({ ...signup, ...extra }))).statusCode, 400);
  assert.equal((await register(request({ ...signup, id: 'real-user' }))).statusCode, 401);
  const cross = request(signup); cross.headers.origin = 'https://evil.example';
  assert.equal((await register(cross)).statusCode, 403);
  assert.equal((await register({ ...request(signup), body: 'x'.repeat(65537) })).statusCode, 413);
  assert.equal(calls.length, 0);
}));

test('registration sends salted hash only, stable retry fingerprint, no raw password or cookie response', () => fixture(async ({ request, signup, calls }) => {
  const first = await register(request(signup)), second = await register(request(signup));
  assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200);
  assert.equal(calls.length, 2);
  const a = JSON.parse(calls[0][1].body), b = JSON.parse(calls[1][1].body);
  assert.equal(a.p_member_id, signup.id); assert.equal(a.p_request_id, signup.requestId);
  assert.equal(a.p_fingerprint, b.p_fingerprint); assert.notEqual(a.p_password_hash, b.p_password_hash);
  assert.equal(await verifyPassword(signup.password, { passwordHash: a.p_password_hash }), true);
  assert.equal(a.password, undefined); assert.ok(!calls[0][1].body.includes(signup.password));
  for (const response of [first, second]) {
    assert.ok(!response.body.includes(a.p_password_hash)); assert.ok(!response.body.includes(a.p_fingerprint));
    assert.equal(response.headers['Set-Cookie'], undefined); assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(JSON.parse(response.body).next, 'member-login');
  }
}));

test('admin read is explicit allowlist plus opaque revision, never credentials or reading history', () => fixture(async ({ request, member, calls }) => {
  const event = { ...request(undefined, 'GET'), queryStringParameters: { memberId: member.id } };
  const response = await read(event); assert.equal(response.statusCode, 200);
  const dto = JSON.parse(response.body).member;
  assert.equal(dto.memo, member.memo); assert.equal(dto.revision, managementRevision(member));
  for (const secret of ['password', 'existing-private', 'private-reading', 'extra', '_registration']) assert.ok(!response.body.includes(secret));
  calls.length = 0;
  assert.equal((await read({ ...event, queryStringParameters: { memberId: 'real-user' } })).statusCode, 401);
  assert.equal((await read({ ...event, queryStringParameters: { memberId: member.id, table: 'other' } })).statusCode, 400);
  assert.equal(calls.length, 0);
}));

test('admin updates constrain fields and require current member-bound revision', () => fixture(async ({ request, command, member, calls, entitlement }) => {
  for (const input of [{ ...command(), role: 'admin' }, { ...command(), action: 'delete' },
    { ...command(), entitlement: { ...entitlement, password: 'changed' } },
    { ...command(), entitlement: { ...entitlement, tier: 'admin' } },
    { ...command(), entitlement: { ...entitlement, expiresAt: null } },
    { ...command(), entitlement: { ...entitlement, permanent: false } }]) assert.equal((await update(request(input))).statusCode, 400);
  assert.equal(calls.length, 0);
  const stale = command(); member.memo = 'changed elsewhere';
  assert.equal((await update(request(stale))).statusCode, 409);
  assert.ok(calls.every(([, options]) => options.method === 'GET'));
  calls.length = 0;
  const original = JSON.stringify(member);
  const response = await update(request(command())); assert.equal(response.statusCode, 200);
  const args = JSON.parse(calls[1][1].body);
  assert.deepEqual(args.p_expected, managementSnapshot(member)); assert.deepEqual(args.p_payload, entitlement);
  assert.ok(!calls[1][1].body.includes('private-reading'));
  assert.equal(JSON.stringify(member), original);
  assert.ok(!response.body.includes('existing-private'));
}));

test('memo and finite entitlement commands do not send approval/status/credential changes', () => fixture(async ({ request, command, calls }) => {
  const base = command();
  const memo = { action: 'set-memo', memberId: base.memberId, revision: base.revision, memo: '메모만 수정' };
  assert.equal((await update(request(memo))).statusCode, 200);
  assert.deepEqual(JSON.parse(calls.at(-1)[1].body).p_payload, { memo: '메모만 수정' });
  const change = { ...base, action: 'set-entitlement', entitlement: { plan: 'month1', tier: 'vip', permanent: false, expiresAt: Date.now() + 86400000 } };
  assert.equal((await update(request(change))).statusCode, 200);
  const payload = JSON.parse(calls.at(-1)[1].body).p_payload;
  assert.equal(payload.paid, undefined); assert.equal(payload.status, undefined); assert.equal(payload.password, undefined);
}));

test('unknown outcomes never expose upstream errors, retry, or fall back to whole-row writes', () => fixture(async ({ request, command, calls, setRpc }) => {
  for (const [result, code] of [['conflict',409],['unavailable',409],['unauthorized',401],['invalid',503],['full',409]]) {
    setRpc(() => new Response(JSON.stringify({ result }))); assert.equal((await update(request(command()))).statusCode, code);
  }
  for (const respond of [() => new Response('private server error', { status: 500 }),
    () => new Response('{"result":"created"}'), () => { throw Error('private-key'); }]) {
    calls.length = 0; setRpc(respond); const response = await update(request(command()));
    assert.equal(JSON.parse(response.body).code, 'MEMBER_WRITE_UNCONFIRMED');
    assert.ok(!response.body.includes('private')); assert.equal(calls.filter(([,o]) => o.method === 'POST').length, 1);
  }
}));

test('account RPC deadline covers streamed body and reports post-commit expiry as unconfirmed', () => fixture(async ({ request, command, setRpc }) => {
  const originalNow = Date.now, event = request(command());
  setRpc(() => { Date.now = () => originalNow() + 1201000; return new Response('{"result":"saved"}'); });
  try { assert.equal(JSON.parse((await update(event)).body).code, 'MEMBER_WRITE_UNCONFIRMED'); }
  finally { Date.now = originalNow; }
  const originalSet = global.setTimeout, originalClear = global.clearTimeout;
  const delays = []; let cleared = 0;
  global.setTimeout = (fn, ms) => { delays.push(ms); return originalSet(fn, 10); };
  global.clearTimeout = timer => { cleared++; return originalClear(timer); };
  setRpc((url, options) => new Response(new ReadableStream({ start(controller) {
    options.signal.addEventListener('abort', () => controller.error(Error('aborted')), { once: true });
  } })));
  try {
    assert.equal(JSON.parse((await update(event)).body).code, 'MEMBER_WRITE_UNCONFIRMED');
    assert.deepEqual(delays, [8000,8000]); assert.equal(cleared, 2);
  } finally { global.setTimeout = originalSet; global.clearTimeout = originalClear; }
}));
