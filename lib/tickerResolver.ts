export type ResolverCandidate = {
  contractAddress: string
  chainId: string
  chainLabel: string
  symbol: string | null
  name: string | null
  source: 'internal' | 'dexscreener' | 'geckoterminal'
  liquidityUsd: number | null
  volume24hUsd: number | null
  fdvUsd: number | null
  pairAddress: string | null
  confidenceScore: number
  matchType: 'exact_symbol' | 'exact_name' | 'partial_symbol' | 'partial_name' | 'weak_match'
  reason: string
}

export type ResolverResult = {
  status: 'resolved' | 'ambiguous' | 'not_found'
  contractAddress: string | null
  chain: string | null
  bestCandidate: ResolverCandidate | null
  alternates: ResolverCandidate[]
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export const CA_REGEX = /^0x[a-fA-F0-9]{40}$/

export function isContractAddress(q: string): boolean {
  return CA_REGEX.test(q.trim())
}

export async function resolveTokenQuery(query: string, chain: 'base' | 'eth' = 'base'): Promise<ResolverResult> {
  const res = await fetch('/api/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, chain }),
  })
  if (!res.ok) throw new Error(`Resolver HTTP ${res.status}`)
  return res.json() as Promise<ResolverResult>
}

export function fmtLiquidity(usd: number | null): string {
  if (!usd || usd <= 0) return '—'
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`
  return `$${Math.round(usd)}`
}
