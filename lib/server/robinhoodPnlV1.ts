// ROBINHOOD PNL V1 — verified-only, bounded, additive to the Robinhood sidecar.
//
// WHY THE OLD LANE NEVER VERIFIED A SWAP (audit, kept here so the fix stays honest):
//  1. Swap logs never reached the decoder. resolveRobinhoodWalletActivity only decodes logs it already
//     holds. When GoldRush has no Robinhood rows, the Blockscout fallback rebuilds each tx from the
//     address token-transfers endpoint as synthetic `Transfer` logs only, and the per-tx log lookup is
//     gated on "this tx has no logs" — a synthetic Transfer counts as a log, so the real receipt (with the
//     PoolManager Swap) is never fetched. Result: decodedSwapCount 0, verifiedSwapCount 0.
//  2. Even a decoded swap could only reach 'high' confidence with CURRENT prices (holdings / DexScreener
//     spot), which a historical PnL must never use; native ETH was unpriced unless still held.
//  3. Pool currencies came from an eth_getLogs over block 0..latest per Swap log, which range-limited
//     RPCs refuse; the swap timestamp fell back to the epoch; and each hop of a multi-hop route was
//     treated as its own wallet trade with no proof the wallet took part.
//
// THIS LANE: candidate tx hashes (from the activity the sidecar already fetched) → exact receipts from the
// Robinhood RPC → a tx-level V4 route proof (canonical PoolManager only, the wallet signed the tx, the
// wallet's own exact in/out amounts reproduced by ONE connected path of PoolManager swaps, nothing else
// economic in the tx) → historical USD for both legs → the existing deterministic FIFO, kept apart from
// Base/ETH under its own chain label. Every limit is hard and every failure is a named rejection.
//
// SIGN CONVENTION: V4's Swap event carries the swapper's BalanceDelta. Like src/lib/v4RouteQuote.ts, both
// readings are tried per path (never mixed) and only the one that reproduces the wallet's own exact
// amounts can pass, so the convention is proven by the wallet's transfers, not assumed.

import { encodeAbiParameters, keccak256, toFunctionSelector, type Hex } from 'viem'
import { buildFifoOutput, type SupportedChain } from '../../src/modules/fifoEngine'
import type { NormalizedEvent } from '../../src/modules/normalization/types'
import { CHAIN_ASSET_REGISTRY } from './chainAssetRegistry'
import { ROBINHOOD_V4_POOL_MANAGER } from './uniswapV4RobinhoodRpc'
import { getRobinhoodRpcUrl } from './robinhoodChainConfig'
import { fetchCoingeckoEthUsdRange } from './coingeckoOnchainOhlcv'
import { nearestPriceWithGap } from '../v4SwapCandles'
import { analyzeRobinhoodMixedRoute, deriveRhNativeEvidence, NATIVE_ASSET, V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, type RhMixedClassification, type RhNativeEvidence, type RhNativeTraceAudit, type RhNativeTraceResult, type RhNativeTransfer, type RobinhoodMixedRouteForensics } from './robinhoodMixedRouteForensics'
import { buildRobinhoodSwapForensics, summarizeAttribution, type RhAttributionClass, type RobinhoodSwapForensics } from './robinhoodSwapForensics'
import { classifyRobinhoodAcquisition, robinhoodUnmatchedSellRaw, type RhAcquisitionClass } from './robinhoodAcquisitionRecovery'

// ── Limits ────────────────────────────────────────────────────────────────────────────────────────
export const ROBINHOOD_PNL_V1_LIMITS = {
  maxCandidateReceipts: 20,
  maxHistoricalPriceSides: 20,
  concurrency: 3,
  deadlineMs: 15_000,
  rpcTimeoutMs: 6_000,
  providerTimeoutMs: 6_000,
} as const
/** A route leftover is a fee only up to this fraction of the flow it came from (same bound as v4RouteQuote). */
export const ROBINHOOD_ROUTE_MAX_FEE_FRACTION = 0.01
/** ETH/USD point must be within this distance of the swap (hourly series; same bound as Token Scanner V4 history). */
export const ROBINHOOD_ETH_USD_MAX_GAP_MS = 45 * 60_000
/** Robinhood's own sample rule: verified lots must be at least half of the structural closed lots. */
export const ROBINHOOD_PNL_V1_MIN_COVERAGE_PCT = 50
const ETH_SERIES_MAX_WINDOW_SEC = 85 * 86_400
/**
 * Acquisition recovery: only for a verified sell the FIFO left (partly) unmatched. One sell lane, at most 8
 * earlier inbound txs of that exact token, with its own small time budget. The 20-receipt cap is untouched.
 */
export const ROBINHOOD_ACQUISITION_RECOVERY_LIMITS = { maxSellLanes: 1, maxCandidatesPerSell: 8, budgetMs: 5_000 } as const
export const ROBINHOOD_DEEP_ACQUISITION_LIMITS = { maxSellLanes: 1, maxPages: 4, maxInboundCandidates: 20, maxReceiptProofs: 8, budgetMs: 8_000 } as const
export const ROBINHOOD_RPC_ACQUISITION_LIMITS = {
  fixedFallbackLookbackBlocks: 2_000_000, historicalMarginBlocks: 1_000_000,
  maxAbsoluteLookbackBlocks: 8_000_000, initialChunkBlocks: 250_000,
  maxSuccessfulChunks: 32, maxAttempts: 48, maxLogsPerChunk: 1_000,
  maxCandidates: 20, budgetMs: 8_000,
} as const

// ── Protocol constants ──────────────────────────────────────────────────────────────────────────────
export const RH_NATIVE = '0x0000000000000000000000000000000000000000'
export const RH_WETH = CHAIN_ASSET_REGISTRY.robinhood.wrappedNative!.address.toLowerCase()
const RH_STABLES: ReadonlyMap<string, number> = new Map(CHAIN_ASSET_REGISTRY.robinhood.verifiedUsdStables.map((s) => [s.address.toLowerCase(), s.decimals]))
const POOL_MANAGER = ROBINHOOD_V4_POOL_MANAGER.toLowerCase()
// Uniswap V4 PositionManager on Robinhood Chain (lib/server/lpProof.ts, Uniswap deployments/4663.md).
export const RH_V4_POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
export const V4_SWAP_TOPIC0 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
const V4_INITIALIZE_TOPIC0 = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
export const V4_MODIFY_LIQUIDITY_TOPIC0 = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'
export const ERC20_TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// Other venues' events (src/modules/receiptSwapDecoder/signatures.ts): a tx that also trades or moves
// liquidity elsewhere is not a single proven V4 trade.
const OTHER_VENUE_SWAP_TOPICS = new Set([
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', // V2 Swap
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', // V3 Swap
])
const LIQUIDITY_TOPICS = new Set([
  V4_MODIFY_LIQUIDITY_TOPIC0,
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f', // V2 Mint
  '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496', // V2 Burn
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde', // V3 Mint
  '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c', // V3 Burn
])
const POOL_KEYS_SELECTOR = toFunctionSelector('poolKeys(bytes25)')
const DECIMALS_SELECTOR = '0x313ce567'
const ROBINHOOD_FIFO_CHAIN = 'robinhood' as unknown as SupportedChain

// ── Types ───────────────────────────────────────────────────────────────────────────────────────────
export type RhRpcCall = { method: string; params: unknown[] }
/** One verified historical ETH/USD answer for a swap timestamp. */
export type RhEthUsdPoint = { priceUsd: number; provider: string; endpoint: string | null; pointMs: number; gapMs: number; maxAllowedGapMs: number; persistentCacheHit?: boolean }
/** One JSON-RPC batch; each slot is the call's result, or null when that call failed. Never throws. */
export type RhRpc = (calls: RhRpcCall[]) => Promise<Array<unknown | null>>
export type RhRpcLogResult = { status: 'ok'; logs: unknown[] } | { status: 'range_limit' | 'unavailable'; logs: null }
export type RhRpcLogQuery = { address: string; topics: [string, null, string]; fromBlock: string; toBlock: string }
export type RhPoolKey = { currency0: string; currency1: string }
export type RhHistoricalTokenPrice = { priceUsd: number; source: string }

export type RobinhoodPnlV1Deps = {
  rpc: RhRpc | null
  /** Hour-aligned historical ETH/USD points ([ms, usd], ascending) for [fromSec, toSec] — the fallback source. */
  ethUsdRange: (fromSec: number, toSec: number) => Promise<Array<[number, number]> | null | { points: Array<[number, number]> | null; httpStatus?: number | null; failure?: string | null; cacheHit?: boolean }>
  /**
   * Primary source: a verified historical ETH/USD for one swap timestamp (seconds) from the shared ChainLens
   * historical-native resolver (UTC-day bucket, permanently cached, no current price). Injected by the sidecar
   * scan so this lane never imports the Base/ETH pricing stack. Null when it has no verified answer.
   */
  ethUsdAt?: (timestampSec: number) => Promise<RhEthUsdPoint | null>
  /** Scan orchestration only: reserve verified native-leg UTC days before broad EVM pricing. */
  prefetchNativeEthDays?: (swaps: readonly RhVerifiedSwap[]) => Promise<void>
  onNativePricePrefetchComplete?: () => void
  /** Trusted historical provider, exact token + timestamp. Null when it has no answer. */
  tokenHistoricalUsd: (token: string, timestampSec: number) => Promise<RhHistoricalTokenPrice | null>
  now: () => number
  /** Forensics only: the target tx's internal native transfers (execution trace); null when unavailable. */
  nativeTransfersForTx?: (txHash: string) => Promise<RhNativeTransfer[] | null | RhNativeTraceResult>
  /** Blockscout history is only a candidate index; every row still needs the existing receipt classifier. */
  historicalTokenInbounds?: (wallet: string, token: string, beforeTimestampSec: number, deadlineAt: number) => Promise<RhHistoricalInboundResult>
  /** Token-centric Blockscout candidate index, used only after address history yields no new candidate. */
  tokenHistoryInbounds?: (wallet: string, token: string, beforeTimestampSec: number, deadlineAt: number) => Promise<RhTokenHistoryResult>
  /** Exact token/recipient RPC Transfer-log index. Never proof of a buy on its own. */
  rpcInboundTransferLogs?: (query: RhRpcLogQuery, deadlineAt: number) => Promise<RhRpcLogResult>
}

export type RobinhoodPnlV1Candidate = { txHash: string; timestampMs: number | null; hasSwapLog: boolean }

export type RhRejection =
  | 'receipt_unavailable' | 'tx_reverted' | 'wallet_not_tx_sender' | 'no_v4_swap_in_tx' | 'wrong_pool_manager'
  | 'other_venue_swap_in_tx' | 'liquidity_event_in_tx' | 'pool_key_unproven' | 'malformed_swap_delta'
  | 'native_flow_unprovable' | 'ambiguous_wallet_flows' | 'no_wallet_input_or_output' | 'route_does_not_chain'
  | 'route_does_not_match_wallet_amounts' | 'ambiguous_route' | 'unrelated_second_action'
  | 'decimals_unavailable' | 'timestamp_unavailable' | 'deadline_exceeded'

export type RhVerifiedSwap = {
  txHash: string
  blockNumber: number
  firstLogIndex: number
  timestampSec: number
  inputToken: string
  outputToken: string
  inputRaw: bigint
  outputRaw: bigint
  inputDecimals: number
  outputDecimals: number
  hops: Array<{ poolId: string; inCurrency: string; outCurrency: string; inRaw: string; outRaw: string }>
  /** The canonical (native/WETH/stable) currency the route passes through, with its exact amount. */
  intermediary: { currency: string; kind: 'native' | 'stable'; raw: bigint; decimals: number } | null
}

export type RhPriceEvidence = {
  swapTxHash: string
  inputToken: string
  outputToken: string
  inputAmount: number
  outputAmount: number
  inputPriceUsd: number | null
  outputPriceUsd: number | null
  inputSource: string | null
  outputSource: string | null
  bothLegsVerified: boolean
  rejectionReason: string | null
}

export type RobinhoodPnlV1Status = 'verified_bounded_sample' | 'partial' | 'not_verified' | 'unavailable'

export type RobinhoodPnlV1Metrics = {
  robinhoodPnlMs: number
  receiptCalls: number
  rpcCalls: number
  historicalPriceCalls: number
  cacheHits: number
  swapsVerified: number
  lotsBuilt: number
  deadlineHit: boolean
  /** Target-tx native trace lookups requested (bounded further by the native_trace Blockscout lane). */
  nativeTraceLookups: number
}

export type RobinhoodPnlV1IngestionAudit = {
  wallet: string
  transactionCount: number
  transferCount: number
  candidateSwapTxCount: number
  candidatesDroppedByCap: number
  receiptsFetched: number
  v4SwapLogCount: number
  verifiedSwapTxCount: number
  rejectedSwapTxCount: number
  rejectionReasons: Partial<Record<RhRejection, number>>
  normalizedBuyCount: number
  normalizedSellCount: number
  /** Forensics only: A/B/C/D classification counts for receipts with canonical V4 swaps (acceptance unchanged). */
  v4AttributionClasses?: Record<RhAttributionClass, number>
  /** Forensics only: mixed-venue (V4 + V2/V3) receipt classes (acceptance unchanged). */
  mixedRouteClasses?: Record<RhMixedClassification, number>
  directV4VerifiedSwapCount?: number
  mixedRouteVerifiedSwapCount?: number
  mixedRouteRejectedCount?: number
  mixedRouteRejectedReasons?: Record<string, number>
  acquisitionRecovery?: RhAcquisitionRecoverySummary | null
  deepAcquisition?: RhDeepAcquisitionSummary | null
}

export type RhInboundTokenTransfer = { txHash: string; timestampMs: number | null; token: string; rawAmount: string | null }
export type RhHistoricalInboundResult = {
  rows: RhInboundTokenTransfer[]; pagesRequested: number; pagesSucceeded: number; olderInboundRowsFound: number
  filteredPagesRequested?: number; fallbackPagesRequested?: number; fallbackActivated?: boolean; exactTokenRowsFound?: number
  historicalRangeStart: number | null; historicalRangeEnd: number | null; stopReason: string
}
export type RhTokenHistoryResult = {
  rows: RhInboundTokenTransfer[]; pagesRequested: number; pagesSucceeded: number; rowsReturned: number
  walletMatches: number; candidatesFound: number; stopReason: string
}
export type RhDeepAcquisitionSummary = {
  deepAcquisitionAttempted: boolean; sellTxHash: string; token: string; pagesRequested: number; pagesSucceeded: number
  filteredPagesRequested: number; fallbackPagesRequested: number; fallbackActivated: boolean; exactTokenRowsFound: number
  historicalRangeStart: number | null; historicalRangeEnd: number | null; historicalCandidatesFound: number
  olderInboundRowsFound: number; candidatesSelected: number; receiptsAttempted: number; verifiedBuysRecovered: number
  recoveredBuyRaw: string; unmatchedSellRawBefore: string; unmatchedSellRawAfter: string; closedLotsAdded: number
  stopReason: string; elapsedMs: number
  tokenHistoryAttempted: boolean; tokenHistoryPagesRequested: number; tokenHistoryPagesSucceeded: number
  tokenHistoryRowsReturned: number; tokenHistoryWalletMatches: number; tokenHistoryCandidatesFound: number
  tokenHistoryStopReason: string | null; tokenHistoryExcludedCurrentSampleHashes: string[]
  rpcHistory: RhRpcAcquisitionHistoryAudit | null
}
export type RhRpcAcquisitionHistoryAudit = {
  sellTxHash: string; sellBlock: number; token: string; wallet: string; fromBlock: number; toBlock: number
  chunksAttempted: number; chunksSucceeded: number; chunkRanges: Array<{ fromBlock: number; toBlock: number; status: string }>
  rangeShrinks: number; logsReturned: number; exactInboundLogs: number; uniqueTxCandidates: number
  knownCurrentSampleTxsFound: string[]; newCandidatesFound: number; receiptsAttempted: number
  verifiedBuysRecovered: number; recoveredBuyRaw: string; unmatchedSellRawAfter: string; closedLotsAdded: number
  stopReason: string; historyCoverage: 'bounded_block_lookback'; lookbackBlocks: number
  lowestScannedBlock: number | null; boundedLookbackComplete: boolean
  coverageTarget: 'earliest_known_inbound_plus_margin' | 'fixed_fallback'
  earliestKnownInboundBlock: number | null; targetFromBlock: number
  reachedEarliestKnownInbound: boolean; reachedHistoricalMargin: boolean
  knownInboundHashesExpected: string[]; knownInboundHashesFound: string[]
  knownInboundCoverageComplete: boolean; absoluteLookbackCapHit: boolean
  historicalMarginBlocks: number; maxAbsoluteLookbackBlocks: number
  rawInboundAnchorHashes: string[]; recoveryCandidateAnchorHashes: string[]; unionAnchorHashes: string[]
  cachedReceiptAnchorsResolved: Array<{ txHash: string; blockNumber: number }>
  cachedReceiptAnchorsMissing: Array<{ txHash: string; reason: 'missing_cached_receipt' }>
  cachedReceiptAnchorsRejected: Array<{ txHash: string; reason: 'invalid_block' | 'post_sell_block' | 'receipt_missing_wallet_token_credit' }>
}

