// PUMP ALERTS — LIVE PUMP DISCOVERY FEED TESTS, DISCLOSED.
//
// Covers the "STOP overcomplicating Pump Alerts" rewrite: a live pump discovery feed instead of a
// multi-tier exact-14d evidence ladder. Exercises the real exported pure functions (no mocks, no
// network) plus static source assertions for the parts a network-free unit test can't reach
// directly (discovery breadth, response shape, UI wiring).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  evaluatePumpCandidate,
  rankPumpCandidate,
  isMajorStableWrappedOrLp,
  PUMP_ALERT_MAX_CAP_USD,
  PUMP_ALERT_MIN_LIQUIDITY_USD,
  PUMP_ALERT_MIN_VOLUME_24H_USD,
  PUMP_ALERT_MIN_24H_CHANGE_PCT,
  PUMP_ALERT_MIN_6H_CHANGE_PCT,
  PUMP_ALERT_MIN_1H_CHANGE_PCT,
  PUMP_ALERT_TARGET_RESULTS,
  PUMP_ALERT_MAX_RAW_CANDIDATES,
  PUMP_ALERT_REQUIRE_EXACT_7D,
} from '../app/api/pump-alerts/route.ts'

function candidate(overrides = {}) {
  return {
    chainSlug: 'base', chainId: 8453, tokenAddress: '0xabc0000000000000000000000000000000000a',
    symbol: 'MOON', name: 'Moon Token',
    priceUsd: 0.002, marketCapUsd: 1_000_000, fdvUsd: 1_200_000,
    liquidityUsd: 50_000, volume24hUsd: 100_000,
    priceChange24hPct: 0, priceChange6hPct: 0, priceChange1hPct: 0,
    pairAddress: '0xpool000000000000000000000000000000000a',
    source: 'geckoterminal',
    ...overrides,
  }
}

// ─── Config defaults, DISCLOSED: exact values requested ────────────────────────────────────────
assert.equal(PUMP_ALERT_MAX_CAP_USD, 30_000_000)
assert.equal(PUMP_ALERT_MIN_LIQUIDITY_USD, 5_000)
assert.equal(PUMP_ALERT_MIN_VOLUME_24H_USD, 5_000)
assert.equal(PUMP_ALERT_MIN_24H_CHANGE_PCT, 5)
assert.equal(PUMP_ALERT_MIN_6H_CHANGE_PCT, 3)
assert.equal(PUMP_ALERT_MIN_1H_CHANGE_PCT, 1.5)
assert.equal(PUMP_ALERT_TARGET_RESULTS, 20)
assert.equal(PUMP_ALERT_MAX_RAW_CANDIDATES, 500)
assert.equal(PUMP_ALERT_REQUIRE_EXACT_7D, false)

