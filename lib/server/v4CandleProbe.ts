// lib/server/v4CandleProbe.ts — TEMPORARY, Preview-only diagnostic behind the CANDLE DEBUG panel's
// "TEST V4 CANDLES" button. It answers one question with a live request: does each provider serve
// pool OHLCV for a bytes32 (64-hex) Uniswap V4 / PancakeSwap Infinity PoolId?
//
// Diagnostic only: nothing here feeds the chart, flips the per-provider V4 PoolId flags, or touches the
// candle ladder. Exactly one request per provider (max 2 per click), each isolated so one
// provider's failure can't color the other's result. Only safe summary numbers are returned —
// never keys, headers, URLs, raw bodies or auth data.

import {
  EVM_CHART_NETWORK,
  EVM_POOL_ADDRESS_RE,
  EVM_POOL_ID_RE,
  classifyOhlcvResponse,
  closeMatchesLivePrice,
  coingeckoMetaTokenSide,
} from '../evmChartCandles.ts'

export const V4_PROBE_CHAINS = ['eth', 'base', 'bnb', 'robinhood'] as const
export const V4_PROBE_REQUEST = { resolution: 'minute' as const, aggregate: 15, limit: 100 }
export const V4_PROBE_MAX_PROVIDER_CALLS = 2

export type V4ProbeInput = {
  chain: (typeof V4_PROBE_CHAINS)[number]
  pool: string
  token: string
  side: 'base' | 'quote'
  livePriceUsd: number | null
}

export type ProviderFetch = (input: V4ProbeInput) => Promise<{ json: unknown; httpStatus: number | null }>

export type V4ProviderResult = {
  provider: 'coingecko_onchain' | 'geckoterminal'
  attempted: boolean
  /** Why no request was made (e.g. no key, chain not routed to this provider). */
  skippedReason: string | null
  httpStatus: number | null
  /** 'ok' or the structured candle code for this response. */
  outcome: string | null
  rows: number
  firstClose: number | null
  latestClose: number | null
  tokenSide: 'base' | 'quote'
  /** Response meta names the scanned token on the requested side. null = response carried no meta. */
  identityMatched: boolean | null
  /** Latest close within 3x of the scan's live token price (the ladder's own check). */
  priceMatch: boolean | null
}

export type V4ProbeResult = {
  chain: string
  pool: string
  token: string
  side: 'base' | 'quote'
  livePriceUsd: number | null
  providerCalls: number
  coingecko: V4ProviderResult
  geckoterminal: V4ProviderResult
}

const TOKEN_RE = EVM_POOL_ADDRESS_RE

export function parseV4ProbeInput(sp: URLSearchParams): V4ProbeInput | { error: string } {
  const chain = (sp.get('chain') ?? '').toLowerCase()
  const pool = (sp.get('pool') ?? '').toLowerCase()
  const token = (sp.get('token') ?? '').toLowerCase()
  const side = sp.get('side')
  const priceRaw = sp.get('livePriceUsd')
  if (!(V4_PROBE_CHAINS as readonly string[]).includes(chain)) return { error: 'unsupported chain' }
  if (!EVM_POOL_ID_RE.test(pool)) return { error: 'pool must be a 64-hex V4 PoolId' }
  if (!TOKEN_RE.test(token)) return { error: 'token must be a 40-hex address' }
  if (side !== 'base' && side !== 'quote') return { error: 'side must be base or quote' }
  const price = priceRaw == null || priceRaw === '' ? null : Number(priceRaw)
  if (price != null && !(Number.isFinite(price) && price > 0)) return { error: 'invalid livePriceUsd' }
  return { chain: chain as V4ProbeInput['chain'], pool, token, side, livePriceUsd: price }
}

function summarize(provider: V4ProviderResult['provider'], input: V4ProbeInput, raw: { json: unknown; httpStatus: number | null }): V4ProviderResult {
  const { code, normalized } = classifyOhlcvResponse('pool', raw.httpStatus, raw.json)
  const pts = normalized.points
  const hasMeta = Boolean((raw.json as { meta?: unknown } | null)?.meta)
  return {
    provider,
    attempted: true,
    skippedReason: null,
    httpStatus: raw.httpStatus,
    outcome: code,
    rows: normalized.validPointCount,
    firstClose: pts[0]?.close ?? null,
    latestClose: pts[pts.length - 1]?.close ?? null,
    tokenSide: input.side,
    identityMatched: hasMeta ? coingeckoMetaTokenSide(raw.json, input.token) === input.side : null,
    priceMatch: pts.length > 0 && input.livePriceUsd != null ? closeMatchesLivePrice(pts, input.livePriceUsd) : null,
  }
}

function skipped(provider: V4ProviderResult['provider'], input: V4ProbeInput, reason: string): V4ProviderResult {
  return { provider, attempted: false, skippedReason: reason, httpStatus: null, outcome: null, rows: 0, firstClose: null, latestClose: null, tokenSide: input.side, identityMatched: null, priceMatch: null }
}

/** One request per provider, isolated; a throw from one never affects the other. */
export async function runV4CandleProbe(
  input: V4ProbeInput,
  deps: { coingecko: ProviderFetch | null; coingeckoSkipReason?: string; geckoterminal: ProviderFetch },
): Promise<V4ProbeResult> {
  let providerCalls = 0
  const runOne = async (provider: V4ProviderResult['provider'], fetcher: ProviderFetch): Promise<V4ProviderResult> => {
    providerCalls++
    try {
      return summarize(provider, input, await fetcher(input))
    } catch {
      return summarize(provider, input, { json: null, httpStatus: null })
    }
  }
  const [coingecko, geckoterminal] = await Promise.all([
    deps.coingecko ? runOne('coingecko_onchain', deps.coingecko) : Promise.resolve(skipped('coingecko_onchain', input, deps.coingeckoSkipReason ?? 'not_configured')),
    EVM_CHART_NETWORK[input.chain] ? runOne('geckoterminal', deps.geckoterminal) : Promise.resolve(skipped('geckoterminal', input, 'network_not_supported')),
  ])
  return { chain: input.chain, pool: input.pool, token: input.token, side: input.side, livePriceUsd: input.livePriceUsd, providerCalls, coingecko, geckoterminal }
}

/** GeckoTerminal pool OHLCV path for the probe (public API, no key). */
export function geckoTerminalProbePath(input: V4ProbeInput): string {
  const qs = new URLSearchParams({
    aggregate: String(V4_PROBE_REQUEST.aggregate),
    limit: String(V4_PROBE_REQUEST.limit),
    currency: 'usd',
    token: input.side,
    include_empty_intervals: 'false',
  })
  return `/api/v2/networks/${EVM_CHART_NETWORK[input.chain]}/pools/${input.pool}/ohlcv/${V4_PROBE_REQUEST.resolution}?${qs.toString()}`
}
