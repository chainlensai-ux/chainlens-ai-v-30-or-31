// MODULE — verifiedSampleRoiEligibility
//
// ROI-only membership over the already-published canonical verified sample. FIFO matching, lot
// pricing, accepted evidence, the canonical manifest, and displayed sample PnL are not modified.
//
// CONFIRMED PRODUCTION BUG THIS CLOSES (verified-sample-cost-basis-audit on
// 0x4dbb3835744b2976560e0259cb218cab89abef96, origin/main 6acc522): realized ROI used
// sum(verifiedLots.costBasisUsd) as the denominator. FIFO treats every inbound as a buy, so a
// TOKEN←USDC swap produces BOTH a TOKEN lot (economic position) AND a USDC lot (cash inventory
// opened when the previous token was sold, closed when the next token was bought). The same
// deployed dollars were therefore counted once as the risk lot's cost basis and again as USDC
// inventory turnover. On that wallet: 98 verified lots, -$70,794.97 realized PnL (all from 21
// non-USDC lots), $527,036.11 cost basis of which $278,198.83 was 77 Base USDC lots at $1/$1/$0.
// That flattened published ROI toward 0 (−13.43%) without changing FIFO conservation.
//
// LIVE CLASSIFICATION REGRESSION THIS ALSO CLOSES (origin/main 46320a / e984eaf / cf6f379): pairing
// used the published verified sample, then consistent FIFO, then unmatched FIFO identities. Live
// still collapsed 72 → 16 quote legs with structuralLotsCount = 232. The missing 56 counterparts
// are not in the current bounded FIFO matched-lot set, not in unmatched buy/sell events, not in
// accepted-evidence records (prices only), and not in the 98-lot canonical manifest (verified
// sample identity + frozen values, no paired-risk token). The original 72-quote audit paired the
// 77 Base USDC lots against a one-off FULL-HISTORY FIFO matched-lot dump (~505 closed lots,
// including unpriced TOKEN counterparts outside the bounded window). That dump was never persisted,
// so a later bounded scan cannot re-prove those identities from any current store. Compact ROI
// quote-leg proofs are therefore written onto the existing v4 canonical sample manifest (optional
// additive field — schema version is NOT bumped, fingerprints do NOT include proofs). Replay
// applies only when lot identity + methodology version match; a fresh live FIFO/event quote can
// confirm; a stale/mismatched proof is unresolved, never guessed into the denominator. Never infer
// from token symbol. Independent EOA/CEX/mint still requires live event proof (or a matching
// persisted independent proof when the bounded window has dropped those txs). Targeted receipt
// backfill (roiQuoteLegTxBackfill.ts) may fill missing proof from the lot's own open/close txs
// without paginating wallet history; failed/capped lookups stay unresolved.
//
// PROOF STANDARD, DISCLOSED: a verified stablecoin lot is excluded from the ROI denominator only
// when swap/FIFO identity — live or a matching persisted proof — proves it is the cash/quote leg
// of an already-represented economic trade. Non-stablecoin verified lots always remain eligible.
// A genuine independent stablecoin movement remains eligible. When quote-leg identity cannot be
// proven either way, ROI is unavailable — never guessed.
//
// Pairing uses ALL structural matched lots (including unpriced), not only the verified subset:
// an unpriced risk lot is still the economic trade the USDC cash financed. That trade's PnL is
// already outside the verified sample; counting the USDC cash in the ROI denominator would add
// capital without the corresponding PnL.
//
// Displayed sample PnL stays the sum over the full verified canonical sample. Quote/cash lots
// excluded from the ROI denominator are also excluded from the ROI numerator, even when their
// PnL is $0. Full-history gates are unchanged.

import type { MatchedLot } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { SupportedChain } from '../modules/providerFetchWindow/types'
import { isVerifiedStablecoinAddress } from '../modules/quoteLegPricing/index'
import { isKnownDexRouter } from './knownDexRouters'
import {
  readCanonicalPnlSampleManifest,
  writeCanonicalPnlSampleManifest,
  type CanonicalPnlSampleManifestIdentity,
  type CanonicalSampleManifestKvLike,
} from './canonicalPnlSampleManifest'

