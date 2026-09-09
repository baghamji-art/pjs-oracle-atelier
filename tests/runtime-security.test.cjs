'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const reading = require('../netlify/functions/generate-reading').handler;
const admin = require('../netlify/functions/admin-auth').handler;
const logout = require('../netlify/functions/admin-logout').handler;
const audit = require('../netlify/functions/admin-migration-audit').handler;
const sessions = require('../netlify/functions/_admin-session');
const root = path.resolve(__dirname, '..');
const report = JSON.stringify({ headline: '테스트', sections: [{ heading: '결론', body: '기존 문장' }], closing: '마무리' });
const input = () => ({ question: '전생에서 이어진 인연이 이번 생에도 나타날까?', qtype: 'past_life_connection',
  language: 'ko', dbReport: '테스트 리딩', userContext: {},
  cards: ['fool','magician','priestess'].map(key => ({ key, orientation: 'upright' })) });
const event = body => ({ httpMethod: 'POST', headers: { origin: 'https://pjtarot.netlify.app',
  'content-type': 'application/json' }, body: JSON.stringify(body) });

async function fixture(run) {
  const values = { OPENAI_API_KEY: 'fixture-api-not-a-real-key', OPENAI_MODEL: 'fixture-model',
    ADMIN_MASTER_CODE: 'fixture-master-code-only', ADMIN_SESSION_SECRET: 'fixture-secret-for-admin-only-1234567890',
    SUPABASE_URL: 'https://chffnolrtxfoehegnecj.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_fixture_only_not_a_real_secret_123456789',
    AI_READING_ENABLED: '', AI_REQUIRE_MEMBER_SESSION: '', MEMBER_SESSION_SECRET: '',
    URL: '', DEPLOY_URL: '', DEPLOY_PRIME_URL: '', NETLIFY_DEV: '' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const originalFetch = global.fetch;
  const calls = [];
  let upstream = async () => new Response(JSON.stringify({ status: 'completed', output_text: report }));
  global.fetch = async (...args) => { calls.push(args); return upstream(...args); };
  const adminEvent = () => ({ httpMethod: 'GET', headers: {
    cookie: sessions.issueSessionCookie(values.ADMIN_SESSION_SECRET).split(';')[0] } });
  try { await run({ values, calls, adminEvent, setUpstream: fn => { upstream = fn; } }); }
  finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

test('cross-site/null/missing origins and HTML form content types cannot invoke mutations', () => fixture(async ({ calls }) => {
  for (const handler of [reading, admin, logout]) {
    for (const origin of ['', 'null', 'https://evil.example', 'https://pjtarot.netlify.app.evil.example']) {
      const request = event(input()); request.headers.origin = origin;
      assert.equal((await handler(request)).statusCode, 403);
    }
    for (const type of ['', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const request = event(input()); request.headers['content-type'] = type;
      assert.equal((await handler(request)).statusCode, 415);
    }
    const crossSite = event(input()); crossSite.headers['sec-fetch-site'] = 'cross-site';
    assert.equal((await handler(crossSite)).statusCode, 403);
  }
  assert.equal(calls.length, 0);
}));

test('trusted server deploy origin allowed; caller Host headers cannot add an origin', () => fixture(async () => {
  const request = event(input()); request.headers.origin = 'https://deploy-fixture.netlify.app';
  request.headers.host = 'deploy-fixture.netlify.app';
  request.headers['x-forwarded-host'] = 'deploy-fixture.netlify.app';
  assert.equal((await reading(request)).statusCode, 403);
  process.env.DEPLOY_PRIME_URL = 'https://deploy-fixture.netlify.app';
  assert.equal((await reading(request)).statusCode, 200);
}));

test('same-origin admin login/logout still work and existing cookie format remains valid', () => fixture(async ({ values }) => {
  const response = await admin(event({ code: values.ADMIN_MASTER_CODE }));
  assert.equal(response.statusCode, 200);
  const cookie = response.headers['Set-Cookie'].split(';')[0];
  assert.ok(sessions.verifyAdminSession({ headers: { cookie } }, values.ADMIN_SESSION_SECRET));
  const signedOut = await logout(event({}));
  assert.equal(signedOut.statusCode, 200);
  assert.ok(signedOut.headers['Set-Cookie'].includes('Max-Age=0'));
}));

test('admin verifier rejects future/overlong/invalid claims and duplicate cookies', () => fixture(async ({ values, adminEvent }) => {
  const now = Math.floor(Date.now()/1000);
  const base = { role: 'admin', iat: now, exp: now + 1200, nonce: crypto.randomBytes(16).toString('base64url') };
  const sign = value => {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return 'pjo_admin_session=' + body + '.' + crypto.createHmac('sha256', values.ADMIN_SESSION_SECRET).update(body).digest('base64url');
  };
  for (const mutation of [{ iat: now+60, exp: now+1260 }, { exp: now+3600 }, { iat: null },
    { exp: String(now+1200) }, { role: 'member' }, { nonce: '' }]) {
    assert.equal(sessions.verifyAdminSession({ headers: { cookie: sign({ ...base, ...mutation }) } }, values.ADMIN_SESSION_SECRET), null);
  }
  const cookie = adminEvent().headers.cookie;
  for (const header of [cookie+'; '+cookie, 'x'.repeat(16385), cookie+'x']) {
    assert.equal(sessions.verifyAdminSession({ headers: { cookie: header } }, values.ADMIN_SESSION_SECRET), null);
  }
  assert.ok(sessions.verifyAdminSession({ headers: { Cookie: sign(base) } }, values.ADMIN_SESSION_SECRET));
}));

test('emergency AI switch prevents any provider call; staged member gate fails closed', () => fixture(async ({ calls }) => {
  process.env.AI_READING_ENABLED = 'false';
  assert.equal(JSON.parse((await reading(event(input()))).body).code, 'AI_DISABLED');
  process.env.AI_READING_ENABLED = '';
  process.env.AI_REQUIRE_MEMBER_SESSION = 'true';
  assert.equal((await reading(event(input()))).statusCode, 503);
  process.env.MEMBER_SESSION_SECRET = 'fixture-member-signing-secret-only-123456789';
  assert.equal((await reading(event(input()))).statusCode, 401);
  assert.equal(calls.length, 0);
}));

test('OpenAI errors/exceptions are redacted; billing/rate errors never retry', () => fixture(async ({ calls, values, setUpstream }) => {
  for (const status of [400,401,403,429,500,503]) {
    calls.length = 0;
    setUpstream(async () => new Response(JSON.stringify({ error: { message: values.OPENAI_API_KEY, code: 'insufficient_quota' } }), { status }));
    const response = await reading(event(input()));
    assert.equal(response.statusCode, status === 429 ? 429 : 502);
    assert.ok(!response.body.includes(values.OPENAI_API_KEY));
    assert.equal(calls.length, 1);
    assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
  }
  setUpstream(async () => { throw Error(values.OPENAI_API_KEY); });
  assert.ok(!(await reading(event(input()))).body.includes(values.OPENAI_API_KEY));
}));

test('known unsupported model fallback remains bounded; successful report stays identical', () => fixture(async ({ calls, setUpstream }) => {
  let attempt = 0;
  setUpstream(async () => ++attempt === 1
    ? new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 404 })
    : new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: report }] }] })));
  const response = await reading(event(input()));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).result, report);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(([,options]) => JSON.parse(options.body).model), ['fixture-model','gpt-4.1-mini']);
  assert.ok(calls.every(([url,options]) => url === 'https://api.openai.com/v1/responses' && options.redirect === 'error'));
}));

