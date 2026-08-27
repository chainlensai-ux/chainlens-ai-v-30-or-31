import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  evaluatePumpCandidate,
  rankPumpCandidate,
  isMajorStableWrappedOrLp,
  mergeNormalizedCandidate,
  tokenAgeDaysFromPairCreatedAtMs,
  parsePairCreatedAtMs,
  sanitizeMarketCapUsd,
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
    pairCreatedAtMs: null,
    source: 'geckoterminal',
    ...overrides,
  }
}

// Keep existing discovery assertions by re-reading the original file body via the same helpers.
assert.equal(PUMP_ALERT_MAX_CAP_USD, 30_000_000)
assert.equal(PUMP_ALERT_MIN_LIQUIDITY_USD, 5_000)
assert.equal(PUMP_ALERT_MIN_VOLUME_24H_USD, 5_000)
assert.equal(PUMP_ALERT_MIN_24H_CHANGE_PCT, 5)
assert.equal(PUMP_ALERT_MIN_6H_CHANGE_PCT, 3)
assert.equal(PUMP_ALERT_MIN_1H_CHANGE_PCT, 1.5)
assert.equal(PUMP_ALERT_TARGET_RESULTS, 20)
assert.equal(PUMP_ALERT_MAX_RAW_CANDIDATES, 500)
assert.equal(PUMP_ALERT_REQUIRE_EXACT_7D, false)

