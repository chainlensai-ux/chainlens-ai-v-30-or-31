// MODULE — hard per-request Alchemy compute-unit (CU) budget + typed exhaustion reasons.
//
// CU-LEAK AUDIT, DISCLOSED (this task): a per-request cap that fails a caller closed with a typed
// reason once a request has consumed too many Alchemy calls or too much estimated CU — never a
// silent, unbounded loop, and never a fallback into another expensive Alchemy path once exhausted
// (see `AlchemyBudgetExhaustedReason` below). Pure, in-memory, request-scoped: a fresh budget is
// created per request/scan (see `createAlchemyCallBudget`), never shared/global — this module makes
// no calls of its own and never widens what an individual caller is otherwise allowed to do.
//
// CU COST TABLE, DISCLOSED: Alchemy's own published per-method compute-unit costs (Base/Ethereum
// mainnet tier, the tiers this codebase actually uses — see rpcClient.ts / lib/rpc.ts). Costs for
// methods this codebase doesn't call are intentionally omitted rather than guessed; an unlisted
// method falls back to `DEFAULT_ESTIMATED_CU` (a deliberately conservative, higher-than-typical
// estimate) so an unaudited method is never under-counted against the budget.

export const ALCHEMY_METHOD_CU_COSTS: Readonly<Record<string, number>> = {
  eth_blockNumber: 10,
  eth_chainId: 0,
  eth_call: 26,
  eth_getBalance: 19,
  eth_getCode: 19,
  eth_getStorageAt: 17,
  eth_getTransactionReceipt: 15,
  eth_getTransactionByHash: 17,
  eth_getLogs: 75,
  eth_getBlockByNumber: 16,
  eth_getBlockByHash: 16,
  alchemy_getAssetTransfers: 150,
  alchemy_getTokenBalances: 26,
  alchemy_getTokenMetadata: 22,
  alchemy_getTokenAllowance: 30,
  // Trace/debug methods are the most expensive category this codebase could ever call — flagged as
  // a distinct constant (rather than folded into DEFAULT_ESTIMATED_CU) so any future call site
  // that touches one is immediately visible as high-risk in review, never silently average-priced.
  trace_transaction: 250,
  trace_block: 250,
  debug_traceTransaction: 250,
  debug_traceBlockByNumber: 250,
} as const

export const DEFAULT_ESTIMATED_CU = 50

export function estimatedCuForMethod(method: string): number {
  return ALCHEMY_METHOD_CU_COSTS[method] ?? DEFAULT_ESTIMATED_CU
}

export type AlchemyBudgetExhaustedReason =
  | 'call_count_budget_exceeded'
  | 'estimated_cu_budget_exceeded'

export type AlchemyBudgetCheckResult =
  | { allowed: true }
  | { allowed: false; reason: AlchemyBudgetExhaustedReason; callsUsed: number; estimatedCuUsed: number }

export type AlchemyCallBudget = {
  // Returns whether one more call of `method` is allowed under this budget WITHOUT consuming it —
  // callers decide whether to actually proceed (this module never blocks a caller from checking
  // ahead of time, e.g. to choose a cheaper fallback within the SAME provider rather than falling
  // through to a different, potentially more expensive one).
  check(method: string): AlchemyBudgetCheckResult
  // Records that a call of `method` actually happened — must be called at most once per real call,
  // never speculatively, never for a cache hit (a cache hit makes no new provider call and must
  // never consume budget).
  record(method: string): void
  callsUsed(): number
  estimatedCuUsed(): number
  maxCalls(): number
  maxEstimatedCu(): number
}

export type AlchemyCallBudgetOptions = {
  maxCalls?: number
  maxEstimatedCu?: number
}

const DEFAULT_MAX_CALLS = 25
const DEFAULT_MAX_ESTIMATED_CU = 2000

// Fresh, request-scoped budget — never a module-level singleton (a shared/global budget would leak
// across unrelated requests and either falsely block a legitimate later request or, worse, let one
// request's exhaustion silently reset for the next).
export function createAlchemyCallBudget(options: AlchemyCallBudgetOptions = {}): AlchemyCallBudget {
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS
  const maxEstimatedCu = options.maxEstimatedCu ?? DEFAULT_MAX_ESTIMATED_CU
  let callsUsed = 0
  let estimatedCuUsed = 0

  return {
    check(method) {
      if (callsUsed >= maxCalls) {
        return { allowed: false, reason: 'call_count_budget_exceeded', callsUsed, estimatedCuUsed }
      }
      if (estimatedCuUsed + estimatedCuForMethod(method) > maxEstimatedCu) {
        return { allowed: false, reason: 'estimated_cu_budget_exceeded', callsUsed, estimatedCuUsed }
      }
      return { allowed: true }
    },
    record(method) {
      callsUsed += 1
      estimatedCuUsed += estimatedCuForMethod(method)
    },
    callsUsed: () => callsUsed,
    estimatedCuUsed: () => estimatedCuUsed,
    maxCalls: () => maxCalls,
    maxEstimatedCu: () => maxEstimatedCu,
  }
}
