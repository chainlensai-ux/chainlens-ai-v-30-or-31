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

import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, type PublicClient } from 'viem'
import { base } from 'viem/chains'
import type { SupportedChain } from '../../providerFetchWindow/types'
import { fetchCoingeckoPriceDetailed } from './coingecko'
import { logRpcCall } from '@/lib/server/rpcDebug'

const WETH_BASE = '0x4200000000000000000000000000000000000006'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const UNISWAP_V3_FACTORY_BASE = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
const UNISWAP_V3_FEE_TIERS = [500, 3000, 10000] as const // 0.05% / 0.3% / 1% — standard tiers

// MULTICALL-BATCHING FIX, DISCLOSED (real-CU-fix, applied per user confirmation of measured
// production evidence): resolvePoolAddress made up to 3 separate eth_call requests per (token,
// pairedWith) pair (one per fee tier, sequentially), and readPoolPrice made 4 separate eth_call
// requests per pool (slot0, token0, and 2x decimals) — together the single largest remaining
// basedex RPC cost after the block-search and negative-cache fixes (607 + 828 = 1,435 calls in one
// measured scan). Multicall3 is a standard, canonical contract deployed at this same address on
// virtually every EVM chain (including Base) that batches N read-only contract calls into ONE
// eth_call, each with its own independent success/failure — same on-chain data, same explicit
// historical block number per call, decoded exactly as the individual calls would decode, just
// fewer RPC round-trips to get there. Zero precision/accuracy cost: nothing about which contracts,
// functions, or block number get queried changes, only how many separate calls it takes.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

const MULTICALL3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'view',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const

type Multicall3Call = { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }
type Multicall3Result = { success: boolean; returnData: `0x${string}` }

// FALLBACK SAFETY, DISCLOSED: Multicall3 wasn't deployed on Base from block 0 — it went live
// shortly after Base's mainnet launch, at whatever block its CREATE2 deployment transaction landed
// in. A scan pricing a trade from before that block would get a real eth_call failure (no contract
// at that address yet at that historical block). Every caller of this helper below wraps it in a
// try/catch and falls back to the original, pre-multicall sequential-calls implementation in that
// case — so the worst case for very early Base history is "costs what it used to," never a wrong
// or missing price.
async function multicall(
  client: PublicClient,
  calls: Multicall3Call[],
  blockNumber?: bigint,
): Promise<Multicall3Result[]> {
  const data = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: 'aggregate3', args: [calls] })
  const raw = blockNumber !== undefined
    ? await client.call({ to: MULTICALL3_ADDRESS, data, blockNumber })
    : await client.call({ to: MULTICALL3_ADDRESS, data })
  if (!raw.data) throw new Error('multicall: no return data')
  const decoded = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', data: raw.data })
  return decoded as unknown as Multicall3Result[]
}

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

// LOG-VOLUME FIX, DISCLOSED (found live, this task): this used to console.warn on EVERY call, one
// line per RPC — for a scan with hundreds/thousands of calls, that volume alone was blowing past
// Vercel's per-invocation log capture limit, so the one line that actually matters (the final
// summary below) never made it into what the dashboard showed. Counting still happens on every
// call (unchanged); only the per-call console line is removed, since logBaseDexFinalTotals()
// already reports the same counts in one line that's guaranteed to survive.
function trackRpcCall(method: string): void {
  const now = Date.now()
  const existing = rpcCallCounters[method]
  if (existing) {
    existing.count += 1
    existing.lastCallAt = now
  } else {
    rpcCallCounters[method] = { count: 1, firstCallAt: now, lastCallAt: now }
  }
  totalBaseDexRpcCallsThisScan += 1
}

// SCAN-LEVEL RPC BUDGET, DISCLOSED (real-latency-fix): a real, measured scan showed this file's
// FINAL TOTALS line reporting 600-900+ RPC calls per pricing pass (getBlock:estimate/bisect,
// readContract:multicall), repeated across multiple passes in one scan — this deployment's own
// Vercel region (syd1, Sydney) is geographically distant from Alchemy's Base RPC infrastructure, so
// each of those calls pays real cross-continent round-trip latency; even the already-reduced ~8-9
// step bisection window (see estimateAndVerifyWindow's own header above) compounds across ~130+
// distinct tokens into a real, measured contributor to exceeding the outer 270s worker-global
// timeout (workers/walletScanV2.ts). Earlier fixes in this file already cut per-token call count
// substantially (bucketing, window estimation, in-flight coalescing) — this budget is the backstop
// for what's left: once TOTAL calls across this whole scan (all methods combined) cross
// MAX_BASEDEX_RPC_CALLS_PER_SCAN, findBlockForTimestamp stops making further real calls and returns
// null for any NOT-YET-CACHED bucket, same as a genuine "no data" answer from this source — pricing
// falls through to whatever this token's real upstream evidence already produced (or stays
// unpriced, the same honest outcome an unindexed token already gets). NEVER FABRICATES: this only
// ever produces the same null an exhausted/failed search would, just without paying for the rest of
// it. A bucket already resolved and cached is still served instantly regardless of the budget.
const MAX_BASEDEX_RPC_CALLS_PER_SCAN = 300
let totalBaseDexRpcCallsThisScan = 0

