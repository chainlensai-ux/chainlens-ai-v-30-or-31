import { NextResponse } from 'next/server'
import { TICKER_CHAIN_IDS, finalizeTickerResolution, isDirectTokenAddress, normalizeTickerAddress, normalizeTickerChain, type TickerChainSlug, type TickerMatch, type TickerResolverSource } from '@/lib/tickerResolverCore'
import { isEvmAddress, isValidSolanaMintAddress } from '@/lib/solanaAddress'

function known(name: string, symbol: string, chainSlug: TickerChainSlug, tokenAddress: string): TickerMatch {
  return { name, symbol, chainId: TICKER_CHAIN_IDS[chainSlug], chainSlug, tokenAddress: normalizeTickerAddress(tokenAddress, chainSlug), pairAddress: null, dex: null, priceUsd: null, marketCapUsd: null, fdvUsd: null, liquidityUsd: null, volume24hUsd: null, priceChange24hPct: null, confidence: 0, reason: 'Known ChainLens token identity.', source: 'chainlens_cache', matchType: 'exact_symbol' }
}

const KNOWN_TOKENS: TickerMatch[] = [
  known('Wrapped Ether', 'WETH', 'eth', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
  known('Wrapped Ether', 'WETH', 'base', '0x4200000000000000000000000000000000000006'),
  known('Pepe', 'PEPE', 'eth', '0x6982508145454ce325ddbe47a25d4ec3d2311933'),
  known('Brett', 'BRETT', 'base', '0x532f27101965dd16442e59d40670faf5ebb142e4'),
  known('Toshi', 'TOSHI', 'base', '0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4'),
  known('USD Coin', 'USDC', 'base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  known('USD Coin', 'USDC', 'eth', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
  known('Aerodrome Finance', 'AERO', 'base', '0x940181a94a35a4569e4529a3cdfb74e38fd98631'),
  known('Virtuals Protocol', 'VIRTUAL', 'base', '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'),
  known('Degen', 'DEGEN', 'base', '0x4ed4e862860bed51a9570b96d89af5e1b0efefed'),
]
const RESOLVER_CACHE = new Map<string, { expiresAt: number; matches: TickerMatch[] }>()
const RESOLVER_CACHE_TTL_MS = 2 * 60 * 1000

function num(value: unknown): number | null { const n = Number(value); return value !== null && value !== '' && Number.isFinite(n) ? n : null }
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function validAddress(value: string): boolean { return isEvmAddress(value) || isValidSolanaMintAddress(value) }
function queryMatch(row: TickerMatch, query: string): boolean {
  const q = query.toUpperCase(), symbol = row.symbol?.toUpperCase() ?? '', name = row.name?.toUpperCase() ?? ''
  return symbol === q || name === q || symbol.startsWith(q) || name.includes(q)
}

async function dexSearch(query: string): Promise<TickerMatch[]> {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5000) })
  const payload = response.ok ? await response.json().catch(() => ({})) as { pairs?: unknown[] } : {}
  return (Array.isArray(payload.pairs) ? payload.pairs : []).flatMap((raw): TickerMatch[] => {
    if (!raw || typeof raw !== 'object') return []
    const p = raw as Record<string, unknown>, base = (p.baseToken as Record<string, unknown> | undefined) ?? {}
    const chainSlug = normalizeTickerChain(p.chainId), tokenAddress = text(base.address) ?? ''
    if (!chainSlug || !validAddress(tokenAddress)) return []
    const liquidity = (p.liquidity as Record<string, unknown> | undefined) ?? {}, volume = (p.volume as Record<string, unknown> | undefined) ?? {}, change = (p.priceChange as Record<string, unknown> | undefined) ?? {}
    const row: TickerMatch = { name: text(base.name), symbol: text(base.symbol), chainId: TICKER_CHAIN_IDS[chainSlug], chainSlug, tokenAddress: normalizeTickerAddress(tokenAddress, chainSlug), pairAddress: text(p.pairAddress), dex: text(p.dexId), priceUsd: num(p.priceUsd), marketCapUsd: num(p.marketCap), fdvUsd: num(p.fdv), liquidityUsd: num(liquidity.usd), volume24hUsd: num(volume.h24), priceChange24hPct: num(change.h24), confidence: 0, reason: 'Live pair identity from DexScreener.', source: 'dexscreener', matchType: 'partial_name' }
    return queryMatch(row, query) ? [row] : []
  })
}

