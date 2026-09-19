import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { OUTCOME_POLICY, canTrackOutcome, displayableCurrentPrice, hypothetical, classifyOutcome, shareOutcome, numberOrNull, percentChange, parsePositiveUsd, validPriceOrNull, type TrackedOutcome } from '../lib/tokenOutcomes'
import { snapshotFromScan, signOutcomeSnapshot, verifyOutcomeReceipt, withOutcomeReceipt } from '../lib/server/tokenOutcomeReceipt'
import { buildOutcomeRefreshUpdate, hydrateTrackedOutcomeListRow, isMissingOutcomeColumnError, isMissingOutcomeTableError, listTrackedOutcomes, omitOptionalObservationColumn, persistOutcomeRefreshUpdate, quoteIsFreshForOutcome, quoteMatches, resolveOutcomeQuote, resolveOutcomeQuoteDetailed, sanitizeOutcomeStorageError, sanitizeTrackedOutcome } from '../lib/server/tokenOutcomeService'
import { afterScanProof } from '../lib/tokenOutcomeProof'
import type { ClarkMarketQuote } from '../lib/server/clarkMarketData'
import { dexScreenerOutcomeMarketProvider, geckoTerminalMarketProvider } from '../lib/server/clarkMarketDataProviders'
import { __resetMemoryFallbackForTest } from '../lib/server/cache/tokenCache'

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
test('percent math uses unrounded positive prices', () => {
  assert.equal(percentChange(1, 0.75), -25)
  assert.equal(percentChange(1, 1.25), 25)
  assert.ok(Math.abs(percentChange(0.0005, 0.00075)! - 50) < 1e-12)
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
test('new receipts version canonical risk direction and legacy Solana receipts fail closed', () => {
  const current = snapshotFromScan(scan(), user)!
  assert.equal(current.snapshotVersion, 2); assert.equal(current.riskScoreDirection, 'higher_is_riskier')
  const legacy = { ...current } as Record<string, unknown>; delete legacy.snapshotVersion; delete legacy.riskScoreDirection; legacy.chain = 'solana'; legacy.tokenAddress = '52qkNpgTHcjuDYhKVcg6rJS4uYYtJHpDRcJoSdKqpump'
  const payload = Buffer.from(JSON.stringify({ version: 1, snapshot: legacy })).toString('base64url')
  const receipt = `${payload}.${createHmac('sha256', process.env.TOKEN_OUTCOME_SIGNING_SECRET!).update(payload).digest('base64url')}`
  assert.equal(verifyOutcomeReceipt(receipt, user), null)
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
  assert.equal(validPriceOrNull('0'), null)
  assert.equal(percentChange(10, 0), null)
})
test('failed or null current price cannot produce a -100% outcome or hypothetical loss', () => {
  for (const current of [null, 0, NaN]) {
    const row = sanitizeTrackedOutcome({ ...outcomeRow(), current_price_usd: current, price_change_pct: -100, outcome_status: 'dumped' })
    assert.equal(row.current_price_usd, null)
    assert.equal(row.price_change_pct, null)
    assert.equal(row.outcome_status, 'unavailable')
    assert.equal(hypothetical(row.baseline_price_usd, row.current_price_usd), null)
  }
})
test('a valid 90% decline remains a real -90% dumped outcome', () => {
  const row = sanitizeTrackedOutcome(withObservation({ ...outcomeRow(), current_price_usd: 1, price_change_pct: null }, 1))
  assert.ok(Math.abs(row.price_change_pct! + 90) < 1e-8)
  assert.equal(row.outcome_status, 'dumped')
  assert.deepEqual(hypothetical(row.baseline_price_usd, row.current_price_usd), { value: 100, pnl: -900, potentialLossAvoided: 900 })
})
test('true economic zero needs independent positive evidence and is never a rug by price alone', () => {
  assert.equal(classifyOutcome({ price: 10, liquidity: 20_000 }, { price: null, liquidity: null }).status, 'unavailable')
  assert.equal(classifyOutcome({ price: 10, liquidity: 20_000 }, { price: null, liquidity: null, verifiedEconomicZero: true }).status, 'dumped')
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
  const quote = { chain: 'ethereum', address, marketIdentity: { selectedPoolAddress: null, baseTokenAddress: address, quoteTokenAddress: null } } as ClarkMarketQuote
  assert.equal(quoteMatches(quote, 'base', address), false)
  assert.equal(quoteMatches(quote, 'eth', address), true)
  assert.equal(quoteMatches({ ...quote, chain: 'solana', address: 'AbCd' }, 'solana', 'abcd'), false)
  assert.equal(quoteMatches({ ...quote, chain: 'base', chainId: 1 }, 'base', address), false)
})
test('same KAI symbol on another chain or contract can never satisfy outcome identity', async () => {
  const baseKai = `0x${'c'.repeat(40)}`
  const otherKai = `0x${'d'.repeat(40)}`
  const q = (chain: string, tokenAddress: string): ClarkMarketQuote => ({ provider: 'dexscreener', name: 'Kai', symbol: 'KAI', chain, chainId: chain === 'base' ? 8453 : 1, address: tokenAddress, priceUsd: 2, liquidityUsd: 1000, marketCapUsd: null, fdvUsd: null, volume24hUsd: null, change24hPct: null, fetchedAt: Date.now() })
  const providers = { dex: async () => ({ quote: q('eth', otherKai), matches: [q('eth', otherKai), q('base', otherKai)] }), gecko: async () => null }
  assert.equal(await resolveOutcomeQuote('base', baseKai, providers), null)
})
test('DexScreener outcome provider selects only exact chain plus canonical contract', async () => {
  const requested = `0x${'1'.repeat(40)}`
  const wrong = `0x${'2'.repeat(40)}`
  const pair = (chainId: string, tokenAddress: string, liquidity: number) => ({
    chainId, priceUsd: '3', liquidity: { usd: liquidity }, baseToken: { address: tokenAddress, symbol: 'KAI', name: 'Kai' },
    priceChange: { h24: 1 }, volume: { h24: 100 }, marketCap: 1000, fdv: 1200,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ pairs: [pair('ethereum', requested, 1_000_000), pair('base', wrong, 500_000), pair('base', requested.toUpperCase(), 100)] }), { status: 200 })
  try {
    const result = await dexScreenerOutcomeMarketProvider(requested, 'base')
    assert.equal(result?.quote.chain, 'base')
    assert.equal(result?.quote.address?.toLowerCase(), requested)
  } finally { globalThis.fetch = originalFetch }
})
test('malformed provider zero is unresolved and failed refresh retains a prior valid observation', async () => {
  const row: TrackedOutcome = withObservation({ ...outcomeRow(), current_price_usd: 4, price_change_pct: -60, outcome_status: 'dumped', market_source: 'dexscreener', last_checked_at: '2026-09-14T00:00:00.000Z' }, 4)
  const malformed = marketQuote(row.token_address, 0)
  const providers = { dex: async () => ({ quote: malformed, matches: [malformed] }), gecko: async () => null }
  assert.equal(await resolveOutcomeQuote('base', row.token_address, providers), null)
  const update = buildOutcomeRefreshUpdate(row, null, null, '2026-09-14T01:00:00.000Z')
  assert.equal(update.current_price_usd, 4)
  assert.equal(update.price_change_pct, -60)
  assert.equal(update.outcome_status, 'dumped')
  assert.equal(update.market_source, 'dexscreener')
  assert.equal(update.last_checked_at, row.last_checked_at)
})
test('market refresh rejects wrong-chain quotes, falls back, caches successes and retries misses', async () => {
  let dexCalls = 0; let geckoCalls = 0
  const token = `0x${'b'.repeat(40)}`
  const quote: ClarkMarketQuote = { ...marketQuote(token, 2), provider: 'geckoterminal', name: 'Fixture', symbol: 'FX' }
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
test('provider timeout or 429-style throw falls back without accepting malformed or empty rows', async () => {
  const token = `0x${'9'.repeat(40)}`, valid = { ...marketQuote(token, 3), provider: 'geckoterminal' as const }
  const timeout = { dex: async () => { throw new Error('timeout') }, gecko: async () => valid }
  assert.equal((await resolveOutcomeQuote('base', token, timeout, { force: true }))?.priceUsd, 3)
  const empty = { dex: async () => ({ quote: marketQuote(token, 0), matches: [marketQuote(token, 0)] }), gecko: async () => null }
  assert.equal(await resolveOutcomeQuote('base', token, empty, { force: true }), null)
})
test('legacy nonzero observations without exact identity proof are pending until refreshed', () => {
  const row = sanitizeTrackedOutcome({ ...outcomeRow(), current_price_usd: 7, market_source: 'dexscreener', price_change_pct: -30 })
  assert.equal(row.current_price_usd, null); assert.equal(row.price_change_pct, null); assert.equal(row.outcome_status, 'unavailable')
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
  const row = withObservation({ ...outcomeRow(), baseline_snapshot_json: snapshotFromScan(scan(), user)!, baseline_price_usd: 10, current_price_usd: 1 }, 1)
  const text = shareOutcome(row)
  assert.match(text, /78\/100/); assert.match(text, /-90\.0%/); assert.match(text, /\$100\.00/)
  assert.doesNotMatch(text, /saved|11111111|\/terminal\/track|user_id/)
})
test('outcome UI renders pending copy and never coerces missing price into loss copy', () => {
  const source = readFileSync(new URL('../components/outcomes/OutcomeCard.tsx', import.meta.url), 'utf8')
  assert.match(source, /Current price unavailable — Outcome pending/)
  assert.match(source, /Outcome pending/)
  assert.match(source, /h \? money\(h\.pnl\) : 'Unavailable'/)
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

function outcomeRow(): TrackedOutcome {
  const snapshot = snapshotFromScan(scan(), user)!
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: user, chain: 'base', token_address: address,
    scan_id: snapshot.scanId, tracked_at: snapshot.scannedAt, baseline_price_usd: 10, baseline_liquidity_usd: 50_000,
    baseline_market_cap_usd: null, baseline_risk_score: 78, baseline_verdict: 'Critical Risk', baseline_snapshot_json: snapshot,
    current_price_usd: null, current_liquidity_usd: null, price_change_pct: null, liquidity_change_pct: null,
    outcome_status: 'watching', outcome_confidence: 'low', outcome_reasons_json: [], last_checked_at: null, market_source: null,
  }
}
function marketQuote(tokenAddress: string, priceUsd: number | null): ClarkMarketQuote {
  return { provider: 'dexscreener', name: 'Test token', symbol: 'TEST', chain: 'base', chainId: 8453, address: tokenAddress,
    priceUsd, liquidityUsd: 5000, marketCapUsd: null, fdvUsd: null, volume24hUsd: null, change24hPct: null, fetchedAt: Date.now(),
    marketIdentity: { selectedPoolAddress: 'pool', baseTokenAddress: tokenAddress, quoteTokenAddress: null } }
}
function withObservation<T extends TrackedOutcome>(row: T, price: number): T {
  return { ...row, market_source: row.market_source ?? 'dexscreener', market_observation_json: { version: 1, chain: row.chain,
    tokenAddress: row.token_address, provider: row.market_source ?? 'dexscreener', fetchedAt: row.last_checked_at ?? new Date().toISOString(),
    priceUsd: price, identityMatched: true, selectedPoolAddress: 'pool', selectedBaseTokenAddress: row.token_address, selectedQuoteTokenAddress: null } }
}

test('1. baseline 1 → current 0.75 is -25%, never -100%', () => {
  assert.equal(percentChange(1, 0.75), -25)
  const row = sanitizeTrackedOutcome(withObservation({ ...outcomeRow(), baseline_price_usd: 1, current_price_usd: 0.75, last_checked_at: new Date().toISOString(), market_source: 'dexscreener' }, 0.75))
  assert.equal(row.price_change_pct, -25)
  assert.equal(row.outcome_status, 'watching')
  assert.notEqual(row.price_change_pct, -100)
})

test('2. current 0 is rejected as unknown, not an economic zero', () => {
  assert.equal(parsePositiveUsd(0), null)
  assert.equal(validPriceOrNull(0), null)
  assert.equal(percentChange(1, 0), null)
  const row = sanitizeTrackedOutcome({ ...outcomeRow(), baseline_price_usd: 1, current_price_usd: 0, price_change_pct: -100, outcome_status: 'dumped' })
  assert.equal(row.current_price_usd, null)
  assert.equal(row.price_change_pct, null)
  assert.equal(row.outcome_status, 'unavailable')
})

test('3. missing current price is pending, not -100 dumped', () => {
  for (const current of [null, undefined, NaN, Number.POSITIVE_INFINITY]) {
    const row = sanitizeTrackedOutcome({ ...outcomeRow(), baseline_price_usd: 1, current_price_usd: current as number, price_change_pct: -100, outcome_status: 'dumped' })
    assert.equal(row.price_change_pct, null)
    assert.equal(row.outcome_status, 'unavailable')
    assert.deepEqual(row.outcome_reasons_json, ['Current price unavailable — Outcome pending'])
    assert.equal(hypothetical(1, row.current_price_usd), null)
  }
})

test('4. DexScreener result for the wrong contract is rejected', async () => {
  const requested = `0x${'1'.repeat(40)}`
  const wrong = `0x${'2'.repeat(40)}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    pairs: [{ chainId: 'base', priceUsd: '0.75', liquidity: { usd: 1_000_000 }, baseToken: { address: wrong, symbol: 'KAI', name: 'Kai' } }],
  }), { status: 200 })
  try {
    const result = await dexScreenerOutcomeMarketProvider(requested, 'base')
    assert.equal(result, null)
    const providers = { dex: async () => ({ quote: marketQuote(wrong, 0.75), matches: [marketQuote(wrong, 0.75)] }), gecko: async () => null }
    assert.equal(await resolveOutcomeQuote('base', requested, providers), null)
  } finally { globalThis.fetch = originalFetch }
})

test('5. Solana quote for the wrong mint is rejected even when the ticker matches', async () => {
  const paidDoge = '52qkNpgTHcjuDYhKVcg6rJS4uYYtJHpDRcJoSdKqpump'
  const otherMint = '51qkNpgTHcjuDYhKVcg6rJS4uYYtJHpDRcJoSdKqpump'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('dexscreener')) {
      return new Response(JSON.stringify({
        pairs: [{ chainId: 'solana', priceUsd: '0.00066', liquidity: { usd: 80_000 }, baseToken: { address: otherMint, symbol: 'PAIDDOGE', name: 'Paid Doge' } }],
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      data: { id: `solana_${otherMint}`, attributes: { address: otherMint, symbol: 'PAIDDOGE', name: 'Paid Doge', price_usd: '0.00066' } },
    }), { status: 200 })
  }
  try {
    assert.equal(await dexScreenerOutcomeMarketProvider(paidDoge, 'solana'), null)
    assert.equal(await geckoTerminalMarketProvider(paidDoge, 'solana'), null)
    const wrongQuote: ClarkMarketQuote = { ...marketQuote(otherMint, 0.00066), chain: 'solana', chainId: null, address: otherMint }
    assert.equal(quoteMatches(wrongQuote, 'solana', paidDoge), false)
    const providers = { dex: async () => ({ quote: wrongQuote, matches: [wrongQuote] }), gecko: async () => wrongQuote }
    assert.equal(await resolveOutcomeQuote('solana', paidDoge, providers), null)
  } finally { globalThis.fetch = originalFetch }
})

test('6. a valid cached observation is reused only while fresh', async () => {
  __resetMemoryFallbackForTest()
  const token = `0x${'c'.repeat(40)}`
  let calls = 0
  const quote = marketQuote(token, 0.8)
  const providers = { dex: async () => { calls += 1; return { quote, matches: [quote] } }, gecko: async () => null }
  assert.equal((await resolveOutcomeQuote('base', token, providers))?.priceUsd, 0.8)
  assert.equal((await resolveOutcomeQuote('base', token, providers))?.priceUsd, 0.8)
  assert.equal(calls, 1)
  const stale = { ...quote, fetchedAt: Date.now() - OUTCOME_POLICY.priceStaleMs - 1 }
  const staleProviders = { dex: async () => { calls += 1; return { quote: stale, matches: [stale] } }, gecko: async () => null }
  __resetMemoryFallbackForTest()
  assert.equal(await resolveOutcomeQuote('base', token, staleProviders), null)
  assert.equal(calls, 2)
})

test('7. stale invalid -100 observation is rejected on read', () => {
  const now = Date.now()
  const stale = new Date(now - 20 * 60_000).toISOString()
  const row = sanitizeTrackedOutcome({
    ...outcomeRow(), baseline_price_usd: 1, current_price_usd: 1e-12, price_change_pct: -100,
    outcome_status: 'dumped', last_checked_at: stale, market_source: 'dexscreener',
  }, now)
  assert.equal(row.current_price_usd, null)
  assert.equal(row.price_change_pct, null)
  assert.equal(row.outcome_status, 'unavailable')
  assert.deepEqual(row.outcome_reasons_json, ['Current price unavailable — Outcome pending'])
})

test('8. a newer valid observation beats an older invalid one', () => {
  const now = Date.now()
  const row: TrackedOutcome = {
    ...outcomeRow(), baseline_price_usd: 1, current_price_usd: 1e-12, price_change_pct: -100,
    outcome_status: 'dumped', market_source: 'dexscreener', last_checked_at: new Date(now - 20 * 60_000).toISOString(),
  }
  const update = buildOutcomeRefreshUpdate(row, marketQuote(row.token_address, 0.75), null, new Date(now).toISOString(), now)
  assert.equal(update.current_price_usd, 0.75)
  assert.equal(update.price_change_pct, -25)
  assert.equal(update.outcome_status, 'watching')
  assert.equal(update.market_source, 'dexscreener')
})

test('9. manual refresh wiring force-updates visible receipts', () => {
  const page = readFileSync(new URL('../app/terminal/track/page.tsx', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../app/api/token-outcomes/route.ts', import.meta.url), 'utf8')
  const service = readFileSync(new URL('../lib/server/tokenOutcomeService.ts', import.meta.url), 'utf8')
  assert.match(page, /force \? \{ ids: visibleIds.current \} : \{\}/)
  assert.match(page, /refreshAction.current\?\.\(true\)/)
  assert.match(route, /force: body.force === true/)
  assert.match(service, /force: opts.force === true/)
})

test('10. page-load refresh updates stale tracked receipts without polling', () => {
  const page = readFileSync(new URL('../app/terminal/track/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /load\(false, version\)\.then\(loaded => \{ if \(loaded && !disposed && version === generation\) return load\(true, version, false\) \}\)/)
  assert.doesNotMatch(page, /setInterval/)
  const service = readFileSync(new URL('../lib/server/tokenOutcomeService.ts', import.meta.url), 'utf8')
  assert.match(service, /priceStaleMs/)
  assert.match(service, /last_checked_at\.lt\.\$\{stale\}/)
})

test('11. KAI-like quote-token pair cannot produce -100% when the priced KAI pair is -25%', async () => {
  const kai = `0x${'c'.repeat(40)}`
  const kdiem = `0x${'d'.repeat(40)}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    pairs: [
      { chainId: 'base', priceUsd: 2820.76, liquidity: { usd: 342_254 }, baseToken: { address: kdiem, symbol: 'kDIEM', name: 'kDIEM' }, quoteToken: { address: kai, symbol: 'KAI' } },
      { chainId: 'base', priceUsd: '0.75', liquidity: { usd: 55_000 }, baseToken: { address: kai, symbol: 'KAI', name: 'Kairence' }, quoteToken: { address: `0x${'e'.repeat(40)}`, symbol: 'USDC' } },
      { chainId: 'robinhood', priceUsd: '0.71', liquidity: { usd: 74_000 }, baseToken: { address: kai, symbol: 'KAI', name: 'Kairence' } },
    ],
  }), { status: 200 })
  try {
    const result = await dexScreenerOutcomeMarketProvider(kai, 'base')
    assert.equal(result?.quote.priceUsd, 0.75)
    assert.equal(result?.quote.address?.toLowerCase(), kai)
    const row = sanitizeTrackedOutcome(withObservation({
      ...outcomeRow(), token_address: kai, baseline_price_usd: 1, current_price_usd: 0.75,
      last_checked_at: new Date().toISOString(), market_source: 'dexscreener',
    }, 0.75))
    assert.equal(percentChange(1, result!.quote.priceUsd), -25)
    assert.equal(row.price_change_pct, -25)
    assert.notEqual(row.outcome_status, 'dumped')
  } finally { globalThis.fetch = originalFetch }
})

test('12. Solana receipt does not stick at 0% when a fresh valid price exists', async () => {
  __resetMemoryFallbackForTest()
  const mint = '52qkNpgTHcjuDYhKVcg6rJS4uYYtJHpDRcJoSdKqpump'
  const live: ClarkMarketQuote = {
    provider: 'dexscreener', name: 'Paid Doge', symbol: 'PAIDDOGE', chain: 'solana', chainId: null, address: mint,
    priceUsd: 0.00075, liquidityUsd: 70_000, marketCapUsd: null, fdvUsd: null, volume24hUsd: null, change24hPct: null, fetchedAt: Date.now(),
    marketIdentity: { selectedPoolAddress: 'pool', baseTokenAddress: mint, quoteTokenAddress: null },
  }
  const providers = { dex: async () => ({ quote: live, matches: [live] }), gecko: async () => null }
  const quote = await resolveOutcomeQuote('solana', mint, providers, { force: true })
  assert.equal(quote?.priceUsd, 0.00075)
  const stuck: TrackedOutcome = {
    ...outcomeRow(), chain: 'solana', token_address: mint, baseline_price_usd: 0.00075, current_price_usd: 0.00075,
    price_change_pct: 0, outcome_status: 'watching', last_checked_at: new Date(Date.now() - 20 * 60_000).toISOString(), market_source: 'dexscreener',
  }
  const moved: ClarkMarketQuote = { ...live, priceUsd: 0.001 }
  const update = buildOutcomeRefreshUpdate(stuck, moved, null)
  assert.ok(Math.abs((update.price_change_pct ?? 0) - ((0.001 - 0.00075) / 0.00075) * 100) < 1e-8)
  assert.notEqual(update.price_change_pct, 0)
})

test('fresh genuinely sourced dust may still display as -100% dumped, missing price never does', () => {
  const now = Date.now()
  const genuine = sanitizeTrackedOutcome(withObservation({
    ...outcomeRow(), baseline_price_usd: 1, current_price_usd: 1e-12, price_change_pct: -100,
    outcome_status: 'dumped', last_checked_at: new Date(now).toISOString(), market_source: 'dexscreener',
  }, 1e-12), now)
  assert.ok((genuine.price_change_pct ?? 0) <= -99.95)
  assert.equal(genuine.outcome_status, 'dumped')
  assert.equal(displayableCurrentPrice({ baseline_price_usd: 1, current_price_usd: 1e-12, last_checked_at: new Date(now - 20 * 60_000).toISOString(), market_source: 'dexscreener' }, now), null)
  assert.equal(classifyOutcome({ price: 1, liquidity: 20_000 }, { price: null, liquidity: null }).status, 'unavailable')
})

test('failed refresh does not retain a stale -100 dust tick', () => {
  const now = Date.now()
  const row: TrackedOutcome = {
    ...outcomeRow(), baseline_price_usd: 1, current_price_usd: 1e-12, price_change_pct: -100,
    outcome_status: 'dumped', market_source: 'dexscreener', last_checked_at: new Date(now - 20 * 60_000).toISOString(),
  }
  const update = buildOutcomeRefreshUpdate(row, null, null, new Date(now).toISOString(), now)
  assert.equal(update.current_price_usd, null)
  assert.equal(update.price_change_pct, null)
  assert.equal(update.outcome_status, 'unavailable')
})

const PAID_DOGE_MINT = '52qkNpgTHcjuDYhKVcg6rJS4uYYtJHpDRcJoSdKqpump'
const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const PAID_DOGE_PUMPSWAP = 'Bs7Ad8EhZb4NjfcsnewodG2yULXrvdNpLU4wgKJJ2sqj'
function paidDogeQuote(priceUsd: number, fetchedAt: number): ClarkMarketQuote {
  return {
    provider: 'dexscreener', name: 'Paid Doge', symbol: 'PAIDDOGE', chain: 'solana', chainId: null,
    address: PAID_DOGE_MINT, priceUsd, liquidityUsd: 83_000, marketCapUsd: null, fdvUsd: null,
    volume24hUsd: null, change24hPct: null, fetchedAt,
    marketIdentity: { selectedPoolAddress: PAID_DOGE_PUMPSWAP, baseTokenAddress: PAID_DOGE_MINT, quoteTokenAddress: WSOL_MINT },
  }
}
function paidDogeRow(now: number, current = 0.0005, pct: number | null = 0): TrackedOutcome {
  return withObservation({
    ...outcomeRow(), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', chain: 'solana', token_address: PAID_DOGE_MINT,
    baseline_price_usd: 0.0005, current_price_usd: current, price_change_pct: pct, outcome_status: 'watching',
    last_checked_at: new Date(now - 60_000).toISOString(), market_source: 'dexscreener',
  }, current)
}

test('solana 1. baseline 0.0005 to live 0.00075 is +50% even when Dex stamps fetchedAt after frozen now', async () => {
  __resetMemoryFallbackForTest()
  const now = 1_800_000_000_000
  const live = paidDogeQuote(0.00075, now + 25)
  assert.equal(quoteIsFreshForOutcome(live, now), true)
  assert.equal(quoteIsFreshForOutcome({ fetchedAt: now - OUTCOME_POLICY.priceStaleMs - 1 }, now), false)
  assert.equal(quoteIsFreshForOutcome({ fetchedAt: now + 61_000 }, now), false)
  const providers = {
    dex: async () => ({
      quote: live, matches: [live],
      candidatePairs: [{ priceUsd: 0.00075, pairAddress: PAID_DOGE_PUMPSWAP, baseMint: PAID_DOGE_MINT, quoteMint: WSOL_MINT, dexId: 'pumpswap' }],
    }),
    gecko: async () => null,
  }
  const detailed = await resolveOutcomeQuoteDetailed('solana', PAID_DOGE_MINT, providers, { force: true, now })
  assert.equal(detailed.quote?.priceUsd, 0.00075)
  assert.equal(detailed.cacheHit, false)
  assert.equal(detailed.fetchAttempted, true)
  assert.equal(detailed.identityMatched, true)
  assert.equal(detailed.selectedBaseMint, PAID_DOGE_MINT)
  assert.equal(detailed.selectedQuoteMint, WSOL_MINT)
  assert.equal(detailed.selectedPairOrPool, PAID_DOGE_PUMPSWAP)
  assert.equal(detailed.fetchedCurrentPrice, 0.00075)
  assert.equal(detailed.rejectionReason, null)
  const update = buildOutcomeRefreshUpdate(paidDogeRow(now), detailed.quote, null, new Date(now).toISOString(), now)
  assert.equal(update.current_price_usd, 0.00075)
  assert.equal(update.price_change_pct, 50)
  assert.equal(percentChange(0.0005, 0.00075), 50)
  const shown = sanitizeTrackedOutcome(withObservation({
    ...paidDogeRow(now), current_price_usd: 0.00075, price_change_pct: 50,
    last_checked_at: new Date(now).toISOString(), market_source: 'dexscreener',
  }, 0.00075), now)
  assert.equal(shown.price_change_pct, 50)
  assert.notEqual(shown.price_change_pct, 0)
})

test('solana 2. forced refresh bypasses the 3-minute outcome price cache', async () => {
  __resetMemoryFallbackForTest()
  const now = Date.now()
  let calls = 0
  const first = paidDogeQuote(0.0005, now)
  const second = paidDogeQuote(0.00075, now + 10)
  const providers = {
    dex: async () => {
      calls += 1
      const quote = calls === 1 ? first : second
      return { quote, matches: [quote] }
    },
    gecko: async () => null,
  }
  assert.equal((await resolveOutcomeQuote('solana', PAID_DOGE_MINT, providers, { now }))?.priceUsd, 0.0005)
  assert.equal((await resolveOutcomeQuote('solana', PAID_DOGE_MINT, providers, { now: now + 30_000 }))?.priceUsd, 0.0005)
  assert.equal(calls, 1)
  assert.equal((await resolveOutcomeQuote('solana', PAID_DOGE_MINT, providers, { force: true, now: now + 30_000 }))?.priceUsd, 0.00075)
  assert.equal(calls, 2)
})

test('solana 3. fresh valid price overwrites an older 0% observation', () => {
  const now = 1_800_000_000_000
  const stuck = paidDogeRow(now, 0.0005, 0)
  const live = paidDogeQuote(0.00075, now + 40)
  const update = buildOutcomeRefreshUpdate(stuck, live, null, new Date(now).toISOString(), now)
  assert.equal(stuck.price_change_pct, 0)
  assert.equal(update.current_price_usd, 0.00075)
  assert.equal(update.price_change_pct, 50)
  assert.equal(update.last_checked_at, new Date(now).toISOString())
  assert.equal(update.market_source, 'dexscreener')
})

test('solana 4. DB/list read prefers the newest valid observation over a stored 0%', () => {
  const now = 1_800_000_000_000
  const listed = hydrateTrackedOutcomeListRow({
    ...paidDogeRow(now, 0.00075, 0),
    tokenSymbol: 'PAIDDOGE', tokenName: 'Paid Doge', scannedAt: new Date(now - 3_600_000).toISOString(),
    last_checked_at: new Date(now).toISOString(),
  }, now)
  assert.equal(listed.current_price_usd, 0.00075)
  assert.equal(listed.price_change_pct, 50)
  assert.notEqual(listed.price_change_pct, 0)
  assert.equal(listed.baseline_snapshot_json.tokenSymbol, 'PAIDDOGE')
})

test('solana 5. failed refresh preserves last valid observation and does not bump last_checked_at', () => {
  const now = 1_800_000_000_000
  const checked = new Date(now - 60_000).toISOString()
  const row = { ...paidDogeRow(now, 0.00075, 50), last_checked_at: checked }
  const update = buildOutcomeRefreshUpdate(row, null, null, new Date(now).toISOString(), now)
  assert.equal(update.current_price_usd, 0.00075)
  assert.equal(update.price_change_pct, 50)
  assert.equal(update.last_checked_at, checked)
  assert.equal(update.market_source, 'dexscreener')
  assert.match(update.outcome_reasons_json[0] ?? '', /Retaining the previous verified observation/)
})

test('solana 6. Track UI renders POST-returned outcomes immediately without another GET', () => {
  const page = readFileSync(new URL('../app/terminal/track/page.tsx', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../app/api/token-outcomes/route.ts', import.meta.url), 'utf8')
  const service = readFileSync(new URL('../lib/server/tokenOutcomeService.ts', import.meta.url), 'utf8')
  assert.match(page, /force \? \{ ids: visibleIds.current \} : \{\}/)
  assert.match(page, /Array\.isArray\(result\.outcomes\)/)
  assert.match(page, /setRows\(outcomes\)/)
  assert.match(page, /return true/)
  assert.match(route, /outcomes, limit: OUTCOME_POLICY\.limits\[user\.plan\]/)
  assert.match(service, /return listTrackedOutcomes\(userId, now\)/)
  for (const field of [
    'trackedOutcomeId', 'chain', 'mint', 'baselinePrice', 'previousCurrentPrice', 'refreshForced',
    'cacheHit', 'fetchAttempted', 'provider', 'candidatePrices', 'selectedPairOrPool', 'selectedBaseMint',
    'selectedQuoteMint', 'identityMatched', 'fetchedCurrentPrice', 'fetchedAt', 'persistedCurrentPrice',
    'persistedLastCheckedAt', 'rereadCurrentPrice', 'computedPercentChange', 'rejectionReason',
  ]) assert.match(service, new RegExp(field))
  assert.match(service, /\[outcome-refresh-forensic\]/)
})

test('solana 7. exact mint match is still required; case-folded Solana mint is rejected', async () => {
  __resetMemoryFallbackForTest()
  const now = 1_800_000_000_000
  const wrongCase = PAID_DOGE_MINT.toLowerCase()
  assert.notEqual(wrongCase, PAID_DOGE_MINT)
  const live = { ...paidDogeQuote(0.00075, now + 10), address: wrongCase }
  const providers = { dex: async () => ({ quote: live, matches: [live] }), gecko: async () => live }
  assert.equal(quoteMatches(live, 'solana', PAID_DOGE_MINT), false)
  assert.equal(await resolveOutcomeQuote('solana', PAID_DOGE_MINT, providers, { force: true, now }), null)
  const otherMint = '51qkNpgTHcjuDYhKVcg6rJS4uYYtJHpDRcJoSdKqpump'
  const other = { ...paidDogeQuote(0.00075, now + 10), address: otherMint }
  assert.equal(quoteMatches(other, 'solana', PAID_DOGE_MINT), false)
})

test('solana 8. quote-token pool is rejected; PumpSwap mint-as-base pair is accepted', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    pairs: [
      {
        chainId: 'solana', dexId: 'pumpswap', pairAddress: 'QuoteHeavy111111111111111111111111111111111',
        priceUsd: '9.99', liquidity: { usd: 1_000_000 },
        baseToken: { address: WSOL_MINT, symbol: 'SOL', name: 'Wrapped SOL' },
        quoteToken: { address: PAID_DOGE_MINT, symbol: 'PAIDDOGE', name: 'Paid Doge' },
      },
      {
        chainId: 'solana', dexId: 'pumpswap', pairAddress: PAID_DOGE_PUMPSWAP,
        priceUsd: '0.00075', liquidity: { usd: 70_000 },
        baseToken: { address: PAID_DOGE_MINT, symbol: 'PAIDDOGE', name: 'Paid Doge' },
        quoteToken: { address: WSOL_MINT, symbol: 'SOL', name: 'Wrapped SOL' },
      },
    ],
  }), { status: 200 })
  try {
    const result = await dexScreenerOutcomeMarketProvider(PAID_DOGE_MINT, 'solana')
    assert.equal(result?.quote.priceUsd, 0.00075)
    assert.equal(result?.quote.address, PAID_DOGE_MINT)
    assert.equal(result?.candidatePairs?.some(c => c.quoteMint === PAID_DOGE_MINT && c.baseMint === WSOL_MINT), false)
    assert.equal(result?.candidatePairs?.some(c => c.baseMint === PAID_DOGE_MINT && c.pairAddress === PAID_DOGE_PUMPSWAP), true)
    const now = Date.now()
    const update = buildOutcomeRefreshUpdate(paidDogeRow(now), result!.quote, null, new Date(now).toISOString(), now)
    assert.equal(update.current_price_usd, 0.00075)
    assert.equal(update.price_change_pct, 50)
  } finally { globalThis.fetch = originalFetch }
})

