// MODULE 6 — fifoEngine: type definitions.
//
// Computes real, quantity-based FIFO lot matching over normalized + recovered events. NO pricing
// module exists yet in this delivery, so this engine never invents a USD figure: it accepts an
// optional, caller-supplied `priceUsdLookup` for cost basis / proceeds and an optional
// `currentPriceUsdLookup` for marking open lots to market. When neither is supplied, every lot is
// genuinely, honestly unpriced — quantity matching still runs for real, but every USD field stays
// null rather than being guessed (Architecture Step 9 §4: "fifoEngine must never guess cost basis").

import type { SupportedChain } from '../providerFetchWindow/types'
import type { NormalizedEvent } from '../normalization/types'

export type LotEvidenceQuality = 'verified' | 'unpriced'

export type OpenLot = {
  lotId: string
  token: string
  chain: SupportedChain
  openedAt: number
  openedTxHash: string
  amountOpened: number
  amountRemaining: number
  costBasisUsd: number | null
  evidenceQuality: LotEvidenceQuality
  // ADDITIVE, OPTIONAL, DISCLOSED (exact-unmatched-identity follow-up task): the original buy
  // event's fromAddress/toAddress/amountRaw — carried through purely so a still-open lot (an
  // unmatched buy) can be reported as an UnmatchedEventIdentity with real, non-fabricated fields.
  // Optional so any existing direct OpenLot construction (tests, other callers) is unaffected.
  sourceFromAddress?: string
  sourceToAddress?: string
  sourceAmountRaw?: string | null
}

export type MatchedLot = {
  lotId: string
  token: string
  chain: SupportedChain
  openedAt: number
  closedAt: number
  openedTxHash: string
  closedTxHash: string
  amount: number
  costBasisUsd: number | null
  proceedsUsd: number | null
  realizedPnlUsd: number | null
  evidenceQuality: LotEvidenceQuality
}

export type IntegrityFlags = {
  hardInvalid: boolean
  estimateOnlyLotsExcluded: number
  syntheticLotsExcluded: number
}

export type PublicPnlStatus = 'unavailable' | 'limited_verified_sample' | 'ok'

// UNMATCHED EVENT IDENTITY, DISCLOSED, ADDITIVE (exact-unmatched-identity follow-up task): a stable
// source identity for one leg fifoEngine's own FIFO matching left unmatched (or partially
// unmatched) — chain/txHash/token/direction/amount/timestamp, the real fields this engine already
// has, joined against for evidence classification purposes downstream (never fed back into
// matching itself). `logIndex`/`providerIndex` are DELIBERATELY OMITTED, DISCLOSED: no such field
// exists anywhere in this codebase's NormalizedEvent (module 2's own output, the only source this
// engine ever reads) — fabricating one would violate this task's own evidence-honesty standard.
// `fromAddress`/`toAddress`/`amountRaw` are included instead as the best REAL additional identity
// fields this engine actually has, for disambiguating same-tx/same-token/same-amount duplicates.
export type UnmatchedEventIdentity = {
  chain: SupportedChain
  txHash: string
  token: string
  timestamp: number
  direction: 'inbound' | 'outbound'
  // The unmatched QUANTITY — for a buy, the lot's own remaining (unconsumed) amount; for a sell,
  // the portion that found no open lot to draw from. Never the original event's full amount when
  // only part of it went unmatched (a partially-filled sell/lot is not double-reported).
  amount: number
  fromAddress: string
  toAddress: string
  amountRaw: string | null
}

export type FifoOutput = {
  matchedLots: MatchedLot[]
  unmatchedBuys: number
  unmatchedSells: number
  // ADDITIVE, DISCLOSED: exact source identities for the unmatched buys/sells the counts above
  // already reported — see UnmatchedEventIdentity's own header. Always the same length as
  // unmatchedBuys/unmatchedSells respectively; never a separate, possibly-divergent count.
  unmatchedBuyEvents: UnmatchedEventIdentity[]
  unmatchedSellEvents: UnmatchedEventIdentity[]
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  costBasisUsd: number | null
  publicPnlStatus: PublicPnlStatus
  integrityFlags: IntegrityFlags
  // See CanonicalBalanceLookup's own header below — `${chain}:${token}` keys excluded from
  // unrealizedPnlUsd because their FIFO-derived open quantity could not be reconciled against a
  // real canonical balance. Always empty when no canonicalBalanceLookup was supplied.
  unrealizedPnlExcludedTokens: string[]
  // Full per-position + scan-level reconciliation diagnostics — see
  // UnrealizedReconciliationSummary's own header below. Diagnostics only: nothing here is ever
  // summed back into unrealizedPnlUsd.
  unrealizedReconciliation: UnrealizedReconciliationSummary
}

