'use strict';
// Requires a separately installed PGlite (not a production dependency).
// Never uses a connection string or real Supabase environment/key/data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { authSnapshot } = require('../netlify/functions/lib/archive-record.cjs');
if (!process.env.PJO_TEST_PGLITE_PATH) throw Error('Set PJO_TEST_PGLITE_PATH to a local PGlite installation');
const { PGlite } = require(process.env.PJO_TEST_PGLITE_PATH);

test('actual PostgreSQL function: ACL, isolated writes, stale snapshots, retries, revocation, capacity', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.app_state (id text primary key, members jsonb, logs jsonb, guest_codes jsonb, updated_at timestamptz);
      grant usage on schema public to service_role, anon, authenticated;
      grant select, update on public.app_state to service_role;`);
    await db.exec(fs.readFileSync(path.join(__dirname, '../docs/security/sql/archive-write-v1.sql'), 'utf8'));
    const a = { id: 'alice-fixture', password: 'test-only', status: 'active', paid: true, memo: 'admin-memo', history: [] };
    const b = { id: 'bob-fixture', password: 'test-only-b', status: 'active', paid: true, history: [] };
    const logs = [{ message: 'untouched' }], guests = ['fixture-guest'];
    await db.query('insert into public.app_state values ($1,$2,$3,$4,now())', ['main', JSON.stringify([a, b]), JSON.stringify(logs), JSON.stringify(guests)]);
    const getRow = async () => (await db.query('select * from public.app_state where id=$1', ['main'])).rows[0];
    const call = async (member, id, expected, next, until = Math.floor(Date.now() / 1000) + 1000) => {
      const result = await db.query('select public.pjo_archive_apply_v1($1,$2,$3,$4,$5,$6) as result',
        [member.id, JSON.stringify(authSnapshot(member)), until, id, expected === null ? null : JSON.stringify(expected), next === null ? null : JSON.stringify(next)]);
      return result.rows[0].result.result;
    };
    for (const role of ['anon', 'authenticated']) {
      await db.exec('set role ' + role);
      await assert.rejects(call(a, 'r', null, { id: 'r' }), error => error.code === '42501');
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    const r1 = { id: 'r1', q: '질문', time: 1, favorite: false, legacyExtra: { keep: true } };
    const r2 = { id: 'r2', q: '다른 질문', time: 2 };
    // Both server requests saw the same old row. Each call must preserve the
    // changes committed by the other, even with identical record IDs per owner.
    assert.equal(await call(a, 'r1', null, r1), 'saved');
    assert.equal(await call(b, 'r1', null, r1), 'saved');
    assert.equal(await call(a, 'r2', null, r2), 'saved');
    let row = await getRow();
    assert.deepEqual(row.members[0].history, [r2, r1]);
    assert.deepEqual(row.members[1].history, [r1]);
    assert.deepEqual(row.logs, logs); assert.deepEqual(row.guest_codes, guests);
    assert.equal(row.members[0].memo, 'admin-memo');
    assert.equal(await call(a, 'r1', null, r1), 'unchanged');
    assert.equal(await call(a, 'r1', null, { ...r1, q: 'conflict' }), 'conflict');
    const starred = { ...r1, favorite: true };
    assert.equal(await call(a, 'r1', r1, starred), 'saved');
    assert.equal(await call(a, 'r1', r1, starred), 'unchanged');
    assert.equal(await call(a, 'r1', r1, { ...r1, q: 'stale overwrite' }), 'conflict');
    assert.equal(await call(a, 'r2', r2, null), 'deleted');
    assert.equal(await call(a, 'r2', r2, null), 'unchanged');
    assert.equal(await call(a, 'r1', starred, { ...starred, id: 'different' }), 'invalid');
    assert.equal(await call(a, 'r1', starred, r1, 1), 'unauthorized');
    assert.equal(await call(a, 'r1', starred, r1, Math.floor(Date.now() / 1000) + 90000), 'unauthorized');
    row = await getRow();
    for (const changed of [{ status: 'blocked' }, { password: 'changed' }, { passwordHash: null }, { paid: false }, { expiresAt: 1 }]) {
      const altered = [{ ...row.members[0], ...changed }, row.members[1]];
      await db.query('update public.app_state set members=$1 where id=$2', [JSON.stringify(altered), 'main']);
      assert.equal(await call(a, 'r1', starred, r1), 'unauthorized');
    }
    const full = Array.from({ length: 60 }, (_, index) => ({ id: 'full-' + index }));
    await db.query('update public.app_state set members=$1 where id=$2', [JSON.stringify([{ ...a, history: full }, b]), 'main']);
    assert.equal(await call(a, 'new', null, { id: 'new' }), 'full');
    assert.deepEqual((await getRow()).members[0].history, full);
    await db.query('update public.app_state set members=$1 where id=$2', [JSON.stringify([{ ...a, history: [r1, r1] }, b]), 'main']);
    assert.equal(await call(a, 'r1', r1, null), 'invalid');
    await db.query('update public.app_state set members=$1 where id=$2', [JSON.stringify([{ ...a, history: null }, b]), 'main']);
    assert.equal(await call(a, 'r1', null, r1), 'invalid');
    // Fixture-only deletion verifies no upsert/initialization when main is absent.
    await db.exec('reset role');
    await db.query('delete from public.app_state where id=$1', ['main']);
    await db.exec('set role service_role');
    assert.equal(await call(a, 'r1', null, r1), 'invalid');
    assert.equal((await db.query('select count(*)::int as n from public.app_state')).rows[0].n, 0);
  } finally { await db.close(); }
});
