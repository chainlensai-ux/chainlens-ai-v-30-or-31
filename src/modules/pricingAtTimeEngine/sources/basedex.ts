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

// AERODROME VENUES, DISCLOSED: additional venues alongside (never replacing) the Uniswap V3 venue
// above.
//   Aerodrome Classic PoolFactory:    0x420DD381b31aEf6683db6B902084cB0FFECe40Da
//   Aerodrome Slipstream PoolFactory: 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A
//
// SLIPSTREAM FACTORY CORRECTION, DISCLOSED (found live, this task — a real, confirmed wrong address
// that shipped in the previous version of this file): this constant previously held
// 0xCc0BddB707055e04e497aB22a59c2aF4391cd12F. That address is Velodrome's (Aerodrome's sibling
// protocol, on OPTIMISM, a different chain) Slipstream PoolFactory, NOT Aerodrome's Base one —
// confirmed by fetching velodrome-finance/slipstream's own README, whose deployment table lists that
// EXACT address with an explicit https://optimistic.etherscan.io link next to it. The corrected
// address above was cross-confirmed 3 separate times from aerodrome-finance/slipstream's own README
// (the correct, Aerodrome-owned repo) as its "Initial Deployment" PoolFactory on Base.
//
// LIVE ON-CHAIN VERIFICATION, ATTEMPTED AND DISCLOSED AS INCOMPLETE: this correction is backed by
// GitHub source-of-truth documentation, cross-checked across repos, NOT by live eth_getCode/eth_call
// evidence — every attempt to reach a Base RPC endpoint or block explorer from this sandbox (the
// configured ALCHEMY_BASE_RPC_URL/KEY are unset here; also tried mainnet.base.org, basescan.org,
// base.blockscout.com, llamarpc.com, publicnode.com, drpc.org, 1rpc.io) was rejected by this
// environment's outbound network policy before reaching the chain. See
// basedex.aerodromeSlipstreamFactory.liveVerification.test.ts: it runs the full 6-step on-chain
// verification (eth_getCode on both addresses, getPool() across every supported tick spacing against
// known Base WETH/USDC pairs, bytecode/token0/token1/slot0 checks on whatever pool is returned)
// automatically the moment a real ALCHEMY_BASE_RPC_URL/KEY IS configured in whatever environment runs
// it — it currently SKIPS (not fails) here for exactly that reason, per "fail closed if verification
// is inconclusive": this file does not claim a live-chain check it did not actually perform.
const AERODROME_CLASSIC_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da'
const AERODROME_SLIPSTREAM_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A'

// Aerodrome Classic (Solidly-fork) factory: pools are keyed by (tokenA, tokenB, stable) — a
// volatile pool and a stable pool for the SAME pair are different, independently-deployed contract
// addresses. Only ever queried below with stable=false (see STABLE-POOL SKIP note near
// readAerodromeClassicVolatilePoolPrice) — never with stable=true.
const AERODROME_CLASSIC_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'stable', type: 'bool' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

// Aerodrome Classic pool: a Solidly/Uniswap-V2-style constant-product-invariant AMM (for the
// volatile pools this file ever prices — see the stable-pool skip note below). `stable()` is read
// back from the pool itself (not merely assumed from which factory call found it) as a second,
// independent guard against ever pricing a stable-curve pool with volatile-pool (reserve-ratio)
// math.
const AERODROME_CLASSIC_POOL_ABI = [
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: '_reserve0', type: 'uint256' },
      { name: '_reserve1', type: 'uint256' },
      { name: '_blockTimestampLast', type: 'uint256' },
    ],
  },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'stable', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const

// SLOT0 ABI MISMATCH, CONFIRMED AND FIXED, DISCLOSED (found live, this task — real production
// evidence: pool 0x027256310dDD3773bc410f1CBd83524C42321Cd0 found, slot0() decode failed with
// "Position `192` is out of bounds (`0 < position < 192`)", Slipstream pricesAccepted stayed 0).
// ROOT CAUSE: Slipstream is a Uniswap V3 FORK, but its slot0() is NOT byte-identical to Uniswap V3's
// — verified directly against Aerodrome's own source repository
// (aerodrome-finance/slipstream/contracts/core/interfaces/pool/ICLPoolState.sol), which declares:
//   function slot0() external view returns (
//     uint160 sqrtPriceX96, int24 tick, uint16 observationIndex,
//     uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked
//   );
// — SIX fields, no `feeProtocol` (uint8) before `unlocked`. Uniswap V3's slot0 (UNISWAP_V3_POOL_ABI
// above) has SEVEN fields, WITH feeProtocol. Decoding Slipstream's real 6*32=192-byte return against
// the 7-field ABI is exactly what produced "position 192 out of bounds" — the decoder correctly read
// all 192 real bytes, then tried to read a 7th (nonexistent) field starting at byte offset 192.
// FIELD SEMANTICS PRESERVED, DISCLOSED: sqrtPriceX96 is documented identically ("the square root
// price in Q64.96 format") in both — the existing rawRatio/decimalAdjustment/orientation math
// (readPoolPrice's own PRICE-CORRUPTION FIX above) is reused verbatim for Slipstream (see
// readSlipstreamPoolPrice below) — only the ABI/decoder is dedicated, never the pricing formula.
const AERODROME_SLIPSTREAM_POOL_ABI = [
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

// Expected raw returndata length for Slipstream's real 6-field slot0 above: uint160/int24/uint16 x3/
// bool each pad to one 32-byte EVM word — 6 words = 192 bytes. FAIL-CLOSED, DISCLOSED: checked BEFORE
// decodeFunctionResult is ever called, so an unexpected length (a future Slipstream upgrade, a proxy
// returning something else, any other malformed response) is caught with a clear, attributable
// reason instead of either a generic decode crash or — far worse — a wrong-but-plausible price from
// silently misaligned field reads.
const SLIPSTREAM_SLOT0_EXPECTED_BYTES = 192

function slot0ReturnDataByteLength(data: `0x${string}`): number {
  return (data.length - 2) / 2
}

const AERODROME_SLIPSTREAM_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'tickSpacing', type: 'int24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

// Standard, publicly-documented Aerodrome Slipstream tick spacings (1 = very tight/stable-like,
// 50/100/200 = standard, 2000 = wide — the tier commonly used for volatile/memecoin pairs).
// Same "try each, take the first non-zero hit" approach as UNISWAP_V3_FEE_TIERS above.
const AERODROME_SLIPSTREAM_TICK_SPACINGS = [1, 50, 100, 200, 2000] as const

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
  resetBaseDexVenueAttributionForScan()
}

