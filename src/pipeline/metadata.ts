/** Aerodrome discovery lives in the pipeline layer and admits only provider-returned metadata. */
import type { ExternalPool } from './pricing'

export type AerodromeToken = { address: string; decimals?: number; symbol?: string }
export type AerodromePool = ExternalPool & {
  address: string
  token0Decimals?: number
  token1Decimals?: number
  token0Symbol?: string
  token1Symbol?: string
  twapPriceUsd?: number
}

const POOLS_QUERY = `query PipelineAerodromePools($token: Bytes!) {
  token0Pools: pools(where: { token0: $token }, first: 100, orderBy: reserveUSD, orderDirection: desc) { id token0 { id decimals symbol } token1 { id decimals symbol } reserve0 reserve1 reserveUSD token0Price token1Price twapPriceUsd }
  token1Pools: pools(where: { token1: $token }, first: 100, orderBy: reserveUSD, orderDirection: desc) { id token0 { id decimals symbol } token1 { id decimals symbol } reserve0 reserve1 reserveUSD token0Price token1Price twapPriceUsd }
}`
const POOLS_MIN_QUERY = `query PipelineAerodromePoolsFallback($token: Bytes!) {
  token0Pools: pools(where: { token0: $token }, first: 100) { id token0 { id decimals symbol } token1 { id decimals symbol } reserve0 reserve1 reserveUSD }
  token1Pools: pools(where: { token1: $token }, first: 100) { id token0 { id decimals symbol } token1 { id decimals symbol } reserve0 reserve1 reserveUSD }
}`
const PAIRS_QUERY = `query PipelineAerodromePairs($token: Bytes!) {
  token0Pairs: pairs(where: { token0: $token }, first: 100) { id token0 { id decimals symbol } token1 { id decimals symbol } reserve0 reserve1 reserveUSD token0Price token1Price twapPriceUsd }
  token1Pairs: pairs(where: { token1: $token }, first: 100) { id token0 { id decimals symbol } token1 { id decimals symbol } reserve0 reserve1 reserveUSD token0Price token1Price twapPriceUsd }
}`

const finitePositive = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}
const tokenField = (raw: unknown, field: 'id' | 'symbol' | 'decimals'): unknown =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[field] : undefined

function parsePool(raw: Record<string, unknown>): AerodromePool | null {
  const token0 = String(tokenField(raw.token0, 'id') ?? '').toLowerCase()
  const token1 = String(tokenField(raw.token1, 'id') ?? '').toLowerCase()
  const reserve0 = finitePositive(raw.reserve0)
  const reserve1 = finitePositive(raw.reserve1)
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!id || !token0 || !token1 || reserve0 === undefined || reserve1 === undefined) return null
  const decimals0 = finitePositive(tokenField(raw.token0, 'decimals'))
  const decimals1 = finitePositive(tokenField(raw.token1, 'decimals'))
  return {
    source: 'aerodrome', address: id, token0, token1, reserve0, reserve1,
    ...(finitePositive(raw.reserveUSD) !== undefined ? { liquidity: finitePositive(raw.reserveUSD) } : {}),
    ...(decimals0 !== undefined ? { token0Decimals: decimals0 } : {}),
    ...(decimals1 !== undefined ? { token1Decimals: decimals1 } : {}),
    ...(typeof tokenField(raw.token0, 'symbol') === 'string' ? { token0Symbol: tokenField(raw.token0, 'symbol') as string } : {}),
    ...(typeof tokenField(raw.token1, 'symbol') === 'string' ? { token1Symbol: tokenField(raw.token1, 'symbol') as string } : {}),
    ...(finitePositive(raw.twapPriceUsd) !== undefined ? { twapPriceUsd: finitePositive(raw.twapPriceUsd) } : {}),
  }
}

async function query(queryText: string, token: string): Promise<AerodromePool[]> {
  try {
    const response = await fetch(process.env.AERODROME_SUBGRAPH_URL ?? 'https://api.thegraph.com/subgraphs/name/aerodrome-finance/aerodrome', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({ query: queryText, variables: { token: token.toLowerCase() } }),
    })
    if (!response.ok) return []
    const body = await response.json() as { data?: Record<string, unknown> }
    return Object.values(body.data ?? {}).flatMap((value) => Array.isArray(value) ? value : [])
      .map((raw) => parsePool(raw as Record<string, unknown>)).filter((pool): pool is AerodromePool => pool !== null)
  } catch { return [] }
}

/** Tries the canonical pools schema, then Aerodrome deployments exposing the legacy pairs schema. */
export async function discoverAerodromePools(tokenAddress: string): Promise<AerodromePool[]> {
  if (!tokenAddress.trim()) return []
  const pools = await query(POOLS_QUERY, tokenAddress)
  if (pools.length > 0) return pools
  const compatiblePools = await query(POOLS_MIN_QUERY, tokenAddress)
  return compatiblePools.length > 0 ? compatiblePools : query(PAIRS_QUERY, tokenAddress)
}

/** Address is authoritative; decimals/symbol disambiguate duplicated or inconsistent graph rows. */
export function mapAerodromeToken(token: AerodromeToken, pools: readonly AerodromePool[]): AerodromePool | null {
  const address = token.address.toLowerCase()
  const matches = pools.filter((pool) => {
    const side = pool.token0?.toLowerCase() === address ? 0 : pool.token1?.toLowerCase() === address ? 1 : -1
    if (side < 0) return false
    const decimals = side === 0 ? pool.token0Decimals : pool.token1Decimals
    const symbol = side === 0 ? pool.token0Symbol : pool.token1Symbol
    return (token.decimals === undefined || decimals === token.decimals) &&
      (token.symbol === undefined || symbol?.toLowerCase() === token.symbol.toLowerCase())
  })
  return matches.length === 1 ? matches[0] : null
}
