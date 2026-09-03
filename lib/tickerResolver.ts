import { type TickerChainSlug, type TickerMatch, type TickerResolverResult } from '@/lib/tickerResolverCore'

export type ResolverCandidate = TickerMatch
export type ResolverResult = TickerResolverResult
export function isContractAddress(query: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(query.trim())
}

export async function resolveTokenQuery(query: string, chain: TickerChainSlug | null): Promise<ResolverResult> {
  const response = await fetch('/api/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, chain }),
  })
  if (!response.ok) throw new Error(`Resolver HTTP ${response.status}`)
  return response.json() as Promise<ResolverResult>
}

export function fmtLiquidity(usd: number | null): string {
  if (!usd || usd <= 0) return '—'
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`
  return `$${Math.round(usd)}`
}

export function fmtResolverUsd(usd: number | null): string {
  if (usd == null) return 'Unavailable'
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`
  return `$${usd.toFixed(2)}`
}
