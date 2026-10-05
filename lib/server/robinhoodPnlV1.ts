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
/** One JSON-RPC batch; each slot is the call's result, or null when that call failed. Never throws. */
export type RhRpc = (calls: RhRpcCall[]) => Promise<Array<unknown | null>>
export type RhPoolKey = { currency0: string; currency1: string }
export type RhHistoricalTokenPrice = { priceUsd: number; source: string }

export type RobinhoodPnlV1Deps = {
  rpc: RhRpc | null
  /** Hour-aligned historical ETH/USD points ([ms, usd], ascending) for [fromSec, toSec]. */
  ethUsdRange: (fromSec: number, toSec: number) => Promise<Array<[number, number]> | null>
  /** Trusted historical provider, exact token + timestamp. Null when it has no answer. */
  tokenHistoricalUsd: (token: string, timestampSec: number) => Promise<RhHistoricalTokenPrice | null>
  now: () => number
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
type RhReceipt = { status: number | null; from: string; blockNumber: number; gasUsed: bigint; effectiveGasPrice: bigint; logs: RhLog[] }

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

type CandidateOutcome = { txHash: string; receiptFetched: boolean; v4SwapLogs: number; swap: RhVerifiedSwap | null; rejection: RhRejection | null; detail: string | null }

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
  if (!pre.ok) return out({ receiptFetched: true, v4SwapLogs, rejection: pre.reason, detail: pre.detail })

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
    )
  }
  const res = batch.length > 0 ? await call(ctx, batch) : []
  let i = 0
  let timestampSec = receipt.logs.find((l) => l.blockTimestamp != null)?.blockTimestamp ?? null
  if (needBlock) timestampSec = hexToNum((res[i++] as Record<string, unknown> | null)?.timestamp)
  let nativeNet: bigint | null = null
  if (nativeTouched && N > 0) {
    const [b0, b1, n0, n1] = [hexToBigInt(res[i]), hexToBigInt(res[i + 1]), hexToNum(res[i + 2]), hexToNum(res[i + 3])]
    // Exact only when this is the wallet's one tx in the block: then balance change + gas fee = what the trade moved.
    if (b0 != null && b1 != null && n0 != null && n1 != null && n1 - n0 === 1) nativeNet = b1 - b0 + receipt.gasUsed * receipt.effectiveGasPrice
  }
  const route = verifyRobinhoodV4Route({ wallet, txHash, receipt, poolKeys, nativeNet })
  if (!route.ok) return out({ receiptFetched: true, v4SwapLogs, rejection: route.reason, detail: route.detail })
  if (timestampSec == null || timestampSec <= 0) return out({ receiptFetched: true, v4SwapLogs, rejection: 'timestamp_unavailable' })
  const [inputDecimals, outputDecimals, interDecimals] = await Promise.all([
    tokenDecimals(ctx, route.inputToken),
    tokenDecimals(ctx, route.outputToken),
    route.intermediary ? tokenDecimals(ctx, route.intermediary.currency) : Promise.resolve(0),
  ])
  if (inputDecimals == null || outputDecimals == null || interDecimals == null) return out({ receiptFetched: true, v4SwapLogs, rejection: 'decimals_unavailable' })
  return out({
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

type EthSeries = Array<[number, number]>
async function loadEthSeries(ctx: Ctx, timestampsSec: number[]): Promise<{ series: EthSeries; windows: number }> {
  const sorted = [...new Set(timestampsSec)].sort((a, b) => a - b)
  const windows: Array<[number, number]> = []
  for (const t of sorted) {
    const last = windows[windows.length - 1]
    if (last && t - last[0] <= ETH_SERIES_MAX_WINDOW_SEC) last[1] = t
    else windows.push([t, t])
  }
  const series: EthSeries = []
  let used = 0
  for (const [from, to] of windows) {
    if (ctx.priceSidesUsed >= ROBINHOOD_PNL_V1_LIMITS.maxHistoricalPriceSides || Date.now() >= ctx.deadlineAt) break
    ctx.priceSidesUsed += 1
    ctx.m.historicalPriceCalls += 1
    used += 1
    const pts = await ctx.deps.ethUsdRange(from - 3_600, to + 3_600).catch(() => null)
    if (pts) series.push(...pts)
  }
  series.sort((a, b) => a[0] - b[0])
  return { series, windows: used }
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

export async function priceRobinhoodSwaps(ctx: Ctx, swaps: readonly RhVerifiedSwap[]): Promise<RhPriceEvidence[]> {
  const needsEth = swaps.filter((s) => quoteKind(s.inputToken) === 'native' || quoteKind(s.outputToken) === 'native' || s.intermediary?.kind === 'native')
  const { series } = needsEth.length > 0 ? await loadEthSeries(ctx, needsEth.map((s) => s.timestampSec)) : { series: [] as EthSeries }
  const quoteUsd = (currency: string, raw: bigint, decimals: number, ts: number): { usd: number; source: string } | null => {
    const kind = quoteKind(currency)
    const qty = toUnits(raw, decimals)
    if (kind === 'stable') return { usd: qty, source: 'verified_stablecoin_exact_address' }
    if (kind === 'native') {
      const hit = nearestPriceWithGap(series, ts * 1000, ROBINHOOD_ETH_USD_MAX_GAP_MS)
      return hit ? { usd: qty * hit.price, source: currency === RH_WETH ? 'weth_historical_eth_usd' : 'native_historical_eth_usd' } : null
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
}): Promise<RobinhoodPnlV1> {
  const startedAt = params.deps.now()
  const wallet = lower(params.wallet)
  const m: RobinhoodPnlV1Metrics = { robinhoodPnlMs: 0, receiptCalls: 0, rpcCalls: 0, historicalPriceCalls: 0, cacheHits: 0, swapsVerified: 0, lotsBuilt: 0, deadlineHit: false }
  const { selected, dropped } = selectRobinhoodPnlV1Candidates(params.candidates)
  const ingestion: RobinhoodPnlV1IngestionAudit = {
    wallet, transactionCount: params.transactionCount, transferCount: params.transferCount,
    candidateSwapTxCount: selected.length, candidatesDroppedByCap: dropped, receiptsFetched: 0, v4SwapLogCount: 0,
    verifiedSwapTxCount: 0, rejectedSwapTxCount: 0, rejectionReasons: {}, normalizedBuyCount: 0, normalizedSellCount: 0,
  }
  const finish = (r: Omit<RobinhoodPnlV1, 'ingestionAudit' | 'metrics' | 'priceEvidence'> & { priceEvidence?: RhPriceEvidence[] }): RobinhoodPnlV1 => {
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
  m.swapsVerified = swaps.length
  const swapsFound = outcomes.filter((o) => o.v4SwapLogs > 0).length

  const evidence = swaps.length > 0 ? await priceRobinhoodSwaps(ctx, swaps) : []
  for (const e of evidence) console.warn('[robinhood-price-evidence-audit]', e)
  const bothLegs = evidence.filter((e) => e.bothLegsVerified).length
  const { fifo, buyCount, sellCount } = buildRobinhoodPnlV1Fifo(wallet, swaps, evidence)
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
    priceEvidence: evidence,
  }
  if (verifiedLots.length > 0) {
    const status: RobinhoodPnlV1Status = coverage != null && coverage >= ROBINHOOD_PNL_V1_MIN_COVERAGE_PCT ? 'verified_bounded_sample' : 'partial'
    return finish({ ...base, status, exactReason: `${verifiedLots.length}/${structural} closed lots verified from ${swaps.length} proven V4 swaps (bounded sample of the ${selected.length} most recent candidate txs).` })
  }
  const topRejection = Object.entries(ingestion.rejectionReasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  const exactReason = swaps.length === 0
    ? `${swapsFound} swap${swapsFound === 1 ? '' : 's'} found / 0 proven as wallet V4 trades${topRejection ? ` (most common: ${topRejection[0]})` : ''}.`
    : bothLegs === 0
      ? `${swaps.length} swap${swaps.length === 1 ? '' : 's'} found / 0 had both-leg historical price proof.`
      : structural === 0
        ? `${swaps.length} swap${swaps.length === 1 ? '' : 's'} proven, ${bothLegs} priced on both legs, but no buy→sell pair closed a lot in this sample.`
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
    ethUsdRange: async (fromSec, toSec) => (await fetchCoingeckoEthUsdRange(fromSec, toSec, ROBINHOOD_PNL_V1_LIMITS.providerTimeoutMs)).points,
    tokenHistoricalUsd: goldrushRobinhoodTokenHistoricalUsd(fetchImpl),
    now: Date.now,
  }
}
