import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.TOKEN_OUTCOME_SIGNING_SECRET = 'radar-track-unit-test-secret-only'

import {
  RADAR_TRACK_EVIDENCE_MAX_AGE_MS, RADAR_TRACK_RECEIPT_MAX_AGE_MS, buildRadarTrackEvidence, canonicalRadarTrackEvidence,
  radarTrackScanId, trackedTokenKey, type RadarTrackReceipt,
} from '../lib/radarTrackEvidence'
import { attachRadarTrackReceipts, signRadarTrackEvidence, snapshotFromRadarEvidence, verifyRadarTrackReceipt } from '../lib/server/radarTrackReceipt'
import { buildRadarFeedDisplayModel, getRadarMomentum, resolveRadarCardStatus } from '../lib/baseRadarFeedStatus'
import { adoptNewerOutcomeObservation, presentTrackedOutcome, shareOutcome, type TrackedOutcome } from '../lib/tokenOutcomes'
import { hydrateTrackedOutcomeListRow, isRadarReceiptSchemaError } from '../lib/server/tokenOutcomeService'
import { verifyOutcomeReceipt } from '../lib/server/tokenOutcomeReceipt'

const user = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const ADDR = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01'
const NOW = Date.parse('2026-10-03T12:00:00.000Z')
const FETCHED = new Date(NOW - 60_000).toISOString()

function radarToken(over: Record<string, unknown> = {}) {
  return {
    name: 'Gold Fish', symbol: 'GOLDFISH', contract: ADDR, chainSlug: 'base', chainId: 8453, tokenAddress: ADDR,
    priceUsd: 0.00182, priceChange24hPct: 12, priceChange6hPct: 3, priceChange1hPct: 1, pairCreatedAt: '2026-10-03T11:14:00.000Z',
    ageMinutes: 46, liquidityUsd: 182_400, volume24h: 412_900, fdvUsd: 2_400_000, marketCapUsd: 1_800_000, marketCapStatus: 'verified',
    valuationBasis: 'verified_market_cap', valuationUsd: 1_800_000, holderVerified: true, evidenceGaps: ['LP lock proof open check'],
    riskLevel: 'WATCH', honeypot: null, simulationStatus: 'open_check', simulationReason: null, clarkVerdict: null,
    ...over,
  }
}

function signed(over: Record<string, unknown> = {}, at = NOW, fetchedAt = FETCHED, uid = user): RadarTrackReceipt {
  const evidence = buildRadarTrackEvidence(radarToken(over), 'base', fetchedAt)
  assert.ok(evidence)
  const receipt = signRadarTrackEvidence(evidence!, uid, at)
  assert.ok(receipt)
  return receipt!
}

test('evidence: frozen Radar score/label/status are exactly what the card computes', () => {
  const token = radarToken()
  const e = buildRadarTrackEvidence(token, 'base', FETCHED)!
  const model = buildRadarFeedDisplayModel(token)
  assert.equal(e.radarScore, model.score)
  assert.equal(e.radarLabel, model.riskLabel)
  assert.equal(e.radarStatus, resolveRadarCardStatus(token, model, getRadarMomentum(token.volume24h, token.liquidityUsd).level))
  assert.equal(e.radarScoreDirection, 'higher_is_stronger')
  assert.equal(e.tokenAddress, ADDR.toLowerCase())
  assert.equal(e.chain, 'base')
  assert.equal(e.radarFetchedAt, FETCHED)
})

test('evidence: market cap is frozen only when verified — FDV is never a market-cap baseline', () => {
  const e = buildRadarTrackEvidence(radarToken({ marketCapStatus: 'unavailable', marketCapUsd: null, valuationBasis: 'fdv_fallback' }), 'base', FETCHED)!
  assert.equal(e.marketCapUsd, null)
  assert.equal(e.fdvUsd, 2_400_000)
  const snap = snapshotFromRadarEvidence(e, user)
  assert.equal(snap.baselineMarketCapUsd, null)
})

test('evidence: unsupported chain or malformed address is rejected, never guessed', () => {
  assert.equal(buildRadarTrackEvidence(radarToken(), 'solana', FETCHED), null)
  assert.equal(buildRadarTrackEvidence(radarToken({ contract: 'not-an-address' }), 'base', FETCHED), null)
  assert.equal(buildRadarTrackEvidence(radarToken(), 'base', 'not-a-date'), null)
})

