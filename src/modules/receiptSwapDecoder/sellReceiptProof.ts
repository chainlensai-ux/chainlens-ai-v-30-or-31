// SELL RECEIPT PROOF — proves sells the transfer history alone cannot show.
//
// A token→ETH sell on Base/Ethereum shows up in the wallet's history only as the token leaving: the
// ETH comes back as an internal transfer (no log, not returned by the transfer APIs on Base), and with
// Permit2 / Universal Router the token goes straight from the wallet to the pool, which is not a known
// router. The sell timeline therefore cannot treat it as a sell. This lane fetches the receipt for
// such outbound events (own budget, separate from the shared 10-receipt shadow budget) and accepts it
// as a sell only on positive, on-chain proof:
//
//   exact_swap           the receipt decodes (decodeReceiptSwap) to a factory-validated swap whose
//                        input is exactly the token the wallet sent.
//   validated_pool_swap  the full decode failed (e.g. multi-hop that doesn't chain), but the wallet
//                        sent the token in this tx and that token went INTO a pool that emitted a Swap
//                        event and is validated by its canonical factory for a pair containing it.
//
// Never: a receipt with an LP Mint/Burn (a deposit also sends tokens to a pool), a tx where the wallet
// did not send the token, a swap that only exists on an unvalidated contract, or a decoded swap whose
// input is a different token. The proceeds (often native ETH) are never invented here — the sell is
// valued by the existing pricing at time.

import { decodeReceiptSwap } from './index'
import { decodeLogs } from './decodeLogs'
import { receiptCacheKey, createReceiptRequestScopeCache, type ReceiptFetcher, type ReceiptFetchOutcome } from './receiptAcquisition'
import { seedPermanentReceiptsIntoRequestScope, recordPermanentReceiptsFromRequestScope } from './permanentReceiptCache'
import type { PoolValidator } from './poolValidator'
import type { UniswapV3PoolValidator } from './uniswapV3PoolValidator'
import type { RawReceiptLog, ReceiptSwapChain } from './types'
import { proveV4SellFromReceipt, type V4SellDeps, type V4SellRejection } from './v4SellReceiptProof'
import { V4_POOL_MANAGERS, V4_SWAP_TOPIC0 } from '../../lib/v4RouteQuote'
import { SELL_VENUES, type SellVenue } from '../../lib/sellVenueClassifier'

export const MAX_SELL_PROOF_RECEIPTS = 25
export const SELL_PROOF_LANE_BUDGET_MS = 12_000
const RECEIPT_FETCH_TIMEOUT_MS = 5_000
const CONCURRENCY = 5
const SUPPORTED_CHAINS: ReadonlySet<string> = new Set(['base', 'eth'])

export type SellProofKind = 'exact_swap' | 'validated_pool_swap' | 'v4_exact_route'
export type SellProofRejection =
  | 'lp_add_or_remove' | 'wallet_did_not_send_token' | 'no_pool_swap_event'
  | 'decoded_swap_not_selling_token' | 'pool_not_validated'

export type SellProofCandidate = { chain: string; txHash: string; token: string; timestamp: string; hasPriorInventory: boolean }

export type SellReceiptProofAudit = {
  candidates: number
  attempted: number
  skippedByCap: number
  skippedByTimeBudget: number
  cacheHits: number
  liveFetches: number
  fetchFailures: number
  proofs: Record<SellProofKind, number>
  rejections: Partial<Record<SellProofRejection | `v4:${V4SellRejection}`, number>>
  byChain: Record<string, { attempted: number; proven: number }>
  /** Venue of every checked receipt (audit label only), split by outcome. */
  venues: { rejected: Record<SellVenue, number>; proven: Record<SellVenue, number> }
  rejectedSamples: Array<{ chain: string; txHash: string; token: string; venue: SellVenue | null; rejection: string }>
  v4Enabled: boolean
}

const REJECTED_SAMPLE_LIMIT = 25
const emptyVenueCounts = (): Record<SellVenue, number> => Object.fromEntries(SELL_VENUES.map((v) => [v, 0])) as Record<SellVenue, number>

