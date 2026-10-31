// Whale Alerts remaining fixes: alerts are priced when stored (stablecoins exactly, fresh trades at the
// market price, labelled estimated), ETH legs the historical lookup missed are priced at the alert's own
// block instead of today's price, recently scanned wallets are not re-fetched and Sync continues to
// the end, and the 1h/6h/24h counters count the same unit as the feed (tx + wallet).
//   npx tsx --test tests/whale-alerts-remaining.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { priceAlertsAtIngestion, SYNC_PRICE_MAX_AGE_MS } from '../lib/server/whaleSyncPricing'
import { priceWhaleMovement } from '../lib/server/whaleUsdPricing'
import { __resetEthAtTimeCacheForTest, ETH_AT_TIME_BUCKET_MS, ethAtTimeBucket, fetchEthUsdAtTimes } from '../lib/server/whaleEthAtTime'
import { __resetWhaleDexPriceCacheForTest, fetchBaseDexScreenerPrices } from '../lib/server/whaleDexPrices'
import { splitFreshWallets, WALLET_FRESH_MS } from '../lib/server/whaleWalletOrder'

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const PEPE = '0x1111111111111111111111111111111111111111'
const NOW = Date.parse('2026-10-31T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

test('ingestion: verified stablecoin stored exactly, fresh token at market, old/unknown stay null', async () => {
  const rows: Array<Record<string, unknown>> = [
    { token_address: USDC, token_symbol: 'USDC', amount_token: 12_345.678, amount_usd: null, occurred_at: iso(5 * 3_600_000) },
    { token_address: PEPE, token_symbol: 'PEPE', amount_token: 1_000, amount_usd: null, occurred_at: iso(60_000) },
    { token_address: PEPE, token_symbol: 'PEPE', amount_token: 1_000, amount_usd: null, occurred_at: iso(SYNC_PRICE_MAX_AGE_MS + 60_000) },
    { token_address: PEPE, token_symbol: 'PEPE', amount_token: null, amount_usd: null, occurred_at: iso(60_000) },
    // A spoofed "USDC" symbol on another contract is not a stablecoin.
    { token_address: '0x2222222222222222222222222222222222222222', token_symbol: 'USDC', amount_token: 500, amount_usd: null, occurred_at: iso(60_000) },
  ]
  const asked: string[][] = []
  const result = await priceAlertsAtIngestion(rows, NOW, async (addresses) => { asked.push(addresses); return new Map([[PEPE, 0.5]]) })
  assert.equal(rows[0].amount_usd, 12_345.68)
  assert.equal(rows[1].amount_usd, 500)
  assert.equal(rows[2].amount_usd, null, 'too old for a current price')
  assert.equal(rows[3].amount_usd, null, 'unknown amount is never priced')
  assert.equal(rows[4].amount_usd, null, 'spoofed stablecoin with no market price stays null')
  assert.deepEqual(result, { stablecoin: 1, market: 1, tooOld: 1, unpriced: 1 })
  assert.equal(asked.length, 1, 'one batched price request')
})

test('ingestion: no request when nothing needs a market price; provider failure leaves null', async () => {
  let calls = 0
  await priceAlertsAtIngestion([{ token_address: USDC, token_symbol: 'USDC', amount_token: 5, occurred_at: iso(0) }], NOW, async () => { calls++; return new Map() })
  assert.equal(calls, 0)
  const row: Record<string, unknown> = { token_address: PEPE, token_symbol: 'PEPE', amount_token: 5, occurred_at: iso(0) }
  const r = await priceAlertsAtIngestion([row], NOW, async () => { throw new Error('down') })
  assert.equal(row.amount_usd, undefined)
  assert.equal(r.unpriced, 1)
})

test('a stored value is "verified" only for a verified stablecoin; otherwise it is an estimate', () => {
  const stable = priceWhaleMovement({ token_address: USDC, token_symbol: 'USDC', amount_token: 100, amount_usd: 100 }, null)
  assert.equal(stable.audit.finalUsdStatus, 'verified')
  assert.equal(stable.audit.priceSourceUsed, 'stored_tx_usd')
  const token = priceWhaleMovement({ token_address: PEPE, token_symbol: 'PEPE', amount_token: 1_000, amount_usd: 500 }, null)
  assert.equal(token.amountUsd, 500)
  assert.equal(token.audit.finalUsdStatus, 'estimated')
  assert.equal(token.audit.priceSourceUsed, 'stored_sync_market_price')
  assert.equal(token.audit.priceUsd, 0.5)
})

test('ETH at the alert time: Chainlink reading per 5-min bucket, stale or failed readings rejected, capped', async () => {
  __resetEthAtTimeCacheForTest()
  const seen: number[] = []
  const reader = async (atSec: number) => {
    seen.push(atSec)
    if (atSec % 2 === 1 && seen.length === 2) return { error: 'chainlink_rpc_error' }
    return { priceUsd: 2_500 + seen.length, updatedAtSec: atSec - 60 }
  }
  const t1 = NOW - 3 * 3_600_000
  const prices = await fetchEthUsdAtTimes([t1, t1 + 1_000], { reader, nowMs: NOW })
  assert.equal(seen.length, 1, 'same bucket read once')
  assert.equal(prices.get(ethAtTimeBucket(t1)), 2_501)
  assert.equal(seen[0], Math.floor((ethAtTimeBucket(t1) + ETH_AT_TIME_BUCKET_MS - 1) / 1000))

  // Cached: no further reads.
  await fetchEthUsdAtTimes([t1], { reader, nowMs: NOW })
  assert.equal(seen.length, 1)

  const stale = await fetchEthUsdAtTimes([NOW - 7_200_000], { reader: async (at) => ({ priceUsd: 2_000, updatedAtSec: at - 7_200 }), nowMs: NOW })
  assert.equal(stale.size, 0, 'a reading two hours old is not that time\'s price')

  let n = 0
  const capped = await fetchEthUsdAtTimes(Array.from({ length: 10 }, (_, i) => NOW - 86_000_000 + i * ETH_AT_TIME_BUCKET_MS), { reader: async (at) => { n++; return { priceUsd: 3_000, updatedAtSec: at } }, maxCalls: 3, nowMs: NOW })
  assert.equal(n, 3)
  assert.equal(capped.size, 3)
  assert.equal((await fetchEthUsdAtTimes([NOW - 50_000_000], { reader: null, nowMs: NOW })).size, 0, 'no RPC configured → nothing')
})

test('DexScreener batch: Base base-token pairs only, highest liquidity wins, cached', async () => {
  __resetWhaleDexPriceCacheForTest()
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return new Response(JSON.stringify({ pairs: [
      { chainId: 'base', baseToken: { address: PEPE }, priceUsd: '0.4', liquidity: { usd: 10 } },
      { chainId: 'base', baseToken: { address: PEPE }, priceUsd: '0.5', liquidity: { usd: 1_000 } },
      { chainId: 'ethereum', baseToken: { address: PEPE }, priceUsd: '9', liquidity: { usd: 1e9 } },
      { chainId: 'base', baseToken: { address: USDC }, quoteToken: { address: PEPE }, priceUsd: '1', liquidity: { usd: 1e9 } },
    ] }), { status: 200 })
  }) as typeof fetch
  const prices = await fetchBaseDexScreenerPrices([PEPE], fetchImpl)
  assert.deepEqual([...prices], [[PEPE, 0.5]])
  await fetchBaseDexScreenerPrices([PEPE.toUpperCase().replace('0X', '0x')], fetchImpl)
  assert.equal(calls, 1)
})

