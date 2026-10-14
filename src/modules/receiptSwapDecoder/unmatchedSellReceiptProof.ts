// TARGETED RECEIPT PROOF FOR UNMATCHED SELLS. When RECEIPT_SWAP_CANONICAL_PROMOTION_ENABLED is off,
// the shadow receipt block runs after the response (setImmediate), so the boundary resolver used to
// see an empty receipt map. This fetches receipts ONLY for unmatched-sell txHashes that still have
// no proof, capped, through the same request-scope + permanent receipt cache and the same decoder.
// It only ever adds `exact_swap`, `lp_add_or_remove_detected`, `one_way_transfer_only` or
// `transfer_with_unrecognised_events`; any other outcome (timeout, missing, other rejection) adds
// nothing.
//
// "No recognised swap event" is NOT proof of a plain transfer: the decoder only knows V2-style and
// V3/Slipstream Swap topics, so a sell through Uniswap V4's PoolManager, another fork, or an
// RFQ/intent fill decodes as `plain_transfer_no_swap_event` too. Only a receipt made entirely of
// ERC-20 Transfers, sent by the wallet and crediting the wallet nothing, is `one_way_transfer_only`.

import { decodeReceiptSwap } from './index'
import { createReceiptRequestScopeCache, receiptCacheKey, type ReceiptFetcher, type ReceiptFetchOutcome } from './receiptAcquisition'
import { seedPermanentReceiptsIntoRequestScope, recordPermanentReceiptsFromRequestScope } from './permanentReceiptCache'
import type { PoolValidator } from './poolValidator'
import type { UniswapV3PoolValidator } from './uniswapV3PoolValidator'
import type { RawReceiptLog } from './types'
import { ERC20_TRANSFER_TOPIC0 } from './signatures'

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

function topicAddress(topic: string | undefined): string | null {
  if (typeof topic !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null
  return `0x${topic.slice(26)}`.toLowerCase()
}

/**
 * PURE. Refines a `plain_transfer_no_swap_event` receipt: `one_way_transfer_only` when EVERY log is an
 * ERC-20 Transfer (topic0 + from + to, no 4th topic as ERC-721 has), at least one is sent by the
 * wallet, and none credits the wallet. Anything else is `transfer_with_unrecognised_events`.
 */
export function classifyNoSwapReceipt(logs: readonly RawReceiptLog[], walletAddress: string): 'one_way_transfer_only' | 'transfer_with_unrecognised_events' {
  const wallet = walletAddress.toLowerCase()
  let walletSent = false
  for (const log of logs) {
    if ((log.topics[0] ?? '').toLowerCase() !== ERC20_TRANSFER_TOPIC0 || log.topics.length !== 3) return 'transfer_with_unrecognised_events'
    const from = topicAddress(log.topics[1])
    const to = topicAddress(log.topics[2])
    if (from == null || to == null) return 'transfer_with_unrecognised_events'
    if (to === wallet) return 'transfer_with_unrecognised_events'
    if (from === wallet) walletSent = true
  }
  return walletSent ? 'one_way_transfer_only' : 'transfer_with_unrecognised_events'
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
      else if (decoded.rejection.reason === 'lp_add_or_remove_detected') proofs.set(txHash, decoded.rejection.reason)
      else if (decoded.rejection.reason === 'plain_transfer_no_swap_event') proofs.set(txHash, classifyNoSwapReceipt(outcome.logs, params.walletAddress))
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
