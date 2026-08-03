// MODULE — walletSnapshot: request-scoped Alchemy call budget for lib/server/walletSnapshot.ts.
//
// SCOPE, DISCLOSED: this is the dev-wallet / token-intelligence surface (app/api/dev-wallet,
// app/api/wallet-scanner), a SEPARATE product surface from the PnL wallet-scan pipeline
// (src/pipeline/**, src/modules/providerFetchWindow/**) — it has its own Alchemy usage, its own
// request lifecycle, and is audited/fixed independently per this task's explicit scope. Nothing
// here touches the PnL pipeline's own provider budget (src/modules/providerCost).
//
// FINDING, DISCLOSED: walletSnapshot.ts's own header already confirms `alchemyRpc` is the ONLY
// function in the file that makes a real Alchemy RPC call — every one of its 12 call sites routes
// through it. A separate, more elaborate budget system already exists in this file
// (lib/server/walletProviders/budget.ts's canUseWalletProviderCall, wired via
// _authorizeWalletProviderCall/_trackGatewayProviderCall) — but its `allowed` decision is computed
// and recorded into an audit log at every call site, and NEVER CHECKED before the real call
// proceeds. It observes; it does not enforce. This module is the actual enforcement point, added
// at the one real choke point instead of retrofitting 12+ scattered call sites (some of which,
// like getSharedTxReceipt/getFirstTxOnChain, are module-level helpers outside that system's
// closure entirely and have no budget check of any kind today).
//
// ALSO PROVEN, DISCLOSED: fetchAlchemyPnlEvents(address, baseUrl) is called from two structurally
// independent, non-mutually-exclusive branches (the GoldRush-partial-result fallback and the
// full-recovery buy-timeline fallback) with byte-identical arguments — a real, reachable duplicate
// this module's settled-result reuse eliminates for free, at the same choke point, with no per-call-
// site change needed.
//
// FAIL CLOSED, DISCLOSED: when the budget is exhausted, `alchemyRpc` returns `null` — the exact
// same value it already returns for "no result" (see its own `json.result ?? null`). Every one of
// its 12 callers already treats a null/empty result as "no data" (try/catch, `?? []`, `?.transfers
// ?? []`), so this never changes an existing consumer's error-handling shape — it only ever makes
// an already-handled "no data" outcome happen without a wasted network call.

import { estimatedCuForMethod } from './alchemyCallBudget'

// HARD CAPS, DISCLOSED. Not env-configurable, for the same reason as the PnL pipeline's own
// provider budget: a containment ceiling a stray environment variable could loosen is not a
// ceiling. Sized from this file's own pre-existing (advisory-only) expectations —
// ALCHEMY_RECEIPT_CALL_CAP=36 and ALCHEMY_NON_RECEIPT_CALL_BASELINE=8 are already the numbers this
// file's own diagnostics warn against exceeding — with headroom above their sum (44) for the
// genuinely bounded pagination paths (fetchAlchemyBaseTransfersPaginated: maxPages<=5 x 2
// directions, runTargetedUnmatchedSellBackfill: maxPagesTotal<=4 per invocation, called at most
// twice per request against disjoint token sets).
export const MAX_ALCHEMY_CALLS_PER_SCAN = 90
// CU CEILING, DISCLOSED: sized to actually bind on a runaway alchemy_getAssetTransfers loop (150
// CU each) rather than being decoration the call cap always reaches first — 90 calls x 150 CU
// would be 13,500; this ceiling stops that specific shape at ~33 calls, well before the call cap,
// while comfortably covering this file's real receipt-heavy floor (36 receipts x 15 CU = 540, plus
// the handful of getAssetTransfers/nonce/behavior calls a healthy request actually makes).
export const MAX_ALCHEMY_CU_PER_SCAN = 5_000

type BudgetState = {
  callsUsed: number
  cuUsed: number
  cappedCalls: number
  callsByMethod: Map<string, number>
  requestCacheHits: number
  singleflightHits: number
  settled: Map<string, unknown>
  inFlight: Map<string, Promise<unknown>>
}

function emptyState(): BudgetState {
  return {
    callsUsed: 0,
    cuUsed: 0,
    cappedCalls: 0,
    callsByMethod: new Map(),
    requestCacheHits: 0,
    singleflightHits: 0,
    settled: new Map(),
    inFlight: new Map(),
  }
}

let state = emptyState()

