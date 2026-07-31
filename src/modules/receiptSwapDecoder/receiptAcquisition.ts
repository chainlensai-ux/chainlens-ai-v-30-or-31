// MODULE — receiptSwapDecoder: bounded Base receipt acquisition.
//
// GOAL, DISCLOSED: every prior pass of this shadow-mode feature deliberately never fetched a
// receipt (logsByTxHash was always an empty Map in production, honestly counted as
// receiptsMissing). This module is the first that ACTUALLY fetches — but tightly bounded: at most
// 10 live eth_getTransactionReceipt calls per scan, concurrency capped at 3, no retries, a per-call
// timeout, and a request-scoped cache + singleflight keyed by chain:txHash so the same transaction
// is never fetched twice within one scan. Still shadow-mode only: acquired logs feed
// decodeReceiptSwap for observability — never normalizedEvents/FIFO/pricing/PnL/router inference/
// public output.
//
// FAIL-CLOSED, DISCLOSED: a reverted, missing, malformed, or timed-out receipt is never treated as
// available — it is counted under its own real reason and simply excluded from `logsByTxHash`,
// exactly like "receipt genuinely absent" in every prior pass.

import type { RawReceiptLog } from './types'
import type { SelectedCandidate } from './candidateSelector'
import { getSharedBaseClient } from './rpcClient'
import { decodeLogs } from './decodeLogs'

export type ReceiptFetchOutcome =
  | { status: 'ok'; logs: RawReceiptLog[] }
  | { status: 'missing' }
  | { status: 'reverted' }
  | { status: 'malformed' }
  | { status: 'timeout' }

export type ReceiptFetcher = (chain: 'base', txHash: string) => Promise<ReceiptFetchOutcome>

export type ReceiptRequestScopeCache = {
  // Keyed by `${chain}:${txHash.toLowerCase()}`. Pre-seeding an entry here (e.g. a receipt already
  // fetched elsewhere in this same request) is exactly "reuse any receipt already in request
  // scope" — it counts as a cache hit and never triggers a live call.
  cache: Map<string, ReceiptFetchOutcome>
  inFlight: Map<string, Promise<ReceiptFetchOutcome>>
}

export function createReceiptRequestScopeCache(): ReceiptRequestScopeCache {
  return { cache: new Map(), inFlight: new Map() }
}

export function receiptCacheKey(chain: string, txHash: string): string {
  return `${chain}:${txHash.toLowerCase()}`
}

const DEFAULT_MAX_LIVE_CALLS = 10
const DEFAULT_CONCURRENCY = 3
const DEFAULT_TIMEOUT_MS = 4000

// TIER-DIVERSIFIED SELECTION, DISCLOSED (this task — production proof: a scan selected 7 tier-3
// verified-quote candidates and only 3 tier-4 known/high-confidence-router candidates, recovered no
// exact swap, and FIFO replay correctly had nothing to replay). A plain "first N in priority order"
// selection lets an abundant tier (3) exhaust the whole 10-call budget before a scarcer-but-equally
// useful tier (4) ever gets a chance, purely because 3 sorts ahead of 4 — never because tier 4 was
// actually less promising. Reserving up to 5 calls for EACH of tier 3 and tier 4 guarantees both
// classes get real coverage whenever candidates exist for them, while an abundant tier can still
// backfill unused capacity from a genuinely scarce one (never idle capacity, never a forced 5/5 when
// one side has fewer real candidates than its own quota).
//
// SCOPE, DISCLOSED: this changes ONLY which of the already-eligible, already-selected (by
// candidateSelector.ts) candidates get a receipt FETCHED first — never eligibility, never the
// selector's own priority/ordering logic, never the 10-call cap, never introduces any new signal.
// Tiers 1 and 2 (missing-closed-lot-side, existing-swap-candidate) always come first, unlimited —
// they are strictly higher-priority than the tier-3/4 quota split and simply shrink the pool the
// quota draws from. Tier 5 (economic-value-only) fills any capacity left over after 1/2/3/4.
const TIER_3_QUOTA = 5
const TIER_4_QUOTA = 5

export type ReceiptTierSelection = {
  selected: SelectedCandidate[]
  selectedByTier: Record<1 | 2 | 3 | 4 | 5, number>
  skippedByTierQuota: Record<3 | 4, number>
  quotaBackfilled: number
}