export type RhAcquisitionRecoverySummary = {
  acquisitionRecoveryAttempted: boolean
  sellTxHash: string | null
  token: string | null
  candidatesFound: number
  candidatesAttempted: number
  candidateTxHashes: string[]
  recoveredBuyCount: number
  recoveredBuyRaw: string
  unmatchedSellRawBefore: string | null
  unmatchedSellRawAfter: string | null
  closedLotsAdded: number
  classifications: Partial<Record<RhAcquisitionClass, number>>
}

export type RobinhoodPnlV1 = {
  status: RobinhoodPnlV1Status
  structuralClosedLots: number
  verifiedClosedLots: number
  /** Verified / structural closed lots, percent (2 dp); null when no lot closed. */
  pricingCoverage: number | null
  /** Null whenever no verified lot closed — $0 is only ever a real, verified break-even. */
  realizedPnlUsd: number | null
  realizedRoiPct: number | null
  unmatchedSellCount: number
  exactReason: string
  swapsFound: number
  swapsVerified: number
  swapsBothLegsPriced: number
  ingestionAudit: RobinhoodPnlV1IngestionAudit
  priceEvidence: RhPriceEvidence[]
  metrics: RobinhoodPnlV1Metrics
  /** Targeted acquisition recovery for a verified, FIFO-unmatched sell (null when the lane did not run). */
  acquisitionRecovery?: RhAcquisitionRecoverySummary | null
  deepAcquisition?: RhDeepAcquisitionSummary | null
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────────
const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '')
const abs = (v: bigint) => (v < BigInt(0) ? -v : v)
const ZERO = BigInt(0)
function hexToBigInt(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^0x[0-9a-f]*$/i.test(v)) return null
  return v === '0x' ? ZERO : BigInt(v)
}
function hexToNum(v: unknown): number | null {
  const b = hexToBigInt(v)
  return b == null ? null : Number(b)
}
function word(data: string, index: number): string | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const w = hex.slice(index * 64, index * 64 + 64)
  return w.length === 64 && /^[0-9a-f]+$/i.test(w) ? w : null
}
function signedWord(data: string, index: number): bigint | null {
  const w = word(data, index)
  if (!w) return null
  const v = BigInt(`0x${w}`)
  return v >= BigInt(2) ** BigInt(255) ? v - BigInt(2) ** BigInt(256) : v
}
function withinFee(leftover: bigint, flow: bigint): boolean {
  if (leftover < ZERO) return false
  if (leftover === ZERO) return true
  return leftover * BigInt(10_000) <= flow * BigInt(Math.round(ROBINHOOD_ROUTE_MAX_FEE_FRACTION * 10_000))
}
/** WETH and native are one currency for matching a wallet endpoint to a route endpoint (wrap/unwrap settlement). */
const sameAsset = (a: string, b: string) => a === b || ((a === RH_NATIVE || a === RH_WETH) && (b === RH_NATIVE || b === RH_WETH))
function quoteKind(currency: string): 'native' | 'stable' | null {
  if (currency === RH_NATIVE || currency === RH_WETH) return 'native'
  if (RH_STABLES.has(currency)) return 'stable'
  return null
}
function toUnits(raw: bigint, decimals: number): number {
  const scale = BigInt(10) ** BigInt(decimals)
  return Number(raw / scale) + Number(raw % scale) / Number(scale)
}
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// ── Process caches (immutable chain facts only) + singleflight ─────────────────────────────────────
const CACHE_MAX = 1_000
const receiptCache = new Map<string, Promise<RhReceipt | null>>()
const poolKeyCache = new Map<string, Promise<RhPoolKey | null>>()
const decimalsCache = new Map<string, Promise<number | null>>()
const tokenPriceCache = new Map<string, Promise<RhHistoricalTokenPrice | null>>()
function remember<V>(map: Map<string, Promise<V>>, key: string, make: () => Promise<V>, onHit: () => void, keep: (v: V) => boolean): Promise<V> {
  const hit = map.get(key)
  if (hit) { onHit(); return hit }
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value!)
  const p = make()
  map.set(key, p)
  // Failures are not remembered: a timeout must never become a cached "no".
  p.then((v) => { if (!keep(v)) map.delete(key) }, () => map.delete(key))
  return p
}
/** Test hook. */
export function __resetRobinhoodPnlV1CachesForTest(): void {
  receiptCache.clear(); poolKeyCache.clear(); decimalsCache.clear(); tokenPriceCache.clear()
}

// ── Receipt-level evidence ──────────────────────────────────────────────────────────────────────────
type RhLog = { address: string; topics: string[]; data: string; logIndex: number; blockTimestamp: number | null }
export type RhReceipt = { status: number | null; from: string; to: string | null; blockNumber: number; gasUsed: bigint; effectiveGasPrice: bigint; logs: RhLog[] }

function parseReceipt(raw: unknown): RhReceipt | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  const blockNumber = hexToNum(r.blockNumber)
  if (blockNumber == null || !Array.isArray(r.logs)) return null
  const logs: RhLog[] = []
  for (const l of r.logs as Array<Record<string, unknown>>) {
    if (!l || l.removed === true) continue
    logs.push({
      address: lower(l.address),
      topics: Array.isArray(l.topics) ? (l.topics as unknown[]).map(lower) : [],
      data: typeof l.data === 'string' ? l.data : '0x',
      logIndex: hexToNum(l.logIndex) ?? 0,
      blockTimestamp: hexToNum(l.blockTimestamp),
    })
  }
  return {
    status: hexToNum(r.status),
    from: lower(r.from),
    to: typeof r.to === 'string' ? lower(r.to) : null,
    blockNumber,
    gasUsed: hexToBigInt(r.gasUsed) ?? ZERO,
    effectiveGasPrice: hexToBigInt(r.effectiveGasPrice) ?? ZERO,
    logs,
  }
}

// ── Run context ─────────────────────────────────────────────────────────────────────────────────────
type Ctx = {
  deps: RobinhoodPnlV1Deps
  rpc: RhRpc
  deadlineAt: number
  m: RobinhoodPnlV1Metrics
  priceSidesUsed: number
}
async function call(ctx: Ctx, calls: RhRpcCall[]): Promise<Array<unknown | null>> {
  ctx.m.rpcCalls += calls.length
  try {
    const out = await ctx.rpc(calls)
    return calls.map((_, i) => out[i] ?? null)
  } catch {
    return calls.map(() => null)
  }
}