export type RoiDenominatorDisposition = 'include_economic_position' | 'exclude_quote_cash_leg' | 'unresolved'

export type RoiClassificationReason =
  | 'non_stable_economic_position'
  | 'fifo_paired_quote_cash'
  | 'event_paired_quote_cash'
  | 'persisted_quote_cash'
  | 'persisted_independent'
  | 'independent_eoa_cex_or_mint'
  | 'unresolved_no_events_provided'
  | 'unresolved_missing_event_context'
  | 'unresolved_native_or_unknown_quote'
  | 'unresolved_router_without_opposite_risk'
  | 'unresolved_stale_quote_leg_proof'
  | 'unresolved_targeted_tx_backfill_unconfirmed'

export type RoiQuoteLegProofType = 'fifo_structural_lot' | 'event_opposite_leg' | 'independent_eoa_cex_or_mint' | 'targeted_tx_backfill'

// Bumped only when the quote-leg identity RULE changes (what counts as a proven pair / independent
// movement), never for a bounded-window or provider-availability change — those are exactly the
// class of change persisted proofs exist to make invisible on replay.
export const ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION = 1

export type PersistedRoiQuoteLegProof = {
  stableLotKey: string
  disposition: 'exclude_quote_cash_leg' | 'include_economic_position'
  pairedRiskToken: string | null
  pairedTxHash: string | null
  proofType: RoiQuoteLegProofType
  methodologyVersion: number
}

export type VerifiedSampleRoiLotClassification = {
  lotKey: string
  token: string
  chain: SupportedChain
  openedTxHash: string
  closedTxHash: string
  amount: number
  costBasisUsd: number | null
  proceedsUsd: number | null
  realizedPnlUsd: number | null
  openingCounterAsset: string | null
  closingCounterAsset: string | null
  openingSwapGroupId: string
  closingSwapGroupId: string
  pairedRiskAssetLotKeys: string[]
  fifoPairAtOpen: boolean
  fifoPairAtClose: boolean
  eventPairAtOpen: boolean
  eventPairAtClose: boolean
  openTxPresentInEvents: boolean | null
  closeTxPresentInEvents: boolean | null
  isQuoteLeg: boolean
  isIndependentStablecoinTrade: boolean
  roiDenominatorDisposition: RoiDenominatorDisposition
  reason: RoiClassificationReason
}

export type VerifiedSampleRoiEligibility = {
  classifications: VerifiedSampleRoiLotClassification[]
  verifiedSampleRoiEligibleLots: MatchedLot[]
  quoteCashLegLots: MatchedLot[]
  unresolvedLots: MatchedLot[]
  roiAvailable: boolean
  roiUnavailableReason: 'unresolved_quote_leg_identity' | null
  realizedRoiPnlUsd: number | null
  realizedRoiCostBasisUsd: number | null
}

export function roiLotKey(lot: Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt'>): string {
  return [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt].join(':')
}

export function isValidPersistedRoiQuoteLegProof(raw: unknown): raw is PersistedRoiQuoteLegProof {
  if (raw === null || typeof raw !== 'object') return false
  const proof = raw as Partial<PersistedRoiQuoteLegProof>
  if (typeof proof.stableLotKey !== 'string' || proof.stableLotKey.length === 0) return false
  if (proof.disposition !== 'exclude_quote_cash_leg' && proof.disposition !== 'include_economic_position') return false
  if (proof.pairedRiskToken != null && typeof proof.pairedRiskToken !== 'string') return false
  if (proof.pairedTxHash != null && typeof proof.pairedTxHash !== 'string') return false
  if (
    proof.proofType !== 'fifo_structural_lot'
    && proof.proofType !== 'event_opposite_leg'
    && proof.proofType !== 'independent_eoa_cex_or_mint'
    && proof.proofType !== 'targeted_tx_backfill'
  ) return false
  if (typeof proof.methodologyVersion !== 'number' || !Number.isFinite(proof.methodologyVersion)) return false
  if (proof.disposition === 'exclude_quote_cash_leg') {
    if (typeof proof.pairedTxHash !== 'string' || proof.pairedTxHash.length === 0) return false
  }
  return true
}

