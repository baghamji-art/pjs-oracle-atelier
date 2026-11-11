'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const memberRoute = require('../netlify/functions/member-consult').handler;
const adminRoute = require('../netlify/functions/admin-consult').handler;
const { authenticateMember } = require('../netlify/functions/lib/member-auth.cjs');
const { issueSessionCookie } = require('../netlify/functions/_admin-session');
const { projectMemberData } = require('../netlify/functions/lib/member-data.cjs');

async function fixture(run) {
  const env = { MEMBER_ACCESS_MODE: 'rehearsal', MEMBER_CONSULT_WRITE_MODE: 'rehearsal', MEMBER_REHEARSAL_IDS: 'fixture-alice,fixture-bob',
    MEMBER_SESSION_SECRET: 'fixture-member-signing-secret-only-1234567890', ADMIN_SESSION_SECRET: 'fixture-admin-signing-secret-only-1234567890',
    ADMIN_MASTER_CODE: 'fixture-admin-master-only', SUPABASE_URL: 'https://chffnolrtxfoehegnecj.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_fixture_only_not_a_real_secret_123456789' };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const members = ['alice', 'bob'].map(name => ({ id: 'fixture-' + name, password: 'test-only-' + name, status: 'active', paid: true,
    memo: 'private-admin-note', history: [{ private: name + '-reading' }] }));
  const originalFetch = global.fetch, calls = [];
  let rpc = () => new Response('{"result":"sent","time":123456}');
  global.fetch = async (url, options) => {
    calls.push([url, options]);
    return options.method === 'GET' ? new Response(JSON.stringify([{ id: 'main', members }])) : rpc(url, options);
  };
  try {
    const login = await authenticateMember({ id: members[0].id, password: members[0].password });
    const adminCookie = issueSessionCookie(env.ADMIN_SESSION_SECRET).split(';')[0];
    const command = { action: 'create', consultId: 'consult_fixture_one', messageId: 'msg_fixture_one', message: '상담 부탁해요.\n감사합니다.', lang: 'ko' };
    const request = (body = command, adminOnly = false) => ({ httpMethod: 'POST', headers: {
      origin: 'https://pjtarot.netlify.app', 'content-type': 'application/json',
      cookie: adminCookie + (adminOnly ? '' : '; ' + login.cookie.split(';')[0]) }, body: JSON.stringify(body) });
    const reply = { ...command, action: 'reply', memberId: 'fixture-bob' };
    calls.length = 0;
    await run({ members, calls, command, request, reply, setRpc: fn => { rpc = fn; } });
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(env)) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  }
}

test('consult routes are disabled independently and require admin rehearsal gate', () => fixture(async ({ request, command, reply, calls }) => {
  for (const route of [memberRoute, adminRoute]) {
    for (const mode of ['', 'true', 'production']) {
      process.env.MEMBER_CONSULT_WRITE_MODE = mode;
      assert.equal((await route(request())).statusCode, 503);
    }
    process.env.MEMBER_CONSULT_WRITE_MODE = 'rehearsal';
    const req = request(route === adminRoute ? reply : command); req.headers.cookie = '';
    assert.equal((await route(req)).statusCode, 401);
    assert.equal((await route({ ...req, httpMethod: 'GET' })).statusCode, 405);
    req.headers.origin = 'https://evil.example'; req.headers.cookie = request().headers.cookie;
    assert.equal((await route(req)).statusCode, 403);
  }
  assert.equal(calls.length, 0);
}));

test('member cannot supply owner, admin role, timestamp, logs, or invalid contents', () => fixture(async ({ request, command, calls }) => {
  for (const change of [{ role: 'admin' }, { memberId: 'fixture-bob' }, { time: 1 }, { logs: [] },
    { message: '' }, { message: ' \n\t ' }, { message: 'x\0y' }, { message: '가'.repeat(5334) },
    { messageId: '../x' }, { consultId: 'x'.repeat(129) }, { lang: 'fr' }, { action: 'delete' }]) {
    assert.equal((await memberRoute(request({ ...command, ...change }))).statusCode, 400);
  }
  assert.equal((await memberRoute({ ...request(), queryStringParameters: { userId: 'fixture-bob' } })).statusCode, 400);
  assert.equal((await memberRoute({ ...request(), body: 'x'.repeat(131073) })).statusCode, 413);
  assert.equal(calls.length, 0);
}));

test('user append derives identity/role from server and preserves exact message text without array writes', () => fixture(async ({ request, command, calls, members }) => {
  const snapshot = JSON.stringify(members);
  const response = await memberRoute(request());
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(calls.length, 2);
  const [url, options] = calls.at(-1);
  assert.ok(url.endsWith('/rest/v1/rpc/pjo_consult_append_v1'));
  const params = JSON.parse(options.body);
  assert.equal(params.p_member_id, 'fixture-alice'); assert.equal(params.p_role, 'user');
  assert.equal(params.p_message, command.message); assert.equal(params.p_message_id, command.messageId);
  assert.equal(params.p_time, undefined); assert.equal(params.logs, undefined);
  assert.ok(!options.body.includes('fixture-bob')); assert.ok(!options.body.includes('private-admin-note'));
  assert.equal(options.redirect, 'error');
  for (const secret of ['password', 'test-only', command.message, 'fixture-bob']) assert.ok(!response.body.includes(secret));
  assert.equal(JSON.stringify(members), snapshot);
}));