function mockListDb(opts: {
  observationError?: { code: string; message: string } | null
  baseError?: { code: string; message: string } | null
  rows?: Record<string, unknown>[]
}) {
  const calls: string[] = []
  const userFilters: string[] = []
  const db = {
    from() {
      const q: { columns?: string } = {}
      const self = {
        select(columns: string) { calls.push(columns); q.columns = columns; return self },
        eq(key: string, value: string) { if (key === 'user_id') userFilters.push(value); return self },
        order() { return self },
        limit() {
          if (String(q.columns).includes('market_observation_json') && opts.observationError) return { data: null, error: opts.observationError }
          if (opts.baseError) return { data: null, error: opts.baseError }
          return { data: opts.rows ?? [], error: null }
        },
      }
      return self
    },
  }
  return { db, calls, userFilters }
}

function storageListRow(symbol: string, tokenAddress: string, id: string) {
  return {
    id, chain: symbol === 'PAIDDOGE' ? 'solana' : 'base', token_address: tokenAddress, scan_id: `scan-${symbol}`,
    tracked_at: '2026-09-14T00:00:00.000Z', baseline_price_usd: 0.0005, baseline_liquidity_usd: 50_000,
    baseline_market_cap_usd: null, baseline_risk_score: 60, baseline_verdict: 'High Risk',
    current_price_usd: 0.00075, current_liquidity_usd: 80_000, price_change_pct: 50, liquidity_change_pct: null,
    outcome_status: 'pumped', outcome_confidence: 'medium',
    outcome_reasons_json: ['Price increased at least 50% since the scan. Market estimate, not executable returns.'],
    last_checked_at: new Date().toISOString(), market_source: 'dexscreener', after_evidence_json: null,
    tokenSymbol: symbol, tokenName: symbol, scannedAt: '2026-09-14T00:00:00.000Z',
  }
}