// SCAN-BOUNDARY RESET, DISCLOSED: called once per snapshot request (see the real call site in
// walletSnapshot.ts's own request-entry function) — a warm serverless instance serving a second,
// unrelated request must start with a fresh budget, never inherit the previous request's spend or
// settled-result cache (a stale wallet's transfer history must never be served to a different
// wallet's request).
export function resetWalletSnapshotAlchemyBudget(): void {
  state = emptyState()
}

// DETERMINISTIC KEY, DISCLOSED: (url, method, params) fully determines an Alchemy RPC request's
// real response — JSON.stringify is stable here because every real call site builds its params
// object as a fresh literal with the same fixed key order every time it runs (verified by reading
// all 12 call sites), so two calls with truly identical arguments always produce identical JSON,
// and two calls that differ in even one param (a different pageKey, a different address) always
// produce different JSON. Never a false-positive collision.
function requestKey(url: string, method: string, params: unknown[]): string {
  return `${url}:${method}:${JSON.stringify(params)}`
}

export type WalletSnapshotAlchemyCostDiagnostics = {
  callsUsed: number
  estimatedCu: number
  maxCalls: number
  maxEstimatedCu: number
  cappedCalls: number
  callsByMethod: Record<string, number>
  requestCacheHits: number
  singleflightHits: number
}

// PURE snapshot — safe to call at any point during or after a request.
export function getWalletSnapshotAlchemyCostDiagnostics(): WalletSnapshotAlchemyCostDiagnostics {
  return {
    callsUsed: state.callsUsed,
    estimatedCu: state.cuUsed,
    maxCalls: MAX_ALCHEMY_CALLS_PER_SCAN,
    maxEstimatedCu: MAX_ALCHEMY_CU_PER_SCAN,
    cappedCalls: state.cappedCalls,
    callsByMethod: Object.fromEntries([...state.callsByMethod.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    requestCacheHits: state.requestCacheHits,
    singleflightHits: state.singleflightHits,
  }
}

// The ONLY function that may spend from this budget or serve a memoized result. `fetcher` is the
// real network call (the caller's own `fetch(...)`) — invoked AT MOST ONCE per distinct
// (url, method, params), and NEVER invoked at all once the budget is exhausted. Returns the same
// shape `fetcher` would: its resolved value, or `null` on budget exhaustion (fail-closed — never a
// thrown error, matching alchemyRpc's own existing "no result" contract).
export async function budgetedAlchemyCall<T>(
  url: string,
  method: string,
  params: unknown[],
  fetcher: () => Promise<T>,
): Promise<T | null> {
  const key = requestKey(url, method, params)

  const settled = state.settled.get(key)
  if (settled !== undefined) {
    state.requestCacheHits += 1
    return settled as T
  }

  const inFlight = state.inFlight.get(key)
  if (inFlight) {
    state.singleflightHits += 1
    return inFlight as Promise<T>
  }

  // NO RETRIES, DISCLOSED: this module makes exactly one attempt per distinct request and never
  // re-attempts it itself. A thrown rejection propagates to the caller's own existing try/catch
  // (every one of the 12 call sites already has one) and is deliberately NOT memoized — the same
  // "never cache a transient failure as a negative result" convention this codebase already uses
  // elsewhere (see goldrushPriceSource.ts's negative cache, which caches genuine misses but never
  // thrown errors), so a later duplicate request gets a fresh real attempt rather than being
  // permanently stuck behind one transient hiccup.
  const cost = estimatedCuForMethod(method)
  if (state.callsUsed >= MAX_ALCHEMY_CALLS_PER_SCAN || state.cuUsed + cost > MAX_ALCHEMY_CU_PER_SCAN) {
    state.cappedCalls += 1
    return null
  }

  state.callsUsed += 1
  state.cuUsed += cost
  state.callsByMethod.set(method, (state.callsByMethod.get(method) ?? 0) + 1)

  const promise = (async (): Promise<T> => {
    const result = await fetcher()
    state.settled.set(key, result)
    return result
  })()

  state.inFlight.set(key, promise)
  try {
    return await promise
  } finally {
    state.inFlight.delete(key)
  }
}

// TEST-SUPPORT EXPORT, DISCLOSED: same convention as every other reset helper in this pipeline.
export function __resetWalletSnapshotAlchemyBudgetForTest(): void {
  resetWalletSnapshotAlchemyBudget()
}