test('admin reply requires no member password but limits target to known test IDs and reply action', () => fixture(async ({ request, reply, members, calls }) => {
  assert.equal((await adminRoute(request({ ...reply, action: 'create' }, true))).statusCode, 400);
  assert.equal((await adminRoute(request({ ...reply, memberId: 'real-user' }, true))).statusCode, 401);
  assert.equal(calls.length, 0);
  members[1].status = 'expired'; members[1].expiresAt = 1;
  const response = await adminRoute(request(reply, true));
  assert.equal(response.statusCode, 200);
  const params = JSON.parse(calls.at(-1)[1].body);
  assert.equal(params.p_member_id, 'fixture-bob'); assert.equal(params.p_role, 'admin');
  assert.equal(params.p_action, 'reply'); assert.equal(members[1].status, 'expired');
}));

test('missing member session and revoked entitlement deny user message before RPC', () => fixture(async ({ request, calls, members }) => {
  assert.equal((await memberRoute(request(undefined, true))).statusCode, 401);
  members[0].status = 'blocked';
  assert.equal((await memberRoute(request())).statusCode, 401);
  assert.ok(calls.every(([, options]) => options.method === 'GET'));
}));

test('conflict/not-found/full map safely; errors and timeouts never retry or claim no write', () => fixture(async ({ request, setRpc, calls }) => {
  for (const [result, code] of [['conflict', 409], ['not_found', 404], ['full', 409], ['unauthorized', 401], ['invalid', 503]]) {
    setRpc(() => new Response(JSON.stringify({ result })));
    assert.equal((await memberRoute(request())).statusCode, code);
  }
  for (const reply of [() => new Response('private DB info', { status: 500 }), () => { throw Error('private-key'); },
    () => new Response('{"result":"sent","time":"wrong"}'), () => new Response('x'.repeat(4097))]) {
    setRpc(reply); calls.length = 0;
    const response = await memberRoute(request());
    assert.equal(JSON.parse(response.body).code, 'CONSULT_WRITE_UNCONFIRMED');
    assert.ok(!response.body.includes('private'));
    assert.equal(calls.filter(([, options]) => options.method === 'POST').length, 1);
  }
  setRpc(() => new Response('{"result":"unchanged","time":123}'));
  assert.equal(JSON.parse((await memberRoute(request())).body).result, 'unchanged');
}));

test('own consultation read exposes retry IDs only for own messages; legacy messages still load', () => fixture(async ({ members }) => {
  const base = { action: 'Private consult message', consultId: 'thread', role: 'user', message: 'hello', time: 1 };
  const result = projectMemberData(members[0], [{ ...base, userId: 'fixture-alice' },
    { ...base, userId: 'fixture-alice', messageId: 'own-id', time: 2 },
    { ...base, userId: 'fixture-bob', messageId: 'foreign-id', time: 3 }], 'consultations');
  assert.equal(result.data[0].messages.length, 2);
  assert.equal(result.data[0].messages[0].messageId, undefined);
  assert.equal(result.data[0].messages[1].messageId, 'own-id');
  assert.ok(!JSON.stringify(result).includes('foreign-id'));
}));

test('post-commit admin expiry is unconfirmed and eight-second timeout includes response body', () => fixture(async ({ request, setRpc }) => {
  const originalNow = Date.now;
  const req = request();
  setRpc(() => { Date.now = () => originalNow() + 1201000; return new Response('{"result":"sent","time":123}'); });
  try { assert.equal(JSON.parse((await memberRoute(req)).body).code, 'CONSULT_WRITE_UNCONFIRMED'); }
  finally { Date.now = originalNow; }
  const originalSet = global.setTimeout, originalClear = global.clearTimeout;
  const delays = []; let cleared = 0;
  global.setTimeout = (fn, ms) => { delays.push(ms); return originalSet(fn, 10); };
  global.clearTimeout = timer => { cleared++; return originalClear(timer); };
  setRpc((url, options) => new Response(new ReadableStream({ start(controller) {
    options.signal.addEventListener('abort', () => controller.error(Error('aborted')), { once: true });
  } })));
  try {
    assert.equal(JSON.parse((await memberRoute(req)).body).code, 'CONSULT_WRITE_UNCONFIRMED');
    assert.deepEqual(delays, [8000, 8000]); assert.equal(cleared, 2);
  } finally { global.setTimeout = originalSet; global.clearTimeout = originalClear; }
}));
