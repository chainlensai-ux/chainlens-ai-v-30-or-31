// MODULE 6 — fifoEngine
//
// Computes real, quantity-based FIFO lot matching over normalized (base + recovered) events.
// Pure — no provider calls anywhere in this module. Never modifies timelines (no import of
// timelineBuilder at all) and never modifies recoveryPolicy (reads only the RawProviderEvent[]
// it produced, has no write path back into it). Never guesses cost basis: every USD figure comes
// only from an optional, caller-supplied price lookup — when absent, figures stay honestly null
// rather than estimated (Architecture Step 9 §4).

import type { NormalizedEvent } from '../normalization/types'
import { normalizeEvents } from '../normalization/index'
import type { RawProviderEvent, SupportedChain } from '../providerFetchWindow/types'
import type {
  CanonicalBalanceLookup,
  CanonicalCurrentPriceLookup,
  CurrentPriceUsdLookup,
  ExcludedUnrealizedPosition,
  FifoOutput,
  IntegrityFlags,
  MatchedLot,
  OpenLot,
  PriceUsdLookup,
  PublicPnlStatus,
  UnmatchedEventIdentity,
  UnrealizedExclusionReason,
  UnrealizedReconciliationDiagnosticsContext,
  UnrealizedReconciliationStatus,
  UnrealizedReconciliationSummary,
} from './types'
import { buildLotId, groupByToken, mergeNormalizedEvents } from './utils'

export type {
  CanonicalBalanceLookup,
  CanonicalCurrentPriceLookup,
  CanonicalCurrentPriceResult,
  CanonicalPositionMetadata,
  CanonicalPositionMetadataLookup,
  CurrentPriceSourceLookup,
  CurrentPriceUsdLookup,
  ExcludedUnrealizedPosition,
  FifoOutput,
  IntegrityFlags,
  LotEvidenceQuality,
  MatchedLot,
  OpenLot,
  PriceUsdLookup,
  PublicPnlStatus,
  UnmatchedEventIdentity,
  UnrealizedExclusionReason,
  UnrealizedReconciliationDiagnosticsContext,
  UnrealizedReconciliationStatus,
  UnrealizedReconciliationSummary,
} from './types'

const noPriceLookup: PriceUsdLookup = () => null
const noCurrentPriceLookup: CurrentPriceUsdLookup = () => null

// PURE. Builds the chronologically-sorted open-lot inventory from every inbound (buy) leg across
// the merged base + recovered event set. `recoveredEvents` here are already-normalized (the
// RawProviderEvent -> NormalizedEvent conversion for recovery output happens once, in
// buildFifoOutput, via the existing normalization module's normalizeEvents — never re-implemented
// here). Every lot's costBasisUsd is resolved via priceUsdLookup only; absent that, it's null.
export function buildLots(
  normalizedEvents: NormalizedEvent[],
  recoveredEvents: NormalizedEvent[],
  priceUsdLookup: PriceUsdLookup = noPriceLookup,
): OpenLot[] {
  const merged = mergeNormalizedEvents(normalizedEvents, recoveredEvents)
  const buys = merged.filter((e) => e.direction === 'inbound')

  const lots: OpenLot[] = buys.map((event) => {
    const costBasisUsd = priceUsdLookup(event)
    return {
      lotId: buildLotId(event.chain, event.contract, event.txHash, Date.parse(event.timestamp)),
      token: event.contract,
      chain: event.chain,
      openedAt: Date.parse(event.timestamp),
      openedTxHash: event.txHash,
      amountOpened: event.amount,
      amountRemaining: event.amount,
      costBasisUsd,
      evidenceQuality: costBasisUsd != null ? 'verified' : 'unpriced',
      sourceFromAddress: event.fromAddress,
      sourceToAddress: event.toAddress,
      sourceAmountRaw: event.amountRaw,
    }
  })

  return lots.sort((a, b) => a.openedAt - b.openedAt)
}

type MatchResult = {
  matchedLots: MatchedLot[]
  remainingOpenLots: OpenLot[]
  unmatchedSells: number
  unmatchedSellEvents: UnmatchedEventIdentity[]
}

