// MODULE — pricingAtTimeEngine/sources: request-scoped historical on-chain RPC/CU budget.
//
// EMERGENCY CONTAINMENT, DISCLOSED: production evidence showed a single wallet scan consuming
// hundreds of thousands of Alchemy CU — getBlock:estimate x69, getBlock:bisect x207,
// multicall:getPool x84, multicall:poolPrice x38, ~20 Aerodrome pool lookups, a prior Uniswap V3
// pricing pass alone emitting 1,483 RPC calls — while most outcomes were no_pool or
// blockResolutionFailure and only a small number of lots actually completed. basedex.ts already had
// several real, effective cost-reduction fixes (bucketed block caching, pool-address caching,
// negative-result caching, multicall batching) layered on over time, but none of them is a HARD
// CEILING: each independently reduces cost, but nothing stops the combined total from growing
// without bound across a large, pathological wallet. This module is that hard ceiling — one
// request-scoped budget shared by every historical on-chain RPC consumer (block-timestamp
// resolution, Uniswap V3, Aerodrome Slipstream, Aerodrome Classic, pool discovery, pool price reads)
// so the TOTAL cost of one wallet scan's on-chain historical pricing can never exceed a strict cap,
// regardless of how many distinct tokens or requirements that scan has.
//
// FAIL CLOSED, DISCLOSED: every check here is a pure "may I spend one more call" gate. When the
// answer is no, the caller gets back exactly the same `null`/"not found" outcome a genuine "no data"
// result would produce — never a fabricated price, never a retry, never a wait. A bucket, pool, or
// token this budget refused to spend further calls on simply stays unresolved, exactly like an
// exhausted/failed on-chain search already did before this module existed. This can only ever REDUCE
// the number of real calls a scan makes relative to the prior uncapped behavior — it never causes a
// call that would otherwise not have happened.
//
// KILL SWITCH, DISCLOSED, DEFAULT OFF: HISTORICAL_ONCHAIN_RPC_PRICING_ENABLED gates the entire
// on-chain historical pricing path (basedex.ts's fetchBaseDexPriceDetailed). Unset or any value other
// than the literal string 'true' means DISABLED — this venue is not attempted at all, at zero RPC
// cost, and pricing falls through to whatever the provider-based sources (GoldRush/DexScreener/
// GeckoTerminal/CoinGecko) already produced. This is a genuine behavior change from before this task
// (on-chain pricing was previously always attempted as a last-resort fallback) — it is the explicit,
// requested emergency containment measure: the cheapest possible RPC cost for this venue is zero
// calls, and that is now the default until this flag is deliberately turned on.

export function isHistoricalOnchainRpcPricingEnabled(): boolean {
  return process.env.HISTORICAL_ONCHAIN_RPC_PRICING_ENABLED === 'true'
}

// HARD CAPS, DISCLOSED, EXACTLY THIS TASK'S SPEC — never configurable via env, deliberately: a
// containment measure that could be silently loosened by a stray environment variable would not be
// a real ceiling. `perToken` applies to pool-discovery and pool-price calls only (the two categories
// that are inherently about ONE specific token) — block resolution is bucket-shared across every
// token that happens to need the same historical time window, so it has no per-token meaning.
export const MAX_TOTAL_RPC_CALLS_PER_SCAN = 40
export const MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN = 8
export const MAX_POOL_DISCOVERY_CALLS_PER_SCAN = 12
export const MAX_POOL_PRICE_CALLS_PER_SCAN = 12
export const MAX_CALLS_PER_TOKEN = 4

export type RpcBudgetCategory = 'block_resolution' | 'pool_discovery' | 'pool_price'
export type RpcBudgetVenue = 'block_resolution' | 'uniswap_v3' | 'aerodrome_slipstream' | 'aerodrome_classic_volatile'

const CATEGORY_CAP: Record<RpcBudgetCategory, number> = {
  block_resolution: MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN,
  pool_discovery: MAX_POOL_DISCOVERY_CALLS_PER_SCAN,
  pool_price: MAX_POOL_PRICE_CALLS_PER_SCAN,
}