export function sanitizeRoiQuoteLegProofs(raw: unknown): PersistedRoiQuoteLegProof[] {
  if (!Array.isArray(raw)) return []
  const out: PersistedRoiQuoteLegProof[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!isValidPersistedRoiQuoteLegProof(item)) continue
    if (seen.has(item.stableLotKey)) continue
    seen.add(item.stableLotKey)
    out.push({
      stableLotKey: item.stableLotKey,
      disposition: item.disposition,
      pairedRiskToken: item.pairedRiskToken ?? null,
      pairedTxHash: item.pairedTxHash ?? null,
      proofType: item.proofType,
      methodologyVersion: item.methodologyVersion,
    })
  }
  return out
}

function normalizeTx(txHash: string | null | undefined): string {
  return (txHash ?? '').toLowerCase()
}

function persistedProofMatchesLot(
  proof: PersistedRoiQuoteLegProof,
  lot: Pick<MatchedLot, 'openedTxHash' | 'closedTxHash'>,
): { matching: boolean; stale: boolean } {
  if (proof.methodologyVersion !== ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION) {
    return { matching: false, stale: true }
  }
  if (proof.disposition === 'exclude_quote_cash_leg') {
    const pairTx = normalizeTx(proof.pairedTxHash)
    const matches = pairTx === normalizeTx(lot.openedTxHash) || pairTx === normalizeTx(lot.closedTxHash)
    return { matching: matches, stale: !matches }
  }
  return { matching: true, stale: false }
}

export function mergeRoiQuoteLegProofs(
  stored: readonly PersistedRoiQuoteLegProof[],
  live: readonly PersistedRoiQuoteLegProof[],
): PersistedRoiQuoteLegProof[] {
  const byKey = new Map<string, PersistedRoiQuoteLegProof>()
  for (const proof of sanitizeRoiQuoteLegProofs(stored)) byKey.set(proof.stableLotKey, proof)
  for (const proof of sanitizeRoiQuoteLegProofs(live)) {
    const previous = byKey.get(proof.stableLotKey)
    if (!previous) {
      byKey.set(proof.stableLotKey, proof)
      continue
    }
    // Live FIFO/event quote confirms and may upgrade a stored independent. A stored quote is never
    // overwritten by a later bounded scan that can only see USDC-only events and therefore reports
    // independent — that is incomplete TOKEN context, not a proof mismatch.
    if (proof.disposition === 'exclude_quote_cash_leg') {
      byKey.set(proof.stableLotKey, proof)
      continue
    }
    if (previous.disposition === 'exclude_quote_cash_leg') continue
    byKey.set(proof.stableLotKey, proof)
  }
  return [...byKey.values()].sort((a, b) => a.stableLotKey.localeCompare(b.stableLotKey))
}

export function liveProofFromClassification(row: VerifiedSampleRoiLotClassification): PersistedRoiQuoteLegProof | null {
  if (row.reason === 'fifo_paired_quote_cash' || row.reason === 'event_paired_quote_cash') {
    const pairedTxHash = row.fifoPairAtOpen || row.eventPairAtOpen
      ? row.openedTxHash
      : row.closedTxHash
    const pairedRiskToken = row.fifoPairAtOpen || row.eventPairAtOpen
      ? row.openingCounterAsset
      : row.closingCounterAsset
    return {
      stableLotKey: row.lotKey,
      disposition: 'exclude_quote_cash_leg',
      pairedRiskToken,
      pairedTxHash,
      proofType: row.reason === 'fifo_paired_quote_cash' ? 'fifo_structural_lot' : 'event_opposite_leg',
      methodologyVersion: ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION,
    }
  }
  if (row.reason === 'independent_eoa_cex_or_mint') {
    return {
      stableLotKey: row.lotKey,
      disposition: 'include_economic_position',
      pairedRiskToken: null,
      pairedTxHash: null,
      proofType: 'independent_eoa_cex_or_mint',
      methodologyVersion: ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION,
    }
  }
  return null
}