test('malformed/oversized/incomplete provider results fail safely', () => fixture(async ({ setUpstream }) => {
  for (const value of [null, {}, { output: {} }, { output_text: 'not JSON' }, { output_text: '{}' },
    { output_text: JSON.stringify({ headline:'x', sections:[null], closing:'x' }) },
    { status: 'incomplete', output_text: report }]) {
    setUpstream(async () => new Response(JSON.stringify(value)));
    assert.equal((await reading(event(input()))).statusCode, 502);
  }
  setUpstream(async () => new Response('x'.repeat(524289)));
  assert.equal((await reading(event(input()))).statusCode, 502);
}));

test('provider body read is covered by the same 18-second deadline', () => fixture(async ({ setUpstream }) => {
  const originalTimer = global.setTimeout, originalClear = global.clearTimeout;
  let requested, cleared = false;
  global.setTimeout = (fn, ms) => { requested = ms; return originalTimer(fn, 5); };
  global.clearTimeout = timer => { cleared = true; return originalClear(timer); };
  setUpstream(async (_, options) => new Response(new ReadableStream({
    start(controller) { options.signal.addEventListener('abort', () => controller.error(Error('timeout')), { once:true }); }
  })));
  try {
    assert.equal((await reading(event(input()))).statusCode, 504);
    assert.equal(requested, 18000);
    assert.equal(cleared, true);
  } finally { global.setTimeout = originalTimer; global.clearTimeout = originalClear; }
}));