function baseDexScanBudgetExceeded(): boolean {
  return totalBaseDexRpcCallsThisScan >= MAX_BASEDEX_RPC_CALLS_PER_SCAN
}

// SCAN-BOUNDARY RESET, DISCLOSED: called once per scan (see src/modules/walletScanWorker.ts,
// alongside its existing resetAlchemyAudit() call) so this budget is genuinely per-scan, not
// process-lifetime — a warm serverless instance serving a second, unrelated scan must start this
// budget fresh rather than inheriting the previous scan's exhausted counter. Deliberately does NOT
// clear blockForTimestampCache/poolAddressCache/poolPriceCache (this file's own
// __resetBaseDexCachesForTest already does that, test-only) — a resolved historical block or pool
// address is a permanent fact that stays valid and worth keeping warm across scans.
export function resetBaseDexRpcBudgetForScan(): void {
  totalBaseDexRpcCallsThisScan = 0
}

// FINAL-TOTALS SUMMARY, DISCLOSED: one log line, callable once a scan's pricing pass finishes,
// reporting the cumulative count for every RPC method tracked above. Added because the per-call
// stream (one line per RPC call, hundreds/thousands per scan) is impractical to scroll through in
// the Vercel log viewer — this gives a single line with the real final numbers to compare against a
// prior baseline, with zero change to any cache/business logic.
export function logBaseDexFinalTotals(): void {
  const totals: Record<string, number> = {}
  for (const [method, entry] of Object.entries(rpcCallCounters)) {
    totals[method] = entry.count
  }
  // eslint-disable-next-line no-console
  console.warn('[RPC-INVESTIGATION] basedex FINAL TOTALS', { totals, timestamp: Date.now() })
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

// AVG BLOCK TIME ESTIMATE, DISCLOSED: Base has a near-constant ~2s block time (OP-stack chain).
// Used ONLY to pick a starting guess for the search below — never trusted as the final answer.
// Every guess this produces is verified (and corrected, via bisection) against real on-chain block
// timestamps before being accepted, so drift in the true average block time can only cost a few
// extra RPC calls (a wider search window), never an incorrect resolved block.
const BASE_AVG_BLOCK_TIME_SEC = 2
const ESTIMATE_SEARCH_WINDOW_BLOCKS = BigInt(256)
const ESTIMATE_SEARCH_MAX_WIDEN_ATTEMPTS = 4

// BISECT-COST FIX, DISCLOSED (real-CU-fix, applied per user confirmation of measured production
// evidence — a single scan's FINAL TOTALS line showed 6,821 getBlock:bisect calls, ~11x more than
// every other basedex method combined, after the earlier caching/coalescing fixes already landed).
// ROOT CAUSE: the old bounds here (`approxBlocksAgo * 2` below latest, `latest.number` above) still
// spanned a huge fraction of chain history for any timestamp more than a few hours old, so the
// 30-step bisection loop almost always ran close to its full 30 iterations — one getBlock call per
// step — for EVERY distinct (bucketed) timestamp, even though Base's block time is close enough to
// constant that a direct estimate lands within a few hundred blocks almost every time.
//
// FIX: estimate the target block directly from Base's average block time, verify it against one
// real on-chain probe, self-calibrate a LOCAL average block time from that probe (latest.timestamp
// vs probe.timestamp), and bisect only a small window (256 blocks either side, ~8-9 steps) around
// the corrected guess — instead of bisecting the entire historical range from scratch.
//
// CORRECTNESS GUARANTEE, DISCLOSED: before trusting that small window, both of its boundaries are
// verified against real getBlock results (fetched below) to actually bracket the target timestamp.
// If they don't (block-time drift bigger than expected, e.g. a network hiccup), the window is
// doubled and re-verified, up to 4 attempts; if all 4 still miss (extremely unlikely on a chain with
// Base's block-time consistency), this falls back to the ORIGINAL full-range bisection used before
// this fix, so the worst case is "no more expensive than before," never a wrong answer.
async function estimateAndVerifyWindow(
  client: PublicClient,
  latest: Awaited<ReturnType<PublicClient['getBlock']>>,
  bucketed: number,
): Promise<{ low: bigint; high: bigint } | null> {
  const secondsAgo = Number(latest.timestamp) - bucketed
  const estimatedBlocksAgo = BigInt(Math.max(1, Math.round(secondsAgo / BASE_AVG_BLOCK_TIME_SEC)))
  const initialGuess = latest.number > estimatedBlocksAgo ? latest.number - estimatedBlocksAgo : BigInt(0)

  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'getBlock:estimate' })
  trackRpcCall('getBlock:estimate')
  let guessBlock = await client.getBlock({ blockNumber: initialGuess })
  let guess = initialGuess

  // Self-calibrate using the real gap between this probe and `latest` (rather than trusting the
  // constant above), then take one corrective step — this is what lets the window stay small even
  // when the true average block time differs slightly from the assumed constant.
  const blockDelta = latest.number - guessBlock.number
  const timeDelta = Number(latest.timestamp) - Number(guessBlock.timestamp)
  if (blockDelta > BigInt(0) && timeDelta > 0) {
    const localAvgBlockTime = timeDelta / Number(blockDelta)
    const remainingSeconds = bucketed - Number(guessBlock.timestamp)
    const adjustBlocks = BigInt(Math.round(remainingSeconds / localAvgBlockTime))
    let refinedGuess = guessBlock.number + adjustBlocks
    if (refinedGuess < BigInt(0)) refinedGuess = BigInt(0)
    if (refinedGuess > latest.number) refinedGuess = latest.number
    if (refinedGuess !== guess) {
      guess = refinedGuess
      logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'getBlock:estimate' })
      trackRpcCall('getBlock:estimate')
      guessBlock = await client.getBlock({ blockNumber: guess })
    }
  }

  let windowBlocks = ESTIMATE_SEARCH_WINDOW_BLOCKS
  for (let attempt = 0; attempt < ESTIMATE_SEARCH_MAX_WIDEN_ATTEMPTS; attempt++) {
    const guessAtOrBelowTarget = Number(guessBlock.timestamp) <= bucketed

    let low: bigint
    let high: bigint
    let lowOk: boolean
    let highOk: boolean

    if (guessAtOrBelowTarget) {
      low = guess
      lowOk = true
      high = guess + windowBlocks > latest.number ? latest.number : guess + windowBlocks
      if (high === latest.number) {
        highOk = true
      } else {
        logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'getBlock:estimate' })
        trackRpcCall('getBlock:estimate')
        const highBlock = await client.getBlock({ blockNumber: high })
        highOk = Number(highBlock.timestamp) > bucketed
      }
    } else {
      high = guess
      highOk = true
      low = guess > windowBlocks ? guess - windowBlocks : BigInt(0)
      if (low === BigInt(0)) {
        lowOk = true
      } else {
        logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'getBlock:estimate' })
        trackRpcCall('getBlock:estimate')
        const lowBlock = await client.getBlock({ blockNumber: low })
        lowOk = Number(lowBlock.timestamp) <= bucketed
      }
    }

    if (lowOk && highOk) return { low, high }
    windowBlocks = windowBlocks * BigInt(4)
  }

  return null
}