export type BaseDexVenue = 'uniswap_v3' | 'aerodrome_slipstream' | 'aerodrome_classic_volatile'

// PER-SCAN VENUE ATTRIBUTION, DISCLOSED, ADDITIVE — no pricing behavior changes: every field below
// is read-only bookkeeping around calls this file already makes, never a new call or a changed
// selection/acceptance rule.
//
// - poolsFoundByVenue: incremented purely on DISCOVERY (a factory call returned a real, non-zero
//   pool address) — never on a successful price. A pool that exists but fails every later check
//   (not yet deployed, zero liquidity, non-finite price) still counts here, and must NEVER be
//   reported as a pricing success — see "never count pool discovery as a pricing success."
// - pricesAcceptedByVenue: incremented only when tryBaseDexVenue's own full chain (discovery -> read
//   -> convert-to-USD) succeeds for that specific venue+quote-token attempt — this is a real,
//   accepted USD price, one attempt at a time, before any caller-side aggregation.
// - rpcCallsByVenue: the real totalBaseDexRpcCallsThisScan delta spent inside one venue's own
//   resolvePool+readPrice calls for one attempt — summed across every attempt this scan, so it is a
//   real accounting of RPC cost per venue, not an estimate.
// - failureReasonsByVenue: every FAILED (ok: false) attempt's own real reason string, tallied by
//   venue — never a synthesized/generic bucket beyond what tryBaseDexVenue itself already produces.
type BaseDexVenueAttributionState = {
  poolsFoundByVenue: Record<BaseDexVenue, number>
  pricesAcceptedByVenue: Record<BaseDexVenue, number>
  rpcCallsByVenue: Record<BaseDexVenue, number>
  failureReasonsByVenue: Record<BaseDexVenue, Record<string, number>>
}

function emptyVenueAttributionState(): BaseDexVenueAttributionState {
  return {
    poolsFoundByVenue: { uniswap_v3: 0, aerodrome_slipstream: 0, aerodrome_classic_volatile: 0 },
    pricesAcceptedByVenue: { uniswap_v3: 0, aerodrome_slipstream: 0, aerodrome_classic_volatile: 0 },
    rpcCallsByVenue: { uniswap_v3: 0, aerodrome_slipstream: 0, aerodrome_classic_volatile: 0 },
    failureReasonsByVenue: { uniswap_v3: {}, aerodrome_slipstream: {}, aerodrome_classic_volatile: {} },
  }
}

let venueAttributionState: BaseDexVenueAttributionState = emptyVenueAttributionState()

function recordPoolFound(venue: BaseDexVenue): void {
  venueAttributionState.poolsFoundByVenue[venue] += 1
}

function recordVenueRpcCalls(venue: BaseDexVenue, delta: number): void {
  venueAttributionState.rpcCallsByVenue[venue] += delta
}

function recordVenueAttempt(venue: BaseDexVenue, ok: boolean, reason: string | null): void {
  if (ok) {
    venueAttributionState.pricesAcceptedByVenue[venue] += 1
    return
  }
  const key = reason ?? 'unknown'
  const perVenue = venueAttributionState.failureReasonsByVenue[venue]
  perVenue[key] = (perVenue[key] ?? 0) + 1
}

// REQUEST-LEVEL ATTRIBUTION, DISCLOSED, ADDITIVE — keyed by the exact (chain, token, timestamp) a
// caller requested, recording ONLY a genuinely accepted (non-null, finite USD) Aerodrome-venue
// price. This is what lets a caller (priceLotsForWallet.ts) later confirm "the price actually
// written into this specific costUsd/proceedsUsd slot came from Aerodrome" rather than merely
// "Aerodrome was attempted" — pool discovery or a rejected price is NEVER recorded here. Since
// fetchBaseDexPriceDetailed is only ever reached for a given (chain, token, timestamp) after every
// earlier price source (DexScreener/CoinGecko/GoldRush/GeckoTerminal) has already returned null for
// that exact request (see pricingAtTimeAdapter.ts's own routing order), a hit here can never
// silently overwrite/shadow a requirement an earlier source already resolved.
type AerodromeAttributionEntry = { venue: 'aerodrome_slipstream' | 'aerodrome_classic_volatile'; priceUsd: number }
const aerodromeAttributionByRequestKey = new Map<string, AerodromeAttributionEntry>()

function aerodromeAttributionKey(chain: string, token: string, timestamp: number): string {
  return `${chain}:${token.toLowerCase()}:${timestamp}`
}

function recordAerodromeAttribution(chain: string, token: string, timestamp: number, venue: 'aerodrome_slipstream' | 'aerodrome_classic_volatile', priceUsd: number): void {
  aerodromeAttributionByRequestKey.set(aerodromeAttributionKey(chain, token, timestamp), { venue, priceUsd })
}

// Exported so a caller (priceLotsForWallet.ts) can confirm, for one specific (chain, token,
// timestamp) requirement it itself submitted, whether Aerodrome specifically supplied the accepted
// price — never a guess, a direct read of what this file itself recorded.
export function getAerodromeAttributionForRequest(chain: string, token: string, timestamp: number): AerodromeAttributionEntry | null {
  return aerodromeAttributionByRequestKey.get(aerodromeAttributionKey(chain, token, timestamp)) ?? null
}

