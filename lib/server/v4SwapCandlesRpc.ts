// lib/server/v4SwapCandlesRpc.ts — Uniswap V4 candles from ON-CHAIN Swap events, for a V4 pool the
// candle providers can't serve by its bytes32 PoolId. Pure math lives in lib/v4SwapCandles.ts.
//
// Scope — only what can be proven:
//  - Chains: Base, Ethereum, BNB and Robinhood Chain, each with its own verified Uniswap V4 PoolManager
//    and timestamp policy (V4_SWAP_CHAIN_CONFIG below — evidence cited per value). Any other chain:
//    v4_chain_not_supported; a configured chain without an RPC: v4_rpc_unavailable; a pool-id
//    protocol with no verified contracts here (PancakeSwap Infinity): v4_protocol_unsupported.
//  - Exact pool: the pool's Initialize must come from a configured manager for exactly this PoolId,
//    Swap logs are read from that one manager filtered by the PoolId topic, and every decoded log
//    re-checks both — another pool on the shared PoolManager never leaks in.
//  - Counter asset: the chain's native asset or its verified wrapped native (CoinGecko's real
//    historical ETH/USD or BNB/USD, one shared cached series per coin), a verified USD stablecoin ($1),
//    or — one hop only — any other token whose own USD history is proven by an INDEPENDENT pool pairing
//    it directly with the native/wrapped native or a verified stable (lib/server/v4QuoteUsd.ts).
//    Otherwise quote_usd_price_unproven. Every trade needs a quote USD point within 15 minutes of it,
//    or that trade is dropped.
//  - The latest candle must sit within 3x of the scan's live token price, or the series is rejected.
//
// TIMESTAMPS. A log's own `blockTimestamp` is exact; when EVERY swap log carries one, candles are
// 5-minute buckets of exact trade times. Otherwise, per chain: Base infers from the real latest header
// and its protocol-fixed 2s interval ('inferred_block_time'); ETH / BNB interpolate between two REAL
// block headers ('block_timestamp_lookup'); Robinhood stops (v4_timestamps_unproven). Any non-exact
// series is bucketed at 15 minutes, never presented as exact 5M candles.
//
// INITIAL WINDOW (every scan). Target: the pool's last 24h — all of it for a pool younger than that —
// never a crawl of older history. Every call (RPC and CoinGecko) counts against the caller's
// remaining candle-path budget: 1 latest header + 1 Initialize read (cached 24h per PoolId) + at most
// 3 Swap-log pages newest first (4h, 8h, 12h = 24h; a busy pool keeps 4h pages) + the shared ETH/USD
// series only on a cache miss. At most 6,000 logs: when that cap is hit the NEWEST logs are kept and
// the oldest, possibly partial, bucket is dropped (never a gap near "now"). 8s overall deadline
// (per-call timeouts are clipped to it), zero retries after an RPC error, reorged (`removed`) logs
// ignored, per-pool result cache.
//
// ON-DEMAND HISTORY (loadV4SwapHistoryWindow — only after the user selects 1H/4H/1D or pans past the
// oldest loaded candle): hourly candles for the same exact PoolId strictly before a `before` cursor.
// Adaptive pages (24h, growing to 4 days while the pool is quiet, shrinking when busy), at most 3 pages
// and 6,000 logs per request, 8 calls, 9s deadline, results cached per window; the response carries
// `hasMore` and the next cursor. Quote USD over the window: USD stable at $1, CoinGecko's hourly
// ETH/USD for that window, or the independent quote pool's hourly candles ending at the window's end —
// each trade within 45 minutes of a real quote point or dropped.

import { RPC } from '../rpc.ts'
import { getRobinhoodRpcUrl } from './robinhoodChainConfig.ts'
import { CHAIN_ASSET_REGISTRY, classifyQuoteAsset, staticNativeLike, verifiedUsdStableDecimals, wrappedNativeDebug, type QuoteClassification } from './chainAssetRegistry.ts'
import { logRpcCall } from './rpcDebug.ts'
import { auditGlobalAlchemyCall } from './globalRpcAudit.ts'
import {
  V4_INITIALIZE_TOPIC0,
  V4_SWAP_TOPIC0,
  buildV4SwapCandles,
  decodeV4Initialize,
  decodeV4Swap,
  nearestPriceWithGap,
  v4TokenPriceInCounter,
  type RawEvmLog,
  type V4PoolKey,
  type V4Swap,
} from '../v4SwapCandles.ts'
import { closeMatchesLivePrice, type EvmChartPoint } from '../evmChartCandles.ts'
import { quoteUsdFailureReason, type QuoteDiscoveryDebug, type QuoteHistoryDebug, type QuoteSelectionInput, type QuoteUsdFailureReason, type QuoteUsdResult } from './v4QuoteUsd.ts'

const NATIVE = '0x0000000000000000000000000000000000000000'

// ── Per-chain V4 configuration ───────────────────────────────────────────────────────────────────
// Every value below is taken from evidence already in this repo, never from memory:
//  - Uniswap V4 PoolManager, ETH (1) / Base (8453) / BNB (56): lib/server/concentratedLpPositions.ts
//    V4_POOL_MANAGER ("Official Uniswap v4 deployments", developers.uniswap.org/deployments) and
//    lib/server/lpProof.ts KNOWN_PROTOCOL_MANAGERS; Base additionally cross-checked live on BaseScan,
//    Base Blockscout and GeckoTerminal (lib/server/uniswapV4BaseRpc.ts).
//  - Uniswap V4 PoolManager, Robinhood Chain (4663): verified live on robinhoodchain.blockscout.com —
//    source-verified PoolManager.sol matching v4-core (lib/server/uniswapV4RobinhoodRpc.ts).
//  - Same PoolManager bytecode everywhere (CREATE2, same init code) => identical Initialize/Swap ABI.
//  - Native / wrapped-native / verified USD stables per chain: lib/server/chainAssetRegistry.ts (exact
//    addresses + decimals + evidence). Base / ETH / BNB values unchanged. Robinhood's WETH is statically
//    verified by Uniswap's official deployments/4663.md (the _WETH9 of its V3 NPM, V4 PositionManager,
//    SwapRouter02, QuoterV2 and UniversalRouter), so it is priced as ETH and is the independent-pool
//    anchor. Robinhood has no verified USD stable, so any other quote asset takes the one-hop lane.
//  - PancakeSwap Infinity (BNB): no verified manager address or ABI in this repo => not configured;
//    a pool whose dex is not Uniswap V4 is reported as v4_protocol_unsupported (zero calls).
//
// TIMESTAMPS per chain:
//  - base: 'fixed_block_time' — Base's protocol-fixed 2s block interval (unchanged behavior).
//  - eth / bnb: 'header_anchor_interpolation' — block spacing is not fixed (ETH missed slots; BNB
//    block time changed across hard forks), so one REAL block header ~24h back plus the latest header
//    anchor the window; exact log timestamps are used when every log carries one, otherwise times are
//    interpolated between the two real headers ('block_timestamp_lookup', never exact 5M -> 15M).
//    nominalBlockSec only sizes the window; it is never used as a timestamp.
//  - robinhood: 'log_timestamp_only' — block production is not proven regular, so candles need every
//    log's own blockTimestamp; otherwise v4_timestamps_unproven (never guessed).

export type QuoteUsdAttempt = 'native_usd' | 'stable_usd' | 'independent_quote_pool' | 'none'
export type V4TimestampMode = 'fixed_block_time' | 'header_anchor_interpolation' | 'log_timestamp_only'
export type V4ManagerConfig = { protocol: 'uniswap_v4'; address: string; source: string }

export type V4ChainConfig = {
  chain: 'base' | 'eth' | 'bnb' | 'robinhood'
  chainId: number
  /** Primary manager (debug); the pool's own manager is whichever configured manager emitted its Initialize. */
  poolManager: string
  managers: ReadonlyArray<V4ManagerConfig>
  timestampMode: V4TimestampMode
  /** fixed_block_time only: the protocol-fixed block interval. */
  blockTimeSec: number
  /** Window sizing only (how many blocks ~24h spans) — never a timestamp source. */
  nominalBlockSec: number
  rpcUrl: () => string
  /** Native asset priced by CoinGecko's historical <coinId>/USD. */
  native: { coinId: 'ethereum' | 'binancecoin'; symbol: 'ETH' | 'BNB' }
  /** Native (0x0) and verified wrapped-native currencies -> decimals, priced by the native series. */
  nativeLike: Record<string, number>
  /** Verified USD stablecoins -> decimals, priced at $1. */
  usdStable: Record<string, number>
}

const UNISWAP_V4_DEPLOYMENTS = 'developers.uniswap.org/deployments (lib/server/concentratedLpPositions.ts V4_POOL_MANAGER)'

