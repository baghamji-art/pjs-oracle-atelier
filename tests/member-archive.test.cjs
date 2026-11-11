'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../netlify/functions/member-archive');
const { issueSessionCookie } = require('../netlify/functions/_admin-session');
const { authenticateMember } = require('../netlify/functions/lib/member-auth.cjs');
const { revision, prepareChange, validateCommand, authSnapshot } = require('../netlify/functions/lib/archive-record.cjs');
const { projectMemberData } = require('../netlify/functions/lib/member-data.cjs');

async function fixture(run) {
  const env = { MEMBER_ACCESS_MODE: 'rehearsal', MEMBER_ARCHIVE_WRITE_MODE: 'rehearsal', MEMBER_REHEARSAL_IDS: 'fixture-alice',
    MEMBER_SESSION_SECRET: 'fixture-member-signing-secret-only-1234567890', ADMIN_SESSION_SECRET: 'fixture-admin-signing-secret-only-1234567890',
    ADMIN_MASTER_CODE: 'fixture-admin-master-only', SUPABASE_URL: 'https://chffnolrtxfoehegnecj.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_fixture_only_not_a_real_secret_123456789' };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const record = { id: 'reading-one', time: 123, q: '전생 인연?', score: '★★★☆☆', favorite: false,
    readingHtml: '<p>원래 글</p>', cards: ['정방향', '역방향', '정방향'], retainedMetadata: { keep: 'untouched' } };
  const member = { id: 'fixture-alice', password: 'test-only', status: 'active', paid: true,
    history: [record], memo: 'private-admin-memo' };
  const row = { id: 'main', members: [member, { id: 'real-user-fixture', password: 'not-used', history: [] }], logs: [], guest_codes: [] };
  const originalFetch = global.fetch, calls = [];
  let rpc = () => new Response('{"result":"saved"}');
  global.fetch = async (url, options) => {
    calls.push([url, options]);
    return options.method === 'GET' ? new Response(JSON.stringify([row])) : rpc(url, options);
  };
  try {
    const login = await authenticateMember({ id: member.id, password: member.password });
    const request = command => ({ httpMethod: 'POST', headers: { origin: 'https://pjtarot.netlify.app',
      'content-type': 'application/json', cookie: issueSessionCookie(env.ADMIN_SESSION_SECRET).split(';')[0] + '; ' + login.cookie.split(';')[0] },
      body: JSON.stringify(command) });
    const patch = () => ({ action: 'patch', readingId: record.id, revision: revision(member.id, record), patch: { favorite: true } });
    calls.length = 0;
    await run({ member, record, row, calls, request, patch, env, setRpc: fn => { rpc = fn; } });
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(env)) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  }
}

test('archive writes need separate opt-in, both sessions, POST and trusted origin', () => fixture(async ({ calls, request, patch }) => {
  for (const mode of ['', 'true', 'production']) {
    process.env.MEMBER_ARCHIVE_WRITE_MODE = mode;
    assert.equal((await handler(request(patch()))).statusCode, 503);
  }
  process.env.MEMBER_ARCHIVE_WRITE_MODE = 'rehearsal';
  let req = request(patch()); req.headers.cookie = '';
  assert.equal((await handler(req)).statusCode, 401);
  req = request(patch()); req.headers.origin = 'https://evil.example';
  assert.equal((await handler(req)).statusCode, 403);
  req = request(patch()); req.headers.cookie = req.headers.cookie.split('; ')[0];
  assert.equal((await handler(req)).statusCode, 401);
  assert.equal((await handler({ ...request(patch()), httpMethod: 'GET' })).statusCode, 405);
  assert.equal(calls.length, 0);
}));

test('rejects owner/credential injection, malformed patches, missing revision and oversized input', () => fixture(async ({ calls, request, patch }) => {
  for (const invalid of [{ ...patch(), userId: 'other' }, { ...patch(), patch: { paid: true } },
    { ...patch(), patch: { password: 'x' } }, { ...patch(), patch: { id: 'other' } },
    { ...patch(), patch: {} }, { ...patch(), revision: '' }, { ...patch(), patch: { favorite: 'true' } },
    { ...patch(), patch: JSON.parse('{"__proto__":{"polluted":true}}') },
    { action: 'create', readingId: 'x', record: { id: 'different', time: 1, q: 'q' } }]) {
    assert.equal((await handler(request(invalid))).statusCode, 400);
  }
  assert.equal((await handler({ ...request(patch()), body: 'x'.repeat(1601 * 1024) })).statusCode, 413);
  assert.equal((await handler({ ...request(patch()), queryStringParameters: { id: 'other' } })).statusCode, 400);
  assert.equal(calls.length, 0);
  assert.equal({}.polluted, undefined);
}));

test('patch sends only own atomic record change; unknown stored metadata survives', () => fixture(async ({ member, row, record, calls, request, patch }) => {
  const original = JSON.stringify(row);
  const result = await handler(request(patch()));
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 2);
  const [url, options] = calls[1];
  assert.ok(url.endsWith('/rest/v1/rpc/pjo_archive_apply_v1'));
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  const args = JSON.parse(options.body);
  assert.equal(args.p_member_id, member.id);
  assert.deepEqual(args.p_expected, record);
  assert.deepEqual(args.p_next, { ...record, favorite: true });
  assert.deepEqual(args.p_auth, authSnapshot(member));
  assert.ok(args.p_valid_until > Date.now() / 1000);
  assert.ok(!options.body.includes('real-user-fixture'));
  for (const secret of ['password', 'test-only', 'private-admin', 'retainedMetadata']) assert.ok(!result.body.includes(secret));
  assert.equal(JSON.stringify(row), original);
}));