test('receipt: round-trips into a canonical Track snapshot with the Radar source and no risk score', () => {
  const result = verifyRadarTrackReceipt(signed(), user, NOW + 5_000)
  assert.ok(result.ok)
  if (!result.ok) return
  const s = result.snapshot
  assert.equal(s.source, 'base_radar')
  assert.equal(s.snapshotVersion, 2)
  assert.equal(s.riskScoreDirection, 'none')
  assert.equal(s.baselineRiskScore, null)
  assert.equal(s.userId, user)
  assert.equal(s.chain, 'base')
  assert.equal(s.tokenAddress, ADDR.toLowerCase())
  assert.equal(s.scanId, `base_radar:base:${ADDR.toLowerCase()}`)
  assert.equal(s.scannedAt, FETCHED)
  assert.equal(s.baselinePriceUsd, 0.00182)
  assert.equal(s.baselineLiquidityUsd, 182_400)
  assert.equal(s.baselineMarketCapUsd, 1_800_000)
  assert.equal(s.radarScore, result.evidence.radarScore)
  assert.match(s.baselineVerdict, /^Radar .+ · \d+\/100$/)
})

test('receipt: a Radar receipt is never accepted by the Token Scanner risk-receipt verifier', () => {
  assert.equal(verifyOutcomeReceipt(signed(), user), null)
  assert.equal(verifyOutcomeReceipt(JSON.stringify(signed()), user), null)
})

test('receipt: tampering with any frozen value invalidates it', () => {
  const r = signed()
  for (const patch of [{ priceUsd: 1 }, { radarScore: 99 }, { tokenAddress: `0x${'b'.repeat(40)}` }, { chain: 'robinhood' }, { marketCapUsd: 9e9 }, { radarFetchedAt: new Date(NOW).toISOString() }]) {
    const tampered = { ...r, evidence: { ...r.evidence, ...patch } }
    const res = verifyRadarTrackReceipt(tampered, user, NOW)
    assert.equal(res.ok, false, JSON.stringify(patch))
  }
  assert.equal(verifyRadarTrackReceipt({ ...r, signedAt: new Date(NOW - 1000).toISOString() }, user, NOW).ok, false)
  assert.equal(verifyRadarTrackReceipt({ ...r, sig: 'AAAA' }, user, NOW).ok, false)
})

test('receipt: bound to the signed-in user', () => {
  const res = verifyRadarTrackReceipt(signed(), other, NOW)
  assert.equal(res.ok, false)
})

test('receipt: expired receipts and stale evidence are refused (never frozen as click-time values)', () => {
  const oldSig = verifyRadarTrackReceipt(signed({}, NOW - RADAR_TRACK_RECEIPT_MAX_AGE_MS - 1, FETCHED), user, NOW)
  assert.deepEqual(oldSig.ok ? null : oldSig.code, 'expired')
  const staleFetch = new Date(NOW - RADAR_TRACK_EVIDENCE_MAX_AGE_MS - 1).toISOString()
  const oldEvidence = verifyRadarTrackReceipt(signed({}, NOW, staleFetch), user, NOW)
  assert.deepEqual(oldEvidence.ok ? null : oldEvidence.code, 'expired')
  const future = verifyRadarTrackReceipt(signed({}, NOW + 10 * 60_000), user, NOW)
  assert.equal(future.ok, false)
})

test('receipt: missing/garbage payloads fail closed with a refresh message', () => {
  for (const bad of [undefined, null, 'x', 42, {}, { v: 1 }, { v: 1, signedAt: 'x', sig: 'y', evidence: {} }]) {
    const res = verifyRadarTrackReceipt(bad, user, NOW)
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error, /Refresh Radar|not configured/)
  }
})