export function liveRoiQuoteLegProofsToPersist(eligibility: VerifiedSampleRoiEligibility): PersistedRoiQuoteLegProof[] {
  const proofs: PersistedRoiQuoteLegProof[] = []
  for (const row of eligibility.classifications) {
    const proof = liveProofFromClassification(row)
    if (proof) proofs.push(proof)
  }
  return proofs
}

function proofsEquivalent(a: readonly PersistedRoiQuoteLegProof[], b: readonly PersistedRoiQuoteLegProof[]): boolean {
  if (a.length !== b.length) return false
  const key = (proof: PersistedRoiQuoteLegProof) => [
    proof.stableLotKey,
    proof.disposition,
    proof.pairedRiskToken ?? '',
    normalizeTx(proof.pairedTxHash),
    proof.proofType,
    String(proof.methodologyVersion),
  ].join('|')
  const left = [...a].sort((x, y) => x.stableLotKey.localeCompare(y.stableLotKey)).map(key)
  const right = [...b].sort((x, y) => x.stableLotKey.localeCompare(y.stableLotKey)).map(key)
  return left.every((item, index) => item === right[index])
}

// Read-modify-write ONLY `roiQuoteLegProofs` on an existing v4 manifest. Fingerprints, records,
// realized totals, and sample membership are untouched. Invalid/malformed proofs are dropped, never
// used to fail the whole manifest. No-op when no manifest exists or the merged set is unchanged.
export async function persistRoiQuoteLegProofs(
  kv: CanonicalSampleManifestKvLike,
  identity: CanonicalPnlSampleManifestIdentity,
  liveProofs: readonly PersistedRoiQuoteLegProof[],
): Promise<{ wrote: boolean; proofCount: number }> {
  const read = await readCanonicalPnlSampleManifest(kv, identity)
  if (!read.manifest) return { wrote: false, proofCount: 0 }
  const stored = sanitizeRoiQuoteLegProofs(read.manifest.roiQuoteLegProofs)
  const merged = mergeRoiQuoteLegProofs(stored, liveProofs)
  if (proofsEquivalent(stored, merged)) return { wrote: false, proofCount: merged.length }
  const ok = await writeCanonicalPnlSampleManifest(kv, { ...read.manifest, roiQuoteLegProofs: merged })
  return { wrote: ok, proofCount: merged.length }
}

function txGroupId(chain: SupportedChain, txHash: string): string {
  return `${chain}:${txHash.toLowerCase()}`
}

