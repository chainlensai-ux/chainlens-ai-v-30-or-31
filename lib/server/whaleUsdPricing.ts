export type WhaleUsdFailureReason =
  | 'price missing'
  | 'decimals missing'
  | 'amount missing'
  | 'unsupported token'
  | 'provider failed'

export type WhaleUsdFinalStatus = 'verified' | 'estimated' | 'zero' | 'unavailable'

export type WhaleUsdPricingAudit = {
  alertId: string
  walletAddress: string | null
  movementId: string
  chainId: number
  tokenAddress: string | null
  symbol: string | null
  amount: number | null
  rawAmount: string | null
  decimals: number | null
  normalizedAmount: number | null
  decimalsResolved: boolean
  priceSourceTried: string[]
  priceSourceUsed: string | null
  priceSource: string | null
  priceUsd: number | null
  estimatedUsdValue: number | null
  historicalPriceAttempted: boolean
  currentPriceAttempted: boolean
  stablecoinShortcutUsed: boolean
  valueUsd: number | null
  finalValueStatus: WhaleUsdFinalStatus
  finalUsdStatus: WhaleUsdFinalStatus
  failureReason: WhaleUsdFailureReason | null
}

export type WhalePriceQuote = {
  priceUsd: number | null
  sourceUsed: string | null
  sourcesTried: string[]
  providerFailed?: boolean
}

const BASE_STABLECOIN_ADDRESSES = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
  '0xa0629aeb28bc956d03bac1fadc9afc30fada9274', // USDG
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
])
const BASE_STABLECOIN_SYMBOLS = new Set(['USDC', 'USDBC', 'USDT', 'USDG', 'DAI', 'USDS', 'USDE', 'USDP', 'PYUSD', 'FRAX', 'LUSD'])

/**
 * A contract address is authoritative. Symbol matching is only a fallback when
 * the feed has no contract address, so a spoofed symbol cannot claim a $1 price.
 */
export function getBaseStablecoinShortcut(input: { tokenAddress?: unknown; symbol?: unknown }): WhalePriceQuote | null {
  const address = typeof input.tokenAddress === 'string' ? input.tokenAddress.toLowerCase() : null
  const symbol = typeof input.symbol === 'string' ? input.symbol.toUpperCase().trim() : ''
  if (address && BASE_STABLECOIN_ADDRESSES.has(address)) {
    return { priceUsd: 1, sourceUsed: 'stablecoin_address_shortcut', sourcesTried: ['stablecoin_address_shortcut'] }
  }
  if (!address && BASE_STABLECOIN_SYMBOLS.has(symbol)) {
    return { priceUsd: 1, sourceUsed: 'stablecoin_symbol_shortcut', sourcesTried: ['stablecoin_symbol_shortcut'] }
  }
  return null
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
  wallet_address?: unknown
  occurred_at?: unknown
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
    alertId: movementId,
    walletAddress: typeof row.wallet_address === 'string' ? row.wallet_address : null,
    movementId,
    chainId,
    tokenAddress,
    symbol,
    amount,
    rawAmount,
    decimals,
    normalizedAmount: amount,
    decimalsResolved,
  }
  const receipt = (params: {
    priceSourceTried: string[]; priceSourceUsed: string | null; priceUsd: number | null
    valueUsd: number | null; status: WhaleUsdFinalStatus; failureReason: WhaleUsdFailureReason | null
  }): WhaleUsdPricingAudit => ({
    ...base,
    priceSourceTried: params.priceSourceTried,
    priceSourceUsed: params.priceSourceUsed,
    priceSource: params.priceSourceUsed,
    priceUsd: params.priceUsd,
    estimatedUsdValue: params.valueUsd,
    historicalPriceAttempted: params.priceSourceTried.some(source => source.includes('historical') || source === 'token_price_at_tx'),
    currentPriceAttempted: params.priceSourceTried.some(source => source.includes('current')),
    stablecoinShortcutUsed: params.priceSourceUsed === 'stablecoin_address_shortcut' || params.priceSourceUsed === 'stablecoin_symbol_shortcut',
    valueUsd: params.valueUsd,
    finalUsdStatus: params.status,
    finalValueStatus: params.status,
    failureReason: params.failureReason,
  })

  if (storedUsd != null && storedUsd > 0) {
    return { amountUsd: storedUsd, audit: receipt({ priceSourceTried: ['stored_tx_usd'], priceSourceUsed: 'stored_tx_usd', priceUsd: null, valueUsd: storedUsd, status: 'verified', failureReason: null }) }
  }
  if (storedUsd === 0 && amount === 0) {
    return { amountUsd: 0, audit: receipt({ priceSourceTried: ['stored_tx_usd'], priceSourceUsed: 'stored_tx_usd', priceUsd: null, valueUsd: 0, status: 'zero', failureReason: null }) }
  }
  if (amount == null) {
    const failureReason: WhaleUsdFailureReason = rawAmount != null && decimals == null ? 'decimals missing' : 'amount missing'
    return { amountUsd: null, audit: receipt({ priceSourceTried: [], priceSourceUsed: null, priceUsd: null, valueUsd: null, status: 'unavailable', failureReason }) }
  }
  if (amount === 0) {
    return { amountUsd: 0, audit: receipt({ priceSourceTried: [], priceSourceUsed: 'token_amount', priceUsd: null, valueUsd: 0, status: 'zero', failureReason: null }) }
  }
  if (txPrice != null && txPrice > 0) {
    const value = Math.round(amount * txPrice * 100) / 100
    return { amountUsd: value, audit: receipt({ priceSourceTried: ['token_price_at_tx'], priceSourceUsed: 'token_price_at_tx', priceUsd: txPrice, valueUsd: value, status: 'estimated', failureReason: null }) }
  }
  if (quote?.priceUsd != null && quote.priceUsd > 0) {
    const value = Math.round(amount * quote.priceUsd * 100) / 100
    return { amountUsd: value, audit: receipt({ priceSourceTried: ['token_price_at_tx', ...quote.sourcesTried], priceSourceUsed: quote.sourceUsed, priceUsd: quote.priceUsd, valueUsd: value, status: 'estimated', failureReason: null }) }
  }

  const failureReason: WhaleUsdFailureReason = !tokenAddress
    ? 'unsupported token'
    : quote?.providerFailed
      ? 'provider failed'
      : 'price missing'
  return {
    amountUsd: null,
    audit: receipt({ priceSourceTried: ['token_price_at_tx', ...(quote?.sourcesTried ?? [])], priceSourceUsed: null, priceUsd: null, valueUsd: null, status: 'unavailable', failureReason }),
  }
}

export function whaleUsdUnavailableCopy(audit: WhaleUsdPricingAudit | null | undefined): string {
  return `USD unavailable: ${audit?.failureReason ?? 'price missing'}`
}