test('LLM prompt/model/token parameters match baseline for supported question types', () => fixture(async ({ calls }) => {
  const source = execFileSync('git', ['show','c4af5d2:netlify/functions/generate-reading.js'], { cwd:root, encoding:'utf8' });
  const context = vm.createContext({ exports:{}, require: name => require(path.join(root,'netlify/functions',name)),
    process, AbortController, setTimeout, clearTimeout, Buffer, fetch: async (...args) => {
      calls.push(args); return { ok:true, status:200, json:async()=>({output_text:report}) };
    } });
  vm.runInContext(source, context);
  for (const qtype of ['past_life_connection','dating_possibility','career']) {
    calls.length = 0;
    const request = event({ ...input(), qtype, question: qtype==='career'?'일의 흐름은?':qtype==='dating_possibility'?'이 관계가 연애로 발전할까?':input().question });
    await context.exports.handler(request);
    await reading(request);
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(calls[0][1].body), JSON.parse(calls[1][1].body));
  }
}));

test('migration audit requires admin auth before querying DB', () => fixture(async ({ calls }) => {
  for (const request of [{ httpMethod:'GET', headers:{} }, { httpMethod:'GET', headers:{'x-admin':'true'} }]) {
    assert.equal((await audit(request)).statusCode, 401);
  }
  assert.equal((await audit({ httpMethod:'POST' })).statusCode, 405);
  assert.equal(calls.length, 0);
}));

test('migration audit returns counts only, no member IDs/passwords/memos and no writes', () => fixture(async ({ calls, adminEvent, setUpstream }) => {
  const members = [
    {id:'private-id-one',password:'private-pw-one',status:'active',paid:true,permanent:true,expiresAt:4102444800000,memo:'private-note'},
    {id:'private-id-two',password:'private-pw-two',status:'expired',paid:false,expiresAt:1},
    {id:'private-id-three',password:null,status:{toString:null},expiresAt:'invalid'}
  ];
  setUpstream(async () => new Response(JSON.stringify([{id:'main',members}])));
  const response = await audit(adminEvent());
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.equal(data.counts.total, 3);
  assert.equal(data.counts.eligibleForPreparedAuth, 1);
  assert.equal(data.counts.requiresReview, 2);
  assert.equal(data.counts.legacyPlaintextPassword, 2);
  assert.equal(data.statuses.other, 1);
  assert.equal(data.dataAccessMigrationComplete, false);
  assert.ok(!response.body.includes('private-'));
  assert.ok(calls.every(([,options]) => options.method === 'GET'));
}));

function cloudFixture(file) {
  const source = fs.readFileSync(path.join(root,'outputs',file),'utf8');
  const start = source.indexOf('function validCloudStateV104(');
  const end = source.indexOf("if(typeof renderCloudStatus==='function')", start);
  assert.ok(start > 0 && end > start);
  const writes = [], localWrites = [];
  const state = { id:'main', members:[], guest_codes:[], logs:[] };
  let response = {data:state,error:null};
  const context = vm.createContext({ CLOUD_ENABLED:true, cloudSaveBusyV104:false, cloudSaveQueuedV104:false,
    cloudLastErrorV104:'', MEMBERS_KEY:'members', GUEST_CODES_KEY:'guest_codes', LOGS_KEY:'logs', DEFAULT_GUEST_CODES:[],
    sb:{from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>response})}),upsert:async value=>{writes.push(value);return {error:null};}})},
    get:()=>[], set:(...args)=>localWrites.push(args), mergeMembersV104:(a,b)=>[...a,...b],
    mergeCodesV104:(a,b)=>[...a,...b], mergeLogsV104:(a,b)=>[...a,...b], console:{warn:()=>{}} });
  vm.runInContext(source.slice(start,end), context);
  return {context,writes,localWrites,state,setResponse:value=>{response=value;}};
}