test('storage: missing optional observation column still lists existing owner receipts', async () => {
  const paid = storageListRow('PAIDDOGE', PAID_DOGE_MINT, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  const kai = storageListRow('KAI', `0x${'c'.repeat(40)}`, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  const { db, calls, userFilters } = mockListDb({
    observationError: { code: 'PGRST204', message: "Could not find the 'market_observation_json' column of 'tracked_token_outcomes' in the schema cache" },
    rows: [paid, kai],
  })
  const rows = await listTrackedOutcomes(user, Date.now(), db as never)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.baseline_snapshot_json.tokenSymbol, 'PAIDDOGE')
  assert.equal(rows[1]?.baseline_snapshot_json.tokenSymbol, 'KAI')
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.includes('market_observation_json'), true)
  assert.equal(calls[1]?.includes('market_observation_json'), false)
  assert.deepEqual(userFilters, [user, user])
})

test('storage: genuine empty account is an empty list, not a storage error', async () => {
  const { db } = mockListDb({ rows: [] })
  const rows = await listTrackedOutcomes(user, Date.now(), db as never)
  assert.deepEqual(rows, [])
})

test('storage: missing table is a storage error, never an empty list', async () => {
  const { db } = mockListDb({
    observationError: { code: '42P01', message: 'relation "tracked_token_outcomes" does not exist' },
    baseError: { code: '42P01', message: 'relation "tracked_token_outcomes" does not exist' },
  })
  await assert.rejects(() => listTrackedOutcomes(user, Date.now(), db as never), /tracked-token-outcomes migration/)
})

