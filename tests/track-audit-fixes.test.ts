// Track Outcomes audit fixes: liquidity becomes comparable only on the same pool, a scanner recheck is
// not erased by market ticks, crossing events read as point-in-time, and the 20s live path neither
// rewrites unchanged rows nor clobbers a concurrent recheck.
//   npx tsx --test tests/track-audit-fixes.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { snapshotFromScan } from '../lib/server/tokenOutcomeReceipt'
import { buildOutcomeRefreshUpdate, refreshLiveOutcome, __resetLiveOutcomeQuoteForTest } from '../lib/server/tokenOutcomeService'
import { compareTrackReceipt, currentTrackSnapshot, originalTrackSnapshot } from '../lib/trackIntelligence'
import type { TrackedOutcome } from '../lib/tokenOutcomes'
import type { ClarkMarketQuote } from '../lib/server/clarkMarketData'

process.env.TOKEN_OUTCOME_SIGNING_SECRET = 'track-audit-unit-test-secret-only'
const user = '11111111-1111-4111-8111-111111111111'
const TOKEN = `0x${'a'.repeat(40)}`
const POOL = `0x${'b'.repeat(40)}`
const OTHER_POOL = `0x${'c'.repeat(40)}`
const SCANNED_AT = 1_789_345_000_000
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function row(liquidityBasis: string | null): TrackedOutcome {
  const snapshot = snapshotFromScan({
    chain: 'base', contract: TOKEN, name: 'Embow', symbol: 'EMBOW', riskScore: 62, riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier',
    riskLabel: 'High Risk', priceUsd: 1, liquidityUsd: 161_300, marketCapUsd: 1_000_000, scanRequestId: 'scan-1', scanRequestStartedAt: SCANNED_AT,
    liquidityBasis, riskMethodologyVersion: 'token_risk:v1', holderDistribution: { top10: 63.7, denominator: 'total_supply:rpc' },
  }, user)!
  return {
    id: ID, user_id: user, chain: 'base', token_address: TOKEN, scan_id: 'scan-1', tracked_at: snapshot.scannedAt,
    baseline_price_usd: 1, baseline_liquidity_usd: 161_300, baseline_market_cap_usd: 1_000_000, baseline_risk_score: 62, baseline_verdict: 'High Risk',
    baseline_snapshot_json: snapshot, current_price_usd: null, current_liquidity_usd: null, price_change_pct: null, liquidity_change_pct: null,
    outcome_status: 'watching', outcome_confidence: 'low', outcome_reasons_json: [], last_checked_at: null, market_source: null,
  }
}
const quote = (pool: string, price: number, liquidityUsd: number, fetchedAt: number): ClarkMarketQuote => ({
  provider: 'dexscreener', name: 'Embow', symbol: 'EMBOW', chain: 'base', chainId: 8453, address: TOKEN, priceUsd: price, liquidityUsd,
  marketCapUsd: price * 1_000_000, fdvUsd: null, volume24hUsd: null, change24hPct: null, fetchedAt,
  marketIdentity: { selectedPoolAddress: pool, baseTokenAddress: TOKEN, quoteTokenAddress: null },
})
const after = (base: TrackedOutcome, q: ClarkMarketQuote, at: number, laterScan: Record<string, unknown> | null = null): TrackedOutcome => {
  const update = buildOutcomeRefreshUpdate(base, q, null, new Date(at).toISOString(), at, laterScan)
  return { ...base, ...update } as TrackedOutcome
}
const comparisonOf = (r: TrackedOutcome, key: string) => compareTrackReceipt(originalTrackSnapshot(r), currentTrackSnapshot(r)).comparisons.find((c) => c.key === key)!

test('liquidity: compared only when the live quote reads the same pool the scan measured', () => {
  const basis = `pool:base:${POOL}:usd-reserves`
  const base = row(basis)
  assert.equal(base.baseline_snapshot_json.trackComparison?.liquidityBasis, basis)
  const now = SCANNED_AT + 3_600_000
  const samePool = comparisonOf(after(base, quote(POOL, 0.33, 40, now), now), 'liquidityUsd')
  assert.equal(samePool.compatible, true)
  assert.ok(Math.abs(samePool.delta! - ((40 - 161_300) / 161_300) * 100) < 1e-9)
  const otherPool = comparisonOf(after(base, quote(OTHER_POOL, 0.33, 40, now), now), 'liquidityUsd')
  assert.equal(otherPool.compatible, false, 'a different pool is a different measurement')
  assert.equal(otherPool.delta, null)
  // Legacy receipts (no basis recorded) stay honestly not comparable.
  assert.equal(comparisonOf(after(row(null), quote(POOL, 0.33, 40, now), now), 'liquidityUsd').compatible, false)
})

test('EVM scanner records the pool its liquidity figure was read from', () => {
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.match(route, /`pool:\$\{chain\}:\$\{_liquidityBasisPool\.toLowerCase\(\)\}:usd-reserves`/)
  assert.match(route, /\(responsePayload as any\)\.liquidityBasis = _liquidityBasis/)
})

