import type { PricingRequest } from './types'

const SPAM_LIKE_SYMBOL_PATTERN = /(claim|airdrop|reward|bonus|visit|http|www\.|\.(com|io|xyz|net|org)\b|free\s|\$\$\$)/i
const IMPLAUSIBLE_SPAM_QUANTITY = 1_000_000_000

export function shouldSkipCurrentPriceFallback(request: Pick<PricingRequest, 'symbol' | 'amount'>): boolean {
  const symbol = request.symbol
  if (typeof symbol === 'string' && SPAM_LIKE_SYMBOL_PATTERN.test(symbol)) return true
  if (typeof request.amount === 'number' && Number.isFinite(request.amount) && request.amount >= IMPLAUSIBLE_SPAM_QUANTITY) return true
  return false
}