test('receipt: unconfigured signing secret is reported, not treated as a valid receipt', () => {
  const r = signed()
  const saved = process.env.TOKEN_OUTCOME_SIGNING_SECRET
  const savedService = process.env.SUPABASE_SERVICE_ROLE_KEY
  delete process.env.TOKEN_OUTCOME_SIGNING_SECRET
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  try {
    const res = verifyRadarTrackReceipt(r, user, NOW)
    assert.deepEqual(res.ok ? null : res.code, 'unconfigured')
    assert.equal(signRadarTrackEvidence(r.evidence, user, NOW), null)
  } finally {
    process.env.TOKEN_OUTCOME_SIGNING_SECRET = saved
    if (savedService !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedService
  }
})

test('idempotency: every Track click on the same chain + token maps to one scan id', () => {
  const a = verifyRadarTrackReceipt(signed({}, NOW - 120_000), user, NOW)
  const b = verifyRadarTrackReceipt(signed({ priceUsd: 0.002 }, NOW), user, NOW)
  assert.ok(a.ok && b.ok)
  if (!a.ok || !b.ok) return
  assert.equal(a.snapshot.scanId, b.snapshot.scanId)
  assert.equal(radarTrackScanId('base', ADDR), radarTrackScanId('base', ADDR.toLowerCase()))
  assert.notEqual(radarTrackScanId('base', ADDR), radarTrackScanId('robinhood', ADDR))
  assert.equal(trackedTokenKey('base', ADDR), trackedTokenKey('base', ADDR.toLowerCase()))
  assert.notEqual(trackedTokenKey('base', ADDR), trackedTokenKey('robinhood', ADDR))
})

test('radar response: receipts are per user, per response — the cached payload is never mutated', () => {
  const payload = { tokens: [radarToken(), radarToken({ contract: `0x${'1'.repeat(40)}` })], fetchedAt: FETCHED, stats: {} }
  const before = JSON.stringify(payload)
  const out = attachRadarTrackReceipts(payload, user, 'base', NOW)
  assert.equal(JSON.stringify(payload), before)
  assert.equal(out.tokens.length, 2)
  for (const t of out.tokens as unknown as Array<{ trackReceipt: RadarTrackReceipt }>) {
    assert.ok(t.trackReceipt)
    assert.equal(verifyRadarTrackReceipt(t.trackReceipt, user, NOW).ok, true)
    assert.equal(verifyRadarTrackReceipt(t.trackReceipt, other, NOW).ok, false)
  }
  assert.equal(attachRadarTrackReceipts(payload, null, 'base', NOW), payload)
})

test('radar response: Robinhood receipts carry the Robinhood chain identity', () => {
  const out = attachRadarTrackReceipts({ tokens: [radarToken({ chainSlug: 'robinhood' })], fetchedAt: FETCHED }, user, 'robinhood', NOW)
  const receipt = (out.tokens as unknown as Array<{ trackReceipt: RadarTrackReceipt }>)[0].trackReceipt
  const res = verifyRadarTrackReceipt(receipt, user, NOW)
  assert.ok(res.ok)
  if (res.ok) {
    assert.equal(res.snapshot.chain, 'robinhood')
    assert.equal(res.snapshot.scanId, `base_radar:robinhood:${ADDR.toLowerCase()}`)
  }
})

test('canonical bytes ignore unknown keys and are stable across JSON round-trips', () => {
  const e = buildRadarTrackEvidence(radarToken(), 'base', FETCHED)!
  const roundTrip = JSON.parse(JSON.stringify({ ...e, extra: 'ignored' }))
  assert.equal(canonicalRadarTrackEvidence(roundTrip), canonicalRadarTrackEvidence(e))
  const r = signed()
  const withExtra = JSON.parse(JSON.stringify({ ...r, evidence: { ...r.evidence, injected: true } }))
  assert.equal(verifyRadarTrackReceipt(withExtra, user, NOW).ok, true)
})

function radarRow(over: Partial<TrackedOutcome> = {}): TrackedOutcome {
  const res = verifyRadarTrackReceipt(signed(), user, NOW)
  assert.ok(res.ok)
  const snapshot = res.ok ? res.snapshot : (null as never)
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: user, chain: 'base', token_address: ADDR.toLowerCase(), scan_id: snapshot.scanId,
    tracked_at: new Date(NOW).toISOString(), baseline_price_usd: snapshot.baselinePriceUsd, baseline_liquidity_usd: snapshot.baselineLiquidityUsd,
    baseline_market_cap_usd: snapshot.baselineMarketCapUsd, baseline_risk_score: null, baseline_verdict: snapshot.baselineVerdict,
    baseline_snapshot_json: snapshot, current_price_usd: null, current_liquidity_usd: null, price_change_pct: null, liquidity_change_pct: null,
    outcome_status: 'watching', outcome_confidence: 'low', outcome_reasons_json: ['Waiting for the first market observation.'],
    last_checked_at: null, market_source: null, ...over,
  }
}

test('track view: Radar receipts present as radar evidence, scanner receipts unchanged', () => {
  const row = presentTrackedOutcome(radarRow(), NOW)
  assert.equal(row.baseline_risk_semantics, 'radar_evidence')
  const share = shareOutcome(row)
  assert.match(share, /Base Radar surfaced GOLDFISH at Radar \d+\/100/)
  assert.doesNotMatch(share, /risk/i)
  const scanner = presentTrackedOutcome(radarRow({ baseline_risk_score: 72, baseline_snapshot_json: { ...radarRow().baseline_snapshot_json, source: undefined, baselineRiskScore: 72 } }), NOW)
  assert.equal(scanner.baseline_risk_semantics, 'canonical')
})