// PURE. Matches every outbound leg in the merged event set against the oldest available open lot
// for that token first (true FIFO order). A sell that finds no open lot at all (or only a partial
// lot, leaving a remainder with no earlier buy to draw from) counts toward `unmatchedSells` — it
// is never backfilled with an invented lot (Architecture Step 9 §4).
export function matchLotsFIFO(
  lots: OpenLot[],
  sellEvents: NormalizedEvent[],
  priceUsdLookup: PriceUsdLookup = noPriceLookup,
): MatchResult {
  // Work on a deep-enough copy so the caller's `lots` array is never mutated.
  const workingLots = lots.map((lot) => ({ ...lot }))
  const lotsByToken = groupByToken(workingLots)
  const matchedLots: MatchedLot[] = []
  let unmatchedSells = 0
  const unmatchedSellEvents: UnmatchedEventIdentity[] = []
  // OCCURRENCE COUNTER, DISCLOSED (chronology/duplicate-lotId follow-up task — confirmed production
  // bug: `publishedMatchedLots` repeated the identical `lotId` for different partial-fill matches of
  // the same open lot sold across multiple sells, since MatchedLot.lotId was always just the
  // underlying OpenLot's own id). Each match consuming a given open lot gets a distinct, deterministic
  // published id (`${lot.lotId}#${occurrence}`) — legitimate partial fills are never merged or
  // dropped, they just each get their own identity. lotIdentityKey (scanDeterminismAudit.ts) never
  // reads this field, so canonical fingerprinting/manifest identity is unaffected by this change.
  const matchOccurrenceByLotId = new Map<string, number>()

  const sortedSells = [...sellEvents].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))

  for (const sell of sortedSells) {
    const key = `${sell.chain}:${sell.contract.toLowerCase()}`
    const tokenLots = (lotsByToken.get(key) ?? []).filter((l) => l.amountRemaining > 0)
    let remainingToMatch = sell.amount
    let matchedAnyAmount = false
    const proceedsUsdTotal = priceUsdLookup(sell)
    const sellTimestampMs = Date.parse(sell.timestamp)

    for (const lot of tokenLots) {
      if (remainingToMatch <= 0) break
      if (lot.amountRemaining <= 0) continue
      // CHRONOLOGY GUARD, DISCLOSED (confirmed production bug: FIFO matched a sell against the
      // oldest STILL-OPEN lot for a token regardless of whether that lot's own openedAt was actually
      // before the sell — e.g. no genuinely earlier buy existed yet and the engine still consumed a
      // later-dated lot, fabricating a closedAt < openedAt match). Lots here are ordered ascending by
      // openedAt (buildLots' own global sort, preserved by groupByToken), so once the next candidate
      // lot opened AFTER this sell, every remaining lot for this token did too — stop matching this
      // sell here rather than fabricate an impossible match; any unconsumed quantity flows through
      // the existing, real unmatchedSells/unmatchedSellEvents path (never silently dropped).
      if (lot.openedAt > sellTimestampMs) break

      const amountFromThisLot = Math.min(lot.amountRemaining, remainingToMatch)
      const proportionOfSell = proceedsUsdTotal != null && sell.amount > 0 ? (amountFromThisLot / sell.amount) * proceedsUsdTotal : null
      const costBasisForPortion = lot.costBasisUsd != null && lot.amountOpened > 0
        ? (amountFromThisLot / lot.amountOpened) * lot.costBasisUsd
        : null
      const isVerified = costBasisForPortion != null && proportionOfSell != null
      const occurrence = matchOccurrenceByLotId.get(lot.lotId) ?? 0
      matchOccurrenceByLotId.set(lot.lotId, occurrence + 1)
      const publishedLotId = occurrence === 0 ? lot.lotId : `${lot.lotId}#${occurrence}`

      matchedLots.push({
        lotId: publishedLotId,
        token: lot.token,
        chain: lot.chain,
        openedAt: lot.openedAt,
        closedAt: Date.parse(sell.timestamp),
        openedTxHash: lot.openedTxHash,
        closedTxHash: sell.txHash,
        amount: amountFromThisLot,
        costBasisUsd: costBasisForPortion,
        proceedsUsd: proportionOfSell,
        realizedPnlUsd: isVerified ? proportionOfSell! - costBasisForPortion! : null,
        evidenceQuality: isVerified ? 'verified' : 'unpriced',
      })

      // Shrink the lot's cost basis by the same proportion as the amount just consumed, so a
      // partially-sold lot's remaining costBasisUsd reflects only its remaining amount — not the
      // original full-lot cost basis. Without this, computePnl's remaining-open-lot cost basis
      // double-counts the portion already realized above (costBasisForPortion).
      if (lot.costBasisUsd != null) lot.costBasisUsd -= costBasisForPortion ?? 0
      lot.amountOpened -= amountFromThisLot
      lot.amountRemaining -= amountFromThisLot
      remainingToMatch -= amountFromThisLot
      matchedAnyAmount = true
    }

    if (remainingToMatch > 0 || !matchedAnyAmount) {
      unmatchedSells += 1
      // remainingToMatch already equals sell.amount when nothing matched at all (matchedAnyAmount
      // false) — this is the real unmatched QUANTITY either way, never the sell's full original
      // amount when only part of it went unmatched.
      unmatchedSellEvents.push({
        chain: sell.chain,
        txHash: sell.txHash,
        token: sell.contract,
        timestamp: Date.parse(sell.timestamp),
        direction: 'outbound',
        amount: remainingToMatch,
        fromAddress: sell.fromAddress,
        toAddress: sell.toAddress,
        amountRaw: sell.amountRaw,
      })
    }
  }

  const remainingOpenLots = [...lotsByToken.values()].flat().filter((l) => l.amountRemaining > 0)
  return { matchedLots, remainingOpenLots, unmatchedSells, unmatchedSellEvents }
}