// TEST-SUPPORT EXPORT, DISCLOSED: same convention as this file's other test-only exports — lets a
// test in priceLotsForWallet.ts's own suite exercise the REAL cross-referencing logic there (does
// this exact requirement's costUsd/proceedsUsd slot line up with a recorded Aerodrome attribution?)
// without needing to mock a full JSON-RPC round trip through viem's http transport just to reach
// this one recording call. Never used by any real request-handling code path.
export function __recordAerodromeAttributionForTest(
  chain: string,
  token: string,
  timestamp: number,
  venue: 'aerodrome_slipstream' | 'aerodrome_classic_volatile',
  priceUsd: number,
): void {
  recordAerodromeAttribution(chain, token, timestamp, venue, priceUsd)
}

// Exported read-only snapshot of this scan's venue-level counters — a plain deep copy, never the
// live mutable state, so a caller can never accidentally corrupt this file's own bookkeeping.
export function getBaseDexVenueAttributionForScan(): BaseDexVenueAttributionState {
  return {
    poolsFoundByVenue: { ...venueAttributionState.poolsFoundByVenue },
    pricesAcceptedByVenue: { ...venueAttributionState.pricesAcceptedByVenue },
    rpcCallsByVenue: { ...venueAttributionState.rpcCallsByVenue },
    failureReasonsByVenue: {
      uniswap_v3: { ...venueAttributionState.failureReasonsByVenue.uniswap_v3 },
      aerodrome_slipstream: { ...venueAttributionState.failureReasonsByVenue.aerodrome_slipstream },
      aerodrome_classic_volatile: { ...venueAttributionState.failureReasonsByVenue.aerodrome_classic_volatile },
    },
  }
}