test('all HTML entry points skip upload/hydration on missing/malformed/failed DB reads', async () => {
  for (const file of ['index.html','admin.html','tarot-site-polished.html']) {
    for (const response of [{data:null,error:{message:'offline'}}, {data:null,error:null},
      {data:{id:'main',members:{}},error:null}, {data:{id:'other',members:[],guest_codes:[],logs:[]},error:null}]) {
      const f = cloudFixture(file); f.setResponse(response);
      await f.context.cloudSaveState(); await f.context.hydrateFromCloud();
      assert.equal(f.writes.length, 0); assert.equal(f.localWrites.length, 0);
      assert.equal(f.context.cloudSaveBusyV104, false);
    }
    const f = cloudFixture(file); await f.context.cloudSaveState();
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].id, 'main');
  }
});

test('admin browser sends JSON on logout but not on GET session restore', () => {
  const source = fs.readFileSync(path.join(root,'outputs/assets/admin-entry.js'),'utf8');
  const get = source.slice(source.indexOf('fetch(SESSION_URL'),source.indexOf('if (response.ok)',source.indexOf('fetch(SESSION_URL')));
  assert.ok(!get.includes('body:'));
  const post = source.slice(source.indexOf('fetch(LOGOUT_URL'), source.indexOf('} catch',source.indexOf('fetch(LOGOUT_URL')));
  assert.ok(post.includes("'Content-Type': 'application/json'"));
  assert.ok(post.includes("body: '{}'"));
});

test('release scanner distinguishes public JWTs from secrets and never echoes matched values', () => {
  const { findings } = require('../scripts/security-scan.cjs');
  const jwt = role => Buffer.from('{"alg":"HS256"}').toString('base64url') + '.' +
    Buffer.from(JSON.stringify({role})).toString('base64url') + '.fixtureSignature';
  const fakeSecret = ['sk-', 'x'.repeat(40)].join('');
  const issues = findings(fakeSecret + '\n' + jwt('service_role'));
  assert.equal(issues.length, 2);
  assert.ok(!JSON.stringify(issues).includes(fakeSecret));
  assert.equal(findings(jwt('anon')).length, 0);
  assert.equal(findings('process.env.OPENAI_API_KEY').length, 0);
});

test('special IDs/questions cannot collide with object prototypes in member/consult/review maps', () => {
  for (const file of ['index.html','admin.html','tarot-site-polished.html']) {
    const source = fs.readFileSync(path.join(root,'outputs',file),'utf8');
    const context = vm.createContext({ DEFAULT_GUEST_CODES:[] });
    vm.runInContext(source.slice(source.indexOf('function memberRankV104('),source.indexOf('function validCloudStateV104(')),context);
    const ids = ['__proto__','constructor','toString'];
    const members = ids.map(id=>({id,status:'active',paid:true,history:[]}));
    assert.deepEqual(Array.from(context.mergeMembersV104(members,[]),m=>m.id).sort(),ids.sort());
    context.getLogs = () => ids.map(id=>({action:'Private consult message',id,userId:id,consultId:id,role:'user',message:'hello',time:1}));
    context.get = () => [];
    context.CONSULT_KEY_V97 = 'fixture';
    context.CONSULT_LOG_ACTION_V97 = 'Private consult message';
    vm.runInContext(source.slice(source.indexOf('function consultLogsV97('),source.indexOf('function setConsultsV97(')),context);
    assert.equal(context.getConsultsV97().length,3);
    vm.runInContext(source.slice(source.indexOf('function consultUsersV100('),source.indexOf('function userThreadsV100(')),context);
    assert.equal(context.consultUsersV100().length,3);
    context.getLogs = () => ids.map(question=>({action:'리딩 리뷰',question,rating:5}));
    vm.runInContext(source.slice(source.indexOf('function reviewLogsV119('),source.indexOf('function ensureReviewStatsWorkspaceV119(')),context);
    assert.equal(context.reviewStatsV119().length,3);
  }
});

test('HTML markup/inline CSS remain byte-identical outside script bodies', () => {
  const withoutScriptBodies = text => text.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi,'$1$2');
  for (const file of ['index.html','admin.html','tarot-site-polished.html']) {
    const previous = execFileSync('git',['show','c4af5d2:outputs/'+file],{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024});
    const current = fs.readFileSync(path.join(root,'outputs',file),'utf8');
    assert.equal(withoutScriptBodies(current),withoutScriptBodies(previous));
    for (const match of current.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      new vm.Script(match[1],{filename:file});
    }
  }
});
