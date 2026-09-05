import { isEvmAddress, isValidSolanaMintAddress } from '@/lib/solanaAddress'

export type TickerChainSlug = 'base' | 'eth' | 'bnb' | 'robinhood' | 'solana'
export type TickerResolverSource = 'chainlens_cache' | 'dexscreener' | 'geckoterminal' | 'coingecko' | 'chain_fallback'

export type TickerMatch = {
  name: string | null
  symbol: string | null
  chainId: number
  chainSlug: TickerChainSlug
  tokenAddress: string
  pairAddress: string | null
  dex: string | null
  priceUsd: number | null
  marketCapUsd: number | null
  fdvUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  priceChange24hPct: number | null
  confidence: number
  reason: string
  source: TickerResolverSource
  matchType: 'exact_symbol' | 'exact_name' | 'partial_symbol' | 'partial_name'
}

export type TickerResolverAudit = {
  query: string
  source: TickerResolverSource | null
  selectedChain: TickerChainSlug | null
  providersTried: TickerResolverSource[]
  matchesFound: number
  topMatch: { chainSlug: TickerChainSlug; tokenAddress: string; symbol: string | null } | null
  selectedMatch: { chainSlug: TickerChainSlug; tokenAddress: string; symbol: string | null } | null
  confidence: number
  needsUserChoice: boolean
  finalAction: 'direct_scan' | 'auto_scan' | 'show_picker' | 'not_found'
  failureReason: string | null
}

export type TickerResolverResult = {
  query: string
  normalizedQuery: string
  matches: TickerMatch[]
  selectedMatch: TickerMatch | null
  needsUserChoice: boolean
  failureReason: string | null
  tickerResolverAudit: TickerResolverAudit
  // Compatibility fields consumed by the existing scanner and Clark routes.
  status: 'resolved' | 'ambiguous' | 'not_found'
  contractAddress: string | null
  chain: TickerChainSlug | null
  bestCandidate: TickerMatch | null
  alternates: TickerMatch[]
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export const TICKER_CHAIN_IDS: Record<TickerChainSlug, number> = {
  base: 8453,
  eth: 1,
  bnb: 56,
  robinhood: 4663,
  solana: 101,
}

export function normalizeTickerChain(value: unknown): TickerChainSlug | null {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === 'base' || v === 'base-mainnet' || v === '8453') return 'base'
  if (v === 'eth' || v === 'ethereum' || v === 'eth-mainnet' || v === '1') return 'eth'
  if (v === 'bnb' || v === 'bsc' || v === 'binance-smart-chain' || v === '56') return 'bnb'
  if (v === 'robinhood' || v === 'robinhood-chain' || v === '4663') return 'robinhood'
  if (v === 'solana' || v === 'sol' || v === '101') return 'solana'
  return null
}

export function normalizeTickerAddress(address: string, chain: TickerChainSlug): string {
  return chain === 'solana' ? address.trim() : address.trim().toLowerCase()
}

export function isDirectTokenAddress(value: string): boolean {
  const q = value.trim()
  return isEvmAddress(q) || isValidSolanaMintAddress(q)
}