// PURE, deterministic — no randomness, no rotation. `candidates` is assumed already sorted by
// candidateSelector.ts (priority tier ascending, economic value descending, chain+txHash
// tie-break) — this function only regroups by tier and re-slices; it never reorders within a tier,
// so that ordering is preserved exactly.
export function selectReceiptFetchCandidates(candidates: readonly SelectedCandidate[], maxLiveCalls: number): ReceiptTierSelection {
  const byTier: Record<1 | 2 | 3 | 4 | 5, SelectedCandidate[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] }
  for (const c of candidates) byTier[c.priorityTier].push(c)

  const selected: SelectedCandidate[] = []
  const selectedByTier: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let remaining = maxLiveCalls

  // Tiers 1 and 2 always come first, unlimited (beyond the overall cap) — they reduce the capacity
  // the tier-3/4 quota split draws from, per this task's explicit "reduce both quotas" rule.
  for (const tier of [1, 2] as const) {
    const take = Math.min(byTier[tier].length, remaining)
    selected.push(...byTier[tier].slice(0, take))
    selectedByTier[tier] = take
    remaining -= take
  }

  const capacityForTier34 = remaining
  let take3 = Math.min(TIER_3_QUOTA, byTier[3].length, capacityForTier34)
  let leftover = capacityForTier34 - take3
  let take4 = Math.min(TIER_4_QUOTA, byTier[4].length, leftover)
  leftover -= take4

  // BACKFILL, DISCLOSED: tier 3 (the higher-priority of the two) gets first claim on any capacity
  // left unused because the OTHER tier ran out of real candidates; tier 4 gets whatever is left
  // after that. Never randomized, never rotated — purely a function of how many real candidates
  // each tier actually has this scan.
  const backfill3 = Math.min(byTier[3].length - take3, leftover)
  take3 += backfill3
  leftover -= backfill3
  const backfill4 = Math.min(byTier[4].length - take4, leftover)
  take4 += backfill4
  leftover -= backfill4

  selected.push(...byTier[3].slice(0, take3))
  selectedByTier[3] = take3
  selected.push(...byTier[4].slice(0, take4))
  selectedByTier[4] = take4
  remaining = leftover

  // Tier 5 (economic-value-only) fills any capacity still left over after 1/2/3/4.
  const take5 = Math.min(byTier[5].length, remaining)
  selected.push(...byTier[5].slice(0, take5))
  selectedByTier[5] = take5

  return {
    selected,
    selectedByTier,
    skippedByTierQuota: {
      3: byTier[3].length - take3,
      4: byTier[4].length - take4,
    },
    quotaBackfilled: backfill3 + backfill4,
  }
}

export type AcquireReceiptsInput = {
  // Already priority-sorted by candidateSelector — "first N" here means highest-priority first.
  candidates: readonly SelectedCandidate[]
  fetcher: ReceiptFetcher
  requestScope: ReceiptRequestScopeCache
  maxLiveCalls?: number
  concurrency?: number
  timeoutMs?: number
}

export type ReceiptAcquisitionCounters = {
  receiptCandidatesTotal: number
  receiptCandidatesSelected: number
  receiptCandidatesCapped: number
  receiptCacheHits: number
  receiptSingleflightHits: number
  receiptLiveCalls: number
  receiptTimeouts: number
  receiptMissingResults: number
  receiptMalformed: number
  receiptReverted: number
  // Real live network calls this acquisition actually issued — cache/singleflight hits are NOT
  // provider calls. Always <= maxLiveCalls (10 by default).
  receiptProviderCalls: number
  // NEGATIVE EVIDENCE, DISCLOSED — see acquireReceiptsForCandidates's own header: how many
  // not-yet-fetched, quota-selected slots this scan swapped out (for a not-yet-selected, capped
  // candidate) because an EARLIER receipt fetched THIS SAME scan, sharing that slot's inferred
  // token pair, already proved plain_transfer_no_swap_event (no recognized pool-swap event at
  // all). Never a retry, never a new provider call — the replacement candidate is fetched exactly
  // once, same as any originally-selected candidate.
  receiptQuotaSubstitutions: number
}

export type AcquireReceiptsResult = {
  logsByTxHash: Map<string, RawReceiptLog[]>
  counters: ReceiptAcquisitionCounters
  // TIER DIVERSIFICATION, DISCLOSED — see selectReceiptFetchCandidates's own header.
  receiptSelectedByPriorityTier: Record<1 | 2 | 3 | 4 | 5, number>
  receiptCandidatesSkippedByTierQuota: Record<3 | 4, number>
  receiptQuotaBackfilled: number
}