/** Pool currencies, proven: PositionManager.poolKeys(bytes25) whose keccak(PoolKey) equals the PoolId; else the PoolManager's own Initialize log. */
export async function resolveRobinhoodPoolKey(poolId: string, rpc: RhRpc, onCall: (n: number) => void = () => {}, onHit: () => void = () => {}): Promise<RhPoolKey | null> {
  const id = lower(poolId)
  if (!/^0x[0-9a-f]{64}$/.test(id)) return null
  return remember(poolKeyCache, id, async () => {
    const arg = id.slice(2, 52).padEnd(64, '0')
    onCall(1)
    const [res] = await rpc([{ method: 'eth_call', params: [{ to: RH_V4_POSITION_MANAGER, data: `${POOL_KEYS_SELECTOR}${arg}` }, 'latest'] }]).catch(() => [null])
    if (typeof res === 'string') {
      const w = [0, 1, 2, 3, 4].map((i) => word(res, i))
      if (w.every(Boolean)) {
        const c0 = `0x${w[0]!.slice(24)}`
        const c1 = `0x${w[1]!.slice(24)}`
        const fee = Number(BigInt(`0x${w[2]}`))
        let tick = BigInt(`0x${w[3]}`)
        if (tick >= BigInt(2) ** BigInt(255)) tick -= BigInt(2) ** BigInt(256)
        const hooks = `0x${w[4]!.slice(24)}`
        const tickSpacing = Number(tick)
        if (tickSpacing !== 0) {
          const hash = keccak256(encodeAbiParameters(
            [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
            [c0 as Hex, c1 as Hex, fee, tickSpacing, hooks as Hex],
          ))
          if (hash.toLowerCase() === id) return { currency0: c0, currency1: c1 }
        }
      }
    }
    onCall(1)
    const [logs] = await rpc([{ method: 'eth_getLogs', params: [{ address: ROBINHOOD_V4_POOL_MANAGER, topics: [V4_INITIALIZE_TOPIC0, id], fromBlock: '0x0', toBlock: 'latest' }] }]).catch(() => [null])
    const init = Array.isArray(logs) ? (logs as Array<Record<string, unknown>>).find((l) => l && l.removed !== true && lower(l.address) === POOL_MANAGER && Array.isArray(l.topics) && lower((l.topics as unknown[])[1]) === id) : null
    const topics = (init?.topics as string[] | undefined) ?? []
    if (topics.length >= 4) return { currency0: `0x${lower(topics[2]).slice(-40)}`, currency1: `0x${lower(topics[3]).slice(-40)}` }
    return null
  }, onHit, (v) => v != null)
}

async function tokenDecimals(ctx: Ctx, token: string): Promise<number | null> {
  if (token === RH_NATIVE) return 18
  if (token === RH_WETH) return 18
  const stable = RH_STABLES.get(token)
  if (stable != null) return stable
  return remember(decimalsCache, token, async () => {
    const [res] = await call(ctx, [{ method: 'eth_call', params: [{ to: token, data: DECIMALS_SELECTOR }, 'latest'] }])
    const d = hexToNum(res)
    return d != null && Number.isInteger(d) && d >= 0 && d <= 36 ? d : null
  }, () => { ctx.m.cacheHits += 1 }, (v) => v != null)
}

// ── Tx-level route verification (pure once the receipt, pool keys and native delta are known) ──────
export type RhRouteInput = {
  wallet: string
  txHash: string
  receipt: RhReceipt
  poolKeys: ReadonlyMap<string, RhPoolKey>
  /** Wallet's exact native balance change from this tx, gas added back; null when unproven. */
  nativeNet: bigint | null
}
export type RhRouteResult =
  | { ok: true; inputToken: string; outputToken: string; inputRaw: bigint; outputRaw: bigint; hops: RhVerifiedSwap['hops']; intermediary: { currency: string; kind: 'native' | 'stable'; raw: bigint } | null; firstLogIndex: number }
  | { ok: false; reason: RhRejection; detail: string }

/** Which pools a receipt swaps through on the canonical PoolManager, and whether native is touched (needs pool keys). */
export function robinhoodReceiptPreflight(wallet: string, receipt: RhReceipt): { ok: true; poolIds: string[] } | { ok: false; reason: RhRejection; detail: string } {
  if (receipt.status !== 1) return { ok: false, reason: 'tx_reverted', detail: `receipt status ${receipt.status}` }
  if (receipt.from !== lower(wallet)) return { ok: false, reason: 'wallet_not_tx_sender', detail: `tx signed by ${receipt.from}` }
  for (const l of receipt.logs) {
    const t0 = l.topics[0] ?? ''
    if (LIQUIDITY_TOPICS.has(t0)) return { ok: false, reason: 'liquidity_event_in_tx', detail: `liquidity event ${t0.slice(0, 10)} from ${l.address}` }
    if (OTHER_VENUE_SWAP_TOPICS.has(t0)) return { ok: false, reason: 'other_venue_swap_in_tx', detail: `non-V4 swap from ${l.address}` }
    if (t0 === V4_SWAP_TOPIC0 && l.address !== POOL_MANAGER) return { ok: false, reason: 'wrong_pool_manager', detail: `V4 Swap from ${l.address}` }
  }
  const swaps = receipt.logs.filter((l) => l.topics[0] === V4_SWAP_TOPIC0 && l.address === POOL_MANAGER)
  if (swaps.length === 0) return { ok: false, reason: 'no_v4_swap_in_tx', detail: 'no Swap from the canonical Robinhood PoolManager' }
  if (swaps.some((l) => !/^0x[0-9a-f]{64}$/.test(l.topics[1] ?? ''))) return { ok: false, reason: 'malformed_swap_delta', detail: 'Swap without a PoolId topic' }
  return { ok: true, poolIds: [...new Set(swaps.map((l) => l.topics[1]))] }
}

export function verifyRobinhoodV4Route(input: RhRouteInput): RhRouteResult {
  const wallet = lower(input.wallet)
  const swaps = input.receipt.logs.filter((l) => l.topics[0] === V4_SWAP_TOPIC0 && l.address === POOL_MANAGER)
  const fail = (reason: RhRejection, detail: string): RhRouteResult => ({ ok: false, reason, detail })
  const hops = swaps.map((l, index) => ({ index, logIndex: l.logIndex, poolId: l.topics[1], key: input.poolKeys.get(l.topics[1]), a0: signedWord(l.data, 0), a1: signedWord(l.data, 1) }))
  const unproven = hops.find((h) => !h.key)
  if (unproven) return fail('pool_key_unproven', unproven.poolId)
  if (hops.some((h) => h.a0 == null || h.a1 == null || h.a0 === ZERO || h.a1 === ZERO || (h.a0 < ZERO) === (h.a1 < ZERO))) {
    return fail('malformed_swap_delta', 'each hop must have exactly one negative and one positive delta')
  }
  const routeCurrencies = new Set(hops.flatMap((h) => [lower(h.key!.currency0), lower(h.key!.currency1)]))
  const nativeTouched = routeCurrencies.has(RH_NATIVE)

  // The wallet's own exact flows: ERC-20 Transfers in this receipt, plus the proven native delta.
  const walletNet = new Map<string, bigint>()
  for (const l of input.receipt.logs) {
    if (l.topics[0] !== ERC20_TRANSFER_TOPIC0 || l.topics.length !== 3) continue
    const from = `0x${l.topics[1].slice(-40)}`
    const to = `0x${l.topics[2].slice(-40)}`
    const w = word(l.data, 0)
    if (!w) continue
    const amount = BigInt(`0x${w}`)
    // Any token moving in this tx must be one the route trades (WETH settles a native route).
    if (!routeCurrencies.has(l.address) && !(nativeTouched && l.address === RH_WETH)) {
      return fail('unrelated_second_action', `transfer of ${l.address}, which no V4 hop in this tx trades`)
    }
    if (from === wallet) walletNet.set(l.address, (walletNet.get(l.address) ?? ZERO) - amount)
    if (to === wallet) walletNet.set(l.address, (walletNet.get(l.address) ?? ZERO) + amount)
  }
  if (nativeTouched) {
    if (input.nativeNet == null) return fail('native_flow_unprovable', 'route trades native ETH but the wallet native delta is unproven')
    if (input.nativeNet !== ZERO) walletNet.set(RH_NATIVE, (walletNet.get(RH_NATIVE) ?? ZERO) + input.nativeNet)
  }
  const ins = [...walletNet].filter(([, v]) => v < ZERO)
  const outs = [...walletNet].filter(([, v]) => v > ZERO)
  if (ins.length > 1 || outs.length > 1) return fail('ambiguous_wallet_flows', `wallet sent ${ins.length} and received ${outs.length} assets`)
  if (ins.length === 0 || outs.length === 0) return fail('no_wallet_input_or_output', `wallet sent ${ins.length} and received ${outs.length} assets`)
  const [walletInToken, walletInNeg] = ins[0]
  const [walletOutToken, walletOutRaw] = outs[0]
  const walletInRaw = -walletInNeg

  // Every directed path from the wallet's input to its output, hops in strictly increasing log order,
  // one sign reading per path. Exactly one may reproduce the wallet's amounts.
  type Directed = { index: number; logIndex: number; poolId: string; inCurrency: string; outCurrency: string; in: bigint; out: bigint }
  const MAX_PATHS = 64
  const MAX_HOPS = 6
  const candidates: Directed[][] = []
  for (const negativeIsInput of [true, false]) {
    const directed: Directed[] = hops.map((h) => {
      const c0 = lower(h.key!.currency0)
      const c1 = lower(h.key!.currency1)
      const zeroIsIn = (h.a0! < ZERO) === negativeIsInput
      return { index: h.index, logIndex: h.logIndex, poolId: h.poolId, inCurrency: zeroIsIn ? c0 : c1, outCurrency: zeroIsIn ? c1 : c0, in: abs(zeroIsIn ? h.a0! : h.a1!), out: abs(zeroIsIn ? h.a1! : h.a0!) }
    })
    const walk = (current: string, after: number, path: Directed[]) => {
      if (candidates.length > MAX_PATHS || path.length >= MAX_HOPS) return
      for (const h of directed) {
        if (h.index <= after || !(path.length === 0 ? sameAsset(h.inCurrency, current) : h.inCurrency === current)) continue
        const next = [...path, h]
        if (sameAsset(h.outCurrency, walletOutToken)) candidates.push(next)
        else walk(h.outCurrency, h.index, next)
      }
    }
    walk(walletInToken, -1, [])
  }
  if (candidates.length > MAX_PATHS) return fail('ambiguous_route', `more than ${MAX_PATHS} candidate paths`)
  if (candidates.length === 0) return fail('route_does_not_chain', `no connected V4 path from ${walletInToken} to ${walletOutToken} among ${hops.length} swaps`)
  const satisfies = (path: Directed[]): boolean => {
    if (!withinFee(walletInRaw - path[0].in, walletInRaw)) return false
    for (let i = 0; i + 1 < path.length; i++) if (!withinFee(path[i].out - path[i + 1].in, path[i].out)) return false
    const outLeft = path[path.length - 1].out - walletOutRaw
    // A token output may carry a transfer tax (the wallet's received amount is what counts); a quote-asset output may not.
    if (outLeft < ZERO) return false
    if (quoteKind(walletOutToken) && !withinFee(outLeft, path[path.length - 1].out)) return false
    return true
  }
  const satisfying = candidates.filter(satisfies)
  if (satisfying.length === 0) return fail('route_does_not_match_wallet_amounts', `wallet in ${walletInRaw} ${walletInToken} / out ${walletOutRaw} ${walletOutToken} not reproduced by any connected path`)
  if (satisfying.length > 1) return fail('ambiguous_route', `${satisfying.length} connected paths reproduce the wallet trade`)
  const path = satisfying[0]
  if (path.length !== hops.length) return fail('unrelated_second_action', `${hops.length - path.length} V4 swap(s) in this tx are not on the wallet's route`)

  const boundaries = path.slice(0, -1).map((h, i) => ({ currency: h.outCurrency, raw: path[i + 1].in }))
  const canon = boundaries.find((b) => quoteKind(b.currency) != null) ?? null
  return {
    ok: true,
    inputToken: walletInToken,
    outputToken: walletOutToken,
    inputRaw: walletInRaw,
    outputRaw: walletOutRaw,
    hops: path.map((h) => ({ poolId: h.poolId, inCurrency: h.inCurrency, outCurrency: h.outCurrency, inRaw: h.in.toString(), outRaw: h.out.toString() })),
    intermediary: canon ? { currency: canon.currency, kind: quoteKind(canon.currency)!, raw: canon.raw } : null,
    firstLogIndex: path[0].logIndex,
  }
}

type CandidateOutcome = { txHash: string; receiptFetched: boolean; v4SwapLogs: number; swap: RhVerifiedSwap | null; rejection: RhRejection | null; detail: string | null; forensics?: RobinhoodSwapForensics | null; mixedRoute?: RobinhoodMixedRouteForensics | null; acceptedVia?: 'direct_v4' | 'mixed_route'; mixedRejection?: string | null }

/**
 * Evidence for a receipt the preflight rejected (most often wallet_not_tx_sender): pool keys for its canonical
 * V4 swaps (shared cache) and, only if a pool trades native ETH, the wallet's exact native change in that
 * block — balance difference when the wallet sent nothing in the block (nonce unchanged), or balance
 * difference plus gas when this was the wallet's one tx. Never feeds acceptance.
 */
/**
 * One target-tx trace lookup (only for a wallet-sent tx whose native endpoint actually needs proof). Always
 * logs exactly one [robinhood-native-trace-audit] line — including when it was not attempted — so a missing
 * trace says why. Returns transfers only for a complete trace with explicit execution status.
 */
async function fetchNativeTrace(ctx: Ctx, wallet: string, txHash: string): Promise<RhNativeTransfer[] | null> {
  const base = (result: RhNativeTraceAudit['result']): RhNativeTraceAudit => ({
    txHash, attempted: false, cacheHit: false, budgetLane: 'native_trace', requestHost: null, authMode: null, httpStatus: null,
    failureClass: null, transportAttempts: [], itemCount: null, paginated: false, malformed: false, missingSuccessStatus: false,
    pagesRequested: 0, pagesSucceeded: 0, totalItemCount: null, paginationComplete: false, paginationCap: null, paginationCapHit: false, pageTransportAttempts: [], result,
  })
  let res: RhNativeTraceResult
  if (!ctx.deps.nativeTransfersForTx) res = { transfers: null, audit: base('not_attempted_no_trace_source') }
  else if (Date.now() >= ctx.deadlineAt) res = { transfers: null, audit: base('not_attempted_deadline') }
  else {
    ctx.m.nativeTraceLookups += 1
    const raw = await ctx.deps.nativeTransfersForTx(txHash).catch(() => null)
    // Injected sources may return the bare transfer list (complete trace) or null (unavailable).
    res = raw == null || Array.isArray(raw)
      ? { transfers: raw, audit: { ...base(raw == null ? 'transport_failed' : raw.length === 0 ? 'empty' : 'proven'), attempted: true, itemCount: raw?.length ?? null } }
      : raw
  }
  const audit = res.audit ?? base(res.transfers ? (res.transfers.length === 0 ? 'empty' : 'proven') : 'transport_failed')
  const ok = (res.transfers ?? []).filter((t) => t.success === true && t.value > BigInt(0))
  const w = lower(wallet)
  console.warn('[robinhood-native-trace-audit]', {
    ...audit,
    nativeToWalletRaw: res.transfers ? ok.filter((t) => t.to.toLowerCase() === w).reduce((s, t) => s + t.value, BigInt(0)).toString() : null,
    nativeFromWalletRaw: res.transfers ? ok.filter((t) => t.from.toLowerCase() === w).reduce((s, t) => s + t.value, BigInt(0)).toString() : null,
  })
  return res.transfers
}

async function forensicsForRejectedReceipt(ctx: Ctx, wallet: string, txHash: string, receipt: RhReceipt, rejection: RhRejection): Promise<{ forensics: RobinhoodSwapForensics; mixedRoute: RobinhoodMixedRouteForensics | null }> {
  const timestampSec = receipt.logs.find((l) => l.blockTimestamp != null)?.blockTimestamp ?? null
  const poolIds = [...new Set(receipt.logs.filter((l) => l.topics[0] === V4_SWAP_TOPIC0 && l.address === POOL_MANAGER && /^0x[0-9a-f]{64}$/.test(l.topics[1] ?? '')).map((l) => l.topics[1]))]
  const poolKeys = new Map<string, RhPoolKey>()
  if (poolIds.length > 0 && Date.now() < ctx.deadlineAt) {
    for (const id of poolIds) {
      const key = await resolveRobinhoodPoolKey(id, ctx.rpc, (n) => { ctx.m.rpcCalls += n }, () => { ctx.m.cacheHits += 1 })
      if (key) poolKeys.set(id, { currency0: lower(key.currency0), currency1: lower(key.currency1) })
    }
  }
  const isSender = receipt.from === lower(wallet)
  const mixed = poolIds.length > 0 && receipt.logs.some((l) => l.topics[0] === V2_SWAP_TOPIC0 || l.topics[0] === V3_SWAP_TOPIC0)
  const nativeTouched = [...poolKeys.values()].some((k) => k.currency0 === RH_NATIVE || k.currency1 === RH_NATIVE)
  const N = receipt.blockNumber
  const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice
  let native: RhNativeEvidence = { walletBalanceBefore: null, walletBalanceAfter: null, gasPaid: gasPaid.toString(), txValue: null, walletTxsInBlock: null, blockBalanceDeltaExGas: null, traceSource: null, traceNativeToWallet: null, traceNativeFromWallet: null, nativeNetExGas: null, status: 'not_needed' }
  let walletNativeDelta: bigint | null = null
  // A mixed route can end in native ETH (V3 WETH pool + unwrap) without any V4 pool trading native, so its
  // wallet-sent receipts always get the exact balance proof: after − before + gas, unique when the wallet's
  // nonce advanced by exactly one in that block.
  if ((nativeTouched || (mixed && isSender)) && N > 0 && Date.now() < ctx.deadlineAt) {
    const hex = (n: number) => `0x${n.toString(16)}`
    const [b0r, b1r, n0r, n1r, txr] = await call(ctx, [
      { method: 'eth_getBalance', params: [wallet, hex(N - 1)] },
      { method: 'eth_getBalance', params: [wallet, hex(N)] },
      { method: 'eth_getTransactionCount', params: [wallet, hex(N - 1)] },
      { method: 'eth_getTransactionCount', params: [wallet, hex(N)] },
      { method: 'eth_getTransactionByHash', params: [txHash] },
    ])
    const [b0, b1, n0, n1] = [hexToBigInt(b0r), hexToBigInt(b1r), hexToNum(n0r), hexToNum(n1r)]
    // Existing swap forensics keep their block-delta reading (diagnostic, unchanged).
    if (b0 != null && b1 != null && n0 != null && n1 != null) {
      if (n1 === n0 && !isSender) walletNativeDelta = b1 - b0
      else if (n1 - n0 === 1 && isSender) walletNativeDelta = b1 - b0 + gasPaid
    }
    // Mixed routes: native attribution only from the target tx's own trace (bounded: wallet-sent mixed receipts).
    const trace = mixed && isSender ? await fetchNativeTrace(ctx, wallet, txHash) : null
    native = deriveRhNativeEvidence({
      wallet, isSender, gasPaid, txValue: hexToBigInt((txr as Record<string, unknown> | null)?.value),
      balanceBefore: b0, balanceAfter: b1, nonceBefore: n0, nonceAfter: n1, trace,
    })
  }
  const forensics = buildRobinhoodSwapForensics({ wallet, txHash, timestampSec, receipt, poolManager: POOL_MANAGER, poolKeys, walletNativeDelta, rejectionReason: rejection })
  const mixedRoute = mixed ? analyzeRobinhoodMixedRoute({ wallet, txHash, receipt, poolManager: POOL_MANAGER, v4PoolKeys: poolKeys, native }) : null
  return { forensics, mixedRoute }
}

const assetAddress = (asset: string) => (asset === NATIVE_ASSET ? RH_NATIVE : asset)

/**
 * A direct_mixed_route_proven route as the same RhVerifiedSwap a direct V4 swap produces: the wallet's exact
 * route endpoints (a native endpoint only ever comes from the target tx's own trace — the analyzer never
 * reads a block balance delta), the connected hops in log order, and the exact native amount the route
 * passed through (for token↔token routes priced via ETH). Anything short of that stays rejected.
 */
async function promoteMixedRoute(ctx: Ctx, txHash: string, receipt: RhReceipt, m: RobinhoodMixedRouteForensics): Promise<{ swap: RhVerifiedSwap | null; reason: string }> {
  if (m.finalClassification !== 'direct_mixed_route_proven') return { swap: null, reason: `${m.finalClassification}: ${m.reason}` }
  if (!m.singleConnectedEconomicRoute || !m.amountConservationPassed || !m.ownershipProven) return { swap: null, reason: 'route proof incomplete' }
  if (m.outsideFundingFlows.length > 0 || m.unrelatedWalletFlows.length > 0 || m.excludedSwapIndexes.length > 0) return { swap: null, reason: 'route has outside funding, unrelated wallet flows or excluded swaps' }
  if (!m.walletInputToken || !m.walletInputRaw || !m.walletOutputToken || !m.walletOutputRaw) return { swap: null, reason: 'route endpoints missing' }
  const nativeLeg = m.walletInputToken === NATIVE_ASSET || m.walletOutputToken === NATIVE_ASSET
  if (nativeLeg && m.nativeAttributionStatus !== 'proven_target_tx_native_transfer') return { swap: null, reason: `native endpoint without target-tx trace proof (${m.nativeAttributionStatus})` }
  const inputToken = assetAddress(m.walletInputToken)
  const outputToken = assetAddress(m.walletOutputToken)
  let timestampSec = receipt.logs.find((l) => l.blockTimestamp != null)?.blockTimestamp ?? null
  if (timestampSec == null) {
    const [blk] = await call(ctx, [{ method: 'eth_getBlockByNumber', params: [`0x${receipt.blockNumber.toString(16)}`, false] }])
    timestampSec = hexToNum((blk as Record<string, unknown> | null)?.timestamp)
  }
  if (timestampSec == null || timestampSec <= 0) return { swap: null, reason: 'timestamp_unavailable' }
  const [inputDecimals, outputDecimals] = await Promise.all([tokenDecimals(ctx, inputToken), tokenDecimals(ctx, outputToken)])
  if (inputDecimals == null || outputDecimals == null) return { swap: null, reason: 'decimals_unavailable' }
  const connected = m.hops.filter((h) => m.connectedSwapIndexes.includes(h.index))
  // Native the route passed through (consumed by hops) — only meaningful when neither endpoint is a quote asset.
  const nativeThrough = connected.filter((h) => h.inToken === NATIVE_ASSET).reduce((s, h) => s + BigInt(h.inRaw ?? '0'), ZERO)
  return {
    reason: 'accepted',
    swap: {
      txHash,
      blockNumber: receipt.blockNumber,
      firstLogIndex: Math.min(...connected.map((h) => h.logIndex)),
      timestampSec,
      inputToken,
      outputToken,
      inputRaw: BigInt(m.walletInputRaw),
      outputRaw: BigInt(m.walletOutputRaw),
      inputDecimals,
      outputDecimals,
      hops: connected.map((h) => ({ poolId: `${h.venue}:${h.address}`, inCurrency: assetAddress(h.inToken!), outCurrency: assetAddress(h.outToken!), inRaw: h.inRaw!, outRaw: h.outRaw! })),
      intermediary: !nativeLeg && nativeThrough > ZERO ? { currency: RH_NATIVE, kind: 'native', raw: nativeThrough, decimals: 18 } : null,
    },
  }
}

async function verifyCandidate(ctx: Ctx, wallet: string, txHash: string): Promise<CandidateOutcome> {
  const out = (o: Partial<CandidateOutcome>): CandidateOutcome => ({ txHash, receiptFetched: false, v4SwapLogs: 0, swap: null, rejection: null, detail: null, ...o })
  if (Date.now() >= ctx.deadlineAt) return out({ rejection: 'deadline_exceeded' })
  const receipt = await remember(receiptCache, txHash, async () => {
    ctx.m.receiptCalls += 1
    const [raw] = await call(ctx, [{ method: 'eth_getTransactionReceipt', params: [txHash] }])
    return parseReceipt(raw)
  }, () => { ctx.m.cacheHits += 1 }, (v) => v != null)
  if (!receipt) return out({ rejection: 'receipt_unavailable' })
  const v4SwapLogs = receipt.logs.filter((l) => l.topics[0] === V4_SWAP_TOPIC0).length
  const pre = robinhoodReceiptPreflight(wallet, receipt)
  if (!pre.ok) {
    // FORENSICS ONLY (acceptance unchanged): for a rejected receipt that still carries canonical V4 swaps,
    // gather the same evidence the route proof would use so it can be classified A/B/C/D in the log.
    const ev = await forensicsForRejectedReceipt(ctx, wallet, txHash, receipt, pre.reason).catch(() => null)
    const base = { receiptFetched: true, v4SwapLogs, forensics: ev?.forensics ?? null, mixedRoute: ev?.mixedRoute ?? null }
    // MIXED-ROUTE ACCEPTANCE: only a wallet-sent V4 + V2/V3 receipt that the mixed-route proof classifies
    // direct_mixed_route_proven is promoted; every other mixed receipt keeps its other_venue rejection.
    if (pre.reason === 'other_venue_swap_in_tx' && ev?.mixedRoute) {
      const promoted = await promoteMixedRoute(ctx, txHash, receipt, ev.mixedRoute)
      if (promoted.swap) return out({ ...base, swap: promoted.swap, acceptedVia: 'mixed_route' })
      return out({ ...base, rejection: pre.reason, detail: pre.detail, mixedRejection: promoted.reason })
    }
    return out({ ...base, rejection: pre.reason, detail: pre.detail })
  }

  const poolKeys = new Map<string, RhPoolKey>()
  for (const id of pre.poolIds) {
    const key = await resolveRobinhoodPoolKey(id, ctx.rpc, (n) => { ctx.m.rpcCalls += n }, () => { ctx.m.cacheHits += 1 })
    if (key) poolKeys.set(id, { currency0: lower(key.currency0), currency1: lower(key.currency1) })
  }
  const nativeTouched = [...poolKeys.values()].some((k) => k.currency0 === RH_NATIVE || k.currency1 === RH_NATIVE)
  const needBlock = receipt.logs.every((l) => l.blockTimestamp == null)
  const N = receipt.blockNumber
  const hex = (n: number) => `0x${n.toString(16)}`
  const batch: RhRpcCall[] = []
  if (needBlock) batch.push({ method: 'eth_getBlockByNumber', params: [hex(N), false] })
  if (nativeTouched && N > 0) {
    batch.push(
      { method: 'eth_getBalance', params: [wallet, hex(N - 1)] },
      { method: 'eth_getBalance', params: [wallet, hex(N)] },
      { method: 'eth_getTransactionCount', params: [wallet, hex(N - 1)] },
      { method: 'eth_getTransactionCount', params: [wallet, hex(N)] },
      { method: 'eth_getTransactionByHash', params: [txHash] },
    )
  }
  const res = batch.length > 0 ? await call(ctx, batch) : []
  let i = 0
  let timestampSec = receipt.logs.find((l) => l.blockTimestamp != null)?.blockTimestamp ?? null
  if (needBlock) timestampSec = hexToNum((res[i++] as Record<string, unknown> | null)?.timestamp)
  // NATIVE ENDPOINT PROOF (accepted lane): the wallet's native net for THIS tx comes only from the target tx's
  // own execution trace (internal native transfers to / from the wallet) plus its known top-level tx.value.
  // The whole-block balance delta (after − before + gas) is kept as a diagnostic bound only: a nonce delta of
  // one proves the wallet sent one tx in the block, not that no other tx in the block paid it ETH.
  let nativeNet: bigint | null = null
  let nativeEvidence: RhNativeEvidence | null = null
  if (nativeTouched && N > 0) {
    const trace = await fetchNativeTrace(ctx, wallet, txHash)
    nativeEvidence = deriveRhNativeEvidence({
      wallet, isSender: receipt.from === lower(wallet), gasPaid: receipt.gasUsed * receipt.effectiveGasPrice,
      txValue: hexToBigInt((res[i + 4] as Record<string, unknown> | null)?.value),
      balanceBefore: hexToBigInt(res[i]), balanceAfter: hexToBigInt(res[i + 1]), nonceBefore: hexToNum(res[i + 2]), nonceAfter: hexToNum(res[i + 3]),
      trace,
    })
    if (nativeEvidence.status === 'proven_target_tx_native_transfer') nativeNet = nativeEvidence.nativeNetExGas
  }
  const route = verifyRobinhoodV4Route({ wallet, txHash, receipt, poolKeys, nativeNet })
  if (!route.ok && route.reason === 'native_flow_unprovable' && nativeEvidence) {
    route.detail = `${route.detail} (native evidence: ${nativeEvidence.status}; block delta ex-gas ${nativeEvidence.blockBalanceDeltaExGas ?? 'n/a'} is diagnostic only)`
  }
  const forensics = buildRobinhoodSwapForensics({ wallet, txHash, timestampSec, receipt, poolManager: POOL_MANAGER, poolKeys, walletNativeDelta: nativeNet, rejectionReason: route.ok ? null : route.reason })
  if (!route.ok) return out({ receiptFetched: true, v4SwapLogs, rejection: route.reason, detail: route.detail, forensics })
  if (timestampSec == null || timestampSec <= 0) return out({ receiptFetched: true, v4SwapLogs, rejection: 'timestamp_unavailable', forensics })
  const [inputDecimals, outputDecimals, interDecimals] = await Promise.all([
    tokenDecimals(ctx, route.inputToken),
    tokenDecimals(ctx, route.outputToken),
    route.intermediary ? tokenDecimals(ctx, route.intermediary.currency) : Promise.resolve(0),
  ])
  if (inputDecimals == null || outputDecimals == null || interDecimals == null) return out({ receiptFetched: true, v4SwapLogs, rejection: 'decimals_unavailable', forensics })
  return out({
    forensics,
    acceptedVia: 'direct_v4',
    receiptFetched: true,
    v4SwapLogs,
    swap: {
      txHash, blockNumber: N, firstLogIndex: route.firstLogIndex, timestampSec,
      inputToken: route.inputToken, outputToken: route.outputToken, inputRaw: route.inputRaw, outputRaw: route.outputRaw,
      inputDecimals, outputDecimals, hops: route.hops,
      intermediary: route.intermediary ? { ...route.intermediary, decimals: interDecimals } : null,
    },
  })
}

// ── Historical both-leg pricing ─────────────────────────────────────────────────────────────────────
// Hierarchy per leg: (1) verified stablecoin by exact address = $1; (2) native ETH / canonical WETH =
// historical ETH/USD at the swap; (3) trusted historical provider by exact token + timestamp; (4) the
// tx's own exact V4 execution against a leg priced by (1)/(2) — the other leg of a direct quote swap, or
// both legs of a route through a canonical intermediary. No symbol, no current price, no market cap.
// A quote-anchored swap's token leg takes the exact execution value (one tx-side value, as on Base),
// so the provider is only consulted for token↔token swaps with no canonical anchor on the route.

// ETH pricing has its own small time budget: by the time pricing runs, receipt / trace work may have used the
// lane's overall deadline, and a skipped provider call must never be the reason a proven swap is unpriced.
const ETH_PRICING_BUDGET_MS = 6_000
const ETH_RESOLVER_MAX_GAP_MS = 86_400_000 // the shared resolver answers with the swap's own UTC-day bucket

type EthHistoryAudit = {
  requestedTimestampSec: number
  requestedFromSec: number | null
  requestedToSec: number | null
  provider: string | null
  endpoint: string | null
  httpStatus: number | null
  pointsReturned: number | null
  earliestPointMs: number | null
  latestPointMs: number | null
  nearestPointMs: number | null
  nearestGapMs: number | null
  maxAllowedGapMs: number | null
  priceUsd: number | null
  persistentCacheHit: boolean
  rejectionReason: string | null
}

/**
 * Historical ETH/USD per swap timestamp (seconds). Primary: the shared ChainLens historical-native resolver
 * (ethUsdAt). Fallback: the hourly CoinGecko range series, nearest point within ROBINHOOD_ETH_USD_MAX_GAP_MS.
 * Never a current price. Every timestamp logs one [robinhood-eth-history-audit] line, priced or not.
 */
async function resolveEthUsdForTimestamps(ctx: Ctx, timestampsSec: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const pricingDeadline = Math.max(ctx.deadlineAt, Date.now() + ETH_PRICING_BUDGET_MS)
  const sorted = [...new Set(timestampsSec)].sort((a, b) => a - b)
  const audits = new Map<number, EthHistoryAudit>(sorted.map((t) => [t, {
    requestedTimestampSec: t, requestedFromSec: null, requestedToSec: null, provider: null, endpoint: null, httpStatus: null, pointsReturned: null,
    earliestPointMs: null, latestPointMs: null, nearestPointMs: null, nearestGapMs: null, maxAllowedGapMs: null, priceUsd: null, persistentCacheHit: false, rejectionReason: null,
  }]))
  const budgetLeft = () => ctx.priceSidesUsed < ROBINHOOD_PNL_V1_LIMITS.maxHistoricalPriceSides
  // 1) Shared verified resolver: one call per distinct UTC day (its own bucket), cached by the resolver.
  if (ctx.deps.ethUsdAt) {
    const byDay = new Map<number, RhEthUsdPoint | null>()
    for (const t of sorted) {
      const a = audits.get(t)!
      const day = Math.floor((t * 1000) / ETH_RESOLVER_MAX_GAP_MS)
      if (!byDay.has(day)) {
        if (Date.now() >= pricingDeadline) { a.rejectionReason = 'not_attempted_pricing_deadline'; continue }
        if (!budgetLeft()) { a.rejectionReason = 'not_attempted_side_budget_exhausted'; continue }
        ctx.priceSidesUsed += 1
        ctx.m.historicalPriceCalls += 1
        byDay.set(day, await ctx.deps.ethUsdAt(t).catch(() => null))
      }
      const hit = byDay.get(day) ?? null
      a.provider = hit?.provider ?? 'chainlens_native_price_resolver'
      a.endpoint = hit?.endpoint ?? null
      a.persistentCacheHit = hit?.persistentCacheHit === true
      if (hit && Number.isFinite(hit.priceUsd) && hit.priceUsd > 0 && hit.gapMs <= hit.maxAllowedGapMs) {
        Object.assign(a, { nearestPointMs: hit.pointMs, nearestGapMs: hit.gapMs, maxAllowedGapMs: hit.maxAllowedGapMs, pointsReturned: 1, earliestPointMs: hit.pointMs, latestPointMs: hit.pointMs, priceUsd: hit.priceUsd, rejectionReason: null })
        out.set(t, hit.priceUsd)
      } else {
        a.rejectionReason = hit ? 'resolver_point_outside_day' : 'resolver_no_verified_price'
      }
    }
  }
  // 2) Fallback: hourly range series for the timestamps the resolver could not answer.
  const missing = sorted.filter((t) => !out.has(t))
  const windows: Array<[number, number]> = []
  for (const t of missing) {
    const last = windows[windows.length - 1]
    if (last && t - last[0] <= ETH_SERIES_MAX_WINDOW_SEC) last[1] = t
    else windows.push([t, t])
  }
  for (const [from, to] of windows) {
    const members = missing.filter((t) => t >= from && t <= to)
    const fromSec = from - 3_600
    const toSec = to + 3_600
    if (Date.now() >= pricingDeadline || !budgetLeft()) {
      for (const t of members) audits.get(t)!.rejectionReason ??= Date.now() >= pricingDeadline ? 'not_attempted_pricing_deadline' : 'not_attempted_side_budget_exhausted'
      continue
    }
    ctx.priceSidesUsed += 1
    ctx.m.historicalPriceCalls += 1
    const raw = await ctx.deps.ethUsdRange(fromSec, toSec).catch(() => ({ points: null, httpStatus: null, failure: 'provider_threw' as string | null }))
    const res = Array.isArray(raw) || raw == null ? { points: raw, httpStatus: null as number | null, failure: raw == null ? 'provider_failed_or_empty' : null as string | null } : { points: raw.points, httpStatus: raw.httpStatus ?? null, failure: raw.failure ?? null }
    const series = [...(res.points ?? [])].filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0).sort((x, y) => x[0] - y[0])
    for (const t of members) {
      const a = audits.get(t)!
      const prior = a.rejectionReason
      Object.assign(a, {
        requestedFromSec: fromSec, requestedToSec: toSec, provider: 'coingecko_market_chart_range',
        endpoint: '/coins/ethereum/market_chart/range', httpStatus: res.httpStatus, pointsReturned: series.length,
        earliestPointMs: series[0]?.[0] ?? null, latestPointMs: series[series.length - 1]?.[0] ?? null, maxAllowedGapMs: ROBINHOOD_ETH_USD_MAX_GAP_MS,
      })
      if (series.length === 0) { a.rejectionReason = `${prior ? `${prior}; ` : ''}range_${res.failure ?? 'empty'}`; continue }
      const nearest = nearestPriceWithGap(series, t * 1000, Number.POSITIVE_INFINITY)
      a.nearestPointMs = nearest ? series.find((p) => p[1] === nearest.price && Math.abs(p[0] - t * 1000) === nearest.gapMs)?.[0] ?? null : null
      a.nearestGapMs = nearest?.gapMs ?? null
      const within = nearestPriceWithGap(series, t * 1000, ROBINHOOD_ETH_USD_MAX_GAP_MS)
      if (within) { out.set(t, within.price); a.priceUsd = within.price; a.rejectionReason = null }
      else {
        const covered = series[0][0] <= t * 1000 && t * 1000 <= series[series.length - 1][0]
        a.rejectionReason = `${prior ? `${prior}; ` : ''}${covered ? 'range_nearest_point_outside_gap' : 'range_timestamp_not_covered'}`
      }
    }
  }
  for (const a of audits.values()) console.warn('[robinhood-eth-history-audit]', a)
  return out
}