type PnlSummary = {
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  costBasisUsd: number | null
  // CANONICAL-BALANCE RECONCILIATION, DISCLOSED, ADDITIVE — see CanonicalBalanceLookup's own header
  // in types.ts. `${chain}:${token.toLowerCase()}` keys for every token whose FIFO-derived open
  // quantity was excluded from unrealizedPnlUsd because it could not be reconciled against a real,
  // independently-fetched current balance (either no canonical balance was known, or the open
  // quantity exceeded it) — always empty when canonicalBalanceLookup isn't supplied. KEPT for
  // backward compatibility; `unrealizedReconciliation.excludedPositions` below carries the full,
  // per-position detail (same set of positions, same order).
  unrealizedPnlExcludedTokens: string[]
  unrealizedReconciliation: UnrealizedReconciliationSummary
}

// RECONCILIATION TOLERANCE, DISCLOSED: a small float-rounding allowance (0.1%) — real on-chain
// balances and event-replayed quantities can differ by dust-level floating-point noise even when
// genuinely consistent (e.g. a token with many small partial fills); this is NOT a loophole for a
// meaningfully wrong quantity to sneak through — anything beyond this tiny slack fails closed.
const CANONICAL_BALANCE_RECONCILIATION_TOLERANCE = 1.001

// SANE-PRICE RANGE, DISCLOSED: the SAME ($0, $1e6] bound this codebase already applies to every
// other price it accepts (src/pipeline/pricingAtTimeAdapter.ts's own MIN/MAX_VALID_USD_PRICE, and
// lib/engines/unrealizedPnlEngine.ts's identical guard) — not a new or stricter standard invented
// here, just the existing one finally applied at this specific reconciliation point too.
const MIN_VALID_CURRENT_PRICE_USD = 0
const MAX_VALID_CURRENT_PRICE_USD = 1e6

// Token decimals are a uint8 on-chain; every real ERC-20 sits far below this bound. A value outside
// it (or non-integer/non-finite) means the canonical snapshot's own normalization is untrustworthy.
const MAX_PLAUSIBLE_TOKEN_DECIMALS = 36

function isUsableDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_PLAUSIBLE_TOKEN_DECIMALS
}

function emptyReconciliationSummary(
  officialUnrealizedPnlUsd: number | null,
  totalOpenPositions: number,
  reconciliationStatus: UnrealizedReconciliationStatus,
): UnrealizedReconciliationSummary {
  return {
    totalOpenPositions,
    reconciledOpenPositions: reconciliationStatus === 'not_reconciled' ? 0 : totalOpenPositions,
    excludedOpenPositions: 0,
    excludedCandidateMarketValueUsd: 0,
    excludedCandidateUnrealizedPnlUsd: 0,
    officialUnrealizedPnlUsd,
    reconciliationStatus,
    excludedPositions: [],
    reconciledPositionsByPriceSource: {},
    excludedReasonCounts: {},
    // Not computed in the zero-change (unreconciled) path — reconciliation didn't run, so there is
    // no per-position provenance/cost-basis breakdown to report, only the pre-existing aggregate
    // figures (costBasisUsd, officialUnrealizedPnlUsd) already returned alongside this summary.
    reconciledMarketValueUsd: 0,
    reconciledCostBasisUsd: 0,
    // "Not reconciled" means every open position is treated as pass-through (never excluded) — 100%
    // nominal coverage when there is anything open at all, 0 when there is nothing to cover.
    unrealizedCoveragePercent: totalOpenPositions > 0 && reconciliationStatus === 'not_reconciled' ? 100 : 0,
  }
}

