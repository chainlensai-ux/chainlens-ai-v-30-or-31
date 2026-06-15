export type TokenWatchlistScanLike = {
  contract?: string | null
  symbol?: string | null
  name?: string | null
  riskLabel?: string | null
  riskScore?: number | null
  cortexScore?: number | null
}

export type TokenWatchlistBody = {
  chain: string
  tokenAddress: string
  tokenSymbol?: string
  tokenName?: string
  riskLabel?: string
  score?: number
}

export function buildTokenWatchlistBody(scan: TokenWatchlistScanLike, chain: string): TokenWatchlistBody | null {
  const tokenAddress = typeof scan.contract === 'string' ? scan.contract.trim() : ''
  const chainKey = typeof chain === 'string' ? chain.trim() : ''
  if (!tokenAddress || !chainKey) return null

  const score = typeof scan.riskScore === 'number' && Number.isFinite(scan.riskScore)
    ? scan.riskScore
    : typeof scan.cortexScore === 'number' && Number.isFinite(scan.cortexScore)
      ? scan.cortexScore
      : undefined

  return {
    chain: chainKey,
    tokenAddress,
    ...(scan.symbol ? { tokenSymbol: scan.symbol } : {}),
    ...(scan.name ? { tokenName: scan.name } : {}),
    ...(scan.riskLabel ? { riskLabel: scan.riskLabel } : {}),
    ...(score !== undefined ? { score } : {}),
  }
}
