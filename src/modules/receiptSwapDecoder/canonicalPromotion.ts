// MODULE — receiptSwapDecoder: the real, flag-gated promotion path for verified receipt-
// reconstructed swap evidence into canonical Wallet Scanner FIFO input.
//
// GOAL, DISCLOSED: every prior task in this module set kept receiptSwapDecoder strictly shadow-mode
// (measured via shadowFifoReplay.ts's own clone-and-compare, but NEVER fed into the real
// normalizedEvents array src/pipeline/index.ts's actual FIFO/PnL computation consumes). This module
// is the first that can actually fill a genuinely missing canonical swap side — gated behind a
// feature flag that defaults OFF (see src/pipeline/index.ts's own wiring), so this module existing
// changes nothing about real production output until explicitly enabled.
//
// SURGICAL, ADDITIVE-ONLY, DISCLOSED: this module NEVER overwrites, removes, or reorders an
// existing canonical event — it only ever appends a genuinely MISSING opposite leg for a
// transaction that already has exactly one, already-verified, incomplete canonical leg (real
// provider-native evidence — this module never invents the existing side). "Never replace
// provider-native evidence with receipt-derived evidence" holds by construction: the existing leg is
// never touched, only a new one is spliced in alongside it.
//
// SHARED MATCHING LOGIC, DISCLOSED: reuses receiptLegPromotionResolver.ts's resolvePromotableLeg —
// the exact same matching/rejection contract shadowFifoReplay.ts's own (unchanged) measurement path
// uses, so "what counts as promotable" cannot silently diverge between the shadow-measurement tool
// and this real promotion path.
//
// SUPPORTED PROTOCOLS, DISCLOSED: aerodrome_classic, aerodrome_slipstream, uniswap_v3 — the three
// protocols this module set's factory validators (poolValidator.ts, uniswapV3PoolValidator.ts)
// actually confirm against a real, canonical, previously-verified factory before decodeReceiptSwap
// ever returns `ok: true`. An UNKNOWN concentrated factory (see
// concentratedPoolEmitterFingerprint.ts / unknownConcentratedFactoryVerifier.ts /
// unsupportedFactoryForensics.ts) never reaches `confidence: 'exact'` at all — those forensic
// modules never validate a pool, only investigate one that already failed validation — so an
// unknown factory is structurally unreachable here, never explicitly re-checked or whitelisted by
// this file.
//
// NO NEW PROVIDER CALLS, DISCLOSED: this module takes `acceptedExactSwaps` — evidence the shadow
// wiring already computed this same scan, from receipts already fetched under the existing 10-call
// budget — and does pure, offline array manipulation. Zero RPC/HTTP calls of its own.
//
// DETERMINISTIC ORDERING + DEDUPE, DISCLOSED: candidates are processed in a fixed sort order
// (chain, then txHash) regardless of the order `acceptedExactSwaps` arrives in, and a
// (chain, txHash) pair is never processed twice even if it somehow appears more than once in the
// input — the exact same "first occurrence wins, stable sort key" discipline already used by
// candidateSelector.ts's own dedupe.

import type { NormalizedEvent } from '../normalization/types'
import type { DecodedReceiptSwap } from './types'
import { resolvePromotableLeg, type PromotableLegRejectionReason } from './receiptLegPromotionResolver'

// Broader than shadowFifoReplay.ts's own RECOGNIZED_PROTOCOLS (which predates Uniswap V3 support
// and is left unchanged there to avoid touching that already-shipped measurement tool's behavior) —
// all three are real, factory-validated protocols in this module set today.
export const CANONICAL_PROMOTION_RECOGNIZED_PROTOCOLS = new Set(['aerodrome_classic', 'aerodrome_slipstream', 'uniswap_v3'])

export const RECEIPT_EXACT_SWAP_RECOVERY_SOURCE = 'receipt_exact_swap_recovery'

export type PromotionRecord = {
  chain: string
  txHash: string
  protocol: string
  poolAddress: string
  addedDirection: 'inbound' | 'outbound'
  addedContract: string
  source: typeof RECEIPT_EXACT_SWAP_RECOVERY_SOURCE
}

