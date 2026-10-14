// What a stablecoin / ETH / WETH leg is doing inside a swap transaction.
//
// In a buy (wallet pays USDC/ETH, receives TOKEN) the USDC/ETH leg is the PAYMENT, not a sell of
// USDC. In a sell (wallet sends TOKEN, receives USDC/ETH) the USDC/ETH leg is the PROCEEDS, not a
// buy of USDC. The timelines previously counted both as trades of the quote asset, which inflated
// sells with every buy's payment and buys with every sell's proceeds.
//
// Only the canonical quote assets the pricing layer already trusts (verified stablecoins, canonical
// WETH, native ETH) are treated this way; every other token keeps its normal classification.
import type { NormalizedEvent } from '../modules/normalization/types'
import { isCanonicalWethAddress, isNativePseudoAddress, isVerifiedStablecoinAddress } from '../modules/quoteLegPricing/index'

export function isQuoteAssetEvent(event: Pick<NormalizedEvent, 'chain' | 'contract'>): boolean {
  const contract = event.contract.toLowerCase()
  return isNativePseudoAddress(contract)
    || isCanonicalWethAddress(event.chain, contract)
    || isVerifiedStablecoinAddress(event.chain, contract)
}

/** Outbound quote asset paid for a different, non-quote token received in the same tx. */
export function isBuyPaymentLeg(event: NormalizedEvent, sameTxEvents: readonly NormalizedEvent[]): boolean {
  if (event.direction !== 'outbound' || !isQuoteAssetEvent(event)) return false
  return sameTxEvents.some(e => e.direction === 'inbound' && !isQuoteAssetEvent(e))
}

/** Inbound quote asset received for a different, non-quote token sent in the same tx. */
export function isSellProceedsLeg(event: NormalizedEvent, sameTxEvents: readonly NormalizedEvent[]): boolean {
  if (event.direction !== 'inbound' || !isQuoteAssetEvent(event)) return false
  return sameTxEvents.some(e => e.direction === 'outbound' && !isQuoteAssetEvent(e))
}

/** Inbound quote asset in a tx where the wallet also sent that same asset (e.g. a router refunding
 *  unused ETH on a buy) — a refund, not a buy. */
export function isQuoteRefundLeg(event: NormalizedEvent, sameTxEvents: readonly NormalizedEvent[]): boolean {
  if (event.direction !== 'inbound' || !isQuoteAssetEvent(event)) return false
  const contract = event.contract.toLowerCase()
  return sameTxEvents.some(e => e.direction === 'outbound' && e.contract.toLowerCase() === contract)
}