// PURE. Aggregates PnL strictly from verified (priced, non-estimate) matched lots — an unpriced
// lot contributes nothing to realizedPnlUsd/costBasisUsd (never a fabricated 0), and if there is
// not a single verified figure to sum, the aggregate itself stays null rather than reporting 0
// (Architecture Step 9 §4 / Step 7 §6).
export function computePnl(
  matchedLots: MatchedLot[],
  remainingOpenLots: OpenLot[],
  currentPriceUsdLookup: CurrentPriceUsdLookup = noCurrentPriceLookup,
  canonicalBalanceLookup?: CanonicalBalanceLookup,
  diagnostics?: UnrealizedReconciliationDiagnosticsContext,
): PnlSummary {
  const verifiedMatched = matchedLots.filter((l) => l.evidenceQuality === 'verified')

  const realizedPnlUsd = verifiedMatched.length > 0
    ? verifiedMatched.reduce((sum, l) => sum + (l.realizedPnlUsd ?? 0), 0)
    : null

  const pricedCostBasisLots = [
    ...verifiedMatched.map((l) => l.costBasisUsd as number),
    ...remainingOpenLots.filter((l) => l.costBasisUsd != null).map((l) => l.costBasisUsd as number),
  ]
  const costBasisUsd = pricedCostBasisLots.length > 0 ? pricedCostBasisLots.reduce((sum, v) => sum + v, 0) : null

  // ZERO-CHANGE PATH, DISCLOSED: when no canonicalBalanceLookup is supplied, this is the EXACT
  // original expression (same map/filter/reduce over remainingOpenLots, same iteration order) —
  // guarantees byte-identical unrealizedPnlUsd for every existing caller that hasn't opted into
  // reconciliation, never a behavior change by default.
  // POSITION KEYING, DISCLOSED: `${chain}:${token.toLowerCase()}` — the chain is part of the key, so
  // the SAME token address on two different chains is two distinct positions that can never collide;
  // and native ETH (providerFetchWindow's NATIVE_ASSET_ADDRESS pseudo-address,
  // 0xeeee…eeee) has a genuinely different address from any chain's canonical WETH contract, so those
  // never collide either. This module deliberately does NOT canonicalize native->WETH here (unlike
  // quoteLegPricing's resolveNativePricingToken, which rewrites ONLY a price-lookup argument and
  // explicitly never merges balances) — merging them would pool two separate real balances into one
  // reconciliation check.
  function positionKey(chain: SupportedChain, token: string): string {
    return `${chain}:${token.toLowerCase()}`
  }

  // Groups every remaining open lot by position, so the reconciliation check runs on the SAME total
  // quantity computePnl is about to value — a token split across several partially-consumed lots
  // must reconcile as a whole, not lot-by-lot (a per-lot check could pass every individual lot while
  // the SUM still exceeds the real balance).
  const openLotsByToken = new Map<string, OpenLot[]>()
  for (const lot of remainingOpenLots) {
    const key = positionKey(lot.chain, lot.token)
    const list = openLotsByToken.get(key)
    if (list) list.push(lot)
    else openLotsByToken.set(key, [lot])
  }
  const totalOpenPositions = openLotsByToken.size

  if (!canonicalBalanceLookup) {
    const unrealizedTerms = remainingOpenLots
      .map((lot) => {
        const currentPrice = currentPriceUsdLookup(lot.token, lot.chain)
        if (currentPrice == null || lot.costBasisUsd == null) return null
        return currentPrice * lot.amountRemaining - lot.costBasisUsd
      })
      .filter((v): v is number => v != null)
    const unrealizedPnlUsd = unrealizedTerms.length > 0 ? unrealizedTerms.reduce((sum, v) => sum + v, 0) : null
    return {
      realizedPnlUsd,
      unrealizedPnlUsd,
      costBasisUsd,
      unrealizedPnlExcludedTokens: [],
      unrealizedReconciliation: emptyReconciliationSummary(unrealizedPnlUsd, totalOpenPositions, 'not_reconciled'),
    }
  }

  // RECONCILED PATH, DISCLOSED. Exclusion-reason precedence is fixed and evaluated in this exact
  // order, so a position that fails several checks always reports the SAME single, most-fundamental
  // reason (never an arbitrary or run-dependent one):
  //   1. invalid_open_quantity            — FIFO's own quantity is unusable; nothing downstream can be trusted
  //   2. chain_or_token_key_mismatch      — the snapshot answered for a DIFFERENT position entirely
  //   3. synthetic_or_quarantined_position— the snapshot itself flags this position as not real
  //   4. invalid_decimals                 — the snapshot's normalization is untrustworthy, so its balance is too
  //   5. missing_canonical_balance        — no balance evidence at all
  //   6. open_quantity_exceeds_balance    — balance known, FIFO quantity is larger (the ~$545k class)
  //   7. missing_verified_current_price   — reconciled quantity, but nothing to value it with
  //   8. unverified_or_outlier_price      — a price exists but is outside the verified sane range
  //
  // OFFICIAL-TOTAL EQUIVALENCE, DISCLOSED: reasons 7 and 8 are reported at POSITION level, which is
  // exactly equivalent to the previous per-lot skip for the official number — currentPriceUsdLookup
  // is keyed by (token, chain), never by lot, so every lot of a position always receives the
  // identical price. A position with no price contributed exactly zero terms before this change and
  // contributes exactly zero now. Reason 8 is the one genuine behavior delta (an outlier price used
  // to be summed into official PnL; it is now refused) — that is the "exclude price-outlier
  // positions from official unrealized PnL" safety requirement, applied rather than only logged.
  // Per-lot null costBasisUsd is still skipped per-lot below, unchanged.
  const excludedPositions: ExcludedUnrealizedPosition[] = []
  const unrealizedPnlExcludedTokens: string[] = []
  const unrealizedTerms: number[] = []
  let reconciledOpenPositions = 0
  let reconciledMarketValueUsd = 0
  let reconciledCostBasisUsd = 0
  const reconciledPositionsByPriceSource: Record<string, number> = {}

  for (const [key, lots] of openLotsByToken) {
    const token = lots[0].token
    const chain = lots[0].chain
    const openQuantityFromFifo = lots.reduce((sum, l) => sum + l.amountRemaining, 0)
    // Summed over the lots that actually carry one — a position with no priced lot reports null
    // rather than a fabricated 0.
    const pricedOpenLots = lots.filter((l) => l.costBasisUsd != null)
    const openCostBasisUsd = pricedOpenLots.length > 0
      ? pricedOpenLots.reduce((sum, l) => sum + (l.costBasisUsd as number), 0)
      : null
    // AGGREGATE-ARITHMETIC FIX, DISCLOSED (found live, this task — confirmed production evidence:
    // reconciledMarketValueUsd - reconciledCostBasisUsd did not equal officialUnrealizedPnlUsd for
    // 5 reconciled positions). ROOT CAUSE: reconciledMarketValueUsd below used to be accumulated from
    // `openQuantityFromFifo` — ALL of a position's lots, including any lot with a null costBasisUsd
    // — while reconciledCostBasisUsd (openCostBasisUsd above) and the per-lot unrealizedTerms loop
    // below both only ever include PRICED lots (costBasisUsd != null, see their own existing
    // comments). A position with a MIX of priced and unpriced open lots therefore had its market
    // value overstated by exactly `price * (unpriced lots' quantity)` relative to both the cost
    // basis and the unrealized-PnL sum it was supposed to reconcile against. Fixed by scoping the
    // market-value quantity to the SAME priced-lot subset cost basis and unrealizedTerms already
    // use — this changes ONLY which quantity the aggregate diagnostic multiplies by, never which
    // lots are priced, never FIFO matching, and never which positions are included/excluded.
    const pricedOpenQuantity = pricedOpenLots.reduce((sum, l) => sum + l.amountRemaining, 0)

    const metadata = diagnostics?.positionMetadataLookup?.(token, chain) ?? null
    const canonicalCurrentBalance = canonicalBalanceLookup(token, chain)
    // CANONICAL PRICE PREFERENCE, DISCLOSED — see CanonicalCurrentPriceLookup's own header in
    // types.ts for the full trace. When the caller supplies the canonical (holdings-derived) price,
    // it is used for BOTH the value fed into the reconciliation math below AND the reported
    // provenance — never a guess blended from two different systems. Falling back to the
    // pre-existing currentPriceUsdLookup + currentPriceSourceLookup preserves byte-identical
    // behavior for any caller that hasn't wired the canonical lookup in.
    const canonicalPrice = diagnostics?.canonicalCurrentPriceLookup?.(token, chain) ?? null
    const rawCurrentPrice = canonicalPrice ? canonicalPrice.priceUsd : currentPriceUsdLookup(token, chain)
    const currentPriceSource = canonicalPrice ? canonicalPrice.source : (diagnostics?.currentPriceSourceLookup?.(token, chain) ?? null)

    const excessOpenQuantity =
      canonicalCurrentBalance != null && Number.isFinite(openQuantityFromFifo) && openQuantityFromFifo > canonicalCurrentBalance
        ? openQuantityFromFifo - canonicalCurrentBalance
        : null

    // Candidate figures are computed from the SAME price/quantity the official path would have
    // used — this is the refused number itself, reported so its inflation is measurable. Only
    // computable when a real (even if outlier) price exists.
    const candidateMarketValueUsd =
      rawCurrentPrice != null && Number.isFinite(rawCurrentPrice * openQuantityFromFifo)
        ? rawCurrentPrice * openQuantityFromFifo
        : null
    const candidateUnrealizedPnlUsd =
      candidateMarketValueUsd != null && openCostBasisUsd != null
        ? candidateMarketValueUsd - openCostBasisUsd
        : null

    function exclude(exclusionReason: UnrealizedExclusionReason): void {
      excludedPositions.push({
        chainId: chain,
        tokenAddress: token,
        symbol: metadata?.symbol ?? null,
        openQuantityFromFifo,
        canonicalCurrentBalance,
        excessOpenQuantity,
        decimalsUsed: metadata?.decimals ?? null,
        currentPriceUsd: rawCurrentPrice,
        currentPriceSource,
        openCostBasisUsd,
        candidateMarketValueUsd,
        candidateUnrealizedPnlUsd,
        exclusionReason,
      })
      unrealizedPnlExcludedTokens.push(key)
    }

    // 1. FIFO's own open quantity must be a real, positive, finite number.
    if (!Number.isFinite(openQuantityFromFifo) || openQuantityFromFifo <= 0) {
      exclude('invalid_open_quantity')
      continue
    }
    // 2. The snapshot must have answered for THIS position, not a different one.
    if (metadata && (metadata.resolvedChain !== chain || metadata.resolvedTokenAddress.toLowerCase() !== token.toLowerCase())) {
      exclude('chain_or_token_key_mismatch')
      continue
    }
    // 3. Only ever fires on an explicit flag from the snapshot — never inferred here.
    if (metadata?.quarantined === true) {
      exclude('synthetic_or_quarantined_position')
      continue
    }
    // 4. Checked only when the snapshot actually supplied a decimals value; an absent one is
    //    "unknown metadata", not a failure, and never fabricates an exclusion.
    if (metadata != null && metadata.decimals != null && !isUsableDecimals(metadata.decimals)) {
      exclude('invalid_decimals')
      continue
    }
    // 5/6. The original, unchanged fail-closed reconciliation — now split into its two real reasons.
    if (canonicalCurrentBalance == null) {
      exclude('missing_canonical_balance')
      continue
    }
    if (openQuantityFromFifo > canonicalCurrentBalance * CANONICAL_BALANCE_RECONCILIATION_TOLERANCE) {
      exclude('open_quantity_exceeds_balance')
      continue
    }
    // 7/8. Price checks — see the OFFICIAL-TOTAL EQUIVALENCE note above.
    if (rawCurrentPrice == null) {
      exclude('missing_verified_current_price')
      continue
    }
    if (!Number.isFinite(rawCurrentPrice) || rawCurrentPrice <= MIN_VALID_CURRENT_PRICE_USD || rawCurrentPrice > MAX_VALID_CURRENT_PRICE_USD) {
      exclude('unverified_or_outlier_price')
      continue
    }

    reconciledOpenPositions += 1
    // Scoped to pricedOpenQuantity (not openQuantityFromFifo) — see this position's own
    // AGGREGATE-ARITHMETIC FIX comment above. Consistent with reconciledCostBasisUsd/
    // unrealizedTerms: an unpriced lot contributes to neither, so it must not inflate this either.
    reconciledMarketValueUsd += rawCurrentPrice * pricedOpenQuantity
    if (openCostBasisUsd != null) reconciledCostBasisUsd += openCostBasisUsd
    const sourceKey = currentPriceSource ?? 'unknown'
    reconciledPositionsByPriceSource[sourceKey] = (reconciledPositionsByPriceSource[sourceKey] ?? 0) + 1
    for (const lot of lots) {
      if (lot.costBasisUsd == null) continue
      unrealizedTerms.push(rawCurrentPrice * lot.amountRemaining - lot.costBasisUsd)
    }
  }

  // OFFICIAL TOTAL, DISCLOSED: computed strictly from RECONCILED positions' own lot terms — the
  // exact same expression the zero-change path above uses, just already filtered down to positions
  // that survived every reconciliation check. An excluded position contributes nothing here, ever.
  const unrealizedPnlUsd = unrealizedTerms.length > 0 ? unrealizedTerms.reduce((sum, v) => sum + v, 0) : null

  // Excluded candidate totals sum ONLY over positions that had a computable candidate — a position
  // with no resolvable price contributes nothing here rather than a fabricated 0. These totals are
  // reported alongside, and never merged into, officialUnrealizedPnlUsd.
  const excludedCandidateMarketValueUsd = excludedPositions.reduce((sum, p) => sum + (p.candidateMarketValueUsd ?? 0), 0)
  const excludedCandidateUnrealizedPnlUsd = excludedPositions.reduce((sum, p) => sum + (p.candidateUnrealizedPnlUsd ?? 0), 0)
  const excludedReasonCounts: Partial<Record<UnrealizedExclusionReason, number>> = {}
  for (const p of excludedPositions) {
    excludedReasonCounts[p.exclusionReason] = (excludedReasonCounts[p.exclusionReason] ?? 0) + 1
  }

  const reconciliationStatus: UnrealizedReconciliationStatus =
    excludedPositions.length === 0
      ? 'ok'
      : reconciledOpenPositions === 0
        ? 'failed'
        : 'partial'

  return {
    realizedPnlUsd,
    unrealizedPnlUsd,
    costBasisUsd,
    unrealizedPnlExcludedTokens,
    unrealizedReconciliation: {
      totalOpenPositions,
      reconciledOpenPositions,
      excludedOpenPositions: excludedPositions.length,
      excludedCandidateMarketValueUsd,
      excludedCandidateUnrealizedPnlUsd,
      officialUnrealizedPnlUsd: unrealizedPnlUsd,
      reconciliationStatus,
      excludedPositions,
      reconciledPositionsByPriceSource,
      excludedReasonCounts,
      reconciledMarketValueUsd,
      reconciledCostBasisUsd,
      unrealizedCoveragePercent: totalOpenPositions > 0 ? (reconciledOpenPositions / totalOpenPositions) * 100 : 0,
    },
  }
}