test('fresh wallets are skipped, and reaching them completes the round', () => {
  const w = (msAgo: number | null) => ({ last_scanned_at: msAgo == null ? null : iso(msAgo) })
  const split = splitFreshWallets([w(null), w(3_600_000), w(WALLET_FRESH_MS - 1_000), w(1_000)], NOW)
  assert.equal(split.stale.length, 2)
  assert.equal(split.fresh.length, 2)
  assert.equal(split.reachedFresh, true)
  assert.equal(splitFreshWallets([w(null), w(WALLET_FRESH_MS + 1)], NOW).reachedFresh, false)
})

const feed = readFileSync(new URL('../app/api/whale-alerts/route.ts', import.meta.url), 'utf8')
const sync = readFileSync(new URL('../app/api/whale-alerts/sync/route.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')

test('wiring: sync prices before persisting, feed uses on-chain ETH before the current price, counters per tx+wallet', () => {
  assert.match(sync, /syncPricing = await priceAlertsAtIngestion\(allFilteredAlerts/)
  assert.ok(sync.indexOf('priceAlertsAtIngestion(allFilteredAlerts') < sync.indexOf('persistWhaleAlerts(supabase'))
  assert.match(sync, /done = processedTotal >= trackedWalletsTotal \|\| \(freshSplit\.reachedFresh && !earlyStopped\)/)
  assert.ok(feed.indexOf("'chainlink_onchain_at_tx'") < feed.indexOf("sourceUsed: majorPrices.eth ? 'coingecko_current'"))
  assert.match(feed, /const STATS_SELECT = '[^']*\bwallet_address\b/)
  assert.match(feed, /`\$\{r\.tx_hash\}::\$\{\(r\.wallet_address \?\? ''\)\.toLowerCase\(\)\}`/)
  assert.match(page, /for \(let round = 0; round < 50; round \+= 1\)/)
})