/** PURE over its injected validators. Decides whether one receipt proves the wallet sold `token`. */
export async function proveSellFromReceipt(params: {
  chain: ReceiptSwapChain
  txHash: string
  walletAddress: string
  token: string
  logs: RawReceiptLog[]
  validator: PoolValidator
  uniswapV3Validator?: UniswapV3PoolValidator
}): Promise<{ proof: SellProofKind } | { proof: null; rejection: SellProofRejection }> {
  const wallet = params.walletAddress.toLowerCase()
  const token = params.token.toLowerCase()
  const decoded = decodeLogs(params.logs, params.chain)
  if (decoded.lpEvents.length > 0) return { proof: null, rejection: 'lp_add_or_remove' }
  if (!decoded.transfers.some((t) => t.token === token && t.from === wallet && t.value > BigInt(0))) {
    return { proof: null, rejection: 'wallet_did_not_send_token' }
  }
  if (decoded.swaps.length === 0) return { proof: null, rejection: 'no_pool_swap_event' }

  const full = await decodeReceiptSwap(
    { chain: params.chain, txHash: params.txHash, walletAddress: params.walletAddress, logs: params.logs },
    params.validator,
    params.uniswapV3Validator,
  ).catch(() => null)
  if (full?.ok) {
    return full.swap.tokenIn.address.toLowerCase() === token
      ? { proof: 'exact_swap' }
      : { proof: null, rejection: 'decoded_swap_not_selling_token' }
  }

  // Pool-level proof: the token went into a factory-validated pool that swapped in this transaction.
  for (const swap of decoded.swaps) {
    const pool = swap.poolAddress
    if (!decoded.transfers.some((t) => t.token === token && t.to === pool && t.value > BigInt(0))) continue
    const counterTokens = [...new Set(decoded.transfers.filter((t) => t.from === pool && t.token !== token).map((t) => t.token))]
    for (const other of counterTokens) {
      if (await params.validator.isValidPool(swap.protocol, pool, token, other, params.chain).catch(() => false)) {
        return { proof: 'validated_pool_swap' }
      }
      if (params.chain === 'base' && swap.protocol === 'aerodrome_slipstream' && params.uniswapV3Validator) {
        const v3 = await params.uniswapV3Validator.validatePool(pool, token, other).catch(() => null)
        if (v3?.valid) return { proof: 'validated_pool_swap' }
      }
    }
  }
  return { proof: null, rejection: 'pool_not_validated' }
}

/**
 * Fetches (capped, cached, time-boxed) and checks receipts for outbound events the sell timeline could
 * not classify. Candidates with prior inventory of the token go first, then newest first. Returns the
 * proven `${chain}:${txHash}` keys (lowercased hash) and an audit.
 */
