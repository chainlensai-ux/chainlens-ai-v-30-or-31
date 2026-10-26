// HELIUS CREDIT ACCOUNTING (P0 cost-safety fix).
//
// Billing, per Helius's published credit table (helius.dev/docs/billing/credits, checked 2026-10-26):
//  - Standard RPC (getSignaturesForAddress, getAccountInfo, ...): 1 credit per request.
//  - Enhanced Transactions (legacy parse, POST /v0/transactions): 100 credits per CALL. The Helius
//    Enhanced Transactions FAQ states "each Enhanced Transaction API call uses 100 credits"; a batch
//    of signatures in one call is billed as one call.
//  - DAS (getTokenAccounts): 10 credits per request. Not stated in the snippets Helius's docs
//    returned to us — taken from a third-party summary, so treated as an estimate.
//
// Before this fix the deep paths reported `pagesFetched + 1` credits for a creator trace (the
// Enhanced call counted as 1, i.e. ~100x under) and did not report credits at all for funding traces
// or recent-launch parses.
//
// HeliusCreditLedger is a per-scan meter AND a hard cap: a request is charged when it is sent (Helius
// bills a sent request whether or not we can use the response), and a request that would push the
// ledger past its cap is never sent. Callers that do not pass a ledger get one capped at that single
// function's own worst case, so no Enhanced call anywhere can run unmetered or unbounded.

export const HELIUS_CREDIT_COST = {
  standard_rpc: 1,
  das: 10,
  enhanced_transactions: 100,
} as const

export type HeliusCreditKind = keyof typeof HELIUS_CREDIT_COST

export type HeliusCreditUsage = {
  capCredits: number
  spentCredits: number
  calls: Record<HeliusCreditKind, number>
  /** Requests NOT sent because they would have exceeded the cap. */
  refused: Record<HeliusCreditKind, number>
}

export class HeliusCreditLedger {
  readonly capCredits: number
  private spent = 0
  private readonly calls: Record<HeliusCreditKind, number> = { standard_rpc: 0, das: 0, enhanced_transactions: 0 }
  private readonly refused: Record<HeliusCreditKind, number> = { standard_rpc: 0, das: 0, enhanced_transactions: 0 }

  constructor(capCredits: number) {
    this.capCredits = Math.max(0, Math.floor(capCredits))
  }

  get spentCredits(): number { return this.spent }
  get remainingCredits(): number { return Math.max(0, this.capCredits - this.spent) }

  /** Charges one request of `kind` if it fits under the cap. False = do not send the request. */
  tryCharge(kind: HeliusCreditKind): boolean {
    const cost = HELIUS_CREDIT_COST[kind]
    if (this.spent + cost > this.capCredits) {
      this.refused[kind] += 1
      return false
    }
    this.spent += cost
    this.calls[kind] += 1
    return true
  }

  usage(): HeliusCreditUsage {
    return { capCredits: this.capCredits, spentCredits: this.spent, calls: { ...this.calls }, refused: { ...this.refused } }
  }
}

/** Cross-request cache for deep-check reads (immutable on-chain facts only). */
export type HeliusDeepCache = {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>
}

/** Per-scan context for every Helius call that costs more than a standard RPC request. */
export type HeliusDeepContext = {
  ledger: HeliusCreditLedger
  cache?: HeliusDeepCache | null
}

export const HELIUS_CREDIT_BUDGET_EXHAUSTED = 'helius_credit_budget_exhausted'

// ── Enhanced Transactions concurrency ────────────────────────────────────────────────────────────
// Helius rate-limits Enhanced Transactions far below standard RPC (2 req/s on the free plan). At most
// this many Enhanced requests are in flight per server instance; the rest queue. Cross-instance load
// is bounded by the per-user lock and the global daily budget (solanaDeepCheckBudget.ts).
export const HELIUS_ENHANCED_MAX_CONCURRENT = 2

let enhancedInFlight = 0
const enhancedWaiters: Array<() => void> = []

export async function withHeliusEnhancedSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (enhancedInFlight >= HELIUS_ENHANCED_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => enhancedWaiters.push(resolve))
  } else {
    enhancedInFlight += 1
  }
  try {
    return await fn()
  } finally {
    const next = enhancedWaiters.shift()
    if (next) next() // the slot passes straight to the next waiter
    else enhancedInFlight -= 1
  }
}

export function __heliusEnhancedInFlightForTest(): number {
  return enhancedInFlight
}
