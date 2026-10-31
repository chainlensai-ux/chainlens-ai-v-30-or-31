// Whale Alerts audit fixes: one side of a swap is its value (never both legs summed), routine stablecoin
// and base-asset churn is not a whale signal, one Activity feed (no Interesting tab), stablecoins are
// priced before any provider call, the feed is served stale-while-revalidate with one shared
// recompute, and the sync paces GoldRush, never re-tries a 429 on the same key, and never guesses 18
// decimals.
//   npx tsx --test tests/whale-alerts-curation.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { routineChurnReason, rowSymbols, SIGNIFICANT_BASE_ASSET_USD, tradeUsdValue } from '../lib/server/whaleFeedCuration'

const leg = (side: 'buy' | 'sell', token_symbol: string, amount_usd: number | null) => ({ side, token_symbol, amount_usd })

test('a USDC → TOKEN buy is worth what was paid, not both legs added together', () => {
  assert.equal(tradeUsdValue([leg('sell', 'USDC', 10_000), leg('buy', 'PEPE', 10_050)]), 10_000)
  // The token side priced by a market estimate never overrides the exact stablecoin paid.
  assert.equal(tradeUsdValue([leg('sell', 'USDC', 10_000), leg('buy', 'PEPE', 40_000)]), 10_000)
  // Paid with ETH + USDC: both base legs count; still one side.
  assert.equal(tradeUsdValue([leg('sell', 'USDC', 4_000), leg('sell', 'WETH', 6_000), leg('buy', 'AERO', 9_900)]), 10_000)
})

test('a sell is worth what came back; a token swap is its larger priced side; unpriced base side falls back', () => {
  assert.equal(tradeUsdValue([leg('sell', 'DEGEN', 5_100), leg('buy', 'USDC', 5_000)]), 5_000)
  assert.equal(tradeUsdValue([leg('sell', 'DEGEN', 2_000), leg('buy', 'AERO', 2_400)]), 2_400)
  assert.equal(tradeUsdValue([leg('sell', 'WETH', null), leg('buy', 'PEPE', 3_000)]), 3_000)
  assert.equal(tradeUsdValue([leg('sell', 'WETH', null), leg('buy', 'PEPE', null)]), null)
})

test('one-direction movements keep their own sum', () => {
  assert.equal(tradeUsdValue([leg('buy', 'PEPE', 700), leg('buy', 'AERO', 300)]), 1_000)
  assert.equal(tradeUsdValue([leg('sell', 'PEPE', null)]), null)
})

test('routine churn: stablecoin-only never shows; base-asset-only only when genuinely large', () => {
  assert.equal(routineChurnReason(rowSymbols('USDT'), 5_000_000), 'stablecoin_only')
  assert.equal(routineChurnReason(rowSymbols('USDC / USDT'), 250_000), 'stablecoin_only')
  assert.equal(routineChurnReason(rowSymbols('WETH'), 40_000), 'base_asset_churn')
  assert.equal(routineChurnReason(rowSymbols('USDC / WETH'), null), 'base_asset_churn', 'unpriced routine churn is not promoted')
  assert.equal(routineChurnReason(rowSymbols('USDC / WETH'), SIGNIFICANT_BASE_ASSET_USD), null)
  // A stablecoin leg that bought a real token is a token trade, never churn.
  assert.equal(routineChurnReason(rowSymbols('USDT / PEPE'), 2_000), null)
  assert.equal(routineChurnReason(rowSymbols('PEPE'), null), null)
})

const feed = readFileSync(new URL('../app/api/whale-alerts/route.ts', import.meta.url), 'utf8')
const sync = readFileSync(new URL('../app/api/whale-alerts/sync/route.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')

test('one Activity feed: no Interesting / All activity toggle, and the server ignores interesting=false', () => {
  assert.doesNotMatch(page, /'Interesting'|All activity|feedMode/)
  assert.doesNotMatch(page, /p\.set\('interesting'/)
  assert.match(feed, /const interestingMode = true/)
  assert.doesNotMatch(feed, /params\.get\('interesting'\)/)
})

test('feed and counters share one curation rule; grouped swaps use one side', () => {
  assert.match(feed, /amount_usd:\s+tradeUsd,/)
  assert.doesNotMatch(feed, /legs\.reduce\(\(s, l\) => s \+ \(\(l\.amount_usd/, 'grouped legs are never summed')
  assert.match(feed, /routineChurnReason\(rowSymbols\(row\.token_symbol\)/)
  assert.match(feed, /const usd = tradeUsdValue\(legs\)\n\s+if \(routineChurnReason\(symbols, usd\)/)
  assert.match(feed, /const STATS_SELECT = '[^']*\bside\b/)
})

test('verified stablecoins are priced before (and never sent to) the historical provider', () => {
  assert.match(feed, /&& !stablecoinShortcut\(row\)\n/)
  assert.match(feed, /const stableFirst = stablecoinShortcut\(row\)\n\s+if \(stableFirst\) return stableFirst/)
})

test('feed: stale-while-revalidate with one shared recompute per cache key', () => {
  assert.match(feed, /after\(\(\) => runSharedFeed\(cacheKey, compute\)/)
  assert.match(feed, /servedStale: true/)
  assert.match(feed, /const shared = feedInFlight\.get\(cacheKey\)/)
})

test('sync: GoldRush calls are paced, a 429 is not repeated on the same key, pages get 10s, no guessed decimals', () => {
  assert.match(sync, /await goldrushPricingGate\.wait\(\)\n\s+logRpcCall/)
  assert.match(sync, /response\.status === 401 \|\| response\.status === 403 \|\| response\.status === 429\) break/)
  assert.match(sync, /const PER_WALLET_TIMEOUT_MS = 10_000/)
  assert.doesNotMatch(sync, /sender_contract_decimals \?\? 18/)
  assert.match(sync, /decimalsResolution\.source === 'fallback_18' \? null/)
})