export const V4_SWAP_CHAIN_CONFIG: Readonly<Record<string, V4ChainConfig>> = {
  base: {
    chain: 'base',
    chainId: 8453,
    poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    managers: [{ protocol: 'uniswap_v4', address: '0x498581ff718922c3f8e6a244956af099b2652b2b', source: 'BaseScan + Base Blockscout + GeckoTerminal (lib/server/uniswapV4BaseRpc.ts)' }],
    timestampMode: 'fixed_block_time',
    blockTimeSec: 2,
    nominalBlockSec: 2,
    rpcUrl: () => RPC.base,
    native: { coinId: 'ethereum', symbol: 'ETH' },
    nativeLike: staticNativeLike('base'),
    usdStable: verifiedUsdStableDecimals('base'),
  },
  eth: {
    chain: 'eth',
    chainId: 1,
    poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
    managers: [{ protocol: 'uniswap_v4', address: '0x000000000004444c5dc75cb358380d2e3de08a90', source: UNISWAP_V4_DEPLOYMENTS }],
    timestampMode: 'header_anchor_interpolation',
    blockTimeSec: 0,
    nominalBlockSec: 12,
    rpcUrl: () => RPC.eth,
    native: { coinId: 'ethereum', symbol: 'ETH' },
    nativeLike: staticNativeLike('eth'),
    usdStable: verifiedUsdStableDecimals('eth'),
  },
  bnb: {
    chain: 'bnb',
    chainId: 56,
    poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
    managers: [{ protocol: 'uniswap_v4', address: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df', source: UNISWAP_V4_DEPLOYMENTS }],
    timestampMode: 'header_anchor_interpolation',
    blockTimeSec: 0,
    nominalBlockSec: 0.75,
    rpcUrl: () => RPC.bnb,
    native: { coinId: 'binancecoin', symbol: 'BNB' },
    nativeLike: staticNativeLike('bnb'),
    usdStable: verifiedUsdStableDecimals('bnb'),
  },
  robinhood: {
    chain: 'robinhood',
    chainId: 4663,
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    managers: [{ protocol: 'uniswap_v4', address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', source: 'robinhoodchain.blockscout.com verified source (lib/server/uniswapV4RobinhoodRpc.ts)' }],
    timestampMode: 'log_timestamp_only',
    blockTimeSec: 0,
    nominalBlockSec: 0.25,
    rpcUrl: () => getRobinhoodRpcUrl() ?? '',
    native: { coinId: 'ethereum', symbol: 'ETH' },
    nativeLike: staticNativeLike('robinhood'),
    usdStable: verifiedUsdStableDecimals('robinhood'),
  },
}

/**
 * Protocols that use a DIFFERENT pool-id manager than Uniswap V4 and have no verified contracts here
 * (PancakeSwap Infinity). A pool the provider labels with one of them is reported as
 * v4_protocol_unsupported with zero calls. Everything else is judged by the proof that matters: its
 * Initialize event on a configured, verified Uniswap V4 PoolManager (hook-based launchpads that use
 * that same PoolManager keep working whatever their dex label).
 */
const UNVERIFIED_POOL_ID_PROTOCOLS = /pancake|infinity/i

export function v4ProtocolSupported(chain: string, dexHint: string | null | undefined): boolean {
  const cfg = V4_SWAP_CHAIN_CONFIG[chain]
  if (!cfg) return false
  return !(dexHint && UNVERIFIED_POOL_ID_PROTOCOLS.test(dexHint))
}

/**
 * Independent-pool lane input for this chain: anchors = the chain's native-like + verified stables (the
 * wrapped native is what an ordinary pool can actually pair with; native 0x0 never appears as an ERC-20
 * pool token), plus the chain's anchor-ranking rule.
 */
export function quoteLaneSelection(chain: string): Pick<QuoteSelectionInput, 'anchors' | 'anchorPriority' | 'wrappedNative'> {
  const cfg = V4_SWAP_CHAIN_CONFIG[chain]
  const reg = CHAIN_ASSET_REGISTRY[chain]
  return {
    anchors: new Set(cfg ? [...Object.keys(cfg.nativeLike), ...Object.keys(cfg.usdStable)] : []),
    anchorPriority: reg?.anchorPriority ?? 'liquidity',
    wrappedNative: reg?.wrappedNative?.address ?? null,
  }
}

const STABLE_LIKE_SYMBOL = /^(usdc|usdt|usdc\.e|usdt0|dai|usds|usde|pyusd|fdusd|busd|tusd|usdbc)$/i
const WRAPPED_NATIVE_LIKE_SYMBOL = /^(weth|wbnb|eth|bnb)$/i
/**
 * Exact reason the independent lane did not prove a quote asset's USD history. A symbol never prices
 * anything: it only explains why a token CALLING itself a stable / wrapped native was not treated as one
 * (its exact address is not in this chain's verified registry) when no independent pool proved it either.
 */
export function explainQuoteFailure(q: Pick<QuoteUsdResult, 'detail' | 'selectionFailure' | 'quoteSymbol'>): QuoteUsdFailureReason {
  const base = quoteUsdFailureReason(q.detail, q.selectionFailure ?? null)
  if (base !== 'quote_pool_not_found' && base !== 'quote_pool_liquidity_too_low') return base
  if (q.quoteSymbol && STABLE_LIKE_SYMBOL.test(q.quoteSymbol)) return 'stable_asset_unverified'
  if (q.quoteSymbol && WRAPPED_NATIVE_LIKE_SYMBOL.test(q.quoteSymbol)) return 'wrapped_native_unverified'
  return base
}

export const V4_SWAP_PAGE_BLOCKS = 7_200
/** Initial-scan page sizes, newest first: 4h + 8h + 12h = 24h of Base blocks. */
export const V4_SWAP_PAGE_PLAN: ReadonlyArray<number> = [7_200, 14_400, 21_600]
export const V4_SWAP_TARGET_WINDOW_SEC = 24 * 3600
/** A first page this busy keeps later pages at 4h (stays well under the RPC's per-response log limit). */
export const V4_SWAP_BUSY_PAGE_LOGS = 2_000
export const V4_SWAP_MAX_PAGES = 3
export const V4_SWAP_MAX_LOGS = 6_000
export const V4_SWAP_DEADLINE_MS = 8_000
export const V4_SWAP_MAX_CALLS = 7
/** Max distance between a trade and the quote-asset USD point used for it. */
export const QUOTE_USD_MAX_GAP_MS = 15 * 60_000
export const V4_EXACT_INTERVAL_SEC = 300
export const V4_INFERRED_INTERVAL_SEC = 900
const RPC_TIMEOUT_MS = 4_000
const OK_TTL_MS = 3 * 60_000
const FAIL_TTL_MS = 60_000
const INIT_TTL_MS = 24 * 3_600_000
const INIT_CACHE_MAX = 500

export type V4SwapGapCode =
  | 'v4_chain_not_supported'
  | 'v4_rpc_unavailable'
  | 'v4_manager_unresolved'
  | 'v4_protocol_unsupported'
  | 'v4_initialize_not_found'
  | 'v4_timestamps_unproven'
  | 'v4_swap_logs_unavailable'
  | 'v4_swap_history_empty'
  | 'quote_usd_price_unproven'
  | 'token_side_unresolved'
  | 'token_identity_unverified'
  | 'call_budget_exhausted'

/** exact_log_timestamps: every log's own time. inferred_block_time: Base's fixed 2s blocks. block_timestamp_lookup: interpolated between real block headers. */
export type V4TimeResolution = 'exact_log_timestamps' | 'inferred_block_time' | 'block_timestamp_lookup'

export type V4SwapCandleResult = {
  ok: boolean
  code: V4SwapGapCode | null
  poolManager: string | null
  /** Chain / protocol / manager evidence for debug. */
  chain: string
  protocol: 'uniswap_v4' | null
  managerSource: string | null
  initializeFound: boolean
  timestampMode: V4TimestampMode | null
  poolId: string
  tokenCurrencyIndex: 0 | 1 | null
  counterAsset: 'eth' | 'bnb' | 'usd_stable' | 'independent_quote' | 'other' | null
  /** How the pool's other asset was priced in USD (null until the pool key is known). */
  quote: {
    asset: string
    symbol: string | null
    source: 'usd_stable' | 'eth_usd_series' | 'bnb_usd_series' | 'independent_pool' | null
    pool: string | null
    pairedWith: string | null
    evidence: 'verified' | 'unavailable'
    points: number
    maxGapMs: number | null
    reason: string | null
    /** Exact-address evidence (debug): decimals, registry classification, which USD lane was tried, its pool and exact failure. */
    decimals?: number | null
    classification?: QuoteClassification | null
    attempt?: QuoteUsdAttempt
    poolProtocol?: string | null
    poolSide?: 'base' | 'quote' | null
    failureReason?: QuoteUsdFailureReason | null
    /** The chain's wrapped native (candidate, proof mode, source, status) and the exact anchors the lane accepted. */
    wrappedNative?: ReturnType<typeof wrappedNativeDebug>
    anchors?: string[]
    /** Discovery (pools returned / anchored / rejected with reasons) and quote-history read diagnostics. */
    discovery?: QuoteDiscoveryDebug | null
    history?: QuoteHistoryDebug | null
    decimalsSource?: 'registry' | 'provider' | 'onchain' | null
  } | null
  logsFound: number
  tradesUsed: number
  /** Swap counts through every stage (debug): raw logs -> exact-PoolId swaps -> timed -> USD-priced -> candles. */
  pipeline: {
    logsReturned: number; exactPoolSwaps: number; timestampValidSwaps: number; usdPricedSwaps: number; candles: number
    /** Swaps whose log carried its own exact block timestamp. */
    exactTimestampSwaps: number
    /** Counter-asset USD lookup per swap: a real point within QUOTE_USD_MAX_GAP_MS / inside the series but too far from any point / outside the series entirely. */
    quoteUsdMatched: number; quoteUsdStale: number; quoteUsdMissing: number
    /** Largest nearest-point distance seen (ms), matched or not. */
    quoteUsdMaxNearestGapMs: number | null
  }
  candles: EvmChartPoint[]
  intervalSec: number
  timeResolution: V4TimeResolution | null
  /** Every call this read made (RPC + CoinGecko), all counted against the caller's budget. */
  callsUsed: number
  rpcCalls: number
  providerCalls: number
  pagesFetched: number
  /** Why paging stopped: 'target_window' (24h covered) | 'log_cap' | 'page_cap' | 'deadline' | 'call_budget' | 'rpc_error' | null (reached pool creation). */
  budgetStopReason: string | null
  cache: { result: boolean; initialize: boolean; ethUsd: boolean }
  /** Window evidence (debug + truthful coverage): exactly which blocks were read and what they covered. */
  window?: V4SwapWindowDebug | null
  /** The newest priced trade behind the latest close (debug: latest-close / MCAP audit). */
  latestTrade?: V4LatestTradeEvidence | null
}

export type V4SwapWindowDebug = {
  latestBlock: number
  latestTs: number
  /** The pool's creation block (its Initialize event). */
  initBlock: number | null
  /** Header-anchored chains: the REAL header ~24h back (nominal block time) used to measure the block rate. */
  anchor: { block: number; ts: number } | null
  /** Seconds per block: protocol-fixed (Base), or measured between two real headers. */
  secPerBlock: number | null
  /** Oldest block the 24h target asks for, and how it was derived. */
  targetBlock: number | null
  targetSource: 'fixed_block_time' | 'real_header' | 'measured_rate' | null
  /** Every Swap-log page read, newest first: inclusive block range + logs returned for the exact PoolId. */
  pages: Array<{ fromBlock: number; toBlock: number; logs: number }>
  oldestSwapTs: number | null
  newestSwapTs: number | null
  /** Seconds of the pool's history this read actually covers (window to the latest header). */
  coveredSec: number | null
  /** Real swap rate over the covered window (exact PoolId swaps per hour); sizes on-demand history pages. */
  swapsPerHour: number | null
}

export type V4LatestTradeEvidence = {
  timestampSec: number
  blockNumber: number
  logIndex: number
  /** Token price in the counter asset from the swap's own sqrtPriceX96. */
  priceInCounter: number
  counterAsset: string | null
  counterSymbol: string | null
  /** Counter-asset USD used for this trade and the real quote point it came from ($1 stablecoin: no point). */
  counterUsd: number
  quotePointMs: number | null
  quoteGapMs: number | null
  priceUsd: number
}

export type V4SwapDeps = {
  rpc: (method: string, params: unknown[], timeoutMs: number) => Promise<{ result: unknown; error: boolean }>
  /** Shared, cached real ETH/USD series covering the swap window ([ms, usd] ascending). */
  ethUsdSeries: (timeoutMs: number) => Promise<{ points: Array<[number, number]> | null; cacheHit: boolean }>
  /** Any chain's native/USD series by CoinGecko coin id (e.g. 'binancecoin'); ETH chains may use ethUsdSeries instead. */
  nativeUsdSeries?: (coinId: string, timeoutMs: number) => Promise<{ points: Array<[number, number]> | null; cacheHit: boolean }>
  /** One-hop independent USD history for any other quote token (lib/server/v4QuoteUsd.ts). Absent => unproven. */
  quoteUsd?: (input: QuoteSelectionInput & { budget: number; deadlineMs: number }) => Promise<QuoteUsdResult>
  now?: () => number
}

const resultCache = new Map<string, { expiresAt: number; value: V4SwapCandleResult }>()
const initCache = new Map<string, { expiresAt: number; key: V4PoolKey; manager: string }>()
const decimalsCache = new Map<string, { expiresAt: number; decimals: number }>()
const headerCache = new Map<string, { expiresAt: number; block: number; ts: number }>()
const historyCache = new Map<string, { expiresAt: number; value: V4HistoryResult }>()
const historyInflight = new Map<string, Promise<V4HistoryResult>>()
const fiveCache = new Map<string, { expiresAt: number; value: V4FiveMinuteResult }>()
const fiveInflight = new Map<string, Promise<V4FiveMinuteResult>>()
export function resetV4SwapCandleCache() {
  densityCache.clear()
  fiveCache.clear()
  fiveInflight.clear()
  resultCache.clear()
  initCache.clear()
  decimalsCache.clear()
  headerCache.clear()
  historyCache.clear()
  historyInflight.clear()
}
const bounded = <K, V>(m: Map<K, V>, max = INIT_CACHE_MAX) => { if (m.size >= max) m.delete(m.keys().next().value!) }

export function makeV4Rpc(chain: string): V4SwapDeps['rpc'] | null {
  const cfg = V4_SWAP_CHAIN_CONFIG[chain]
  const url = cfg?.rpcUrl()
  if (!cfg || !url) return null
  return async (method, params, timeoutMs) => {
    logRpcCall({ route: 'v4SwapCandles', chain, method })
    if (url.includes('g.alchemy.com')) auditGlobalAlchemyCall(method, { chain, route: 'v4SwapCandles' })
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(Math.max(1, timeoutMs)) })
      if (!res.ok) return { result: null, error: true }
      const json = await res.json() as { result?: unknown; error?: unknown }
      return json.error || json.result === undefined ? { result: null, error: true } : { result: json.result, error: false }
    } catch {
      return { result: null, error: true }
    }
  }
}

const toHex = (n: number) => `0x${Math.max(0, Math.floor(n)).toString(16)}`

export async function loadV4SwapCandles(
  input: {
    chain: string; poolId: string; token: string; tokenDecimals: number; livePriceUsd: number | null; dexHint?: string | null
    /**
     * On-demand 5M read (loadV4SwapFiveMinuteWindow) only: never reads or writes the SCAN result cache, and
     * token identity rests on the pool's own Initialize (the scanned token must be currency0 / currency1 of
     * exactly this PoolId) — the same proof the on-demand history lane uses — since no live price is passed.
     */
    onDemand?: boolean
    /** On-demand only: the exact-timestamp bucket width (60 = 1M, default 300 = 5M). Non-exact series stay 15M. */
    exactIntervalSec?: 60 | 300
  },
  deps: V4SwapDeps,
  /** Calls still allowed on the whole candle path; this read never exceeds min(budget, V4_SWAP_MAX_CALLS). */
  budget: number = V4_SWAP_MAX_CALLS,
): Promise<V4SwapCandleResult> {
  const now = deps.now ?? Date.now
  const poolId = input.poolId.toLowerCase()
  const token = input.token.toLowerCase()
  const cfg = V4_SWAP_CHAIN_CONFIG[input.chain]
  const r: V4SwapCandleResult = {
    ok: false, code: null, poolManager: cfg?.poolManager ?? null, chain: input.chain, protocol: null, managerSource: null, initializeFound: false, timestampMode: cfg?.timestampMode ?? null,
    poolId, tokenCurrencyIndex: null, counterAsset: null, quote: null, logsFound: 0, tradesUsed: 0,
    pipeline: { logsReturned: 0, exactPoolSwaps: 0, timestampValidSwaps: 0, usdPricedSwaps: 0, candles: 0, exactTimestampSwaps: 0, quoteUsdMatched: 0, quoteUsdStale: 0, quoteUsdMissing: 0, quoteUsdMaxNearestGapMs: null },
    candles: [], intervalSec: V4_EXACT_INTERVAL_SEC, timeResolution: null, callsUsed: 0, rpcCalls: 0, providerCalls: 0, pagesFetched: 0,
    budgetStopReason: null, cache: { result: false, initialize: false, ethUsd: false },
  }
  const gap = (code: V4SwapGapCode): V4SwapCandleResult => ({ ...r, ok: false, code })
  if (!cfg) return gap('v4_chain_not_supported')
  if (cfg.managers.length === 0) return gap('v4_manager_unresolved')
  if (!v4ProtocolSupported(input.chain, input.dexHint)) return gap('v4_protocol_unsupported')
  if (!/^0x[a-f0-9]{64}$/.test(poolId) || !/^0x[a-f0-9]{40}$/.test(token)) return gap('token_side_unresolved')

  // The scan's own resolved decimals are remembered so an on-demand history request needs no extra read.
  if (Number.isInteger(input.tokenDecimals) && input.tokenDecimals >= 0 && input.tokenDecimals <= 36) {
    bounded(decimalsCache)
    decimalsCache.set(`${input.chain}:${token}`, { expiresAt: now() + INIT_TTL_MS, decimals: input.tokenDecimals })
  }
  const cacheKey = `${input.chain}:${poolId}:${token}`
  const hit = input.onDemand ? undefined : resultCache.get(cacheKey)
  if (hit && hit.expiresAt > now()) return { ...hit.value, callsUsed: 0, rpcCalls: 0, providerCalls: 0, pagesFetched: 0, cache: { ...hit.value.cache, result: true } }
  const done = (v: V4SwapCandleResult) => {
    // A budget stop says nothing about the pool itself — never cache it. On-demand reads cache on their own.
    if (v.code !== 'call_budget_exhausted' && !input.onDemand) resultCache.set(cacheKey, { expiresAt: now() + (v.ok ? OK_TTL_MS : FAIL_TTL_MS), value: v })
    return v
  }
  const cap = Math.min(budget, V4_SWAP_MAX_CALLS)
  const deadline = now() + V4_SWAP_DEADLINE_MS
  const canCall = (): boolean => {
    if (r.callsUsed >= cap) { r.budgetStopReason = 'call_budget'; return false }
    if (now() >= deadline) { r.budgetStopReason = 'deadline'; return false }
    return true
  }
  const rpc = async (method: string, params: unknown[]) => {
    r.callsUsed++
    r.rpcCalls++
    return deps.rpc(method, params, Math.min(RPC_TIMEOUT_MS, Math.max(1, deadline - now())))
  }

  // 1. Latest block number + real timestamp.
  if (!canCall()) return gap('call_budget_exhausted')
  const latestRes = await rpc('eth_getBlockByNumber', ['latest', false])
  const latest = latestRes.result as { number?: string; timestamp?: string } | null
  const latestBlock = latest?.number ? Number(BigInt(latest.number)) : null
  const latestTs = latest?.timestamp ? Number(BigInt(latest.timestamp)) : null
  if (latestRes.error || latestBlock == null || latestTs == null) { r.budgetStopReason = 'rpc_error'; return done(gap('v4_swap_logs_unavailable')) }
  const win: V4SwapWindowDebug = { latestBlock, latestTs, initBlock: null, anchor: null, secPerBlock: cfg.timestampMode === 'fixed_block_time' ? cfg.blockTimeSec : null, targetBlock: null, targetSource: null, pages: [], oldestSwapTs: null, newestSwapTs: null, coveredSec: null, swapsPerHour: null }
  r.window = win

  // 2. The pool's own Initialize event on a configured manager (immutable: cached 24h per PoolId).
  const init = await readPoolInitialize(input.chain, cfg, poolId, latestBlock, now, canCall, rpc)
  if (init.kind !== 'ok') {
    if (init.kind === 'budget') return gap('call_budget_exhausted')
    if (init.kind === 'rpc_error') { r.budgetStopReason = 'rpc_error'; return done(gap('v4_swap_logs_unavailable')) }
    return done(gap('v4_initialize_not_found'))
  }
  r.cache.initialize = init.cached
  const key = init.key
  const manager = init.manager
  r.poolManager = manager
  r.protocol = 'uniswap_v4'
  r.managerSource = cfg.managers.find((m) => m.address === manager)?.source ?? null
  r.initializeFound = true
  win.initBlock = key.initBlock
  const tokenIsCurrency0 = key.currency0 === token
  if (!tokenIsCurrency0 && key.currency1 !== token) return done(gap('token_side_unresolved'))
  r.tokenCurrencyIndex = tokenIsCurrency0 ? 0 : 1
  const counter = tokenIsCurrency0 ? key.currency1 : key.currency0
  const counterEthDec: number | undefined = cfg.nativeLike[counter]
  const counterUsdDec = cfg.usdStable[counter]
  const classification = classifyQuoteAsset(input.chain, counter)
  const lane = quoteLaneSelection(input.chain)
  const nativeKind: 'eth' | 'bnb' = cfg.native.symbol === 'BNB' ? 'bnb' : 'eth'
  const isNative = counterEthDec != null
  r.counterAsset = isNative ? nativeKind : counterUsdDec != null ? 'usd_stable' : 'other'
  const attempt: QuoteUsdAttempt = isNative ? 'native_usd' : counterUsdDec != null ? 'stable_usd' : deps.quoteUsd && classification === 'arbitrary_quote' ? 'independent_quote_pool' : 'none'
  r.quote = {
    asset: counter, symbol: isNative ? cfg.native.symbol : null, source: isNative ? (nativeKind === 'bnb' ? 'bnb_usd_series' : 'eth_usd_series') : counterUsdDec != null ? 'usd_stable' : null, pool: null, pairedWith: null, evidence: counterUsdDec != null ? 'verified' : 'unavailable', points: 0, maxGapMs: null, reason: null,
    decimals: (counterEthDec ?? counterUsdDec) ?? null, classification, attempt, poolProtocol: null, poolSide: null, failureReason: null,
    wrappedNative: wrappedNativeDebug(input.chain), anchors: [...lane.anchors], discovery: null, history: null, decimalsSource: counterEthDec != null || counterUsdDec != null ? 'registry' : null,
  }

  // 2a. Chains without a fixed block interval: one REAL block header ~24h back anchors the window
  // (and, when logs carry no timestamps, the interpolation between real headers).
  let anchor: { block: number; ts: number } | null = null
  if (cfg.timestampMode !== 'fixed_block_time') {
    const windowBlocks = Math.ceil(V4_SWAP_TARGET_WINDOW_SEC / cfg.nominalBlockSec)
    const anchorBlock = Math.max(key.initBlock, latestBlock - windowBlocks + 1)
    if (anchorBlock >= latestBlock) anchor = { block: latestBlock, ts: latestTs }
    else {
      if (!canCall()) return gap('call_budget_exhausted')
      const h = await rpc('eth_getBlockByNumber', [toHex(anchorBlock), false])
      const hb = h.result as { number?: string; timestamp?: string } | null
      if (h.error || !hb?.timestamp) { r.budgetStopReason = 'rpc_error'; return done(gap('v4_swap_logs_unavailable')) }
      anchor = { block: anchorBlock, ts: Number(BigInt(hb.timestamp)) }
    }
  }

  // 3. Swap logs for exactly this PoolId, newest page first, never before creation, back to 24h.
  const swaps: Array<V4Swap & { logTimestamp: number | null }> = []
  // Window + page plan: Base keeps its fixed 4h/8h/12h block pages; header-anchored chains split the
  // real ~24h block span (measured between two real headers) into the same 1/6, 1/3, 1/2 time shares.
  let targetBlock: number
  let pagePlan: ReadonlyArray<number>
  if (!anchor) {
    targetBlock = latestBlock - Math.floor(V4_SWAP_TARGET_WINDOW_SEC / cfg.blockTimeSec) + 1
    pagePlan = V4_SWAP_PAGE_PLAN
    win.targetSource = 'fixed_block_time'
  } else {
    const spanBlocks = latestBlock - anchor.block
    const spanSec = latestTs - anchor.ts
    const measured = spanBlocks > 0 && spanSec > 0 ? spanSec / spanBlocks : null
    win.anchor = anchor
    win.secPerBlock = measured
    if (measured != null && spanSec > V4_SWAP_TARGET_WINDOW_SEC) {
      // Chain slower than the planning estimate: keep only the newest ~24h of blocks (measured rate).
      targetBlock = latestBlock - Math.floor(V4_SWAP_TARGET_WINDOW_SEC / measured) + 1
      win.targetSource = 'measured_rate'
    } else if (measured != null && spanSec < V4_SWAP_TARGET_WINDOW_SEC && anchor.block > key.initBlock && cfg.timestampMode === 'log_timestamp_only') {
      // Chain FASTER than the planning estimate (e.g. Robinhood producing blocks quicker than the nominal
      // 0.25s): the nominal window spans less than 24h, so extend it by the measured rate. Only on chains
      // whose candles use each log's own timestamp (never an extrapolated time). No extra call.
      targetBlock = Math.max(key.initBlock, latestBlock - Math.floor(V4_SWAP_TARGET_WINDOW_SEC / measured) + 1)
      win.targetSource = 'measured_rate'
    } else {
      targetBlock = anchor.block
      win.targetSource = 'real_header'
    }
    const total = latestBlock - targetBlock + 1
    const p1 = Math.max(1, Math.ceil(total / 6))
    const p2 = Math.max(1, Math.ceil(total / 3))
    pagePlan = [p1, p2, Math.max(1, total - p1 - p2)]
  }
  const busyPageBlocks = pagePlan[0]
  win.targetBlock = targetBlock
  let toBlock = latestBlock
  let busy = false
  let capped = false
  // Newest-first page reader (bounded by V4_SWAP_MAX_PAGES, the log cap, the budget and the deadline).
  const readPages = async (maxPages: number) => {
    while (toBlock >= key.initBlock) {
      if (toBlock < targetBlock) { r.budgetStopReason = 'target_window'; break }
      if (capped) { r.budgetStopReason = 'log_cap'; break }
      if (r.pagesFetched >= Math.min(maxPages, V4_SWAP_MAX_PAGES)) { r.budgetStopReason = 'page_cap'; break }
      // Keep one call in hand for the native/USD series (it may not be cached yet).
      if (isNative && r.callsUsed >= cap - 1) { r.budgetStopReason = 'call_budget'; break }
      if (!canCall()) break
      const size = busy ? busyPageBlocks : pagePlan[r.pagesFetched] ?? busyPageBlocks
      const fromBlock = Math.max(key.initBlock, targetBlock, toBlock - size + 1)
      r.pagesFetched++
      const page = await rpc('eth_getLogs', [{ address: manager, topics: [V4_SWAP_TOPIC0, poolId], fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }])
      if (page.error || !Array.isArray(page.result)) { r.budgetStopReason = 'rpc_error'; break }
      r.pipeline.logsReturned += page.result.length
      const decoded = decodePageNewestFirst(page.result as RawEvmLog[], poolId, manager)
      win.pages.push({ fromBlock, toBlock, logs: decoded.length })
      if (decoded.length >= V4_SWAP_BUSY_PAGE_LOGS) busy = true
      for (const s of decoded) {
        if (swaps.length >= V4_SWAP_MAX_LOGS) { capped = true; break }
        swaps.push({ ...s, logTimestamp: s.blockTimestamp })
      }
      toBlock = fromBlock - 1
    }
    if (!r.budgetStopReason && capped) r.budgetStopReason = 'log_cap'
  }
  // A quote-USD failure must not mask what the pool's own swaps show: read ONE newest swap page (bounded,
  // only on this failure path) so debug reports real swap / timestamp counts, and a chain whose logs carry
  // no exact timestamps reports that (the blocker that would remain even with a proven quote).
  const finishQuoteFailure = async (): Promise<V4SwapCandleResult> => {
    if (swaps.length === 0 && canCall()) await readPages(1)
    r.logsFound = swaps.length
    r.pipeline.exactPoolSwaps = swaps.length
    const exactCount = swaps.filter((x) => x.logTimestamp != null).length
    r.pipeline.exactTimestampSwaps = exactCount
    r.pipeline.timestampValidSwaps = cfg.timestampMode === 'log_timestamp_only' ? exactCount : swaps.length
    if (swaps.length > 0 && exactCount < swaps.length && cfg.timestampMode === 'log_timestamp_only') return done(gap('v4_timestamps_unproven'))
    return done(gap('quote_usd_price_unproven'))
  }

  // 2b. Any other quote token: resolve its independent USD history FIRST (fail fast, before paging),
  // always leaving at least one call for a swap-log page.
  let quotePoints: Array<[number, number]> | null = null
  let counterDecimals = (counterEthDec ?? counterUsdDec) ?? null
  if (r.counterAsset === 'other') {
    const unproven = (reason: string, failureReason: QuoteUsdFailureReason) => { r.quote = { ...r.quote!, evidence: 'unavailable', reason, failureReason }; return finishQuoteFailure() }
    if (!deps.quoteUsd) return unproven('no_independent_quote_source', 'quote_usd_price_unproven')
    const q = await deps.quoteUsd({
      quoteToken: counter,
      scannedToken: token,
      excludePool: poolId,
      ...lane,
      budget: Math.max(0, cap - r.callsUsed - 1),
      deadlineMs: deadline,
    })
    r.callsUsed += q.callsUsed
    r.providerCalls += q.callsUsed
    r.quote = { ...r.quote!, symbol: q.quoteSymbol, source: 'independent_pool', pool: q.pool, pairedWith: q.pairedWith, points: q.points.length, reason: q.detail, decimals: q.quoteDecimals, poolProtocol: q.poolDex ?? null, poolSide: q.poolSide ?? null, discovery: q.discovery ?? null, history: q.history ?? null, decimalsSource: q.quoteDecimals != null ? 'provider' : null }
    if (q.reason === 'call_budget_exhausted') { r.budgetStopReason = 'call_budget'; return gap('call_budget_exhausted') }
    if (!q.ok) return unproven(q.detail ?? 'quote_usd_price_unproven', explainQuoteFailure(q))
    // The provider carried no decimals for the quote token: its own decimals() on-chain (cached 24h), else unproven.
    let qDec = q.quoteDecimals
    if (qDec == null) {
      if (!canCall()) return gap('call_budget_exhausted')
      qDec = await readTokenDecimals(input.chain, counter, rpc, now)
      if (qDec == null) return unproven('quote_decimals_unavailable', 'quote_asset_unverified')
      r.quote = { ...r.quote!, decimals: qDec, decimalsSource: 'onchain' }
    }
    r.counterAsset = 'independent_quote'
    counterDecimals = qDec
    quotePoints = q.points
  }
  if (counterDecimals == null) { r.quote = { ...r.quote!, failureReason: 'quote_asset_unverified' }; return finishQuoteFailure() }
  const decimals0 = tokenIsCurrency0 ? input.tokenDecimals : counterDecimals
  const decimals1 = tokenIsCurrency0 ? counterDecimals : input.tokenDecimals

  await readPages(V4_SWAP_MAX_PAGES)

  r.logsFound = swaps.length
  r.pipeline.exactPoolSwaps = swaps.length
  if (swaps.length === 0) {
    if (r.budgetStopReason === 'rpc_error' || r.budgetStopReason === 'deadline') return done(gap('v4_swap_logs_unavailable'))
    if (r.budgetStopReason === 'call_budget') return gap('call_budget_exhausted')
    return done(gap('v4_swap_history_empty'))
  }

  // Exact times only if every swap log carries its own block timestamp. Otherwise: Base infers from its
  // fixed 2s blocks; header-anchored chains interpolate between two REAL headers; a chain whose block
  // timing is not proven (log_timestamp_only) stops here. Any non-exact series is bucketed at 15m.
  const exact = swaps.every((s) => s.logTimestamp != null)
  r.pipeline.exactTimestampSwaps = swaps.filter((s) => s.logTimestamp != null).length
  if (!exact && cfg.timestampMode === 'log_timestamp_only') return done(gap('v4_timestamps_unproven'))
  r.timeResolution = exact ? 'exact_log_timestamps' : anchor ? 'block_timestamp_lookup' : 'inferred_block_time'
  r.intervalSec = exact ? (input.exactIntervalSec ?? V4_EXACT_INTERVAL_SEC) : V4_INFERRED_INTERVAL_SEC
  const inferTs = anchor
    ? interpolateBlockTime([anchor, { block: latestBlock, ts: latestTs }])
    : (b: number) => latestTs - (latestBlock - b) * cfg.blockTimeSec
  let timed = swaps.map((s) => ({ ...s, timestampSec: exact ? s.logTimestamp! : inferTs(s.blockNumber) }))
  // Log cap hit: the oldest kept bucket may be missing earlier trades — drop it rather than show a partial candle.
  if (capped) timed = dropOldestBucket(timed, r.intervalSec)
  r.pipeline.timestampValidSwaps = timed.filter((s) => Number.isFinite(s.timestampSec) && s.timestampSec > 0).length
  // Truthful coverage: the target window when it was read in full, else back to the oldest kept trade
  // (log cap / page cap / budget / deadline / RPC error) — never a claimed 24h.
  if (timed.length > 0) {
    const tss = timed.map((s) => s.timestampSec)
    win.oldestSwapTs = Math.min(...tss)
    win.newestSwapTs = Math.max(...tss)
  }
  const blockTimeAt = (b: number): number | null => anchor
    ? (win.secPerBlock != null ? latestTs - (latestBlock - b) * win.secPerBlock : null)
    : latestTs - (latestBlock - b) * cfg.blockTimeSec
  const reachedCreation = !capped && toBlock < key.initBlock
  if (r.budgetStopReason === 'target_window' || reachedCreation) {
    const from = reachedCreation ? key.initBlock : targetBlock
    const t0 = win.targetSource === 'real_header' && anchor && from === anchor.block ? anchor.ts : blockTimeAt(from)
    win.coveredSec = t0 != null ? Math.max(0, latestTs - t0) : null
  } else if (win.oldestSwapTs != null) {
    // Partial window: only from the oldest kept bucket boundary (the partial oldest bucket was dropped on a cap).
    win.coveredSec = Math.max(0, latestTs - Math.floor(win.oldestSwapTs / r.intervalSec) * r.intervalSec)
  }
  if (win.coveredSec != null && win.coveredSec > 0) win.swapsPerHour = Math.round((timed.length / win.coveredSec) * 3600)
  rememberSwapDensity(input.chain, poolId, win, now)

  // 4. Counter-asset USD: $1 stablecoin, the shared cached ETH/USD series, or the independent quote
  // pool's own history. Each trade uses the closest real point within 15 minutes, or is dropped.
  let maxGapMs = 0
  const fromSeries = (series: ReadonlyArray<readonly [number, number]>) => (tsMs: number) => {
    // Per-swap evidence accounting: missing = the series does not cover this time at all; stale = covered,
    // but no real point within QUOTE_USD_MAX_GAP_MS. Neither is ever filled with another price.
    const nearest = nearestPriceWithGap(series, tsMs, Number.POSITIVE_INFINITY)
    if (nearest) r.pipeline.quoteUsdMaxNearestGapMs = Math.max(r.pipeline.quoteUsdMaxNearestGapMs ?? 0, nearest.gapMs)
    const hit = nearestPriceWithGap(series, tsMs, QUOTE_USD_MAX_GAP_MS)
    if (!hit) {
      const outside = series.length === 0 || tsMs < series[0][0] - QUOTE_USD_MAX_GAP_MS || tsMs > series[series.length - 1][0] + QUOTE_USD_MAX_GAP_MS
      if (outside) r.pipeline.quoteUsdMissing++
      else r.pipeline.quoteUsdStale++
      return null
    }
    r.pipeline.quoteUsdMatched++
    maxGapMs = Math.max(maxGapMs, hit.gapMs)
    return hit.price
  }
  let auditSeries: ReadonlyArray<readonly [number, number]> | null = null
  let counterUsdAt: (tsMs: number) => number | null = () => { r.pipeline.quoteUsdMatched++; return 1 } // verified $1 stable
  if (isNative) {
    if (now() >= deadline) { r.budgetStopReason = 'deadline'; r.quote = { ...r.quote!, failureReason: 'quote_usd_price_unproven' }; return done(gap('quote_usd_price_unproven')) }
    const seriesFn = cfg.native.coinId === 'ethereum' ? deps.ethUsdSeries : deps.nativeUsdSeries ? (t: number) => deps.nativeUsdSeries!(cfg.native.coinId, t) : null
    if (!seriesFn) { r.quote = { ...r.quote!, evidence: 'unavailable', reason: `${cfg.native.coinId}_usd_series_unavailable`, failureReason: 'quote_history_unavailable' }; return done(gap('quote_usd_price_unproven')) }
    const eth = await seriesFn(Math.max(1, deadline - now()))
    r.cache.ethUsd = eth.cacheHit
    if (!eth.cacheHit) { r.callsUsed++; r.providerCalls++ }
    if (!eth.points || eth.points.length === 0) { r.quote = { ...r.quote!, evidence: 'unavailable', reason: `${cfg.native.coinId === 'ethereum' ? 'eth' : cfg.native.coinId}_usd_series_unavailable`, failureReason: 'quote_history_unavailable' }; return done(gap('quote_usd_price_unproven')) }
    r.quote = { ...r.quote!, evidence: 'verified', points: eth.points.length }
    auditSeries = eth.points
    counterUsdAt = fromSeries(eth.points)
  } else if (quotePoints) {
    r.quote = { ...r.quote!, evidence: 'verified' }
    auditSeries = quotePoints
    counterUsdAt = fromSeries(quotePoints)
  }

  // 5. Real-trade OHLCV; at least 2 real buckets; identity checked against the live price.
  const built = buildV4SwapCandles({ swaps: timed, tokenIsCurrency0, decimals0, decimals1, counterUsdAt, intervalSec: r.intervalSec })
  r.tradesUsed = built.tradesUsed
  r.pipeline.usdPricedSwaps = built.tradesUsed
  r.pipeline.candles = built.candles.length
  r.quote = { ...r.quote!, maxGapMs: r.counterAsset === 'usd_stable' ? null : maxGapMs }
  if (built.tradesUsed === 0 && r.counterAsset !== 'usd_stable') { r.quote = { ...r.quote!, evidence: 'unavailable', reason: 'no_quote_usd_point_within_15m_of_any_trade', failureReason: 'quote_history_stale' }; return done(gap('quote_usd_price_unproven')) }
  r.latestTrade = latestTradeEvidence(timed, { tokenIsCurrency0, decimals0, decimals1, counterAsset: counter, counterSymbol: r.quote?.symbol ?? null, series: auditSeries })
  if (built.candles.length < 2) return done(gap('v4_swap_history_empty'))
  if (!input.onDemand && !closeMatchesLivePrice(built.candles, input.livePriceUsd)) return done(gap('token_identity_unverified'))
  return done({ ...r, ok: true, code: null, candles: built.candles })
}

/** A page's swaps for exactly this PoolId on exactly this manager, newest first, reorged logs ignored. */
function decodePageNewestFirst(logs: ReadonlyArray<RawEvmLog>, poolId: string, manager?: string): V4Swap[] {
  const out: V4Swap[] = []
  for (const log of logs) {
    if (log.removed === true) continue
    if (manager && typeof log.address === 'string' && log.address.toLowerCase() !== manager) continue
    const s = decodeV4Swap(log, poolId)
    if (s) out.push(s)
  }
  return out.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
}

/** The newest trade that can be priced, with the exact quote point it used (same 15-minute rule as the candles). */
function latestTradeEvidence(
  timed: ReadonlyArray<V4Swap & { timestampSec: number }>,
  o: { tokenIsCurrency0: boolean; decimals0: number; decimals1: number; counterAsset: string; counterSymbol: string | null; series: ReadonlyArray<readonly [number, number]> | null },
): V4LatestTradeEvidence | null {
  const newestFirst = [...timed].sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
  for (const s of newestFirst) {
    const inCounter = v4TokenPriceInCounter(s.sqrtPriceX96, o.tokenIsCurrency0, o.decimals0, o.decimals1)
    if (inCounter == null) continue
    const hit = o.series ? nearestPriceWithGap(o.series, s.timestampSec * 1000, QUOTE_USD_MAX_GAP_MS) : { price: 1, gapMs: 0 }
    if (!hit) continue
    const nearestPoint = o.series ? o.series.reduce((best, p) => (Math.abs(p[0] - s.timestampSec * 1000) < Math.abs(best[0] - s.timestampSec * 1000) ? p : best), o.series[0]) : null
    return {
      timestampSec: s.timestampSec, blockNumber: s.blockNumber, logIndex: s.logIndex, priceInCounter: inCounter,
      counterAsset: o.counterAsset, counterSymbol: o.counterSymbol, counterUsd: hit.price,
      quotePointMs: nearestPoint ? nearestPoint[0] : null, quoteGapMs: o.series ? hit.gapMs : null, priceUsd: inCounter * hit.price,
    }
  }
  return null
}

// Real swap density per pool (logs per block), remembered from a completed read so an on-demand history
// request can size its pages to the pool's activity instead of pulling a 24h page of a busy pool.
const densityCache = new Map<string, { expiresAt: number; logsPerBlock: number }>()
function rememberSwapDensity(chain: string, poolId: string, win: V4SwapWindowDebug, now: () => number) {
  const blocks = win.pages.reduce((n, p) => n + (p.toBlock - p.fromBlock + 1), 0)
  const logs = win.pages.reduce((n, p) => n + p.logs, 0)
  if (blocks <= 0 || logs <= 0) return
  bounded(densityCache)
  densityCache.set(`${chain}:${poolId}`, { expiresAt: now() + HISTORY_OK_TTL_MS, logsPerBlock: logs / blocks })
}

function dropOldestBucket<T extends { timestampSec: number }>(timed: ReadonlyArray<T>, intervalSec: number): T[] {
  if (timed.length === 0) return []
  const oldest = Math.min(...timed.map((s) => Math.floor(s.timestampSec / intervalSec)))
  return timed.filter((s) => Math.floor(s.timestampSec / intervalSec) !== oldest)
}

// ── On-demand history window ─────────────────────────────────────────────────────────────────────

export const V4_HISTORY_INTERVAL_SEC = 3600
export const V4_HISTORY_FIRST_PAGE_BLOCKS = 43_200 // 24h
export const V4_HISTORY_MIN_PAGE_BLOCKS = 7_200 // 4h
export const V4_HISTORY_MAX_PAGE_BLOCKS = 172_800 // 4 days
export const V4_HISTORY_MAX_PAGES = 3
// Kept logs per history request. Pages are sized to the pool's REAL swap density (~V4_HISTORY_TARGET_PAGE_LOGS
// each, below common 10k-log node response limits), so a busy pool no longer downloads a 24h page (~36k logs at
// 1,500 swaps/h) to keep 6,000: 3 density-sized pages keep up to 15,000 genuine swaps with less transfer.
export const V4_HISTORY_MAX_LOGS = 15_000
export const V4_HISTORY_TARGET_PAGE_LOGS = 5_000
export const V4_HISTORY_MAX_CALLS = 8
export const V4_HISTORY_DEADLINE_MS = 9_000
/** Oldest cursor accepted — bounds how far interactive paging can crawl. */
export const V4_HISTORY_MAX_AGE_SEC = 180 * 86_400
/** Hourly candles priced from hourly quote points: each trade within 45 minutes of a real point, or dropped. */
export const V4_HISTORY_QUOTE_MAX_GAP_MS = 45 * 60_000
const HISTORY_OK_TTL_MS = 15 * 60_000
const HISTORY_FAIL_TTL_MS = 60_000
const HEADER_TTL_MS = 30_000
const QUIET_PAGE_LOGS = 1_500
const BUSY_PAGE_LOGS = 4_000
const DECIMALS_SELECTOR = '0x313ce567'

/** An ERC-20's own decimals() (one eth_call; cached 24h per chain + token, shared by scan and history). */
async function readTokenDecimals(chain: string, token: string, rpc: (method: string, params: unknown[]) => Promise<{ result: unknown; error: boolean }>, now: () => number): Promise<number | null> {
  const hit = decimalsCache.get(`${chain}:${token}`)
  if (hit && hit.expiresAt > now()) return hit.decimals
  const res = await rpc('eth_call', [{ to: token, data: DECIMALS_SELECTOR }, 'latest'])
  const v = typeof res.result === 'string' && /^0x[0-9a-f]+$/i.test(res.result) ? Number(BigInt(res.result)) : null
  if (res.error || v == null || !Number.isInteger(v) || v < 0 || v > 36) return null
  bounded(decimalsCache)
  decimalsCache.set(`${chain}:${token}`, { expiresAt: now() + INIT_TTL_MS, decimals: v })
  return v
}

export type V4HistoryResult = {
  ok: boolean
  code: V4SwapGapCode | 'invalid_request' | null
  poolId: string
  intervalSec: number
  /** Genuine hourly swap candles strictly before `windowEndSec`, ascending. Hours with no trade are absent. */
  candles: EvmChartPoint[]
  /** Older swaps may exist before `nextBeforeSec` (false once the pool's creation block is reached). */
  hasMore: boolean
  /** Cursor for the next (older) request: every block from here up to windowEndSec was read. */
  nextBeforeSec: number | null
  windowEndSec: number
  timeResolution: V4TimeResolution | null
  logsFound: number
  tradesUsed: number
  callsUsed: number
  pagesFetched: number
  stopReason: string | null
  /** Why no older window remains (evidence, never a short page): the pool's creation, or the max-age bound. */
  endReason?: 'reached_pool_creation' | 'max_history_age' | null
  quote: { source: 'usd_stable' | 'eth_usd_series' | 'bnb_usd_series' | 'independent_pool' | null; evidence: 'verified' | 'unavailable'; maxGapMs: number | null; reason: string | null } | null
  cache: { result: boolean; header: boolean; initialize: boolean; decimals: boolean; quote: boolean }
}

export type V4HistoryDeps = {
  rpc: V4SwapDeps['rpc']
  /** Real ETH/USD over [fromSec, toSec] (hourly), cached per window. */
  ethUsdRange?: (fromSec: number, toSec: number, timeoutMs: number) => Promise<{ points: Array<[number, number]> | null; cacheHit: boolean }>
  /** Real <coinId>/USD over [fromSec, toSec] for non-ETH natives (e.g. 'binancecoin'), cached per window. */
  nativeUsdRange?: (coinId: string, fromSec: number, toSec: number, timeoutMs: number) => Promise<{ points: Array<[number, number]> | null; cacheHit: boolean }>
  /** The quote token's independent-pool USD history over [fromSec, toSec] (lib/server/v4QuoteUsd.ts resolveIndependentQuoteUsdWindow). */
  quoteUsdWindow?: (input: QuoteSelectionInput & { fromSec: number; toSec: number; budget: number; deadlineMs: number }) => Promise<QuoteUsdResult>
  now?: () => number
}

/**
 * Older hourly candles for exactly this V4 PoolId, strictly before `beforeSec`. Only ever called from
 * the interactive chart-candles endpoint — never during a scan. Bounded: <= 3 log pages, <= 6,000 logs,
 * <= 8 calls, 9s; cached per (pool, token, hour-aligned cursor); concurrent identical requests share one read.
 */
export async function loadV4SwapHistoryWindow(
  input: { chain: string; poolId: string; token: string; beforeSec: number; /** The scan's real swap rate (coverage.swapsPerHour) — a page-size hint only. */ swapsPerHourHint?: number | null },
  deps: V4HistoryDeps,
): Promise<V4HistoryResult> {
  const now = deps.now ?? Date.now
  const poolId = String(input.poolId ?? '').toLowerCase()
  const token = String(input.token ?? '').toLowerCase()
  const beforeSec = Math.floor(Number(input.beforeSec) / 3600) * 3600
  const base: V4HistoryResult = {
    ok: false, code: null, poolId, intervalSec: V4_HISTORY_INTERVAL_SEC, candles: [], hasMore: true, nextBeforeSec: null, windowEndSec: beforeSec,
    timeResolution: null, logsFound: 0, tradesUsed: 0, callsUsed: 0, pagesFetched: 0, stopReason: null, quote: null,
    cache: { result: false, header: false, initialize: false, decimals: false, quote: false },
  }
  const cfg = V4_SWAP_CHAIN_CONFIG[input.chain]
  if (!cfg) return { ...base, code: 'v4_chain_not_supported', hasMore: false }
  const nowSec = Math.floor(now() / 1000)
  if (!/^0x[a-f0-9]{64}$/.test(poolId) || !/^0x[a-f0-9]{40}$/.test(token) || !Number.isFinite(beforeSec) || beforeSec > nowSec + 3600 || beforeSec < nowSec - V4_HISTORY_MAX_AGE_SEC) {
    return { ...base, code: 'invalid_request', hasMore: false }
  }
  const key = `${input.chain}:${poolId}:${token}:${beforeSec}`
  const hit = historyCache.get(key)
  if (hit && hit.expiresAt > now()) return { ...hit.value, callsUsed: 0, pagesFetched: 0, cache: { ...hit.value.cache, result: true } }
  const running = historyInflight.get(key)
  if (running) return running
  const hint = Number(input.swapsPerHourHint)
  const p = readHistoryWindow({ chain: input.chain, poolId, token, beforeSec, swapsPerHourHint: Number.isFinite(hint) && hint > 0 && hint <= 1_000_000 ? hint : null }, cfg, base, deps, now).then((v) => {
    if (v.code !== 'call_budget_exhausted') {
      bounded(historyCache)
      historyCache.set(key, { expiresAt: now() + (v.ok ? HISTORY_OK_TTL_MS : HISTORY_FAIL_TTL_MS), value: v })
    }
    return v
  }).finally(() => historyInflight.delete(key))
  historyInflight.set(key, p)
  return p
}

async function readHistoryWindow(
  input: { chain: string; poolId: string; token: string; beforeSec: number; swapsPerHourHint: number | null },
  cfg: V4ChainConfig,
  base: V4HistoryResult,
  deps: V4HistoryDeps,
  now: () => number,
): Promise<V4HistoryResult> {
  const { poolId, token, beforeSec } = input
  const r: V4HistoryResult = { ...base, cache: { ...base.cache } }
  const fail = (code: V4SwapGapCode, stopReason: string | null = r.stopReason): V4HistoryResult => ({ ...r, ok: false, code, stopReason })
  const deadline = now() + V4_HISTORY_DEADLINE_MS
  const canCall = (reserve = 0): boolean => {
    if (r.callsUsed + reserve >= V4_HISTORY_MAX_CALLS) { r.stopReason = 'call_budget'; return false }
    if (now() >= deadline) { r.stopReason = 'deadline'; return false }
    return true
  }
  const rpc = async (method: string, params: unknown[]) => {
    r.callsUsed++
    return deps.rpc(method, params, Math.min(RPC_TIMEOUT_MS + 1_000, Math.max(1, deadline - now())))
  }

  // 1. Latest block + real timestamp (shared 30s per chain): maps the time cursor onto Base's fixed 2s blocks.
  let header = headerCache.get(input.chain)
  if (header && header.expiresAt > now()) r.cache.header = true
  else {
    if (!canCall()) return fail('call_budget_exhausted')
    const res = await rpc('eth_getBlockByNumber', ['latest', false])
    const b = res.result as { number?: string; timestamp?: string } | null
    if (res.error || !b?.number || !b?.timestamp) return fail('v4_swap_logs_unavailable', 'rpc_error')
    header = { expiresAt: now() + HEADER_TTL_MS, block: Number(BigInt(b.number)), ts: Number(BigInt(b.timestamp)) }
    headerCache.set(input.chain, header)
  }
  const fixedTime = cfg.timestampMode === 'fixed_block_time'
  const blockTsFixed = (block: number) => header!.ts - (header!.block - block) * cfg.blockTimeSec

  // 2. Pool key from its own Initialize event on a configured manager (shared 24h cache with the scan).
  const init = await readPoolInitialize(input.chain, cfg, poolId, header.block, now, () => canCall(), rpc)
  if (init.kind !== 'ok') {
    if (init.kind === 'budget') return fail('call_budget_exhausted')
    if (init.kind === 'rpc_error') return fail('v4_swap_logs_unavailable', 'rpc_error')
    return { ...fail('v4_initialize_not_found'), hasMore: false }
  }
  if (init.cached) r.cache.initialize = true
  const key = init.key
  const manager = init.manager
  const tokenIsCurrency0 = key.currency0 === token
  if (!tokenIsCurrency0 && key.currency1 !== token) return { ...fail('token_side_unresolved'), hasMore: false }
  const counter = tokenIsCurrency0 ? key.currency1 : key.currency0
  const counterEthDec: number | undefined = cfg.nativeLike[counter]
  const counterUsdDec = cfg.usdStable[counter]
  const counterKind: 'native' | 'usd_stable' | 'other' = counterEthDec != null ? 'native' : counterUsdDec != null ? 'usd_stable' : 'other'
  const nativeSource: 'eth_usd_series' | 'bnb_usd_series' = cfg.native.symbol === 'BNB' ? 'bnb_usd_series' : 'eth_usd_series'
  const nativeRange = cfg.native.coinId === 'ethereum'
    ? deps.ethUsdRange
    : deps.nativeUsdRange ? (f: number, t: number, ms: number) => deps.nativeUsdRange!(cfg.native.coinId, f, t, ms) : undefined
  if (counterKind === 'native' && !nativeRange) return { ...fail('quote_usd_price_unproven'), quote: { source: nativeSource, evidence: 'unavailable', maxGapMs: null, reason: `no_${cfg.native.coinId}_usd_source` } }
  if (counterKind === 'other' && !deps.quoteUsdWindow) return { ...fail('quote_usd_price_unproven'), quote: { source: 'independent_pool', evidence: 'unavailable', maxGapMs: null, reason: 'no_independent_quote_source' } }

  // 3. Scanned-token decimals: the scan's own value when this instance has it, else one decimals() read.
  let tokenDecimals: number | null = token === NATIVE ? 18 : null
  const cachedDec = decimalsCache.get(`${input.chain}:${token}`)
  if (tokenDecimals == null && cachedDec && cachedDec.expiresAt > now()) { tokenDecimals = cachedDec.decimals; r.cache.decimals = true }
  if (tokenDecimals == null) {
    if (!canCall()) return fail('call_budget_exhausted')
    const res = await rpc('eth_call', [{ to: token, data: DECIMALS_SELECTOR }, 'latest'])
    const hex = typeof res.result === 'string' && /^0x[0-9a-f]+$/i.test(res.result) ? Number(BigInt(res.result)) : null
    if (res.error || hex == null || !Number.isInteger(hex) || hex < 0 || hex > 36) return fail('token_side_unresolved', 'decimals_unavailable')
    tokenDecimals = hex
    bounded(decimalsCache)
    decimalsCache.set(`${input.chain}:${token}`, { expiresAt: now() + INIT_TTL_MS, decimals: hex })
  }

  // 4. Map the time cursor to a block. Base: its fixed 2s blocks. Other chains: one REAL header near
  // the cursor (A) — the block rate is measured between A and the latest header, never assumed.
  const readHeader = async (block: number): Promise<{ block: number; ts: number } | null> => {
    const res = await rpc('eth_getBlockByNumber', [toHex(block), false])
    const b = res.result as { timestamp?: string } | null
    return res.error || !b?.timestamp ? null : { block, ts: Number(BigInt(b.timestamp)) }
  }
  const anchors: Array<{ block: number; ts: number }> = [{ block: header.block, ts: header.ts }]
  let secPerBlock = fixedTime ? cfg.blockTimeSec : cfg.nominalBlockSec
  let cursorBlock: number
  if (fixedTime) cursorBlock = header.block - Math.ceil((header.ts - beforeSec + 1) / cfg.blockTimeSec)
  else {
    const est = Math.max(key.initBlock, Math.min(header.block, header.block - Math.ceil((header.ts - beforeSec) / cfg.nominalBlockSec)))
    if (est < header.block) {
      if (!canCall()) return fail('call_budget_exhausted')
      const a = await readHeader(est)
      if (!a) return fail('v4_swap_logs_unavailable', 'rpc_error')
      anchors.push(a)
      if (header.block > a.block && header.ts > a.ts) secPerBlock = (header.ts - a.ts) / (header.block - a.block)
      cursorBlock = Math.min(header.block, a.block + Math.floor((beforeSec - 1 - a.ts) / secPerBlock))
    } else cursorBlock = header.block
  }
  const hoursToBlocks = (h: number) => Math.max(1, Math.ceil((h * 3600) / secPerBlock))
  const minPage = fixedTime ? V4_HISTORY_MIN_PAGE_BLOCKS : hoursToBlocks(4)
  const maxPage = fixedTime ? V4_HISTORY_MAX_PAGE_BLOCKS : hoursToBlocks(96)
  // Swap density (logs per block): this instance's own completed read of the pool, else the scan's measured
  // rate passed as a hint. Known density sizes every page to ~V4_HISTORY_TARGET_PAGE_LOGS (down to 30 min of
  // blocks); unknown density keeps the 24h first page with the quiet/busy adaptation below.
  const knownDensity = densityCache.get(`${input.chain}:${poolId}`)
  const logsPerBlock = knownDensity && knownDensity.expiresAt > now()
    ? knownDensity.logsPerBlock
    : input.swapsPerHourHint != null ? (input.swapsPerHourHint / 3600) * secPerBlock : null
  const floorPage = logsPerBlock != null ? hoursToBlocks(0.5) : minPage
  const densityPage = (lpb: number) => Math.max(floorPage, Math.min(maxPage, Math.ceil(V4_HISTORY_TARGET_PAGE_LOGS / lpb)))
  const firstPage = logsPerBlock != null && logsPerBlock > 0 ? densityPage(logsPerBlock) : fixedTime ? V4_HISTORY_FIRST_PAGE_BLOCKS : hoursToBlocks(24)

  // 5. Swap logs for exactly this PoolId on exactly its manager, strictly before the cursor, newest
  // first; adaptive page size. Non-fixed chains keep one call for the oldest-block header.
  const quoteReserve = (counterKind === 'usd_stable' ? 0 : counterKind === 'native' ? 1 : 2) + (fixedTime ? 0 : 1)
  if (cursorBlock < key.initBlock) return { ...r, ok: true, code: null, hasMore: false, nextBeforeSec: null, stopReason: 'pool_creation', endReason: 'reached_pool_creation' }
  const swaps: V4Swap[] = []
  let toBlock = Math.min(header.block, cursorBlock)
  let size = firstPage
  let capped = false
  let anyPage = false
  while (toBlock >= key.initBlock) {
    if (r.pagesFetched >= V4_HISTORY_MAX_PAGES) { r.stopReason = 'page_cap'; break }
    if (!canCall(quoteReserve)) break
    const fromBlock = Math.max(key.initBlock, toBlock - size + 1)
    r.pagesFetched++
    const page = await rpc('eth_getLogs', [{ address: manager, topics: [V4_SWAP_TOPIC0, poolId], fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }])
    if (page.error || !Array.isArray(page.result)) {
      // Too wide for the node (or a transient error): one smaller page next, never a retry loop.
      if (size > floorPage) { size = Math.max(floorPage, Math.floor(size / 4)); continue }
      r.stopReason = 'rpc_error'
      break
    }
    anyPage = true
    const decoded = decodePageNewestFirst(page.result as RawEvmLog[], poolId, manager)
    for (const s of decoded) {
      if (swaps.length >= V4_HISTORY_MAX_LOGS) { capped = true; break }
      swaps.push(s)
    }
    if (capped) { r.stopReason = 'log_cap'; break }
    const observed = decoded.length / Math.max(1, toBlock - fromBlock + 1)
    toBlock = fromBlock - 1
    size = logsPerBlock != null || decoded.length > BUSY_PAGE_LOGS
      // Density-sized: the next page targets ~V4_HISTORY_TARGET_PAGE_LOGS at the rate just observed.
      ? (observed > 0 ? densityPage(observed) : Math.min(maxPage, size * 2))
      : decoded.length < QUIET_PAGE_LOGS ? Math.min(maxPage, size * 2) : size
  }
  r.logsFound = swaps.length
  if (!anyPage) return fail(r.stopReason === 'call_budget' ? 'call_budget_exhausted' : 'v4_swap_logs_unavailable')

  // Non-fixed chains: a REAL header at the oldest block read (B) bounds the covered time exactly and,
  // with A and the latest header, anchors any interpolation.
  if (!fixedTime) {
    const oldestRead = Math.max(key.initBlock, toBlock + 1)
    if (!anchors.some((a) => a.block === oldestRead)) {
      if (r.callsUsed >= V4_HISTORY_MAX_CALLS || now() >= deadline) return fail('call_budget_exhausted', 'call_budget')
      const b = await readHeader(oldestRead)
      if (!b) return fail('v4_swap_logs_unavailable', 'rpc_error')
      anchors.push(b)
    }
  }
  const blockTs = fixedTime ? blockTsFixed : interpolateBlockTime(anchors)

  // Exact times only if every swap log carries its own block timestamp. Otherwise Base infers from its
  // fixed blocks, ETH/BNB interpolate between real headers, and Robinhood stops (timing unproven).
  const exact = swaps.length > 0 && swaps.every((s) => s.blockTimestamp != null)
  if (swaps.length > 0 && !exact && cfg.timestampMode === 'log_timestamp_only') return { ...fail('v4_timestamps_unproven'), hasMore: false }
  r.timeResolution = swaps.length === 0 ? null : exact ? 'exact_log_timestamps' : fixedTime ? 'inferred_block_time' : 'block_timestamp_lookup'
  let timed = swaps.map((s) => ({ ...s, timestampSec: exact ? s.blockTimestamp! : blockTs(s.blockNumber) })).filter((s) => s.timestampSec < beforeSec)

  // Cursor: everything from the oldest fully-read block up to the window end is covered. A partial
  // oldest hour (log cap / page boundary) is dropped and re-read by the next request — never shown short.
  const reachedCreation = !capped && toBlock < key.initBlock
  let coveredFromSec: number
  if (capped) {
    const oldestTs = timed.length > 0 ? Math.min(...timed.map((s) => s.timestampSec)) : beforeSec
    coveredFromSec = Math.floor(oldestTs / 3600) * 3600 + 3600
  } else {
    coveredFromSec = reachedCreation ? 0 : Math.ceil(blockTs(toBlock + 1) / 3600) * 3600
  }
  if (!reachedCreation) timed = timed.filter((s) => s.timestampSec >= coveredFromSec)
  r.hasMore = !reachedCreation && coveredFromSec > Math.floor(now() / 1000) - V4_HISTORY_MAX_AGE_SEC
  r.endReason = r.hasMore ? null : reachedCreation ? 'reached_pool_creation' : 'max_history_age'
  r.nextBeforeSec = r.hasMore ? Math.min(coveredFromSec, beforeSec - 3600) : null
  if (timed.length === 0) return { ...r, ok: true, code: null, candles: [] }

  // 5. Quote USD over exactly this window.
  const fromSec = Math.min(...timed.map((s) => s.timestampSec))
  const toSec = Math.max(...timed.map((s) => s.timestampSec))
  let counterDecimals: number | null = (counterEthDec ?? counterUsdDec) ?? null
  let series: Array<[number, number]> | null = null
  if (counterKind === 'native') {
    if (now() >= deadline) return { ...fail('quote_usd_price_unproven', 'deadline'), hasMore: r.hasMore }
    const eth = await nativeRange!(fromSec - 3600, toSec + 3600, Math.max(1, deadline - now()))
    if (!eth.cacheHit) r.callsUsed++
    r.cache.quote = eth.cacheHit
    series = eth.points
    r.quote = { source: nativeSource, evidence: series ? 'verified' : 'unavailable', maxGapMs: null, reason: series ? null : `${nativeSource}_unavailable` }
  } else if (counterKind === 'other') {
    const q = await deps.quoteUsdWindow!({
      quoteToken: counter, scannedToken: token, excludePool: poolId,
      ...quoteLaneSelection(input.chain),
      fromSec: fromSec - 3600, toSec: toSec + 3600,
      budget: Math.max(0, V4_HISTORY_MAX_CALLS - r.callsUsed), deadlineMs: deadline,
    })
    r.callsUsed += q.callsUsed
    r.cache.quote = q.cache.series
    counterDecimals = q.quoteDecimals
    series = q.ok ? q.points : null
    // Provider carried no decimals for the quote token: its own decimals() (shared 24h cache with the scan).
    if (series && counterDecimals == null && r.callsUsed < V4_HISTORY_MAX_CALLS && now() < deadline) counterDecimals = await readTokenDecimals(input.chain, counter, rpc, now)
    r.quote = { source: 'independent_pool', evidence: series ? 'verified' : 'unavailable', maxGapMs: null, reason: q.detail }
  } else {
    r.quote = { source: 'usd_stable', evidence: 'verified', maxGapMs: null, reason: null }
  }
  if (counterDecimals == null || (counterKind !== 'usd_stable' && (!series || series.length === 0))) return { ...fail('quote_usd_price_unproven'), hasMore: r.hasMore, nextBeforeSec: r.nextBeforeSec }
  let maxGapMs = 0
  const counterUsdAt = !series ? () => 1 : (tsMs: number) => {
    const hitPt = nearestPriceWithGap(series!, tsMs, V4_HISTORY_QUOTE_MAX_GAP_MS)
    if (!hitPt) return null
    maxGapMs = Math.max(maxGapMs, hitPt.gapMs)
    return hitPt.price
  }

  // 6. Genuine hourly OHLCV from real trades only.
  const built = buildV4SwapCandles({
    swaps: timed, tokenIsCurrency0,
    decimals0: tokenIsCurrency0 ? tokenDecimals : counterDecimals,
    decimals1: tokenIsCurrency0 ? counterDecimals : tokenDecimals,
    counterUsdAt, intervalSec: V4_HISTORY_INTERVAL_SEC,
  })
  r.tradesUsed = built.tradesUsed
  r.quote = { ...r.quote!, maxGapMs: counterKind === 'usd_stable' ? null : maxGapMs }
  if (built.tradesUsed === 0 && counterKind !== 'usd_stable') return { ...fail('quote_usd_price_unproven'), quote: { ...r.quote!, evidence: 'unavailable', reason: 'no_quote_usd_point_within_45m_of_any_trade' }, hasMore: r.hasMore, nextBeforeSec: r.nextBeforeSec }
  return { ...r, ok: true, code: null, candles: built.candles }
}

/** Piecewise-linear block -> time between REAL block headers (ascending by block). Never used as "exact". */
export function interpolateBlockTime(anchors: ReadonlyArray<{ block: number; ts: number }>): (block: number) => number {
  const a = [...anchors].sort((x, y) => x.block - y.block)
  return (block: number) => {
    if (a.length === 1) return a[0].ts
    let i = 0
    while (i < a.length - 2 && block > a[i + 1].block) i++
    const lo = a[i]
    const hi = a[i + 1]
    if (hi.block === lo.block) return lo.ts
    return Math.round(lo.ts + ((block - lo.block) * (hi.ts - lo.ts)) / (hi.block - lo.block))
  }
}

/**
 * The pool's Initialize event on one of the chain's configured managers (exact PoolId, exact manager:
 * a log from any other contract is rejected). Cached 24h per chain + PoolId together with its manager.
 */
async function readPoolInitialize(
  chain: string,
  cfg: V4ChainConfig,
  poolId: string,
  latestBlock: number,
  now: () => number,
  canCall: () => boolean,
  rpc: (method: string, params: unknown[]) => Promise<{ result: unknown; error: boolean }>,
): Promise<{ kind: 'ok'; key: V4PoolKey; manager: string; cached: boolean } | { kind: 'budget' | 'rpc_error' | 'not_found' }> {
  const cacheKey = `${chain}:${poolId}`
  const cached = initCache.get(cacheKey)
  if (cached && cached.expiresAt > now()) return { kind: 'ok', key: cached.key, manager: cached.manager, cached: true }
  if (!canCall()) return { kind: 'budget' }
  const managers = cfg.managers.map((m) => m.address.toLowerCase())
  const res = await rpc('eth_getLogs', [{ address: managers.length === 1 ? managers[0] : managers, topics: [V4_INITIALIZE_TOPIC0, poolId], fromBlock: '0x0', toBlock: toHex(latestBlock) }])
  if (res.error || !Array.isArray(res.result)) return { kind: 'rpc_error' }
  for (const log of res.result as RawEvmLog[]) {
    if (log.removed === true) continue
    const from = typeof log.address === 'string' ? log.address.toLowerCase() : null
    if (!from || !managers.includes(from)) continue
    const key = decodeV4Initialize(log, poolId)
    if (!key) continue
    bounded(initCache)
    initCache.set(cacheKey, { expiresAt: now() + INIT_TTL_MS, key, manager: from })
    return { kind: 'ok', key, manager: from, cached: false }
  }
  return { kind: 'not_found' }
}

// ── On-demand 5M (only after the user clicks 5M — never during a scan) ─────────────────────────────
// A bytes32 Uniswap V4 PoolId is never sent to a provider's pool OHLCV for 5M: the candles come from the
// same exact-PoolId Swap-event pipeline as the scan (loadV4SwapCandles — Initialize proof of the scanned
// token's side, removed-log filtering, log/page/call caps, deadline, quote USD evidence, deterministic
// newest-first order). 5M is returned ONLY when every swap log carries its own exact block timestamp
// (exact_log_timestamps -> V4_EXACT_INTERVAL_SEC buckets of real trades). A series whose times are
// inferred (Base fixed blocks) or interpolated between headers (ETH / BNB) is never cut into 5-minute
// candles — v4_timestamps_not_exact, and the scan's 15M stays as it is. Never derived from 15M candles,
// never interpolated trades.
//
// Reuse first: the scan's own cached V4 result for this (chain, PoolId, token) answers with zero calls
// (exact -> its 5M candles; non-exact -> the precise reason). Otherwise one bounded read (<= 1 decimals
// call when the scan's decimals are not cached + <= V4_SWAP_MAX_CALLS), cached per pool + token; concurrent
// identical requests share one read.

export type V4FiveMinuteCode = V4SwapGapCode | 'invalid_request' | 'v4_timestamps_not_exact' | 'token_decimals_unavailable'
/** On-demand exact-timestamp bucket widths: 5M (300s) and 1M (60s). Never derived from wider candles. */
export type V4IntradayIntervalSec = 60 | 300

export type V4FiveMinuteResult = {
  ok: boolean
  code: V4FiveMinuteCode | null
  chain: string
  poolId: string
  intervalSec: number
  /** Genuine 5-minute swap candles (ascending). Empty unless ok. */
  candles: EvmChartPoint[]
  timeResolution: V4TimeResolution | null
  source: 'v4_swap_events'
  /** The read covered its full target window (every log page read). */
  windowProven: boolean
  /** Seconds the read actually covered (truthful coverage; null when unknown). */
  coveredSec: number | null
  logsFound: number
  tradesUsed: number
  callsUsed: number
  budgetStopReason: string | null
  /** scanResult: answered from the scan's cached V4 read; fiveMinute: from this lane's own cache. */
  cache: { scanResult: boolean; fiveMinute: boolean }
}

/** The 5M chip's message after "5M unavailable — " for a V4 5M failure (no provider wording). */
export const V4_FIVE_MINUTE_NOT_EXACT_MESSAGE = 'exact swap timestamps are not available for this V4 pool, so 5M candles are not built (15M stays available)'
/** Same for the 1M chip. */
export const V4_ONE_MINUTE_NOT_EXACT_MESSAGE = 'exact swap timestamps are not available for this V4 pool, so 1M candles are not built (15M stays available)'

function fiveMinuteFrom(v: V4SwapCandleResult, cache: V4FiveMinuteResult['cache'], intervalSec: V4IntradayIntervalSec = V4_EXACT_INTERVAL_SEC): V4FiveMinuteResult {
  const base: V4FiveMinuteResult = {
    ok: false, code: v.code, chain: v.chain, poolId: v.poolId, intervalSec, candles: [], timeResolution: v.timeResolution, source: 'v4_swap_events',
    windowProven: v.budgetStopReason === 'target_window', coveredSec: v.window?.coveredSec ?? null, logsFound: v.logsFound, tradesUsed: v.tradesUsed, callsUsed: cache.scanResult || cache.fiveMinute ? 0 : v.callsUsed, budgetStopReason: v.budgetStopReason, cache,
  }
  if (!v.ok) return base
  if (v.timeResolution !== 'exact_log_timestamps' || v.intervalSec !== intervalSec) return { ...base, code: 'v4_timestamps_not_exact' }
  return { ...base, ok: true, code: null, candles: v.candles }
}

export async function loadV4SwapFiveMinuteWindow(
  input: { chain: string; poolId: string; token: string },
  deps: V4SwapDeps,
): Promise<V4FiveMinuteResult> {
  return loadV4SwapIntradayWindow({ ...input, intervalSec: V4_EXACT_INTERVAL_SEC }, deps)
}

/**
 * On-demand 1M / 5M candles of exactly this V4 PoolId's swaps (see the 5M notes above). 1M is the SAME
 * bounded read as 5M — same pages, log cap, call budget, PoolId / token-side / quote-USD proof — bucketed at
 * 60s; it is never derived from 5M or 15M and needs every log's own exact timestamp. The scan's cached read
 * answers 5M directly; for 1M it can only answer "not exact" (its 5M candles cannot be split).
 */
export async function loadV4SwapIntradayWindow(
  input: { chain: string; poolId: string; token: string; intervalSec: V4IntradayIntervalSec },
  deps: V4SwapDeps,
): Promise<V4FiveMinuteResult> {
  const interval: V4IntradayIntervalSec = input.intervalSec === 60 ? 60 : V4_EXACT_INTERVAL_SEC
  const now = deps.now ?? Date.now
  const poolId = String(input.poolId ?? '').toLowerCase()
  const token = String(input.token ?? '').toLowerCase()
  const empty = (code: V4FiveMinuteCode): V4FiveMinuteResult => ({
    ok: false, code, chain: input.chain, poolId, intervalSec: interval, candles: [], timeResolution: null, source: 'v4_swap_events',
    windowProven: false, coveredSec: null, logsFound: 0, tradesUsed: 0, callsUsed: 0, budgetStopReason: null, cache: { scanResult: false, fiveMinute: false },
  })
  if (!V4_SWAP_CHAIN_CONFIG[input.chain]) return empty('v4_chain_not_supported')
  if (!/^0x[a-f0-9]{64}$/.test(poolId) || !/^0x[a-f0-9]{40}$/.test(token)) return empty('invalid_request')
  const scanKey = `${input.chain}:${poolId}:${token}`
  const key = `${scanKey}:${interval}`
  // 1. The scan's own V4 read for exactly this pool + token (zero calls): its 5M candles for 5M; for 1M only
  //    a proven "not exact" / failure answer (5M candles are never split into 1M).
  const scan = resultCache.get(scanKey)
  if (scan && scan.expiresAt > now() && scan.value.code !== 'call_budget_exhausted') {
    const fromScan = fiveMinuteFrom(scan.value, { scanResult: true, fiveMinute: false }, V4_EXACT_INTERVAL_SEC)
    if (interval === V4_EXACT_INTERVAL_SEC) return fromScan
    if (!fromScan.ok) return { ...fromScan, intervalSec: interval }
  }
  // 2. This lane's own cache / in-flight read.
  const hit = fiveCache.get(key)
  if (hit && hit.expiresAt > now()) return { ...hit.value, callsUsed: 0, cache: { scanResult: false, fiveMinute: true } }
  const running = fiveInflight.get(key)
  if (running) return running
  const p = (async (): Promise<V4FiveMinuteResult> => {
    // 3. Bounded on-demand read: the token's decimals (scan-cached, else its own decimals()), then the same
    // exact-PoolId swap pipeline as the scan.
    let decimalsCalls = 0
    const cached = decimalsCache.get(`${input.chain}:${token}`)
    let decimals = cached && cached.expiresAt > now() ? cached.decimals : null
    if (decimals == null) {
      decimalsCalls = 1
      decimals = await readTokenDecimals(input.chain, token, (m, params) => deps.rpc(m, params, RPC_TIMEOUT_MS), now)
      if (decimals == null) return { ...empty('token_decimals_unavailable'), callsUsed: decimalsCalls }
    }
    const v = await loadV4SwapCandles({ chain: input.chain, poolId, token, tokenDecimals: decimals, livePriceUsd: null, onDemand: true, exactIntervalSec: interval }, deps, V4_SWAP_MAX_CALLS)
    const out = fiveMinuteFrom(v, { scanResult: false, fiveMinute: false }, interval)
    out.callsUsed = v.callsUsed + decimalsCalls
    if (out.code !== 'call_budget_exhausted') {
      bounded(fiveCache)
      fiveCache.set(key, { expiresAt: now() + (v.ok ? OK_TTL_MS : FAIL_TTL_MS), value: out })
    }
    return out
  })().finally(() => fiveInflight.delete(key))
  fiveInflight.set(key, p)
  return p
}