async function geckoSearch(query: string, selectedChain: TickerChainSlug | null): Promise<TickerMatch[]> {
  const network = selectedChain ? `&network=${selectedChain === 'bnb' ? 'bsc' : selectedChain}` : ''
  const response = await fetch(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}${network}&page=1&include=base_token`, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5000) })
  const payload = response.ok ? await response.json().catch(() => ({})) as { data?: unknown[]; included?: unknown[] } : {}
  const tokens = new Map<string, Record<string, unknown>>()
  for (const raw of Array.isArray(payload.included) ? payload.included : []) { if (raw && typeof raw === 'object') { const r = raw as Record<string, unknown>; if (typeof r.id === 'string') tokens.set(r.id, (r.attributes as Record<string, unknown>) ?? {}) } }
  return (Array.isArray(payload.data) ? payload.data : []).flatMap((raw): TickerMatch[] => {
    if (!raw || typeof raw !== 'object') return []
    const p = raw as Record<string, unknown>, attrs = (p.attributes as Record<string, unknown>) ?? {}, rels = (p.relationships as Record<string, unknown>) ?? {}
    const tokenId = text(((rels.base_token as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id) ?? '', split = tokenId.indexOf('_')
    const token = tokens.get(tokenId) ?? {}, chainSlug = normalizeTickerChain(split > 0 ? tokenId.slice(0, split) : ''), tokenAddress = text(token.address) ?? (split > 0 ? tokenId.slice(split + 1) : '')
    if (!chainSlug || !validAddress(tokenAddress)) return []
    const volume = (attrs.volume_usd as Record<string, unknown> | undefined) ?? {}, change = (attrs.price_change_percentage as Record<string, unknown> | undefined) ?? {}
    const row: TickerMatch = { name: text(token.name), symbol: text(token.symbol), chainId: TICKER_CHAIN_IDS[chainSlug], chainSlug, tokenAddress: normalizeTickerAddress(tokenAddress, chainSlug), pairAddress: text(attrs.address), dex: text(attrs.dex_name), priceUsd: num(attrs.base_token_price_usd), marketCapUsd: num(attrs.market_cap_usd), fdvUsd: num(attrs.fdv_usd), liquidityUsd: num(attrs.reserve_in_usd), volume24hUsd: num(volume.h24), priceChange24hPct: num(change.h24), confidence: 0, reason: 'Live pool identity from GeckoTerminal.', source: 'geckoterminal', matchType: 'partial_name' }
    return queryMatch(row, query) ? [row] : []
  })
}

async function coinGeckoSearch(query: string): Promise<TickerMatch[]> {
  const response = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(4000) })
  const payload = response.ok ? await response.json().catch(() => ({})) as { coins?: unknown[] } : {}
  const exact = (Array.isArray(payload.coins) ? payload.coins : []).filter((raw) => { const c = raw as Record<string, unknown>; return String(c.symbol ?? '').toUpperCase() === query.toUpperCase() || String(c.name ?? '').toUpperCase() === query.toUpperCase() }).slice(0, 3)
  const detailResults = await Promise.allSettled(exact.map(async (raw) => { const id = String((raw as Record<string, unknown>).id ?? ''); const r = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}?localization=false&tickers=false&community_data=false&developer_data=false`, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(4000) }); return r.ok ? r.json() as Promise<Record<string, unknown>> : null }))
  const platformMap: Record<string, TickerChainSlug> = { ethereum: 'eth', base: 'base', 'binance-smart-chain': 'bnb', solana: 'solana' }, rows: TickerMatch[] = []
  for (const result of detailResults) {
    if (result.status !== 'fulfilled' || !result.value) continue
    const data = result.value, platforms = (data.platforms as Record<string, unknown> | undefined) ?? {}, market = (data.market_data as Record<string, unknown> | undefined) ?? {}
    for (const [platform, addressValue] of Object.entries(platforms)) {
      const chainSlug = platformMap[platform], tokenAddress = text(addressValue) ?? ''
      if (!chainSlug || !validAddress(tokenAddress)) continue
      rows.push({ name: text(data.name), symbol: text(data.symbol)?.toUpperCase() ?? null, chainId: TICKER_CHAIN_IDS[chainSlug], chainSlug, tokenAddress: normalizeTickerAddress(tokenAddress, chainSlug), pairAddress: null, dex: null, priceUsd: num((market.current_price as Record<string, unknown> | undefined)?.usd), marketCapUsd: num((market.market_cap as Record<string, unknown> | undefined)?.usd), fdvUsd: num((market.fully_diluted_valuation as Record<string, unknown> | undefined)?.usd), liquidityUsd: null, volume24hUsd: num((market.total_volume as Record<string, unknown> | undefined)?.usd), priceChange24hPct: num(market.price_change_percentage_24h), confidence: 0, reason: 'Common-asset contract identity from CoinGecko.', source: 'coingecko', matchType: 'exact_symbol' })
    }
  }
  return rows
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { query?: string; chain?: string | null }
  const query = String(body.query ?? '').trim(), selectedChain = normalizeTickerChain(body.chain), providersTried: TickerResolverSource[] = []
  if (!query) return NextResponse.json(finalizeTickerResolution({ query, selectedChain, matches: [], providersTried }))
  if (isDirectTokenAddress(query)) {
    const directChain = isValidSolanaMintAddress(query) ? 'solana' : selectedChain
    if (!directChain) { const result = finalizeTickerResolution({ query, selectedChain, matches: [], providersTried }); return NextResponse.json({ ...result, failureReason: 'Choose a chain for this EVM contract address.', reason: 'Choose a chain for this EVM contract address.' }) }
    const direct = known('Contract token', 'TOKEN', directChain, query); direct.symbol = null; direct.source = 'chain_fallback'; direct.reason = 'Contract address provided directly.'; direct.confidence = 100
    return NextResponse.json(finalizeTickerResolution({ query, selectedChain: directChain, matches: [direct], providersTried, directAddressChain: directChain }))
  }
  const normalized = query.replace(/^\$/, '').trim(), matches: TickerMatch[] = []
  const cacheKey = `${selectedChain ?? 'all'}:${normalized.toUpperCase()}`
  providersTried.push('chainlens_cache')
  const cached = RESOLVER_CACHE.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    const cachedRows = cached.matches.map((row) => ({ ...row, source: 'chainlens_cache' as const, reason: 'Recent ChainLens ticker lookup.' }))
    return NextResponse.json(finalizeTickerResolution({ query, selectedChain, matches: cachedRows, providersTried }))
  }
  providersTried.push('dexscreener'); try { matches.push(...await dexSearch(normalized)) } catch { /* continue */ }
  providersTried.push('geckoterminal'); try { matches.push(...await geckoSearch(normalized, selectedChain)) } catch { /* continue */ }
  providersTried.push('coingecko'); try { matches.push(...await coinGeckoSearch(normalized)) } catch { /* continue */ }
  providersTried.push('chain_fallback'); matches.push(...KNOWN_TOKENS.filter((row) => queryMatch(row, normalized)).map((row) => ({ ...row, source: 'chain_fallback' as const, reason: 'Known chain-specific token identity.' })))
  const result = finalizeTickerResolution({ query, selectedChain, matches, providersTried })
  if (result.matches.length) RESOLVER_CACHE.set(cacheKey, { expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS, matches: result.matches })
  return NextResponse.json(result)
}