function isNonStableAsset(chain: SupportedChain, contract: string): boolean {
  return !isVerifiedStablecoinAddress(chain, contract)
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

type TxEventIndex = {
  txPresent: boolean
  nonStableOppositeOpen: boolean
  nonStableOppositeClose: boolean
  openingCounterAsset: string | null
  closingCounterAsset: string | null
  hasNonStable: boolean
  hasUnknownDirectionNonStable: boolean
  usdcInboundFromRouter: boolean
  usdcOutboundToRouter: boolean
}

const EMPTY_TX_INDEX: TxEventIndex = {
  txPresent: false,
  nonStableOppositeOpen: false,
  nonStableOppositeClose: false,
  openingCounterAsset: null,
  closingCounterAsset: null,
  hasNonStable: false,
  hasUnknownDirectionNonStable: false,
  usdcInboundFromRouter: false,
  usdcOutboundToRouter: false,
}

function indexEventsByTx(events: readonly NormalizedEvent[]): Map<string, NormalizedEvent[]> {
  const grouped = new Map<string, NormalizedEvent[]>()
  for (const event of events) {
    const key = txGroupId(event.chain, event.txHash)
    const existing = grouped.get(key)
    if (existing) existing.push(event)
    else grouped.set(key, [event])
  }
  return grouped
}

function indexEventsForLotToken(
  eventsByTx: Map<string, NormalizedEvent[]>,
  chain: SupportedChain,
  txHash: string,
  stableToken: string,
): TxEventIndex {
  const grouped = eventsByTx.get(txGroupId(chain, txHash))
  if (!grouped || grouped.length === 0) return EMPTY_TX_INDEX

  const stable = stableToken.toLowerCase()
  let openingCounterAsset: string | null = null
  let closingCounterAsset: string | null = null
  let nonStableOppositeOpen = false
  let nonStableOppositeClose = false
  let hasNonStable = false
  let hasUnknownDirectionNonStable = false
  let usdcInboundFromRouter = false
  let usdcOutboundToRouter = false

  for (const event of grouped) {
    const contract = event.contract.toLowerCase()
    if (contract === stable) {
      if (event.direction === 'inbound') {
        if (isKnownDexRouter(event.fromAddress)) usdcInboundFromRouter = true
      } else if (event.direction === 'outbound') {
        if (isKnownDexRouter(event.toAddress)) usdcOutboundToRouter = true
      }
      continue
    }
    if (!isNonStableAsset(event.chain, event.contract)) continue
    hasNonStable = true
    if (openingCounterAsset == null) openingCounterAsset = event.contract.toLowerCase()
    if (closingCounterAsset == null) closingCounterAsset = event.contract.toLowerCase()
    if (event.direction === 'outbound') nonStableOppositeOpen = true
    else if (event.direction === 'inbound') nonStableOppositeClose = true
    else hasUnknownDirectionNonStable = true
  }

  return {
    txPresent: true,
    nonStableOppositeOpen,
    nonStableOppositeClose,
    openingCounterAsset,
    closingCounterAsset,
    hasNonStable,
    hasUnknownDirectionNonStable,
    usdcInboundFromRouter,
    usdcOutboundToRouter,
  }
}

export function classifyVerifiedSampleRoiEligibility(params: {
  verifiedLots: readonly MatchedLot[]
  structuralLots?: readonly MatchedLot[]
  normalizedEvents?: readonly NormalizedEvent[]
  persistedProofs?: readonly PersistedRoiQuoteLegProof[]
  forceUnresolvedLotKeys?: readonly string[]
}): VerifiedSampleRoiEligibility {
  const structuralLots = params.structuralLots ?? params.verifiedLots
  const events = params.normalizedEvents
  const eventsProvided = events != null
  const eventsByTx = eventsProvided ? indexEventsByTx(events) : null
  const persistedByKey = new Map<string, PersistedRoiQuoteLegProof>()
  for (const proof of sanitizeRoiQuoteLegProofs(params.persistedProofs)) {
    persistedByKey.set(proof.stableLotKey, proof)
  }
  const forceUnresolved = new Set(params.forceUnresolvedLotKeys ?? [])

  const riskByOpenTx = new Map<string, MatchedLot[]>()
  const riskByCloseTx = new Map<string, MatchedLot[]>()
  for (const lot of structuralLots) {
    if (isVerifiedStablecoinAddress(lot.chain, lot.token)) continue
    const openKey = txGroupId(lot.chain, lot.openedTxHash)
    const closeKey = txGroupId(lot.chain, lot.closedTxHash)
    const opened = riskByOpenTx.get(openKey)
    if (opened) opened.push(lot)
    else riskByOpenTx.set(openKey, [lot])
    const closed = riskByCloseTx.get(closeKey)
    if (closed) closed.push(lot)
    else riskByCloseTx.set(closeKey, [lot])
  }

  const classifications: VerifiedSampleRoiLotClassification[] = []
  const verifiedSampleRoiEligibleLots: MatchedLot[] = []
  const quoteCashLegLots: MatchedLot[] = []
  const unresolvedLots: MatchedLot[] = []

  for (const lot of params.verifiedLots) {
    const key = roiLotKey(lot)
    const openingSwapGroupId = txGroupId(lot.chain, lot.openedTxHash)
    const closingSwapGroupId = txGroupId(lot.chain, lot.closedTxHash)

    if (!isVerifiedStablecoinAddress(lot.chain, lot.token)) {
      classifications.push({
        lotKey: key,
        token: lot.token,
        chain: lot.chain,
        openedTxHash: lot.openedTxHash,
        closedTxHash: lot.closedTxHash,
        amount: lot.amount,
        costBasisUsd: lot.costBasisUsd,
        proceedsUsd: lot.proceedsUsd,
        realizedPnlUsd: lot.realizedPnlUsd,
        openingCounterAsset: null,
        closingCounterAsset: null,
        openingSwapGroupId,
        closingSwapGroupId,
        pairedRiskAssetLotKeys: [],
        fifoPairAtOpen: false,
        fifoPairAtClose: false,
        eventPairAtOpen: false,
        eventPairAtClose: false,
        openTxPresentInEvents: eventsProvided ? (eventsByTx?.has(openingSwapGroupId) ?? false) : null,
        closeTxPresentInEvents: eventsProvided ? (eventsByTx?.has(closingSwapGroupId) ?? false) : null,
        isQuoteLeg: false,
        isIndependentStablecoinTrade: false,
        roiDenominatorDisposition: 'include_economic_position',
        reason: 'non_stable_economic_position',
      })
      verifiedSampleRoiEligibleLots.push(lot)
      continue
    }

    const pairedOnOpen = riskByCloseTx.get(openingSwapGroupId) ?? []
    const pairedOnClose = riskByOpenTx.get(closingSwapGroupId) ?? []
    const pairedRiskAssetLotKeys = [...new Set([...pairedOnOpen, ...pairedOnClose].map(roiLotKey))]
    const fifoPairAtOpen = pairedOnOpen.length > 0
    const fifoPairAtClose = pairedOnClose.length > 0

    const openEvents = eventsByTx ? indexEventsForLotToken(eventsByTx, lot.chain, lot.openedTxHash, lot.token) : null
    const closeEvents = eventsByTx ? indexEventsForLotToken(eventsByTx, lot.chain, lot.closedTxHash, lot.token) : null
    const openTxPresentInEvents = openEvents ? openEvents.txPresent : null
    const closeTxPresentInEvents = closeEvents ? closeEvents.txPresent : null
    const eventPairAtOpen = Boolean(openEvents?.txPresent && openEvents.nonStableOppositeOpen)
    const eventPairAtClose = Boolean(closeEvents?.txPresent && closeEvents.nonStableOppositeClose)

    const fifoProvenQuote = fifoPairAtOpen || fifoPairAtClose
    const eventProvenQuote = eventPairAtOpen || eventPairAtClose
    const persistedProof = persistedByKey.get(key)
    const persistedMatch = persistedProof ? persistedProofMatchesLot(persistedProof, lot) : null

    let disposition: RoiDenominatorDisposition
    let isQuoteLeg = false
    let isIndependentStablecoinTrade = false
    let reason: RoiClassificationReason

    if (fifoProvenQuote || eventProvenQuote) {
      // Canonical FIFO lot identity is primary; events only supplement. A proven quote leg stays
      // excluded even when the bounded event window no longer contains its historical txs.
      disposition = 'exclude_quote_cash_leg'
      isQuoteLeg = true
      reason = fifoProvenQuote ? 'fifo_paired_quote_cash' : 'event_paired_quote_cash'
    } else if (persistedProof && persistedMatch?.stale) {
      // Wrong methodology or pairedTxHash that is not this lot's open/close. Fail closed.
      disposition = 'unresolved'
      reason = 'unresolved_stale_quote_leg_proof'
    } else if (persistedProof && persistedMatch?.matching && persistedProof.disposition === 'exclude_quote_cash_leg') {
      // Same canonical sample/lot identity + matching methodology. Bounded FIFO/events no longer
      // contain the TOKEN counterpart; the once-proven quote identity still holds.
      disposition = 'exclude_quote_cash_leg'
      isQuoteLeg = true
      reason = 'persisted_quote_cash'
    } else if (!eventsProvided) {
      if (persistedProof && persistedMatch?.matching && persistedProof.disposition === 'include_economic_position') {
        disposition = 'include_economic_position'
        isIndependentStablecoinTrade = true
        reason = 'persisted_independent'
      } else {
        // Structural lots alone cannot distinguish an EOA/CEX cash movement from a native-ETH swap
        // whose opposite leg never produced an ERC20 FIFO lot. Fail closed.
        disposition = 'unresolved'
        reason = 'unresolved_no_events_provided'
      }
    } else if (!openEvents!.txPresent || !closeEvents!.txPresent) {
      if (persistedProof && persistedMatch?.matching && persistedProof.disposition === 'include_economic_position') {
        disposition = 'include_economic_position'
        isIndependentStablecoinTrade = true
        reason = 'persisted_independent'
      } else {
        // Missing historical/bounded event context is not proof of an independent EOA/CEX/mint
        // movement. Do not guess the lot into the ROI denominator.
        disposition = 'unresolved'
        reason = 'unresolved_missing_event_context'
      }
    } else if (
      openEvents?.hasUnknownDirectionNonStable
      || closeEvents?.hasUnknownDirectionNonStable
      || (openEvents?.hasNonStable && !openEvents.nonStableOppositeOpen)
      || (closeEvents?.hasNonStable && !closeEvents.nonStableOppositeClose)
    ) {
      disposition = 'unresolved'
      reason = 'unresolved_native_or_unknown_quote'
    } else if (openEvents?.usdcInboundFromRouter || closeEvents?.usdcOutboundToRouter) {
      // Router counterparty with no proven opposite-direction risk asset: could be a native quote
      // swap. Do not guess. A stored independent does not override live ambiguity.
      disposition = 'unresolved'
      reason = 'unresolved_router_without_opposite_risk'
    } else if (forceUnresolved.has(key)) {
      // Targeted receipt backfill was required and did not confirm this lot (failed/timeout/capped).
      // Bounded USDC-only events must not stand in as an independent proof.
      disposition = 'unresolved'
      reason = 'unresolved_targeted_tx_backfill_unconfirmed'
    } else {
      // Both txs are present in events and show no opposite-direction risk asset. Counterparties
      // are EOA/CEX or a 0x0 mint — a mint without a swap is cash issuance, not a quote leg.
      // Matching persisted quote already returned above; reaching here with a stored quote is
      // impossible. Live independent is the honest classification of this event set.
      disposition = 'include_economic_position'
      isIndependentStablecoinTrade = true
      reason = 'independent_eoa_cex_or_mint'
    }

    const openingCounterAsset = openEvents?.openingCounterAsset
      ?? (pairedOnOpen[0] ? pairedOnOpen[0].token.toLowerCase() : null)
      ?? (persistedProof?.pairedRiskToken ?? null)
    const closingCounterAsset = closeEvents?.closingCounterAsset
      ?? (pairedOnClose[0] ? pairedOnClose[0].token.toLowerCase() : null)
      ?? (persistedProof?.pairedRiskToken ?? null)

    classifications.push({
      lotKey: key,
      token: lot.token,
      chain: lot.chain,
      openedTxHash: lot.openedTxHash,
      closedTxHash: lot.closedTxHash,
      amount: lot.amount,
      costBasisUsd: lot.costBasisUsd,
      proceedsUsd: lot.proceedsUsd,
      realizedPnlUsd: lot.realizedPnlUsd,
      openingCounterAsset,
      closingCounterAsset,
      openingSwapGroupId,
      closingSwapGroupId,
      pairedRiskAssetLotKeys,
      fifoPairAtOpen,
      fifoPairAtClose,
      eventPairAtOpen,
      eventPairAtClose,
      openTxPresentInEvents,
      closeTxPresentInEvents,
      isQuoteLeg,
      isIndependentStablecoinTrade,
      roiDenominatorDisposition: disposition,
      reason,
    })

    if (disposition === 'include_economic_position') verifiedSampleRoiEligibleLots.push(lot)
    else if (disposition === 'exclude_quote_cash_leg') quoteCashLegLots.push(lot)
    else unresolvedLots.push(lot)
  }

  const roiAvailable = unresolvedLots.length === 0
  const realizedRoiPnlUsd = roiAvailable
    ? verifiedSampleRoiEligibleLots.reduce((sum, lot) => sum + finiteOrZero(lot.realizedPnlUsd), 0)
    : null
  const realizedRoiCostBasisUsd = roiAvailable
    ? verifiedSampleRoiEligibleLots.reduce((sum, lot) => sum + finiteOrZero(lot.costBasisUsd), 0)
    : null

  return {
    classifications,
    verifiedSampleRoiEligibleLots,
    quoteCashLegLots,
    unresolvedLots,
    roiAvailable,
    roiUnavailableReason: roiAvailable ? null : 'unresolved_quote_leg_identity',
    realizedRoiPnlUsd,
    realizedRoiCostBasisUsd,
  }
}