async function providerPrice(ctx: Ctx, token: string, timestampSec: number): Promise<RhHistoricalTokenPrice | null> {
  const key = `${token}:${timestampSec}`
  if (!tokenPriceCache.has(key)) {
    if (ctx.priceSidesUsed >= ROBINHOOD_PNL_V1_LIMITS.maxHistoricalPriceSides || Date.now() >= ctx.deadlineAt) return null
    ctx.priceSidesUsed += 1
    ctx.m.historicalPriceCalls += 1
  }
  return remember(tokenPriceCache, key, async () => {
    const p = await ctx.deps.tokenHistoricalUsd(token, timestampSec).catch(() => null)
    return p && Number.isFinite(p.priceUsd) && p.priceUsd > 0 ? p : null
  }, () => { ctx.m.cacheHits += 1 }, (v) => v != null)
}

function swapNeedsNativeEthPrice(s: RhVerifiedSwap): boolean {
  return quoteKind(s.inputToken) === 'native' || quoteKind(s.outputToken) === 'native' || s.intermediary?.kind === 'native'
}

export async function priceRobinhoodSwaps(ctx: Ctx, swaps: readonly RhVerifiedSwap[]): Promise<RhPriceEvidence[]> {
  const needsEth = swaps.filter(swapNeedsNativeEthPrice)
  const ethAt = needsEth.length > 0 ? await resolveEthUsdForTimestamps(ctx, needsEth.map((s) => s.timestampSec)) : new Map<number, number>()
  const quoteUsd = (currency: string, raw: bigint, decimals: number, ts: number): { usd: number; source: string } | null => {
    const kind = quoteKind(currency)
    const qty = toUnits(raw, decimals)
    if (kind === 'stable') return { usd: qty, source: 'verified_stablecoin_exact_address' }
    if (kind === 'native') {
      const price = ethAt.get(ts)
      return price != null ? { usd: qty * price, source: currency === RH_WETH ? 'weth_historical_eth_usd' : 'native_historical_eth_usd' } : null
    }
    return null
  }
  const out: RhPriceEvidence[] = []
  for (const s of swaps) {
    const inputAmount = toUnits(s.inputRaw, s.inputDecimals)
    const outputAmount = toUnits(s.outputRaw, s.outputDecimals)
    let inUsd: number | null = null
    let outUsd: number | null = null
    let inSrc: string | null = null
    let outSrc: string | null = null
    let reason: string | null = null
    const qIn = quoteKind(s.inputToken) ? quoteUsd(s.inputToken, s.inputRaw, s.inputDecimals, s.timestampSec) : null
    const qOut = quoteKind(s.outputToken) ? quoteUsd(s.outputToken, s.outputRaw, s.outputDecimals, s.timestampSec) : null
    if (quoteKind(s.inputToken) || quoteKind(s.outputToken)) {
      if (qIn) { inUsd = qIn.usd; inSrc = qIn.source }
      if (qOut) { outUsd = qOut.usd; outSrc = qOut.source }
      if (qIn && !qOut) { outUsd = qIn.usd; outSrc = 'v4_exact_swap_execution' }
      if (qOut && !qIn) { inUsd = qOut.usd; inSrc = 'v4_exact_swap_execution' }
      if (!qIn && !qOut) reason = 'historical ETH/USD unavailable at the swap timestamp'
    } else if (s.intermediary) {
      const q = quoteUsd(s.intermediary.currency, s.intermediary.raw, s.intermediary.decimals, s.timestampSec)
      if (q) { inUsd = q.usd; outUsd = q.usd; inSrc = outSrc = `v4_exact_route_quote_via_${q.source}` }
      else reason = 'route passes through ETH, but historical ETH/USD is unavailable at the swap timestamp'
    } else {
      const [pIn, pOut] = [await providerPrice(ctx, s.inputToken, s.timestampSec), await providerPrice(ctx, s.outputToken, s.timestampSec)]
      if (pIn) { inUsd = inputAmount * pIn.priceUsd; inSrc = pIn.source }
      if (pOut) { outUsd = outputAmount * pOut.priceUsd; outSrc = pOut.source }
      if (!pIn || !pOut) reason = !pIn && !pOut ? 'no trusted historical price for either leg' : `no trusted historical price for the ${pIn ? 'output' : 'input'} leg`
    }
    const bothLegsVerified = inUsd != null && outUsd != null && Number.isFinite(inUsd) && Number.isFinite(outUsd) && inUsd > 0 && outUsd > 0
    out.push({
      swapTxHash: s.txHash, inputToken: s.inputToken, outputToken: s.outputToken, inputAmount, outputAmount,
      inputPriceUsd: inUsd != null && inputAmount > 0 ? inUsd / inputAmount : null,
      outputPriceUsd: outUsd != null && outputAmount > 0 ? outUsd / outputAmount : null,
      inputSource: inSrc, outputSource: outSrc, bothLegsVerified,
      rejectionReason: bothLegsVerified ? null : (reason ?? 'one or both legs unpriced'),
    })
  }
  return out
}

export const MAX_ROBINHOOD_NATIVE_PREFETCH_BUCKETS = 3

