// SOLANA MARKET ANALYZER, DISCLOSED (Solana-native architecture task): live price, liquidity,
// volume, transaction counts, pair age, and social links — all from DexScreener's Solana pair
// data (already a wired provider, no new/paid API) — plus real OHLCV candles from GeckoTerminal's
// free, keyless public API, keyed off the same pool address. Solana-native market evidence, not
// an EVM chart adapter: Solana AMM pools index differently than EVM pairs, so pair selection
// (highest liquidity, summed across every indexed pair) is Solana-specific logic.

import { fetchSolanaOhlcv, type SolanaOhlcvResult } from '../solanaProviders.ts'
import type { RpcFetch } from './rpcClient.ts'
import type { SolanaMarketData, SolanaMarketPriceEvidence } from './types.ts'

export type SolanaMarketAnalysis = {
  data: SolanaMarketData | null
  provider: string | null
  pairsFound: number
  errorReason: string | null
}

/**
 * Which side of a DexScreener pair the scanned mint is on. Exact, case-sensitive comparison —
 * Solana mints are base58 and case-sensitive, so a lowercase match could attribute a different
 * mint's pair to this one. Returns null when neither side is the mint (or the pair omits sides).
 */
export function resolveSolanaPairSide(pair: Record<string, unknown>, mintAddress: string): 'base' | 'quote' | null {
  const base = (pair.baseToken as Record<string, unknown> | undefined)?.address
  const quote = (pair.quoteToken as Record<string, unknown> | undefined)?.address
  if (typeof base === 'string' && base === mintAddress) return 'base'
  if (typeof quote === 'string' && quote === mintAddress) return 'quote'
  return null
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
    const pos = (v: unknown): number | null => {
      const n = num(v)
      return n != null && n > 0 ? n : null
    }
    // Which side of the SELECTED (deepest) pool the scanned mint is on — the one canonical resolver,
    // shared with the Price Chart's candle request (primaryPoolTokenSide below).
    const topSide = resolveSolanaPairSide(top, mintAddress)
    const matchedToken = topSide === 'base' ? top.baseToken as Record<string, unknown> : topSide === 'quote' ? top.quoteToken as Record<string, unknown> : null
    const tokenName = typeof matchedToken?.name === 'string' ? matchedToken.name : null
    const tokenSymbol = typeof matchedToken?.symbol === 'string' ? matchedToken.symbol : null
    // POOL-LEVEL fields (valid whichever side the mint is on): liquidity.usd and volume.h24 are the
    // whole pool's USD depth/turnover, so they are summed across every Solana pair — a token's real
    // depth is not just its deepest pool. pairCreatedAt is the pool's own creation time.
    const liquidityUsd = solPairs.reduce((sum, p) => sum + (num((p.liquidity as Record<string, unknown> | undefined)?.usd) ?? 0), 0)
    const volume24hUsd = solPairs.reduce((sum, p) => sum + (num((p.volume as Record<string, unknown> | undefined)?.h24) ?? 0), 0)
    // txns.h24 buys/sells are counted from the pair's BASE token's point of view (a "buy" swaps quote
    // for base). For a quote-side mint that same swap is a SELL of the mint, so the counts swap
    // exactly; with no proven side the direction is unknown and stays null.
    const topTxns24h = (top.txns as Record<string, unknown> | undefined)?.h24 as Record<string, unknown> | undefined
    const pairBuys = num(topTxns24h?.buys)
    const pairSells = num(topTxns24h?.sells)
    const txns24h = topSide === 'base' ? { buys: pairBuys, sells: pairSells }
      : topSide === 'quote' ? { buys: pairSells, sells: pairBuys }
        : { buys: null, sells: null }
    const pairCreatedAt = num(top.pairCreatedAt)
    const pairAgeDaysRaw = pairCreatedAt != null ? Math.floor((Date.now() - pairCreatedAt) / 86_400_000) : null
    const pairAgeDays = pairAgeDaysRaw != null && pairAgeDaysRaw >= 0 ? pairAgeDaysRaw : null
    const pairAgeLabel = pairAgeDays != null ? (pairAgeDays < 1 ? '<1d' : `${pairAgeDays}d`) : null

    // BASE-TOKEN fields (priceUsd, fdv, marketCap, info.websites/socials) describe the pair's BASE
    // token only. They are read from the deepest pair where the scanned mint IS the base token —
    // the selected pool itself when the mint is its base, otherwise an alternate pool from this SAME
    // response. If no such pair exists they stay null: a quote-side mint's USD price is never taken
    // from the pair's base-side price, and priceNative is never inverted into one (the pair token's
    // USD price is not independently known here). Market Pulse then falls back to Jupiter's price,
    // which is keyed by the exact mint.
    const pricePair = topSide === 'base' ? top : solPairs.find((p) => resolveSolanaPairSide(p, mintAddress) === 'base') ?? null
    const priceUsd = pricePair ? pos(pricePair.priceUsd) : null
    const priceEvidence: SolanaMarketPriceEvidence = pricePair
      ? {
          status: priceUsd == null ? 'not_returned' : pricePair === top ? 'selected_pool_base_side' : 'alternate_pool_base_side',
          pairAddress: typeof pricePair.pairAddress === 'string' ? pricePair.pairAddress : null,
          reason: priceUsd == null ? 'The pool where this mint is the base token returned no USD price.' : null,
        }
      : {
          status: topSide === 'quote' ? 'unavailable_quote_side' : 'unavailable_side_unknown',
          pairAddress: null,
          reason: topSide === 'quote'
            ? 'This mint is the quote token of its indexed pools; the pool price belongs to the paired token, so no pool USD price is shown for this mint.'
            : 'The indexed pool did not identify this mint on either side, so its price cannot be attributed to this mint.',
        }

    const validUrl = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : null)
    const info = pricePair?.info as Record<string, unknown> | undefined
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
        priceUsd,
        priceEvidence,
        liquidityUsd: liquidityUsd > 0 ? Math.round(liquidityUsd) : null,
        volume24hUsd: volume24hUsd > 0 ? Math.round(volume24hUsd) : null,
        fdvUsd: pricePair ? pos(pricePair.fdv) : null,
        marketCapUsd: pricePair ? pos(pricePair.marketCap) : null,
        primaryPoolAddress: typeof top.pairAddress === 'string' ? top.pairAddress : null,
        primaryPoolTokenSide: topSide,
        primaryDexLabel: typeof top.dexId === 'string' ? top.dexId : null,
        tokenName,
        tokenSymbol,
        pairAgeLabel,
        pairAgeDays,
        txns24h,
        socials: { website, twitter, telegram, discord, reddit },
      },
    }
  } catch {
    return { data: null, provider: 'dexscreener', pairsFound: 0, errorReason: 'dexscreener_unreachable' }
  }
}

/** Real OHLCV candles for the Price Chart — see solanaProviders.ts's fetchSolanaOhlcv for the full disclosure. */
export async function analyzeSolanaCandles(poolAddress: string | null, fetchImpl: RpcFetch, tokenSide: 'base' | 'quote' | null = null): Promise<SolanaOhlcvResult> {
  return fetchSolanaOhlcv(poolAddress, fetchImpl, tokenSide)
}
