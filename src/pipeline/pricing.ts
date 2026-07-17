/** Pipeline-only, non-authoritative pricing and pool metadata helpers. */
import type { AerodromePool, AerodromeToken } from './metadata'

export type DexScreenerChain = 'ethereum' | 'bsc' | 'polygon' | 'arbitrum' | 'optimism' | 'avalanche' | 'fantom' | 'base'
export type ExternalPoolSource = 'dexscreener' | 'uniswap' | 'aerodrome' | 'sushi' | 'curve' | 'balancer'
export type PipelinePrice = {
  priceUsd: number
  source: 'goldrush' | ExternalPoolSource | 'external' | 'ratio' | 'synthetic'
  confidence: 'high' | 'medium' | 'low'
  pricedViaExternal?: true
  pricedViaDexScreener?: true
}
export { discoverAerodromePools, mapAerodromeToken } from './metadata'
export type TimestampedPipelinePrice = Record<number, PipelinePrice>

export type PoolMetadata = {
  poolAddress?: string
  token0?: string
  token1?: string
  reserve0?: number
  reserve1?: number
  liquidity?: number
  feeTier?: number
  poolType?: string
}

export type SyntheticPoolPriceData = PoolMetadata & {
  midPriceUsd: number
  liquidityUsd?: number
  priceConfidence: PipelinePrice['confidence']
  pricedViaDexScreener?: boolean
  pricedViaUniswap?: boolean
  pricedViaAerodrome?: boolean
  pricedViaSushi?: boolean
  pricedViaCurve?: boolean
  pricedViaBalancer?: boolean
  pricedViaRatioFallback?: boolean
  pricedViaSynthetic?: boolean
}
export type ExternalPool = PoolMetadata & { source: ExternalPoolSource; priceUsd?: number }

/** Historical Base fallback: provider TWAP first, otherwise reserve ratio with a real quote USD price. */
export function priceBaseTokenFromAerodrome(
  token: AerodromeToken,
  pool: AerodromePool | null,
  quotePricesUsd: Readonly<Record<string, number>>,
): number | null {
  if (!pool) return null
  if (pool.twapPriceUsd !== undefined && Number.isFinite(pool.twapPriceUsd) && pool.twapPriceUsd > 0) return pool.twapPriceUsd
  const tokenIs0 = pool.token0?.toLowerCase() === token.address.toLowerCase()
  const tokenIs1 = pool.token1?.toLowerCase() === token.address.toLowerCase()
  if (!tokenIs0 && !tokenIs1) return null
  const quote = tokenIs0 ? pool.token1 : pool.token0
  const tokenReserve = tokenIs0 ? pool.reserve0 : pool.reserve1
  const quoteReserve = tokenIs0 ? pool.reserve1 : pool.reserve0
  const quotePrice = quote ? positive(quotePricesUsd[quote.toLowerCase()]) : undefined
  if (!positive(tokenReserve) || !positive(quoteReserve) || !quotePrice) return null
  return (quoteReserve! / tokenReserve!) * quotePrice
}

const SUBGRAPH_URLS = {
  uniswap: process.env.UNISWAP_SUBGRAPH_URL ?? 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3',
  aerodrome: process.env.AERODROME_SUBGRAPH_URL ?? 'https://api.thegraph.com/subgraphs/name/aerodrome-finance/aerodrome',
  sushi: process.env.SUSHI_SUBGRAPH_URL ?? 'https://api.thegraph.com/subgraphs/name/sushiswap/exchange',
  curve: process.env.CURVE_SUBGRAPH_URL ?? 'https://api.thegraph.com/subgraphs/name/convex-community/volume-mainnet',
  balancer: process.env.BALANCER_SUBGRAPH_URL ?? 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2',
} as const

function positive(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}
function address(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && value.id.trim()) return value.id
  return undefined
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined }

function normalizePool(source: ExternalPoolSource, raw: Record<string, unknown>): ExternalPool {
  // Only fields explicitly returned by the provider are admitted. In particular, liquidity and
  // volume are metadata and are never converted into a price.
  const explicitPrice = positive(raw.priceUsd ?? raw.priceUSD ?? raw.token0PriceUSD ?? raw.usdPrice)
  return {
    source,
    ...(text(raw.id ?? raw.address) ? { poolAddress: text(raw.id ?? raw.address) } : {}),
    ...(explicitPrice ? { priceUsd: explicitPrice } : {}),
    ...(address(raw.token0 ?? raw.coin0) ? { token0: address(raw.token0 ?? raw.coin0) } : {}),
    ...(address(raw.token1 ?? raw.coin1) ? { token1: address(raw.token1 ?? raw.coin1) } : {}),
    ...(positive(raw.reserve0 ?? raw.reserve0Raw) ? { reserve0: positive(raw.reserve0 ?? raw.reserve0Raw) } : {}),
    ...(positive(raw.reserve1 ?? raw.reserve1Raw) ? { reserve1: positive(raw.reserve1 ?? raw.reserve1Raw) } : {}),
    ...(positive(raw.liquidity ?? raw.totalLiquidity) ? { liquidity: positive(raw.liquidity ?? raw.totalLiquidity) } : {}),
    ...(positive(raw.feeTier ?? raw.swapFee ?? raw.fee) ? { feeTier: positive(raw.feeTier ?? raw.swapFee ?? raw.fee) } : {}),
    ...(text(raw.poolType ?? raw.type) ? { poolType: text(raw.poolType ?? raw.type) } : {}),
  }
}

