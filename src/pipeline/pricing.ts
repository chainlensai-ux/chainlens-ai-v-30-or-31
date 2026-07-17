/** Pipeline-only pricing primitives. Liquidity and volume are deliberately ignored. */
export type DexScreenerChain = 'ethereum' | 'bsc' | 'polygon' | 'arbitrum' | 'optimism' | 'avalanche' | 'fantom' | 'base'
export type PipelinePrice = { priceUsd: number; source: 'goldrush' | 'dexscreener' | 'ratio' | 'synthetic'; confidence: 'high' | 'medium' | 'low'; pricedViaDexScreener?: true }
export type TimestampedPipelinePrice = Record<number, PipelinePrice>

function validPrice(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }

export async function fetchDexScreenerPool(chain: DexScreenerChain, poolAddress: string): Promise<number | null> {
  if (!poolAddress.trim()) return null
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${poolAddress}`, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) return null
    const body = await response.json() as { pair?: { priceUsd?: string }; pairs?: Array<{ priceUsd?: string }> }
    const parsed = Number(body.pair?.priceUsd ?? body.pairs?.[0]?.priceUsd)
    return validPrice(parsed) ? parsed : null
  } catch { return null }
}

export type PriceAttempt = () => Promise<number | null> | number | null

/** GoldRush -> DexScreener -> ratio -> synthetic. A miss remains a miss. */
export async function resolvePipelinePrice(ts: number, attempts: { goldrush: PriceAttempt; dexscreener: PriceAttempt; ratio: PriceAttempt; synthetic: PriceAttempt }): Promise<TimestampedPipelinePrice> {
  const ordered: Array<[PipelinePrice['source'], PipelinePrice['confidence'], PriceAttempt]> = [
    ['goldrush', 'high', attempts.goldrush], ['dexscreener', 'medium', attempts.dexscreener],
    ['ratio', 'low', attempts.ratio], ['synthetic', 'low', attempts.synthetic],
  ]
  for (const [source, confidence, attempt] of ordered) {
    const priceUsd = await attempt()
    if (!validPrice(priceUsd)) continue
    return { [ts]: { priceUsd, source, confidence, ...(source === 'dexscreener' ? { pricedViaDexScreener: true as const } : {}) } }
  }
  return {}
}

export type PricingIntegrity = 'high' | 'medium' | 'low'
export function scorePricingCoverage(prices: Array<PipelinePrice | null>, tradeCount: number): number {
  if (tradeCount <= 0) return 100
  return Math.min(100, (prices.filter((price) => price && validPrice(price.priceUsd)).length / tradeCount) * 100)
}
export function scorePricingIntegrity(prices: Array<PipelinePrice | null>, tradeCount: number): PricingIntegrity {
  const valid = prices.filter((price): price is PipelinePrice => Boolean(price && validPrice(price.priceUsd)))
  const base: PricingIntegrity = valid.some((p) => p.confidence === 'low') ? 'low' : valid.some((p) => p.confidence === 'medium') ? 'medium' : 'high'
  if (scorePricingCoverage(prices, tradeCount) >= 50) return base
  return base === 'high' ? 'medium' : 'low'
}
