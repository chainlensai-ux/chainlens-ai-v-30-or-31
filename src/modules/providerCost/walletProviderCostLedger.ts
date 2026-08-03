// MODULE — providerCost: one request-scoped Alchemy + GoldRush budget and cost ledger for a whole
// wallet scan.
//
// WHY, DISCLOSED (see docs/wallet-provider-cost-audit.md for the full call inventory): before this
// module the wallet scan had FOUR independent, uncoordinated cost controls —
// providerFetchWindow's singleflight map, goldrushPriceSource's consecutive-miss breaker,
// alchemyHistoricalPriceSource's own per-scan request cap, and basedex's historicalRpcBudget —
// plus one budget module (lib/server/alchemyCallBudget.ts) that was fully written, fully tested,
// and wired to NOTHING. None of them could see each other, so nothing bounded the scan's TOTAL
// provider spend: a scan could exhaust one path's budget and immediately spend freely on another.
// This module is the single shared ceiling, and the single place the real numbers are counted.
//
// COUNTS REAL CALLS ONLY, DISCLOSED: `recordCall` must be invoked once per call that genuinely went
// out over the network. A cache hit, a singleflight join, or a budget refusal must NEVER record a
// call — those are recorded separately (recordDuplicatePrevented / recordCapped) precisely so the
// diagnostic can reconcile exactly against a mocked provider's own invocation count. That
// reconciliation is asserted by a test.
//
// FAIL CLOSED, DISCLOSED: `tryConsume` returning false means the caller must make NO call and
// return the same honest "no data" value it would return for a genuine provider miss. This module
// never fabricates a price, never lowers an evidence gate, and never retries — it only ever
// prevents spend.

import type { SupportedChain } from '../providerFetchWindow/types'
import { estimatedCuForMethod } from '@/lib/server/alchemyCallBudget'

export type CostProvider = 'alchemy' | 'goldrush'

// The real pipeline stages a provider call can originate from — used for per-stage attribution in
// the diagnostic. 'unknown' is the honest default for a call site that hasn't been threaded with a
// stage yet, never a guess at which stage it belongs to.
export type CostStage =
  | 'transaction_history'
  | 'holdings'
  | 'historical_pricing'
  | 'onchain_rpc_pricing'
  | 'receipts'
  | 'recovery'
  | 'current_pricing'
  | 'unknown'

// GOLDRUSH CREDIT MODEL, DISCLOSED: Covalent/GoldRush bills per request, not per method, on the
// endpoints this codebase uses (transactions_v3, balances_v2, PricingService.getTokenPrices) — so
// one call is costed as one credit. This is a real, uniform billing model, NOT an invented
// per-endpoint weighting: this codebase has no verified differentiated GoldRush credit figures and
// will not fabricate them.
const GOLDRUSH_CREDITS_PER_CALL = 1

// HARD CAPS, DISCLOSED. Deliberately not env-configurable: a containment ceiling a stray
// environment variable could silently loosen is not a ceiling. Sized from the audit's own measured
// production evidence (docs/wallet-provider-cost-audit.md): the worst measured scan made 1,045
// GoldRush pricing calls with ZERO accepted results, and 1,483 Alchemy RPC calls from Uniswap V3
// pricing alone. These caps sit far above what a healthy scan actually needs (a scan's legitimate
// floor is ~2 history calls + 1 balances call per chain, plus the genuinely-resolvable price
// lookups) and far below the runaway figures above.
export const MAX_ALCHEMY_CALLS_PER_SCAN = 120
// CU CEILING, SIZED TO ACTUALLY BIND, DISCLOSED: a healthy scan's real Alchemy floor is roughly
// 4 x alchemy_getAssetTransfers (history, 2 chains x from+to) = 600 CU, plus 2 x
// alchemy_getTokenBalances (holdings) = 52 CU, plus <=40 receipt reads at 15 CU = 600 CU, plus the
// separately-capped on-chain RPC pricing path (<=40 calls, ~1,000 CU) — about 2,300 CU in total.
// This ceiling leaves ~3x headroom over that while still binding HARD on the runaway shape that
// actually matters: an unbounded alchemy_getAssetTransfers loop (150 CU each) is stopped at ~53
// calls rather than being allowed all 120 by the call cap alone. A CU cap the call cap always
// reaches first would be decoration, not a control.
export const MAX_ALCHEMY_CU_PER_SCAN = 8_000
export const MAX_GOLDRUSH_CALLS_PER_SCAN = 150
// Sub-cap, DISCLOSED: historical PRICING specifically is the runaway path the audit measured (1,045
// calls, 0 accepted). It gets its own tighter ceiling inside the overall GoldRush budget, so a
// pathological pricing fan-out can never starve the scan's own structural GoldRush needs
// (transaction history, balances) of their handful of calls.
export const MAX_GOLDRUSH_PRICING_CALLS_PER_SCAN = 80