// PURE lookup contracts — supplied by a future price-at-time module. Defaulting to "always null"
// keeps this engine's current output honest (no priced module exists yet), while allowing it to
// resolve real cost basis/PnL the moment such a module is wired in, with no change to this file.
export type PriceUsdLookup = (event: NormalizedEvent) => number | null
export type CurrentPriceUsdLookup = (token: string, chain: SupportedChain) => number | null

// CANONICAL-BALANCE RECONCILIATION, DISCLOSED, ADDITIVE (found live, this task — confirmed
// architectural gap behind a false ~$545k unrealized PnL): this engine's own `remainingOpenLots`
// (see computePnl in index.ts) is derived PURELY from event-replay (buys minus matched sells) —
// there was NEVER any cross-check against the wallet's real, independently-fetched current token
// balance (src/modules/holdings) before multiplying an open quantity by a current price. A missed
// sell, a duplicated/mis-normalized buy event, or a raw-unit/decimal scaling bug in ANY upstream
// provider can inflate a token's event-replay-derived open quantity far past its real on-chain
// balance — and this engine, previously, had no way to catch that before reporting the resulting
// (fabricated-looking) unrealizedPnlUsd as official.
//
// Optional, defaulting to undefined: a caller that does not supply this gets BYTE-IDENTICAL
// existing behavior (see computePnl's own "ZERO-CHANGE PATH" comment) — this is purely an opt-in
// safety layer, never a change to FIFO lot matching/identity itself (buildLots/matchLotsFIFO are
// completely untouched). Returns the real current on-chain balance for (token, chain), or `null`
// when that balance genuinely isn't known/trustworthy for this token — `null` is a real, honest
// "unknown" result, never coerced to 0 or Infinity.
export type CanonicalBalanceLookup = (token: string, chain: SupportedChain) => number | null

// ============================================================================
// UNREALIZED-PNL RECONCILIATION DIAGNOSTICS (additive, diagnostics-only)
// ============================================================================
//
// Every field below is a REPORT about a decision computePnl already makes — none of it feeds back
// into official unrealizedPnlUsd. An excluded position's `candidate*` figures exist precisely so the
// refused number is visible and auditable; they are never summed into the official total.
//
// DECIMAL-NORMALIZATION SAFETY, DISCLOSED: every quantity/balance reported here is already
// decimal-NORMALIZED (fifoEngine's own OpenLot.amountRemaining and holdings' TokenHolding.amount are
// both human-scale, never raw base units). This module deliberately never accepts, stores, or emits
// a raw (pre-normalization) balance string — `amountRaw` is not read anywhere in this path — so a
// raw balance can never reach a log line through these diagnostics.

export type UnrealizedExclusionReason =
  // No real canonical balance evidence exists for this (chainId, tokenAddress) at all.
  | 'missing_canonical_balance'
  // FIFO's event-replayed open quantity is larger than the real current balance (beyond tolerance).
  | 'open_quantity_exceeds_balance'
  // The canonical snapshot reported a token-decimals value that is not a usable integer — the
  // balance derived alongside it cannot be trusted to be correctly normalized.
  | 'invalid_decimals'
  // FIFO's own open quantity is not a finite, positive number (corrupted upstream event data).
  | 'invalid_open_quantity'
  // No current price could be resolved for this position at all.
  | 'missing_verified_current_price'
  // A current price WAS resolved but falls outside this codebase's own verified sane range.
  | 'unverified_or_outlier_price'
  // The canonical snapshot explicitly marks this position synthetic/quarantined.
  | 'synthetic_or_quarantined_position'
  // The canonical snapshot resolved to a DIFFERENT (chainId, tokenAddress) than the one asked for.
  | 'chain_or_token_key_mismatch'

