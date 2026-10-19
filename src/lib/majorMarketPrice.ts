// Major-asset market prices: when a market-history price can stand in for an execution price.
//
// ETH/WETH, cbBTC and verified stablecoins trade in markets deep enough that their market price
// within an hour of a trade is the trade's price to within a few percent. For these assets only, a
// historical market price that close to the trade is accepted as verified evidence; anything farther
// away, or any other token, stays partial. A side that also carries its own same-transaction quote
// keeps that quote (market prices only fill empty sides), and the 1.5x major-asset band of the lot
// price outlier guard still rejects any market price that disagrees with the token's other trades.

import type { SupportedChain } from '../modules/providerFetchWindow/types'
import { isCanonicalWethAddress, isNativePseudoAddress, isVerifiedStablecoinAddress } from '../modules/quoteLegPricing'

export const CBBTC_ADDRESS = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'
export const MAJOR_MARKET_PRICE_MAX_DISTANCE_MS = 60 * 60 * 1000

/** ETH/WETH or cbBTC — majors whose price cannot move 1.5x inside a scan window. */
export function isMajorVolatileToken(chain: string, token: string): boolean {
  const t = token.toLowerCase()
  return t === CBBTC_ADDRESS || isNativePseudoAddress(t) || isCanonicalWethAddress(chain as SupportedChain, t)
}

export function isMajorMarketToken(chain: string, token: string): boolean {
  return isMajorVolatileToken(chain, token) || isVerifiedStablecoinAddress(chain as SupportedChain, token.toLowerCase())
}

/** Whether a market-history price `distanceMs` away from the trade counts as verified for `token`. */
export function acceptsMajorMarketPrice(chain: string, token: string, distanceMs: number | null | undefined): boolean {
  return typeof distanceMs === 'number' && Number.isFinite(distanceMs) && distanceMs >= 0
    && distanceMs <= MAJOR_MARKET_PRICE_MAX_DISTANCE_MS && isMajorMarketToken(chain, token)
}