// TRANSACTION-HISTORY RESERVATION, DISCLOSED (Alchemy-history-ingestion-regression task, explicit
// requirement: "reserve transaction-history CU before optional receipt/pricing/debug calls" /
// "transaction history must have higher priority than receipts, historical price shadows,
// recovery, optional diagnostics"). Only two call sites ever consume from the Alchemy budget today
// — providerFetchWindow's own structural per-chain history pull (stage 'transaction_history') and
// recoveryPolicy's targeted per-candidate pull (stage 'recovery', scales with candidate count). A
// non-'transaction_history' Alchemy request may only spend up to this reserved floor BELOW the
// hard ceiling — guaranteeing the structural history fetch always has at least this much headroom
// left, no matter how many recovery candidates ran first or how the two concurrent engines (old
// pipeline, V2) happen to interleave. Sized for every SupportedChain's own from+to pull
// (base/eth/arbitrum/hyperevm x 2 directions x 150 CU = 1,200) with one full chain of additional
// headroom for retries after a transient-failure eviction (see providerFetchWindow/index.ts's own
// isReuseEligible).
export const ALCHEMY_TRANSACTION_HISTORY_RESERVED_CU = 1_500

type ProviderCounters = {
  calls: number
  estimatedCost: number
  callsByEndpoint: Map<string, number>
  callsByChain: Map<string, number>
  callsByStage: Map<string, number>
  pagesFetched: number
  duplicateCallsPrevented: number
  cappedCalls: number
  resultUsed: number
  resultUnused: number
}

function emptyProviderCounters(): ProviderCounters {
  return {
    calls: 0,
    estimatedCost: 0,
    callsByEndpoint: new Map(),
    callsByChain: new Map(),
    callsByStage: new Map(),
    pagesFetched: 0,
    duplicateCallsPrevented: 0,
    cappedCalls: 0,
    resultUsed: 0,
    resultUnused: 0,
  }
}

type LedgerState = {
  alchemy: ProviderCounters
  goldrush: ProviderCounters
  goldrushPricingCalls: number
  requestHits: number
  singleflightHits: number
  negativeCacheHits: number
}

function emptyState(): LedgerState {
  return {
    alchemy: emptyProviderCounters(),
    goldrush: emptyProviderCounters(),
    goldrushPricingCalls: 0,
    requestHits: 0,
    singleflightHits: 0,
    negativeCacheHits: 0,
  }
}

let state: LedgerState = emptyState()