// OPEN-POSITION CLASSIFICATION, DISCLOSED, ADDITIVE (Wallet Scanner improvement audit, task 2 —
// exact taxonomy requested). This NEVER changes which positions are excluded, never changes
// exclusionReason, never changes officialUnrealizedPnlUsd — it is a second, human-readable label
// computed FROM the same exclusionReason plus a small set of real, already-computed position facts
// (symbol text, quantity/balance magnitude, whether both real price providers explicitly found no
// liquidity anywhere for this token). `priced_reconciled` is never stored on an ExcludedUnrealizedPosition
// (a reconciled position is never excluded in the first place) — it describes the
// reconciledOpenPositions count in UnrealizedReconciliationSummary; a UI combining both counts is how
// all 8 taxonomy values become visible together.
//
// HEURISTIC, NOT A THIRD FACT SOURCE, DISCLOSED: `dust_spam`/`suspicious_airdrop` are inferred from
// the symbol text and quantity shape (classic spam-token patterns: promotional/URL-like symbols, or
// an implausibly large open quantity that no real accumulation could explain) — same kind of
// evidence-based, no-network-call heuristic this codebase's app/frontend/lib/holdingsHeuristics.ts
// already uses for its own dust/personality classification (isDust/isAirdropOnly). A position that
// does not match any spam/dead heuristic keeps the plainer, more conservative label
// (missing_price/missing_balance/unsupported) rather than being over-classified as spam.
export type OpenPositionClassification =
  | 'priced_reconciled'
  | 'missing_price'
  | 'missing_balance'
  | 'balance_less_than_fifo_open'
  | 'dust_spam'
  | 'dead_unindexed'
  | 'unsupported'
  | 'suspicious_airdrop'

export type ExcludedUnrealizedPosition = {
  // CHAIN IDENTIFIER, DISCLOSED: this codebase's own canonical chain key (SupportedChain — 'base',
  // 'eth', 'arbitrum', 'hyperevm'), which is the real identifier every lot/holding/price lookup in
  // this module is keyed by. Deliberately NOT a numeric EIP-155 id: this codebase only has verified
  // numeric ids for 2 of its 4 supported chains (see src/modules/fallbackPricing/index.ts's own
  // CHAIN_ID_TO_SUPPORTED_CHAIN), so emitting a numeric field here would mean fabricating ids for
  // the rest.
  chainId: SupportedChain
  tokenAddress: string
  symbol: string | null
  openQuantityFromFifo: number
  canonicalCurrentBalance: number | null
  // openQuantityFromFifo - canonicalCurrentBalance when both are known and the former is larger;
  // null when no canonical balance exists to compare against.
  excessOpenQuantity: number | null
  decimalsUsed: number | null
  currentPriceUsd: number | null
  currentPriceSource: string | null
  openCostBasisUsd: number | null
  // The market value / unrealized PnL this position WOULD have contributed had it not been
  // excluded — the refused figure itself, reported so the inflation is measurable. Null when no
  // price was resolvable (nothing to compute a candidate from). NEVER added to official PnL.
  candidateMarketValueUsd: number | null
  candidateUnrealizedPnlUsd: number | null
  exclusionReason: UnrealizedExclusionReason
  // See OpenPositionClassification's own header above — additive, never affects exclusionReason or
  // any total.
  classification: OpenPositionClassification
}

export type UnrealizedReconciliationStatus =
  // No canonicalBalanceLookup was supplied — reconciliation did not run at all (zero-change path).
  | 'not_reconciled'
  | 'ok'
  | 'partial'
  | 'failed'