// COVERAGE FIX, DISCLOSED (Clark-summary-confidence-mislabeling task): previously this only checked
// `verifiedMatchedCount >= 10` (an absolute count) to return 'ok' — completely ignoring how much of
// the wallet's real sell activity actually got matched at all. Found live: a wallet with 17 verified
// closed lots but 118 unmatched sells (i.e. ~87% of its real sell events have NO cost-basis match at
// all) was still labeled "Verified FIFO sample — official PnL available." — a real, honest-looking
// confidence claim the underlying evidence doesn't support. Now also requires that verified lots
// make up at least half of the wallet's total attempted sell activity (every matched lot, verified
// or not, plus every completely unmatched sell) before granting the strongest confidence tier —
// `totalSellAttempts` counts ALL matched lots (`matchedCount`, verified or lower-quality) plus
// unmatched sells, so a wallet whose sells are mostly unresolved never crosses this bar regardless
// of its absolute verified count.
// TEST-SUPPORT EXPORT, DISCLOSED: exported solely so a test can assert this coverage-threshold
// logic directly, without constructing full normalizedEvents/lot fixtures through buildFifoOutput —
// no behavior change, same function real callers use.
export function derivePublicPnlStatus(
  verifiedMatchedCount: number,
  matchedCount: number,
  unmatchedSells: number,
  hardInvalid: boolean,
): PublicPnlStatus {
  if (hardInvalid) return 'unavailable'
  if (verifiedMatchedCount === 0) return 'unavailable'
  if (verifiedMatchedCount < 10) return 'limited_verified_sample'
  const totalSellAttempts = matchedCount + unmatchedSells
  const verifiedCoverageRatio = totalSellAttempts > 0 ? verifiedMatchedCount / totalSellAttempts : 1
  if (verifiedCoverageRatio < 0.5) return 'limited_verified_sample'
  return 'ok'
}

