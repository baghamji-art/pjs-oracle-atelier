'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { managementSnapshot, PERMANENT_EXPIRY } = require('../netlify/functions/lib/member-management.cjs');
const { hashPassword, verifyPassword } = require('../netlify/functions/lib/member-password.cjs');
if (!process.env.PJO_TEST_PGLITE_PATH) throw Error('Set PJO_TEST_PGLITE_PATH to a local PGlite installation');
const { PGlite } = require(process.env.PJO_TEST_PGLITE_PATH);

async function database(run) {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.app_state (id text primary key, members jsonb, logs jsonb, guest_codes jsonb, updated_at timestamptz);
      grant usage on schema public to service_role, anon, authenticated;
      grant select, update on public.app_state to service_role;`);
    await db.exec(fs.readFileSync(path.join(__dirname, '../docs/security/sql/member-management-v1.sql'), 'utf8'));
    const alice = { id: 'fixture-old', password: 'old-password-only-fixture', status: 'pending', paid: false, memo: 'old-memo',
      history: [{ id: 'reading-one', text: 'unchanged' }], unknown: { keep: true }, firstLoginAt: 123 };
    const bob = { id: 'fixture-bob', password: 'not-used', status: 'active', paid: true, history: [] };
    const logs = [{ action: 'Private consult message', userId: alice.id, message: 'keep me' }];
    await db.query('insert into public.app_state values ($1,$2,$3,$4,now())', ['main',JSON.stringify([alice,bob]),JSON.stringify(logs),'["guest-fixture"]']);
    const readRow = async () => (await db.query("select * from public.app_state where id='main'")).rows[0];
    const setMembers = async members => db.query("update public.app_state set members=$1 where id='main'", [JSON.stringify(members)]);
    const register = async (id, hash, nonce = 'fixture-request-00001', fingerprint = 'x'.repeat(43), until = Math.floor(Date.now()/1000)+1000) =>
      (await db.query('select public.pjo_member_register_v1($1,$2,$3,$4,$5) as result', [id,hash,nonce,fingerprint,until])).rows[0].result.result;
    const manage = async (member, payload, action = 'approve', until = Math.floor(Date.now()/1000)+1000) =>
      (await db.query('select public.pjo_member_manage_v1($1,$2,$3,$4,$5) as result',
        [member.id,JSON.stringify(managementSnapshot(member)),until,action,JSON.stringify(payload)])).rows[0].result.result;
    await run({ db, alice, bob, logs, readRow, setMembers, register, manage });
  } finally { await db.close(); }
}

test('SQL signup/management: permissions, instant permanent policy, no plaintext, atomic CAS and preservation', () => database(async ({ db, alice, bob, logs, readRow, setMembers, register, manage }) => {
  const hash = await hashPassword('fixture-only-password');
  const entitlement = { plan: 'permanent', tier: 'member', permanent: true, expiresAt: PERMANENT_EXPIRY };
  for (const role of ['anon','authenticated']) {
    await db.exec('set role ' + role);
    await assert.rejects(register('fixture-new',hash), e => e.code === '42501');
    await assert.rejects(manage(alice,entitlement), e => e.code === '42501');
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  assert.equal(await register('fixture-new',hash), 'created');
  const initial = await readRow(), created = initial.members[2];
  assert.equal(created.status,'active'); assert.equal(created.paid,true); assert.equal(created.plan,'permanent');
  assert.equal(created.tier,'member'); assert.equal(created.permanent,true); assert.equal(created.expiresAt,PERMANENT_EXPIRY);
  assert.equal(Object.hasOwn(created,'password'), false); assert.equal(await verifyPassword('fixture-only-password',created),true);
  assert.deepEqual(initial.members.slice(0,2),[alice,bob]); assert.deepEqual(initial.logs,logs); assert.deepEqual(initial.guest_codes,['guest-fixture']);
  assert.equal(await register('fixture-new',await hashPassword('fixture-only-password')), 'unchanged');
  assert.equal((await readRow()).members[2].passwordHash,hash,'retry must not replace the original hash');
  assert.equal(await register('fixture-new',hash,'fixture-request-00002'), 'unavailable');
  assert.equal(await register('fixture-new',hash,'fixture-request-00001','y'.repeat(43)), 'unavailable');
  assert.equal(await register(alice.id,hash), 'unavailable');
  assert.equal(await register('bad-hash','plaintext'), 'invalid');
  assert.equal(await register('expired',hash,'fixture-request-expired','x'.repeat(43),1), 'unauthorized');

  // Another account and the same account's readings may change after admin read.
  const latest = (await readRow()).members;
  latest[0].history.push({ id: 'concurrent-reading', text: 'keep latest' }); latest[1].memo = 'concurrent-other-admin';
  await setMembers(latest);
  assert.equal(await manage(alice,entitlement), 'saved');
  const approved = (await readRow()).members[0];
  assert.equal(approved.status,'active'); assert.equal(approved.paid,true);
  assert.deepEqual(approved.history,latest[0].history); assert.deepEqual(approved.unknown,alice.unknown);
  assert.equal(approved.password,alice.password); assert.equal(approved.firstLoginAt,123);
  assert.equal((await readRow()).members[1].memo,'concurrent-other-admin');
  assert.equal(await manage(alice,{ ...entitlement, tier:'vip' }), 'conflict');
  assert.equal(await manage(approved,{ ...entitlement, tier:'admin' }), 'invalid');
  assert.equal(await manage(approved,{ password:'changed' },'set-memo'), 'invalid');
  assert.equal(await manage(approved,{ memo:'new note', status:'active' },'set-memo'), 'invalid');
  assert.equal(await manage(approved,entitlement,'approve',1), 'unauthorized');
  const finite = { plan:'month1',tier:'vip',permanent:false,expiresAt:Date.now()+86400000 };
  assert.equal(await manage(approved,finite,'set-entitlement'), 'saved');
  let changed = (await readRow()).members[0];
  assert.equal(changed.lastApprovedAt,approved.lastApprovedAt); assert.equal(changed.status,approved.status); assert.equal(changed.paid,approved.paid);
  assert.equal(changed.password,alice.password);
  assert.equal(await manage(changed,{ memo:'new note' },'set-memo'), 'saved');
  assert.equal(await manage(changed,{ memo:'stale overwrite' },'set-memo'), 'conflict');
  changed = (await readRow()).members[0];
  assert.equal(await manage(changed,{ memo:'new note' },'set-memo'), 'unchanged');
  const altered = (await readRow()).members; altered[0].password = 'new-credential'; await setMembers(altered);
  assert.equal(await manage(changed,entitlement), 'conflict');
  assert.deepEqual((await readRow()).logs,logs);
  await db.query("update public.app_state set logs=$1 where id='main'", [JSON.stringify([...logs,{id:'deleted-id',action:'Member deleted'}])]);
  assert.equal(await register('deleted-id',hash),'unavailable');
  await setMembers(Array.from({length:10000},(_,i)=>({id:'full-'+i})));
  assert.equal(await register('overflow',hash),'full'); assert.equal((await readRow()).members.length,10000);
  await setMembers([alice,alice]); assert.equal(await register('duplicate',hash),'invalid');
  await setMembers([alice,bob]);
  await db.query("update public.app_state set logs=$1 where id='main'", [JSON.stringify([{message:'x'.repeat(7340032)}])]);
  const fullRow = await readRow();
  assert.equal(await manage(alice,{memo:'must not grow oversized storage'},'set-memo'),'full');
  assert.deepEqual(await readRow(),fullRow,'capacity rejection must not mutate any data');
  await db.query("update public.app_state set logs=$1 where id='main'", [JSON.stringify(logs)]);
  await setMembers(null); assert.equal(await register('invalid',hash),'invalid');
  await db.exec('reset role'); await db.exec("delete from public.app_state where id='main'"); await db.exec('set role service_role');
  assert.equal(await register('missing-main',hash),'invalid'); assert.equal(await manage(alice,entitlement),'invalid');
}));

test('local API to SQL to login roundtrip: newly hashed account can log in without changing legacy users', () => database(async ({ db, readRow }) => {
  const env = { MEMBER_ACCESS_MODE:'rehearsal',MEMBER_ACCOUNT_WRITE_MODE:'rehearsal',MEMBER_SIGNUP_POLICY:'instant-permanent',
    MEMBER_REHEARSAL_IDS:'fixture-roundtrip',MEMBER_SESSION_SECRET:'fixture-member-signing-secret-only-1234567890',
    ADMIN_SESSION_SECRET:'fixture-admin-signing-secret-only-1234567890',ADMIN_MASTER_CODE:'fixture-admin-master-only',
    SUPABASE_URL:'https://chffnolrtxfoehegnecj.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_fixture_only_not_a_real_secret_123456789' };
  const before = Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])); Object.assign(process.env,env);
  const originalFetch = global.fetch;
  await db.exec('set role service_role');
  global.fetch = async (url,options) => {
    if (options.method === 'GET' && url === env.SUPABASE_URL+'/rest/v1/app_state?select=id,members&id=eq.main&limit=1') {
      const row = await readRow(); return new Response(JSON.stringify([{id:row.id,members:row.members}]));
    }
    assert.equal(url,env.SUPABASE_URL+'/rest/v1/rpc/pjo_member_register_v1'); assert.equal(options.method,'POST');
    const p = JSON.parse(options.body);
    const result = (await db.query('select public.pjo_member_register_v1($1,$2,$3,$4,$5) as result',
      [p.p_member_id,p.p_password_hash,p.p_request_id,p.p_fingerprint,p.p_valid_until])).rows[0].result;
    return new Response(JSON.stringify(result));
  };
  try {
    const { issueSessionCookie } = require('../netlify/functions/_admin-session');
    const signup = require('../netlify/functions/member-register').handler;
    const login = require('../netlify/functions/member-login').handler;
    const session = require('../netlify/functions/member-session').handler;
    const baseline = (await readRow()).members;
    const headers = { origin:'https://pjtarot.netlify.app','content-type':'application/json',cookie:issueSessionCookie(env.ADMIN_SESSION_SECRET).split(';')[0] };
    const credentials = {id:'fixture-roundtrip',password:'로컬 확인용 🔐'};
    const registration = await signup({httpMethod:'POST',headers,body:JSON.stringify({...credentials,requestId:'fixture-roundtrip-request'})});
    assert.equal(registration.statusCode,200);
    const signed = await login({httpMethod:'POST',headers,body:JSON.stringify(credentials)}); assert.equal(signed.statusCode,200);
    assert.ok(signed.headers['Set-Cookie'].includes('HttpOnly'));
    const verified = await session({httpMethod:'GET',headers:{...headers,cookie:headers.cookie+'; '+signed.headers['Set-Cookie'].split(';')[0]}});
    assert.equal(verified.statusCode,200); assert.equal(JSON.parse(verified.body).member.id,credentials.id);
    const row = await readRow(); assert.deepEqual(row.members.slice(0,2),baseline);
    assert.equal(row.members[2].password,undefined);
    assert.equal((await signup({httpMethod:'POST',headers,body:JSON.stringify({...credentials,requestId:'fixture-roundtrip-request'})})).statusCode,200);
    assert.equal((await readRow()).members.length,3);
  } finally {
    global.fetch = originalFetch; for (const k of Object.keys(env)) if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];
  }
}));
