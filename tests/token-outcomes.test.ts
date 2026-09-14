import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { OUTCOME_POLICY, canTrackOutcome, hypothetical, classifyOutcome, shareOutcome, numberOrNull, type TrackedOutcome } from '../lib/tokenOutcomes'
import { snapshotFromScan, signOutcomeSnapshot, verifyOutcomeReceipt, withOutcomeReceipt } from '../lib/server/tokenOutcomeReceipt'
import { quoteMatches, resolveOutcomeQuote } from '../lib/server/tokenOutcomeService'
import { afterScanProof } from '../lib/tokenOutcomeProof'
import type { ClarkMarketQuote } from '../lib/server/clarkMarketData'

const user = '11111111-1111-4111-8111-111111111111'
const address = `0x${'a'.repeat(40)}`
function scan() { return {
  chain: 'base', contract: address, name: 'Test token', symbol: 'TEST', riskScore: 78,
  riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier', riskLabel: 'Critical Risk',
  priceUsd: 10, liquidityUsd: 50_000, marketCapUsd: null, fdvUsd: 999_999,
  scanRequestId: 'scan-original', scanRequestStartedAt: 1_789_345_000_000,
  riskBreakdown: { holders: ['Concentrated holders'] }, security: { source: 'fixture' },
  honeypot: { isHoneypot: false, simulationSuccess: true },
} }
process.env.TOKEN_OUTCOME_SIGNING_SECRET = 'outcomes-unit-test-secret-only'
test('threshold is inclusive at 50 and rejects missing, nonfinite and safety values', () => {
  for (const v of [0, 49.99, NaN, Infinity, undefined, null, '78', 101]) assert.equal(canTrackOutcome(v), false)
  for (const v of [50, 78, 100]) assert.equal(canTrackOutcome(v), true)
  assert.equal(snapshotFromScan({ ...scan(), riskScoreType: 'safety_score' }, user), null)
})
test('snapshot is a deep frozen-in-time copy, never FDV as market cap', () => {
  const original = scan(); const s = snapshotFromScan(original, user)!
  original.riskBreakdown.holders[0] = 'Changed by next scan'; original.riskScore = 20
  assert.equal(s.baselineRiskScore, 78)
  assert.deepEqual(s.baselineRiskReasons, { holders: ['Concentrated holders'] })
  assert.equal(s.baselineMarketCapUsd, null)
  assert.equal(s.scanId, 'scan-original')
  assert.deepEqual((s.baselineSecuritySignals as Record<string, unknown>).honeypot, { isHoneypot: false, simulationSuccess: true })
})
test('receipt preserves duplicate identity and rejects another user or tampered snapshot', () => {
  const s = snapshotFromScan(scan(), user)!
  const receipt = signOutcomeSnapshot(s)!
  assert.deepEqual(verifyOutcomeReceipt(receipt, user), s)
  assert.equal(verifyOutcomeReceipt(receipt, 'another-user'), null)
  assert.equal(verifyOutcomeReceipt(`${receipt}x`, user), null)
  const changedPayload = Buffer.from(JSON.stringify({ version: 1, snapshot: { ...s, baselineRiskScore: 99 } })).toString('base64url')
  assert.equal(verifyOutcomeReceipt(`${changedPayload}.${receipt.split('.')[1]}`, user), null)
  assert.equal(verifyOutcomeReceipt(receipt, user)?.scanId, verifyOutcomeReceipt(signOutcomeSnapshot(s), user)?.scanId)
})
test('adding receipt changes no existing scanner output and never mutates input/cache', () => {
  const original = scan(); const before = structuredClone(original)
  const result = withOutcomeReceipt(original, user)
  const { outcomeReceipt, ...rest } = result
  assert.ok(outcomeReceipt); assert.deepEqual(rest, before); assert.deepEqual(original, before)
})
test('hypothetical positive PnL is deterministic', () => {
  assert.deepEqual(hypothetical(10, 15), { value: 1500, pnl: 500, potentialLossAvoided: 0 })
})
test('hypothetical loss and loss avoided are explicitly hypothetical', () => {
  const result = hypothetical(10, 1.36)!
  assert.ok(Math.abs(result.value - 136) < 1e-8)
  assert.ok(Math.abs(result.pnl + 864) < 1e-8)
  assert.ok(Math.abs(result.potentialLossAvoided - 864) < 1e-8)
})
test('missing, zero, negative and nonfinite prices never produce hypothetical returns', () => {
  for (const value of [null, 0, -1, NaN, Infinity]) { assert.equal(hypothetical(value, 1), null); assert.equal(hypothetical(1, value), null) }
  assert.equal(numberOrNull(null), null); assert.equal(numberOrNull(''), null); assert.equal(numberOrNull(false), null)
  assert.equal(numberOrNull('0'), 0)
})
test('90% price dump does not automatically classify a rug', () => {
  assert.equal(classifyOutcome({ price: 100, liquidity: 100_000 }, { price: 10, liquidity: null }).status, 'dumped')
  assert.equal(classifyOutcome({ price: 100, liquidity: 100_000 }, { price: 10, liquidity: 0 }).status, 'dumped')
})
test('strong verified drain, sell-block or comparable collapse plus dead-pool evidence can classify rug', () => {
  for (const proof of [{ verifiedDeployerDrain: true }, { verifiedTradingBlocked: true }, { comparableLiquidity: true, verifiedPoolDead: true }]) {
    const result = classifyOutcome({ price: 100, liquidity: 100_000 }, { price: 10, liquidity: 100, ...proof })
    assert.equal(result.status, 'rugged'); assert.equal(result.confidence, 'high'); assert.ok(result.reasons.length)
  }
})
test('classifier fails closed on gaps, incomparable or tiny liquidity', () => {
  assert.equal(classifyOutcome({ price: null, liquidity: null }, { price: 1, liquidity: 0 }).status, 'unavailable')
  assert.equal(classifyOutcome({ price: 1, liquidity: 10 }, { price: 1, liquidity: 0, comparableLiquidity: true, verifiedPoolDead: true }).status, 'watching')
  assert.equal(classifyOutcome({ price: 1, liquidity: null }, { price: 2, liquidity: null }).status, 'pumped')
})
test('wrong chain/address cache is rejected and Solana address casing is preserved', () => {
  const quote = { chain: 'ethereum', address } as ClarkMarketQuote
  assert.equal(quoteMatches(quote, 'base', address), false)
  assert.equal(quoteMatches(quote, 'eth', address), true)
  assert.equal(quoteMatches({ ...quote, chain: 'solana', address: 'AbCd' }, 'solana', 'abcd'), false)
})
test('market refresh rejects wrong-chain quotes, falls back, caches successes and retries misses', async () => {
  let dexCalls = 0; let geckoCalls = 0
  const token = `0x${'b'.repeat(40)}`
  const quote: ClarkMarketQuote = { provider: 'geckoterminal', name: 'Fixture', symbol: 'FX', chain: 'base', chainId: 8453, address: token, priceUsd: 2, liquidityUsd: 5000, marketCapUsd: null, fdvUsd: null, volume24hUsd: null, change24hPct: null, fetchedAt: Date.now() }
  const providers = {
    dex: async () => { dexCalls++; return { quote: { ...quote, chain: 'eth' }, matches: [{ ...quote, chain: 'eth' }] } },
    gecko: async () => { geckoCalls++; return quote },
  }
  assert.equal((await resolveOutcomeQuote('base', token, providers))?.priceUsd, 2)
  assert.equal((await resolveOutcomeQuote('base', token, providers))?.priceUsd, 2)
  assert.equal(dexCalls, 1); assert.equal(geckoCalls, 1)
  let failures = 0
  const missing = { dex: async () => { failures++; return null }, gecko: async () => null }
  await resolveOutcomeQuote('base', `0x${'c'.repeat(40)}`, missing)
  await resolveOutcomeQuote('base', `0x${'c'.repeat(40)}`, missing)
  assert.equal(failures, 2)
})
test('only fresh later chain-matched confirmed sell-block evidence can corroborate a rug', () => {
  const now = Date.now()
  const row = { chain: 'base', token_address: address, tracked_at: new Date(now - 20_000).toISOString(), scan_id: 'original', baseline_snapshot_json: snapshotFromScan(scan(), user)! } as TrackedOutcome
  const later = { chain: 'base', contract: address, scanRequestStartedAt: now - 5000, scanRequestId: 'later', honeypot: { isHoneypot: true, honeypotStatus: 'confirmed', finalStatus: 'risk_detected' } }
  assert.equal(afterScanProof(row, later, now)?.verifiedTradingBlocked, true)
  assert.equal(afterScanProof(row, { ...later, chain: 'eth' }, now), null)
  assert.equal(afterScanProof(row, { ...later, scanRequestStartedAt: now - 25_000 }, now), null)
  assert.equal(afterScanProof(row, { ...later, honeypot: { isHoneypot: null, finalStatus: 'provider_unavailable' } }, now), null)
  const priorBlocked = structuredClone(row)
  priorBlocked.baseline_snapshot_json.baselineSecuritySignals = { honeypot: { isHoneypot: true, simulationSuccess: false } }
  assert.equal(afterScanProof(priorBlocked, later, now), null)
})
test('share text uses frozen score and current math without exposing receipt, account or private link', () => {
  const row = { baseline_snapshot_json: snapshotFromScan(scan(), user)!, baseline_price_usd: 10, current_price_usd: 1 } as TrackedOutcome
  const text = shareOutcome(row)
  assert.match(text, /78\/100/); assert.match(text, /-90\.0%/); assert.match(text, /\$100\.00/)
  assert.doesNotMatch(text, /saved|11111111|\/terminal\/track|user_id/)
})
test('outcome storage remains separate from Watchlist; UI wiring preserves existing action', () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const service = read('lib/server/tokenOutcomeService.ts') + read('app/api/token-outcomes/route.ts')
  assert.doesNotMatch(service, /from\(['"]watchlist/)
  assert.match(read('app/terminal/token-scanner/page.tsx'), /onClick=\{saveTrackedToken\}/)
  assert.match(read('app/terminal/token-scanner/page.tsx'), /outcomeReceipt: json.outcomeReceipt/)
  assert.match(read('components/outcomes/OutcomeCard.tsx'), /showModal\(\)/)
  assert.match(read('components/outcomes/OutcomeCard.tsx'), /onCancel=\{onClose\}/)
  assert.ok(OUTCOME_POLICY.limits.free < OUTCOME_POLICY.limits.pro && OUTCOME_POLICY.limits.pro < OUTCOME_POLICY.limits.elite)
})