async function bisectWithinBounds(
  client: PublicClient,
  bucketed: number,
  initialLow: bigint,
  initialHigh: bigint,
): Promise<bigint> {
  let low = initialLow
  let high = initialHigh
  const two = BigInt(2)

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
  return low
}

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

  // BUDGET SHORT-CIRCUIT: checked after the cache/in-flight checks above (a bucket this scan
  // already resolved, or is already resolving concurrently, is always served regardless of the
  // budget) — see MAX_BASEDEX_RPC_CALLS_PER_SCAN's own declaration for the full reasoning.
  if (baseDexScanBudgetExceeded()) return null

  const search = (async (): Promise<bigint> => {
    const latest = await getLatestBlockCached(client)
    if (bucketed >= Number(latest.timestamp)) {
      blockForTimestampCache.set(bucketed, latest.number)
      return latest.number
    }

    const window = await estimateAndVerifyWindow(client, latest, bucketed)
    const [initialLow, initialHigh] = window ? [window.low, window.high] : [BigInt(0), latest.number]

    const low = await bisectWithinBounds(client, bucketed, initialLow, initialHigh)
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
// `Map<string, number | null>` to match what this function actually returns — `null` is a real,
// permanent, cacheable outcome too (an uninitialized pool's sqrtPriceX96 === 0 at a given historical
// block is a settled fact, same as any other historical price at that block).
const poolAddressCache = new Map<string, `0x${string}`>()
const poolPriceCache = new Map<string, number | null>()

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
    const pool = await resolvePoolAddressViaMulticall(client, tokenAddress, pairedWith)
      .catch(() => resolvePoolAddressSequential(client, tokenAddress, pairedWith))

    if (pool) {
      poolAddressCache.set(cacheKey, pool)
      return pool
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

// MULTICALL PATH, DISCLOSED: batches all 3 fee-tier getPool attempts into ONE eth_call via
// Multicall3's aggregate3 (allowFailure: true per sub-call, so one reverting fee tier doesn't take
// down the others — same as the try/catch-per-tier behavior the sequential fallback below has
// always had). Picks the first non-zero pool address found, in the same fee-tier priority order as
// before. Throws (letting the caller fall back to resolvePoolAddressSequential) if the multicall
// itself fails — e.g. Multicall3 not yet deployed at this historical context.
async function resolvePoolAddressViaMulticall(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
): Promise<`0x${string}` | null> {
  const calls: Multicall3Call[] = UNISWAP_V3_FEE_TIERS.map((fee) => ({
    target: UNISWAP_V3_FACTORY_BASE as `0x${string}`,
    allowFailure: true,
    callData: encodeFunctionData({
      abi: UNISWAP_V3_FACTORY_ABI,
      functionName: 'getPool',
      args: [tokenAddress, pairedWith, fee],
    }),
  }))

  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:multicall:getPool' })
  trackRpcCall('readContract:multicall:getPool')
  const results = await multicall(client, calls)

  for (const result of results) {
    if (!result.success) continue
    const pool = decodeFunctionResult({
      abi: UNISWAP_V3_FACTORY_ABI,
      functionName: 'getPool',
      data: result.returnData,
    })
    if (pool && pool !== '0x0000000000000000000000000000000000000000') return pool
  }
  return null
}

// FALLBACK PATH, DISCLOSED: the original, pre-multicall sequential implementation — unchanged
// logic, used only when the multicall attempt above throws.
async function resolvePoolAddressSequential(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
): Promise<`0x${string}` | null> {
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
      if (pool && pool !== '0x0000000000000000000000000000000000000000') return pool
    } catch {
      // try the next fee tier
    }
  }
  return null
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

  const [slot0, token0, tokenDecimals, pairedDecimals] = await readPoolPriceInputsViaMulticall(
    client, poolAddress, tokenAddress, pairedWith, blockNumber,
  ).catch(() => readPoolPriceInputsSequential(client, poolAddress, tokenAddress, pairedWith, blockNumber))

  const sqrtPriceX96 = slot0[0]

  // ZERO-PRICE FIX, DISCLOSED: a pool that exists on-chain (passes getPool) but has never had
  // initialize() called has slot0().sqrtPriceX96 === 0 — a real, legitimate on-chain state, not a
  // hypothetical. Previously, when tokenAddress was the pool's token0, rawRatio = 0 ** 2 = 0 sailed
  // straight through as if it were a real price (Number.isFinite(0) is true, so every caller's
  // finiteness guard accepted it), fabricating a $0 evidenced price instead of falling through to
  // the next price source. The other orientation (token1) instead produced 1/0 = Infinity, which
  // correctly failed the finiteness check — so this bug only ever fired for exactly half of
  // uninitialized pools, purely depending on which address happens to sort as token0. Same failure
  // category as the earlier -$39T decimal-orientation bug: an unchecked pool state silently
  // producing a plausible-looking wrong price instead of null/evidence-missing.
  if (sqrtPriceX96 === BigInt(0)) {
    poolPriceCache.set(cacheKey, null)
    return null
  }

  // price of token1 in terms of token0, in raw (undecimalized) units:
  const rawRatio = (Number(sqrtPriceX96) / 2 ** 96) ** 2
  const isTokenToken0 = token0.toLowerCase() === tokenAddress.toLowerCase()

  // PRICE-CORRUPTION FIX, DISCLOSED (found live: a real scan showed realizedPnlUsd around -3.9e28
  // and unrealizedPnl around -2.7e29 — a wallet holding an 18-decimal Base token (Mog) priced
  // against USDC (6 decimals) whenever it fell through to this on-chain fallback path). ROOT CAUSE:
  // the previous version applied decimalAdjustment to rawRatio FIRST (`token0PerToken1 = rawRatio *
  // decimalAdjustment`) and then reciprocated the WHOLE PRODUCT for the isTokenToken0 case
  // (`1 / token0PerToken1`) — but 1/(rawRatio * decimalAdjustment) also reciprocates the decimal
  // exponent itself, which is wrong. decimalAdjustment = 10^(tokenDecimals - pairedDecimals) is a
  // pool-independent constant that must NEVER flip sign; only the RAW RATIO's orientation (rawRatio
  // vs its reciprocal) depends on whether tokenAddress is the pool's token0 or token1. Verified by
  // hand against a concrete WETH(18dec)/USDC(6dec) pool in both token-role orientations: the old
  // formula computed the correct answer only when tokenAddress happened to BE the pool's token0 (by
  // coincidence, both of this module's own test fixtures used that exact orientation, which is why
  // this was never caught) — the other orientation (tokenAddress = pool's token1, roughly half of
  // all real pools, decided purely by which contract address sorts higher) was off by
  // 10^(2 * decimalsDifference), e.g. ~10^24x for an 18-vs-6-decimals pair.
  const decimalAdjustment = 10 ** (tokenDecimals - pairedDecimals)
  const orientedRatio = isTokenToken0 ? rawRatio : 1 / rawRatio
  const price = decimalAdjustment * orientedRatio
  poolPriceCache.set(cacheKey, price)
  return price
}

type PoolPriceInputs = [
  readonly [bigint, number, number, number, number, number, boolean],
  `0x${string}`,
  number,
  number,
]

// MULTICALL PATH, DISCLOSED: batches slot0 + token0 + both decimals() reads into ONE eth_call via
// Multicall3's aggregate3 (allowFailure: true per sub-call). Throws (letting the caller fall back
// to readPoolPriceInputsSequential) if the multicall itself fails, or if any individual sub-call
// failed — readPoolPrice needs all four values to compute a price, so a partial result is treated
// the same as a full failure, never a fabricated/partial price.
async function readPoolPriceInputsViaMulticall(
  client: PublicClient,
  poolAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
  blockNumber: bigint,
): Promise<PoolPriceInputs> {
  const calls: Multicall3Call[] = [
    { target: poolAddress, allowFailure: true, callData: encodeFunctionData({ abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0' }) },
    { target: poolAddress, allowFailure: true, callData: encodeFunctionData({ abi: UNISWAP_V3_POOL_ABI, functionName: 'token0' }) },
    { target: tokenAddress, allowFailure: true, callData: encodeFunctionData({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }) },
    { target: pairedWith, allowFailure: true, callData: encodeFunctionData({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }) },
  ]

  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:multicall:poolPrice' })
  trackRpcCall('readContract:multicall:poolPrice')
  const results = await multicall(client, calls, blockNumber)

  if (results.length !== 4 || results.some((r) => !r.success)) {
    throw new Error('multicall: one or more poolPrice sub-calls failed')
  }

  const slot0 = decodeFunctionResult({ abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0', data: results[0].returnData })
  const token0 = decodeFunctionResult({ abi: UNISWAP_V3_POOL_ABI, functionName: 'token0', data: results[1].returnData })
  const tokenDecimals = decodeFunctionResult({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals', data: results[2].returnData })
  const pairedDecimals = decodeFunctionResult({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals', data: results[3].returnData })

  return [slot0, token0, tokenDecimals, pairedDecimals]
}

// FALLBACK PATH, DISCLOSED: the original, pre-multicall sequential implementation — unchanged
// logic, used only when the multicall attempt above throws.
async function readPoolPriceInputsSequential(
  client: PublicClient,
  poolAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
  blockNumber: bigint,
): Promise<PoolPriceInputs> {
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:slot0' })
  trackRpcCall('readContract:slot0')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:token0' })
  trackRpcCall('readContract:token0')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:decimals' })
  trackRpcCall('readContract:decimals')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:decimals' })
  trackRpcCall('readContract:decimals')
  return Promise.all([
    client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0', blockNumber }),
    client.readContract({ address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'token0', blockNumber }),
    client.readContract({ address: tokenAddress, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', blockNumber }),
    client.readContract({ address: pairedWith, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', blockNumber }),
  ])
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