// Reuses the exact native-leg predicate used by priceRobinhoodSwaps. This chooses only structurally
// verified swaps; timestamps from activity rows or rejected candidate receipts never qualify.
export function selectRobinhoodNativePriceDays(swaps: readonly RhVerifiedSwap[], nowMs = Date.now()): {
  requestedBuckets: number[]; selectedTimestampsSec: number[]; skippedByCap: number
} {
  const byBucket = new Map<number, number>()
  for (const swap of swaps) {
    if (!swapNeedsNativeEthPrice(swap)) continue
    if (!Number.isSafeInteger(swap.timestampSec) || swap.timestampSec <= 0) continue
    const bucket = Math.floor((swap.timestampSec * 1000) / ETH_RESOLVER_MAX_GAP_MS) * ETH_RESOLVER_MAX_GAP_MS
    if (bucket + ETH_RESOLVER_MAX_GAP_MS > nowMs) continue // no open/current UTC day reservation
    if (!byBucket.has(bucket)) byBucket.set(bucket, swap.timestampSec)
  }
  const requestedBuckets = [...byBucket.keys()]
  return {
    requestedBuckets,
    selectedTimestampsSec: requestedBuckets.slice(0, MAX_ROBINHOOD_NATIVE_PREFETCH_BUCKETS).map((bucket) => byBucket.get(bucket)!),
    skippedByCap: Math.max(0, requestedBuckets.length - MAX_ROBINHOOD_NATIVE_PREFETCH_BUCKETS),
  }
}

// ── FIFO (Robinhood-only identities) ────────────────────────────────────────────────────────────────
export function buildRobinhoodPnlV1Fifo(wallet: string, swaps: readonly RhVerifiedSwap[], evidence: readonly RhPriceEvidence[]) {
  const byTx = new Map(evidence.map((e) => [e.swapTxHash, e]))
  const ordered = [...swaps].sort((a, b) => a.timestampSec - b.timestampSec || a.blockNumber - b.blockNumber || a.firstLogIndex - b.firstLogIndex || a.txHash.localeCompare(b.txHash))
  const events: NormalizedEvent[] = []
  const usdByEvent = new Map<string, number>()
  for (const s of ordered) {
    const e = byTx.get(s.txHash)
    const ts = new Date(s.timestampSec * 1000).toISOString()
    // Quote legs (ETH/WETH/stable) are the price, not a position: only token legs open or close lots.
    if (!quoteKind(s.inputToken)) {
      events.push({ provider: 'alchemy', chain: ROBINHOOD_FIFO_CHAIN, txHash: s.txHash, timestamp: ts, fromAddress: wallet, toAddress: ROBINHOOD_V4_POOL_MANAGER, contract: s.inputToken, symbol: s.inputToken, amount: toUnits(s.inputRaw, s.inputDecimals), amountRaw: s.inputRaw.toString(), tokenDecimals: s.inputDecimals, direction: 'outbound' })
      if (e?.bothLegsVerified && e.inputPriceUsd != null) usdByEvent.set(`${s.txHash}:${s.inputToken}:outbound`, e.inputPriceUsd * e.inputAmount)
    }
    if (!quoteKind(s.outputToken)) {
      events.push({ provider: 'alchemy', chain: ROBINHOOD_FIFO_CHAIN, txHash: s.txHash, timestamp: ts, fromAddress: ROBINHOOD_V4_POOL_MANAGER, toAddress: wallet, contract: s.outputToken, symbol: s.outputToken, amount: toUnits(s.outputRaw, s.outputDecimals), amountRaw: s.outputRaw.toString(), tokenDecimals: s.outputDecimals, direction: 'inbound' })
      if (e?.bothLegsVerified && e.outputPriceUsd != null) usdByEvent.set(`${s.txHash}:${s.outputToken}:inbound`, e.outputPriceUsd * e.outputAmount)
    }
  }
  const fifo = buildFifoOutput({
    normalizedEvents: events,
    recoveredRawEvents: [],
    walletAddress: wallet,
    priceUsdLookup: (ev) => usdByEvent.get(`${ev.txHash}:${ev.contract}:${ev.direction}`) ?? null,
    currentPriceUsdLookup: () => null,
  })
  return { fifo, buyCount: events.filter((e) => e.direction === 'inbound').length, sellCount: events.filter((e) => e.direction === 'outbound').length }
}

// ── Acquisition recovery (verified sell left unmatched by FIFO) ─────────────────────────────────────
type RecoveryRow = {
  candidateTxHash: string
  candidateTimestamp: number | null
  inboundRaw: string | null
  classification: RhAcquisitionClass
  walletFundingToken: string | null
  walletFundingRaw: string | null
  routeProven: boolean
  ownershipProven: boolean
  rejectionReason: string | null
  txValueEvidence: 'tx_value_zero_proven' | 'tx_value_nonzero' | 'tx_value_unavailable' | null
  swap: RhVerifiedSwap | null
}

/** The target transaction's native value must be an authoritative, parseable RPC quantity. */
function recoveryTxValue(raw: unknown): bigint | null {
  const value = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw as Record<string, unknown>).value : null
  return typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) ? BigInt(value) : null
}

/** Recovery has its own five-second ceiling and cannot move the parent scan deadline. */
export function robinhoodAcquisitionRecoveryDeadline(parentDeadlineAt: number, now: number): number {
  return Math.min(parentDeadlineAt, now + ROBINHOOD_ACQUISITION_RECOVERY_LIMITS.budgetMs)
}

/** A slow recovery dependency cannot hold the sidecar past this lane's absolute deadline. */
async function withinRecoveryDeadline<T>(deadlineAt: number, work: () => Promise<T>): Promise<T | null> {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work().catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function loadReceipt(ctx: Ctx, txHash: string): Promise<RhReceipt | null> {
  return remember(receiptCache, txHash, async () => {
    ctx.m.receiptCalls += 1
    const [raw] = await call(ctx, [{ method: 'eth_getTransactionReceipt', params: [txHash] }])
    return parseReceipt(raw)
  }, () => { ctx.m.cacheHits += 1 }, (v) => v != null)
}

const receiptTimestamp = (r: RhReceipt) => r.logs.find((l) => l.blockTimestamp != null)?.blockTimestamp ?? null
const walletReceivesToken = (r: RhReceipt, wallet: string, token: string) =>
  r.logs.some((l) => l.address === token && l.topics[0] === ERC20_TRANSFER_TOPIC0 && l.topics.length === 3 && lower(`0x${l.topics[2].slice(-40)}`) === wallet)

/**
 * Earlier inbound movements of the sold token (activity rows + receipts this scan already read), newest first,
 * classified one by one until the unmatched quantity is covered or the per-sell cap is reached. Wallet-sent
 * txs go through the existing direct-V4 / mixed-route verification unchanged; relayed txs need the full
 * wallet-funded route proof. Receiving a token alone is never a buy.
 */
async function recoverAcquisitionsForSell(
  ctx: Ctx,
  recoveryDeadlineAt: number,
  wallet: string,
  sell: { txHash: string; token: string; timestampSec: number; unmatchedRaw: bigint },
  inbound: readonly RhInboundTokenTransfer[],
  outcomes: readonly CandidateOutcome[],
  options: { historicalOnly?: boolean; excludedHashes?: ReadonlySet<string>; maxCandidates?: number } = {},
): Promise<{ found: number; rows: RecoveryRow[] }> {
  const token = sell.token
  const verified = new Set(outcomes.filter((o) => o.swap).map((o) => o.txHash))
  const pool = new Map<string, { ts: number | null; rows: bigint[] }>()
  for (const r of inbound) {
    const h = lower(r.txHash)
    if (lower(r.token) !== token || h === sell.txHash || verified.has(h) || options.excludedHashes?.has(h) || !/^0x[0-9a-f]{64}$/.test(h)) continue
    const e = pool.get(h) ?? { ts: null, rows: [] }
    if (r.timestampMs != null && Number.isFinite(r.timestampMs)) e.ts = Math.floor(r.timestampMs / 1000)
    if (r.rawAmount != null && /^\d+$/.test(r.rawAmount)) e.rows.push(BigInt(r.rawAmount))
    pool.set(h, e)
  }
  for (const o of options.historicalOnly ? [] : outcomes) {
    if (!o.receiptFetched || o.swap || o.txHash === sell.txHash) continue
    const rc = await receiptCache.get(o.txHash)?.catch(() => null)
    if (rc && walletReceivesToken(rc, wallet, token) && !pool.has(o.txHash)) pool.set(o.txHash, { ts: null, rows: [] })
  }
  // A receipt already read is the authoritative timestamp.
  const listed: Array<{ txHash: string; ts: number; rows: bigint[] }> = []
  for (const [h, e] of pool) {
    const cached = receiptCache.has(h) ? await receiptCache.get(h)!.catch(() => null) : null
    const ts = (cached ? receiptTimestamp(cached) : null) ?? e.ts
    if (ts != null && ts < sell.timestampSec) listed.push({ txHash: h, ts, rows: e.rows })
  }
  listed.sort((a, b) => b.ts - a.ts || a.txHash.localeCompare(b.txHash))
  const rows: RecoveryRow[] = []
  let covered = ZERO
  for (const c of listed.slice(0, options.maxCandidates ?? ROBINHOOD_ACQUISITION_RECOVERY_LIMITS.maxCandidatesPerSell)) {
    if (covered >= sell.unmatchedRaw) break
    const row: RecoveryRow = {
      candidateTxHash: c.txHash, candidateTimestamp: c.ts, inboundRaw: c.rows.length === 1 ? c.rows[0].toString() : null, classification: 'ambiguous',
      walletFundingToken: null, walletFundingRaw: null, routeProven: false, ownershipProven: false, rejectionReason: null, txValueEvidence: null, swap: null,
    }
    rows.push(row)
    if (Date.now() >= recoveryDeadlineAt) { row.rejectionReason = 'not_attempted_recovery_deadline'; continue }
    const receipt = await withinRecoveryDeadline(recoveryDeadlineAt, () => loadReceipt(ctx, c.txHash))
    if (Date.now() >= recoveryDeadlineAt) { row.rejectionReason = 'not_attempted_recovery_deadline'; continue }
    if (!receipt) { row.rejectionReason = 'receipt_unavailable'; continue }
    const ts = receiptTimestamp(receipt) ?? c.ts
    row.candidateTimestamp = ts
    if (ts >= sell.timestampSec) { row.rejectionReason = 'not_before_sell'; continue }
    const poolKeys = new Map<string, RhPoolKey>()
    for (const id of new Set(receipt.logs.filter((l) => l.topics[0] === V4_SWAP_TOPIC0 && l.address === POOL_MANAGER && /^0x[0-9a-f]{64}$/.test(l.topics[1] ?? '')).map((l) => l.topics[1]))) {
      const key = await withinRecoveryDeadline(recoveryDeadlineAt, () => resolveRobinhoodPoolKey(id, ctx.rpc, (n) => { ctx.m.rpcCalls += n }, () => { ctx.m.cacheHits += 1 }))
      if (key) poolKeys.set(id, { currency0: lower(key.currency0), currency1: lower(key.currency1) })
    }
    if (Date.now() >= recoveryDeadlineAt) { row.rejectionReason = 'not_attempted_recovery_deadline'; continue }
    const isSender = receipt.from === wallet
    const hasSwap = receipt.logs.some((l) => l.topics[0] === V2_SWAP_TOPIC0 || l.topics[0] === V3_SWAP_TOPIC0 || l.topics[0] === V4_SWAP_TOPIC0)
    const txr = !isSender && hasSwap
      ? (await withinRecoveryDeadline(recoveryDeadlineAt, () => call(ctx, [{ method: 'eth_getTransactionByHash', params: [c.txHash] }])))?.[0] ?? null
      : null
    if (Date.now() >= recoveryDeadlineAt) { row.rejectionReason = 'not_attempted_recovery_deadline'; continue }
    const txValue = !isSender && hasSwap ? recoveryTxValue(txr) : null
    if (!isSender && hasSwap) row.txValueEvidence = txValue == null ? 'tx_value_unavailable' : txValue === ZERO ? 'tx_value_zero_proven' : 'tx_value_nonzero'
    const proof = classifyRobinhoodAcquisition({
      wallet, txHash: c.txHash, receipt, targetToken: token, inboundRaw: c.rows.length === 1 ? c.rows[0] : null,
      poolManager: POOL_MANAGER, v4PoolKeys: poolKeys, txValue,
    })
    Object.assign(row, { classification: proof.classification, walletFundingToken: proof.walletFundingToken, walletFundingRaw: proof.walletFundingRaw, rejectionReason: proof.rejectionReason, inboundRaw: proof.walletCreditRaw ?? row.inboundRaw })
    if (isSender) {
      // The wallet's own tx: only the existing direct-V4 / mixed-route lanes may call it a swap.
      const o = outcomes.find((x) => x.txHash === c.txHash)
        ?? await withinRecoveryDeadline(recoveryDeadlineAt, () => verifyCandidate(ctx, wallet, c.txHash))
      if (!o || Date.now() >= recoveryDeadlineAt) { row.rejectionReason = 'not_attempted_recovery_deadline'; continue }
      if (o.swap && o.swap.outputToken === token) {
        Object.assign(row, { classification: 'verified_buy', walletFundingToken: o.swap.inputToken, walletFundingRaw: o.swap.inputRaw.toString(), inboundRaw: o.swap.outputRaw.toString(), routeProven: true, ownershipProven: true, rejectionReason: null, swap: o.swap })
        covered += o.swap.outputRaw
      } else if (proof.classification === 'verified_buy' || proof.classification === 'ambiguous') {
        Object.assign(row, { classification: 'ambiguous', rejectionReason: `existing verification rejected the wallet's own tx: ${o.mixedRejection ?? o.rejection ?? 'no swap of the sold token'}` })
      }
      continue
    }
    if (proof.classification !== 'verified_buy') continue
    const inputToken = proof.walletFundingToken!
    const decimals = await withinRecoveryDeadline(recoveryDeadlineAt, () => Promise.all([tokenDecimals(ctx, inputToken), tokenDecimals(ctx, token)]))
    if (!decimals || Date.now() >= recoveryDeadlineAt) { Object.assign(row, { classification: 'ambiguous', rejectionReason: 'not_attempted_recovery_deadline' }); continue }
    const [inputDecimals, outputDecimals] = decimals
    if (inputDecimals == null || outputDecimals == null) { Object.assign(row, { classification: 'ambiguous', rejectionReason: 'decimals_unavailable' }); continue }
    const nativeThrough = proof.nativeThroughRaw ? BigInt(proof.nativeThroughRaw) : ZERO
    row.routeProven = proof.routeProven
    row.ownershipProven = proof.ownershipProven
    row.swap = {
      txHash: c.txHash, blockNumber: receipt.blockNumber, firstLogIndex: proof.firstLogIndex ?? 0, timestampSec: ts,
      inputToken, outputToken: token, inputRaw: BigInt(proof.walletFundingRaw!), outputRaw: BigInt(proof.walletCreditRaw!), inputDecimals, outputDecimals,
      hops: proof.hops.map((h) => ({ poolId: `${h.venue}:${h.address}`, inCurrency: assetAddress(h.inToken!), outCurrency: assetAddress(h.outToken!), inRaw: h.inRaw!, outRaw: h.outRaw! })),
      intermediary: !quoteKind(inputToken) && nativeThrough > ZERO ? { currency: RH_NATIVE, kind: 'native', raw: nativeThrough, decimals: 18 } : null,
    }
    covered += row.swap.outputRaw
  }
  return { found: listed.length, rows }
}

const emptyRecoverySummary = (): RhAcquisitionRecoverySummary => ({
  acquisitionRecoveryAttempted: false, sellTxHash: null, token: null, candidatesFound: 0, candidatesAttempted: 0, recoveredBuyCount: 0,
  candidateTxHashes: [], recoveredBuyRaw: '0', unmatchedSellRawBefore: null, unmatchedSellRawAfter: null, closedLotsAdded: 0, classifications: {},
})

/** Runs the recovery lane for the most recent verified sell the FIFO left unmatched; logs one audit line per candidate. */
async function runAcquisitionRecovery(
  ctx: Ctx, wallet: string, swaps: readonly RhVerifiedSwap[], unmatchedSells: number,
  outcomes: readonly CandidateOutcome[], inbound: readonly RhInboundTokenTransfer[],
): Promise<{ summary: RhAcquisitionRecoverySummary; swaps: RhVerifiedSwap[]; evidence: RhPriceEvidence[] }> {
  const summary = emptyRecoverySummary()
  if (unmatchedSells === 0) return { summary, swaps: [], evidence: [] }
  const isQuote = (t: string) => quoteKind(t) != null
  const lanes = [...robinhoodUnmatchedSellRaw(swaps, isQuote)].filter(([, v]) => v.unmatchedRaw > ZERO)
    .map(([txHash, v]) => ({ txHash, ...v }))
    .sort((a, b) => b.timestampSec - a.timestampSec || a.txHash.localeCompare(b.txHash))
    .slice(0, ROBINHOOD_ACQUISITION_RECOVERY_LIMITS.maxSellLanes)
  if (lanes.length === 0) return { summary, swaps: [], evidence: [] }
  const sell = lanes[0]
  const recoveryDeadlineAt = robinhoodAcquisitionRecoveryDeadline(ctx.deadlineAt, Date.now())
  const { found, rows } = await recoverAcquisitionsForSell(ctx, recoveryDeadlineAt, wallet, sell, inbound, outcomes)
  const recovered = rows.map((r) => r.swap).filter((x): x is RhVerifiedSwap => x != null)
  const evidence = recovered.length > 0
    ? await withinRecoveryDeadline(recoveryDeadlineAt, () => priceRobinhoodSwaps(ctx, recovered)) ?? []
    : []
  const after = robinhoodUnmatchedSellRaw([...swaps, ...recovered], isQuote).get(sell.txHash)?.unmatchedRaw ?? sell.unmatchedRaw
  const attempted = rows.filter((r) => r.rejectionReason !== 'not_attempted_recovery_deadline').length
  Object.assign(summary, {
    acquisitionRecoveryAttempted: true, sellTxHash: sell.txHash, token: sell.token, candidatesFound: found, candidatesAttempted: attempted,
    candidateTxHashes: [...new Set(rows.map((row) => lower(row.candidateTxHash)).filter((hash) => /^0x[0-9a-f]{64}$/.test(hash)))].sort(),
    recoveredBuyCount: recovered.length, recoveredBuyRaw: recovered.reduce((t, x) => t + x.outputRaw, ZERO).toString(),
    unmatchedSellRawBefore: sell.unmatchedRaw.toString(), unmatchedSellRawAfter: after.toString(),
  })
  for (const r of rows) summary.classifications[r.classification] = (summary.classifications[r.classification] ?? 0) + 1
  const head = { sellTxHash: sell.txHash, token: sell.token, sellRaw: sell.sellRaw.toString(), candidatesFound: found, candidatesAttempted: attempted }
  if (rows.length === 0) {
    console.warn('[robinhood-acquisition-recovery-audit]', {
      ...head, candidateTxHash: null, candidateTimestamp: null, inboundRaw: null, classification: null, walletFundingToken: null, walletFundingRaw: null,
      routeProven: false, ownershipProven: false, txValueEvidence: null, priceEvidenceStatus: null, fifoIncluded: false, rejectionReason: 'no_earlier_inbound_of_sold_token',
    })
  }
  for (const r of rows) {
    const e = r.swap ? evidence.find((x) => x.swapTxHash === r.candidateTxHash) : undefined
    console.warn('[robinhood-acquisition-recovery-audit]', {
      ...head,
      candidateTxHash: r.candidateTxHash, candidateTimestamp: r.candidateTimestamp, inboundRaw: r.inboundRaw, classification: r.classification,
      walletFundingToken: r.walletFundingToken, walletFundingRaw: r.walletFundingRaw, routeProven: r.routeProven, ownershipProven: r.ownershipProven, txValueEvidence: r.txValueEvidence,
      priceEvidenceStatus: !r.swap ? null : e?.bothLegsVerified ? 'both_legs_priced' : (e?.rejectionReason ?? 'not_priced'),
      fifoIncluded: r.swap != null,
      rejectionReason: r.rejectionReason,
    })
  }
  return { summary, swaps: recovered, evidence }
}

type RhKnownInboundAnchorDiagnostics = Pick<RhRpcAcquisitionHistoryAudit,
  'rawInboundAnchorHashes' | 'recoveryCandidateAnchorHashes' | 'unionAnchorHashes'
  | 'cachedReceiptAnchorsResolved' | 'cachedReceiptAnchorsMissing' | 'cachedReceiptAnchorsRejected'>

/** Current recovery and activity identify candidates; only already-fetched exact receipts supply block anchors. */
async function knownInboundReceiptAnchors(
  inbound: readonly RhInboundTokenTransfer[], token: string, wallet: string,
  recoveryCandidateHashes: readonly string[], sellTxHash: string, sellBlock: number, sellTimestampSec: number,
): Promise<{ expectedHashes: string[]; blockByHash: Map<string, number>; diagnostics: RhKnownInboundAnchorDiagnostics }> {
  const rawInboundAnchorHashes = [...new Set(inbound.filter((row) => lower(row.token) === token
    && lower(row.txHash) !== sellTxHash && /^0x[0-9a-f]{64}$/.test(lower(row.txHash))
    && (row.timestampMs == null || row.timestampMs < sellTimestampSec * 1000))
    .map((row) => lower(row.txHash)))].sort()
  const recoveryCandidateAnchorHashes = [...new Set(recoveryCandidateHashes.map(lower)
    .filter((hash) => hash !== sellTxHash && /^0x[0-9a-f]{64}$/.test(hash)))].sort()
  const expectedHashes = [...new Set([...rawInboundAnchorHashes, ...recoveryCandidateAnchorHashes])].sort()
  const blockByHash = new Map<string, number>()
  const diagnostics: RhKnownInboundAnchorDiagnostics = {
    rawInboundAnchorHashes, recoveryCandidateAnchorHashes, unionAnchorHashes: expectedHashes,
    cachedReceiptAnchorsResolved: [], cachedReceiptAnchorsMissing: [], cachedReceiptAnchorsRejected: [],
  }
  const cachedReceipts = await Promise.all(expectedHashes.map(async (hash) => {
    const cached = receiptCache.get(hash)
    return cached ? await cached.catch(() => null) : null
  }))
  expectedHashes.forEach((hash, index) => {
    const receipt = cachedReceipts[index]
    if (!receipt) { diagnostics.cachedReceiptAnchorsMissing.push({ txHash: hash, reason: 'missing_cached_receipt' }); return }
    if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber <= 0) {
      diagnostics.cachedReceiptAnchorsRejected.push({ txHash: hash, reason: 'invalid_block' }); return
    }
    if (receipt.blockNumber >= sellBlock) {
      diagnostics.cachedReceiptAnchorsRejected.push({ txHash: hash, reason: 'post_sell_block' }); return
    }
    if (!walletReceivesToken(receipt, wallet, token)) {
      diagnostics.cachedReceiptAnchorsRejected.push({ txHash: hash, reason: 'receipt_missing_wallet_token_credit' }); return
    }
    blockByHash.set(hash, receipt.blockNumber)
    diagnostics.cachedReceiptAnchorsResolved.push({ txHash: hash, blockNumber: receipt.blockNumber })
  })
  return { expectedHashes, blockByHash, diagnostics }
}