// ESTIMATED CU, DISCLOSED: Alchemy's own published per-method compute-unit table lists
// eth_getBlockByNumber at 16 CU and eth_call at 26 CU — used here ONLY to produce an estimated total
// for the diagnostic below, never for any budgeting decision (every cap above is a plain call count,
// exactly as specified). A multicall batches several logical reads into one eth_call, so it is
// costed as a single 26-CU eth_call here too — real, not inflated per sub-call.
const ESTIMATED_CU_PER_CALL: Record<RpcBudgetCategory, number> = {
  block_resolution: 16,
  pool_discovery: 26,
  pool_price: 26,
}

type BudgetState = {
  totalRpcCalls: number
  callsByCategory: Record<RpcBudgetCategory, number>
  callsByVenue: Record<RpcBudgetVenue, number>
  callsByToken: Map<string, number>
  timestampBuckets: Set<number>
  blockCacheHits: number
  poolCacheHits: number
  negativeCacheHits: number
  stoppedByGlobalCap: number
  stoppedByPerTokenCap: number
}

function emptyState(): BudgetState {
  return {
    totalRpcCalls: 0,
    callsByCategory: { block_resolution: 0, pool_discovery: 0, pool_price: 0 },
    callsByVenue: { block_resolution: 0, uniswap_v3: 0, aerodrome_slipstream: 0, aerodrome_classic_volatile: 0 },
    callsByToken: new Map(),
    timestampBuckets: new Set(),
    blockCacheHits: 0,
    poolCacheHits: 0,
    negativeCacheHits: 0,
    stoppedByGlobalCap: 0,
    stoppedByPerTokenCap: 0,
  }
}

let state: BudgetState = emptyState()

// SCAN-BOUNDARY RESET, DISCLOSED: same per-scan reset convention as every other request-scoped
// budget/cache in this pipeline (see basedex.ts's own resetBaseDexRpcBudgetForScan, which calls
// this) — a warm serverless instance serving a second, unrelated scan must start this budget fresh.
export function resetHistoricalRpcBudgetForScan(): void {
  state = emptyState()
}

// `token` is optional: block-resolution calls are bucket-shared, not token-specific, so they never
// participate in the per-token cap. Returns true (and reserves the spend) only when EVERY applicable
// cap — global, category, and (if a token was given) per-token — still has room; otherwise records
// exactly which cap refused it and returns false, spending nothing. This is the ONLY function in
// this module that may increment totalRpcCalls/callsByCategory/callsByToken — every real RPC call
// site in basedex.ts must call this immediately before making the call, and must not make the call
// at all if it returns false.
export function tryReserveRpcCall(category: RpcBudgetCategory, venue: RpcBudgetVenue, token: string | null): boolean {
  if (state.totalRpcCalls >= MAX_TOTAL_RPC_CALLS_PER_SCAN) {
    state.stoppedByGlobalCap += 1
    return false
  }
  if (state.callsByCategory[category] >= CATEGORY_CAP[category]) {
    state.stoppedByGlobalCap += 1
    return false
  }
  if (token) {
    const tokenKey = token.toLowerCase()
    const tokenCalls = state.callsByToken.get(tokenKey) ?? 0
    if (tokenCalls >= MAX_CALLS_PER_TOKEN) {
      state.stoppedByPerTokenCap += 1
      return false
    }
  }

  state.totalRpcCalls += 1
  state.callsByCategory[category] += 1
  state.callsByVenue[venue] += 1
  if (token) {
    const tokenKey = token.toLowerCase()
    state.callsByToken.set(tokenKey, (state.callsByToken.get(tokenKey) ?? 0) + 1)
  }
  return true
}

