import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareTrackReceipt, currentTrackSnapshot, enrichTrackSnapshot, mergeTrackEvents, originalTrackSnapshot, type TrackOriginal, type TrackSnapshot } from '../lib/trackIntelligence'
import { classifyOutcome, type TrackedOutcome } from '../lib/tokenOutcomes'
import { buildOutcomeRefreshUpdate } from '../lib/server/tokenOutcomeService'
import { snapshotFromScan } from '../lib/server/tokenOutcomeReceipt'
import type { ClarkMarketQuote } from '../lib/server/clarkMarketData'

const original: TrackOriginal = { id: 'receipt', observedAt: '2026-10-01T00:00:00Z', priceUsd: 1, marketCapUsd: 100_000,
  liquidityUsd: 100_000, liquidityBasis: 'pool:base:pool1:usd-reserves', top10Pct: 31, holderBasis: 'total_supply:exclusions-v1',
  riskScore: 62, riskMethodologyVersion: 'risk-v1', deployerActivity: null, outcome: 'watching' }
const current = (override: Partial<TrackSnapshot> = {}): TrackSnapshot => ({ ...original, observedAt: '2026-10-02T00:00:00Z', ...override })
test('frozen original receipt is never mutated', () => {
  const frozen = Object.freeze({ ...original })
  compareTrackReceipt(frozen, current({ liquidityUsd: 70_000 }))
  assert.deepEqual(frozen, original)
})
test('unavailable evidence never becomes zero', () => {
  const result = compareTrackReceipt(original, current({ liquidityUsd: null, riskScore: null, top10Pct: null }))
  assert.ok(result.comparisons.every(c => c.current === null && c.delta === null))
  assert.equal(result.materialChangeCount, 0)
})
test('pool vs aggregate and different pools suppress liquidity deltas', () => {
  for (const liquidityBasis of [null, 'aggregate:base', 'pool:base:pool2:usd-reserves']) {
    const c = compareTrackReceipt(original, current({ liquidityUsd: 70_000, liquidityBasis })).comparisons[1]
    assert.equal(c.current, 70_000); assert.equal(c.delta, null); assert.equal(c.compatible, false)
  }
})
test('methodology mismatch preserves both scores without an arrow', () => {
  const c = compareTrackReceipt(original, current({ riskScore: 74, riskMethodologyVersion: 'risk-v2' })).comparisons[0]
  assert.equal(c.original, 62); assert.equal(c.current, 74); assert.equal(c.delta, null)
  assert.match(c.reason!, /methodology changed/)
})
test('missing methodology is not assumed compatible', () => {
  assert.equal(compareTrackReceipt({ ...original, riskMethodologyVersion: null }, current()).comparisons[0].compatible, false)
})
test('different holder denominator suppresses pp change', () => {
  assert.equal(compareTrackReceipt(original, current({ top10Pct: 39, holderBasis: 'indexed_sample' })).comparisons[2].delta, null)
})
test('matching evidence produces the requested percent and pp changes', () => {
  const r = compareTrackReceipt(original, current({ liquidityUsd: 81_200, top10Pct: 39 }))
  assert.equal(r.comparisons[1].delta, -18.8)
  assert.equal(r.comparisons[2].delta, 8)
  assert.equal(r.materialChangeCount, 2)
  assert.equal(r.criticalChangeCount, 0)
})
test('event IDs are deterministic across refresh times', () => {
  const a = compareTrackReceipt(original, current({ liquidityUsd: 80_000 })).timelineEvents
  const b = compareTrackReceipt(original, current({ liquidityUsd: 80_000, observedAt: '2026-10-02T00:01:00Z' })).timelineEvents
  assert.deepEqual(a.map(e => e.id), b.map(e => e.id))
})
test('refresh deduplicates and preserves first observation timestamp', () => {
  const a = compareTrackReceipt(original, current({ liquidityUsd: 80_000 })).timelineEvents
  const b = compareTrackReceipt(original, current({ liquidityUsd: 79_000, observedAt: '2026-10-02T00:01:00Z' })).timelineEvents
  assert.deepEqual(mergeTrackEvents(a, b), mergeTrackEvents([], a))
})
test('small price/cap/liquidity/holder changes create no tick noise', () => {
  const r = compareTrackReceipt(original, current({ priceUsd: 1.01, marketCapUsd: 101_000, liquidityUsd: 95_000, top10Pct: 32 }))
  assert.deepEqual(r.timelineEvents.map(e => e.type), ['scan_created'])
})
test('verified direct deployer transfer produces one deduplicated event', () => {
  const transfer = { txHash: '0xabc', walletAddress: '0xcreator', observedAt: '2026-10-01T12:00:00Z', source: 'accepted scanner transfer',
    verified: true as const, relationship: 'deployer' as const, supplyPct: 2.4 }
  const r = compareTrackReceipt(original, current({ deployerActivity: [transfer, transfer] }))
  assert.equal(r.timelineEvents.filter(e => e.type === 'deployer_transfer').length, 1)
  assert.equal(r.comparisons[3].current, 1)
  assert.match(r.changes[0].description, /2.4%/)
})
test('unverified, historical and future transfers cannot create dev activity', () => {
  const t = { txHash: 'tx', walletAddress: 'wallet', source: 'scanner', relationship: 'deployer' as const, verified: true as const, observedAt: original.observedAt }
  const r = compareTrackReceipt(original, current({ deployerActivity: [t, { ...t, observedAt: '2027-01-01' }] }))
  assert.equal(r.timelineEvents.filter(e => e.type === 'deployer_transfer').length, 0)
})
test('price collapse alone never becomes a rug event', () => {
  const status = classifyOutcome({ price: 1, liquidity: 100_000 }, { price: .001, liquidity: 1 })
  assert.equal(status.status, 'dumped')
  const r = compareTrackReceipt(original, current({ priceUsd: .001, outcome: 'rugged' }))
  assert.ok(!r.timelineEvents.some(e => e.currentValue === 'rugged'))
  assert.equal(r.criticalChangeCount, 0)
})
test('legacy receipt without additive fields has a safe presentation', () => {
  const row = { id: 'legacy', chain: 'base', token_address: '0xabc', baseline_price_usd: null, baseline_liquidity_usd: null,
    baseline_market_cap_usd: null, baseline_snapshot_json: { scannedAt: original.observedAt }, current_price_usd: null,
    current_liquidity_usd: null, last_checked_at: null, outcome_status: 'unavailable' } as TrackedOutcome
  const r = compareTrackReceipt(originalTrackSnapshot(row), currentTrackSnapshot(row))
  assert.equal(r.comparisons.length, 4)
  assert.equal(r.timelineEvents[0].type, 'scan_created')
  assert.ok(r.comparisons.every(c => c.current === null))
})
test('UI inserts only the three additive sections below Live Market', () => {
  const ui = readFileSync(new URL('../components/outcomes/OutcomeCard.tsx', import.meta.url), 'utf8')
  assert.ok(ui.indexOf('<TrackIntelligence row={row} />') > ui.indexOf('Live market</span>'))
  assert.ok(ui.indexOf('<TrackIntelligence row={row} />') < ui.indexOf('className={styles.outcomePanel}'))
})
test('server cache must be fresh, after scan and same token/chain', () => {
  const row = { chain: 'base', token_address: '0xabc', baseline_snapshot_json: { scannedAt: original.observedAt } } as TrackedOutcome
  const now = Date.parse(current().observedAt)
  const scan = { chain: 'base', contract: '0xabc', scanRequestStartedAt: now, holderDistribution: { top10: 39, denominator: 'total_supply' },
    riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier', riskScore: 74 }
  assert.equal(enrichTrackSnapshot(row, current(), scan, now).riskScore, 74)
  for (const invalid of [{ ...scan, chain: 'eth' }, { ...scan, contract: '0xdef' }, { ...scan, scanRequestStartedAt: now - 3600000 }]) {
    assert.deepEqual(enrichTrackSnapshot(row, current(), invalid, now), current())
  }
})
test('timeline is bounded and retains frozen creation event', () => {
  let events = compareTrackReceipt(original, current()).timelineEvents
  for (let i = 1; i <= 130; i++) events = mergeTrackEvents(events, compareTrackReceipt(original, current({ priceUsd: 1 + i })).timelineEvents)
  assert.equal(events.length, 100)
  assert.equal(events.at(-1)?.type, 'scan_created')
})
test('existing refresh persists intelligence separately and retains it on provider failure', () => {
  const token = `0x${'a'.repeat(40)}`
  const now = Date.parse('2026-10-02T00:00:00Z')
  const receipt = snapshotFromScan({ chain: 'base', contract: token, riskScore: 62, riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier',
    priceUsd: 1, marketCapUsd: 100_000, liquidityUsd: 100_000, scanRequestStartedAt: Date.parse(original.observedAt), scanRequestId: 'original' }, 'user')!
  const row = { id: 'receipt', chain: 'base', token_address: token, scan_id: 'original', tracked_at: original.observedAt,
    baseline_snapshot_json: receipt, baseline_price_usd: 1, baseline_market_cap_usd: 100_000, baseline_liquidity_usd: 100_000,
    current_price_usd: null, current_liquidity_usd: null, last_checked_at: null } as TrackedOutcome
  const before = structuredClone(row)
  const quote = { provider: 'dexscreener', chain: 'base', address: token, priceUsd: 2, marketCapUsd: 200_000, liquidityUsd: 90_000, fetchedAt: now,
    marketIdentity: { baseTokenAddress: token, quoteTokenAddress: null, selectedPoolAddress: 'pool' } } as ClarkMarketQuote
  const update = buildOutcomeRefreshUpdate(row, quote, null, new Date(now).toISOString(), now)
  assert.deepEqual(row, before)
  assert.ok(!('baseline_snapshot_json' in update))
  assert.ok(update.market_observation_json?.trackIntelligence?.events.some(e => e.type === 'price_change'))
  const next = { ...row, ...update }
  const retry = buildOutcomeRefreshUpdate(next, quote, null, new Date(now + 1000).toISOString(), now + 1000)
  assert.deepEqual(retry.market_observation_json?.trackIntelligence?.events, update.market_observation_json?.trackIntelligence?.events)
  const failed = buildOutcomeRefreshUpdate(next, null, null, new Date(now + 2000).toISOString(), now + 2000)
  assert.deepEqual(failed.market_observation_json, update.market_observation_json)
})
test('scanner accepts direct proven creator transfers, never ordinary holder graph links', () => {
  const now = Date.parse(current().observedAt)
  const row = { chain: 'base', token_address: '0xabc', baseline_snapshot_json: { scannedAt: original.observedAt } } as TrackedOutcome
  const dev = { deployerStatus: 'confirmed', creationTxHash: 'creation', deployerAddress: 'creator',
    linkedWallets: [{ reason: 'token_supply_transfer', txHash: 'tx', firstSeen: '2026-10-01T12:00:00Z', amountReceived: 999 }] }
  const scan = { chain: 'base', contract: '0xabc', scanRequestStartedAt: now, devIntel: dev }
  const next = enrichTrackSnapshot(row, current(), scan, now)
  assert.equal(next.deployerActivity?.length, 1)
  assert.equal(next.deployerActivity?.[0].supplyPct, undefined)
  for (const invalid of [{ ...dev, creationTxHash: null }, { ...dev, deployerStatus: 'possible_match' },
    { ...dev, linkedWallets: [{ reason: 'top_holder_direct_transfer', txHash: 'tx', firstSeen: '2026-10-01T12:00:00Z' }] }]) {
    assert.equal(enrichTrackSnapshot(row, current(), { ...scan, devIntel: invalid }, now).deployerActivity, null)
  }
})
test('stale reused scanner numbers expire without erasing their historical events', () => {
  const snap = current({ scannerObservedAt: '2026-10-01T00:00:00Z', top10Pct: 39, riskScore: 74 })
  const row = { last_checked_at: current().observedAt, market_observation_json: { trackIntelligence: { snapshot: snap } } } as TrackedOutcome
  const result = currentTrackSnapshot(row)
  assert.equal(result.top10Pct, null); assert.equal(result.riskScore, null)
})