/** Exact RPC Transfer-log discovery. Logs index candidates; only the unchanged receipt classifier can prove buys. */
export async function discoverRobinhoodRpcAcquisitionHistory(input: {
  sellTxHash: string; sellBlock: number; token: string; wallet: string; deadlineAt: number
  rpcLogs: (query: RhRpcLogQuery, deadlineAt: number) => Promise<RhRpcLogResult>
  rpc: RhRpc; knownHashes: ReadonlySet<string>
  knownInboundHashesExpected?: readonly string[]; knownInboundBlocks?: ReadonlyMap<string, number>
  anchorDiagnostics?: RhKnownInboundAnchorDiagnostics
  onCandidates?: (rows: RhInboundTokenTransfer[]) => Promise<'sell_covered' | 'proof_cap' | false>
  onRpcCalls?: (count: number) => void
}): Promise<{ rows: RhInboundTokenTransfer[]; audit: RhRpcAcquisitionHistoryAudit }> {
  const { sellBlock, sellTxHash, rpcLogs, rpc, knownHashes, deadlineAt } = input
  const token = lower(input.token)
  const wallet = lower(input.wallet)
  const toBlock = sellBlock - 1
  const knownInboundHashesExpected = [...new Set(input.knownInboundHashesExpected?.map(lower) ?? [])]
    .filter((hash) => /^0x[0-9a-f]{64}$/.test(hash)).sort()
  const expectedSet = new Set(knownInboundHashesExpected)
  const validKnownBlocks = [...(input.knownInboundBlocks?.entries() ?? [])]
    .filter(([hash, block]) => expectedSet.has(lower(hash)) && Number.isSafeInteger(block) && block > 0 && block < sellBlock)
    .map(([, block]) => block)
  const earliestKnownInboundBlock = validKnownBlocks.length ? Math.min(...validKnownBlocks) : null
  const coverageTarget = earliestKnownInboundBlock == null ? 'fixed_fallback' : 'earliest_known_inbound_plus_margin'
  const desiredFromBlock = Math.max(1, earliestKnownInboundBlock == null
    ? sellBlock - ROBINHOOD_RPC_ACQUISITION_LIMITS.fixedFallbackLookbackBlocks
    : earliestKnownInboundBlock - ROBINHOOD_RPC_ACQUISITION_LIMITS.historicalMarginBlocks)
  const absoluteFloor = Math.max(1, sellBlock - ROBINHOOD_RPC_ACQUISITION_LIMITS.maxAbsoluteLookbackBlocks)
  const absoluteLookbackCapHit = desiredFromBlock < absoluteFloor
  const fromBlock = Math.max(desiredFromBlock, absoluteFloor)
  const audit: RhRpcAcquisitionHistoryAudit = {
    sellTxHash, sellBlock, token, wallet, fromBlock, toBlock, chunksAttempted: 0, chunksSucceeded: 0,
    chunkRanges: [], rangeShrinks: 0, logsReturned: 0, exactInboundLogs: 0, uniqueTxCandidates: 0,
    knownCurrentSampleTxsFound: [], newCandidatesFound: 0, receiptsAttempted: 0,
    verifiedBuysRecovered: 0, recoveredBuyRaw: '0', unmatchedSellRawAfter: '0', closedLotsAdded: 0,
    stopReason: 'not_started', historyCoverage: 'bounded_block_lookback',
    lookbackBlocks: sellBlock - fromBlock,
    lowestScannedBlock: null, boundedLookbackComplete: false,
    coverageTarget, earliestKnownInboundBlock, targetFromBlock: fromBlock,
    reachedEarliestKnownInbound: false, reachedHistoricalMargin: false,
    knownInboundHashesExpected, knownInboundHashesFound: [], knownInboundCoverageComplete: false,
    absoluteLookbackCapHit,
    historicalMarginBlocks: ROBINHOOD_RPC_ACQUISITION_LIMITS.historicalMarginBlocks,
    maxAbsoluteLookbackBlocks: ROBINHOOD_RPC_ACQUISITION_LIMITS.maxAbsoluteLookbackBlocks,
    rawInboundAnchorHashes: input.anchorDiagnostics?.rawInboundAnchorHashes ?? [],
    recoveryCandidateAnchorHashes: input.anchorDiagnostics?.recoveryCandidateAnchorHashes ?? [],
    unionAnchorHashes: input.anchorDiagnostics?.unionAnchorHashes ?? knownInboundHashesExpected,
    cachedReceiptAnchorsResolved: input.anchorDiagnostics?.cachedReceiptAnchorsResolved ?? [],
    cachedReceiptAnchorsMissing: input.anchorDiagnostics?.cachedReceiptAnchorsMissing ?? [],
    cachedReceiptAnchorsRejected: input.anchorDiagnostics?.cachedReceiptAnchorsRejected ?? [],
  }
  const rows: RhInboundTokenTransfer[] = []
  if (!rpcLogs || !Number.isSafeInteger(sellBlock) || sellBlock <= 1 || !/^0x[0-9a-f]{40}$/.test(token) || !/^0x[0-9a-f]{40}$/.test(wallet)) {
    audit.stopReason = 'invalid_target'; return { rows, audit }
  }
  const recipientTopic = `0x${wallet.slice(2).padStart(64, '0')}`
  const seenLogs = new Set<string>()
  const seenTxs = new Set<string>()
  const knownFound = new Set<string>()
  const expectedFound = new Set<string>()
  let proofComplete = false
  let nextTo = toBlock
  let chunkBlocks: number = ROBINHOOD_RPC_ACQUISITION_LIMITS.initialChunkBlocks
  while (nextTo >= fromBlock && audit.chunksSucceeded < ROBINHOOD_RPC_ACQUISITION_LIMITS.maxSuccessfulChunks
    && audit.chunksAttempted < ROBINHOOD_RPC_ACQUISITION_LIMITS.maxAttempts) {
    if (Date.now() >= deadlineAt) { audit.stopReason = 'deadline'; break }
    const chunkFrom = Math.max(fromBlock, nextTo - chunkBlocks + 1)
    const query: RhRpcLogQuery = {
      address: token, topics: [ERC20_TRANSFER_TOPIC0, null, recipientTopic],
      fromBlock: `0x${chunkFrom.toString(16)}`, toBlock: `0x${nextTo.toString(16)}`,
    }
    audit.chunksAttempted++
    input.onRpcCalls?.(1)
    const response = await withinRecoveryDeadline(deadlineAt, () => rpcLogs(query, deadlineAt))
    const status = response?.status ?? 'deadline'
    audit.chunkRanges.push({ fromBlock: chunkFrom, toBlock: nextTo, status })
    if (status === 'range_limit') {
      if (chunkBlocks <= 1) { audit.stopReason = 'range_limit_minimum'; break }
      chunkBlocks = Math.max(1, Math.floor(chunkBlocks / 2))
      audit.rangeShrinks++
      continue
    }
    if (status !== 'ok' || !response || response.logs == null) { audit.stopReason = status; break }
    if (response.logs.length > ROBINHOOD_RPC_ACQUISITION_LIMITS.maxLogsPerChunk) {
      audit.logsReturned += response.logs.length
      audit.chunkRanges[audit.chunkRanges.length - 1].status = 'local_result_limit'
      if (chunkBlocks <= 1) { audit.stopReason = 'result_limit_minimum'; break }
      chunkBlocks = Math.max(1, Math.floor(chunkBlocks / 2))
      audit.rangeShrinks++
      continue
    }
    audit.chunksSucceeded++
    audit.lowestScannedBlock = audit.lowestScannedBlock == null ? chunkFrom : Math.min(audit.lowestScannedBlock, chunkFrom)
    audit.logsReturned += response.logs.length
    const byTx = new Map<string, { block: number; raw: bigint }>()
    for (const value of response.logs) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const log = value as Record<string, unknown>
      if (log.removed === true || lower(log.address) !== token || !Array.isArray(log.topics) || log.topics.length !== 3
        || lower(log.topics[0]) !== ERC20_TRANSFER_TOPIC0 || lower(log.topics[2]) !== recipientTopic) continue
      const hash = lower(log.transactionHash)
      const block = hexToNum(log.blockNumber)
      const index = hexToNum(log.logIndex)
      const raw = typeof log.data === 'string' && /^0x[0-9a-f]{64}$/i.test(log.data) ? BigInt(log.data) : ZERO
      if (!/^0x[0-9a-f]{64}$/.test(hash) || block == null || !Number.isSafeInteger(block) || block < fromBlock || block >= sellBlock
        || block < chunkFrom || block > nextTo || index == null || !Number.isSafeInteger(index) || raw <= ZERO) continue
      const key = `${hash}:${index}:${raw.toString()}`
      if (seenLogs.has(key)) continue
      seenLogs.add(key)
      audit.exactInboundLogs++
      if (knownHashes.has(hash)) knownFound.add(hash)
      if (expectedSet.has(hash)) expectedFound.add(hash)
      const prior = byTx.get(hash)
      if (prior && prior.block !== block) continue
      byTx.set(hash, { block, raw: (prior?.raw ?? ZERO) + raw })
    }
    const novel = [...byTx].filter(([hash]) => !seenTxs.has(hash))
      .sort((a, b) => b[1].block - a[1].block || a[0].localeCompare(b[0]))
      .slice(0, ROBINHOOD_RPC_ACQUISITION_LIMITS.maxCandidates - seenTxs.size)
    for (const [hash] of novel) seenTxs.add(hash)
    audit.uniqueTxCandidates = seenTxs.size
    audit.knownCurrentSampleTxsFound = [...knownFound].sort()
    audit.knownInboundHashesFound = [...expectedFound].sort()
    const fresh = novel.filter(([hash]) => !knownHashes.has(hash))
    const blocks = [...new Set(fresh.map(([, v]) => v.block))]
    if (blocks.length) input.onRpcCalls?.(blocks.length)
    const blockResults = blocks.length ? await withinRecoveryDeadline(deadlineAt, () => rpc(blocks.map((block) => ({
      method: 'eth_getBlockByNumber', params: [`0x${block.toString(16)}`, false],
    })))) : []
    const timeByBlock = new Map<number, number>()
    blocks.forEach((block, i) => {
      const result = blockResults?.[i]
      const ts = result && typeof result === 'object' ? hexToNum((result as Record<string, unknown>).timestamp) : null
      if (ts != null && Number.isSafeInteger(ts) && ts > 0) timeByBlock.set(block, ts)
    })
    const chunkRows = fresh.flatMap(([txHash, entry]) => {
      const ts = timeByBlock.get(entry.block)
      return ts == null ? [] : [{ txHash, timestampMs: ts * 1000, token, rawAmount: entry.raw.toString() }]
    })
    rows.push(...chunkRows)
    audit.newCandidatesFound = rows.length
    nextTo = chunkFrom - 1
    const provenStop = !proofComplete && chunkRows.length ? await input.onCandidates?.(chunkRows) : false
    if (provenStop) proofComplete = true // Coverage continues; no further receipt proofs are spent.
    if (seenTxs.size >= ROBINHOOD_RPC_ACQUISITION_LIMITS.maxCandidates) { audit.stopReason = 'candidate_cap'; break }
  }
  if (nextTo < fromBlock) audit.stopReason = 'bounded_target_reached'
  else if (audit.stopReason === 'not_started') audit.stopReason = Date.now() >= deadlineAt ? 'deadline'
    : audit.chunksSucceeded >= ROBINHOOD_RPC_ACQUISITION_LIMITS.maxSuccessfulChunks ? 'chunk_cap'
    : audit.chunksAttempted >= ROBINHOOD_RPC_ACQUISITION_LIMITS.maxAttempts ? 'attempt_cap' : 'incomplete_coverage'
  audit.boundedLookbackComplete = nextTo < fromBlock
  audit.reachedEarliestKnownInbound = earliestKnownInboundBlock != null && audit.lowestScannedBlock != null
    && audit.lowestScannedBlock <= earliestKnownInboundBlock
  audit.reachedHistoricalMargin = earliestKnownInboundBlock != null && audit.lowestScannedBlock != null
    && earliestKnownInboundBlock >= ROBINHOOD_RPC_ACQUISITION_LIMITS.historicalMarginBlocks
    && audit.lowestScannedBlock <= earliestKnownInboundBlock - ROBINHOOD_RPC_ACQUISITION_LIMITS.historicalMarginBlocks
  audit.knownInboundCoverageComplete = knownInboundHashesExpected.length > 0
    && knownInboundHashesExpected.every((hash) => expectedFound.has(hash))
  return { rows, audit }
}