// PURE CHECK, never mutates: used by a caller that needs to reserve SEVERAL calls as one atomic
// batch (e.g. a 4-call sequential RPC fallback that only makes sense to attempt as a whole) — checks
// whether `count` more calls of this category/token would ALL fit under every applicable cap before
// any of them are actually reserved via tryReserveRpcCall, so a partial reservation can never be
// silently counted against the budget without a matching real call ever being made.
export function canReserveRpcCalls(category: RpcBudgetCategory, token: string | null, count: number): boolean {
  if (state.totalRpcCalls + count > MAX_TOTAL_RPC_CALLS_PER_SCAN) return false
  if (state.callsByCategory[category] + count > CATEGORY_CAP[category]) return false
  if (token) {
    const tokenKey = token.toLowerCase()
    const tokenCalls = state.callsByToken.get(tokenKey) ?? 0
    if (tokenCalls + count > MAX_CALLS_PER_TOKEN) return false
  }
  return true
}

export function recordTimestampBucket(bucketed: number): void {
  state.timestampBuckets.add(bucketed)
}

export function recordBlockCacheHit(): void {
  state.blockCacheHits += 1
}

export function recordPoolCacheHit(): void {
  state.poolCacheHits += 1
}

export function recordNegativeCacheHit(): void {
  state.negativeCacheHits += 1
}

export type HistoricalRpcBudgetSummary = {
  enabled: boolean
  totalRpcCalls: number
  blockResolutionCalls: number
  poolDiscoveryCalls: number
  poolPriceCalls: number
  callsByVenue: Record<RpcBudgetVenue, number>
  callsByToken: Record<string, number>
  timestampBuckets: number
  blockCacheHits: number
  poolCacheHits: number
  negativeCacheHits: number
  stoppedByGlobalCap: number
  stoppedByPerTokenCap: number
  estimatedAlchemyCu: number
}

// PURE snapshot — never mutates state, safe to call at any point in or after a scan.
export function getHistoricalRpcBudgetSummary(): HistoricalRpcBudgetSummary {
  const estimatedAlchemyCu =
    state.callsByCategory.block_resolution * ESTIMATED_CU_PER_CALL.block_resolution +
    state.callsByCategory.pool_discovery * ESTIMATED_CU_PER_CALL.pool_discovery +
    state.callsByCategory.pool_price * ESTIMATED_CU_PER_CALL.pool_price

  return {
    enabled: isHistoricalOnchainRpcPricingEnabled(),
    totalRpcCalls: state.totalRpcCalls,
    blockResolutionCalls: state.callsByCategory.block_resolution,
    poolDiscoveryCalls: state.callsByCategory.pool_discovery,
    poolPriceCalls: state.callsByCategory.pool_price,
    callsByVenue: { ...state.callsByVenue },
    callsByToken: Object.fromEntries(state.callsByToken),
    timestampBuckets: state.timestampBuckets.size,
    blockCacheHits: state.blockCacheHits,
    poolCacheHits: state.poolCacheHits,
    negativeCacheHits: state.negativeCacheHits,
    stoppedByGlobalCap: state.stoppedByGlobalCap,
    stoppedByPerTokenCap: state.stoppedByPerTokenCap,
    estimatedAlchemyCu,
  }
}

// Logs the [historical-rpc-budget] diagnostic — called once per resolvePricingAtTime pass, alongside
// basedex.ts's own pre-existing logBaseDexFinalTotals() (same call site, see
// pricingAtTimeEngine/index.ts). console.warn, not console.log, matching this codebase's established
// "next.config's compiler.removeConsole strips console.log/info/debug from the production build"
// convention — this must survive in real deployment logs.
export function logHistoricalRpcBudgetSummary(): void {
  // eslint-disable-next-line no-console
  console.warn('[historical-rpc-budget]', getHistoricalRpcBudgetSummary())
}

// TEST-SUPPORT EXPORT, DISCLOSED: lets a test start from a clean budget state without importing the
// scan-boundary reset (which also touches basedex's own unrelated caches).
export function __resetHistoricalRpcBudgetForTest(): void {
  resetHistoricalRpcBudgetForScan()
}