{
  const c = candidate({ priceChange24hPct: null, priceChange6hPct: null, priceChange1hPct: null, volume24hUsd: 50_000, liquidityUsd: 100_000 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false, 'no momentum data anywhere must never be silently qualified')
  assert.equal(r.reason, 'noMomentum')
}
{
  const c = candidate({ chainSlug: 'base', chainId: 8453, marketCapUsd: 5_000_000, priceChange24hPct: 6 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, true, 'a Base token under $30M with +6% 24h must qualify')
  assert.equal(r.window, '24h')
}
{
  const c = candidate({ chainSlug: 'eth', chainId: 1, marketCapUsd: 8_000_000, priceChange24hPct: 1, priceChange6hPct: 4 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, true, 'an ETH token under $30M with +4% 6h must qualify (24h too weak, falls back to 6h)')
  assert.equal(r.window, '6h')
}
{
  const c = candidate({ chainSlug: 'robinhood', chainId: 4663, marketCapUsd: 2_000_000, priceChange24hPct: 1, priceChange6hPct: 1, priceChange1hPct: 2 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, true, 'a Robinhood token under $30M with +2% 1h must qualify (24h/6h too weak, falls back to 1h)')
  assert.equal(r.window, '1h')
}
{
  const c = candidate({ priceChange24hPct: 1, priceChange6hPct: 0.5, priceChange1hPct: 0.2, volume24hUsd: 40_000, liquidityUsd: 100_000 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, true, 'volume/liquidity >= 0.3x with a positive 24h change must qualify even with no window threshold hit')
  assert.equal(r.window, 'volLiq')
}
{
  const c = candidate({ priceChange24hPct: -1, priceChange6hPct: 0.5, priceChange1hPct: 0.2, volume24hUsd: 40_000, liquidityUsd: 100_000 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false, 'the volume/liquidity rule requires a POSITIVE 24h change, not just an active ratio')
  assert.equal(r.reason, 'noMomentum')
}
{
  const c = candidate({ priceChange24hPct: 1, priceChange6hPct: 1, priceChange1hPct: 1, volume24hUsd: 5_000, liquidityUsd: 100_000 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false)
  assert.equal(r.reason, 'noMomentum')
}
{
  const c = candidate({ priceChange24hPct: 10 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, true, 'a candidate with zero 7d/14d evidence must still qualify on live momentum alone')
}
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
{
  const c = candidate({ marketCapUsd: 50_000_000, fdvUsd: 50_000_000, priceChange24hPct: 20 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false)
  assert.equal(r.reason, 'overCap')
}
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
assert.equal(isMajorStableWrappedOrLp('BSOL', 'Bridged Solana'), true, 'a bridged Solana representation must be excluded by name')
assert.equal(isMajorStableWrappedOrLp('AERO-USDC-LP', 'Aerodrome LP Vault'), true, 'an LP-token symbol pattern must be excluded')
assert.equal(isMajorStableWrappedOrLp('MOON', 'Moon Token'), false)
{
  const strong = candidate({ priceChange24hPct: 40, volume24hUsd: 200_000, liquidityUsd: 150_000, marketCapUsd: 500_000 })
  const weak = candidate({ priceChange24hPct: 6, volume24hUsd: 20_000, liquidityUsd: 20_000, marketCapUsd: 20_000_000 })
  const strongEval = evaluatePumpCandidate(strong)
  const weakEval = evaluatePumpCandidate(weak)
  assert.equal(strongEval.qualified, true)
  assert.equal(weakEval.qualified, true)
  assert.ok(rankPumpCandidate(strong, strongEval) > rankPumpCandidate(weak, weakEval), 'a stronger mover with more liquidity and a lower cap must rank higher')
}
{
  const thin = candidate({ priceChange24hPct: 20, volume24hUsd: 5_000, liquidityUsd: 5_500 })
  const deep = candidate({ priceChange24hPct: 20, volume24hUsd: 5_000, liquidityUsd: 5_500 * 20 })
  const thinEval = evaluatePumpCandidate(thin)
  const deepEval = evaluatePumpCandidate(deep)
  assert.ok(rankPumpCandidate(thin, thinEval) < rankPumpCandidate(deep, deepEval), 'the risk penalty must make thin liquidity rank below deep liquidity, all else equal')
}

const routeSrc = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
assert.match(routeCode, /export function evaluatePumpCandidate/, 'the eligibility function must be exported and pure')
assert.match(routeCode, /export function rankPumpCandidate/, 'the ranking function must be exported and pure')
assert.match(routeCode, /Promise\.allSettled\(\s*\[?\s*fetchGTCandidates\(chain, signal\),\s*fetchDexScreenerCandidates\(chain, signal\),/, 'GeckoTerminal and DexScreener discovery must run independently — one failing must never block the other')
assert.match(routeCode, /async function fetchDexScreenerCandidates/, 'a DexScreener-sourced discovery path, independent of GeckoTerminal, must exist')
assert.match(routeCode, /const settled = await Promise\.allSettled\(chains\.map\(c => fetchChainCandidates\(c, ac\.signal\)\)\)/, 'every requested chain must be fetched independently — one chain failing must never block another')
assert.doesNotMatch(routeCode, /fetchPoolFourteenDayChange|evaluateCandidatesInBatches|geckoOhlcvAttempted/, 'the old exact-14d evidence ladder (OHLCV budget/batches) must be fully removed — this feed never blocks on it')
assert.match(routeCode, /pair\.chainId !== dsChainId\) continue/, 'a DexScreener pair from another chain must never be accepted (hard rule: no wrong-chain pools)')
assert.match(routeCode, /pumpFeedAudit: \{/, 'the response must include the rejection-breakdown audit')
for (const field of ['rawCandidates', 'qualified', 'rejectedMajorStableWrapped', 'rejectedOverCap', 'rejectedLowLiquidity', 'rejectedLowVolume', 'rejectedNoMomentum']) {
  assert.match(routeCode, new RegExp(field), `pumpFeedAudit must include ${field}`)
}
assert.match(routeCode, /chain: c\.chainSlug, chainId: c\.chainId/, 'published alerts must carry the candidate\'s own chain, never a hardcoded one')
assert.match(routeCode, /const key = `\$\{c\.chainSlug\}:\$\{c\.tokenAddress\}`/, 'dedupe identity must be chain-scoped')
assert.match(routeCode, /chainsFailed\.push\(chains\[i\]\)/, 'chain-level failures must be tracked and reported')
assert.match(routeCode, /finalState: 'providerUnavailable'/, 'a genuine total-outage response must still report a truthful finalState')

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
assert.match(pageCode, /\{alerts\.length\} of \{candidateAudit\.rawCandidates\} candidates qualified/, 'the low-count explanation must cite the real qualified/raw counts')
assert.match(pageCode, /rejectedMajorStableWrapped\} majors\/stables removed/, 'the breakdown must state majors/stables removed')
assert.match(pageCode, /over \$30M removed/, 'the breakdown must state over $30M removed')
assert.match(pageCode, /low liquidity removed/, 'the breakdown must state low liquidity removed')
assert.match(pageCode, /low volume removed/, 'the breakdown must state low volume removed')
assert.match(pageCode, /no momentum removed/, 'the breakdown must state no momentum removed')

{
  const keep = candidate({ marketCapUsd: null, fdvUsd: 2_000_000, pairAddress: null, pairCreatedAtMs: null })
  const incoming = candidate({
    marketCapUsd: 1_000_000, fdvUsd: 9_000_000,
    pairAddress: '0xpoolbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    pairCreatedAtMs: 1_700_000_000_000,
  })
  const merged = mergeNormalizedCandidate(keep, incoming)
  assert.equal(merged.marketCapUsd, 1_000_000, 'null mcap must fill from a later row')
  assert.equal(merged.fdvUsd, 2_000_000, 'an already-present fdv must not be overwritten')
  assert.equal(merged.pairAddress, incoming.pairAddress)
  assert.equal(merged.pairCreatedAtMs, incoming.pairCreatedAtMs)
}
{
  const now = Date.now()
  assert.equal(tokenAgeDaysFromPairCreatedAtMs(now, now), 0, 'a just-created pair must keep age 0, not null')
  assert.equal(tokenAgeDaysFromPairCreatedAtMs(null, now), null)
}
assert.match(routeCode, /marketCapUsd === fdvUsd/, 'DexScreener mcap===fdv must be treated as unknown circulating supply')
assert.match(routeCode, /mergeNormalizedCandidate/, 'same-token rows must merge instead of first-wins')
assert.match(routeCode, /pairCreatedAtMs/, 'candidates must carry pairCreatedAtMs')
assert.match(pageCode, /rejectedCapDataMissing\} missing cap data/, 'cap-data-missing must not be labelled over $30M')
assert.doesNotMatch(pageCode, /rejectedOverCap \+ candidateAudit\.rejectedCapDataMissing/, 'missing-cap rows must never be summed into over $30M')

{
  const iso = '2026-08-27T22:36:00.000Z'
  const created = Date.parse(iso)
  assert.equal(parsePairCreatedAtMs(iso), created, 'GT pool_created_at ISO must parse to ms')
  const now = created + 5 * 3_600_000
  const days = tokenAgeDaysFromPairCreatedAtMs(parsePairCreatedAtMs(iso), now)
  assert.ok(days != null)
  assert.ok(Math.abs(days - 5 / 24) < 1e-9, '5.0h GT pool_created_at must become ~5/24 days')
}
{
  const ms = 1_700_000_000_000
  assert.equal(parsePairCreatedAtMs(ms), ms, 'DS pairCreatedAt in ms stays ms')
  const sec = 1_700_000_000
  assert.equal(parsePairCreatedAtMs(sec), 1_700_000_000_000, 'DS pairCreatedAt in seconds must scale to ms')
  const now = ms + 12 * 3_600_000
  const days = tokenAgeDaysFromPairCreatedAtMs(parsePairCreatedAtMs(ms), now)
  assert.ok(days != null)
  assert.ok(Math.abs(days - 0.5) < 1e-9, 'DS pairCreatedAt 12h ago must become 0.5 days')
}
assert.match(routeCode, /Date\.parse\(attrs\.pool_created_at\)/, 'GeckoTerminal pool_created_at must be parsed into pairCreatedAtMs')
assert.match(routeCode, /parsePairCreatedAtMs\(pair\.pairCreatedAt\)/, 'DexScreener pairCreatedAt must be parsed into pairCreatedAtMs')
{
  const gt = candidate({ marketCapUsd: null, fdvUsd: 9_000_000, pairCreatedAtMs: null, source: 'geckoterminal' })
  const ds = candidate({ marketCapUsd: 1_250_000, fdvUsd: 9_000_000, pairCreatedAtMs: 1_700_000_000_000, source: 'dexscreener' })
  const merged = mergeNormalizedCandidate(gt, ds)
  assert.equal(merged.marketCapUsd, 1_250_000, 'GT null mcap must fill from later DS mcap')
  assert.equal(merged.pairCreatedAtMs, 1_700_000_000_000, 'GT null age must fill from later DS pairCreatedAt')
}
assert.equal(sanitizeMarketCapUsd(1_000_000, 1_000_000, true), null, 'DS marketCap===fdv stays null mcap')
assert.equal(sanitizeMarketCapUsd(1_000_000, 2_000_000, true), 1_000_000, 'DS mcap distinct from fdv is kept')
assert.equal(sanitizeMarketCapUsd(0, 2_000_000, false), null, '0 mcap is missing, not a real cap')
{
  const c = candidate({ marketCapUsd: 0, fdvUsd: null, priceChange24hPct: 10 })
  const r = evaluatePumpCandidate(c)
  assert.equal(r.qualified, false, '0 mcap with no FDV must be capDataMissing')
  assert.equal(r.reason, 'capDataMissing')
}
assert.match(routeCode, /pump:v4:/, 'cache key must bump to v4 so stale null-age/null-mcap entries die')
assert.doesNotMatch(routeCode, /pump:v3:/, 'the v3 cache key must be gone')
assert.match(routeCode, /r\.status === 'fulfilled'\)/, 'empty successful fetches must not count as provider failures')
assert.doesNotMatch(routeCode, /r\.status === 'fulfilled' && r\.value\.length > 0/, 'empty success must not be treated as a chain failure')
assert.match(pageCode, /activeChains\.size === CHAIN_CHIPS\.length/, 'clicking a chain while all are selected must isolate that chain')
assert.match(pageCode, /chainParamRef\.current = nextChains/, 'the fetch query must be written from the new set')
assert.match(pageCode, /toFixed\(1\)\}h/, 'sub-day age on the card must render as hours like the report')
assert.doesNotMatch(pageCode, /tokenAgeDays < 1 \? '<1d'/, 'cards must not collapse sub-day age to <1d')

console.log('test-pump-alerts-discovery.mjs: all assertions passed')
