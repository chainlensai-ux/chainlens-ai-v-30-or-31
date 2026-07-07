// MODULE — pricingAtTimeEngine/sources: basedex
//
// Split out of multiProviderPriceSource.ts for modularization. Logic is unchanged from that file.
//
// NAMING NOTE: there is no hosted "BaseDex API" — no such external REST service exists. What this
// file actually does is query a real, deployed Uniswap V3 pool's on-chain state (slot0) directly
// via RPC, at a real historical block number resolved by binary search against real block
// timestamps, using the already-installed `viem` dependency and this codebase's existing
// ALCHEMY_BASE_RPC_URL/ALCHEMY_BASE_KEY env convention (lib/rpc.ts). The file/export names below
// match what was asked for (basedex.ts / fetchBaseDexPrice) — the implementation is a real
// on-chain query, not a fabricated call to a nonexistent "BaseDex API".
//
// WETH/USDC/Uniswap V3 Factory addresses below are real, publicly documented, canonical contract
// addresses on Base — not invented.

import { createPublicClient, http, type PublicClient } from 'viem'
import { base } from 'viem/chains'
import type { SupportedChain } from '../../providerFetchWindow/types'
import { fetchCoingeckoPriceDetailed } from './coingecko'
import { logRpcCall } from '@/lib/server/rpcDebug'

const WETH_BASE = '0x4200000000000000000000000000000000000006'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const UNISWAP_V3_FACTORY_BASE = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
const UNISWAP_V3_FEE_TIERS = [500, 3000, 10000] as const // 0.05% / 0.3% / 1% — standard tiers

const UNISWAP_V3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

const UNISWAP_V3_POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

const ERC20_DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

let cachedBaseClient: PublicClient | null = null