// PURE, DISCLOSED (root-cause fix — production proof: receiptQuotaSubstitutions stayed 0 on a real
// scan whose selected set was dominated by tier 3/4's own `legs.length === 1` eligibility path,
// i.e. candidates that qualify PRECISELY because only one side is known pre-fetch). The original
// version required BOTH tokenIn and tokenOut to be non-null, returning null otherwise — but a
// single-leg candidate (missingSide 'tokenIn' or 'tokenOut') can NEVER carry both, so it could
// never be added to `negativeEvidence` after decoding to a plain transfer, and could never be
// matched against as a substitution candidate either. Since single-leg candidates are exactly the
// weak-evidence, router-touch-only pattern this whole mechanism exists to displace, the negative-
// evidence set was silently inert for the dominant real-world case. Fixed: when exactly one side is
// known, key on that single known token alone (`single:<token>`, distinct prefix so it can never
// collide with a real two-sided pair key) — still order-independent (a single value has no order),
// still never infers protocol/venue from anything beyond the token address candidateSelector.ts's
// own inferTokensFromLegs already computed. `null` only when NEITHER side is known (nothing to key
// by at all).
function tokenPairKey(tokenIn: string | null, tokenOut: string | null): string | null {
  if (tokenIn && tokenOut) {
    const [a, b] = [tokenIn.toLowerCase(), tokenOut.toLowerCase()].sort()
    return `${a}:${b}`
  }
  const single = tokenIn ?? tokenOut
  if (single) return `single:${single.toLowerCase()}`
  return null
}

// NO RETRIES, DISCLOSED: a single attempt per key. If it times out or errors, the outcome is
// recorded and this key is never attempted again within this call — a future scan gets a fresh
// attempt, but this scan fails closed for that transaction.
function withTimeout(promise: Promise<ReceiptFetchOutcome>, timeoutMs: number): Promise<ReceiptFetchOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ status: 'timeout' })
    }, timeoutMs)
    promise.then(
      (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: 'malformed' })
      },
    )
  })
}

