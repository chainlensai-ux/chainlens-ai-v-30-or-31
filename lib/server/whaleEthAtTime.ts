// ETH/USD AT THE ALERT'S TIME for whale alerts whose historical lookup failed. Previously an ETH or
// WETH leg fell straight back to CoinGecko's CURRENT price, so a 20-hour-old trade was valued at
// today's ETH. The Chainlink ETH/USD feed read on-chain at the alert's own Base block is the price at
// that time (chainlinkEthUsd.ts), through this project's Alchemy RPC — a separate quota from the
// market-data providers that just failed. Bounded per feed computation; answers are immutable, so
// they are cached for the life of the process, per 5-minute bucket.

import { createChainlinkBaseEthUsdReader, type OnchainNativeUsdReader } from '@/src/modules/nativePriceResolver/chainlinkEthUsd'
import { alchemyRpcUrlFor } from '@/src/modules/providerFetchWindow/utils'

export const ETH_AT_TIME_BUCKET_MS = 5 * 60_000
export const ETH_AT_TIME_MAX_CALLS = 24
/** A feed answer older than this before the alert's time is not that time's price (heartbeat is 20 min). */
export const ETH_AT_TIME_MAX_STALENESS_SEC = 3_600

const cache = new Map<number, number>()
const MAX_CACHE = 2_000

export function __resetEthAtTimeCacheForTest(): void { cache.clear() }

export const ethAtTimeBucket = (timestampMs: number) => Math.floor(timestampMs / ETH_AT_TIME_BUCKET_MS) * ETH_AT_TIME_BUCKET_MS

/** ETH/USD per 5-minute bucket for the given alert timestamps. Unresolved buckets are absent. */
export async function fetchEthUsdAtTimes(
  timestampsMs: readonly number[],
  opts: { reader?: OnchainNativeUsdReader | null; maxCalls?: number; nowMs?: number } = {},
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const now = opts.nowMs ?? Date.now()
  // Newest first: the feed shows recent alerts first, so a capped run prices what is on screen.
  const buckets = [...new Set(timestampsMs.filter((t) => Number.isFinite(t) && t > 0 && t <= now).map(ethAtTimeBucket))].sort((a, b) => b - a)
  const missing: number[] = []
  for (const bucket of buckets) {
    const cached = cache.get(bucket)
    if (cached != null) out.set(bucket, cached)
    else missing.push(bucket)
  }
  if (missing.length === 0) return out
  let calls = 0
  const maxCalls = opts.maxCalls ?? ETH_AT_TIME_MAX_CALLS
  const reader = opts.reader !== undefined
    ? opts.reader
    : createChainlinkBaseEthUsdReader({ rpcUrl: alchemyRpcUrlFor('base'), consume: () => true })
  if (!reader) return out
  let cursor = 0
  const worker = async () => {
    while (cursor < missing.length) {
      if (calls >= maxCalls) return
      calls += 1
      const bucket = missing[cursor++]
      // Read at the bucket's end (capped at now) so the answer is the latest round at that time.
      const atSec = Math.floor(Math.min(bucket + ETH_AT_TIME_BUCKET_MS - 1, now) / 1000)
      const reading = await reader(atSec)
      if ('error' in reading) continue
      if (!(reading.priceUsd > 0) || atSec - reading.updatedAtSec > ETH_AT_TIME_MAX_STALENESS_SEC || reading.updatedAtSec > atSec + 60) continue
      out.set(bucket, reading.priceUsd)
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!)
      cache.set(bucket, reading.priceUsd)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker))
  return out
}
