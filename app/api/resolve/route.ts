import { NextResponse } from 'next/server'
import { isEvmAddress, isValidSolanaMintAddress } from '@/lib/solanaAddress'

// DISCLOSED: base58 Solana mint addresses are case-sensitive — unlike EVM hex addresses, which are
// safe to lowercase for comparison, lowercasing a Solana address changes it into a different,
// invalid address. Only normalize case for the EVM shape.
function normalizeCandidateAddress(addr: string): string {
  return isEvmAddress(addr) ? addr.toLowerCase() : addr
}
function isResolvableContractAddress(addr: string): boolean {
  return isEvmAddress(addr) || isValidSolanaMintAddress(addr)
}

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
// SPEC RESULT SHAPE, DISCLOSED (ticker search task): query/normalizedQuery/matches/selectedMatch/
// needsUserChoice/failureReason are additive — every existing consumer (lib/tickerResolver.ts,
// the Token Scanner page, Clark's resolveTokenSymbolToAddress) keeps reading status/contractAddress/
// bestCandidate/alternates exactly as before. matches mirrors bestCandidate+alternates in the
// requested per-match shape so a caller that wants it doesn't have to re-derive it.
export type ResolverMatch = {
  name: string | null
  symbol: string | null
  chainId: string
  chainSlug: string
  tokenAddress: string
  pairAddress: string | null
  dex: string
  priceUsd: number | null
  marketCapUsd: number | null
  fdvUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  priceChange24hPct: number | null
  confidence: 'high' | 'medium' | 'low'
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
  query: string
  normalizedQuery: string
  matches: ResolverMatch[]
  selectedMatch: ResolverMatch | null
  needsUserChoice: boolean
  failureReason: string | null
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
  if (p === 'solana' && c === 'solana') return 300
  if (p === 'bsc' && c === 'bsc') return 300
  if (c === 'ethereum' || c === 'eth') return 80
  if (c === 'base') return 80
  if (c === 'solana') return 80
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
      const rawAddr = bt?.address as string | undefined
      const chainId = ((p.chainId as string | undefined) ?? 'unknown').toLowerCase()
      if (!rawAddr || !isResolvableContractAddress(rawAddr)) continue
      const addr = normalizeCandidateAddress(rawAddr)
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

// CHAIN-AWARE FIX, DISCLOSED (ticker search task): the network-scoped GeckoTerminal call used to
// hardcode network=base regardless of which chain the user actually had selected — "/token PEPE"
// with BNB or Solana selected still ran its chain-specific search against Base. Now maps the
// caller's preferred chain to GeckoTerminal's own network slug (falls back to the global,
// non-network-scoped search alone when the chain has no GeckoTerminal network, e.g. robinhood).
const GECKOTERMINAL_NETWORK: Record<string, string> = {
  base: 'base', eth: 'eth', ethereum: 'eth', bnb: 'bsc', bsc: 'bsc', solana: 'solana',
}

async function fetchGeckoTerminal(query: string, prefer: string): Promise<ResolverCandidate[]> {
  try {
    const network = GECKOTERMINAL_NETWORK[prefer.toLowerCase()]
    const calls = [fetch(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}&page=1`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) })]
    if (network) {
      calls.push(fetch(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}&network=${network}&page=1`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }))
    }
    const results = await Promise.allSettled(calls)
    const allPools: unknown[] = []
    for (const r of results) {
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
      const rawAddr = parts.slice(1).join('_')
      if (!rawAddr || !isResolvableContractAddress(rawAddr)) continue
      const addr = normalizeCandidateAddress(rawAddr)
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

function toMatch(c: ResolverCandidate, confidence: 'high' | 'medium' | 'low'): ResolverMatch {
  return {
    name: c.name, symbol: c.symbol, chainId: c.chainId, chainSlug: resolvedChain(c.chainId),
    tokenAddress: c.contractAddress, pairAddress: c.pairAddress, dex: c.source,
    priceUsd: null, marketCapUsd: null, fdvUsd: c.fdvUsd, liquidityUsd: c.liquidityUsd,
    volume24hUsd: c.volume24hUsd, priceChange24hPct: null, confidence, reason: c.reason,
  }
}

// TICKER RESOLVER AUDIT, DISCLOSED (ticker search task): one structured record per resolve
// attempt, logged server-side only — mirrors this codebase's existing audit-object convention
// (paypalPaymentAudit, checkoutFlowAudit, robinhoodTokenEvidenceAudit).
type TickerResolverAudit = {
  query: string
  source: 'ca' | 'solana_mint' | 'internal_alias' | 'live_search'
  selectedChain: string
  providersTried: string[]
  matchesFound: number
  topMatch: string | null
  confidence: 'high' | 'medium' | 'low'
  needsUserChoice: boolean
  finalAction: 'resolved' | 'ambiguous' | 'not_found'
  failureReason: string | null
}
function logTickerResolverAudit(audit: TickerResolverAudit): void {
  console.log('tickerResolverAudit', JSON.stringify(audit))
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { query?: string; chain?: string }
    const rawQuery = (body.query ?? '').trim()
    const prefer   = (body.chain  ?? 'base').toLowerCase()

    if (!rawQuery) {
      return NextResponse.json<ResolverResult>({ status: 'not_found', contractAddress: null, chain: null, bestCandidate: null, alternates: [], confidence: 'low', reason: 'Empty query.', query: rawQuery, normalizedQuery: '', matches: [], selectedMatch: null, needsUserChoice: false, failureReason: 'empty_query' })
    }

    const normalized = rawQuery.replace(/^\$/, '').trim()
    const upper = normalized.toUpperCase()

    // 1. Direct CA — resolve immediately (EVM lowercased for comparison; Solana mints are
    // case-sensitive base58 and must be returned exactly as given).
    if (CA_REGEX.test(rawQuery)) {
      logTickerResolverAudit({ query: rawQuery, source: 'ca', selectedChain: prefer, providersTried: [], matchesFound: 1, topMatch: rawQuery.toLowerCase(), confidence: 'high', needsUserChoice: false, finalAction: 'resolved', failureReason: null })
      return NextResponse.json<ResolverResult>({ status: 'resolved', contractAddress: rawQuery.toLowerCase(), chain: prefer, bestCandidate: null, alternates: [], confidence: 'high', reason: 'Contract address provided directly.', query: rawQuery, normalizedQuery: normalized, matches: [], selectedMatch: null, needsUserChoice: false, failureReason: null })
    }
    if (isValidSolanaMintAddress(rawQuery)) {
      logTickerResolverAudit({ query: rawQuery, source: 'solana_mint', selectedChain: 'solana', providersTried: [], matchesFound: 1, topMatch: rawQuery, confidence: 'high', needsUserChoice: false, finalAction: 'resolved', failureReason: null })
      return NextResponse.json<ResolverResult>({ status: 'resolved', contractAddress: rawQuery, chain: 'solana', bestCandidate: null, alternates: [], confidence: 'high', reason: 'Contract address provided directly.', query: rawQuery, normalizedQuery: normalized, matches: [], selectedMatch: null, needsUserChoice: false, failureReason: null })
    }

    // 2. Internal alias map — instant, no network call
    const alias = INTERNAL_ALIASES[upper]
    if (alias) {
      const c: ResolverCandidate = { contractAddress: alias.address.toLowerCase(), chainId: 'base', chainLabel: 'BASE', symbol: alias.symbol, name: alias.name, source: 'internal', liquidityUsd: null, volume24hUsd: null, fdvUsd: null, pairAddress: null, confidenceScore: 999, matchType: 'exact_symbol', reason: 'Internal registry match.' }
      const m = toMatch(c, 'high')
      logTickerResolverAudit({ query: rawQuery, source: 'internal_alias', selectedChain: prefer, providersTried: [], matchesFound: 1, topMatch: alias.symbol, confidence: 'high', needsUserChoice: false, finalAction: 'resolved', failureReason: null })
      return NextResponse.json<ResolverResult>({ status: 'resolved', contractAddress: alias.address.toLowerCase(), chain: 'base', bestCandidate: c, alternates: [], confidence: 'high', reason: `Matched ${alias.symbol} from internal token registry.`, query: rawQuery, normalizedQuery: normalized, matches: [m], selectedMatch: m, needsUserChoice: false, failureReason: null })
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
      logTickerResolverAudit({ query: rawQuery, source: 'live_search', selectedChain: prefer, providersTried: ['dexscreener', 'geckoterminal'], matchesFound: 0, topMatch: null, confidence: 'low', needsUserChoice: false, finalAction: 'not_found', failureReason: 'no_matches' })
      return NextResponse.json<ResolverResult>({ status: 'not_found', contractAddress: null, chain: null, bestCandidate: null, alternates: [], confidence: 'low', reason: 'No matching token found. Try pasting the contract address.', query: rawQuery, normalizedQuery: normalized, matches: [], selectedMatch: null, needsUserChoice: false, failureReason: 'no_matches' })
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

    // AMBIGUITY-GATING FIX, DISCLOSED (ticker search task): exact-symbol/exact-name matches used to
    // be entirely EXEMPT from the ambiguity check ("best.matchType !== 'exact_symbol' && ... !==
    // 'exact_name'") — two different real tokens that both happen to be an exact "PEPE" match on
    // different chains (or even the same chain) always silently resolved to whichever ranked
    // marginally higher, never asking. Per explicit instruction ("do not randomly choose a token
    // when confidence is low" / "if multiple matches exist, show options"), exact matches are no
    // longer exempt — they just get a tighter score-gap threshold than fuzzy matches, since a real
    // exact-symbol tie deserves more benefit of the doubt than two loose partial matches do.
    const exactTie = best.matchType === 'exact_symbol' || best.matchType === 'exact_name'
    const scoreDiff = best.confidenceScore - (second?.confidenceScore ?? 0)
    const ambiguousThreshold = exactTie ? 30 : 50
    const isAmbiguous = !!second && scoreDiff < ambiguousThreshold

    let confidence: 'high' | 'medium' | 'low' = 'low'
    if (best.matchType === 'exact_symbol' || best.matchType === 'exact_name') {
      confidence = (best.liquidityUsd ?? 0) > 50_000 ? 'high' : 'medium'
    } else if (best.matchType === 'partial_symbol' || best.matchType === 'partial_name') {
      confidence = (best.liquidityUsd ?? 0) > 250_000 ? 'medium' : 'low'
    }

    const matches = [best, ...alternates].map((c) => toMatch(c, confidence))
    const selectedMatch = isAmbiguous ? null : matches[0]
    logTickerResolverAudit({
      query: rawQuery, source: 'live_search', selectedChain: prefer,
      providersTried: ['dexscreener', 'geckoterminal'], matchesFound: merged.length,
      topMatch: best.symbol ?? best.name, confidence, needsUserChoice: isAmbiguous,
      finalAction: isAmbiguous ? 'ambiguous' : 'resolved', failureReason: null,
    })

    const displayName = best.symbol ?? best.name ?? normalized.toUpperCase()
    return NextResponse.json<ResolverResult>({
      status: isAmbiguous ? 'ambiguous' : 'resolved',
      contractAddress: best.contractAddress,
      chain: resolvedChain(best.chainId),
      bestCandidate: best,
      query: rawQuery,
      normalizedQuery: normalized,
      matches,
      selectedMatch,
      needsUserChoice: isAmbiguous,
      failureReason: null,
      alternates,
      confidence,
      reason: isAmbiguous
        ? `Multiple tokens found for ${normalized.toUpperCase()}. Choose one to scan.`
        : `Resolved ${displayName} on ${best.chainLabel}.`,
    })

  } catch (err) {
    console.error('[resolve]', err)
    return NextResponse.json<ResolverResult>({ status: 'not_found', contractAddress: null, chain: null, bestCandidate: null, alternates: [], confidence: 'low', reason: 'Resolver error.', query: '', normalizedQuery: '', matches: [], selectedMatch: null, needsUserChoice: false, failureReason: 'resolver_error' }, { status: 500 })
  }
}