test('a scanner recheck survives market ticks; display compares it only while it is within 15 minutes', () => {
  const base = row(null)
  const rechecked = SCANNED_AT + 3_600_000
  const laterScan = { chain: 'base', contract: TOKEN, scanRequestStartedAt: rechecked, riskScore: 71, riskScoreType: 'risk_score',
    riskScoreDirection: 'higher_is_riskier', riskMethodologyVersion: 'token_risk:v1', holderDistribution: { top10: 70.2, denominator: 'total_supply:rpc' } }
  let r = after(base, quote(POOL, 0.5, 1000, rechecked), rechecked, laterScan)
  assert.equal(comparisonOf(r, 'riskScore').current, 71)
  assert.equal(comparisonOf(r, 'riskScore').compatible, true)
  // 40 minutes of 20s market ticks (no scanner): the stored recheck is kept…
  for (let t = rechecked + 20_000; t <= rechecked + 40 * 60_000; t += 20_000) r = after(r, quote(POOL, 0.5, 1000, t), t)
  const stored = r.market_observation_json?.trackIntelligence?.snapshot
  assert.equal(stored?.riskScore, 71)
  assert.equal(stored?.top10Pct, 70.2)
  assert.equal(stored?.scannerObservedAt, new Date(rechecked).toISOString())
  // …but not presented as current: it is older than the freshness window, and says so.
  const display = currentTrackSnapshot(r)
  assert.equal(display.riskScore, null)
  assert.equal(display.top10Pct, null)
  assert.equal(display.scannerStale, true)
  assert.equal(comparisonOf(r, 'riskScore').current, null)
})

test('price crossing events read as point-in-time observations, not the current change', () => {
  const base = row(null)
  const at = SCANNED_AT + 3_600_000
  const r = after(base, quote(POOL, 0.362, 1000, at), at)
  const event = r.market_observation_json?.trackIntelligence?.events.find((e) => e.type === 'price_change')
  assert.equal(event?.description, 'Price crossed −50% vs scan · down 63.8% when first observed')
  // The live summary states the current change; the stored event keeps its first-observation wording.
  const later = after(r, quote(POOL, 0.327, 1000, at + 60_000), at + 60_000)
  const live = compareTrackReceipt(originalTrackSnapshot(later), currentTrackSnapshot(later)).changes.find((e) => e.type === 'price_change')
  assert.equal(live?.summary, 'Price down 67.3% since scan')
  const stored = later.market_observation_json?.trackIntelligence?.events.find((e) => e.type === 'price_change')
  assert.equal(stored?.description, 'Price crossed −50% vs scan · down 63.8% when first observed')
})

function liveDb(stored: TrackedOutcome & { updated_at?: string }, opts: { updateRows?: number; latest?: TrackedOutcome } = {}) {
  const writes: Record<string, unknown>[] = []
  const filters: Array<[string, unknown]> = []
  let reads = 0
  const db = {
    from() {
      let op: 'select' | 'update' = 'select'
      let payload: Record<string, unknown> = {}
      const self = {
        select() {
          if (op === 'update') { writes.push(payload); return Promise.resolve({ data: Array.from({ length: opts.updateRows ?? 1 }, () => ({ current_price_usd: payload.current_price_usd, last_checked_at: payload.last_checked_at })), error: null }) }
          return self
        },
        update(p: Record<string, unknown>) { op = 'update'; payload = p; return self },
        eq(column: string, value: unknown) { if (op === 'update') filters.push([column, value]); return self },
        maybeSingle() { reads += 1; return Promise.resolve({ data: reads > 1 && opts.latest ? opts.latest : stored, error: null }) },
      }
      return self
    },
  }
  return { db, writes, filters, reads: () => reads }
}

test('live tick: no usable quote means no database write; the last verified observation stands', async () => {
  __resetLiveOutcomeQuoteForTest()
  const { db, writes } = liveDb(row(null))
  const reasons: Array<string | null> = []
  await refreshLiveOutcome(user, ID, { providers: { dex: async () => null, gecko: async () => null }, onDiagnostic: (d) => reasons.push(d.rejectionReason) }, db as never)
  assert.equal(writes.length, 0)
  assert.deepEqual(reasons, ['no_identity_matched_market_quote'])
})

test('live tick: written only if the row is unchanged since read; a lost race returns the newer row', async () => {
  __resetLiveOutcomeQuoteForTest()
  const now = Date.now()
  const stored = { ...row(null), updated_at: '2026-10-31T10:00:00.000Z' }
  const newer = { ...row(null), current_price_usd: 0.4, last_checked_at: new Date(now).toISOString() } as TrackedOutcome
  const { db, writes, filters } = liveDb(stored, { updateRows: 0, latest: newer })
  const reasons: Array<string | null> = []
  const q = quote(POOL, 0.5, 1000, now)
  const out = await refreshLiveOutcome(user, ID, { now, providers: { dex: async () => ({ quote: q, matches: [q] }), gecko: async () => null }, onDiagnostic: (d) => reasons.push(d.rejectionReason) }, db as never)
  assert.equal(writes.length, 1)
  assert.ok(filters.some(([c, v]) => c === 'updated_at' && v === '2026-10-31T10:00:00.000Z'), 'optimistic lock on updated_at')
  assert.deepEqual(reasons, ['superseded_by_newer_write'])
  assert.equal(out?.last_checked_at, newer.last_checked_at)
})