export type UnrealizedReconciliationSummary = {
  totalOpenPositions: number
  reconciledOpenPositions: number
  excludedOpenPositions: number
  excludedCandidateMarketValueUsd: number
  excludedCandidateUnrealizedPnlUsd: number
  // Exactly the same value as FifoOutput.unrealizedPnlUsd — restated here so a consumer reading
  // this summary alone can never mistake the excluded candidate totals above for the official one.
  officialUnrealizedPnlUsd: number | null
  reconciliationStatus: UnrealizedReconciliationStatus
  excludedPositions: ExcludedUnrealizedPosition[]
  // Count of RECONCILED (never excluded) positions, grouped by currentPriceSource — lets a caller
  // see, e.g., "58 provider_supplied, 2 dexscreener_fallback" instead of only a total count. A
  // reconciled position with an unknown source is grouped under 'unknown', never silently dropped
  // from the count.
  reconciledPositionsByPriceSource: Record<string, number>
  // Count of EXCLUDED positions, grouped by their exclusionReason — the same data
  // excludedPositions carries, pre-tallied for a scan-level view.
  excludedReasonCounts: Partial<Record<UnrealizedExclusionReason, number>>
  // Same tally, grouped by the additive `classification` label instead — lets a UI show "62 excluded:
  // 18 missing price, 9 missing balance, ..., 21 dust/spam, 4 dead/unindexed" without re-deriving the
  // mapping itself. `priced_reconciled` never appears here (see OpenPositionClassification's header).
  excludedClassificationCounts: Partial<Record<OpenPositionClassification, number>>
  // Convenience sum of excludedClassificationCounts.dust_spam + dead_unindexed + suspicious_airdrop —
  // exactly what the requested UI's "Dead/spam token count" reads, pre-computed so no consumer has to
  // know which 3 of the 7 excluded-position labels count as "not a real gap in coverage."
  deadOrSpamPositionsCount: number
  // Sum of (currentPriceUsd * openQuantityFromFifo) over RECONCILED positions only — the real
  // market value backing officialUnrealizedPnlUsd.
  reconciledMarketValueUsd: number
  // Sum of openCostBasisUsd over RECONCILED positions only.
  reconciledCostBasisUsd: number
  // reconciledOpenPositions / totalOpenPositions, as a 0-100 percent (0 when there are no open
  // positions at all — vacuously fully covered, matching derivePublicPnlStatus's own "empty is ok"
  // convention elsewhere in this file).
  unrealizedCoveragePercent: number
  // OPEN-POSITION COVERAGE, DISCLOSED, ADDITIVE (Wallet Scanner second-pass audit, task 2 — "do not
  // count as a current open-position coverage failure if balance is truly absent"). A position
  // excluded as `missing_balance` (classification, from exclusionReason `missing_canonical_balance`)
  // is not a CURRENTLY open position this scan failed to price — it's a FIFO-inferred position with
  // no real evidence it's still held at all (see the exact wording this reason now carries on
  // ExcludedUnrealizedPosition). Counting it against coverage the same way as a real, balance-
  // verified-but-unpriced position would overstate how broken the scan is. This field excludes those
  // from BOTH the numerator and denominator; `unrealizedCoveragePercent` above is UNCHANGED (still
  // includes them) for any existing caller relying on its exact prior definition.
  openPositionCoveragePercent: number
}

// Shared factory for the "reconciliation never ran" summary — used by degraded/fallback FifoOutput
// shapes (src/pipeline/utils.ts's fifoEngineFallback) and test fixtures, so those can never drift
// from this module's own definition of an empty summary. Returns a FRESH object each call (never a
// shared frozen singleton whose `excludedPositions` array could be mutated by one consumer and seen
// by another). Same value-exported-from-a-types-file convention this codebase already uses
// (DEFAULT_RECOVERY_CAPS in recoveryPolicy/types.ts).
export function emptyUnrealizedReconciliation(): UnrealizedReconciliationSummary {
  return {
    totalOpenPositions: 0,
    reconciledOpenPositions: 0,
    excludedOpenPositions: 0,
    excludedCandidateMarketValueUsd: 0,
    excludedCandidateUnrealizedPnlUsd: 0,
    officialUnrealizedPnlUsd: null,
    reconciliationStatus: 'not_reconciled',
    excludedPositions: [],
    reconciledPositionsByPriceSource: {},
    excludedReasonCounts: {},
    excludedClassificationCounts: {},
    deadOrSpamPositionsCount: 0,
    reconciledMarketValueUsd: 0,
    reconciledCostBasisUsd: 0,
    unrealizedCoveragePercent: 0,
    openPositionCoveragePercent: 0,
  }
}