// SCAN-BOUNDARY RESET, DISCLOSED: called once per scan job (walletScanWorker.ts), the same
// convention every other request-scoped provider budget/cache in this pipeline already uses — a
// warm serverless instance serving a second, unrelated scan must start fresh rather than inherit
// the previous scan's exhausted budget.
export function resetWalletProviderCostLedger(): void {
  state = emptyState()
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

export type ConsumeRequest = {
  provider: CostProvider
  // The real endpoint/method identifier — e.g. 'alchemy_getAssetTransfers',
  // 'goldrush_transactions_v3', 'goldrush_getTokenPrices'. Used verbatim for per-endpoint
  // attribution and, for Alchemy, to look up the published CU cost.
  endpoint: string
  chain: SupportedChain | 'multi' | 'unknown'
  stage: CostStage
  // True only for the historical-pricing path, which carries its own tighter GoldRush sub-cap.
  isPricing?: boolean
}

// PURE CHECK — never mutates. Reports whether one more call would fit under every applicable cap.
export function canConsume(request: ConsumeRequest): boolean {
  if (request.provider === 'alchemy') {
    if (state.alchemy.calls >= MAX_ALCHEMY_CALLS_PER_SCAN) return false
    // RESERVED FLOOR, DISCLOSED: a non-transaction_history request (today, only 'recovery') is
    // checked against the ceiling MINUS the reserved floor — it can never push cumulative Alchemy
    // spend past that reduced line, no matter how many recovery candidates are queued. The
    // structural transaction_history fetch itself is always checked against the FULL ceiling, so
    // it can spend into the reserved floor freely — that floor exists FOR it, not against it.
    const effectiveCeiling = request.stage === 'transaction_history'
      ? MAX_ALCHEMY_CU_PER_SCAN
      : MAX_ALCHEMY_CU_PER_SCAN - ALCHEMY_TRANSACTION_HISTORY_RESERVED_CU
    if (state.alchemy.estimatedCost + estimatedCuForMethod(request.endpoint) > effectiveCeiling) return false
    return true
  }
  if (state.goldrush.calls >= MAX_GOLDRUSH_CALLS_PER_SCAN) return false
  if (request.isPricing && state.goldrushPricingCalls >= MAX_GOLDRUSH_PRICING_CALLS_PER_SCAN) return false
  return true
}

// Reserves and records one real provider call. Returns false — recording a capped call, spending
// nothing — when any applicable cap is already reached. The ONLY function that may increment
// `calls`/`estimatedCost`; every real call site must gate on it and must not make the call at all
// when it returns false.
export function tryConsume(request: ConsumeRequest): boolean {
  const counters = request.provider === 'alchemy' ? state.alchemy : state.goldrush
  if (!canConsume(request)) {
    counters.cappedCalls += 1
    return false
  }

  counters.calls += 1
  counters.estimatedCost += request.provider === 'alchemy'
    ? estimatedCuForMethod(request.endpoint)
    : GOLDRUSH_CREDITS_PER_CALL
  bump(counters.callsByEndpoint, request.endpoint)
  bump(counters.callsByChain, String(request.chain))
  bump(counters.callsByStage, request.stage)
  if (request.provider === 'goldrush' && request.isPricing) state.goldrushPricingCalls += 1
  return true
}

// A real provider call that fetched one more page of a paginated endpoint. Recorded alongside (not
// instead of) the call itself, so `pagesFetched` never double-counts as a separate call.
export function recordPageFetched(provider: CostProvider, pages = 1): void {
  const counters = provider === 'alchemy' ? state.alchemy : state.goldrush
  counters.pagesFetched += pages
}

// A call that was NOT made because an existing cache entry, singleflight join, or deterministic
// short-circuit already had the answer. Never counted as a call — this is the direct measure of
// what this module's caching prevents.
export function recordDuplicatePrevented(provider: CostProvider, kind: 'request_cache' | 'singleflight' | 'negative_cache' | 'deterministic'): void {
  const counters = provider === 'alchemy' ? state.alchemy : state.goldrush
  counters.duplicateCallsPrevented += 1
  if (kind === 'request_cache' || kind === 'deterministic') state.requestHits += 1
  else if (kind === 'singleflight') state.singleflightHits += 1
  else state.negativeCacheHits += 1
}

// Whether a call that really happened produced a result the scan actually consumed. Recorded by the
// call site that knows the answer — never inferred here, and never assumed true.
export function recordCallOutcome(provider: CostProvider, used: boolean): void {
  const counters = provider === 'alchemy' ? state.alchemy : state.goldrush
  if (used) counters.resultUsed += 1
  else counters.resultUnused += 1
}

function mapToRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

export type WalletProviderCostAudit = {
  alchemy: {
    calls: number
    estimatedCu: number
    callsByEndpoint: Record<string, number>
    callsByChain: Record<string, number>
    callsByStage: Record<string, number>
    duplicateCallsPrevented: number
    cappedCalls: number
  }
  goldrush: {
    calls: number
    estimatedCredits: number
    callsByEndpoint: Record<string, number>
    callsByChain: Record<string, number>
    callsByStage: Record<string, number>
    pagesFetched: number
    duplicateCallsPrevented: number
    cappedCalls: number
  }
  cache: {
    requestHits: number
    singleflightHits: number
    negativeCacheHits: number
  }
  outputs: {
    callsWhoseResultWasUsed: number
    callsWhoseResultWasUnused: number
  }
}

// PURE snapshot — safe to call at any point during or after a scan.
export function getWalletProviderCostAudit(): WalletProviderCostAudit {
  return {
    alchemy: {
      calls: state.alchemy.calls,
      estimatedCu: state.alchemy.estimatedCost,
      callsByEndpoint: mapToRecord(state.alchemy.callsByEndpoint),
      callsByChain: mapToRecord(state.alchemy.callsByChain),
      callsByStage: mapToRecord(state.alchemy.callsByStage),
      duplicateCallsPrevented: state.alchemy.duplicateCallsPrevented,
      cappedCalls: state.alchemy.cappedCalls,
    },
    goldrush: {
      calls: state.goldrush.calls,
      estimatedCredits: state.goldrush.estimatedCost,
      callsByEndpoint: mapToRecord(state.goldrush.callsByEndpoint),
      callsByChain: mapToRecord(state.goldrush.callsByChain),
      callsByStage: mapToRecord(state.goldrush.callsByStage),
      pagesFetched: state.goldrush.pagesFetched,
      duplicateCallsPrevented: state.goldrush.duplicateCallsPrevented,
      cappedCalls: state.goldrush.cappedCalls,
    },
    cache: {
      requestHits: state.requestHits,
      singleflightHits: state.singleflightHits,
      negativeCacheHits: state.negativeCacheHits,
    },
    outputs: {
      callsWhoseResultWasUsed: state.alchemy.resultUsed + state.goldrush.resultUsed,
      callsWhoseResultWasUnused: state.alchemy.resultUnused + state.goldrush.resultUnused,
    },
  }
}

// console.warn, not console.log — next.config's compiler.removeConsole strips log/info/debug from
// the production build, and this diagnostic must survive in real deployment logs.
export function logWalletProviderCostAudit(): void {
  // eslint-disable-next-line no-console
  console.warn('[wallet-provider-cost-audit]', getWalletProviderCostAudit())
}

// TEST-SUPPORT EXPORT, DISCLOSED: same convention as every other reset helper in this pipeline.
export function __resetWalletProviderCostLedgerForTest(): void {
  resetWalletProviderCostLedger()
}