test('stale or other-member revision conflicts before RPC; other record ID cannot be modified', () => fixture(async ({ record, calls, request, patch }) => {
  for (const command of [{ ...patch(), revision: revision('someone-else', record) },
    { ...patch(), revision: revision('fixture-alice', { ...record, favorite: true }) }]) {
    assert.equal((await handler(request(command))).statusCode, 409);
  }
  assert.equal((await handler(request({ ...patch(), readingId: 'other-person-record' }))).statusCode, 404);
  assert.ok(calls.every(([, options]) => options.method === 'GET'));
}));

test('duplicate create is stable, conflicts never overwrite and full archive never drops old records', () => fixture(async ({ member, record }) => {
  const createRecord = { id: 'new-id', time: 123, q: '질문', score: '★★★★★', favorite: false };
  const command = { action: 'create', readingId: createRecord.id, record: createRecord };
  assert.equal(validateCommand(command), true);
  member.history.push(createRecord);
  assert.equal(prepareChange(member, command).ok, true);
  assert.equal(prepareChange(member, { ...command, record: { ...createRecord, q: '다른 질문' } }).status, 409);
  member.history = Array.from({ length: 60 }, (_, index) => ({ ...record, id: 'existing-' + index }));
  const original = JSON.stringify(member);
  assert.equal(prepareChange(member, command).code, 'ARCHIVE_FULL');
  assert.equal(JSON.stringify(member), original);
}));

test('deletion targets only requested ID and preserves unrecognized fields on ordinary updates', () => fixture(async ({ member, record, request, patch, calls, setRpc }) => {
  setRpc(() => new Response('{"result":"deleted"}'));
  const { patch: ignored, ...command } = patch();
  const result = await handler(request({ ...command, action: 'delete' }));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).revision, null);
  const args = JSON.parse(calls.at(-1)[1].body);
  assert.equal(args.p_reading_id, record.id); assert.equal(args.p_next, null);
  assert.deepEqual(args.p_expected, record);
  assert.equal(member.history.length, 1);
}));

test('RPC conflicts/credential changes and unknown outcomes never fall back to table writes or retry', () => fixture(async ({ calls, request, patch, setRpc }) => {
  for (const [reply, status] of [['conflict', 409], ['unauthorized', 401], ['full', 409], ['invalid', 503]]) {
    setRpc(() => new Response(JSON.stringify({ result: reply })));
    assert.equal((await handler(request(patch()))).statusCode, status);
  }
  for (const respond of [() => new Response('private DB detail', { status: 404 }),
    () => new Response('{"secret":"private"}'), () => { throw Error('private server key'); }]) {
    calls.length = 0; setRpc(respond);
    const result = await handler(request(patch()));
    assert.equal(JSON.parse(result.body).code, 'ARCHIVE_WRITE_UNCONFIRMED');
    assert.ok(!result.body.includes('private'));
    assert.equal(calls.filter(([, options]) => options.method === 'POST').length, 1);
  }
}));

test('archive revisions are canonical and projection preserves star score/reflection', () => fixture(async ({ member, record }) => {
  const reverse = Object.fromEntries(Object.entries(record).reverse());
  assert.equal(revision(member.id, record), revision(member.id, reverse));
  record.destinyReflection = { type: 'unclear', memo: '생각', time: 456 };
  const result = projectMemberData(member, [], 'reading', record.id);
  assert.equal(result.data.score, '★★★☆☆');
  assert.deepEqual(result.data.destinyReflection, record.destinyReflection);
  assert.equal(result.data.revision, revision(member.id, record));
  assert.equal(result.data.retainedMetadata, undefined);
}));

test('timeout includes RPC body and post-commit session expiry is reported as unconfirmed', () => fixture(async ({ request, patch, setRpc }) => {
  const originalNow = Date.now;
  setRpc(() => { Date.now = () => originalNow() + 1201000; return new Response('{"result":"saved"}'); });
  try {
    const result = await handler(request(patch()));
    assert.equal(JSON.parse(result.body).code, 'ARCHIVE_WRITE_UNCONFIRMED');
  } finally { Date.now = originalNow; }
  const originalSet = global.setTimeout, originalClear = global.clearTimeout;
  const delays = [];
  let cleared = 0;
  global.setTimeout = (fn, ms) => { delays.push(ms); return originalSet(fn, 10); };
  global.clearTimeout = timer => { cleared++; return originalClear(timer); };
  setRpc((url, options) => new Response(new ReadableStream({
    start(controller) { options.signal.addEventListener('abort', () => controller.error(Error('aborted')), { once: true }); }
  })));
  try {
    const result = await handler(request(patch()));
    assert.equal(JSON.parse(result.body).code, 'ARCHIVE_WRITE_UNCONFIRMED');
    assert.deepEqual(delays, [8000, 8000]);
    assert.equal(cleared, 2);
  } finally { global.setTimeout = originalSet; global.clearTimeout = originalClear; }
}));
