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
}

export type AcquireReceiptsResult = {
  logsByTxHash: Map<string, RawReceiptLog[]>
  counters: ReceiptAcquisitionCounters
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

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

// PURE with respect to control flow beyond the injected fetcher — no retries, no receipt-fetch
// call this function didn't explicitly make, no mutation of `candidates`/`requestScope` beyond the
// documented cache/inFlight bookkeeping.
export async function acquireReceiptsForCandidates(input: AcquireReceiptsInput): Promise<AcquireReceiptsResult> {
  const maxLiveCalls = input.maxLiveCalls ?? DEFAULT_MAX_LIVE_CALLS
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const receiptCandidatesTotal = input.candidates.length
  const selectedForFetch = input.candidates.slice(0, maxLiveCalls)
  const receiptCandidatesCapped = Math.max(0, receiptCandidatesTotal - selectedForFetch.length)

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
      case 'ok':
        logsByTxHash.set(candidate.txHash, outcome.logs)
        break
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
  // this scale (at most maxLiveCalls candidates ever reach this loop).
  for (const batch of chunk(selectedForFetch, concurrency)) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map(processOne))
  }

  return {
    logsByTxHash,
    counters: {
      receiptCandidatesTotal,
      receiptCandidatesSelected: selectedForFetch.length,
      receiptCandidatesCapped,
      receiptCacheHits: cacheHits,
      receiptSingleflightHits: singleflightHits,
      receiptLiveCalls: liveCalls,
      receiptTimeouts: timeouts,
      receiptMissingResults: missing,
      receiptMalformed: malformed,
      receiptReverted: reverted,
      receiptProviderCalls: liveCalls,
    },
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
