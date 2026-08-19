// SOLANA MARKET ANALYZER, DISCLOSED (Solana-native architecture task): live price, liquidity,
// volume, transaction counts, pair age, and social links — all from DexScreener's Solana pair
// data (already a wired provider, no new/paid API) — plus real OHLCV candles from GeckoTerminal's
// free, keyless public API, keyed off the same pool address. Solana-native market evidence, not
// an EVM chart adapter: Solana AMM pools index differently than EVM pairs, so pair selection
// (highest liquidity, summed across every indexed pair) is Solana-specific logic.

import { fetchSolanaOhlcv, type SolanaOhlcvResult } from '../solanaProviders.ts'
import type { RpcFetch } from './rpcClient.ts'
import type { SolanaMarketData } from './types.ts'

export type SolanaMarketAnalysis = {
  data: SolanaMarketData | null
  provider: string | null
  pairsFound: number
  errorReason: string | null
}

export async function analyzeSolanaMarket(mintAddress: string, fetchImpl: RpcFetch): Promise<SolanaMarketAnalysis> {
  try {
    const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { data: null, provider: 'dexscreener', pairsFound: 0, errorReason: `dexscreener_http_${res.status}` }
    const json = await res.json().catch(() => null) as { pairs?: unknown } | null
    const pairs = Array.isArray(json?.pairs) ? json!.pairs as Array<Record<string, unknown>> : []
    // Solana-only pairs, highest liquidity first — the primary pool is the deepest one.
    const solPairs = pairs
      .filter((p) => String(p.chainId ?? '').toLowerCase() === 'solana')
      .sort((a, b) => {
        const la = Number((a.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)
        const lb = Number((b.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)
        return lb - la
      })
    if (solPairs.length === 0) return { data: null, provider: 'dexscreener', pairsFound: 0, errorReason: 'no_solana_pairs' }
    const top = solPairs[0]
    const num = (v: unknown): number | null => {
      const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
      return Number.isFinite(n) ? n : null
    }
    // Identify which side of the pair is the mint we scanned — never assume it's always "base".
    const baseToken = top.baseToken as Record<string, unknown> | undefined
    const quoteToken = top.quoteToken as Record<string, unknown> | undefined
    const matchedToken = String(baseToken?.address ?? '').toLowerCase() === mintAddress.toLowerCase()
      ? baseToken
      : String(quoteToken?.address ?? '').toLowerCase() === mintAddress.toLowerCase()
        ? quoteToken
        : null
    const tokenName = typeof matchedToken?.name === 'string' ? matchedToken.name : null
    const tokenSymbol = typeof matchedToken?.symbol === 'string' ? matchedToken.symbol : null
    // Liquidity/volume are summed across every Solana pair — a token's real depth is not just its
    // deepest pool. Price/FDV/marketCap are read from the deepest pool only (summing those would
    // be meaningless).
    const liquidityUsd = solPairs.reduce((sum, p) => sum + (num((p.liquidity as Record<string, unknown> | undefined)?.usd) ?? 0), 0)
    const volume24hUsd = solPairs.reduce((sum, p) => sum + (num((p.volume as Record<string, unknown> | undefined)?.h24) ?? 0), 0)
    const topTxns24h = (top.txns as Record<string, unknown> | undefined)?.h24 as Record<string, unknown> | undefined
    const txns24h = { buys: num(topTxns24h?.buys), sells: num(topTxns24h?.sells) }
    const pairCreatedAt = num(top.pairCreatedAt)
    const pairAgeLabel = pairCreatedAt != null
      ? (() => {
          const days = Math.floor((Date.now() - pairCreatedAt) / 86_400_000)
          if (days < 0) return null
          if (days < 1) return '<1d'
          return `${days}d`
        })()
      : null

    // Social links from the SAME pair response — see SolanaMarketData.socials's own header.
    const validUrl = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : null)
    const info = top.info as Record<string, unknown> | undefined
    const websites = Array.isArray(info?.websites) ? info!.websites as Array<Record<string, unknown>> : []
    const socialsRaw = Array.isArray(info?.socials) ? info!.socials as Array<Record<string, unknown>> : []
    let website: string | null = null
    for (const w of websites) {
      const u = validUrl(w.url)
      if (u && !/dexscreener\.com/i.test(u)) { website = u; break }
    }
    let twitter: string | null = null
    let telegram: string | null = null
    let discord: string | null = null
    let reddit: string | null = null
    for (const s of socialsRaw) {
      const type = String(s.type ?? '').toLowerCase()
      const u = validUrl(s.url)
      if (!u) continue
      if (!twitter && (type === 'twitter' || type === 'x')) twitter = u
      else if (!telegram && type === 'telegram') telegram = u
      else if (!discord && type === 'discord') discord = u
      else if (!reddit && type === 'reddit') reddit = u
    }

    return {
      provider: 'dexscreener',
      pairsFound: solPairs.length,
      errorReason: null,
      data: {
        priceUsd: num(top.priceUsd),
        liquidityUsd: liquidityUsd > 0 ? Math.round(liquidityUsd) : null,
        volume24hUsd: volume24hUsd > 0 ? Math.round(volume24hUsd) : null,
        fdvUsd: num(top.fdv),
        marketCapUsd: num(top.marketCap),
        primaryPoolAddress: typeof top.pairAddress === 'string' ? top.pairAddress : null,
        primaryDexLabel: typeof top.dexId === 'string' ? top.dexId : null,
        tokenName,
        tokenSymbol,
        pairAgeLabel,
        txns24h,
        socials: { website, twitter, telegram, discord, reddit },
      },
    }
  } catch {
    return { data: null, provider: 'dexscreener', pairsFound: 0, errorReason: 'dexscreener_unreachable' }
  }
}

/** Real OHLCV candles for the Price Chart — see solanaProviders.ts's fetchSolanaOhlcv for the full disclosure. */
export async function analyzeSolanaCandles(poolAddress: string | null, fetchImpl: RpcFetch): Promise<SolanaOhlcvResult> {
  return fetchSolanaOhlcv(poolAddress, fetchImpl)
}
