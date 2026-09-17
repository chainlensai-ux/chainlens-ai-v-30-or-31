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
  const c = '33333333-3333-4333-8333-333333333333'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      grant usage on schema auth,public to authenticated,service_role;
      insert into auth.users values ('${a}'),('${b}'),('${c}');`)
    await db.exec(readFileSync(new URL('../docs/migrations/20260914_tracked_token_outcomes.sql', import.meta.url), 'utf8'))
    await db.exec(`set role service_role;
      insert into public.tracked_token_outcomes(user_id,chain,token_address,scan_id,baseline_price_usd,baseline_risk_score,baseline_verdict,baseline_snapshot_json,current_price_usd,price_change_pct,outcome_status)
      values('${c}','base','0xcccccccccccccccccccccccccccccccccccccccc','legacy-zero',10,70,'High Risk','{}',0,-100,'dumped')`)
    await db.exec('reset role')
    await db.exec(readFileSync(new URL('../docs/migrations/20260914_token_outcome_price_integrity.sql', import.meta.url), 'utf8'))
    await db.exec(readFileSync(new URL('../docs/migrations/20260918_track_outcome_identity_proof.sql', import.meta.url), 'utf8'))
    const snapshot = (userId: string, scanId = 'scan-1') => ({ userId, chain: 'base', tokenAddress: `0x${'a'.repeat(40)}`, scanId, baselineRiskScore: 78, baselineVerdict: 'Critical Risk', baselinePriceUsd: 10, baselineLiquidityUsd: 20000 })
    async function create(userId: string, scanId = 'scan-1', limit = 5) {
      await db.exec('set role service_role')
      return db.query('select public.create_tracked_outcome($1::uuid,$2::jsonb,$3::integer) as result', [userId, JSON.stringify(snapshot(userId, scanId)), limit])
    }
    await t.test('integrity migration repairs legacy zero and fabricated -100% observations', async () => {
      await db.exec('set role service_role')
      const legacy = (await db.query(`select current_price_usd,price_change_pct,outcome_status,outcome_confidence from public.tracked_token_outcomes where user_id='${c}'`)).rows[0]
      assert.equal(legacy.current_price_usd, null)
      assert.equal(legacy.price_change_pct, null)
      assert.equal(legacy.outcome_status, 'unavailable')
      assert.equal(legacy.outcome_confidence, 'low')
    })
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
      await assert.rejects(db.exec(`update public.tracked_token_outcomes set current_price_usd=0,price_change_pct=-100 where user_id='${a}'`), /tracked_outcome_current_price_positive/)
    })
    await t.test('server function rejects mismatched snapshot owner', async () => {
      await assert.rejects(db.query('select public.create_tracked_outcome($1::uuid,$2::jsonb,200)', [a, JSON.stringify(snapshot(b))]), /Snapshot user mismatch/)
    })
    await t.test('anonymous users cannot read outcomes', async () => {
      await db.exec('set role anon')
      await assert.rejects(db.query('select * from public.tracked_token_outcomes'), /permission denied/)
    })
    await t.test('clients cannot delete receipts; service deletion is exact and removes the observation row', async () => {
      await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${a}'`)
      await assert.rejects(db.exec(`delete from public.tracked_token_outcomes where user_id='${a}'`), /permission denied/)
      await db.exec('set role service_role')
      const target = (await db.query(`select id from public.tracked_token_outcomes where user_id='${b}' limit 1`)).rows[0].id
      await db.query('delete from public.tracked_token_outcomes where id=$1 and user_id=$2', [target, b])
      assert.equal((await db.query('select id from public.tracked_token_outcomes where id=$1', [target])).rows.length, 0)
      assert.ok((await db.query(`select id from public.tracked_token_outcomes where user_id='${a}'`)).rows.length > 0)
    })
  } finally { await db.close() }
})
