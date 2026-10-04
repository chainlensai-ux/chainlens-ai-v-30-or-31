// src/lib/dexscreenerRequestCache.ts — shared, request-scoped DexScreener cache/coalescer.
//
// CONFIRMED ROOT CAUSE, DISCLOSED (provider-call-audit follow-up task, real production evidence:
// far more than the intended 30 DexScreener /latest/dex/tokens calls in one scan, despite
// lib/engine/modules/pricing/fetchPricing.ts's own MAX_FALLBACK_TOKENS=30 cap): this codebase has
// TWO entirely separate, uncoordinated DexScreener implementations reachable from one wallet scan —
// src/modules/pricingAtTimeEngine/sources/dexscreener.ts (used by the historical pricing pass AND,
// via the exact same detailed function, by pnlReconciliation's recovery pass) and
// src/modules/pricing/utils.ts (used by fetchPricing.ts's current-holdings fallback, via
// src/modules/pricing's resolvePrices). Neither has ever known the other exists — capping ONE of
// them (as the earlier "bound and prioritize DexScreener fallback pricing" round did, correctly, for
// the holdings lane) does nothing to bound the OTHER, and a token requested by both lanes in the
// same scan fires two independent real HTTP calls for the identical, already-known answer.
//
// This module is the single shared choke point both lanes now route through — one real cache, one
// coalescer, one bounded budget for the non-holdings lanes, real per-caller diagnostics.
//
// FRESHNESS-SAFE KEYING, DISCLOSED: DexScreener only ever exposes CURRENT pair state (see
// dexscreener.ts's own header) — fetchDexscreenerPriceDetailed only returns a real value when the
// requested `timestamp` is within DEXSCREENER_FRESHNESS_TOLERANCE_MS of "now"; anything older
// always resolves to the identical "too old" rejection regardless of the exact timestamp value.
// Naively coalescing purely by (chain, token) — ignoring timestamp entirely — would risk a REAL,
// serious correctness bug: a "current" lookup (e.g. a holdings fallback call) populating the cache
// with a genuinely fresh price, then a LATER, genuinely-historical recovery lookup for the SAME
// token silently reusing that fresh price as if it were valid for a materially different, much
// older moment — exactly the "never use current-price guesses for historical PnL" rule this whole
// session has enforced. Keying by (chain, token, freshnessBucket) instead — where freshnessBucket
// is just "within the tolerance window" vs "not" — preserves the EXACT same real outcome
// fetchDexscreenerPriceDetailed's own gate already produces (every out-of-window timestamp gets the
// identical rejection either way; every in-window timestamp gets DexScreener's identical "now"
// answer either way), so coalescing is always safe, never a weakened gate.

import { AsyncLocalStorage } from 'node:async_hooks'
import { fetchDexscreenerPriceDetailed, DEXSCREENER_FRESHNESS_TOLERANCE_MS } from '../modules/pricingAtTimeEngine/sources/dexscreener'
import type { DexscreenerPriceResult } from '../modules/pricingAtTimeEngine/sources/dexscreener'
import type { SupportedChain } from '../modules/providerFetchWindow/types'

export type DexscreenerCaller = 'holdings' | 'historical'

// EXPLICIT BOUNDED BUDGET, DISCLOSED (this task's explicit requirement, "never allow unbounded
// DexScreener fanout"): applies ONLY to non-holdings ('historical', which also covers recovery —
// recovery reuses the exact same detailed pricing-router function) callers — the holdings lane
// keeps its own, separate, already-existing 30-token cap in fetchPricing.ts entirely unchanged,
// enforced upstream of this module (holdings never even reaches this budget gate for a
// budget-excluded token, since fetchPricing.ts never calls this module for one). Distinct from — and
// intentionally smaller in practice than — the per-token lookup cap pricingAtTimeEngine already
// enforces per distinct token; this is a REQUEST-WIDE ceiling across every distinct token the
// historical/recovery lane touches.
const HISTORICAL_DEXSCREENER_BUDGET_DEFAULT = 60

type CacheEntry = Promise<DexscreenerPriceResult>

type RequestState = {
  cache: Map<string, CacheEntry>
  liveFetchesByCaller: Record<string, number>
  cacheHitsByCaller: Record<string, number>
  budgetCappedByCaller: Record<string, number>
  uniqueTokens: Set<string>
  historicalBudget: number
  historicalBudgetUsed: number
}

function newRequestState(): RequestState {
  return { cache: new Map(), liveFetchesByCaller: {}, cacheHitsByCaller: {}, budgetCappedByCaller: {}, uniqueTokens: new Set(), historicalBudget: HISTORICAL_DEXSCREENER_BUDGET_DEFAULT, historicalBudgetUsed: 0 }
}

// JOB SCOPE (repeated-scan portfolio-value audit): this state was module-global, so two scan jobs overlapping
// on one warm instance shared it — job B's reset wiped job A's entries mid-scan, and a transient failure job A
// cached AFTER that reset (e.g. an http_429 for a dominant holding) was then served to job B as its own answer.
// A job run inside runInDexscreenerRequestScope gets its own state; outside any scope (tests, scripts) the
// process-level state below is used exactly as before.
const scopedState = new AsyncLocalStorage<RequestState>()
const processState = newRequestState()
const state = (): RequestState => scopedState.getStore() ?? processState