/** One deeper lane, only after the current-sample lane found no buy for a priced unmatched sell. */
async function runDeepAcquisitionRecovery(
  ctx: Ctx, wallet: string, swaps: readonly RhVerifiedSwap[], evidence: readonly RhPriceEvidence[],
  currentRecovery: RhAcquisitionRecoverySummary, inbound: readonly RhInboundTokenTransfer[], outcomes: readonly CandidateOutcome[],
): Promise<{ summary: RhDeepAcquisitionSummary | null; swaps: RhVerifiedSwap[]; evidence: RhPriceEvidence[] }> {
  const empty = { summary: null, swaps: [] as RhVerifiedSwap[], evidence: [] as RhPriceEvidence[] }
  if ((!ctx.deps.historicalTokenInbounds && !ctx.deps.rpcInboundTransferLogs) || currentRecovery.recoveredBuyCount !== 0) return empty
  const isQuote = (t: string) => quoteKind(t) != null
  const sell = [...robinhoodUnmatchedSellRaw(swaps, isQuote)]
    .filter(([hash, v]) => v.unmatchedRaw > ZERO && evidence.some((e) => e.swapTxHash === hash && e.bothLegsVerified))
    .map(([txHash, v]) => ({ txHash, ...v }))
    .sort((a, b) => b.timestampSec - a.timestampSec || a.txHash.localeCompare(b.txHash))[0]
  if (!sell || currentRecovery.sellTxHash !== sell.txHash) return empty
  const startedAt = Date.now()
  const excludedHashes = new Set([...inbound.map((r) => lower(r.txHash)), ...outcomes.map((o) => o.txHash)])
  const sellBlock = swaps.find((s) => s.txHash === sell.txHash)?.blockNumber
  const knownInboundAnchors = sellBlock == null ? null : await knownInboundReceiptAnchors(
    inbound, sell.token, wallet, currentRecovery.candidateTxHashes, sell.txHash, sellBlock, sell.timestampSec,
  )
  const rpcDeadlineAt = Date.now() + ROBINHOOD_RPC_ACQUISITION_LIMITS.budgetMs
  const rpcCtx = { ...ctx, deadlineAt: rpcDeadlineAt }
  const rpcProofRows: RecoveryRow[] = []
  let rpcCovered = ZERO
  const rpcResult = ctx.deps.rpcInboundTransferLogs && sellBlock != null
    ? await discoverRobinhoodRpcAcquisitionHistory({
      sellTxHash: sell.txHash, sellBlock, token: sell.token, wallet, deadlineAt: rpcDeadlineAt,
      rpcLogs: ctx.deps.rpcInboundTransferLogs, rpc: ctx.rpc, knownHashes: new Set(excludedHashes),
      knownInboundHashesExpected: knownInboundAnchors?.expectedHashes,
      knownInboundBlocks: knownInboundAnchors?.blockByHash,
      anchorDiagnostics: knownInboundAnchors?.diagnostics,
      onRpcCalls: (count) => { ctx.m.rpcCalls += count },
      onCandidates: async (chunkRows) => {
        const remainingProofs = ROBINHOOD_DEEP_ACQUISITION_LIMITS.maxReceiptProofs - rpcProofRows.filter((r) => r.rejectionReason !== 'not_attempted_recovery_deadline').length
        if (remainingProofs <= 0) return 'proof_cap'
        const result = await recoverAcquisitionsForSell(rpcCtx, rpcDeadlineAt, wallet,
          { ...sell, unmatchedRaw: sell.unmatchedRaw - rpcCovered }, chunkRows, outcomes,
          { historicalOnly: true, excludedHashes, maxCandidates: remainingProofs })
        rpcProofRows.push(...result.rows)
        for (const row of result.rows) excludedHashes.add(row.candidateTxHash)
        rpcCovered += result.rows.reduce((sum, row) => sum + (row.swap?.outputRaw ?? ZERO), ZERO)
        if (rpcCovered >= sell.unmatchedRaw) return 'sell_covered'
        return rpcProofRows.filter((r) => r.rejectionReason !== 'not_attempted_recovery_deadline').length >= ROBINHOOD_DEEP_ACQUISITION_LIMITS.maxReceiptProofs ? 'proof_cap' : false
      },
    }) : null
  const rpcAudit = rpcResult?.audit ?? null
  const rpcRecovered = rpcProofRows.map((r) => r.swap).filter((s): s is RhVerifiedSwap => s != null)
  const rpcPriced = rpcRecovered.length ? await withinRecoveryDeadline(rpcDeadlineAt, () => priceRobinhoodSwaps(rpcCtx, rpcRecovered)) ?? [] : []
  ctx.priceSidesUsed = rpcCtx.priceSidesUsed
  const remainingProofs = ROBINHOOD_DEEP_ACQUISITION_LIMITS.maxReceiptProofs - rpcProofRows.filter((r) => r.rejectionReason !== 'not_attempted_recovery_deadline').length
  const runFallback = rpcCovered < sell.unmatchedRaw && remainingProofs > 0 && Boolean(ctx.deps.historicalTokenInbounds)
  const deadlineAt = Math.min(ctx.deadlineAt, startedAt + ROBINHOOD_DEEP_ACQUISITION_LIMITS.budgetMs)
  const history = runFallback ? await withinRecoveryDeadline(deadlineAt, () => ctx.deps.historicalTokenInbounds!(wallet, sell.token, sell.timestampSec, deadlineAt)) : null
  const rowKey = (r: RhInboundTokenTransfer): string | null => r.rawAmount != null && /^\d+$/.test(r.rawAmount)
    ? `${lower(r.txHash)}:${BigInt(r.rawAmount).toString()}` : null
  const knownRowKeys = new Set(inbound.map(rowKey).filter((key): key is string => key != null))
  const addressRows = history?.rows ?? []
  for (const row of addressRows) { const key = rowKey(row); if (key) knownRowKeys.add(key) }
  const addressCandidates = addressRows.filter((r) => !excludedHashes.has(lower(r.txHash)))
  // A timed-out/empty filtered probe is unusable; known current-sample rows are not new candidates.
  const tokenHistoryEligible = runFallback && ctx.deps.tokenHistoryInbounds && addressCandidates.length === 0
    && (!history || history.fallbackActivated || history.filteredPagesRequested === 0)
  const tokenDeadlineAt = tokenHistoryEligible ? Date.now() + 6_000 : null
  const tokenHistory = tokenDeadlineAt == null ? null : await withinRecoveryDeadline(tokenDeadlineAt, () => ctx.deps.tokenHistoryInbounds!(wallet, sell.token, sell.timestampSec, tokenDeadlineAt))
  const excludedCurrentSampleHashes = new Set<string>()
  const tokenRows = (tokenHistory?.rows ?? []).filter((r) => {
    const key = rowKey(r)
    if (key == null) return false
    if (excludedHashes.has(lower(r.txHash))) excludedCurrentSampleHashes.add(lower(r.txHash))
    if (knownRowKeys.has(key)) return false
    knownRowKeys.add(key)
    return true
  })
  const proofDeadlineAt = tokenDeadlineAt ?? deadlineAt
  // Keep the parent lane's deadline intact. Only the token-history work gets its own bounded window.
  const proofCtx = tokenDeadlineAt == null ? ctx : { ...ctx, deadlineAt: tokenDeadlineAt }
  const candidates = (tokenDeadlineAt == null ? addressCandidates : tokenRows).filter((r) => !excludedHashes.has(lower(r.txHash)))
    .sort((a, b) => (b.timestampMs ?? -1) - (a.timestampMs ?? -1) || a.txHash.localeCompare(b.txHash))
    .slice(0, Math.max(0, ROBINHOOD_DEEP_ACQUISITION_LIMITS.maxInboundCandidates - (rpcResult?.audit.uniqueTxCandidates ?? 0)))
  const fallbackResult = runFallback ? await recoverAcquisitionsForSell(proofCtx, proofDeadlineAt, wallet,
    { ...sell, unmatchedRaw: sell.unmatchedRaw - rpcCovered }, candidates, outcomes,
    { historicalOnly: true, excludedHashes, maxCandidates: remainingProofs }) : { rows: [] as RecoveryRow[] }
  const rows = [...rpcProofRows, ...fallbackResult.rows]
  const fallbackRecovered = fallbackResult.rows.map((r) => r.swap).filter((s): s is RhVerifiedSwap => s != null)
  const recovered = [...rpcRecovered, ...fallbackRecovered]
  const fallbackPriced = fallbackRecovered.length ? await withinRecoveryDeadline(proofDeadlineAt, () => priceRobinhoodSwaps(proofCtx, fallbackRecovered)) ?? [] : []
  const priced = [...rpcPriced, ...fallbackPriced]
  if (proofCtx !== ctx) ctx.priceSidesUsed = proofCtx.priceSidesUsed
  const after = robinhoodUnmatchedSellRaw([...swaps, ...recovered], isQuote).get(sell.txHash)?.unmatchedRaw ?? sell.unmatchedRaw
  const candidateTimes = candidates.map((r) => r.timestampMs).filter((ts): ts is number => ts != null && Number.isFinite(ts))
  const summary: RhDeepAcquisitionSummary = {
    deepAcquisitionAttempted: true, sellTxHash: sell.txHash, token: sell.token,
    pagesRequested: history?.pagesRequested ?? 0, pagesSucceeded: history?.pagesSucceeded ?? 0,
    filteredPagesRequested: history?.filteredPagesRequested ?? 0, fallbackPagesRequested: history?.fallbackPagesRequested ?? 0,
    fallbackActivated: history?.fallbackActivated ?? false, exactTokenRowsFound: history?.exactTokenRowsFound ?? 0,
    historicalRangeStart: history?.historicalRangeStart ?? (candidateTimes.length ? Math.min(...candidateTimes) : null),
    historicalRangeEnd: history?.historicalRangeEnd ?? (candidateTimes.length ? Math.max(...candidateTimes) : null),
    historicalCandidatesFound: (rpcResult?.audit.newCandidatesFound ?? 0) + candidates.length, olderInboundRowsFound: history?.olderInboundRowsFound ?? 0,
    candidatesSelected: Math.min((rpcResult?.audit.newCandidatesFound ?? 0) + candidates.length, ROBINHOOD_DEEP_ACQUISITION_LIMITS.maxReceiptProofs),
    receiptsAttempted: rows.filter((r) => r.rejectionReason !== 'not_attempted_recovery_deadline').length,
    verifiedBuysRecovered: recovered.length, recoveredBuyRaw: recovered.reduce((n, s) => n + s.outputRaw, ZERO).toString(),
    unmatchedSellRawBefore: sell.unmatchedRaw.toString(), unmatchedSellRawAfter: after.toString(), closedLotsAdded: 0,
    stopReason: after === ZERO ? 'sell_covered' : runFallback && Date.now() >= proofDeadlineAt ? 'deadline'
      : tokenHistoryEligible ? tokenHistory?.stopReason ?? 'token_history_unavailable'
        : runFallback ? history?.stopReason ?? 'history_unavailable' : rpcAudit?.stopReason ?? 'history_unavailable', elapsedMs: Date.now() - startedAt,
    tokenHistoryAttempted: Boolean(tokenHistoryEligible), tokenHistoryPagesRequested: tokenHistory?.pagesRequested ?? 0,
    tokenHistoryPagesSucceeded: tokenHistory?.pagesSucceeded ?? 0, tokenHistoryRowsReturned: tokenHistory?.rowsReturned ?? 0,
    tokenHistoryWalletMatches: tokenHistory?.walletMatches ?? 0, tokenHistoryCandidatesFound: tokenHistory?.candidatesFound ?? 0,
    tokenHistoryStopReason: tokenHistoryEligible ? tokenHistory?.stopReason ?? 'deadline' : null,
    tokenHistoryExcludedCurrentSampleHashes: [...excludedCurrentSampleHashes].sort(),
    rpcHistory: rpcAudit,
  }
  if (rpcAudit) {
    rpcAudit.receiptsAttempted = rpcProofRows.filter((r) => r.rejectionReason !== 'not_attempted_recovery_deadline').length
    rpcAudit.verifiedBuysRecovered = rpcRecovered.length
    rpcAudit.recoveredBuyRaw = rpcRecovered.reduce((sum, swap) => sum + swap.outputRaw, ZERO).toString()
    rpcAudit.unmatchedSellRawAfter = (robinhoodUnmatchedSellRaw([...swaps, ...rpcRecovered], isQuote).get(sell.txHash)?.unmatchedRaw ?? sell.unmatchedRaw).toString()
    if (rpcRecovered.length) {
      const beforeFifo = buildRobinhoodPnlV1Fifo(wallet, swaps, evidence)
      const rpcFifo = buildRobinhoodPnlV1Fifo(wallet, [...swaps, ...rpcRecovered], [...evidence, ...rpcPriced])
      rpcAudit.closedLotsAdded = rpcFifo.fifo.matchedLots.length - beforeFifo.fifo.matchedLots.length
    }
  }
  for (const row of rows) {
    const price = priced.find((p) => p.swapTxHash === row.candidateTxHash)
    console.warn('[robinhood-deep-acquisition-audit]', {
      ...summary, candidateTxHash: row.candidateTxHash, candidateTimestamp: row.candidateTimestamp, inboundRaw: row.inboundRaw,
      classification: row.classification, routeProven: row.routeProven, ownershipProven: row.ownershipProven,
      txValueEvidence: row.txValueEvidence, priceEvidenceStatus: !row.swap ? null : price?.bothLegsVerified ? 'both_legs_priced' : (price?.rejectionReason ?? 'not_priced'),
      fifoIncluded: row.swap != null, rejectionReason: row.rejectionReason,
    })
  }
  if (!rows.length) console.warn('[robinhood-deep-acquisition-audit]', { ...summary, candidateTxHash: null, classification: null, rejectionReason: summary.stopReason })
  return { summary, swaps: recovered, evidence: priced }
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────────────────
export function selectRobinhoodPnlV1Candidates(candidates: readonly RobinhoodPnlV1Candidate[]): { selected: RobinhoodPnlV1Candidate[]; dropped: number } {
  const byHash = new Map<string, RobinhoodPnlV1Candidate>()
  for (const c of candidates) {
    const h = lower(c.txHash)
    if (!/^0x[0-9a-f]{64}$/.test(h)) continue
    const prev = byHash.get(h)
    byHash.set(h, prev
      ? { txHash: h, timestampMs: prev.timestampMs ?? c.timestampMs, hasSwapLog: prev.hasSwapLog || c.hasSwapLog }
      : { txHash: h, timestampMs: c.timestampMs, hasSwapLog: c.hasSwapLog })
  }
  // Txs with a seen Swap log first, then most recent first, then hash: a deterministic bounded sample.
  const all = [...byHash.values()].sort((a, b) => Number(b.hasSwapLog) - Number(a.hasSwapLog) || (b.timestampMs ?? -1) - (a.timestampMs ?? -1) || a.txHash.localeCompare(b.txHash))
  const selected = all.slice(0, ROBINHOOD_PNL_V1_LIMITS.maxCandidateReceipts)
  return { selected, dropped: all.length - selected.length }
}

export async function computeRobinhoodPnlV1(params: {
  wallet: string
  candidates: readonly RobinhoodPnlV1Candidate[]
  transactionCount: number
  transferCount: number
  /** Why the sidecar's activity could not be read, when it could not (status unavailable/not_configured). */
  activityUnavailableReason: string | null
  deps: RobinhoodPnlV1Deps
  /** Activity rows of tokens the wallet received — only read by the acquisition recovery lane. */
  inboundTokenTransfers?: readonly RhInboundTokenTransfer[]
}): Promise<RobinhoodPnlV1> {
  const startedAt = params.deps.now()
  const wallet = lower(params.wallet)
  const m: RobinhoodPnlV1Metrics = { robinhoodPnlMs: 0, receiptCalls: 0, rpcCalls: 0, historicalPriceCalls: 0, cacheHits: 0, swapsVerified: 0, lotsBuilt: 0, deadlineHit: false, nativeTraceLookups: 0 }
  const { selected, dropped } = selectRobinhoodPnlV1Candidates(params.candidates)
  let prefetchSignalled = false
  const signalNativePrefetchComplete = () => {
    if (prefetchSignalled) return
    prefetchSignalled = true
    params.deps.onNativePricePrefetchComplete?.()
  }
  const ingestion: RobinhoodPnlV1IngestionAudit = {
    wallet, transactionCount: params.transactionCount, transferCount: params.transferCount,
    candidateSwapTxCount: selected.length, candidatesDroppedByCap: dropped, receiptsFetched: 0, v4SwapLogCount: 0,
    verifiedSwapTxCount: 0, rejectedSwapTxCount: 0, rejectionReasons: {}, normalizedBuyCount: 0, normalizedSellCount: 0,
  }
  const finish = (r: Omit<RobinhoodPnlV1, 'ingestionAudit' | 'metrics' | 'priceEvidence'> & { priceEvidence?: RhPriceEvidence[] }): RobinhoodPnlV1 => {
    signalNativePrefetchComplete()
    m.robinhoodPnlMs = params.deps.now() - startedAt
    // console.warn: production strips console.log (next.config removeConsole); this must log on every exit.
    const result: RobinhoodPnlV1 = { ...r, priceEvidence: r.priceEvidence ?? [], ingestionAudit: ingestion, metrics: m }
    console.warn('[robinhood-pnl-ingestion-audit]', { ...ingestion, status: result.status, exactReason: result.exactReason, metrics: m })
    return result
  }
  const empty = { structuralClosedLots: 0, verifiedClosedLots: 0, pricingCoverage: null, realizedPnlUsd: null, realizedRoiPct: null, unmatchedSellCount: 0, swapsFound: 0, swapsVerified: 0, swapsBothLegsPriced: 0 }
  if (!params.deps.rpc) return finish({ ...empty, status: 'unavailable', exactReason: 'Robinhood RPC is not configured — swap receipts cannot be read.' })
  if (params.activityUnavailableReason && selected.length === 0) return finish({ ...empty, status: 'unavailable', exactReason: `Robinhood wallet activity unavailable (${params.activityUnavailableReason}).` })
  if (selected.length === 0) return finish({ ...empty, status: 'not_verified', exactReason: 'No Robinhood transactions with token movements were found for this wallet.' })

  const ctx: Ctx = { deps: params.deps, rpc: params.deps.rpc, deadlineAt: Date.now() + ROBINHOOD_PNL_V1_LIMITS.deadlineMs, m, priceSidesUsed: 0 }
  const outcomes = await mapLimit(selected, ROBINHOOD_PNL_V1_LIMITS.concurrency, (c) => verifyCandidate(ctx, wallet, c.txHash).catch((): CandidateOutcome => ({ txHash: c.txHash, receiptFetched: false, v4SwapLogs: 0, swap: null, rejection: 'receipt_unavailable', detail: 'verification threw' })))
  const swaps: RhVerifiedSwap[] = []
  for (const o of outcomes) {
    if (o.receiptFetched) ingestion.receiptsFetched += 1
    ingestion.v4SwapLogCount += o.v4SwapLogs
    if (o.swap) { swaps.push(o.swap); continue }
    if (o.rejection === 'deadline_exceeded') m.deadlineHit = true
    ingestion.rejectedSwapTxCount += 1
    if (o.rejection) ingestion.rejectionReasons[o.rejection] = (ingestion.rejectionReasons[o.rejection] ?? 0) + 1
  }
  ingestion.verifiedSwapTxCount = swaps.length
  const forensicRows = outcomes.map((o) => o.forensics).filter((f): f is RobinhoodSwapForensics => f != null)
  for (const f of forensicRows) console.warn('[robinhood-swap-verification-forensics]', f)
  for (const o of outcomes) if (!o.forensics) console.warn('[robinhood-swap-verification-forensics]', { txHash: o.txHash, wallet, rejectionReason: o.rejection, receiptFetched: o.receiptFetched, attributionClass: null, attributionDetail: o.detail ?? 'no receipt evidence' })
  ingestion.v4AttributionClasses = summarizeAttribution(forensicRows)
  const mixedRows = outcomes.map((o) => o.mixedRoute).filter((m): m is RobinhoodMixedRouteForensics => m != null)
  for (const m of mixedRows) console.warn('[robinhood-mixed-route-forensics]', m)
  ingestion.mixedRouteClasses = { direct_mixed_route_proven: 0, independent_second_action: 0, ambiguous: 0 }
  for (const m of mixedRows) ingestion.mixedRouteClasses[m.finalClassification] += 1
  ingestion.directV4VerifiedSwapCount = outcomes.filter((o) => o.swap && o.acceptedVia === 'direct_v4').length
  ingestion.mixedRouteVerifiedSwapCount = outcomes.filter((o) => o.swap && o.acceptedVia === 'mixed_route').length
  const mixedRejected = outcomes.filter((o) => o.mixedRoute && !o.swap)
  ingestion.mixedRouteRejectedCount = mixedRejected.length
  ingestion.mixedRouteRejectedReasons = {}
  for (const o of mixedRejected) {
    const k = o.mixedRoute!.finalClassification === 'direct_mixed_route_proven' ? (o.mixedRejection ?? 'promotion_failed') : o.mixedRoute!.finalClassification
    ingestion.mixedRouteRejectedReasons[k] = (ingestion.mixedRouteRejectedReasons[k] ?? 0) + 1
  }
  m.swapsVerified = swaps.length
  const swapsFound = outcomes.filter((o) => o.v4SwapLogs > 0).length

  try {
    if (params.deps.prefetchNativeEthDays) await params.deps.prefetchNativeEthDays(swaps)
  } catch (err) {
    console.warn('[robinhood-native-price-prefetch-error]', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    signalNativePrefetchComplete()
  }
  const evidence = swaps.length > 0 ? await priceRobinhoodSwaps(ctx, swaps) : []
  for (const e of evidence) console.warn('[robinhood-price-evidence-audit]', e)
  const bothLegs = evidence.filter((e) => e.bothLegsVerified).length
  const first = buildRobinhoodPnlV1Fifo(wallet, swaps, evidence)
  // Recovery lane: only a verified sell the FIFO left unmatched; only proven acquisitions join the FIFO.
  const recovery = await runAcquisitionRecovery(ctx, wallet, swaps, first.fifo.unmatchedSells, outcomes, params.inboundTokenTransfers ?? [])
  const intermediate = recovery.swaps.length > 0
    ? buildRobinhoodPnlV1Fifo(wallet, [...swaps, ...recovery.swaps], [...evidence, ...recovery.evidence])
    : first
  recovery.summary.closedLotsAdded = intermediate.fifo.matchedLots.length - first.fifo.matchedLots.length
  ingestion.acquisitionRecovery = recovery.summary
  const deep = await runDeepAcquisitionRecovery(ctx, wallet, [...swaps, ...recovery.swaps], [...evidence, ...recovery.evidence], recovery.summary, params.inboundTokenTransfers ?? [], outcomes)
  const { fifo, buyCount, sellCount } = deep.swaps.length > 0
    ? buildRobinhoodPnlV1Fifo(wallet, [...swaps, ...recovery.swaps, ...deep.swaps], [...evidence, ...recovery.evidence, ...deep.evidence])
    : intermediate
  if (deep.summary) {
    deep.summary.closedLotsAdded = fifo.matchedLots.length - intermediate.fifo.matchedLots.length
    if (deep.summary.rpcHistory) {
      console.warn('[robinhood-rpc-acquisition-history-audit]', deep.summary.rpcHistory)
    }
    ingestion.deepAcquisition = deep.summary
    console.warn('[robinhood-deep-acquisition-audit]', { ...deep.summary, candidateTxHash: null, classification: 'summary' })
  }
  for (const o of outcomes) {
    if (!o.mixedRoute) continue
    const e = o.swap ? evidence.find((x) => x.swapTxHash === o.txHash) : undefined
    console.warn('[robinhood-mixed-route-acceptance-audit]', {
      txHash: o.txHash,
      classification: o.mixedRoute.finalClassification,
      accepted: o.swap != null,
      inputToken: o.swap?.inputToken ?? null,
      inputRaw: o.swap?.inputRaw.toString() ?? null,
      outputToken: o.swap?.outputToken ?? null,
      outputRaw: o.swap?.outputRaw.toString() ?? null,
      nativeProofStatus: o.mixedRoute.nativeAttributionStatus,
      priceEvidenceStatus: !o.swap ? null : e?.bothLegsVerified ? 'both_legs_priced' : (e?.rejectionReason ?? 'not_priced'),
      // Only token legs open/close lots; a swap with at least one non-quote leg reaches FIFO.
      fifoIncluded: o.swap != null && !(quoteKind(o.swap.inputToken) && quoteKind(o.swap.outputToken)),
      rejectionReason: o.swap ? null : (o.mixedRejection ?? o.rejection),
    })
  }
  ingestion.normalizedBuyCount = buyCount
  ingestion.normalizedSellCount = sellCount
  const structural = fifo.matchedLots.length
  const verifiedLots = fifo.matchedLots.filter((l) => l.evidenceQuality === 'verified' && l.realizedPnlUsd != null && l.costBasisUsd != null)
  m.lotsBuilt = structural
  const realized = verifiedLots.length > 0 ? Math.round(verifiedLots.reduce((s, l) => s + l.realizedPnlUsd!, 0) * 100) / 100 : null
  const cost = verifiedLots.reduce((s, l) => s + l.costBasisUsd!, 0)
  const coverage = structural > 0 ? Math.round((verifiedLots.length / structural) * 10_000) / 100 : null
  const base = {
    structuralClosedLots: structural,
    verifiedClosedLots: verifiedLots.length,
    pricingCoverage: coverage,
    realizedPnlUsd: realized,
    realizedRoiPct: realized != null && cost > 0 ? Math.round((realized / cost) * 10_000) / 100 : null,
    unmatchedSellCount: fifo.unmatchedSells,
    swapsFound,
    swapsVerified: swaps.length,
    swapsBothLegsPriced: bothLegs,
    priceEvidence: [...evidence, ...recovery.evidence, ...deep.evidence],
    acquisitionRecovery: recovery.summary,
    deepAcquisition: deep.summary,
  }
  if (verifiedLots.length > 0) {
    const status: RobinhoodPnlV1Status = coverage != null && coverage >= ROBINHOOD_PNL_V1_MIN_COVERAGE_PCT ? 'verified_bounded_sample' : 'partial'
    return finish({ ...base, status, exactReason: `${verifiedLots.length}/${structural} closed lots verified from ${swaps.length} proven V4 swaps${recovery.swaps.length + deep.swaps.length > 0 ? ` + ${recovery.swaps.length + deep.swaps.length} recovered acquisition${recovery.swaps.length + deep.swaps.length === 1 ? '' : 's'}` : ''} (bounded sample of the ${selected.length} most recent candidate txs).` })
  }
  const topRejection = Object.entries(ingestion.rejectionReasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  const exactReason = swaps.length === 0
    ? `${swapsFound} swap${swapsFound === 1 ? '' : 's'} found / 0 proven as wallet V4 trades${topRejection ? ` (most common: ${topRejection[0]})` : ''}.`
    : bothLegs === 0
      ? `${swaps.length} swap${swaps.length === 1 ? '' : 's'} found / 0 had both-leg historical price proof.`
      : structural === 0
        ? `${swaps.length} swap${swaps.length === 1 ? '' : 's'} proven, ${bothLegs} priced on both legs, but no buy→sell pair closed a lot in this sample.${recovery.summary.acquisitionRecoveryAttempted ? ` Acquisition recovery checked ${recovery.summary.candidatesAttempted} earlier inbound${recovery.summary.candidatesAttempted === 1 ? '' : 's'} of the sold token; none was a provable buy.` : ''}`
        : `${structural} lots closed, but none had verified prices on both the buy and the sell.`
  return finish({ ...base, status: 'not_verified', exactReason })
}

// ── Real dependencies ───────────────────────────────────────────────────────────────────────────────
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export function robinhoodRpcFromUrl(rpcUrl: string | null, fetchImpl: FetchLike): RhRpc | null {
  if (!rpcUrl) return null
  return async (calls) => {
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params }))),
        signal: AbortSignal.timeout(ROBINHOOD_PNL_V1_LIMITS.rpcTimeoutMs),
      })
      if (!res.ok) return calls.map(() => null)
      const json = await res.json().catch(() => null)
      const rows = Array.isArray(json) ? json as Array<{ id?: number; result?: unknown; error?: unknown }> : []
      return calls.map((_, id) => {
        const row = rows.find((r) => r && r.id === id)
        return row && row.error == null && row.result != null ? row.result : null
      })
    } catch {
      return calls.map(() => null)
    }
  }
}

