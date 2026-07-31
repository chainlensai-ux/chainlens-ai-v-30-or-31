// MODULE — receiptSwapDecoder: permanent receipt cache.
//
// GOAL, DISCLOSED (Phase 2 — explicit "permanent receipt cache" requirement): a real, mined
// transaction receipt for a specific (chain, txHash) is IMMUTABLE — its logs can never change once
// the transaction is confirmed. Every prior pass of this module kept `ReceiptRequestScopeCache`
// strictly request-scoped (cleared at the start of every scan — see receiptAcquisition.ts's own
// header), so a wallet rescanned on a warm serverless instance always re-fetched the exact same
// receipts it fetched last time. This module is a process-lifetime cache of ACCEPTED ('ok') receipts
// only, following the same convention already established for immutable historical data elsewhere in
// this codebase (src/modules/nativePriceResolver's acceptedPriceByBucket): only a genuine SUCCESS is
// remembered permanently; a miss/timeout/malformed/reverted outcome is never cached beyond the scan
// that observed it (a transient RPC hiccup must never become a permanent blind spot for a real,
// existing receipt).
//
// NEVER A NEW PROVIDER CALL, DISCLOSED: this module makes no network calls of its own — it only
// stores/reads what receiptAcquisition.ts's real fetcher already retrieved, and is consulted by
// SEEDING it into that module's existing request-scoped cache before acquisition runs (a seeded entry
// is a real cache hit, not a live call — the exact mechanism receiptAcquisition.ts's own
// ReceiptRequestScopeCache already documents).

import type { RawReceiptLog } from './types'
import type { ReceiptFetchOutcome, ReceiptRequestScopeCache } from './receiptAcquisition'
import { receiptCacheKey } from './receiptAcquisition'

const permanentReceiptCache = new Map<string, RawReceiptLog[]>()

export function permanentReceiptCacheSize(): number {
  return permanentReceiptCache.size
}

// TEST-SUPPORT ONLY, DISCLOSED: same reasoning as nativePriceResolver's own
// __resetNativePriceResolverForTest — production code has no path to discard a known-good, immutable
// receipt mid-run; tests need a clean slate between cases.
export function __resetPermanentReceiptCacheForTest(): void {
  permanentReceiptCache.clear()
}

// Copies every permanently-cached receipt into `requestScope` as a real 'ok' outcome, BEFORE
// acquisition runs. A candidate whose receipt is already known this way costs zero live calls this
// scan — acquireReceiptsForCandidates's own cache-hit accounting handles the rest unmodified.
export function seedPermanentReceiptsIntoRequestScope(requestScope: ReceiptRequestScopeCache, candidates: readonly { chain: string; txHash: string }[]): number {
  let seeded = 0
  for (const candidate of candidates) {
    const key = receiptCacheKey(candidate.chain, candidate.txHash)
    if (requestScope.cache.has(key)) continue
    const logs = permanentReceiptCache.get(key)
    if (!logs) continue
    requestScope.cache.set(key, { status: 'ok', logs })
    seeded += 1
  }
  return seeded
}

// After acquisition, promotes every freshly-'ok' entry already sitting in the request-scope cache
// into the permanent cache — idempotent (re-storing an already-permanent entry is a no-op) and never
// stores a miss/timeout/malformed/reverted outcome.
export function recordPermanentReceiptsFromRequestScope(requestScope: ReceiptRequestScopeCache): number {
  let recorded = 0
  for (const [key, outcome] of requestScope.cache) {
    if (outcome.status !== 'ok') continue
    if (permanentReceiptCache.has(key)) continue
    permanentReceiptCache.set(key, outcome.logs)
    recorded += 1
  }
  return recorded
}

// TEST-SUPPORT ONLY, DISCLOSED: direct read, so a test can assert a specific entry was actually
// stored without depending on seedPermanentReceiptsIntoRequestScope's own candidate-list plumbing.
export function __getPermanentReceiptCacheEntryForTest(chain: string, txHash: string): ReceiptFetchOutcome | null {
  const logs = permanentReceiptCache.get(receiptCacheKey(chain, txHash))
  return logs ? { status: 'ok', logs } : null
}