// NEGATIVE-EVIDENCE SUBSTITUTION, DISCLOSED (production proof: 25 eligible, 10 fetched, 8/10 ended
// plain_transfer_no_swap_event, 0 exact swaps recovered): purely quota-based tier selection cannot
// see, mid-scan, that a receipt it already fetched proved a given token-pair pattern is NOT a swap
// (no recognized pool-swap-shaped event at all — never a protocol/venue inference, just presence/
// absence). Once that's known, spending ANOTHER of the fixed 10 slots on a not-yet-fetched,
// still-queued candidate sharing that exact pattern is a proven waste this scan can now avoid: it
// is swapped out for the next-priority CAPPED candidate instead (never re-attempting the
// already-fetched one, never retrying, never exceeding the original slot count). A capped candidate
// that itself already matches known-negative evidence is skipped over, never selected as a
// replacement.
//
// PURE with respect to control flow beyond the injected fetcher — no retries, no receipt-fetch call
// this function didn't explicitly make, no mutation of `candidates`/`requestScope` beyond the
// documented cache/inFlight bookkeeping.
export async function acquireReceiptsForCandidates(input: AcquireReceiptsInput): Promise<AcquireReceiptsResult> {
  const maxLiveCalls = input.maxLiveCalls ?? DEFAULT_MAX_LIVE_CALLS
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const receiptCandidatesTotal = input.candidates.length
  const tierSelection = selectReceiptFetchCandidates(input.candidates, maxLiveCalls)
  const selectedForFetch = tierSelection.selected
  const receiptCandidatesCapped = Math.max(0, receiptCandidatesTotal - selectedForFetch.length)

  const selectedKeys = new Set(selectedForFetch.map((c) => receiptCacheKey(c.chain, c.txHash)))
  const reserve = input.candidates.filter((c) => !selectedKeys.has(receiptCacheKey(c.chain, c.txHash)))
  let reserveIndex = 0
  const negativeEvidence = new Set<string>()
  let quotaSubstitutions = 0

  // The fixed-size, mutable queue of slots actually fetched this scan — its LENGTH never changes
  // (still exactly `selectedForFetch.length`, never more than maxLiveCalls), only individual
  // not-yet-processed entries may be substituted before their batch runs.
  const queue = [...selectedForFetch]

  function substituteIfNegativelyEvidenced(index: number): void {
    const candidate = queue[index]
    const key = tokenPairKey(candidate.inferredTokenIn, candidate.inferredTokenOut)
    if (!key || !negativeEvidence.has(key)) return
    while (reserveIndex < reserve.length) {
      const replacement = reserve[reserveIndex]
      reserveIndex += 1
      const replacementKey = tokenPairKey(replacement.inferredTokenIn, replacement.inferredTokenOut)
      if (replacementKey && negativeEvidence.has(replacementKey)) continue
      queue[index] = replacement
      quotaSubstitutions += 1
      return
    }
  }

  const logsByTxHash = new Map<string, RawReceiptLog[]>()
  let cacheHits = 0
  let singleflightHits = 0
  let liveCalls = 0
  let timeouts = 0
  let missing = 0
  let malformed = 0
  let reverted = 0

  const { cache, inFlight } = input.requestScope

  async function processOne(candidate: SelectedCandidate): Promise<void> {
    const key = receiptCacheKey(candidate.chain, candidate.txHash)

    let outcome: ReceiptFetchOutcome
    if (cache.has(key)) {
      cacheHits += 1
      outcome = cache.get(key)!
    } else if (inFlight.has(key)) {
      singleflightHits += 1
      outcome = await inFlight.get(key)!
    } else {
      liveCalls += 1
      const promise = withTimeout(input.fetcher('base', candidate.txHash), timeoutMs)
      inFlight.set(key, promise)
      outcome = await promise
      inFlight.delete(key)
      cache.set(key, outcome)
    }

    switch (outcome.status) {
      case 'ok': {
        logsByTxHash.set(candidate.txHash, outcome.logs)
        // NEGATIVE EVIDENCE, DISCLOSED: pure, offline (zero provider calls) check for "does this
        // receipt contain ANY recognized pool-swap-shaped event at all" — never asserts WHICH
        // protocol/venue, only presence/absence, so this never infers protocol from a Swap topic.
        const decoded = decodeLogs(outcome.logs)
        if (decoded.swaps.length === 0) {
          const pairKey = tokenPairKey(candidate.inferredTokenIn, candidate.inferredTokenOut)
          if (pairKey) negativeEvidence.add(pairKey)
        }
        break
      }
      case 'timeout':
        timeouts += 1
        break
      case 'missing':
        missing += 1
        break
      case 'malformed':
        malformed += 1
        break
      case 'reverted':
        reverted += 1
        break
    }
  }

  // CONCURRENCY CAP, DISCLOSED: processed in fixed-size batches (never more than `concurrency` live
  // promises in flight at once) rather than an unbounded Promise.all — simple and sufficient at
  // this scale (at most maxLiveCalls candidates ever reach this loop). Substitution is checked
  // immediately before each batch runs, using negative evidence accumulated from every PRIOR batch
  // this same scan (never the batch about to run, which hasn't been fetched yet).
  for (let start = 0; start < queue.length; start += concurrency) {
    const end = Math.min(start + concurrency, queue.length)
    for (let i = start; i < end; i += 1) substituteIfNegativelyEvidenced(i)
    const batch = queue.slice(start, end)
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map(processOne))
  }

  const finalSelectedByTier: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const c of queue) finalSelectedByTier[c.priorityTier] += 1

  return {
    logsByTxHash,
    counters: {
      receiptCandidatesTotal,
      receiptCandidatesSelected: queue.length,
      receiptCandidatesCapped,
      receiptCacheHits: cacheHits,
      receiptSingleflightHits: singleflightHits,
      receiptLiveCalls: liveCalls,
      receiptTimeouts: timeouts,
      receiptMissingResults: missing,
      receiptMalformed: malformed,
      receiptReverted: reverted,
      receiptQuotaSubstitutions: quotaSubstitutions,
      receiptProviderCalls: liveCalls,
    },
    receiptSelectedByPriorityTier: finalSelectedByTier,
    receiptCandidatesSkippedByTierQuota: tierSelection.skippedByTierQuota,
    receiptQuotaBackfilled: tierSelection.quotaBackfilled,
  }
}

function toRawLogs(logs: readonly { address: string; topics: readonly string[]; data: string; logIndex: number | null }[]): RawReceiptLog[] {
  return logs.map((log, index) => ({
    logIndex: log.logIndex ?? index,
    address: log.address,
    topics: [...log.topics],
    data: log.data,
  }))
}

// Real, on-chain implementation — a single eth_getTransactionReceipt per call, via the shared Base
// client (rpcClient.ts). Never retried by this function itself (see withTimeout's own header) —
// retry-avoidance is the caller's (acquireReceiptsForCandidates') responsibility, and it never
// retries either.
export function createLiveBaseReceiptFetcher(): ReceiptFetcher {
  return async (_chain, txHash) => {
    const client = getSharedBaseClient()
    if (!client) return { status: 'malformed' }
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
      if (!receipt) return { status: 'missing' }
      if (receipt.status === 'reverted') return { status: 'reverted' }
      return { status: 'ok', logs: toRawLogs(receipt.logs) }
    } catch (err) {
      if (err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'TransactionReceiptNotFoundError') {
        return { status: 'missing' }
      }
      // Any other unexpected shape/provider error fails closed as malformed rather than throwing.
      return { status: 'malformed' }
    }
  }
}