/** Unlike the batch RPC, preserve range-limit errors so the log search can shrink its exact range. */
export function robinhoodRpcInboundLogsFromUrl(rpcUrl: string | null, fetchImpl: FetchLike): RobinhoodPnlV1Deps['rpcInboundTransferLogs'] {
  if (!rpcUrl) return undefined
  return async (query, deadlineAt) => {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) return { status: 'unavailable', logs: null }
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [query] }),
        signal: AbortSignal.timeout(Math.min(ROBINHOOD_PNL_V1_LIMITS.rpcTimeoutMs, remaining)),
      })
      if (res.status === 413) return { status: 'range_limit', logs: null }
      if (!res.ok) return { status: 'unavailable', logs: null }
      const json = await res.json().catch(() => null) as { result?: unknown; error?: { code?: number; message?: string } } | null
      if (Array.isArray(json?.result)) return { status: 'ok', logs: json.result }
      const message = json?.error?.message ?? ''
      const rangeLimited = json?.error?.code === -32005 || /(?:block range|range too|too many results|result limit|response size|exceeds? (?:the )?limit)/i.test(message)
      return { status: rangeLimited ? 'range_limit' : 'unavailable', logs: null }
    } catch { return { status: 'unavailable', logs: null } }
  }
}

/** GoldRush historical token price for the exact token and the swap's own UTC day; null on any doubt. */
export function goldrushRobinhoodTokenHistoricalUsd(fetchImpl: FetchLike): RobinhoodPnlV1Deps['tokenHistoricalUsd'] {
  return async (token, timestampSec) => {
    const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
    if (!apiKey || !/^0x[0-9a-f]{40}$/.test(token)) return null
    const day = new Date(timestampSec * 1000).toISOString().slice(0, 10)
    try {
      const res = await fetchImpl(`https://api.covalenthq.com/v1/pricing/historical_by_addresses_v2/robinhood-mainnet/USD/${token}/?from=${day}&to=${day}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(ROBINHOOD_PNL_V1_LIMITS.providerTimeoutMs),
      })
      if (!res.ok) return null
      const json = await res.json().catch(() => null) as { data?: Array<{ contract_address?: string; items?: Array<{ date?: string; price?: number }> }> } | null
      const row = json?.data?.find((d) => lower(d.contract_address) === token)
      const item = row?.items?.find((it) => typeof it.date === 'string' && it.date.slice(0, 10) === day)
      return item && typeof item.price === 'number' && Number.isFinite(item.price) && item.price > 0 ? { priceUsd: item.price, source: 'goldrush_historical_exact_token_day' } : null
    } catch {
      return null
    }
  }
}

export function defaultRobinhoodPnlV1Deps(fetchImpl: FetchLike): RobinhoodPnlV1Deps {
  return {
    rpc: robinhoodRpcFromUrl(getRobinhoodRpcUrl(), fetchImpl),
    rpcInboundTransferLogs: robinhoodRpcInboundLogsFromUrl(getRobinhoodRpcUrl(), fetchImpl),
    ethUsdRange: async (fromSec, toSec) => fetchCoingeckoEthUsdRange(fromSec, toSec, ROBINHOOD_PNL_V1_LIMITS.providerTimeoutMs),
    tokenHistoricalUsd: goldrushRobinhoodTokenHistoricalUsd(fetchImpl),
    now: Date.now,
  }
}