function finite(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function rankTickerMatches(query: string, matches: TickerMatch[], selectedChain: TickerChainSlug | null): TickerMatch[] {
  const q = query.trim().replace(/^\$/, '').toUpperCase()
  const deduped = new Map<string, TickerMatch>()
  for (const row of matches) {
    if (!row.tokenAddress || (!isEvmAddress(row.tokenAddress) && !isValidSolanaMintAddress(row.tokenAddress))) continue
    if (selectedChain && row.chainSlug !== selectedChain) continue
    const symbol = row.symbol?.trim().toUpperCase() ?? ''
    const name = row.name?.trim().toUpperCase() ?? ''
    let matchPoints = -40
    let matchType: TickerMatch['matchType'] = 'partial_name'
    if (symbol === q || (q === 'ETH' && symbol === 'WETH') || (q === 'BTC' && ['WBTC', 'CBBTC'].includes(symbol))) { matchPoints = 45; matchType = 'exact_symbol' }
    else if (name === q) { matchPoints = 38; matchType = 'exact_name' }
    else if (symbol.startsWith(q)) { matchPoints = 20; matchType = 'partial_symbol' }
    else if (name.startsWith(q) || name.includes(q)) { matchPoints = 12; matchType = 'partial_name' }
    else continue

    const liquidity = finite(row.liquidityUsd)
    const volume = finite(row.volume24hUsd)
    const quality = Math.min(22, Math.log10(Math.max(1, liquidity)) * 3)
      + Math.min(14, Math.log10(Math.max(1, volume)) * 2)
      + (finite(row.marketCapUsd) > 0 ? 5 : 0)
      + (row.source === 'chainlens_cache' || row.source === 'chain_fallback' ? 40 : 0)
    const confidence = Math.max(0, Math.min(100, Math.round(matchPoints + quality + (selectedChain ? 8 : 0))))
    const ranked = { ...row, matchType, confidence }
    const key = `${row.chainSlug}:${normalizeTickerAddress(row.tokenAddress, row.chainSlug)}`
    const prior = deduped.get(key)
    if (!prior || ranked.confidence > prior.confidence) deduped.set(key, ranked)
    else if (prior) {
      deduped.set(key, {
        ...prior,
        liquidityUsd: Math.max(finite(prior.liquidityUsd), finite(ranked.liquidityUsd)) || null,
        volume24hUsd: Math.max(finite(prior.volume24hUsd), finite(ranked.volume24hUsd)) || null,
        marketCapUsd: prior.marketCapUsd ?? ranked.marketCapUsd,
        fdvUsd: prior.fdvUsd ?? ranked.fdvUsd,
        priceUsd: prior.priceUsd ?? ranked.priceUsd,
      })
    }
  }
  return [...deduped.values()].sort((a, b) => b.confidence - a.confidence || finite(b.liquidityUsd) - finite(a.liquidityUsd) || finite(b.volume24hUsd) - finite(a.volume24hUsd))
}

export function finalizeTickerResolution(input: {
  query: string
  selectedChain: TickerChainSlug | null
  matches: TickerMatch[]
  providersTried: TickerResolverSource[]
  directAddressChain?: TickerChainSlug | null
}): TickerResolverResult {
  const query = input.query.trim()
  const normalizedQuery = query.replace(/^\$/, '').trim().toUpperCase()
  const directChain = input.directAddressChain ?? null
  const ranked = directChain ? input.matches : rankTickerMatches(normalizedQuery, input.matches, input.selectedChain)
  const top = ranked[0] ?? null
  const second = ranked[1] ?? null
  const multipleStrong = Boolean(top && second && second.confidence >= 55 && (top.confidence - second.confidence < 14 || (top.matchType === 'exact_symbol' && second.matchType === 'exact_symbol')))
  const lowConfidence = Boolean(top && top.confidence < 62)
  const needsUserChoice = !directChain && Boolean(top) && (multipleStrong || lowConfidence)
  const selectedMatch = top && !needsUserChoice ? top : null
  const failureReason = top ? null : 'No supported provider returned a confident token identity. Try a contract address.'
  const finalAction = directChain ? 'direct_scan' : selectedMatch ? 'auto_scan' : top ? 'show_picker' : 'not_found'
  const status: TickerResolverResult['status'] = !top ? 'not_found' : needsUserChoice ? 'ambiguous' : 'resolved'
  const confidenceLabel = !top || top.confidence < 55 ? 'low' : top.confidence >= 78 ? 'high' : 'medium'
  const reason = !top ? failureReason! : needsUserChoice
    ? `Multiple tokens found for ${normalizedQuery}. Choose one to scan.`
    : `Resolved ${top.symbol ?? top.name ?? normalizedQuery} on ${top.chainSlug}.`
  return {
    query,
    normalizedQuery,
    matches: ranked.slice(0, 8),
    selectedMatch,
    needsUserChoice,
    failureReason,
    status,
    contractAddress: selectedMatch?.tokenAddress ?? null,
    chain: selectedMatch?.chainSlug ?? null,
    bestCandidate: top,
    alternates: ranked.slice(1, 8),
    confidence: confidenceLabel,
    reason,
    tickerResolverAudit: {
      query,
      source: top?.source ?? null,
      selectedChain: input.selectedChain,
      providersTried: input.providersTried,
      matchesFound: ranked.length,
      topMatch: top ? { chainSlug: top.chainSlug, tokenAddress: top.tokenAddress, symbol: top.symbol } : null,
      selectedMatch: selectedMatch ? { chainSlug: selectedMatch.chainSlug, tokenAddress: selectedMatch.tokenAddress, symbol: selectedMatch.symbol } : null,
      confidence: top?.confidence ?? 0,
      needsUserChoice,
      finalAction,
      failureReason,
    },
  }
}