test('track view: live observations never overwrite the frozen Radar baseline', () => {
  const original = radarRow()
  const proof = { version: 1 as const, chain: 'base', tokenAddress: ADDR.toLowerCase(), provider: 'dexscreener', fetchedAt: new Date(NOW + 60_000).toISOString(), priceUsd: 0.004, identityMatched: true as const, selectedPoolAddress: null, selectedBaseTokenAddress: ADDR.toLowerCase(), selectedQuoteTokenAddress: null }
  const live = { ...original, baseline_price_usd: 999, baseline_snapshot_json: { ...original.baseline_snapshot_json, baselinePriceUsd: 999 }, current_price_usd: 0.004, last_checked_at: new Date(NOW + 60_000).toISOString(), market_source: 'dexscreener', market_observation_json: proof }
  const merged = adoptNewerOutcomeObservation(original, live, NOW + 61_000)
  assert.equal(merged.baseline_price_usd, 0.00182)
  assert.equal(merged.baseline_snapshot_json.baselinePriceUsd, 0.00182)
  assert.equal(merged.current_price_usd, 0.004)
  assert.ok(merged.price_change_pct != null && merged.price_change_pct > 100)
})

test('track list: compact list rows keep the Radar source, score and label', () => {
  const row = hydrateTrackedOutcomeListRow({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', chain: 'base', token_address: ADDR.toLowerCase(), scan_id: 'base_radar:base:x', tracked_at: new Date(NOW).toISOString(),
    baseline_price_usd: 0.00182, baseline_liquidity_usd: 182_400, baseline_market_cap_usd: null, baseline_risk_score: null, baseline_verdict: 'Radar MODERATE · 47/100',
    current_price_usd: null, current_liquidity_usd: null, price_change_pct: null, liquidity_change_pct: null, outcome_status: 'watching', outcome_confidence: 'low',
    outcome_reasons_json: [], last_checked_at: null, market_source: null, after_evidence_json: null,
    tokenSymbol: 'GOLDFISH', tokenName: 'Gold Fish', scannedAt: FETCHED, snapshotVersion: 2, source: 'base_radar', radarScore: 47, radarLabel: 'MODERATE',
  }, NOW)
  assert.equal(row.baseline_risk_semantics, 'radar_evidence')
  assert.equal(row.baseline_snapshot_json.radarScore, 47)
  assert.equal(row.baseline_snapshot_json.radarLabel, 'MODERATE')
  const legacy = hydrateTrackedOutcomeListRow({ id: 'b', chain: 'base', token_address: ADDR, tracked_at: FETCHED, baseline_risk_score: 70, baseline_verdict: 'High', outcome_reasons_json: [], source: null }, NOW)
  assert.equal(legacy.baseline_risk_semantics, 'canonical')
  assert.equal(legacy.baseline_snapshot_json.source, undefined)
})

test('storage: pre-migration constraint errors are recognised as a schema gap', () => {
  assert.equal(isRadarReceiptSchemaError({ code: '23502', message: 'null value in column "baseline_risk_score" violates not-null constraint' }), true)
  assert.equal(isRadarReceiptSchemaError({ code: '23514', message: 'violates check constraint' }), true)
  assert.equal(isRadarReceiptSchemaError({ code: '08006', message: 'connection failure' }), false)
  assert.equal(isRadarReceiptSchemaError(null), false)
})

test('wiring: the Track route accepts Radar receipts through the same RPC; Radar signs after its cache', () => {
  const route = readFileSync(new URL('../app/api/token-outcomes/route.ts', import.meta.url), 'utf8')
  assert.match(route, /verifyRadarTrackReceipt\(body\.radarReceipt, user\.userId\)/)
  assert.equal((route.match(/rpc\('create_tracked_outcome'/g) ?? []).length, 1)
  const radar = readFileSync(new URL('../app/api/radar/route.ts', import.meta.url), 'utf8')
  assert.match(radar, /attachRadarTrackReceipts\(body, ctx\.userId, ctx\.chain\)/)
  assert.doesNotMatch(radar, /radarPayloadCache\.set\([^)]*trackReceipt/)
  const page = readFileSync(new URL('../app/terminal/base-radar/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /outcomeRequest\('POST', \{ radarReceipt: token\.trackReceipt \}\)/)
  assert.match(page, /trackInFlightRef\.current\.has\(key\)/)
})
