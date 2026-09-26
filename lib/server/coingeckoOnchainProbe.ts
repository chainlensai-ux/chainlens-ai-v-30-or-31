// lib/server/coingeckoOnchainProbe.ts — READ-ONLY capability probe for CoinGecko's on-chain pool
// OHLCV endpoint, run on the deployed server where COINGECKO_API_KEY actually lives.
//
// PROBE ONLY, DISCLOSED: nothing in the product calls this. It exists so the team can check, from
// Vercel, whether the existing COINGECKO_API_KEY is accepted by
//   https://api.coingecko.com/api/v3/onchain/networks/{network}/pools/{pool}/ohlcv/{timeframe}
// before any decision to use it as a Token Scanner 429 fallback. One upstream request per call.
// The key is sent only as a request header and is scrubbed from everything returned.

export type ProbeTier = 'demo' | 'pro'

export type ProbeInput = {
  network: string
  pool: string
  timeframe: 'minute' | 'hour' | 'day'
  aggregate: number
  limit: number
  token: 'base' | 'quote' | null
  tier: ProbeTier
}

export type ProbeFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{
  status: number
  headers: { forEach: (cb: (value: string, key: string) => void) => void }
  text: () => Promise<string>
}>

const NETWORK_RE = /^[a-z0-9_-]{1,40}$/
const POOL_RE = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/

export function parseProbeInput(sp: URLSearchParams): ProbeInput | { error: string } {
  const network = (sp.get('network') ?? 'base').toLowerCase()
  const pool = sp.get('pool') ?? ''
  const timeframe = (sp.get('timeframe') ?? 'minute') as ProbeInput['timeframe']
  const aggregate = Number(sp.get('aggregate') ?? (timeframe === 'minute' ? 15 : 1))
  const limit = Number(sp.get('limit') ?? 100)
  const tokenRaw = sp.get('token')
  const tier: ProbeTier = sp.get('tier') === 'pro' ? 'pro' : 'demo'
  if (!NETWORK_RE.test(network)) return { error: 'invalid network' }
  if (!POOL_RE.test(pool)) return { error: 'invalid or missing pool address' }
  if (!['minute', 'hour', 'day'].includes(timeframe)) return { error: 'timeframe must be minute|hour|day' }
  if (!Number.isInteger(aggregate) || aggregate < 1 || aggregate > 15) return { error: 'invalid aggregate' }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return { error: 'limit must be 1..1000' }
  if (tokenRaw != null && tokenRaw !== 'base' && tokenRaw !== 'quote') return { error: 'token must be base|quote' }
  return { network, pool, timeframe, aggregate, limit, token: (tokenRaw as 'base' | 'quote' | null) ?? null, tier }
}

const RATE_HEADER_RE = /^(x-ratelimit|ratelimit|retry-after|x-cg|cf-cache-status|x-request-id)/i

function scrub(text: string, key: string | null): string {
  return key ? text.split(key).join('[redacted]') : text
}

function describe(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return depth > 1 ? `array(${value.length})` : { array: value.length, first: value.length ? describe(value[0], depth + 1) : null }
  if (value && typeof value === 'object') {
    if (depth > 2) return 'object'
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([k, v]) => [k, describe(v, depth + 1)]))
  }
  return typeof value
}

export async function runCoingeckoOnchainProbe(input: ProbeInput, apiKey: string | null, fetchImpl: ProbeFetch) {
  const host = input.tier === 'pro' ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com'
  const headerName = input.tier === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'
  const qs = new URLSearchParams({ aggregate: String(input.aggregate), limit: String(input.limit), currency: 'usd' })
  if (input.token) qs.set('token', input.token)
  const path = `/api/v3/onchain/networks/${input.network}/pools/${input.pool}/ohlcv/${input.timeframe}?${qs.toString()}`
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey) headers[headerName] = apiKey

  const request = { host, path, keyHeaderSent: apiKey ? headerName : null, tier: input.tier }
  let res: Awaited<ReturnType<ProbeFetch>>
  try {
    res = await fetchImpl(`${host}${path}`, { headers })
  } catch (err) {
    return { ok: false, request, keyConfigured: Boolean(apiKey), httpStatus: null, error: scrub(String((err as Error)?.message ?? err), apiKey).slice(0, 200) }
  }
  const rateHeaders: Record<string, string> = {}
  res.headers.forEach((value, name) => { if (RATE_HEADER_RE.test(name)) rateHeaders[name.toLowerCase()] = scrub(value, apiKey) })
  const body = await res.text().catch(() => '')
  let json: unknown = null
  try { json = JSON.parse(body) } catch { /* not JSON */ }
  const attrs = (json as { data?: { attributes?: Record<string, unknown> } } | null)?.data?.attributes
  const list = attrs?.ohlcv_list
  const rows = Array.isArray(list) ? list : null
  const meta = (json as { meta?: Record<string, unknown> } | null)?.meta ?? null
  const keyAccepted = res.status >= 200 && res.status < 300 ? true : res.status === 401 || res.status === 403 ? false : null
  return {
    ok: res.status >= 200 && res.status < 300,
    request,
    keyConfigured: Boolean(apiKey),
    httpStatus: res.status,
    keyAccepted,
    rateLimitHeaders: rateHeaders,
    schema: json == null ? null : describe(json),
    ohlcv: rows ? {
      rows: rows.length,
      firstRow: rows[0] ?? null,
      lastRow: rows[rows.length - 1] ?? null,
      newestFirst: rows.length > 1 && Array.isArray(rows[0]) && Array.isArray(rows[1]) ? Number(rows[0][0]) > Number(rows[1][0]) : null,
    } : null,
    // Side evidence: the response meta names the base/quote tokens the prices refer to.
    sideMeta: meta ? { base: scrubObj((meta as Record<string, unknown>).base, apiKey), quote: scrubObj((meta as Record<string, unknown>).quote, apiKey) } : null,
    bodySnippet: rows ? null : scrub(body, apiKey).slice(0, 400),
  }
}

function scrubObj(v: unknown, key: string | null): unknown {
  if (v == null) return null
  return JSON.parse(scrub(JSON.stringify(v), key))
}