export type PromotionRejection = {
  chain: string
  txHash: string
  reason: PromotableLegRejectionReason
}

export type PromoteVerifiedReceiptSwapsInput = {
  // READ ONLY — never mutated. The promoted result is always a fresh array; callers that don't want
  // promotion applied simply never call this function (the feature flag lives in the caller,
  // src/pipeline/index.ts, not here).
  normalizedEvents: readonly NormalizedEvent[]
  walletAddress: string
  acceptedExactSwaps: readonly DecodedReceiptSwap[]
  // DOUBLE-FILL GUARD, DISCLOSED (audit fix) — see receiptLegPromotionResolver.ts's own header:
  // src/pipeline/index.ts's recoveryPolicy independently recovers missing legs via its own
  // historical-page-fetch mechanism, held separately from canonical `normalizedEvents` until
  // fifoEngine's own mergeNormalizedEvents combines them at FIFO-build time (an EXACT-match dedupe
  // that a receipt-derived leg could differ from by even one field). Passing those already-recovered
  // events here (never spliced, only used to detect "recoveryPolicy already has this leg") prevents
  // this module from proposing a leg recoveryPolicy independently already recovered for the same
  // transaction. Optional — omitting it preserves this module's original, pre-audit-fix behavior.
  recoveredEvents?: readonly NormalizedEvent[]
}

export type PromoteVerifiedReceiptSwapsResult = {
  // Always a NEW array — `input.normalizedEvents` itself is never mutated or returned by reference.
  // Identical in content order to the input with zero or more legs additively spliced in.
  promotedEvents: NormalizedEvent[]
  addedLegs: NormalizedEvent[]
  promotions: PromotionRecord[]
  rejections: PromotionRejection[]
}

function dedupeKey(chain: string, txHash: string): string {
  return `${chain}:${txHash.toLowerCase()}`
}

// PURE. Deterministic: identical input (regardless of `acceptedExactSwaps`' own input order)
// produces an identical `promotedEvents`/`promotions`/`rejections` output — sorted by
// (chain, txHash) before processing, tie-broken by the dedupe key itself.
export function promoteVerifiedReceiptSwaps(input: PromoteVerifiedReceiptSwapsInput): PromoteVerifiedReceiptSwapsResult {
  const sorted = [...input.acceptedExactSwaps].sort((a, b) => dedupeKey(a.chain, a.txHash).localeCompare(dedupeKey(b.chain, b.txHash)))

  let working: NormalizedEvent[] = input.normalizedEvents.map((e) => ({ ...e }))
  const addedLegs: NormalizedEvent[] = []
  const promotions: PromotionRecord[] = []
  const rejections: PromotionRejection[] = []
  const seen = new Set<string>()

  for (const decodedSwap of sorted) {
    const key = dedupeKey(decodedSwap.chain, decodedSwap.txHash)
    if (seen.has(key)) continue
    seen.add(key)

    const resolution = resolvePromotableLeg(
      working, input.walletAddress, decodedSwap, CANONICAL_PROMOTION_RECOGNIZED_PROTOCOLS, input.recoveredEvents ?? [],
    )
    if (!resolution.ok) {
      rejections.push({ chain: decodedSwap.chain, txHash: decodedSwap.txHash, reason: resolution.reason })
      continue
    }

    const { missingEvent, existingIndex } = resolution
    working = [...working.slice(0, existingIndex + 1), missingEvent, ...working.slice(existingIndex + 1)]
    addedLegs.push(missingEvent)
    promotions.push({
      chain: decodedSwap.chain,
      txHash: decodedSwap.txHash,
      protocol: decodedSwap.protocol,
      poolAddress: decodedSwap.poolAddress,
      // resolvePromotableLeg only ever sets 'inbound'/'outbound' on a successfully-resolved missing
      // leg (never 'unknown') — narrowed here purely for the record's own stricter type.
      addedDirection: missingEvent.direction as 'inbound' | 'outbound',
      addedContract: missingEvent.contract,
      source: RECEIPT_EXACT_SWAP_RECOVERY_SOURCE,
    })
  }

  return { promotedEvents: working, addedLegs, promotions, rejections }
}