export async function fetchDexScreenerPool(chain: DexScreenerChain, poolAddress: string): Promise<ExternalPool | null> {
  if (!poolAddress.trim()) return null
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${poolAddress}`, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) return null
    const body = await response.json() as { pair?: Record<string, unknown>; pairs?: Array<Record<string, unknown>> }
    const raw = body.pair ?? body.pairs?.[0]
    return raw ? normalizePool('dexscreener', raw) : null
  } catch { return null }
}

const POOL_QUERY = `query PipelinePool($id: ID!) { pool(id: $id) { id token0 { id } token1 { id } reserve0 reserve1 liquidity feeTier swapFee poolType priceUsd priceUSD token0PriceUSD } pair(id: $id) { id token0 { id } token1 { id } reserve0 reserve1 liquidity feeTier swapFee poolType priceUsd priceUSD token0PriceUSD } }`

async function fetchSubgraphPool(source: keyof typeof SUBGRAPH_URLS, poolAddress: string): Promise<ExternalPool | null> {
  if (!poolAddress.trim()) return null
  try {
    const response = await fetch(SUBGRAPH_URLS[source], {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({ query: POOL_QUERY, variables: { id: poolAddress.toLowerCase() } }),
    })
    if (!response.ok) return null
    const body = await response.json() as { data?: { pool?: Record<string, unknown>; pair?: Record<string, unknown> } }
    const raw = body.data?.pool ?? body.data?.pair
    return raw ? normalizePool(source, raw) : null
  } catch { return null }
}

export const fetchUniswapPool = (poolAddress: string) => fetchSubgraphPool('uniswap', poolAddress)
export const fetchAerodromePool = (poolAddress: string) => fetchSubgraphPool('aerodrome', poolAddress)
export const fetchSushiPool = (poolAddress: string) => fetchSubgraphPool('sushi', poolAddress)
export const fetchCurvePool = (poolAddress: string) => fetchSubgraphPool('curve', poolAddress)
export const fetchBalancerPool = (poolAddress: string) => fetchSubgraphPool('balancer', poolAddress)

export type PriceAttempt = () => Promise<number | null | undefined> | number | null | undefined
export type ExternalPoolAttempt = () => Promise<ExternalPool | null> | ExternalPool | null

/** GoldRush -> DexScreener -> subgraphs -> ratio -> synthetic. A miss remains a miss. */
export async function resolvePipelinePrice(ts: number, attempts: {
  goldrush: PriceAttempt
  dexscreener: PriceAttempt | ExternalPoolAttempt
  subgraphs?: Partial<Record<Exclude<ExternalPoolSource, 'dexscreener'>, PriceAttempt | ExternalPoolAttempt>>
  external?: PriceAttempt
  ratio: PriceAttempt
  synthetic: PriceAttempt
}): Promise<TimestampedPipelinePrice> {
  const external = async (source: ExternalPoolSource, attempt: PriceAttempt | ExternalPoolAttempt): Promise<PipelinePrice | null> => {
    const result = await attempt()
    const priceUsd = typeof result === 'object' && result !== null ? result.priceUsd : result
    const validPrice = positive(priceUsd)
    if (!validPrice) return null
    return { priceUsd: validPrice, source, confidence: 'medium', pricedViaExternal: true, ...(source === 'dexscreener' ? { pricedViaDexScreener: true } : {}) }
  }
  const goldrush = await attempts.goldrush()
  const goldrushPrice = positive(goldrush)
  if (goldrushPrice) return { [ts]: { priceUsd: goldrushPrice, source: 'goldrush', confidence: 'high' } }
  const dex = await external('dexscreener', attempts.dexscreener)
  if (dex) return { [ts]: dex }
  for (const source of ['uniswap', 'aerodrome', 'sushi', 'curve', 'balancer'] as const) {
    const attempt = attempts.subgraphs?.[source]
    if (!attempt) continue
    const found = await external(source, attempt)
    if (found) return { [ts]: found }
  }
  if (attempts.external) {
    const priceUsd = await attempts.external()
    const validPrice = positive(priceUsd)
    if (validPrice) return { [ts]: { priceUsd: validPrice, source: 'external', confidence: 'medium', pricedViaExternal: true } }
  }
  for (const [source, attempt] of [['ratio', attempts.ratio], ['synthetic', attempts.synthetic]] as const) {
    const priceUsd = await attempt()
    const validPrice = positive(priceUsd)
    if (validPrice) return { [ts]: { priceUsd: validPrice, source, confidence: 'low' } }
  }
  return {}
}

/** Earlier sources win; later sources only fill metadata that is genuinely absent. */
export function mergePoolMetadata(pools: ReadonlyArray<ExternalPool | null>): PoolMetadata {
  const merged: PoolMetadata = {}
  for (const pool of pools) if (pool) for (const key of ['poolAddress', 'token0', 'token1', 'reserve0', 'reserve1', 'liquidity', 'feeTier', 'poolType'] as const) {
    if (merged[key] === undefined && pool[key] !== undefined) Object.assign(merged, { [key]: pool[key] })
  }
  return merged
}

/** Converts resolved USD evidence into synthetic-pipeline data without inventing price or depth. */
export function buildSyntheticPoolPriceData(
  usd: unknown,
  amount: unknown,
  resolved: PipelinePrice | null,
  pools: ReadonlyArray<ExternalPool | null>,
): SyntheticPoolPriceData | undefined {
  const validUsd = positive(usd)
  const validAmount = positive(amount)
  if (!validUsd || !validAmount || !resolved || !positive(resolved.priceUsd)) return undefined
  const metadata = mergePoolMetadata(pools)
  return {
    ...metadata,
    midPriceUsd: validUsd / validAmount,
    priceConfidence: resolved.confidence,
    ...(metadata.liquidity !== undefined ? { liquidityUsd: metadata.liquidity } : {}),
    ...(resolved.source === 'dexscreener' ? { pricedViaDexScreener: true } : {}),
    ...(resolved.source === 'uniswap' ? { pricedViaUniswap: true } : {}),
    ...(resolved.source === 'aerodrome' ? { pricedViaAerodrome: true } : {}),
    ...(resolved.source === 'sushi' ? { pricedViaSushi: true } : {}),
    ...(resolved.source === 'curve' ? { pricedViaCurve: true } : {}),
    ...(resolved.source === 'balancer' ? { pricedViaBalancer: true } : {}),
    ...(resolved.source === 'ratio' ? { pricedViaRatioFallback: true } : {}),
    ...(resolved.source === 'synthetic' ? { pricedViaSynthetic: true } : {}),
  }
}

export type PricingIntegrity = 'high' | 'medium' | 'low'
export function scorePricingCoverage(prices: Array<PipelinePrice | null>, tradeCount: number): number {
  if (tradeCount <= 0) return 100
  return Math.min(100, (prices.filter((price) => price && positive(price.priceUsd)).length / tradeCount) * 100)
}
export function scorePricingIntegrity(prices: Array<PipelinePrice | null>, tradeCount: number): PricingIntegrity {
  const valid = prices.filter((price): price is PipelinePrice => Boolean(price && positive(price.priceUsd)))
  const base: PricingIntegrity = valid.some((p) => p.confidence === 'low') ? 'low' : valid.some((p) => p.confidence === 'medium') ? 'medium' : 'high'
  if (scorePricingCoverage(prices, tradeCount) >= 50) return base
  return base === 'high' ? 'medium' : 'low'
}
