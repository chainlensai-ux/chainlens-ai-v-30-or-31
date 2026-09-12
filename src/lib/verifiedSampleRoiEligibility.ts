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
// PROOF STANDARD, DISCLOSED: a verified stablecoin lot is excluded from the ROI denominator only
// when swap/FIFO identity proves it is the cash/quote leg of an already-represented economic
// trade — never by symbol, never by a blanket stablecoin-address filter. Non-stablecoin verified
// lots always remain eligible. A genuine independent stablecoin movement (EOA/CEX transfer,
// mint-without-swap, stable-stable cash reshuffle with no opposite-direction risk asset) remains
// eligible. When quote-leg identity cannot be proven either way, ROI is unavailable — never
// guessed.
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

export type RoiDenominatorDisposition = 'include_economic_position' | 'exclude_quote_cash_leg' | 'unresolved'

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
  isQuoteLeg: boolean
  isIndependentStablecoinTrade: boolean
  roiDenominatorDisposition: RoiDenominatorDisposition
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
  nonStableOppositeOpen: boolean
  nonStableOppositeClose: boolean
  openingCounterAsset: string | null
  closingCounterAsset: string | null
  hasNonStable: boolean
  hasUnknownDirectionNonStable: boolean
  usdcInboundFromRouter: boolean
  usdcOutboundToRouter: boolean
}

function indexEventsForLotToken(
  events: readonly NormalizedEvent[],
  chain: SupportedChain,
  txHash: string,
  stableToken: string,
): TxEventIndex {
  const key = txGroupId(chain, txHash)
  const grouped = events.filter((event) => txGroupId(event.chain, event.txHash) === key)
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
}): VerifiedSampleRoiEligibility {
  const structuralLots = params.structuralLots ?? params.verifiedLots
  const events = params.normalizedEvents
  const eventsProvided = events != null

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
        isQuoteLeg: false,
        isIndependentStablecoinTrade: false,
        roiDenominatorDisposition: 'include_economic_position',
      })
      verifiedSampleRoiEligibleLots.push(lot)
      continue
    }

    const pairedOnOpen = riskByCloseTx.get(openingSwapGroupId) ?? []
    const pairedOnClose = riskByOpenTx.get(closingSwapGroupId) ?? []
    const pairedRiskAssetLotKeys = [...new Set([...pairedOnOpen, ...pairedOnClose].map(roiLotKey))]

    const openEvents = eventsProvided ? indexEventsForLotToken(events, lot.chain, lot.openedTxHash, lot.token) : null
    const closeEvents = eventsProvided ? indexEventsForLotToken(events, lot.chain, lot.closedTxHash, lot.token) : null

    const fifoProvenQuote = pairedRiskAssetLotKeys.length > 0
    const eventProvenQuote = Boolean(openEvents?.nonStableOppositeOpen || closeEvents?.nonStableOppositeClose)

    let disposition: RoiDenominatorDisposition
    let isQuoteLeg = false
    let isIndependentStablecoinTrade = false

    if (fifoProvenQuote || eventProvenQuote) {
      disposition = 'exclude_quote_cash_leg'
      isQuoteLeg = true
    } else if (!eventsProvided) {
      // Structural lots alone cannot distinguish an EOA/CEX cash movement from a native-ETH swap
      // whose opposite leg never produced an ERC20 FIFO lot. Fail closed.
      disposition = 'unresolved'
    } else if (
      openEvents?.hasUnknownDirectionNonStable
      || closeEvents?.hasUnknownDirectionNonStable
      || (openEvents?.hasNonStable && !openEvents.nonStableOppositeOpen)
      || (closeEvents?.hasNonStable && !closeEvents.nonStableOppositeClose)
    ) {
      disposition = 'unresolved'
    } else if (openEvents?.usdcInboundFromRouter || closeEvents?.usdcOutboundToRouter) {
      // Router counterparty with no proven opposite-direction risk asset: could be a native quote
      // swap. Do not guess.
      disposition = 'unresolved'
    } else {
      // No opposite-direction risk asset on either side. Counterparties are EOA/CEX or a 0x0 mint
      // — a mint without a swap is cash issuance, not a quote leg.
      disposition = 'include_economic_position'
      isIndependentStablecoinTrade = true
    }

    const openingCounterAsset = openEvents?.openingCounterAsset
      ?? (pairedOnOpen[0] ? pairedOnOpen[0].token.toLowerCase() : null)
    const closingCounterAsset = closeEvents?.closingCounterAsset
      ?? (pairedOnClose[0] ? pairedOnClose[0].token.toLowerCase() : null)

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
      isQuoteLeg,
      isIndependentStablecoinTrade,
      roiDenominatorDisposition: disposition,
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
