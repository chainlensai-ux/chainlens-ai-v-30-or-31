export type WhaleUsdFailureReason =
  | 'price unavailable'
  | 'token decimals missing'
  | 'amount missing'
  | 'unsupported token'
  | 'provider failed'

export type WhaleUsdFinalStatus = 'verified' | 'estimated' | 'zero' | 'unavailable'

export type WhaleUsdPricingAudit = {
  movementId: string
  chainId: number
  tokenAddress: string | null
  symbol: string | null
  amount: number | null
  decimalsResolved: boolean
  priceSourceTried: string[]
  priceSourceUsed: string | null
  priceUsd: number | null
  estimatedUsdValue: number | null
  finalUsdStatus: WhaleUsdFinalStatus
  failureReason: WhaleUsdFailureReason | null
}

export type WhalePriceQuote = {
  priceUsd: number | null
  sourceUsed: string | null
  sourcesTried: string[]
  providerFailed?: boolean
}

type WhaleMovementPricingInput = {
  id?: unknown
  tx_hash?: unknown
  chain_id?: unknown
  token_address?: unknown
  token_symbol?: unknown
  amount_token?: unknown
  amount_raw?: unknown
  token_decimals?: unknown
  decimals?: unknown
  amount_usd?: unknown
  price_usd_at_tx?: unknown
  token_price_usd_at_tx?: unknown
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function priceWhaleMovement(
  row: WhaleMovementPricingInput,
  quote: WhalePriceQuote | null,
): { amountUsd: number | null; audit: WhaleUsdPricingAudit } {
  const storedUsd = finiteNumber(row.amount_usd)
  const amount = finiteNumber(row.amount_token)
  const rawAmount = row.amount_raw == null ? null : String(row.amount_raw)
  const decimals = finiteNumber(row.token_decimals) ?? finiteNumber(row.decimals)
  const txPrice = finiteNumber(row.price_usd_at_tx) ?? finiteNumber(row.token_price_usd_at_tx)
  const tokenAddress = typeof row.token_address === 'string' && row.token_address.trim() ? row.token_address : null
  const symbol = typeof row.token_symbol === 'string' && row.token_symbol.trim() ? row.token_symbol : null
  const movementId = String(row.id ?? row.tx_hash ?? `${tokenAddress ?? symbol ?? 'unknown'}:${amount ?? 'missing'}`)
  const chainId = finiteNumber(row.chain_id) ?? 8453
  const decimalsResolved = amount != null || (rawAmount != null && decimals != null)
  const base = {
    movementId,
    chainId,
    tokenAddress,
    symbol,
    amount,
    decimalsResolved,
  }

  if (storedUsd != null && storedUsd > 0) {
    return { amountUsd: storedUsd, audit: { ...base, priceSourceTried: ['stored_tx_usd'], priceSourceUsed: 'stored_tx_usd', priceUsd: null, estimatedUsdValue: storedUsd, finalUsdStatus: 'verified', failureReason: null } }
  }
  if (storedUsd === 0 && amount === 0) {
    return { amountUsd: 0, audit: { ...base, priceSourceTried: ['stored_tx_usd'], priceSourceUsed: 'stored_tx_usd', priceUsd: null, estimatedUsdValue: 0, finalUsdStatus: 'zero', failureReason: null } }
  }
  if (amount == null) {
    const failureReason: WhaleUsdFailureReason = rawAmount != null && decimals == null ? 'token decimals missing' : 'amount missing'
    return { amountUsd: null, audit: { ...base, priceSourceTried: [], priceSourceUsed: null, priceUsd: null, estimatedUsdValue: null, finalUsdStatus: 'unavailable', failureReason } }
  }
  if (amount === 0) {
    return { amountUsd: 0, audit: { ...base, priceSourceTried: [], priceSourceUsed: 'token_amount', priceUsd: null, estimatedUsdValue: 0, finalUsdStatus: 'zero', failureReason: null } }
  }
  if (txPrice != null && txPrice > 0) {
    const value = Math.round(amount * txPrice * 100) / 100
    return { amountUsd: value, audit: { ...base, priceSourceTried: ['token_price_at_tx'], priceSourceUsed: 'token_price_at_tx', priceUsd: txPrice, estimatedUsdValue: value, finalUsdStatus: 'estimated', failureReason: null } }
  }
  if (quote?.priceUsd != null && quote.priceUsd > 0) {
    const value = Math.round(amount * quote.priceUsd * 100) / 100
    return { amountUsd: value, audit: { ...base, priceSourceTried: ['token_price_at_tx', ...quote.sourcesTried], priceSourceUsed: quote.sourceUsed, priceUsd: quote.priceUsd, estimatedUsdValue: value, finalUsdStatus: 'estimated', failureReason: null } }
  }

  const failureReason: WhaleUsdFailureReason = !tokenAddress
    ? 'unsupported token'
    : quote?.providerFailed
      ? 'provider failed'
      : 'price unavailable'
  return {
    amountUsd: null,
    audit: {
      ...base,
      priceSourceTried: ['token_price_at_tx', ...(quote?.sourcesTried ?? [])],
      priceSourceUsed: null,
      priceUsd: null,
      estimatedUsdValue: null,
      finalUsdStatus: 'unavailable',
      failureReason,
    },
  }
}

export function whaleUsdUnavailableCopy(audit: WhaleUsdPricingAudit | null | undefined): string {
  return `USD unavailable: ${audit?.failureReason ?? 'price unavailable'}`
}