export function runInDexscreenerRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  return scopedState.run(newRequestState(), fn)
}

function freshnessBucket(timestamp: number): 'current' | 'stale' {
  return Math.abs(Date.now() - timestamp) <= DEXSCREENER_FRESHNESS_TOLERANCE_MS ? 'current' : 'stale'
}

function cacheKey(chain: SupportedChain, token: string, timestamp: number): string {
  return `${chain}:${token.toLowerCase()}:${freshnessBucket(timestamp)}`
}

// PER-JOB RESET, DISCLOSED: same established convention as every other request-scoped cache this
// session has added (providerFetchWindow, recoveryPolicy's historical-page lane) — called once per
// real scan job (walletScanWorker.ts) so nothing leaks across unrelated wallets/scans on a warm
// serverless instance. `historicalBudgetOverride` lets a caller with a real, disclosed reason use a
// different bound than the default — always still bounded, never unlimited.
export function resetDexscreenerRequestCache(historicalBudgetOverride?: number): void {
  const st = state()
  st.cache.clear()
  for (const k of Object.keys(st.liveFetchesByCaller)) delete st.liveFetchesByCaller[k]
  for (const k of Object.keys(st.cacheHitsByCaller)) delete st.cacheHitsByCaller[k]
  for (const k of Object.keys(st.budgetCappedByCaller)) delete st.budgetCappedByCaller[k]
  st.uniqueTokens.clear()
  st.historicalBudget = historicalBudgetOverride ?? HISTORICAL_DEXSCREENER_BUDGET_DEFAULT
  st.historicalBudgetUsed = 0
}

export type DexscreenerRequestDiagnostics = {
  dexLiveFetchesByCaller: Record<string, number>
  dexCacheHitsByCaller: Record<string, number>
  dexUniqueTokens: number
  dexBudgetCappedByCaller: Record<string, number>
}

export function getDexscreenerRequestDiagnostics(): DexscreenerRequestDiagnostics {
  const st = state()
  return {
    dexLiveFetchesByCaller: { ...st.liveFetchesByCaller },
    dexCacheHitsByCaller: { ...st.cacheHitsByCaller },
    dexUniqueTokens: st.uniqueTokens.size,
    dexBudgetCappedByCaller: { ...st.budgetCappedByCaller },
  }
}

// SHARED ENTRY POINT, DISCLOSED: every module that wants a DexScreener price — current-holdings
// fallback, historical pricing, recovery — calls this instead of reaching for
// fetchDexscreenerPriceDetailed/fetchDexscreenerPrice directly. A timeout/failure result is cached
// exactly like a success (fetchDexscreenerPriceDetailed already never throws — every failure path
// resolves to a real `{priceUsd: null, reason}`), so a later identical lookup within the same
// request reuses it instead of retrying the same endpoint — this task's explicit "a timeout result
// must also be reused within the request" requirement, now true for DexScreener specifically, not
// just the transaction-history lane.
export async function fetchDexscreenerPriceShared(
  token: string,
  chain: SupportedChain,
  timestamp: number,
  caller: DexscreenerCaller,
): Promise<DexscreenerPriceResult> {
  const st = state()
  const { cache, liveFetchesByCaller, cacheHitsByCaller, budgetCappedByCaller, uniqueTokens } = st
  const key = cacheKey(chain, token, timestamp)
  uniqueTokens.add(`${chain}:${token.toLowerCase()}`)

  const existing = cache.get(key)
  if (existing) {
    cacheHitsByCaller[caller] = (cacheHitsByCaller[caller] ?? 0) + 1
    return existing
  }

  if (caller !== 'holdings') {
    // Holdings keeps its own separate, already-enforced 30-token cap upstream — this gate only
    // ever applies to the historical/recovery lane, per this task's explicit requirement.
    if (st.historicalBudgetUsed >= st.historicalBudget) {
      budgetCappedByCaller[caller] = (budgetCappedByCaller[caller] ?? 0) + 1
      return { priceUsd: null, reason: 'dexscreener_shared_historical_budget_exhausted', pairAddress: null, dexId: null, liquidityUsd: null, pairAgeMs: null, quoteTokenSymbol: null, baseTokenSymbol: null, alternatePairs: [], winnerReason: null }
    }
    st.historicalBudgetUsed += 1
  }

  liveFetchesByCaller[caller] = (liveFetchesByCaller[caller] ?? 0) + 1
  const promise = fetchDexscreenerPriceDetailed(token, chain, timestamp)
  // Defensive cleanup only: fetchDexscreenerPriceDetailed is disclosed as never throwing — guards
  // against that contract ever being violated by a future change, so an unexpected rejection can't
  // permanently poison this key for the rest of the request.
  promise.catch(() => { if (cache.get(key) === promise) cache.delete(key) })
  cache.set(key, promise)
  return promise
}