// SCAN-BOUNDARY RESET, DISCLOSED: folded into resetBaseDexRpcBudgetForScan's own call site (already
// invoked once per real scan — see src/modules/walletScanWorker.ts) so no new wiring is needed
// anywhere else. The per-request attribution map is cleared too — same "process-lifetime state must
// not leak into an unrelated scan" reasoning as totalBaseDexRpcCallsThisScan's own reset.
export function resetBaseDexVenueAttributionForScan(): void {
  venueAttributionState = emptyVenueAttributionState()
  aerodromeAttributionByRequestKey.clear()
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
  __resetAerodromeCachesForTest()
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

// POOL-CREATED-AFTER-TRADE, DISCLOSED, ZERO-ADDED-COST FIX: resolvePoolAddress finds a pool's address
// at the CURRENT factory state (no historical blockNumber — see its own header), which is safe for
// pools that already existed at trade time (V3 pool addresses are permanent/deterministic), but a
// pool address can also be one the factory only linked AFTER the trade's own historical block. In
// that case the historical slot0()/token0() calls hit a contract with no code yet at that block — the
// EVM returns `success` with EMPTY returndata for a call to an address with no code (never a revert),
// so decodeFunctionResult() would throw a generic, unattributed decode error, and the existing
// `.catch(() => sequential)` fallback would then retry the EXACT SAME doomed calls against the same
// not-yet-deployed address, wasting a full second round of RPC calls only to fail identically.
// Detected here from data already fetched by the ONE multicall this function already makes — zero
// additional RPC cost — and surfaced as a distinguishable error message instead of an opaque
// "multicall: one or more poolPrice sub-calls failed" / generic decode error, so
// fetchBaseDexPriceDetailed's caller-facing `reason` can honestly attribute this case instead of
// lumping it into an undifferentiated rpc_error.
class PoolNotYetDeployedError extends Error {}

// See SLIPSTREAM_SLOT0_EXPECTED_BYTES's own header — thrown for a deterministic returndata-shape
// mismatch, never retried sequentially (the shape would be identical on retry).
class SlipstreamSlot0ShapeError extends Error {}

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
  ).catch((err) => {
    // Never retry a provably-doomed identical call — see PoolNotYetDeployedError's own header.
    if (err instanceof PoolNotYetDeployedError) throw err
    return readPoolPriceInputsSequential(client, poolAddress, tokenAddress, pairedWith, blockNumber)
  })

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

  // See PoolNotYetDeployedError's own header above: empty returndata for the POOL's own calls
  // (slot0/token0) at this historical block — as opposed to the token-decimals calls, which target
  // long-since-deployed ERC20s — is the real, cheaply-detected signal that this pool contract had no
  // code yet at the trade's block, not a transient failure.
  if (results[0].returnData === '0x' || results[1].returnData === '0x') {
    throw new PoolNotYetDeployedError('pool_not_yet_deployed_at_block')
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

type SlipstreamPoolPriceInputs = [
  readonly [bigint, number, number, number, number, boolean],
  `0x${string}`,
  number,
  number,
]

// DEDICATED SLIPSTREAM slot0 DECODE PATH, DISCLOSED — see AERODROME_SLIPSTREAM_POOL_ABI's own header
// above for the confirmed, source-verified ABI difference from Uniswap V3. Structurally identical to
// readPoolPriceInputsViaMulticall above (same multicall batching, same PoolNotYetDeployedError
// empty-returndata detection) — the only real differences are the dedicated 6-field ABI and the
// explicit pre-decode length check below.
async function readSlipstreamPoolPriceInputsViaMulticall(
  client: PublicClient,
  poolAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
  blockNumber: bigint,
): Promise<SlipstreamPoolPriceInputs> {
  const calls: Multicall3Call[] = [
    { target: poolAddress, allowFailure: true, callData: encodeFunctionData({ abi: AERODROME_SLIPSTREAM_POOL_ABI, functionName: 'slot0' }) },
    { target: poolAddress, allowFailure: true, callData: encodeFunctionData({ abi: AERODROME_SLIPSTREAM_POOL_ABI, functionName: 'token0' }) },
    { target: tokenAddress, allowFailure: true, callData: encodeFunctionData({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }) },
    { target: pairedWith, allowFailure: true, callData: encodeFunctionData({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }) },
  ]

  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:multicall:poolPrice:aeroSlipstream' })
  trackRpcCall('readContract:multicall:poolPrice:aeroSlipstream')
  const results = await multicall(client, calls, blockNumber)

  if (results.length !== 4 || results.some((r) => !r.success)) {
    throw new Error('multicall: one or more aeroSlipstream poolPrice sub-calls failed')
  }

  if (results[0].returnData === '0x' || results[1].returnData === '0x') {
    throw new PoolNotYetDeployedError('pool_not_yet_deployed_at_block')
  }

  // FAIL-CLOSED LENGTH CHECK, DISCLOSED — see SLIPSTREAM_SLOT0_EXPECTED_BYTES's own header. Checked
  // BEFORE decodeFunctionResult so a malformed/unexpected response is caught with a clear,
  // attributable reason (pool address + byte length, never the raw returndata itself — kept out of
  // logs deliberately, per "without logging excessive raw data") instead of a generic decode crash.
  const slot0ByteLength = slot0ReturnDataByteLength(results[0].returnData)
  if (slot0ByteLength !== SLIPSTREAM_SLOT0_EXPECTED_BYTES) {
    // eslint-disable-next-line no-console
    console.warn('[basedex] aerodrome slipstream slot0 returndata length mismatch', {
      poolAddress,
      expectedBytes: SLIPSTREAM_SLOT0_EXPECTED_BYTES,
      actualBytes: slot0ByteLength,
    })
    // A deterministic shape mismatch, not a transient failure — a sequential retry would fetch the
    // exact same malformed shape (this is what the contract actually returns), so this is deliberately
    // NOT a plain Error: see readSlipstreamPoolPrice's own catch below, which (like
    // PoolNotYetDeployedError above) rethrows this specific class instead of wasting a doomed retry.
    throw new SlipstreamSlot0ShapeError(`slipstream_slot0_returndata_length_mismatch:pool=${poolAddress}:expected=${SLIPSTREAM_SLOT0_EXPECTED_BYTES}:actual=${slot0ByteLength}`)
  }

  const slot0 = decodeFunctionResult({ abi: AERODROME_SLIPSTREAM_POOL_ABI, functionName: 'slot0', data: results[0].returnData })
  const token0 = decodeFunctionResult({ abi: AERODROME_SLIPSTREAM_POOL_ABI, functionName: 'token0', data: results[1].returnData })
  const tokenDecimals = decodeFunctionResult({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals', data: results[2].returnData })
  const pairedDecimals = decodeFunctionResult({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals', data: results[3].returnData })

  return [slot0, token0, tokenDecimals, pairedDecimals]
}

async function readSlipstreamPoolPriceInputsSequential(
  client: PublicClient,
  poolAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
  blockNumber: bigint,
): Promise<SlipstreamPoolPriceInputs> {
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:slot0:aeroSlipstream' })
  trackRpcCall('readContract:slot0:aeroSlipstream')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:token0' })
  trackRpcCall('readContract:token0')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:decimals' })
  trackRpcCall('readContract:decimals')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:decimals' })
  trackRpcCall('readContract:decimals')
  return Promise.all([
    client.readContract({ address: poolAddress, abi: AERODROME_SLIPSTREAM_POOL_ABI, functionName: 'slot0', blockNumber }),
    client.readContract({ address: poolAddress, abi: AERODROME_SLIPSTREAM_POOL_ABI, functionName: 'token0', blockNumber }),
    client.readContract({ address: tokenAddress, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', blockNumber }),
    client.readContract({ address: pairedWith, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', blockNumber }),
  ])
}

// TEST-SUPPORT EXPORT, DISCLOSED: same reasoning as readPoolPrice above. Pricing math (rawRatio/
// decimalAdjustment/orientation, including the ZERO-PRICE and PRICE-CORRUPTION fixes) is reused
// verbatim from readPoolPrice — only the ABI/decode path is dedicated (AERODROME_SLIPSTREAM_POOL_ABI),
// per the confirmed field-count mismatch documented there.
export async function readSlipstreamPoolPrice(
  client: PublicClient,
  poolAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
  blockNumber: bigint,
): Promise<number | null> {
  const cacheKey = `${poolAddress.toLowerCase()}-${blockNumber.toString()}`
  const cachedPrice = poolPriceCache.get(cacheKey)
  if (cachedPrice !== undefined) return cachedPrice

  const [slot0, token0, tokenDecimals, pairedDecimals] = await readSlipstreamPoolPriceInputsViaMulticall(
    client, poolAddress, tokenAddress, pairedWith, blockNumber,
  ).catch((err) => {
    if (err instanceof PoolNotYetDeployedError || err instanceof SlipstreamSlot0ShapeError) throw err
    return readSlipstreamPoolPriceInputsSequential(client, poolAddress, tokenAddress, pairedWith, blockNumber)
  })

  const sqrtPriceX96 = slot0[0]

  if (sqrtPriceX96 === BigInt(0)) {
    poolPriceCache.set(cacheKey, null)
    return null
  }

  const rawRatio = (Number(sqrtPriceX96) / 2 ** 96) ** 2
  const isTokenToken0 = token0.toLowerCase() === tokenAddress.toLowerCase()
  const decimalAdjustment = 10 ** (tokenDecimals - pairedDecimals)
  const orientedRatio = isTokenToken0 ? rawRatio : 1 / rawRatio
  const price = decimalAdjustment * orientedRatio
  poolPriceCache.set(cacheKey, price)
  return price
}

// ============================================================================
// AERODROME SLIPSTREAM (concentrated liquidity, Uniswap-V3-style pool math)
// ============================================================================
//
// Discovery only differs from Uniswap V3 (different factory address, tickSpacing instead of a fee
// tier) — pricing reuses readPoolPrice UNCHANGED (see AERODROME_SLIPSTREAM_FACTORY_ABI's own header
// above for why that's safe), so there is no separate "read price" implementation for this venue.
// Cache/singleflight/negative-cache structure mirrors resolvePoolAddress's own, in a SEPARATE set of
// maps (not the same Map object) so a token's Uniswap pool address and its Aerodrome Slipstream pool
// address for the identical (token, pairedWith) pair — genuinely different on-chain contracts —
// never collide under the same cache key.
const aeroSlipstreamPoolAddressCache = new Map<string, `0x${string}`>()
const aeroSlipstreamNegativePoolCache = new Map<string, number>()
const aeroSlipstreamInFlightPoolSearches = new Map<string, Promise<`0x${string}` | null>>()

async function resolveAerodromeSlipstreamPoolAddressViaMulticall(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
): Promise<`0x${string}` | null> {
  const calls: Multicall3Call[] = AERODROME_SLIPSTREAM_TICK_SPACINGS.map((tickSpacing) => ({
    target: AERODROME_SLIPSTREAM_FACTORY as `0x${string}`,
    allowFailure: true,
    callData: encodeFunctionData({
      abi: AERODROME_SLIPSTREAM_FACTORY_ABI,
      functionName: 'getPool',
      args: [tokenAddress, pairedWith, tickSpacing],
    }),
  }))

  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:multicall:getPool:aeroSlipstream' })
  trackRpcCall('readContract:multicall:getPool:aeroSlipstream')
  const results = await multicall(client, calls)

  for (const result of results) {
    if (!result.success) continue
    const pool = decodeFunctionResult({
      abi: AERODROME_SLIPSTREAM_FACTORY_ABI,
      functionName: 'getPool',
      data: result.returnData,
    })
    if (pool && pool !== '0x0000000000000000000000000000000000000000') return pool
  }
  return null
}

async function resolveAerodromeSlipstreamPoolAddressSequential(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
): Promise<`0x${string}` | null> {
  for (const tickSpacing of AERODROME_SLIPSTREAM_TICK_SPACINGS) {
    try {
      logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:getPool:aeroSlipstream' })
      trackRpcCall('readContract:getPool:aeroSlipstream')
      const pool = await client.readContract({
        address: AERODROME_SLIPSTREAM_FACTORY as `0x${string}`,
        abi: AERODROME_SLIPSTREAM_FACTORY_ABI,
        functionName: 'getPool',
        args: [tokenAddress, pairedWith, tickSpacing],
      })
      if (pool && pool !== '0x0000000000000000000000000000000000000000') return pool
    } catch {
      // try the next tick spacing
    }
  }
  return null
}

export async function resolveAerodromeSlipstreamPoolAddress(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
): Promise<`0x${string}` | null> {
  const cacheKey = `${tokenAddress.toLowerCase()}-${pairedWith.toLowerCase()}`

  const cached = aeroSlipstreamPoolAddressCache.get(cacheKey)
  if (cached !== undefined) return cached

  const negativeExpiresAt = aeroSlipstreamNegativePoolCache.get(cacheKey)
  if (negativeExpiresAt !== undefined && Date.now() < negativeExpiresAt) return null

  const inFlight = aeroSlipstreamInFlightPoolSearches.get(cacheKey)
  if (inFlight) return inFlight

  // Same scan-wide budget the block search already enforces — never spend more RPC budget on this
  // new venue than the existing cap already allows. See MAX_BASEDEX_RPC_CALLS_PER_SCAN's own header.
  if (baseDexScanBudgetExceeded()) return null

  const search = (async (): Promise<`0x${string}` | null> => {
    const pool = await resolveAerodromeSlipstreamPoolAddressViaMulticall(client, tokenAddress, pairedWith)
      .catch(() => resolveAerodromeSlipstreamPoolAddressSequential(client, tokenAddress, pairedWith))

    if (pool) {
      aeroSlipstreamPoolAddressCache.set(cacheKey, pool)
      return pool
    }
    aeroSlipstreamNegativePoolCache.set(cacheKey, Date.now() + NEGATIVE_POOL_CACHE_TTL_MS)
    return null
  })()

  aeroSlipstreamInFlightPoolSearches.set(cacheKey, search)
  try {
    return await search
  } finally {
    aeroSlipstreamInFlightPoolSearches.delete(cacheKey)
  }
}

// ============================================================================
// AERODROME CLASSIC — VOLATILE POOLS ONLY (constant-product reserve-ratio math)
// ============================================================================
//
// STABLE-POOL SKIP, DISCLOSED, INTENTIONAL: Aerodrome Classic stable pools use a different
// (StableSwap-style) curve invariant than the constant-product (x*y=k) math this file implements
// below — pricing a stable pool with plain reserve-ratio math would silently produce a WRONG price
// (a plausible-looking number, not an honest failure) whenever the pool sits away from its 1:1 peg.
// Per explicit instruction, this venue therefore NEVER queries the factory with stable=true, and
// independently double-checks the pool's own `stable()` view (see readAerodromeClassicVolatile-
// PoolPrice below) before ever using its reserves — so even a discovery-side accident could not slip
// a stable pool through this volatile-only math.
const aeroClassicPoolAddressCache = new Map<string, `0x${string}`>()
const aeroClassicNegativePoolCache = new Map<string, number>()
const aeroClassicInFlightPoolSearches = new Map<string, Promise<`0x${string}` | null>>()
const aeroClassicPoolPriceCache = new Map<string, number | null>()

class AeroPoolNotYetDeployedError extends Error {}

export async function resolveAerodromeClassicVolatilePoolAddress(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
): Promise<`0x${string}` | null> {
  const cacheKey = `${tokenAddress.toLowerCase()}-${pairedWith.toLowerCase()}`

  const cached = aeroClassicPoolAddressCache.get(cacheKey)
  if (cached !== undefined) return cached

  const negativeExpiresAt = aeroClassicNegativePoolCache.get(cacheKey)
  if (negativeExpiresAt !== undefined && Date.now() < negativeExpiresAt) return null

  const inFlight = aeroClassicInFlightPoolSearches.get(cacheKey)
  if (inFlight) return inFlight

  if (baseDexScanBudgetExceeded()) return null

  const search = (async (): Promise<`0x${string}` | null> => {
    try {
      logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:getPool:aeroClassic' })
      trackRpcCall('readContract:getPool:aeroClassic')
      const pool = await client.readContract({
        address: AERODROME_CLASSIC_FACTORY as `0x${string}`,
        abi: AERODROME_CLASSIC_FACTORY_ABI,
        functionName: 'getPool',
        args: [tokenAddress, pairedWith, false], // false = volatile only, see this section's own header
      })
      if (pool && pool !== '0x0000000000000000000000000000000000000000') {
        aeroClassicPoolAddressCache.set(cacheKey, pool)
        return pool
      }
    } catch {
      // no pool for this pair (or a real RPC failure) — treated the same as "not found" below
    }
    aeroClassicNegativePoolCache.set(cacheKey, Date.now() + NEGATIVE_POOL_CACHE_TTL_MS)
    return null
  })()

  aeroClassicInFlightPoolSearches.set(cacheKey, search)
  try {
    return await search
  } finally {
    aeroClassicInFlightPoolSearches.delete(cacheKey)
  }
}

type AeroClassicPoolPriceInputs = [bigint, bigint, `0x${string}`, boolean, number, number]

async function readAerodromeClassicVolatilePoolPriceInputsViaMulticall(
  client: PublicClient,
  poolAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
  blockNumber: bigint,
): Promise<AeroClassicPoolPriceInputs> {
  const calls: Multicall3Call[] = [
    { target: poolAddress, allowFailure: true, callData: encodeFunctionData({ abi: AERODROME_CLASSIC_POOL_ABI, functionName: 'getReserves' }) },
    { target: poolAddress, allowFailure: true, callData: encodeFunctionData({ abi: AERODROME_CLASSIC_POOL_ABI, functionName: 'token0' }) },
    { target: poolAddress, allowFailure: true, callData: encodeFunctionData({ abi: AERODROME_CLASSIC_POOL_ABI, functionName: 'stable' }) },
    { target: tokenAddress, allowFailure: true, callData: encodeFunctionData({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }) },
    { target: pairedWith, allowFailure: true, callData: encodeFunctionData({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }) },
  ]

  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:multicall:poolPrice:aeroClassic' })
  trackRpcCall('readContract:multicall:poolPrice:aeroClassic')
  const results = await multicall(client, calls, blockNumber)

  if (results.length !== 5 || results.some((r) => !r.success)) {
    throw new Error('multicall: one or more aeroClassic poolPrice sub-calls failed')
  }

  // Same empty-returndata signal as PoolNotYetDeployedError above: a pool the factory currently
  // links but that had no code yet at this historical block, detected for free from data this same
  // multicall already fetched — never a wasted, doomed sequential retry.
  if (results[0].returnData === '0x' || results[1].returnData === '0x' || results[2].returnData === '0x') {
    throw new AeroPoolNotYetDeployedError('pool_not_yet_deployed_at_block')
  }

  const [reserve0, reserve1] = decodeFunctionResult({ abi: AERODROME_CLASSIC_POOL_ABI, functionName: 'getReserves', data: results[0].returnData })
  const token0 = decodeFunctionResult({ abi: AERODROME_CLASSIC_POOL_ABI, functionName: 'token0', data: results[1].returnData })
  const stable = decodeFunctionResult({ abi: AERODROME_CLASSIC_POOL_ABI, functionName: 'stable', data: results[2].returnData })
  const tokenDecimals = decodeFunctionResult({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals', data: results[3].returnData })
  const pairedDecimals = decodeFunctionResult({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals', data: results[4].returnData })

  return [reserve0, reserve1, token0, stable, tokenDecimals, pairedDecimals]
}

async function readAerodromeClassicVolatilePoolPriceInputsSequential(
  client: PublicClient,
  poolAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
  blockNumber: bigint,
): Promise<AeroClassicPoolPriceInputs> {
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:getReserves' })
  trackRpcCall('readContract:getReserves')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:token0' })
  trackRpcCall('readContract:token0')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:stable' })
  trackRpcCall('readContract:stable')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:decimals' })
  trackRpcCall('readContract:decimals')
  logRpcCall({ route: 'pricingAtTimeEngine:basedex', chain: 'base', method: 'readContract:decimals' })
  trackRpcCall('readContract:decimals')
  const [reserves, token0, stable, tokenDecimals, pairedDecimals] = await Promise.all([
    client.readContract({ address: poolAddress, abi: AERODROME_CLASSIC_POOL_ABI, functionName: 'getReserves', blockNumber }),
    client.readContract({ address: poolAddress, abi: AERODROME_CLASSIC_POOL_ABI, functionName: 'token0', blockNumber }),
    client.readContract({ address: poolAddress, abi: AERODROME_CLASSIC_POOL_ABI, functionName: 'stable', blockNumber }),
    client.readContract({ address: tokenAddress, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', blockNumber }),
    client.readContract({ address: pairedWith, abi: ERC20_DECIMALS_ABI, functionName: 'decimals', blockNumber }),
  ])
  return [reserves[0], reserves[1], token0, stable, tokenDecimals, pairedDecimals]
}

export async function readAerodromeClassicVolatilePoolPrice(
  client: PublicClient,
  poolAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  pairedWith: `0x${string}`,
  blockNumber: bigint,
): Promise<number | null> {
  const cacheKey = `${poolAddress.toLowerCase()}-${blockNumber.toString()}`
  const cachedPrice = aeroClassicPoolPriceCache.get(cacheKey)
  if (cachedPrice !== undefined) return cachedPrice

  const [reserve0, reserve1, token0, stable, tokenDecimals, pairedDecimals] =
    await readAerodromeClassicVolatilePoolPriceInputsViaMulticall(client, poolAddress, tokenAddress, pairedWith, blockNumber)
      .catch((err) => {
        if (err instanceof AeroPoolNotYetDeployedError) throw err
        return readAerodromeClassicVolatilePoolPriceInputsSequential(client, poolAddress, tokenAddress, pairedWith, blockNumber)
      })

  // NEVER PRICE A STABLE POOL WITH THIS MATH — see this section's own header. Independently
  // re-verified here from the pool's own on-chain state, not merely trusted from which factory call
  // found it.
  if (stable) {
    aeroClassicPoolPriceCache.set(cacheKey, null)
    return null
  }

  // ZERO-LIQUIDITY REJECTION: a deployed-but-never-funded (or fully-drained) pool has reserve0 or
  // reserve1 === 0 — a real, legitimate on-chain state (same category as slot0().sqrtPriceX96 === 0
  // for the Uniswap V3 venue above), not a hypothetical. Division by a zero reserve would otherwise
  // produce Infinity/NaN, which must never be treated as a real price.
  if (reserve0 === BigInt(0) || reserve1 === BigInt(0)) {
    aeroClassicPoolPriceCache.set(cacheKey, null)
    return null
  }

  const isTokenToken0 = token0.toLowerCase() === tokenAddress.toLowerCase()

  // Same orientation/decimal-adjustment discipline as readPoolPrice's own hard-learned lesson above
  // (see its PRICE-CORRUPTION FIX comment): decimalAdjustment = 10^(tokenDecimals - pairedDecimals)
  // is a pool-independent constant that must NEVER flip sign; only which raw reserve plays the role
  // of "the paired asset's reserve" depends on token0/token1 orientation.
  // rawRatio = (raw reserve of the paired asset) / (raw reserve of the priced token)
  const rawRatio = isTokenToken0 ? Number(reserve1) / Number(reserve0) : Number(reserve0) / Number(reserve1)
  const decimalAdjustment = 10 ** (tokenDecimals - pairedDecimals)
  const price = rawRatio * decimalAdjustment

  if (!Number.isFinite(price)) {
    aeroClassicPoolPriceCache.set(cacheKey, null)
    return null
  }

  aeroClassicPoolPriceCache.set(cacheKey, price)
  return price
}

// TEST-SUPPORT EXPORT, DISCLOSED: same reasoning as __resetBaseDexCachesForTest above, extended to
// the two new Aerodrome venues' own cache/singleflight maps.
export function __resetAerodromeCachesForTest(): void {
  aeroSlipstreamPoolAddressCache.clear()
  aeroSlipstreamNegativePoolCache.clear()
  aeroSlipstreamInFlightPoolSearches.clear()
  aeroClassicPoolAddressCache.clear()
  aeroClassicNegativePoolCache.clear()
  aeroClassicInFlightPoolSearches.clear()
  aeroClassicPoolPriceCache.clear()
}

export type BaseDexVenueAttempt = {
  venue: BaseDexVenue
  quoteToken: 'WETH' | 'USDC'
  attempted: boolean
  ok: boolean
  reason: string | null
}

// Converts a raw tokenPerQuote ratio (from any venue) into a USD price. USDC is treated as $1 (a
// standard, disclosed industry approximation for a USD-pegged stablecoin — same as the pre-existing
// Uniswap USDC path). WETH requires one further real, recursive CoinGecko lookup for WETH's own
// historical USD price — never a guessed/hardcoded ETH price.
async function convertQuoteRatioToUsd(
  quoteLabel: 'WETH' | 'USDC',
  tokenPerQuote: number,
  timestamp: number,
): Promise<number | null> {
  if (quoteLabel === 'USDC') return tokenPerQuote
  const wethUsd = await fetchCoingeckoPriceDetailed(WETH_BASE, 'base', timestamp)
  if (wethUsd.priceUsd === null) return null
  return tokenPerQuote * wethUsd.priceUsd
}

// One venue+quote-token attempt: resolve the pool, read its price, convert to USD, and always
// record a structured attempt entry (success or failure) — this is what "expose attempts,
// successes, selected venue/pool type, failure reason" is built from.
// TEST-SUPPORT EXPORT, DISCLOSED: same reasoning as resolvePoolAddress/readPoolPrice above — exported
// solely so a test can exercise one venue+quote-token attempt directly (with a mocked client) and
// assert the resulting venue-attribution counters, without driving the full 6-attempt
// fetchBaseDexPriceDetailed orchestration. No behavior change.
export async function tryBaseDexVenue(
  venue: BaseDexVenue,
  quoteLabel: 'WETH' | 'USDC',
  quoteAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  client: PublicClient,
  blockNumber: bigint,
  timestamp: number,
  attempts: BaseDexVenueAttempt[],
  resolvePool: (client: PublicClient, tokenAddress: `0x${string}`, pairedWith: `0x${string}`) => Promise<`0x${string}` | null>,
  readPrice: (client: PublicClient, poolAddress: `0x${string}`, tokenAddress: `0x${string}`, pairedWith: `0x${string}`, blockNumber: bigint) => Promise<number | null>,
): Promise<number | null> {
  const rpcCallsAtStart = totalBaseDexRpcCallsThisScan
  function pushAttempt(ok: boolean, reason: string | null): void {
    attempts.push({ venue, quoteToken: quoteLabel, attempted: true, ok, reason })
    recordVenueAttempt(venue, ok, reason)
  }

  let pool: `0x${string}` | null
  try {
    pool = await resolvePool(client, tokenAddress, quoteAddress)
  } catch (err) {
    recordVenueRpcCalls(venue, totalBaseDexRpcCallsThisScan - rpcCallsAtStart)
    pushAttempt(false, `pool_discovery_error:${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
  if (!pool) {
    recordVenueRpcCalls(venue, totalBaseDexRpcCallsThisScan - rpcCallsAtStart)
    pushAttempt(false, 'no_pool')
    return null
  }
  // DISCOVERY ONLY, DISCLOSED: recorded the instant a real pool address is found, regardless of what
  // happens next (deployed-but-not-yet-at-block, zero liquidity, non-finite price all still count as
  // "found" here) — see poolsFoundByVenue's own header. This must NEVER be conflated with a pricing
  // success, which is only ever recorded at the bottom of this function on the full success path.
  recordPoolFound(venue)

  let ratio: number | null
  try {
    ratio = await readPrice(client, pool, tokenAddress, quoteAddress, blockNumber)
  } catch (err) {
    recordVenueRpcCalls(venue, totalBaseDexRpcCallsThisScan - rpcCallsAtStart)
    pushAttempt(false, err instanceof Error ? err.message : 'unknown')
    return null
  }
  if (ratio === null || !Number.isFinite(ratio)) {
    recordVenueRpcCalls(venue, totalBaseDexRpcCallsThisScan - rpcCallsAtStart)
    pushAttempt(false, 'invalid_or_zero_price')
    return null
  }

  const usd = await convertQuoteRatioToUsd(quoteLabel, ratio, timestamp)
  recordVenueRpcCalls(venue, totalBaseDexRpcCallsThisScan - rpcCallsAtStart)
  if (usd === null || !Number.isFinite(usd)) {
    pushAttempt(false, 'quote_token_usd_unavailable')
    return null
  }

  pushAttempt(true, null)
  return usd
}

export type BaseDexPriceResult = {
  priceUsd: number | null
  reason: string | null
  venue?: BaseDexVenue
  attempts?: BaseDexVenueAttempt[]
  rpcCallsUsed?: number
}

// Detailed variant — used by the orchestrator (getPriceAtTime) for structured debug output.
export async function fetchBaseDexPriceDetailed(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<BaseDexPriceResult> {
  if (chain !== 'base') return { priceUsd: null, reason: 'base_dex_only_supports_base_chain' }

  const client = getBaseClient()
  if (!client) return { priceUsd: null, reason: 'no_api_key_configured' }

  const rpcCallsAtStart = totalBaseDexRpcCallsThisScan
  const attempts: BaseDexVenueAttempt[] = []

  try {
    const targetSec = Math.floor(timestamp / 1000)
    const blockNumber = await findBlockForTimestamp(client, targetSec)
    if (blockNumber === null) {
      return { priceUsd: null, reason: 'could_not_resolve_historical_block', attempts, rpcCallsUsed: totalBaseDexRpcCallsThisScan - rpcCallsAtStart }
    }

    const tokenAddress = token as `0x${string}`
    const quotes: { label: 'WETH' | 'USDC'; address: `0x${string}` }[] = [
      { label: 'WETH', address: WETH_BASE as `0x${string}` },
      { label: 'USDC', address: USDC_BASE as `0x${string}` },
    ]

    // DETERMINISTIC VENUE PRIORITY, DISCLOSED: Uniswap V3 first (Base's deepest, most established
    // venue — unchanged from before this task, so pre-existing behavior for any token that already
    // had a Uniswap pool is byte-for-byte identical), then Aerodrome Slipstream (concentrated
    // liquidity), then Aerodrome Classic volatile pools (constant-product) — Classic STABLE pools
    // are never attempted at all (see AERODROME_CLASSIC_FACTORY_ABI's own header). Within each
    // venue, WETH is tried before USDC, matching the pre-existing priority. This fixed order is
    // itself the determinism guarantee: the same (token, chain, timestamp) always attempts venues in
    // this exact sequence and returns the first one that produces a valid price — never a random or
    // ambiguous choice among multiple venues that both have a pool.
    const venuesInPriorityOrder: {
      venue: BaseDexVenue
      resolvePool: (client: PublicClient, tokenAddress: `0x${string}`, pairedWith: `0x${string}`) => Promise<`0x${string}` | null>
      readPrice: (client: PublicClient, poolAddress: `0x${string}`, tokenAddress: `0x${string}`, pairedWith: `0x${string}`, blockNumber: bigint) => Promise<number | null>
    }[] = [
      { venue: 'uniswap_v3', resolvePool: resolvePoolAddress, readPrice: readPoolPrice },
      { venue: 'aerodrome_slipstream', resolvePool: resolveAerodromeSlipstreamPoolAddress, readPrice: readSlipstreamPoolPrice },
      { venue: 'aerodrome_classic_volatile', resolvePool: resolveAerodromeClassicVolatilePoolAddress, readPrice: readAerodromeClassicVolatilePoolPrice },
    ]

    for (const { venue, resolvePool, readPrice } of venuesInPriorityOrder) {
      for (const quote of quotes) {
        const usd = await tryBaseDexVenue(venue, quote.label, quote.address, tokenAddress, client, blockNumber, timestamp, attempts, resolvePool, readPrice)
        if (usd !== null) {
          if (venue === 'aerodrome_slipstream' || venue === 'aerodrome_classic_volatile') {
            recordAerodromeAttribution(chain, token, timestamp, venue, usd)
          }
          return { priceUsd: usd, reason: null, venue, attempts, rpcCallsUsed: totalBaseDexRpcCallsThisScan - rpcCallsAtStart }
        }
      }
    }

    return { priceUsd: null, reason: 'no_dex_pool_found_any_venue', attempts, rpcCallsUsed: totalBaseDexRpcCallsThisScan - rpcCallsAtStart }
  } catch (err) {
    return { priceUsd: null, reason: `rpc_error:${err instanceof Error ? err.message : 'unknown'}`, attempts, rpcCallsUsed: totalBaseDexRpcCallsThisScan - rpcCallsAtStart }
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