// Orchestrates the full FIFO pipeline into the final output shape. `recoveredRawEvents` are
// recoveryPolicy's raw output — normalized here via the existing normalization module (a pure
// reuse, not a new provider call) before being merged into the lot/match pipeline.
export function buildFifoOutput(params: {
  normalizedEvents: NormalizedEvent[]
  recoveredRawEvents: RawProviderEvent[]
  walletAddress: string
  priceUsdLookup?: PriceUsdLookup
  currentPriceUsdLookup?: CurrentPriceUsdLookup
  // See CanonicalBalanceLookup's own header in types.ts — optional, defaults to unset (zero
  // behavior change unless a caller explicitly opts in).
  canonicalBalanceLookup?: CanonicalBalanceLookup
  // Diagnostics-only enrichment for the reconciliation report — see
  // UnrealizedReconciliationSummary's own header in types.ts. Never affects which positions are
  // included in official unrealized PnL beyond the reason LABEL each exclusion reports.
  unrealizedReconciliationDiagnostics?: UnrealizedReconciliationDiagnosticsContext
}): FifoOutput {
  const priceUsdLookup = params.priceUsdLookup ?? noPriceLookup
  const currentPriceUsdLookup = params.currentPriceUsdLookup ?? noCurrentPriceLookup

  const { normalizedEvents: recoveredNormalized } = normalizeEvents(params.recoveredRawEvents, params.walletAddress)
  const mergedAll = mergeNormalizedEvents(params.normalizedEvents, recoveredNormalized)
  const sells = mergedAll.filter((e) => e.direction === 'outbound')

  const lots = buildLots(params.normalizedEvents, recoveredNormalized, priceUsdLookup)
  const { matchedLots, remainingOpenLots, unmatchedSells, unmatchedSellEvents } = matchLotsFIFO(lots, sells, priceUsdLookup)
  // UNMATCHED BUY IDENTITIES, DISCLOSED, ADDITIVE: one UnmatchedEventIdentity per remaining open
  // lot — same array `remainingOpenLots` computePnl/unmatchedBuys already use, just re-shaped for
  // exact identity reporting. `sourceFromAddress`/`sourceToAddress`/`sourceAmountRaw` default to
  // real empty-string/null only for the (non-production) case of an OpenLot constructed directly
  // without going through buildLots above — buildLots itself always populates them from the real
  // source event.
  const unmatchedBuyEvents: UnmatchedEventIdentity[] = remainingOpenLots.map((lot) => ({
    chain: lot.chain,
    txHash: lot.openedTxHash,
    token: lot.token,
    timestamp: lot.openedAt,
    direction: 'inbound',
    amount: lot.amountRemaining,
    fromAddress: lot.sourceFromAddress ?? '',
    toAddress: lot.sourceToAddress ?? '',
    amountRaw: lot.sourceAmountRaw ?? null,
  }))
  const { realizedPnlUsd, unrealizedPnlUsd, costBasisUsd, unrealizedPnlExcludedTokens, unrealizedReconciliation } =
    computePnl(
      matchedLots,
      remainingOpenLots,
      currentPriceUsdLookup,
      params.canonicalBalanceLookup,
      params.unrealizedReconciliationDiagnostics,
    )

  const verifiedMatchedCount = matchedLots.filter((l) => l.evidenceQuality === 'verified').length
  const estimateOnlyLotsExcluded = matchedLots.filter((l) => l.evidenceQuality === 'unpriced').length
  const hardInvalid = params.normalizedEvents.length === 0 && recoveredNormalized.length === 0

  const integrityFlags: IntegrityFlags = {
    hardInvalid,
    estimateOnlyLotsExcluded,
    // This engine never fabricates a lot from missing evidence, so there is no code path that can
    // ever produce a synthetic lot — this stays 0 by construction, not by a runtime check.
    syntheticLotsExcluded: 0,
  }

  return {
    matchedLots,
    unmatchedBuys: remainingOpenLots.length,
    unmatchedSells,
    unmatchedBuyEvents,
    unmatchedSellEvents,
    realizedPnlUsd,
    unrealizedPnlUsd,
    costBasisUsd,
    publicPnlStatus: derivePublicPnlStatus(verifiedMatchedCount, matchedLots.length, unmatchedSells, hardInvalid),
    integrityFlags,
    unrealizedPnlExcludedTokens,
    unrealizedReconciliation,
  }
}

export type { SupportedChain }
