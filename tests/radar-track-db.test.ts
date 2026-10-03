import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.TOKEN_OUTCOME_SIGNING_SECRET = 'radar-track-db-test-secret-only'

import { buildRadarTrackEvidence } from '../lib/radarTrackEvidence'
import { signRadarTrackEvidence, verifyRadarTrackReceipt } from '../lib/server/radarTrackReceipt'
import { isRadarReceiptSchemaError } from '../lib/server/tokenOutcomeService'

// Run with OUTCOME_PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js (same as
// tests/token-outcomes-db.test.ts). Real PostgreSQL engine, every migration applied in order.
test('Base Radar → Track migration: idempotent, re-trackable, scanner constraint intact', { skip: !process.env.OUTCOME_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.OUTCOME_PGLITE_MODULE!)
  const db = new PGlite()
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  const token = `0x${'d'.repeat(40)}`
  const now = Date.now()
  function radarSnapshot(userId: string, chain: 'base' | 'robinhood' = 'base', price = 0.5) {
    const evidence = buildRadarTrackEvidence({
      name: 'Gold Fish', symbol: 'GOLDFISH', contract: token, priceUsd: price, liquidityUsd: 90_000, volume24h: 40_000,
      ageMinutes: 46, marketCapUsd: 1_800_000, marketCapStatus: 'verified', fdvUsd: 2_000_000, holderVerified: true, simulationStatus: 'open_check',
    }, chain, new Date(now - 30_000).toISOString())!
    const res = verifyRadarTrackReceipt(signRadarTrackEvidence(evidence, userId, now), userId, now)
    assert.ok(res.ok)
    return res.ok ? res.snapshot : (null as never)
  }
  const scannerSnapshot = (userId: string, scanId: string, risk: number | null = 78) => ({ userId, chain: 'base', tokenAddress: token, scanId, baselineRiskScore: risk, baselineVerdict: 'Critical Risk', baselinePriceUsd: 10, baselineLiquidityUsd: 20000 })
  async function create(userId: string, snapshot: unknown, limit = 5) {
    await db.exec('set role service_role')
    const res = await db.query('select public.create_tracked_outcome($1::uuid,$2::jsonb,$3::integer) as result', [userId, JSON.stringify(snapshot), limit])
    return (res.rows[0] as { result: { duplicate: boolean; outcome: { id: string; baseline_risk_score: number | null; scan_id: string; baseline_price_usd: number } } }).result
  }
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      grant usage on schema auth,public to authenticated,service_role;
      insert into auth.users values ('${a}'),('${b}');`)
    for (const file of ['20260914_tracked_token_outcomes.sql', '20260914_token_outcome_price_integrity.sql', '20260918_track_outcome_identity_proof.sql']) {
      await db.exec(readFileSync(new URL(`../docs/migrations/${file}`, import.meta.url), 'utf8'))
    }
    await t.test('before the migration a Radar receipt fails with an error the route maps to "needs migration"', async () => {
      const err = await create(a, radarSnapshot(a)).then(() => null, (e: unknown) => e as { code?: string; message?: string })
      assert.ok(err)
      assert.equal(isRadarReceiptSchemaError(err), true)
      await db.exec('reset role')
    })
    await db.exec(readFileSync(new URL('../docs/migrations/20261003_track_base_radar_receipts.sql', import.meta.url), 'utf8'))

    let firstId = ''
    await t.test('a Radar receipt inserts with no risk score and its frozen Radar baseline', async () => {
      const r = await create(a, radarSnapshot(a))
      assert.equal(r.duplicate, false)
      assert.equal(r.outcome.baseline_risk_score, null)
      assert.equal(r.outcome.scan_id, `base_radar:base:${token}`)
      assert.equal(r.outcome.baseline_price_usd, 0.5)
      firstId = r.outcome.id
    })
    await t.test('repeated Track clicks return the same receipt — never a duplicate active row, never a new baseline', async () => {
      const again = await create(a, radarSnapshot(a, 'base', 0.9))
      assert.equal(again.duplicate, true)
      assert.equal(again.outcome.id, firstId)
      assert.equal(again.outcome.baseline_price_usd, 0.5)
      const count = await db.query(`select count(*)::int as n from public.tracked_token_outcomes where user_id='${a}'`)
      assert.equal((count.rows[0] as { n: number }).n, 1)
    })
    await t.test('same token on another chain is a separate receipt', async () => {
      const rh = await create(a, radarSnapshot(a, 'robinhood'))
      assert.equal(rh.duplicate, false)
      assert.notEqual(rh.outcome.id, firstId)
    })
    await t.test('Radar baseline is immutable like every Track baseline', async () => {
      await db.exec('set role service_role')
      await assert.rejects(() => db.exec(`update public.tracked_token_outcomes set baseline_snapshot_json = '{}'::jsonb where id='${firstId}'`), /immutable/)
      await assert.rejects(() => db.exec(`update public.tracked_token_outcomes set baseline_price_usd = 99 where id='${firstId}'`), /immutable/)
      await db.exec(`update public.tracked_token_outcomes set current_price_usd = 0.7 where id='${firstId}'`)
    })
    await t.test('remove, then Track again creates a fresh receipt', async () => {
      await db.exec('set role service_role')
      await db.exec(`delete from public.tracked_token_outcomes where id='${firstId}'`)
      const fresh = await create(a, radarSnapshot(a, 'base', 0.9))
      assert.equal(fresh.duplicate, false)
      assert.notEqual(fresh.outcome.id, firstId)
      assert.equal(fresh.outcome.baseline_price_usd, 0.9)
    })
    await t.test('a token already tracked from Token Scanner reads as already tracked from Radar', async () => {
      const scanned = await create(b, scannerSnapshot(b, 'scan-1'))
      assert.equal(scanned.duplicate, false)
      const fromRadar = await create(b, radarSnapshot(b))
      assert.equal(fromRadar.duplicate, true)
      assert.equal(fromRadar.outcome.id, scanned.outcome.id)
    })
    await t.test('scanner receipts keep the exact 50–100 risk constraint and scan-id idempotency', async () => {
      await assert.rejects(() => create(b, scannerSnapshot(b, 'scan-low', 40)), /check constraint/)
      await assert.rejects(() => create(b, scannerSnapshot(b, 'scan-null', null)), /check constraint/)
      const rescan = await create(b, scannerSnapshot(b, 'scan-2'))
      assert.equal(rescan.duplicate, false)
      assert.equal((await create(b, scannerSnapshot(b, 'scan-2'))).duplicate, true)
    })
    await t.test('a Radar-sourced row cannot smuggle in a risk score', async () => {
      await db.exec('set role service_role')
      const forged = { ...radarSnapshot(a, 'robinhood'), tokenAddress: `0x${'e'.repeat(40)}`, baselineRiskScore: 80 }
      await assert.rejects(() => create(a, forged), /check constraint/)
    })
    await t.test('plan limit still applies to Radar receipts', async () => {
      const c = '33333333-3333-4333-8333-333333333333'
      await db.exec('reset role')
      await db.exec(`insert into auth.users values ('${c}')`)
      await create(c, radarSnapshot(c), 1)
      await assert.rejects(() => create(c, radarSnapshot(c, 'robinhood'), 1), /plan limit/)
    })
    await t.test('clients still cannot call the insert RPC', async () => {
      await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${a}',false)`)
      await assert.rejects(() => db.query('select public.create_tracked_outcome($1::uuid,$2::jsonb,5)', [a, JSON.stringify(radarSnapshot(a))]), /permission denied/)
      await db.exec('reset role')
    })
  } finally { await db.close() }
})