test('storage: unrelated database failure is a storage error, never an empty list', async () => {
  const { db } = mockListDb({
    observationError: { code: '08006', message: 'connection timeout talking to postgres' },
  })
  await assert.rejects(() => listTrackedOutcomes(user, Date.now(), db as never), /Outcome storage unavailable/)
})

test('storage: owner filter is required and another user id is not used', async () => {
  const { db, userFilters } = mockListDb({ rows: [storageListRow('PAIDDOGE', PAID_DOGE_MINT, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')] })
  await listTrackedOutcomes(user, Date.now(), db as never)
  assert.ok(userFilters.length > 0)
  assert.ok(userFilters.every(id => id === user))
})

test('storage: refresh write retries without the optional observation column', async () => {
  const captured: Record<string, unknown>[] = []
  let writes = 0
  const db = {
    from() {
      const self = {
        update(payload: Record<string, unknown>) { captured.push(payload); return self },
        eq() { return self },
        select() {
          writes += 1
          if (writes === 1) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'market_observation_json' column of 'tracked_token_outcomes' in the schema cache" } }
          return { data: [{ current_price_usd: 0.00075, last_checked_at: '2026-09-17T00:00:00.000Z', price_change_pct: 50 }], error: null }
        },
      }
      return self
    },
  }
  const written = await persistOutcomeRefreshUpdate(db as never, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user, 'claim', {
    current_price_usd: 0.00075, market_observation_json: { version: 1 }, last_checked_at: '2026-09-17T00:00:00.000Z',
  })
  assert.equal(written.error, null)
  assert.equal(captured.length, 2)
  assert.equal('market_observation_json' in captured[0]!, true)
  assert.equal('market_observation_json' in captured[1]!, false)
  assert.equal(captured[1]!.current_price_usd, 0.00075)
})

test('storage: schema helpers distinguish missing column, missing table, and secrets', () => {
  assert.equal(isMissingOutcomeColumnError({ code: 'PGRST204', message: "Could not find the 'market_observation_json' column of 'tracked_token_outcomes' in the schema cache" }), true)
  assert.equal(isMissingOutcomeColumnError({ code: '42703', message: 'column tracked_token_outcomes.market_observation_json does not exist' }), true)
  assert.equal(isMissingOutcomeTableError({ code: '42P01', message: 'relation "tracked_token_outcomes" does not exist' }), true)
  assert.equal(isMissingOutcomeColumnError({ code: '42P01', message: 'relation "tracked_token_outcomes" does not exist' }), false)
  const sanitized = sanitizeOutcomeStorageError({ code: 'PGRST204', message: 'fail https://abcd.supabase.co/rest/v1 eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb' })
  assert.equal(sanitized.code, 'storage_schema')
  assert.doesNotMatch(sanitized.message, /eyJ/)
  assert.doesNotMatch(sanitized.message, /https:\/\//)
  assert.equal('market_observation_json' in omitOptionalObservationColumn({ current_price_usd: 1, market_observation_json: { version: 1 } }), false)
})

test('storage: GET 401 expired session is not a storage failure; retry falls back to GET', () => {
  const route = readFileSync(new URL('../app/api/token-outcomes/route.ts', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../app/terminal/track/page.tsx', import.meta.url), 'utf8')
  assert.match(route, /if \(!user\) return unauthorizedResponse\(\)/)
  assert.match(route, /logOutcomeStorageError\('GET', error\)/)
  assert.doesNotMatch(route, /outcomes:\s*\[\]/)
  assert.match(page, /Sign in to view your private outcomes/)
  assert.match(page, /A refresh write failure must not hide saved receipts/)
  assert.match(page, /const data = await outcomeRequest\('GET'\)/)
  assert.match(page, /!error && <section className=\{styles.empty\}>/)
})
