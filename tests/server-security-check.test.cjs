'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { issueSessionCookie } = require('../netlify/functions/_admin-session');
const { handler } = require('../netlify/functions/admin-security-check');

async function fixture(run) {
  const values = {
    ADMIN_MASTER_CODE: 'fixture-admin-password-only',
    ADMIN_SESSION_SECRET: 'fixture-session-secret-not-a-production-key-12345',
    SUPABASE_URL: 'https://chffnolrtxfoehegnecj.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_fixture_only_not_a_real_secret_123456789'
  };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  const originalFetch = global.fetch;
  let calls = [];
  let upstream = async () => ({ ok: true, status: 200, json: async () => [{ id: 'main' }] });
  global.fetch = async (...args) => { calls.push(args); return upstream(...args); };
  const cookie = issueSessionCookie(values.ADMIN_SESSION_SECRET).split(';')[0];
  const request = () => ({ httpMethod: 'GET', headers: { cookie } });
  try { await run({ values, calls, request, setUpstream: fn => { upstream = fn; } }); }
  finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

test('anonymous callers and browser-supplied claims cannot probe DB or config', () => fixture(async ({ calls }) => {
  delete process.env.SUPABASE_SECRET_KEY;
  for (const headers of [{}, { authorization: 'Bearer fake-member-token' }, { cookie: 'pjo_admin_session=fake' }, { 'x-admin': 'true' }]) {
    const result = await handler({ httpMethod: 'GET', headers });
    assert.equal(result.statusCode, 401);
    assert.equal(JSON.parse(result.body).code, 'ADMIN_LOGIN_REQUIRED');
  }
  assert.equal(calls.length, 0);
}));

test('expired, tampered and non-admin signed sessions are rejected', () => fixture(async ({ values, request, calls }) => {
  const token = payload => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', values.ADMIN_SESSION_SECRET).update(encoded).digest('base64url');
    return 'pjo_admin_session=' + encoded + '.' + signature;
  };
  for (const cookie of [request().headers.cookie + 'x', token({ role: 'admin', exp: 1 }), token({ role: 'member', exp: Math.floor(Date.now()/1000)+600 })]) {
    assert.equal((await handler({ httpMethod: 'GET', headers: { cookie } })).statusCode, 401);
  }
  assert.equal(calls.length, 0);
}));

test('rejects mutations and invalid admin configuration before DB access', () => fixture(async ({ request, calls }) => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    assert.equal((await handler({ ...request(), httpMethod: method })).statusCode, 405);
  }
  process.env.ADMIN_SESSION_SECRET = '';
  assert.equal((await handler(request())).statusCode, 503);
  assert.equal(calls.length, 0);
}));

test('successful probe uses only a fixed GET, does not forward caller URLs/headers or reveal data', () => fixture(async ({ values, request, calls, setUpstream }) => {
  setUpstream(async () => ({ ok: true, status: 200, json: async () => [{ id: 'main', members: [{ password: 'must-not-be-returned' }] }] }));
  const result = await handler({ ...request(), queryStringParameters: { select: '*', url: 'https://example.com' } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true, code: 'SERVER_CONNECTION_READY', mode: 'read-only', dataAccessMigrationComplete: false });
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, values.SUPABASE_URL + '/rest/v1/app_state?select=id&id=eq.main&limit=1');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.apikey, values.SUPABASE_SECRET_KEY);
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.headers.cookie, undefined);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
  assert.ok(!result.body.includes(values.SUPABASE_SECRET_KEY));
  assert.ok(!result.body.includes('must-not-be-returned'));
}));

test('missing/mistyped server settings fail closed; never send a key to a different URL', () => fixture(async ({ values, request, calls }) => {
  for (const url of ['', 'http://chffnolrtxfoehegnecj.supabase.co', 'https://example.com', values.SUPABASE_URL + '/functions/v1/other', values.SUPABASE_URL + '?secret=bad', 'https://user:password@chffnolrtxfoehegnecj.supabase.co', 'not a URL']) {
    process.env.SUPABASE_URL = url;
    assert.equal((await handler(request())).statusCode, 503);
  }
  process.env.SUPABASE_URL = values.SUPABASE_URL;
  for (const key of ['', 'sb_publishable_not_a_secret', 'eyJ_legacy_key', values.SUPABASE_SECRET_KEY + '\n']) {
    process.env.SUPABASE_SECRET_KEY = key;
    assert.equal((await handler(request())).statusCode, 503);
  }
  assert.equal(calls.length, 0);
}));

test('upstream errors and exceptions never echo credentials or DB details', () => fixture(async ({ values, request, setUpstream }) => {
  for (const status of [401, 403, 404, 429, 500]) {
    setUpstream(async () => ({ ok: false, status, json: async () => { throw Error('Must not read error body'); } }));
    const result = await handler(request());
    assert.equal(result.statusCode, 502);
    assert.ok(!result.body.includes(values.SUPABASE_SECRET_KEY));
  }
  setUpstream(async () => { throw Error(values.SUPABASE_SECRET_KEY); });
  const result = await handler(request());
  assert.equal(result.statusCode, 502);
  assert.ok(!result.body.includes(values.SUPABASE_SECRET_KEY));
}));

test('empty main row and invalid JSON/schema produce controlled failures, no writes', () => fixture(async ({ request, setUpstream, calls }) => {
  setUpstream(async () => ({ ok: true, json: async () => [] }));
  assert.equal((await handler(request())).statusCode, 409);
  for (const data of [null, {}, [{ id: 'other' }], [{ id: 'main' }, { id: 'main' }]]) {
    setUpstream(async () => ({ ok: true, json: async () => data }));
    assert.equal((await handler(request())).statusCode, 502);
  }
  setUpstream(async () => ({ ok: true, json: async () => { throw SyntaxError('invalid JSON'); } }));
  assert.equal((await handler(request())).statusCode, 502);
  assert.ok(calls.every(([,options]) => options.method === 'GET'));
}));

test('timeout covers both fetching and reading the response body', () => fixture(async ({ request, setUpstream }) => {
  const originalTimer=global.setTimeout, originalClear=global.clearTimeout;
  let requestedTimeout,cleared=false;
  global.setTimeout=(fn,ms)=>{requestedTimeout=ms;return originalTimer(fn,5);};
  global.clearTimeout=id=>{cleared=true;return originalClear(id);};
  try {
    setUpstream(async (_,options) => ({ ok: true, json: () => new Promise((resolve,reject) => {
      options.signal.addEventListener('abort',()=>reject(Object.assign(Error('timeout'),{name:'AbortError'})),{once:true});
    }) }));
    const result=await handler(request());
    assert.equal(result.statusCode,504);
    assert.equal(JSON.parse(result.body).code,'SUPABASE_PROBE_TIMEOUT');
    assert.equal(requestedTimeout,8000);
    assert.equal(cleared,true);
  } finally {global.setTimeout=originalTimer;global.clearTimeout=originalClear;}
}));