export async function proveSellsFromReceipts(params: {
  candidates: readonly SellProofCandidate[]
  walletAddress: string
  fetchReceipt: ReceiptFetcher
  validator: PoolValidator
  uniswapV3Validator?: UniswapV3PoolValidator
  cap?: number
  laneBudgetMs?: number
  timeoutMs?: number
  now?: () => number
  /** Audit-only venue label for each checked receipt. */
  classifyVenue?: (input: { chain: ReceiptSwapChain; logs: RawReceiptLog[]; txTo: string | null }) => Promise<SellVenue>
  /** Uniswap V4 proof (WALLET_V4_SELL_PROOF=1): tried for receipts with canonical-PoolManager swaps the pool decoder rejected. */
  v4?: V4SellDeps
}): Promise<{ provenTxKeys: Set<string>; proofByTxHash: Map<string, SellProofKind>; audit: SellReceiptProofAudit }> {
  const cap = params.cap ?? MAX_SELL_PROOF_RECEIPTS
  const now = params.now ?? Date.now
  const deadline = now() + (params.laneBudgetMs ?? SELL_PROOF_LANE_BUDGET_MS)
  const timeoutMs = params.timeoutMs ?? RECEIPT_FETCH_TIMEOUT_MS

  // One check per (chain, tx, token); a tx can carry more than one token the wallet sold.
  const seen = new Set<string>()
  const unique = params.candidates.filter((c) => {
    if (!SUPPORTED_CHAINS.has(c.chain)) return false
    const key = `${c.chain}:${c.txHash.toLowerCase()}:${c.token.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const ordered = [...unique].sort((a, b) =>
    Number(b.hasPriorInventory) - Number(a.hasPriorInventory)
    || Date.parse(b.timestamp) - Date.parse(a.timestamp)
    || a.txHash.localeCompare(b.txHash))
  const selected = ordered.slice(0, cap)

  const audit: SellReceiptProofAudit = {
    candidates: unique.length, attempted: 0, skippedByCap: unique.length - selected.length, skippedByTimeBudget: 0,
    cacheHits: 0, liveFetches: 0, fetchFailures: 0, proofs: { exact_swap: 0, validated_pool_swap: 0, v4_exact_route: 0 }, rejections: {}, byChain: {},
    venues: { rejected: emptyVenueCounts(), proven: emptyVenueCounts() }, rejectedSamples: [], v4Enabled: params.v4 != null,
  }
  const provenTxKeys = new Set<string>()
  const proofByTxHash = new Map<string, SellProofKind>()
  if (selected.length === 0) return { provenTxKeys, proofByTxHash, audit }

  const scope = createReceiptRequestScopeCache()
  seedPermanentReceiptsIntoRequestScope(scope, selected.map((c) => ({ chain: c.chain, txHash: c.txHash.toLowerCase() })))
  const inFlight = new Map<string, Promise<ReceiptFetchOutcome>>()
  const fetchOne = (chain: ReceiptSwapChain, txHash: string): Promise<ReceiptFetchOutcome> => {
    const key = receiptCacheKey(chain, txHash)
    const cached = scope.cache.get(key)
    if (cached) { audit.cacheHits += 1; return Promise.resolve(cached) }
    const pending = inFlight.get(key)
    if (pending) return pending
    audit.liveFetches += 1
    const run = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<ReceiptFetchOutcome>((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs) })
      const outcome = await Promise.race([params.fetchReceipt(chain, txHash).catch((): ReceiptFetchOutcome => ({ status: 'malformed' })), timeout])
      if (timer) clearTimeout(timer)
      scope.cache.set(key, outcome)
      return outcome
    })()
    inFlight.set(key, run)
    return run
  }

  const results = new Map<SellProofCandidate, SellProofKind | SellProofRejection | `v4:${V4SellRejection}` | null>()
  const venueOf = new Map<SellProofCandidate, SellVenue>()
  for (let i = 0; i < selected.length; i += CONCURRENCY) {
    if (now() >= deadline) { audit.skippedByTimeBudget = selected.length - i; break }
    const batch = selected.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async (candidate) => {
      const chain = candidate.chain as ReceiptSwapChain
      const txHash = candidate.txHash.toLowerCase()
      audit.attempted += 1
      const row = (audit.byChain[chain] ??= { attempted: 0, proven: 0 })
      row.attempted += 1
      const outcome = await fetchOne(chain, txHash)
      if (outcome.status !== 'ok') { audit.fetchFailures += 1; results.set(candidate, null); return }
      let verdict: { proof: SellProofKind } | { proof: null; rejection: SellProofRejection | `v4:${V4SellRejection}` } | null = await proveSellFromReceipt({
        chain, txHash, walletAddress: params.walletAddress, token: candidate.token, logs: outcome.logs,
        validator: params.validator, uniswapV3Validator: params.uniswapV3Validator,
      }).catch(() => null)
      const manager = V4_POOL_MANAGERS[chain]
      const hasV4Swap = outcome.logs.some((l) => (l.topics[0] ?? '').toLowerCase() === V4_SWAP_TOPIC0 && l.address.toLowerCase() === manager)
      if (params.v4 && hasV4Swap && verdict?.proof == null) {
        const v4 = await proveV4SellFromReceipt({ chain, txHash, walletAddress: params.walletAddress, token: candidate.token, logs: outcome.logs, deps: params.v4 }).catch(() => null)
        if (v4) verdict = v4.proof ? { proof: v4.proof } : { proof: null, rejection: `v4:${v4.rejection}` }
      }
      results.set(candidate, verdict == null ? null : verdict.proof ?? verdict.rejection)
      if (params.classifyVenue) {
        const venue = await params.classifyVenue({ chain, logs: outcome.logs, txTo: outcome.to ?? null }).catch((): SellVenue => 'unknown')
        venueOf.set(candidate, venue)
      }
    }))
  }
  recordPermanentReceiptsFromRequestScope(scope)

  // Applied in candidate order so the output never depends on network completion order.
  for (const candidate of selected) {
    const result = results.get(candidate)
    if (result == null) continue
    const venue = venueOf.get(candidate) ?? null
    if (result === 'exact_swap' || result === 'validated_pool_swap' || result === 'v4_exact_route') {
      const txHash = candidate.txHash.toLowerCase()
      audit.proofs[result] += 1
      if (venue) audit.venues.proven[venue] += 1
      audit.byChain[candidate.chain].proven += 1
      provenTxKeys.add(`${candidate.chain}:${txHash}`)
      if (!proofByTxHash.has(txHash) || result === 'exact_swap') proofByTxHash.set(txHash, result)
    } else {
      audit.rejections[result] = (audit.rejections[result] ?? 0) + 1
      if (venue) audit.venues.rejected[venue] += 1
      if (audit.rejectedSamples.length < REJECTED_SAMPLE_LIMIT) {
        audit.rejectedSamples.push({ chain: candidate.chain, txHash: candidate.txHash.toLowerCase(), token: candidate.token.toLowerCase(), venue, rejection: result })
      }
    }
  }
  return { provenTxKeys, proofByTxHash, audit }
}