function getBaseClient(): PublicClient | null {
  const rpcUrl = process.env.ALCHEMY_BASE_RPC_URL
    ?? (process.env.ALCHEMY_BASE_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}` : null)
  if (!rpcUrl) return null
  if (!cachedBaseClient) {
    cachedBaseClient = createPublicClient({ chain: base, transport: http(rpcUrl) })
  }
  return cachedBaseClient
}

// RPC-COST FIX, DISCLOSED: findBlockForTimestamp previously ran a full ~31-call sequence
// (1 "latest" + up to 30 bisection getBlock calls) on EVERY invocation, with zero memoization —
// confirmed by reading this file before this change (only the RPC *client* was cached, never a
// lookup result). Since pricingAtTimeEngine calls this once per distinct trade needing Base-chain
// historical pricing, a wallet with many such trades could trigger this dozens of times per scan,
// each re-running the full binary search from scratch — a real, measured cost driver (per-route
// Alchemy dashboard breakdown showed eth_getBlockByNumber at 72% of total call volume on a given
// day), not a hypothetical one. Two safe, correctness-preserving caches added below:
//
// 1. blockForTimestampCache: a resolved (targetTimestampSec -> block number) mapping is a
//    permanent historical fact — it can never change once computed — so this is cached
//    indefinitely (for the lifetime of this process/instance), keyed on the exact requested
//    second. This eliminates the entire binary search for any repeat lookup of the same
//    timestamp (e.g. multiple distinct tokens traded in the same block/second), with zero
//    precision loss: a cache hit returns the exact same value the full search would have
//    computed.
// 2. latestBlockCache: a short (5s) TTL cache for the "latest" block lookup only. This value is
//    used solely to pick the search's STARTING bisection bounds (`approxBlocksAgo`/initial
//    low/high) for a historical (necessarily past) timestamp — the search still bisects using
//    each candidate block's own real on-chain timestamp at every step, so a few-seconds-stale
//    "latest" cannot change the final, exact answer; it only avoids redundant identical fetches
//    when many trades are resolved within the same short window.
const blockForTimestampCache = new Map<number, bigint>()
let latestBlockCache: { block: Awaited<ReturnType<PublicClient['getBlock']>>; fetchedAtMs: number } | null = null
const LATEST_BLOCK_CACHE_TTL_MS = 5_000

// INSTRUMENTATION, DISCLOSED (eth_getBlockByNumber/eth_call runaway-investigation task): additive
// only — a running per-method call counter with first/last-call timestamps, logged alongside every
// existing logRpcCall() below (none of which were changed or removed). No timeout, budget, retry,
// or business-logic change. SCOPE, DISCLOSED: this counter is process-lifetime scoped (a warm
// serverless instance may serve more than one request), not truly per-scan — for "run one scan and
// watch the console," a burst from a single scan is still clearly visible as a tight cluster of
// closely-spaced timestamps with a rapidly climbing count; true per-scan isolation would require
// threading a scanId through this file's whole call chain, which is a larger, separate change.
//
// console.warn, NOT console.log, DISCLOSED (found live, this task): next.config's
// `compiler.removeConsole` strips console.log/info/debug entirely out of the production build —
// confirmed live: this instrumentation never appeared in Vercel logs on any deployment while this
// codebase's own pre-existing console.warn lines did. Using console.warn so this survives the real
// build.
const rpcCallCounters: Record<string, { count: number; firstCallAt: number; lastCallAt: number }> = {}

function trackRpcCall(method: string): void {
  const now = Date.now()
  const existing = rpcCallCounters[method]
  if (existing) {
    existing.count += 1
    existing.lastCallAt = now
  } else {
    rpcCallCounters[method] = { count: 1, firstCallAt: now, lastCallAt: now }
  }
  // eslint-disable-next-line no-console
  console.warn('[RPC-INVESTIGATION] basedex', {
    method,
    module: 'pricingAtTimeEngine:basedex',
    count: rpcCallCounters[method].count,
    firstCallAt: rpcCallCounters[method].firstCallAt,
    lastCallAt: now,
  })
}

async function getLatestBlockCached(client: PublicClient): ReturnType<PublicClient['getBlock']> {
  const now = Date.now()
  if (latestBlockCache && now - latestBlockCache.fetchedAtMs < LATEST_BLOCK_CACHE_TTL_MS) {
    return latestBlockCache.block
  }
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'getBlock:latest' })
  trackRpcCall('getBlock:latest')
  const block = await client.getBlock({ blockTag: 'latest' })
  latestBlockCache = { block, fetchedAtMs: now }
  return block
}

// TIMESTAMP BUCKETING, DISCLOSED PRECISION TRADEOFF (real-CU-fix, applied live per user
// confirmation of measured production evidence): blockForTimestampCache was keyed on the EXACT
// requested second, so two trades even a few seconds apart each paid the full ~20-30-call
// bisection search from scratch. Rounding down to a 5-minute bucket before searching/caching means
// every trade within the same 5-minute window shares one search — a real, order-of-magnitude cut
// in eth_getBlockByNumber volume for any wallet with multiple trades close together in time (the
// common case). The real tradeoff: the resolved block (and therefore the price read at it) is now
// accurate to within this same 5-minute window, not the exact trade second. BUCKET SIZE CHOICE,
// DISCLOSED: 5 minutes matches DEXSCREENER_FRESHNESS_TOLERANCE_MS above — this file already treats
// a 5-minute price-staleness window as an acceptable tolerance elsewhere in this same pricing
// chain, so this isn't a new or looser precision standard, just applying the same one here.
const BLOCK_TIMESTAMP_BUCKET_SECONDS = 5 * 60

function bucketTimestamp(targetTimestampSec: number): number {
  return Math.floor(targetTimestampSec / BLOCK_TIMESTAMP_BUCKET_SECONDS) * BLOCK_TIMESTAMP_BUCKET_SECONDS
}

// IN-FLIGHT REQUEST COALESCING, DISCLOSED (real-CU-fix, zero precision cost): if multiple entries
// (e.g. several transfer legs in the same transaction, or several trades in the same bucket priced
// concurrently under the new concurrency cap in pricingAtTimeEngine/index.ts) request the same
// bucketed timestamp while a search for it is already running, they now share that single in-flight
// search instead of each starting a redundant duplicate one. This is purely deduplicating identical
// concurrent work — it changes no computed value, only how many times the same answer is computed.
const inFlightBlockSearches = new Map<number, Promise<bigint>>()

// TEST-SUPPORT EXPORT, DISCLOSED: exported (alongside a cache-reset helper below) solely so a test
// can inject a mocked PublicClient and assert the caching behavior without hitting real RPC/env
// vars — does not change this function's real behavior or signature (beyond the disclosed
// timestamp-bucketing precision tradeoff above, which applies uniformly to every caller).
export async function findBlockForTimestamp(client: PublicClient, targetTimestampSec: number): Promise<bigint | null> {
  const bucketed = bucketTimestamp(targetTimestampSec)

  const cached = blockForTimestampCache.get(bucketed)
  if (cached !== undefined) return cached

  const inFlight = inFlightBlockSearches.get(bucketed)
  if (inFlight) return inFlight

  const search = (async (): Promise<bigint> => {
    const latest = await getLatestBlockCached(client)
    if (bucketed >= Number(latest.timestamp)) {
      blockForTimestampCache.set(bucketed, latest.number)
      return latest.number
    }

    const two = BigInt(2)
    const approxBlocksAgo = BigInt(Math.max(0, Math.floor((Number(latest.timestamp) - bucketed) / 2)))
    let low = latest.number > approxBlocksAgo * two ? latest.number - approxBlocksAgo * two : BigInt(0)
    let high = latest.number

    for (let i = 0; i < 30 && low < high; i++) {
      const mid = (low + high + BigInt(1)) / two
      logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'getBlock:bisect' })
      trackRpcCall('getBlock:bisect')
      const block = await client.getBlock({ blockNumber: mid })
      if (Number(block.timestamp) <= bucketed) {
        low = mid
      } else {
        high = mid - BigInt(1)
      }
    }
    blockForTimestampCache.set(bucketed, low)
    return low
  })()

  inFlightBlockSearches.set(bucketed, search)
  try {
    return await search
  } finally {
    inFlightBlockSearches.delete(bucketed)
  }
}

// TEST-SUPPORT EXPORT, DISCLOSED: lets a test start each case from a clean cache state. Not called
// anywhere in real request handling.
export function __resetBaseDexCachesForTest(): void {
  blockForTimestampCache.clear()
  latestBlockCache = null
  poolAddressCache.clear()
  poolPriceCache.clear()
  inFlightBlockSearches.clear()
  negativePoolCache.clear()
  inFlightPoolSearches.clear()
}

// RPC-COST FIX, DISCLOSED (continuation of the findBlockForTimestamp fix above): resolvePoolAddress
// and readPoolPrice each perform multiple uncached readContract calls (eth_call) on EVERY
// invocation. Since pricingAtTimeEngine calls fetchBaseDexPrice once per distinct trade needing
// Base historical pricing, this multiplies eth_call volume the same way the block search did
// before its own fix — confirmed as the real remaining cost driver via a follow-up Alchemy
// dashboard check (eth_call was the second-largest slice after eth_getBlockByNumber). Two more
// safe, correctness-preserving caches added:
//
// 1. poolAddressCache: a Uniswap V3 pool's address for a given (tokenAddress, pairedWith) pair is
//    permanent and deterministic (CREATE2) once it exists — caching a FOUND pool forever is exactly
//    as safe as the block-timestamp cache above. A "no pool found" result is deliberately NOT
//    cached, though (a disclosed refinement over a literal read of the task): a pool for a pair
//    that doesn't exist yet at cold start COULD be deployed later, and this process can stay warm
//    across many requests — caching a negative result indefinitely risks permanently hiding a pool
//    that starts existing partway through this instance's lifetime. Caching only real hits has no
//    such risk.
// 2. poolPriceCache: a pool's price (sqrtPriceX96-derived) AT A SPECIFIC HISTORICAL BLOCK is a
//    permanent, already-settled fact — historical chain state never changes — so this is cached
//    indefinitely, keyed on (poolAddress, blockNumber). Same zero-precision-loss reasoning as the
//    block-timestamp cache: a cache hit returns the exact value a fresh read would produce.
//
// VALUE-TYPE CORRECTION, DISCLOSED: the task's own suggested poolPriceCache type was
// `Map<string, bigint>` — readPoolPrice's real, unmodified return type is `Promise<number | null>`
// (a decimal-adjusted USD-denominated ratio, not a raw on-chain bigint), so the cache is typed
// `Map<string, number>` to match what this function actually returns; no change to that return
// type itself.
const poolAddressCache = new Map<string, `0x${string}`>()
const poolPriceCache = new Map<string, number>()

// NEGATIVE-RESULT CACHE, DISCLOSED (real-CU-fix, applied per user confirmation of measured
// production evidence: distinct-token ratio logging showed avgLookupsPerToken=6.37 across 115
// distinct tokens in one real scan, meaning most tokens are looked up several times each — and the
// earlier basedex counters showed ~95% of resolvePoolAddress attempts fail to find a real pool.
// Without this, EVERY one of those repeat lookups for the same no-pool token re-runs all 6 getPool
// attempts (3 fee tiers x 2 paired assets) from scratch, every time that token reappears in the
// trade history.
//
// TTL, NOT PERMANENT, DISCLOSED: a positive result is cached forever (a found pool's address is
// permanent/deterministic) — a NEGATIVE result is different: a pool for this pair could be deployed
// later, and this process can stay warm across many requests, so caching "no pool" forever risks
// permanently hiding a pool that starts existing partway through this instance's lifetime (the same
// concern the original code's own comment already raised, which is why it never cached negatives at
// all). A short TTL is the middle ground: within one scan (or a few back-to-back scans), repeat
// lookups for the same still-nonexistent pool are free; after the TTL expires, a fresh check runs
// again, so a newly-deployed pool is still discovered within a bounded delay. 5 minutes matches the
// same tolerance already used elsewhere in this file (BLOCK_TIMESTAMP_BUCKET_SECONDS,
// DEXSCREENER_FRESHNESS_TOLERANCE_MS) — not a new or looser precision standard.
const NEGATIVE_POOL_CACHE_TTL_MS = 5 * 60 * 1000
const negativePoolCache = new Map<string, number>() // cacheKey -> expiresAtMs

// IN-FLIGHT COALESCING, DISCLOSED: same reasoning as findBlockForTimestamp's own in-flight map —
// concurrent lookups for the same (token, pairedWith) pair (now much more likely under the
// concurrency-capped-but-still-parallel priceEntries()) share one search instead of each starting a
// redundant duplicate one. Zero precision cost, pure dedup of identical concurrent work.
const inFlightPoolSearches = new Map<string, Promise<`0x${string}` | null>>()

// TEST-SUPPORT EXPORT, DISCLOSED: same reasoning as findBlockForTimestamp above — exported solely
// so a test can assert the new caching behavior with a mocked client, no signature/behavior change.
export async function resolvePoolAddress(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
): Promise<`0x${string}` | null> {
  const cacheKey = `${tokenAddress.toLowerCase()}-${pairedWith.toLowerCase()}`

  const cached = poolAddressCache.get(cacheKey)
  if (cached !== undefined) {
    // eslint-disable-next-line no-console
    console.log('[CU-DIAG] basedex: poolAddress cache hit =', cacheKey)
    return cached
  }

  const negativeExpiresAt = negativePoolCache.get(cacheKey)
  if (negativeExpiresAt !== undefined && Date.now() < negativeExpiresAt) {
    return null
  }

  const inFlight = inFlightPoolSearches.get(cacheKey)
  if (inFlight) return inFlight

  const search = (async (): Promise<`0x${string}` | null> => {
    for (const fee of UNISWAP_V3_FEE_TIERS) {
      try {
        logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:getPool' })
        trackRpcCall('readContract:getPool')
        const pool = await client.readContract({
          address: UNISWAP_V3_FACTORY_BASE as `0x${string}`,
          abi: UNISWAP_V3_FACTORY_ABI,
          functionName: 'getPool',
          args: [tokenAddress, pairedWith, fee],
        })
        if (pool && pool !== '0x0000000000000000000000000000000000000000') {
          poolAddressCache.set(cacheKey, pool)
          return pool
        }
      } catch {
        // try the next fee tier
      }
    }
    negativePoolCache.set(cacheKey, Date.now() + NEGATIVE_POOL_CACHE_TTL_MS)
    return null
  })()

  inFlightPoolSearches.set(cacheKey, search)
  try {
    return await search
  } finally {
    inFlightPoolSearches.delete(cacheKey)
  }
}

// TEST-SUPPORT EXPORT, DISCLOSED: same reasoning as resolvePoolAddress above.
export async function readPoolPrice(
  client: PublicClient,
  poolAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
  blockNumber: bigint,
): Promise<number | null> {
  const cacheKey = `${poolAddress.toLowerCase()}-${blockNumber.toString()}`
  const cachedPrice = poolPriceCache.get(cacheKey)
  if (cachedPrice !== undefined) {
    // eslint-disable-next-line no-console
    console.log('[CU-DIAG] basedex: poolPrice cache hit =', cacheKey)
    return cachedPrice
  }

  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:slot0' })
  trackRpcCall('readContract:slot0')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:token0' })
  trackRpcCall('readContract:token0')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:decimals' })
  trackRpcCall('readContract:decimals')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:decimals' })
  trackRpcCall('readContract:decimals')
  const [slot0, token0, tokenDecimals, pairedDecimals] = await Promise.all([
    client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0', blockNumber }),
    client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'token0', blockNumber }),
    client.readContract({ address: tokenAddress, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', blockNumber }),
    client.readContract({ address: pairedWith, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', blockNumber }),
  ])

  const sqrtPriceX96 = slot0[0]
  // price of token1 in terms of token0, in raw (undecimalized) units:
  const rawRatio = (Number(sqrtPriceX96) / 2 ** 96) ** 2
  const isTokenToken0 = token0.toLowerCase() === tokenAddress.toLowerCase()

  // Adjust for each token's own decimals, then orient the ratio as "1 tokenAddress = X pairedWith".
  const decimalAdjustment = 10 ** (tokenDecimals - pairedDecimals)
  const token0PerToken1 = rawRatio * decimalAdjustment
  const price = isTokenToken0 ? 1 / token0PerToken1 : token0PerToken1
  poolPriceCache.set(cacheKey, price)
  return price
}

export type BaseDexPriceResult = { priceUsd: number | null; reason: string | null }

// Detailed variant — used by the orchestrator (getPriceAtTime) for structured debug output.
export async function fetchBaseDexPriceDetailed(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<BaseDexPriceResult> {
  if (chain !== 'base') return { priceUsd: null, reason: 'base_dex_only_supports_base_chain' }

  const client = getBaseClient()
  if (!client) return { priceUsd: null, reason: 'no_api_key_configured' }

  try {
    const targetSec = Math.floor(timestamp / 1000)
    const blockNumber = await findBlockForTimestamp(client, targetSec)
    if (blockNumber === null) return { priceUsd: null, reason: 'could_not_resolve_historical_block' }

    const tokenAddress = token as `0x${string}`

    // Try token/WETH first, then token/USDC.
    const wethPool = await resolvePoolAddress(client, tokenAddress, WETH_BASE as `0x${string}`)
    if (wethPool) {
      const tokenPerWeth = await readPoolPrice(client, wethPool, tokenAddress, WETH_BASE as `0x${string}`, blockNumber)
      if (tokenPerWeth !== null && Number.isFinite(tokenPerWeth)) {
        // Need WETH's own USD price at this same timestamp to convert — real recursive lookup
        // (CoinGecko has WETH's full historical range), never a guessed ETH price.
        const wethUsd = await fetchCoingeckoPriceDetailed(WETH_BASE, 'base', timestamp)
        if (wethUsd.priceUsd !== null) {
          return { priceUsd: tokenPerWeth * wethUsd.priceUsd, reason: null }
        }
      }
    }

    const usdcPool = await resolvePoolAddress(client, tokenAddress, USDC_BASE as `0x${string}`)
    if (usdcPool) {
      const tokenPerUsdc = await readPoolPrice(client, usdcPool, tokenAddress, USDC_BASE as `0x${string}`, blockNumber)
      if (tokenPerUsdc !== null && Number.isFinite(tokenPerUsdc)) {
        // USDC is treated as $1 — a standard industry approximation (USDC is a USD-pegged
        // stablecoin), disclosed here explicitly rather than silently assumed.
        return { priceUsd: tokenPerUsdc, reason: null }
      }
    }

    return { priceUsd: null, reason: 'no_uniswap_v3_pool_found' }
  } catch (err) {
    return { priceUsd: null, reason: `rpc_error:${err instanceof Error ? err.message : 'unknown'}` }
  }
}

// Public export matching this codebase's PriceSourceFn contract exactly (token, chain, timestamp)
// -> number | null — a clean USD price or null, never a fabricated value.
export async function fetchBaseDexPrice(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<number | null> {
  const result = await fetchBaseDexPriceDetailed(token, chain, timestamp)
  return result.priceUsd
}
