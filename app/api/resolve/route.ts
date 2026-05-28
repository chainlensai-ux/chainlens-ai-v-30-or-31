import { NextResponse } from 'next/server'

const INTERNAL_ALIASES: Record<string, { address: string; symbol: string; name: string }> = {
  WETH:    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH',   name: 'Wrapped Ether' },
  ETH:     { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH',   name: 'Wrapped Ether' },
  USDC:    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC',   name: 'USD Coin' },
  USDBC:   { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC',  name: 'USD Base Coin' },
  AERO:    { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO',   name: 'Aerodrome Finance' },
  BRETT:   { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT',  name: 'Brett' },
  VIRTUAL: { address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', symbol: 'VIRTUAL',name: 'Virtuals Protocol' },
  DEGEN:   { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN',  name: 'Degen' },
  TOSHI:   { address: '0xAC1bd2486aAf3B5C0B7b8f6e7DfeF5C0a05D0D89', symbol: 'TOSHI',  name: 'Toshi' },
  MORPHO:  { address: '0xBAa5BDeA6D371052a6BDeB0eD79B147C43aABF84', symbol: 'MORPHO', name: 'Morpho' },
  CBBTC:   { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC',  name: 'Coinbase Wrapped BTC' },
  CBETH:   { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH',  name: 'Coinbase Wrapped Ether' },
}

const CA_REGEX = /^0x[a-fA-F0-9]{40}$/

type MatchType = 'exact_symbol' | 'exact_name' | 'partial_symbol' | 'partial_name' | 'weak_match'
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
  matchType: MatchType
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

const CHAIN_LABEL: Record<string, string> = {
  base: 'BASE', ethereum: 'ETH', eth: 'ETH',
  solana: 'SOL', bsc: 'BSC', polygon: 'POLYGON',
  arbitrum: 'ARB', optimism: 'OP', avalanche: 'AVAX',
}

function chainBonus(chainId: string, prefer: string): number {
  const c = chainId.toLowerCase()
  const p = prefer.toLowerCase()
  if (p === 'base' && c === 'base') return 300
  if (p === 'eth' && (c === 'ethereum' || c === 'eth')) return 300
  if (c === 'ethereum' || c === 'eth') return 80
  if (c === 'base') return 80
  if (['arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche'].includes(c)) return 30
  return -100
}

function matchScore(query: string, symbol: string | null, name: string | null): { score: number; matchType: MatchType } {
  const q = query.toLowerCase()
  const s = (symbol ?? '').toLowerCase()
  const n = (name ?? '').toLowerCase()
  if (s === q) return { score: 250, matchType: 'exact_symbol' }
  if (n === q) return { score: 220, matchType: 'exact_name' }
  if (s.startsWith(q)) return { score: 140, matchType: 'partial_symbol' }
  if (n.startsWith(q)) return { score: 120, matchType: 'partial_name' }
  if (s.includes(q)) return { score: 80, matchType: 'partial_symbol' }
  if (n.includes(q)) return { score: 60, matchType: 'partial_name' }
  if (q.length >= 3 && (s.includes(q.slice(0, 3)) || n.includes(q.slice(0, 3)))) return { score: 20, matchType: 'weak_match' }
  return { score: -80, matchType: 'weak_match' }
}

function liquidityBonus(liq: number | null): number {
  if (!liq || liq <= 0) return 0
  if (liq > 1_000_000) return 140
  if (liq > 250_000) return 100
  if (liq > 50_000) return 60
  if (liq > 10_000) return 30
  return 5
}

function volumeBonus(vol: number | null): number {
  if (!vol || vol <= 0) return 0
  if (vol > 1_000_000) return 100
  if (vol > 250_000) return 70
  if (vol > 50_000) return 40
  if (vol > 10_000) return 20
  return 5
}

async function fetchDexScreener(query: string, prefer: string): Promise<ResolverCandidate[]> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) return []
    const json = await res.json() as { pairs?: unknown[] }
    const pairs = Array.isArray(json.pairs) ? json.pairs : []
    const seen = new Set<string>()
    const out: ResolverCandidate[] = []
    for (const pair of pairs.slice(0, 30)) {
      if (typeof pair !== 'object' || pair === null) continue
      const p = pair as Record<string, unknown>
      const bt = p.baseToken as Record<string, unknown> | undefined
      const addr = (bt?.address as string | undefined)?.toLowerCase()
      const chainId = ((p.chainId as string | undefined) ?? 'unknown').toLowerCase()
      if (!addr || !CA_REGEX.test(addr)) continue
      const key = `${addr}:${chainId}`
      if (seen.has(key)) continue
      seen.add(key)
      const symbol = (bt?.symbol as string | null) ?? null
      const name   = (bt?.name   as string | null) ?? null
      const liq  = (p.liquidity as Record<string, unknown> | undefined)?.usd ? Number((p.liquidity as Record<string, unknown>).usd) : null
      const vol  = (p.volume   as Record<string, unknown> | undefined)?.h24 ? Number((p.volume as Record<string, unknown>).h24) : null
      const fdv  = p.fdv ? Number(p.fdv) : null
      const { score: ms, matchType } = matchScore(query, symbol, name)
      if (ms < -50) continue
      out.push({
        contractAddress: addr,
        chainId,
        chainLabel: CHAIN_LABEL[chainId] ?? chainId.toUpperCase(),
        symbol, name, source: 'dexscreener',
        liquidityUsd: Number.isFinite(liq) ? liq : null,
        volume24hUsd: Number.isFinite(vol) ? vol : null,
        fdvUsd: Number.isFinite(fdv) ? fdv : null,
        pairAddress: (p.pairAddress as string | null) ?? null,
        confidenceScore: ms + liquidityBonus(liq) + volumeBonus(vol) + chainBonus(chainId, prefer) + 60,
        matchType,
        reason: `DexScreener: ${symbol ?? name ?? addr} on ${chainId}`,
      })
    }
    return out
  } catch { return [] }
}

async function fetchGeckoTerminal(query: string, prefer: string): Promise<ResolverCandidate[]> {
  try {
    const [r1, r2] = await Promise.allSettled([
      fetch(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}&network=base&page=1`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }),
      fetch(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}&page=1`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }),
    ])
    const allPools: unknown[] = []
    for (const r of [r1, r2]) {
      if (r.status === 'fulfilled' && r.value.ok) {
        const j = await r.value.json() as { data?: unknown[] }
        if (Array.isArray(j.data)) allPools.push(...j.data)
      }
    }
    const seen = new Set<string>()
    const out: ResolverCandidate[] = []
    for (const pool of allPools.slice(0, 40)) {
      if (typeof pool !== 'object' || pool === null) continue
      const p = pool as Record<string, unknown>
      const attrs = (p.attributes as Record<string, unknown>) ?? {}
      const relId = ((p.relationships as Record<string, unknown>)?.base_token as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined
      const rel = (relId?.id as string) ?? ''
      const parts = rel.split('_')
      const network = parts[0]?.toLowerCase() ?? 'unknown'
      const addr = parts.slice(1).join('_')?.toLowerCase()
      if (!addr || !CA_REGEX.test(addr)) continue
      const key = `${addr}:${network}`
      if (seen.has(key)) continue
      seen.add(key)
      const symbol = (attrs.base_token_symbol as string | null) ?? null
      const name   = (attrs.base_token_name   as string | null) ?? null
      const liq = attrs.reserve_in_usd ? Number(attrs.reserve_in_usd) : null
      const vol = (attrs.volume_usd as Record<string, unknown> | undefined)?.h24 ? Number((attrs.volume_usd as Record<string, unknown>).h24) : null
      const chainId = network === 'eth' ? 'ethereum' : network
      const { score: ms, matchType } = matchScore(query, symbol, name)
      if (ms < -50) continue
      out.push({
        contractAddress: addr,
        chainId,
        chainLabel: CHAIN_LABEL[chainId] ?? chainId.toUpperCase(),
        symbol, name, source: 'geckoterminal',
        liquidityUsd: Number.isFinite(liq) ? liq : null,
        volume24hUsd: Number.isFinite(vol) ? vol : null,
        fdvUsd: null,
        pairAddress: (attrs.address as string | null) ?? null,
        confidenceScore: ms + liquidityBonus(liq) + volumeBonus(vol) + chainBonus(chainId, prefer) + 70,
        matchType,
        reason: `GeckoTerminal: ${symbol ?? name ?? addr} on ${chainId}`,
      })
    }
    return out
  } catch { return [] }
}

function mergeCandidates(all: ResolverCandidate[]): ResolverCandidate[] {
  const byKey = new Map<string, ResolverCandidate>()
  for (const c of all) {
    const key = `${c.contractAddress}:${c.chainId}`
    const ex = byKey.get(key)
    if (!ex) { byKey.set(key, c); continue }
    byKey.set(key, {
      ...ex,
      liquidityUsd:  Math.max(ex.liquidityUsd ?? 0, c.liquidityUsd ?? 0) || null,
      volume24hUsd:  Math.max(ex.volume24hUsd ?? 0, c.volume24hUsd ?? 0) || null,
      fdvUsd:        ex.fdvUsd ?? c.fdvUsd,
      confidenceScore: ex.confidenceScore + (c.source !== ex.source ? 40 : 0),
      reason: ex.source !== c.source ? `${ex.source}+${c.source}` : ex.reason,
    })
  }
  return Array.from(byKey.values()).sort((a, b) => b.confidenceScore - a.confidenceScore)
}

function resolvedChain(chainId: string): string {
  const c = chainId.toLowerCase()
  if (c === 'ethereum' || c === 'eth') return 'eth'
  if (c === 'base') return 'base'
  return c
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { query?: string; chain?: string }
    const rawQuery = (body.query ?? '').trim()
    const prefer   = (body.chain  ?? 'base').toLowerCase()

    if (!rawQuery) {
      return NextResponse.json<ResolverResult>({ status: 'not_found', contractAddress: null, chain: null, bestCandidate: null, alternates: [], confidence: 'low', reason: 'Empty query.' })
    }

    const normalized = rawQuery.replace(/^\$/, '').trim()
    const upper = normalized.toUpperCase()

    // 1. Direct CA — resolve immediately
    if (CA_REGEX.test(rawQuery)) {
      return NextResponse.json<ResolverResult>({ status: 'resolved', contractAddress: rawQuery.toLowerCase(), chain: prefer, bestCandidate: null, alternates: [], confidence: 'high', reason: 'Contract address provided directly.' })
    }

    // 2. Internal alias map — instant, no network call
    const alias = INTERNAL_ALIASES[upper]
    if (alias) {
      const c: ResolverCandidate = { contractAddress: alias.address.toLowerCase(), chainId: 'base', chainLabel: 'BASE', symbol: alias.symbol, name: alias.name, source: 'internal', liquidityUsd: null, volume24hUsd: null, fdvUsd: null, pairAddress: null, confidenceScore: 999, matchType: 'exact_symbol', reason: 'Internal registry match.' }
      return NextResponse.json<ResolverResult>({ status: 'resolved', contractAddress: alias.address.toLowerCase(), chain: 'base', bestCandidate: c, alternates: [], confidence: 'high', reason: `Matched ${alias.symbol} from internal token registry.` })
    }

    // 3. Live search — DexScreener + GeckoTerminal in parallel
    const [ds, gt] = await Promise.allSettled([
      fetchDexScreener(normalized, prefer),
      fetchGeckoTerminal(normalized, prefer),
    ])

    const all: ResolverCandidate[] = [
      ...(ds.status === 'fulfilled' ? ds.value : []),
      ...(gt.status === 'fulfilled' ? gt.value : []),
    ]

    if (all.length === 0) {
      return NextResponse.json<ResolverResult>({ status: 'not_found', contractAddress: null, chain: null, bestCandidate: null, alternates: [], confidence: 'low', reason: 'No matching token found. Try pasting the contract address.' })
    }

    // Apply no-liquidity penalty after merging
    const merged = mergeCandidates(all)
    for (const c of merged) {
      if (!c.liquidityUsd && !c.volume24hUsd) c.confidenceScore -= 40
    }
    merged.sort((a, b) => b.confidenceScore - a.confidenceScore)

    const best = merged[0]
    const second = merged[1]
    const alternates = merged.slice(1, 6)

    const scoreDiff = best.confidenceScore - (second?.confidenceScore ?? 0)
    const isAmbiguous = !!second && scoreDiff < 50 && best.matchType !== 'exact_symbol' && best.matchType !== 'exact_name'

    let confidence: 'high' | 'medium' | 'low' = 'low'
    if (best.matchType === 'exact_symbol' || best.matchType === 'exact_name') {
      confidence = (best.liquidityUsd ?? 0) > 50_000 ? 'high' : 'medium'
    } else if (best.matchType === 'partial_symbol' || best.matchType === 'partial_name') {
      confidence = (best.liquidityUsd ?? 0) > 250_000 ? 'medium' : 'low'
    }

    const displayName = best.symbol ?? best.name ?? normalized.toUpperCase()
    return NextResponse.json<ResolverResult>({
      status: isAmbiguous ? 'ambiguous' : 'resolved',
      contractAddress: best.contractAddress,
      chain: resolvedChain(best.chainId),
      bestCandidate: best,
      alternates,
      confidence,
      reason: isAmbiguous
        ? `Multiple ${normalized.toUpperCase()} tokens found. Using the highest-liquidity match.`
        : `Resolved ${displayName} on ${best.chainLabel}.`,
    })

  } catch (err) {
    console.error('[resolve]', err)
    return NextResponse.json<ResolverResult>({ status: 'not_found', contractAddress: null, chain: null, bestCandidate: null, alternates: [], confidence: 'low', reason: 'Resolver error.' }, { status: 500 })
  }
}