// Richer, OPTIONAL companion to CanonicalBalanceLookup, sourced from the SAME already-fetched
// canonical holdings snapshot (no additional holdings fetch anywhere — see runWalletScanV2.ts).
// Supplies only the extra per-position metadata the diagnostics above report; `balance` itself is
// still decided by CanonicalBalanceLookup so the inclusion/exclusion decision has exactly one owner.
export type CanonicalPositionMetadata = {
  symbol: string | null
  decimals: number | null
  // Echo of the key the snapshot ACTUALLY resolved — lets computePnl detect a chain/token key
  // mismatch instead of silently trusting a lookup that answered for a different position.
  resolvedChain: SupportedChain
  resolvedTokenAddress: string
  // True only when the snapshot itself marks this position synthetic/quarantined. Absent/false
  // means "not flagged", never "unknown" — this engine never infers a quarantine of its own.
  quarantined?: boolean
}

export type CanonicalPositionMetadataLookup = (token: string, chain: SupportedChain) => CanonicalPositionMetadata | null

// Reports WHICH real source produced the current price for a position, for diagnostics only. Returns
// null when the caller genuinely does not know — never a fabricated/default source label.
export type CurrentPriceSourceLookup = (token: string, chain: SupportedChain) => string | null

// CANONICAL CURRENT-PRICE LOOKUP, DISCLOSED, ADDITIVE (found live, this task — confirmed production
// evidence: totalOpenPositions: 60, reconciledOpenPositions: 0, every position excluded as
// missing_verified_current_price with currentPriceSource: null for all 60). ROOT CAUSE, AUDITED: the
// price fed into reconciliation (CurrentPriceUsdLookup, supplied by priceLotsForWallet.ts) comes from
// this codebase's HISTORICAL/at-trade-time pricing infrastructure (pricingAtTimeEngine querying
// DexScreener/CoinGecko/GoldRush/basedex fresh, per token) — a COMPLETELY DIFFERENT system from the
// already-resolved, already-approved prices runWalletScanV2.ts's own holdings snapshot carries
// (TokenHolding.providerPriceUsd, or src/modules/pricing's resolvePrices() output — the exact same
// data buildPortfolioSummary already uses for the portfolio total). For most of the wallet's real
// holdings, especially illiquid/long-tail tokens, the historical-pricing system's own live "current"
// lookup path never finds anything (no historical evidence infrastructure exists for "right now"),
// so the reconciliation was starved of a price it already had, sitting one module away.
//
// FIX: an optional, PREFERRED-when-present lookup that returns the SAME canonical (holdings-derived)
// price + REAL provenance already resolved for portfolio valuation — no new provider/DexScreener/
// holdings call, just reusing what runWalletScanV2.ts already computed. When absent, computePnl
// falls back to the pre-existing currentPriceUsdLookup + currentPriceSourceLookup exactly as before
// (zero behavior change for any caller that hasn't wired this in).
export type CanonicalCurrentPriceResult = { priceUsd: number; source: string }
export type CanonicalCurrentPriceLookup = (token: string, chain: SupportedChain) => CanonicalCurrentPriceResult | null

// NO-LIQUIDITY-ANYWHERE LOOKUP, DISCLOSED, ADDITIVE (Wallet Scanner improvement audit — "classify
// spam/dead/unpriced tokens separately"): optional, PREFERRED-when-present, same pattern as
// canonicalCurrentPriceLookup above. Reports true only when src/modules/pricing's resolvePrices
// pass explicitly found NEITHER DexScreener NOR GeckoTerminal indexes any pair/pool for this token —
// a real, measured, structural fact (see resolvePricesDetailed's own noLiquidityFoundKeys header),
// never inferred here. Absent/false means "not known to be unindexed", never "confirmed indexed".
export type NoLiquidityFoundLookup = (token: string, chain: SupportedChain) => boolean

export type UnrealizedReconciliationDiagnosticsContext = {
  positionMetadataLookup?: CanonicalPositionMetadataLookup
  currentPriceSourceLookup?: CurrentPriceSourceLookup
  canonicalCurrentPriceLookup?: CanonicalCurrentPriceLookup
  noLiquidityFoundLookup?: NoLiquidityFoundLookup
}

export type { NormalizedEvent }
