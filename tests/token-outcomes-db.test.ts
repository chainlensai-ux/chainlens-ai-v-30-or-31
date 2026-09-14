import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Run with OUTCOME_PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js.
// Isolated real PostgreSQL engine: no production DB or credentials, no schema mocking.
test('outcome migration enforces RLS, immutable snapshots, limits and duplicates in PostgreSQL', { skip: !process.env.OUTCOME_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.OUTCOME_PGLITE_MODULE!)
  const db = new PGlite()
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      grant usage on schema auth,public to authenticated,service_role;
      insert into auth.users values ('${a}'),('${b}');`)
    await db.exec(readFileSync(new URL('../docs/migrations/20260914_tracked_token_outcomes.sql', import.meta.url), 'utf8'))
    const snapshot = (userId: string, scanId = 'scan-1') => ({ userId, chain: 'base', tokenAddress: `0x${'a'.repeat(40)}`, scanId, baselineRiskScore: 78, baselineVerdict: 'Critical Risk', baselinePriceUsd: 10, baselineLiquidityUsd: 20000 })
    async function create(userId: string, scanId = 'scan-1', limit = 5) {
      await db.exec('set role service_role')
      return db.query('select public.create_tracked_outcome($1::uuid,$2::jsonb,$3::integer) as result', [userId, JSON.stringify(snapshot(userId, scanId)), limit])
    }
    await t.test('same user+chain+token+scan is idempotent, even at the limit', async () => {
      const first = await create(a, 'scan-1', 1)
      const second = await create(a, 'scan-1', 1)
      assert.equal(second.rows[0].result.duplicate, true)
      assert.equal(first.rows[0].result.outcome.id, second.rows[0].result.outcome.id)
      await assert.rejects(create(a, 'scan-2', 1), /plan limit/)
    })
    await t.test('different user can track same token; user A cannot read user B', async () => {
      await create(b)
      await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${a}'`)
      const own = await db.query('select user_id from public.tracked_token_outcomes')
      assert.equal(own.rows.length, 1); assert.equal(own.rows[0].user_id, a)
      const other = await db.query('select * from public.tracked_token_outcomes where user_id=$1', [b])
      assert.equal(other.rows.length, 0)
    })
    await t.test('clients cannot invoke server insert RPC, forge inserts or mutate snapshots', async () => {
      await assert.rejects(db.query('select public.create_tracked_outcome($1::uuid,$2::jsonb,200)', [b, JSON.stringify(snapshot(b))]), /permission denied/)
      await assert.rejects(db.exec(`update public.tracked_token_outcomes set baseline_risk_score=99 where user_id='${a}'`), /permission denied/)
      await assert.rejects(db.exec(`insert into public.tracked_token_outcomes(user_id) values('${b}')`), /permission denied/)
    })
    await t.test('even service role cannot rewrite original snapshot; current observation can update', async () => {
      await db.exec('set role service_role')
      await assert.rejects(db.exec(`update public.tracked_token_outcomes set baseline_risk_score=99 where user_id='${a}'`), /immutable/)
      await db.exec(`update public.tracked_token_outcomes set current_price_usd=1 where user_id='${a}'`)
      const row = (await db.query(`select baseline_risk_score,current_price_usd from public.tracked_token_outcomes where user_id='${a}'`)).rows[0]
      assert.equal(row.baseline_risk_score,78); assert.equal(row.current_price_usd,1)
    })
    await t.test('server function rejects mismatched snapshot owner', async () => {
      await assert.rejects(db.query('select public.create_tracked_outcome($1::uuid,$2::jsonb,200)', [a, JSON.stringify(snapshot(b))]), /Snapshot user mismatch/)
    })
    await t.test('anonymous users cannot read outcomes', async () => {
      await db.exec('set role anon')
      await assert.rejects(db.query('select * from public.tracked_token_outcomes'), /permission denied/)
    })
  } finally { await db.close() }
})
