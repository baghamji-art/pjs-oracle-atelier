'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { authSnapshot } = require('../netlify/functions/lib/archive-record.cjs');
if (!process.env.PJO_TEST_PGLITE_PATH) throw Error('Set PJO_TEST_PGLITE_PATH to a local PGlite installation');
const { PGlite } = require(process.env.PJO_TEST_PGLITE_PATH);

test('SQL consultation append: permissions, ownership, retry identity, ordering, no truncation or collateral writes', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.app_state (id text primary key, members jsonb, logs jsonb, guest_codes jsonb, updated_at timestamptz);
      grant usage on schema public to service_role, anon, authenticated;
      grant select, update on public.app_state to service_role;`);
    await db.exec(fs.readFileSync(path.join(__dirname, '../docs/security/sql/consult-write-v1.sql'), 'utf8'));
    const alice = { id: 'alice-fixture', password: 'fixture-only', status: 'active', paid: true, history: [{ untouched: true }] };
    const bob = { id: 'bob-fixture', password: 'fixture-only-b', status: 'active', paid: true };
    const oldLogs = Array.from({ length: 240 }, (_, index) => ({ action: 'audit-fixture', index }));
    const getRow = async () => (await db.query("select * from public.app_state where id='main'")).rows[0];
    const setRow = async (members, logs) => db.query("update public.app_state set members=$1, logs=$2 where id='main'", [JSON.stringify(members), JSON.stringify(logs)]);
    await db.query('insert into public.app_state values ($1,$2,$3,$4,now())', ['main', JSON.stringify([alice, bob]), JSON.stringify(oldLogs), '["guest-fixture"]']);
    const call = async ({ member = alice, role = 'user', action = 'create', thread = 'thread-a', id = 'message-a', message = 'hello\n안녕', lang = 'ko', until = Math.floor(Date.now() / 1000) + 1000 } = {}) => {
      return (await db.query('select public.pjo_consult_append_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
        [member.id, JSON.stringify(authSnapshot(member)), until, role, action, thread, id, message, lang])).rows[0].result;
    };
    for (const role of ['anon', 'authenticated']) {
      await db.exec('set role ' + role); await assert.rejects(call(), error => error.code === '42501'); await db.exec('reset role');
    }
    await db.exec('set role service_role');
    const first = await call(); assert.equal(first.result, 'sent');
    assert.equal((await call()).result, 'unchanged'); assert.equal((await call()).time, first.time);
    assert.equal((await call({ message: 'changed' })).result, 'conflict');
    assert.equal((await call({ thread: 'new-thread' })).result, 'conflict');
    assert.equal((await call({ member: bob })).result, 'not_found');
    assert.equal((await call({ member: bob, action: 'reply', id: 'bob-hijack' })).result, 'not_found');
    assert.equal((await call({ action: 'reply', thread: 'missing', id: 'missing-reply' })).result, 'not_found');
    assert.equal((await call({ role: 'admin', action: 'create', id: 'invalid-admin-create' })).result, 'invalid');
    assert.equal((await call({ id: 'other-create' })).result, 'conflict');
    const second = await call({ role: 'admin', action: 'reply', id: 'answer-a', message: '답변' });
    const third = await call({ action: 'reply', id: 'followup-a', message: '추가 질문' });
    assert.equal(second.result, 'sent'); assert.equal(third.result, 'sent');
    assert.ok(second.time > first.time); assert.ok(third.time > second.time);
    assert.equal((await call({ member: bob, thread: 'thread-b', id: 'message-a' })).result, 'sent');
    let row = await getRow();
    assert.deepEqual(row.members, [alice, bob]); assert.deepEqual(row.guest_codes, ['guest-fixture']);
    assert.deepEqual(row.logs.slice(-240), oldLogs); assert.equal(row.logs.length, 244);
    assert.equal(row.logs.find(log => log.messageId === 'answer-a').role, 'admin');
    assert.equal(row.logs.find(log => log.messageId === 'followup-a').role, 'user');
    assert.equal((await call({ action: 'reply', id: 'expired-session', until: 1 })).result, 'unauthorized');
    for (const change of [{ password: 'changed' }, { passwordHash: null }, { status: 'blocked' }, { paid: false }]) {
      await setRow([{ ...alice, ...change }, bob], row.logs);
      assert.equal((await call({ action: 'reply', id: 'revoked' })).result, 'unauthorized');
    }
    const expired = { ...alice, status: 'expired', expiresAt: 1 };
    await setRow([expired, bob], row.logs);
    assert.equal((await call({ member: expired, action: 'reply', id: 'expired-user' })).result, 'unauthorized');
    assert.equal((await call({ member: expired, role: 'admin', action: 'reply', id: 'answer-expired' })).result, 'sent');
    const crowded = Array.from({ length: 10000 }, (_, index) => ({ action: 'audit', index }));
    await setRow([alice, bob], crowded);
    assert.equal((await call()).result, 'full'); assert.equal((await getRow()).logs.length, 10000);
    await setRow([alice, bob], [{ action: 'audit', content: 'x'.repeat(7340032) }]);
    assert.equal((await call()).result, 'full');
    await setRow([alice, bob], null); assert.equal((await call()).result, 'invalid');
    await db.exec('reset role'); await db.exec("delete from public.app_state where id='main'");
    await db.exec('set role service_role'); assert.equal((await call()).result, 'invalid');
  } finally { await db.close(); }
});