// ─── Hard rule: no fake data — never fabricate a value not present on the candidate ─────────────
{
  const c = candidate({ priceChange24hPct: null, priceChange6hPct: null, priceChange1hPct: null, volume24hUsd: 50_000, liquidityUsd: 100_000 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false, 'no momentum data anywhere must never be silently qualified')
  assert.equal(r.reason, 'noMomentum')
}

// ─── Required test: Base token under $30M with +6% 24h renders ─────────────────────────────────
{
  const c = candidate({ chainSlug: 'base', chainId: 8453, marketCapUsd: 5_000_000, priceChange24hPct: 6 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, true, 'a Base token under $30M with +6% 24h must qualify')
  assert.equal(r.window, '24h')
}

// ─── Required test: ETH token under $30M with +4% 6h renders ───────────────────────────────────
{
  const c = candidate({ chainSlug: 'eth', chainId: 1, marketCapUsd: 8_000_000, priceChange24hPct: 1, priceChange6hPct: 4 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, true, 'an ETH token under $30M with +4% 6h must qualify (24h too weak, falls back to 6h)')
  assert.equal(r.window, '6h')
}

// ─── Required test: Robinhood token under $30M with +2% 1h renders ─────────────────────────────
{
  const c = candidate({ chainSlug: 'robinhood', chainId: 4663, marketCapUsd: 2_000_000, priceChange24hPct: 1, priceChange6hPct: 1, priceChange1hPct: 2 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, true, 'a Robinhood token under $30M with +2% 1h must qualify (24h/6h too weak, falls back to 1h)')
  assert.equal(r.window, '1h')
}

// ─── Volume/liquidity-ratio momentum rule: qualifies without any window threshold being hit ─────
{
  const c = candidate({ priceChange24hPct: 1, priceChange6hPct: 0.5, priceChange1hPct: 0.2, volume24hUsd: 40_000, liquidityUsd: 100_000 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, true, 'volume/liquidity >= 0.3x with a positive 24h change must qualify even with no window threshold hit')
  assert.equal(r.window, 'volLiq')
}
// Same ratio but a non-positive 24h change must NOT qualify via this rule.
{
  const c = candidate({ priceChange24hPct: -1, priceChange6hPct: 0.5, priceChange1hPct: 0.2, volume24hUsd: 40_000, liquidityUsd: 100_000 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false, 'the volume/liquidity rule requires a POSITIVE 24h change, not just an active ratio')
  assert.equal(r.reason, 'noMomentum')
}

// ─── Required test: no momentum on any window (and ratio rule) → rejected, never faked ──────────
{
  const c = candidate({ priceChange24hPct: 1, priceChange6hPct: 1, priceChange1hPct: 1, volume24hUsd: 5_000, liquidityUsd: 100_000 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false)
  assert.equal(r.reason, 'noMomentum')
}

// ─── Do NOT require exact 7d/14d OHLCV to render a card ─────────────────────────────────────────
{
  const c = candidate({ priceChange24hPct: 10 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, true, 'a candidate with zero 7d/14d evidence must still qualify on live momentum alone')
}

// ─── Cap rule: marketCapUsd OR fdvUsd <= $30M ────────────────────────────────────────────────────
{
  const c = candidate({ marketCapUsd: null, fdvUsd: 25_000_000, priceChange24hPct: 10 })
  assert.equal(evaluatePumpCandidate(c).qualified, true, 'fdvUsd alone under the cap must qualify when marketCapUsd is null')
}
{
  const c = candidate({ marketCapUsd: 40_000_000, fdvUsd: 1_000_000, priceChange24hPct: 10 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false, 'a $40M market cap must be rejected even when FDV alone would pass')
  assert.equal(r.reason, 'overCap')
}
{
  const c = candidate({ marketCapUsd: null, fdvUsd: null, priceChange24hPct: 10 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false)
  assert.equal(r.reason, 'capDataMissing')
}

// ─── High-cap token over $30M excluded ───────────────────────────────────────────────────────────
{
  const c = candidate({ marketCapUsd: 50_000_000, fdvUsd: 50_000_000, priceChange24hPct: 20 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false)
  assert.equal(r.reason, 'overCap')
}

// ─── Liquidity / volume minimums ─────────────────────────────────────────────────────────────────
{
  const r = evaluatePumpCandidate(candidate({ liquidityUsd: 1_000, priceChange24hPct: 20 }))
  assert.equal(r.qualified, false)
  assert.equal(r.reason, 'lowLiquidity')
}
{
  const r = evaluatePumpCandidate(candidate({ volume24hUsd: 1_000, priceChange24hPct: 20 }))
  assert.equal(r.qualified, false)
  assert.equal(r.reason, 'lowVolume')
}

// ─── SOL/ETH/BTC/WETH/USDC/AERO (and the rest of the hard-rule denylist) excluded ────────────────
for (const [sym, name] of [
  ['SOL', 'Solana'], ['ETH', 'Ethereum'], ['BTC', 'Bitcoin'], ['WETH', 'Wrapped Ether'],
  ['WBTC', 'Wrapped Bitcoin'], ['CBETH', 'Coinbase Wrapped Staked ETH'],
  ['USDC', 'USD Coin'], ['USDT', 'Tether'], ['AERO', 'Aerodrome Finance'],
]) {
  assert.equal(isMajorStableWrappedOrLp(sym, name), true, `${sym} must be excluded as a major/stable/wrapped asset`)
  const r = evaluatePumpCandidate(candidate({ symbol: sym, name, priceChange24hPct: 50 }))
  assert.equal(r.qualified, false, `${sym} must never qualify regardless of momentum`)
  assert.equal(r.reason, 'majorStableWrapped')
}
// A bridged/wrapped representation caught by name, even with an unlisted symbol.
assert.equal(isMajorStableWrappedOrLp('BSOL', 'Bridged Solana'), true, 'a bridged Solana representation must be excluded by name')
// LP token pattern.
assert.equal(isMajorStableWrappedOrLp('AERO-USDC-LP', 'Aerodrome LP Vault'), true, 'an LP-token symbol pattern must be excluded')

// A genuine low-cap, non-denylisted token must NOT be excluded.
assert.equal(isMajorStableWrappedOrLp('MOON', 'Moon Token'), false)

// ─── Ranking: higher momentum/liquidity/lower-cap ranks above a weaker candidate ─────────────────
{
  const strong = candidate({ priceChange24hPct: 40, volume24hUsd: 200_000, liquidityUsd: 150_000, marketCapUsd: 500_000 })
  const weak = candidate({ priceChange24hPct: 6, volume24hUsd: 20_000, liquidityUsd: 20_000, marketCapUsd: 20_000_000 })
  const strongEval = evaluatePumpCandidate(strong)
  const weakEval = evaluatePumpCandidate(weak)
  assert.equal(strongEval.qualified, true)
  assert.equal(weakEval.qualified, true)
  assert.ok(rankPumpCandidate(strong, strongEval) > rankPumpCandidate(weak, weakEval), 'a stronger mover with more liquidity and a lower cap must rank higher')
}
// A razor-thin-liquidity mover must be penalized relative to an otherwise-identical deeper pool.
{
  const thin = candidate({ priceChange24hPct: 20, volume24hUsd: 5_000, liquidityUsd: 5_500 })
  const deep = candidate({ priceChange24hPct: 20, volume24hUsd: 5_000, liquidityUsd: 5_500 * 20 })
  const thinEval = evaluatePumpCandidate(thin)
  const deepEval = evaluatePumpCandidate(deep)
  assert.ok(rankPumpCandidate(thin, thinEval) < rankPumpCandidate(deep, deepEval), 'the risk penalty must make thin liquidity rank below deep liquidity, all else equal')
}

// ─── Route-level static assertions: discovery breadth, "do not block on GeckoTerminal", chains ──
const routeSrc = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /export function evaluatePumpCandidate/, 'the eligibility function must be exported and pure')
assert.match(routeCode, /export function rankPumpCandidate/, 'the ranking function must be exported and pure')
assert.match(routeCode, /Promise\.allSettled\(\s*\[?\s*fetchGTCandidates\(chain, signal\),\s*fetchDexScreenerCandidates\(chain, signal\),/, 'GeckoTerminal and DexScreener discovery must run independently — one failing must never block the other')
assert.match(routeCode, /async function fetchDexScreenerCandidates/, 'a DexScreener-sourced discovery path, independent of GeckoTerminal, must exist')
assert.match(routeCode, /const settled = await Promise\.allSettled\(chains\.map\(c => fetchChainCandidates\(c, ac\.signal\)\)\)/, 'every requested chain must be fetched independently — one chain failing must never block another')
assert.doesNotMatch(routeCode, /fetchPoolFourteenDayChange|evaluateCandidatesInBatches|geckoOhlcvAttempted/, 'the old exact-14d evidence ladder (OHLCV budget/batches) must be fully removed — this feed never blocks on it')
assert.match(routeCode, /pair\.chainId !== dsChainId\) continue/, 'a DexScreener pair from another chain must never be accepted (hard rule: no wrong-chain pools)')

// Response includes the rejection-breakdown audit the UI needs for "1 of X candidates qualified".
assert.match(routeCode, /pumpFeedAudit: \{/, 'the response must include the rejection-breakdown audit')
for (const field of ['rawCandidates', 'qualified', 'rejectedMajorStableWrapped', 'rejectedOverCap', 'rejectedLowLiquidity', 'rejectedLowVolume', 'rejectedNoMomentum']) {
  assert.match(routeCode, new RegExp(field), `pumpFeedAudit must include ${field}`)
}

// Chain identity is preserved end-to-end — no candidate is ever relabelled to another chain.
assert.match(routeCode, /chain: c\.chainSlug, chainId: c\.chainId/, 'published alerts must carry the candidate\'s own chain, never a hardcoded one')
assert.match(routeCode, /const key = `\$\{c\.chainSlug\}:\$\{c\.tokenAddress\}`/, 'dedupe identity must be chain-scoped')

// GT failure for one/all chains does not block the feed: DexScreener-only chains can still succeed,
// and the failure is honestly reported, never silently swallowed.
assert.match(routeCode, /chainsFailed\.push\(chains\[i\]\)/, 'chain-level failures must be tracked and reported')
assert.match(routeCode, /finalState: 'providerUnavailable'/, 'a genuine total-outage response must still report a truthful finalState')

// ─── UI wiring: actions, badges, Load More, chain-strict handoffs still present ──────────────────
const pageSrc = fs.readFileSync(new URL('../app/terminal/pump-alerts/page.tsx', import.meta.url), 'utf8')
const pageCode = pageSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(pageCode, /onClick=\{onScan\}/, 'Scan action must be wired')
assert.match(pageCode, /onClick=\{onCopyCA\}/, 'Copy CA action must be wired')
assert.match(pageCode, /onClick=\{onAskClark\}/, 'Ask Clark action must be wired')
assert.match(pageCode, /onClick=\{onReport\}/, 'Report action must be wired')
assert.match(pageCode, /Live Momentum/, 'the Live Momentum badge must render')
assert.match(pageCode, /const PAGE_SIZE = 10/, 'initial render / page size must stay 8-10 alerts')
assert.match(pageCode, /const hasMore = visibleCount < filtered\.length/, 'Load More must hide once everything is shown')
assert.match(pageCode, /loadMoreLoading/, 'Load More must expose a loading state')
assert.match(pageCode, /alert\.chain === 'base' \? '' : `&chain=\$\{alert\.chain\}`/, 'Scan handoff must pass the real chain to Token Scanner')
assert.match(pageCode, /chain: alert\.chain,/, 'the report handoff must pass the alert\'s real chain')
assert.doesNotMatch(pageCode, /setAlerts\(\[\]\)/, 'alerts must never be reset to empty on refresh — that would blank the feed')

// The exact "1 of X candidates qualified" format the UI must show when the feed is thin.
assert.match(pageCode, /\{alerts\.length\} of \{candidateAudit\.rawCandidates\} candidates qualified/, 'the low-count explanation must cite the real qualified/raw counts')
assert.match(pageCode, /rejectedMajorStableWrapped\} majors\/stables removed/, 'the breakdown must state majors/stables removed')
assert.match(pageCode, /over \$30M removed/, 'the breakdown must state over $30M removed')
assert.match(pageCode, /low liquidity removed/, 'the breakdown must state low liquidity removed')
assert.match(pageCode, /low volume removed/, 'the breakdown must state low volume removed')
assert.match(pageCode, /no momentum removed/, 'the breakdown must state no momentum removed')

console.log('test-pump-alerts-discovery.mjs: all assertions passed')
