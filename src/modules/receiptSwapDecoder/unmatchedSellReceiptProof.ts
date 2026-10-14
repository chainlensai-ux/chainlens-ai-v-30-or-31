// TARGETED RECEIPT PROOF FOR UNMATCHED SELLS. When RECEIPT_SWAP_CANONICAL_PROMOTION_ENABLED is off,
// the shadow receipt block runs after the response (setImmediate), so the boundary resolver used to
// see an empty receipt map. This fetches receipts ONLY for unmatched-sell txHashes that still have
// no proof, capped, through the same request-scope + permanent receipt cache and the same decoder.
// It only ever adds `exact_swap`, `plain_transfer_no_swap_event` or `lp_add_or_remove_detected`;
// any other outcome (timeout, missing, other rejection) adds nothing.

import { decodeReceiptSwap } from './index'
import { createReceiptRequestScopeCache, receiptCacheKey, type ReceiptFetcher, type ReceiptFetchOutcome } from './receiptAcquisition'
import { seedPermanentReceiptsIntoRequestScope, recordPermanentReceiptsFromRequestScope } from './permanentReceiptCache'
import type { PoolValidator } from './poolValidator'
import type { UniswapV3PoolValidator } from './uniswapV3PoolValidator'

export const MAX_UNMATCHED_SELL_RECEIPT_FETCHES = 20
const RECEIPT_FETCH_TIMEOUT_MS = 5_000
const RECEIPT_FETCH_CONCURRENCY = 5

export type UnmatchedSellReceiptProofAudit = {
  candidates: number
  attempted: number
  skippedByCap: number
  cacheHits: number
  liveFetches: number
  proofsAdded: Record<string, number>
}

export async function fillUnmatchedSellReceiptProofs(params: {
  sells: readonly { chain: string; txHash: string }[]
  walletAddress: string
  receiptProofByTxHash: Map<string, string>
  fetchReceipt: ReceiptFetcher
  validator: PoolValidator
  uniswapV3Validator?: UniswapV3PoolValidator
  cap?: number
  timeoutMs?: number
}): Promise<UnmatchedSellReceiptProofAudit> {
  const cap = params.cap ?? MAX_UNMATCHED_SELL_RECEIPT_FETCHES
  const timeoutMs = params.timeoutMs ?? RECEIPT_FETCH_TIMEOUT_MS
  const seen = new Set<string>()
  const candidates: string[] = []
  // Receipts (and the decoder's pool validation) are Base-only in this pipeline.
  for (const sell of params.sells) {
    if (sell.chain !== 'base') continue
    const tx = sell.txHash.toLowerCase()
    if (seen.has(tx) || params.receiptProofByTxHash.has(tx)) continue
    seen.add(tx)
    candidates.push(tx)
  }
  const selected = candidates.slice(0, cap)
  const audit: UnmatchedSellReceiptProofAudit = {
    candidates: candidates.length,
    attempted: selected.length,
    skippedByCap: candidates.length - selected.length,
    cacheHits: 0,
    liveFetches: 0,
    proofsAdded: {},
  }
  if (selected.length === 0) return audit

  const scope = createReceiptRequestScopeCache()
  seedPermanentReceiptsIntoRequestScope(scope, selected.map((txHash) => ({ chain: 'base', txHash })))

  const fetchOne = async (txHash: string): Promise<ReceiptFetchOutcome> => {
    const key = receiptCacheKey('base', txHash)
    const cached = scope.cache.get(key)
    if (cached) { audit.cacheHits += 1; return cached }
    audit.liveFetches += 1
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<ReceiptFetchOutcome>((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs) })
    const outcome = await Promise.race([params.fetchReceipt('base', txHash).catch((): ReceiptFetchOutcome => ({ status: 'malformed' })), timeout])
    if (timer) clearTimeout(timer)
    scope.cache.set(key, outcome)
    return outcome
  }

  const proofs = new Map<string, string>()
  for (let i = 0; i < selected.length; i += RECEIPT_FETCH_CONCURRENCY) {
    const batch = selected.slice(i, i + RECEIPT_FETCH_CONCURRENCY)
    await Promise.all(batch.map(async (txHash) => {
      const outcome = await fetchOne(txHash)
      if (outcome.status !== 'ok') return
      const decoded = await decodeReceiptSwap(
        { chain: 'base', txHash, walletAddress: params.walletAddress, logs: outcome.logs },
        params.validator,
        params.uniswapV3Validator,
      ).catch(() => null)
      if (decoded == null) return
      if (decoded.ok) proofs.set(txHash, 'exact_swap')
      else if (decoded.rejection.reason === 'plain_transfer_no_swap_event' || decoded.rejection.reason === 'lp_add_or_remove_detected') {
        proofs.set(txHash, decoded.rejection.reason)
      }
    }))
  }
  recordPermanentReceiptsFromRequestScope(scope)

  // Applied in candidate order so the map's contents never depend on network completion order.
  for (const txHash of selected) {
    const proof = proofs.get(txHash)
    if (proof == null || params.receiptProofByTxHash.has(txHash)) continue
    params.receiptProofByTxHash.set(txHash, proof)
    audit.proofsAdded[proof] = (audit.proofsAdded[proof] ?? 0) + 1
  }
  return audit
}
