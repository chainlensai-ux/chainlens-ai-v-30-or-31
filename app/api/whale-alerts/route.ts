import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getOrFetchCached } from '@/lib/coingeckoCache'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'

type WindowKey = '1h' | '6h' | '24h' | '7d'
type RawRow = Record<string, unknown>

const WINDOW_MS: Record<WindowKey, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
}

function parseWindow(value: string | null): WindowKey {
  if (value === '1h' || value === '6h' || value === '24h' || value === '7d') return value
  return '24h'
}

function parseLimit(value: string | null): number {
  const n = Number(value ?? 50)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(100, Math.floor(n))
}

function emptyUnavailable(reason: string) {
  return NextResponse.json({
    alerts: [],
    stats: { alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 },
    unavailable: reason,
  })
}

// Group raw rows by (tx_hash, wallet_address) so one on-chain transaction
// produces one feed item instead of N token-leg rows.
function groupAlertsByTx(rows: RawRow[]): RawRow[] {
  if (rows.length === 0) return rows

  const groups = new Map<string, RawRow[]>()
  for (const row of rows) {
    const txKey = (row.tx_hash as string | null) ?? String(row.id ?? '')
    const key = `${txKey}::${(row.wallet_address as string | null) ?? ''}`
    const g = groups.get(key)
    if (g) g.push(row)
    else groups.set(key, [row])
  }

  const result: RawRow[] = []
  for (const legs of groups.values()) {
    if (legs.length === 1) {
      result.push({ ...legs[0], legs: 1 })
      continue
    }

    const first = legs[0]
    const sideSet = new Set(legs.map(l => l.side as string | null).filter(Boolean))
    const side = sideSet.size === 1 ? [...sideSet][0] : null

    const syms = [
      ...new Set(legs.map(l => l.token_symbol as string | null).filter(Boolean)),
    ].slice(0, 3)

    const usdSum = legs.reduce((s, l) => s + ((l.amount_usd as number | null) ?? 0), 0)

    const sevOrder = ['major', 'large', 'medium', 'small']
    const severity = sevOrder.find(sv => legs.some(l => l.severity === sv)) ?? (first.severity as string | null)

    result.push({
      ...first,
      token_symbol: syms.join(' / ') || null,
      token_name:   null,
      side,
      amount_usd:   usdSum > 0 ? usdSum : null,
      amount_token: null,
      severity,
      legs:         legs.length,
    })
  }

  return result
}

const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'USDbC', 'EURC'])
const LOW_SIGNAL_ROUTING = new Set(['USDC', 'USDBC', 'EURC', 'DAI', 'USDT', 'WETH', 'ETH', 'CBBTC', 'WSTETH'])
// Boring = base/stable assets that dominate the feed at small sizes. In "interesting" mode
// these are suppressed unless the USD value is >= $1 000.
const BORING_ASSETS = new Set(['USDC', 'USDBC', 'USDT', 'DAI', 'WETH', 'ETH', 'CBBTC'])

function splitSymbols(sym: string | null): string[] {
  if (!sym) return []
  return sym
    .split(' / ')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
}

function firstNonRoutingSymbol(sym: string | null): string | null {
  const symbols = splitSymbols(sym)
  return symbols.find(s => !LOW_SIGNAL_ROUTING.has(s)) ?? null
}

const GT_BASE_URL     = 'https://api.geckoterminal.com/api/v2'
const GT_REQ_HEADERS  = { accept: 'application/json', origin: 'https://chainlens.ai' }
// Tokens already priced by enrichRowUsd — skip for random GeckoTerminal lookups
const ENRICHED_BY_COINGECKO = new Set(['USDC', 'USDT', 'DAI', 'USDBC', 'WETH', 'ETH', 'CBBTC', 'WBTC'])
const MAX_RANDOM_TOKENS = 15
const WHALE_CACHE_TTL_MS = 45_000
const whaleCache = new Map<string, { exp: number; payload: unknown }>()
const whaleRate = new Map<string, { count: number; resetAt: number }>()
const WHALE_RATE_LIMIT: Record<'free' | 'pro' | 'elite', number> = { free: 3, pro: 12, elite: 30 }

// Rank alerts so non-stablecoin buys/swaps surface first, stablecoin moves last.
// Score is purely for display ordering — never used to filter.
function computeInterestScore(row: RawRow): number {
  const sym  = ((row.token_symbol as string | null) ?? '').trim()
  const side = ((row.side as string | null) ?? '').toLowerCase()
  const legs = (row.legs as number | null) ?? 1
  const usd  = row.amount_usd as number | null

  const syms = sym.split(' / ').map(s => s.trim().toUpperCase()).filter(Boolean)
  if (syms.length === 0) return 0

  // "Interesting" = not in the low-signal routing/stable set
  const hasInteresting = syms.some(s => !LOW_SIGNAL_ROUTING.has(s))
  const allStable = syms.every(s => STABLECOINS.has(s) || s === 'USDBC' || s === 'AXLUSDC')

  let score = 0
  // Multi-leg swap containing a non-routing token (e.g. USDC→AERO)
  if (legs >= 2 && hasInteresting) score += 100
  else if (legs >= 2)              score += 40
  // Non-stable, non-base-asset buy/accumulation
  if (hasInteresting) score += (side === 'buy' ? 80 : 50)
  // Pure base-asset moves (WETH, ETH) — moderate interest
  if (!hasInteresting && !allStable) score += 20
  // Pure stablecoin transfers — lowest priority
  if (allStable) score -= 30
  // USD value contribution (log-scaled, capped so a 1 USDC txn never beats a real buy)
  if (usd !== null && usd > 0) score += Math.min(25, Math.log10(usd) * 5)

  return score
}

// Returns true only when every symbol in a (possibly grouped) token_symbol is a stablecoin.
// "USDC / WETH" → false (mixed); "USDC" → true; "USDC / USDT" → true.
function isStablecoinOnly(sym: string | null): boolean {
  if (!sym) return false
  return sym.split(' / ').every(s => STABLECOINS.has(s.trim()))
}

// Drop stablecoin-only rows with amount_token < 100 (dust transfers).
// Keeps: mixed stable+non-stable pairs, rows with unknown amount (sync rows), amount >= 100.
// Threshold matches the $100 All quality floor so the two filters stay consistent.
function filterStablecoinNoise(rows: RawRow[]): RawRow[] {
  return rows.filter(row => {
    if (!isStablecoinOnly(row.token_symbol as string | null)) return true
    const amt = row.amount_token as number | null
    return amt === null || amt >= 100
  })
}

// In "interesting" mode: hide rows where every symbol is a boring base/stable asset
// and the verified USD value is below $1 000. Rows with null USD are kept.
function filterBoringAssets(
  rows: RawRow[],
  interestingMode: boolean,
): { rows: RawRow[]; hiddenAsBoring: number } {
  if (!interestingMode) return { rows, hiddenAsBoring: 0 }
  let hiddenAsBoring = 0
  const result = rows.filter(row => {
    const syms = splitSymbols((row.token_symbol as string | null) ?? null)
    if (syms.length === 0) return true
    if (!syms.every(s => BORING_ASSETS.has(s))) return true  // has a non-boring token
    const usd = row.amount_usd as number | null
    if (usd === null) return true   // unverified size — keep
    if (usd >= 1000) return true    // large enough to show
    hiddenAsBoring++
    return false
  })
  return { rows: result, hiddenAsBoring }
}

// Suppress swaps that are only routing/stable/major assets (e.g., USDC/WETH, EURC/USDC).
function filterRoutingOnlySwaps(rows: RawRow[]): RawRow[] {
  return rows.filter(row => {
    const symbols = splitSymbols((row.token_symbol as string | null) ?? null)
    if (symbols.length <= 1) return true
    return symbols.some(sym => !LOW_SIGNAL_ROUTING.has(sym))
  })
}


function getRowUsdValue(row: RawRow): number {
  const usd = row.amount_usd as number | null
  return usd !== null && Number.isFinite(usd) ? usd : 0
}

function applyDiversityCap(rows: RawRow[]): { rows: RawRow[]; cappedTokenCounts: Record<string, number> } {
  const sorted = [...rows].sort((a, b) => getRowUsdValue(b) - getRowUsdValue(a))
  const selected = new Set<number>()
  const perToken = new Map<string, number>()
  const cappedTokenCounts: Record<string, number> = {}

  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i]
    const focus = ((row.focus_token_symbol as string | null) ?? firstNonRoutingSymbol((row.token_symbol as string | null) ?? null) ?? '').toUpperCase().trim()
    if (!focus) {
      selected.add(i)
      continue
    }
    const usd = getRowUsdValue(row)
    const cap = usd < 10000 ? 2 : 3
    const used = perToken.get(focus) ?? 0
    if (used < cap) {
      perToken.set(focus, used + 1)
      selected.add(i)
    } else {
      cappedTokenCounts[focus] = (cappedTokenCounts[focus] ?? 0) + 1
    }
  }

  const kept = sorted.filter((_, i) => selected.has(i))
  return { rows: kept, cappedTokenCounts }
}

function applyHeadlineTokenFocus(row: RawRow): RawRow {
  const focus = firstNonRoutingSymbol((row.token_symbol as string | null) ?? null)
  if (!focus) return row
  return { ...row, focus_token_symbol: focus }
}

// Collapse rapid repeats: same wallet + token + side appearing multiple times
// within a 5-minute window becomes one representative row with a `repeats` count.
// Rows are expected newest-first (occurred_at desc).
function collapseRapidRepeats(rows: RawRow[]): RawRow[] {
  const REPEAT_WINDOW_MS = 5 * 60 * 1000
  const seen = new Map<string, { firstTime: number; idx: number; count: number }>()
  const result: RawRow[] = []

  for (const row of rows) {
    const key = [
      (row.wallet_address as string | null) ?? '',
      (row.token_symbol as string | null) ?? '',
      (row.side as string | null) ?? '',
    ].join('::')
    const ts = row.occurred_at ? new Date(row.occurred_at as string).getTime() : 0

    const existing = seen.get(key)
    if (existing && ts > 0 && existing.firstTime > 0 && (existing.firstTime - ts) < REPEAT_WINDOW_MS) {
      existing.count += 1
      result[existing.idx] = { ...result[existing.idx], repeats: existing.count }
    } else {
      const idx = result.length
      result.push({ ...row, repeats: 1 })
      seen.set(key, { firstTime: ts, idx, count: 1 })
    }
  }

  return result
}

// Derive a signal quality score from token symbol, amount, and leg count.
// HIGH: large USDC/WETH/cbBTC move or complex multi-leg transaction.
// WATCH: moderate move or 2-leg swap.
// LOW: everything else.
function computeSignalScore(row: RawRow): string {
  const sym  = ((row.token_symbol as string | null) ?? '').toUpperCase().trim()
  const amt  = row.amount_token as number | null
  const legs = (row.legs as number | null) ?? 1

  if (legs >= 3) return 'HIGH'
  if (legs >= 2) return 'WATCH'

  if (sym === 'USDC' || sym === 'USDT') {
    if (amt !== null && amt >= 1000) return 'HIGH'
    if (amt !== null && amt >= 100)  return 'WATCH'
  }
  if (sym === 'WETH' || sym === 'ETH') {
    if (amt !== null && amt >= 0.25) return 'HIGH'
    if (amt !== null && amt >= 0.01) return 'WATCH'
  }
  if (sym === 'CBBTC' || sym === 'WBTC') {
    if (amt !== null && amt >= 0.01) return 'HIGH'
    if (amt !== null && amt > 0)     return 'WATCH'
  }

  return 'LOW'
}

// Returns true if a post-enrichment row meets the "All" quality floor.
// Shared by filterByValueFloor (feed) and countStatsFiltered (stats cards).
function passesQualityFloor(row: RawRow): boolean {
  const usd  = row.amount_usd as number | null
  const sym  = ((row.token_symbol as string | null) ?? '').toUpperCase().trim()
  const amt  = row.amount_token as number | null
  const legs = (row.legs as number | null) ?? 1

  // Multi-leg swaps always pass — the swap itself is notable regardless of leg size.
  if (legs >= 2) return true

  // Primary check: known USD value must be >= $100.
  if (usd !== null) return usd >= 100

  // Fallback for rows where enrichment produced no USD (unknown tokens):
  // apply per-symbol token amount floors.
  if (sym === 'USDC' || sym === 'USDT' || sym === 'DAI' || sym === 'USDBC') return amt === null || amt >= 100
  if (sym === 'WETH' || sym === 'ETH') return amt === null || amt >= 0.01
  if (sym === 'CBBTC' || sym === 'WBTC') return amt === null || amt >= 0.0005

  // Unknown / other tokens: keep (amount > 0 guaranteed by meaningfulFilter).
  return true
}

// Parsed value range spec: null = "All" (quality floor), otherwise numeric bounds.
type ValueRangeSpec = { min: number; max: number | null } | null

function parseValueRange(value: string | null): ValueRangeSpec {
  if (!value || value === 'all') return null
  if (value === '10000+') return { min: 10000, max: null }
  const m = value.match(/^(\d+)-(\d+)$/)
  if (m) return { min: Number(m[1]), max: Number(m[2]) }
  return null
}

// Post-enrichment, post-grouping value filter.
// null ("All"): quality floor — hide known-tiny moves, keep unpriced rows.
// range: require known amount_usd within [min, max).
function filterByValueRange(
  rows: RawRow[],
  range: ValueRangeSpec,
): { rows: RawRow[]; hiddenByFilter: number; hiddenAsDust: number } {
  if (range === null) {
    let hiddenAsDust = 0
    const result = rows.filter(row => {
      if (!passesQualityFloor(row)) { hiddenAsDust++; return false }
      return true
    })
    return { rows: result, hiddenByFilter: 0, hiddenAsDust }
  }
  let hiddenByFilter = 0
  const result = rows.filter(row => {
    const usd = row.amount_usd as number | null
    if (usd === null) { hiddenByFilter++; return false }
    if (usd < range.min) { hiddenByFilter++; return false }
    if (range.max !== null && usd >= range.max) { hiddenByFilter++; return false }
    return true
  })
  return { rows: result, hiddenByFilter, hiddenAsDust: 0 }
}

// Count distinct tx_hash values from a stats query result, applying per-row enrichment
// and the same value floor used for the feed. Used for metric cards.
function countStatsFiltered(
  data: unknown,
  prices: MajorPrices,
  minUsd: number,
  tokenPrices?: Map<string, number>,
): number {
  type StatRow = { tx_hash: string | null; token_symbol?: string | null; amount_token?: number | null; amount_usd?: number | null; token_address?: string | null }
  const rows = data as StatRow[] | null
  if (!rows || rows.length === 0) return 0
  const txHashes = new Set<string>()
  for (const r of rows) {
    let enriched = enrichRowUsd(r as RawRow, prices)
    if (tokenPrices && tokenPrices.size > 0) enriched = enrichRowWithTokenPrice(enriched, tokenPrices)
    const passes   = minUsd > 0
      ? ((enriched.amount_usd as number | null) !== null && (enriched.amount_usd as number) >= minUsd)
      : passesQualityFloor(enriched)
    if (passes && r.tx_hash) txHashes.add(r.tx_hash)
  }
  return txHashes.size
}

// Fetch the USD price for an arbitrary Base token via GeckoTerminal pools endpoint.
// Sorts pools by liquidity and reads base_token_price_usd from the deepest pool.
// Returns null on any failure so callers never throw.
async function fetchBaseTokenPrice(tokenAddress: string): Promise<number | null> {
  try {
    type GTPoolAttrs = { base_token_price_usd?: string; reserve_in_usd?: string }
    const result = await getOrFetchCached<{ data?: Array<{ attributes: GTPoolAttrs }> }>({
      key: `geckoterminal:base:token-price:${tokenAddress.toLowerCase()}`,
      ttlMs: 120_000,
      onLog: msg => console.info(`[whale-alerts] ${msg}`),
      fetcher: async () => {
        const url = `${GT_BASE_URL}/networks/base/tokens/${tokenAddress}/pools?include=base_token,quote_token`
        const res = await fetch(url, { headers: GT_REQ_HEADERS, cache: 'no-store', signal: AbortSignal.timeout(5000) })
        if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`)
        return res.json() as Promise<{ data?: Array<{ attributes: GTPoolAttrs }> }>
      },
    })
    const pools = Array.isArray(result.data?.data) ? result.data.data : []
    if (pools.length === 0) return null
    const sorted = [...pools].sort(
      (a, b) =>
        (parseFloat(b.attributes.reserve_in_usd ?? '0') || 0) -
        (parseFloat(a.attributes.reserve_in_usd ?? '0') || 0),
    )
    const priceStr = sorted[0]?.attributes?.base_token_price_usd
    const price    = priceStr ? parseFloat(priceStr) : NaN
    return isNaN(price) || price <= 0 ? null : price
  } catch {
    return null
  }
}

// Fetch prices for multiple Base token addresses in parallel (Promise.allSettled).
async function batchFetchTokenPrices(
  addresses: string[],
): Promise<{ prices: Map<string, number>; hits: number; misses: number }> {
  const prices  = new Map<string, number>()
  const results = await Promise.allSettled(
    addresses.map(addr => fetchBaseTokenPrice(addr).then(p => ({ addr, p }))),
  )
  let hits = 0, misses = 0
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.p !== null) {
      prices.set(r.value.addr.toLowerCase(), r.value.p)
      hits++
    } else {
      misses++
    }
  }
  return { prices, hits, misses }
}

// Second enrichment pass: price rows that still have amount_usd=null
// using a pre-fetched token-price map keyed by token_address (lowercased).
function enrichRowWithTokenPrice(row: RawRow, tokenPrices: Map<string, number>): RawRow {
  if ((row.amount_usd as number | null) !== null) return row
  const addr = (row.token_address as string | null)?.toLowerCase()
  if (!addr) return row
  const amt = row.amount_token as number | null
  if (amt === null || amt <= 0) return row
  const price = tokenPrices.get(addr)
  if (price === undefined) return row
  const usd = Math.round(amt * price * 100) / 100
  return usd > 0 ? { ...row, amount_usd: usd } : row
}

type MajorPrices = { eth: number | null; btc: number | null }

// Fetch ETH and BTC prices from CoinGecko, cached for 60 s.
// Never throws — returns null prices on any failure so the feed still loads.
async function fetchMajorPrices(): Promise<MajorPrices> {
  try {
    const result = await getOrFetchCached<Record<string, { usd?: number }>>({
      key: 'whale-alerts:major-prices',
      ttlMs: 60_000,
      fetcher: async () => {
        const res = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd',
          { signal: AbortSignal.timeout(4000) },
        )
        if (!res.ok) throw new Error(`coingecko ${res.status}`)
        return res.json() as Promise<Record<string, { usd?: number }>>
      },
    })
    return {
      eth: result.data?.ethereum?.usd ?? null,
      btc: result.data?.bitcoin?.usd ?? null,
    }
  } catch {
    return { eth: null, btc: null }
  }
}

// Enrich a single raw row with a computed amount_usd where reliably known:
//   Stablecoins (USDC/USDT/DAI/USDbC)  → amount_token 1:1
//   WETH / ETH                          → amount_token × live ETH price
//   cbBTC / WBTC                        → amount_token × live BTC price
//   Everything else                     → leave amount_usd unchanged (null or DB value)
// Never overwrites an existing DB-provided amount_usd.
function enrichRowUsd(row: RawRow, prices: MajorPrices): RawRow {
  if ((row.amount_usd as number | null) !== null) return row
  const sym = ((row.token_symbol as string | null) ?? '').toUpperCase().trim()
  const amt = row.amount_token as number | null
  if (amt === null || amt <= 0) return row

  let usd: number | null = null
  if (sym === 'USDC' || sym === 'USDT' || sym === 'DAI' || sym === 'USDBC') {
    usd = amt
  } else if (sym === 'WETH' || sym === 'ETH') {
    usd = prices.eth !== null ? Math.round(amt * prices.eth * 100) / 100 : null
  } else if (sym === 'CBBTC' || sym === 'WBTC') {
    usd = prices.btc !== null ? Math.round(amt * prices.btc * 100) / 100 : null
  }

  return usd !== null ? { ...row, amount_usd: usd } : row
}


export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  let plan: 'free' | 'pro' | 'elite' = 'free'
  let settingsRowFound = false
  if (token) {
    const planData = await getCurrentUserPlanFromBearerToken(token).catch(() => null)
    if (planData) { plan = planData.plan; settingsRowFound = planData.settingsRowFound }
  }
  if (plan === 'free') return NextResponse.json({ alerts: [], error: 'Included in Pro and Elite.', rateLimited: false, planGate: { verifiedPlan: plan, requiredPlan: 'pro', settingsRowFound, planSource: token ? 'bearer_token' : 'no_token' } }, { status: 403 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const now = Date.now()
  const rk = `${ip}:${plan}`
  const rr = whaleRate.get(rk)
  if (!rr || rr.resetAt <= now) whaleRate.set(rk, { count: 1, resetAt: now + 60_000 })
  else if (rr.count >= WHALE_RATE_LIMIT[plan]) return NextResponse.json({ alerts: [], error: 'Rate limit reached. Try again shortly.', rateLimited: true }, { status: 429 })
  else rr.count += 1
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRole) {
    return emptyUnavailable('missing_supabase_env')
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRole)
    const params = req.nextUrl.searchParams

    const selectedWindow = parseWindow(params.get('window'))
    const valueRangeRaw = params.get('valueRange') ?? 'all'
    const valueRange = parseValueRange(valueRangeRaw)
    const interestingRaw = params.get('interesting') ?? 'true'
    const interestingMode = interestingRaw !== 'false'
    const type = params.get('type')?.trim() || null
    const side = params.get('side')?.trim() || null
    const severity = params.get('severity')?.trim() || null
    const limit = parseLimit(params.get('limit'))
    const cacheKey = `whale:${plan}:${selectedWindow}:${valueRangeRaw}:${interestingRaw}:${type ?? ''}:${side ?? ''}:${severity ?? ''}:${limit}`
    const cached = whaleCache.get(cacheKey)
    if (cached && cached.exp > now) return NextResponse.json(cached.payload)

    const windowStartIso = new Date(Date.now() - WINDOW_MS[selectedWindow]).toISOString()

    // Keep only meaningful token movements. A row passes if ANY branch matches:
    //   1. amount_token IS NULL  — sync rows where token amount is unknown (keep them)
    //   2. USDC with amount >= 100
    //   3. WETH or ETH with amount >= 0.01
    //   4. Any other named token with amount > 0
    //   5. Null-symbol token with amount > 0 (unknown asset, but has a real value)
    const meaningfulFilter =
      'amount_token.is.null,' +
      'and(token_symbol.eq.USDC,amount_token.gte.100),' +
      'and(token_symbol.in.(WETH,ETH),amount_token.gte.0.01),' +
      'and(token_symbol.neq.USDC,token_symbol.neq.WETH,token_symbol.neq.ETH,token_symbol.not.is.null,amount_token.gt.0),' +
      'and(token_symbol.is.null,amount_token.gt.0)'

    // Fetch more rows than the display limit so grouping still yields a full page.
    const internalLimit = Math.min(300, limit * 3)

    let query = supabase
      .from('whale_alerts')
      .select('*')
      .gte('occurred_at', windowStartIso)
      .or(meaningfulFilter)
      .order('occurred_at', { ascending: false })
      .limit(internalLimit)

    // minUsd filter is NOT applied at DB level because webhook rows have amount_usd=null
    // and enrichment (WETH×price, USDC 1:1, etc.) runs JS-side after the fetch.
    // Applying gte('amount_usd', n) in Supabase would exclude all unenriched rows.
    // filterByValueFloor() handles this correctly after enrichment.
    if (type) query = query.eq('alert_type', type)
    if (side) query = query.eq('side', side)
    if (severity) query = query.eq('severity', severity)

    // Stats queries: include token_symbol, amount_token, amount_usd so each row
    // can be enriched and value-filtered JS-side — keeping stats in sync with the feed.
    const STATS_SELECT = 'tx_hash, token_symbol, amount_token, amount_usd, token_address'

    const [alertsRes, stats15m, stats1h, stats24h, trackedCount, majorPrices] = await Promise.all([
      query,
      supabase.from('whale_alerts').select(STATS_SELECT).gte('occurred_at', new Date(Date.now() - 15 * 60 * 1000).toISOString()).or(meaningfulFilter).not('tx_hash', 'is', null).limit(5000),
      supabase.from('whale_alerts').select(STATS_SELECT).gte('occurred_at', new Date(Date.now() - WINDOW_MS['1h']).toISOString()).or(meaningfulFilter).not('tx_hash', 'is', null).limit(5000),
      supabase.from('whale_alerts').select(STATS_SELECT).gte('occurred_at', new Date(Date.now() - WINDOW_MS['24h']).toISOString()).or(meaningfulFilter).not('tx_hash', 'is', null).limit(5000),
      supabase.from('tracked_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
      fetchMajorPrices(),
    ])

    if (alertsRes.error) {
      console.error('[whale-alerts] query failed', alertsRes.error.message)
      return NextResponse.json({ error: 'Failed to load alerts.' }, { status: 500 })
    }

    // Pipeline:
    //   1a. Enrich USD JS-side (stablecoins 1:1, WETH×ETH, cbBTC×BTC)
    //   1b. Collect unknown token addresses → batch-fetch GT prices → second enrich pass
    //   2.  Group by (tx_hash, wallet_address) — sums enriched USD across legs
    //   3.  Score signal quality
    //   4.  Apply value floor / minUsd filter (JS-side, after enrichment)
    //   5.  Drop stablecoin-only dust as a secondary safety net
    //   6.  Collapse rapid repeats
    //   7.  Limit
    const step1 = ((alertsRes.data ?? []) as RawRow[]).map(row => enrichRowUsd(row, majorPrices))

    // Collect unique token_address values that still have no USD value after step 1
    // and are not already handled by enrichRowUsd. Cap at MAX_RANDOM_TOKENS.
    const randomAddresses = [
      ...new Set(
        step1
          .filter(row => {
            if ((row.amount_usd as number | null) !== null) return false
            const sym = ((row.token_symbol as string | null) ?? '').toUpperCase().trim()
            if (ENRICHED_BY_COINGECKO.has(sym)) return false
            const addr = row.token_address as string | null
            return addr != null && /^0x[a-fA-F0-9]{40}$/.test(addr)
          })
          .map(row => (row.token_address as string).toLowerCase()),
      ),
    ].slice(0, MAX_RANDOM_TOKENS)

    const { prices: tokenPrices, hits: randomTokenPriceHits, misses: randomTokenPriceMisses } =
      randomAddresses.length > 0
        ? await batchFetchTokenPrices(randomAddresses)
        : { prices: new Map<string, number>(), hits: 0, misses: 0 }

    const enriched = randomAddresses.length > 0
      ? step1.map(row => enrichRowWithTokenPrice(row, tokenPrices))
      : step1

    const scored   = groupAlertsByTx(enriched).map(row => ({
      ...row,
      signal_score: computeSignalScore(row),
      interesting_score: computeInterestScore(row),
    }))
    const { rows: valueFiltered, hiddenByFilter, hiddenAsDust } = filterByValueRange(scored, valueRange)
    const { rows: boringFiltered, hiddenAsBoring } = filterBoringAssets(valueFiltered, interestingMode)
    const deNoised = filterRoutingOnlySwaps(filterStablecoinNoise(boringFiltered)).map(applyHeadlineTokenFocus)
    const { rows: diversityCapped, cappedTokenCounts } = applyDiversityCap(deNoised)
    // Sort by interest score (non-stablecoin buys/swaps first, stablecoins last)
    const interestSorted = [...diversityCapped].sort(
      (a, b) => ((b.interesting_score as number) ?? 0) - ((a.interesting_score as number) ?? 0),
    )
    const grouped  = collapseRapidRepeats(interestSorted).slice(0, limit)

    const payload = {
      alerts: grouped,
      stats: {
        alerts15m:      countStatsFiltered(stats15m.data, majorPrices, 0, tokenPrices),
        alerts1h:       countStatsFiltered(stats1h.data,  majorPrices, 0, tokenPrices),
        alerts24h:      countStatsFiltered(stats24h.data, majorPrices, 0, tokenPrices),
        trackedWallets: trackedCount.count ?? 0,
      },
      diagnostics: {
        returnedCount:            grouped.length,
        rawCount:                 (alertsRes.data ?? []).length,
        afterTimeFilter:          (alertsRes.data ?? []).length,
        afterMinValueFilter:      valueFiltered.length,
        afterBoringFilter:        boringFiltered.length,
        rawRows:                  (alertsRes.data ?? []).length,
        afterStableRoutingFilter: deNoised.length,
        afterDiversityCap:        diversityCapped.length,
        cappedTokenCounts,
        appliedWindow:            selectedWindow,
        appliedValueRange:        valueRangeRaw,
        interestingMode,
        hiddenByFilter,
        hiddenAsDust,
        hiddenAsBoring,
        filtersActive:            { type: type ?? null, side: side ?? null, severity: severity ?? null },
        priceEnrichment:          { ethPrice: majorPrices.eth, btcPrice: majorPrices.btc },
        randomTokenPriceLookups:  randomAddresses.length,
        randomTokenPriceHits,
        randomTokenPriceMisses,
        cacheHit: false,
        providerStatus: 'ok',
        rateLimited: false,
      },
    }
    whaleCache.set(cacheKey, { exp: Date.now() + WHALE_CACHE_TTL_MS, payload })
    return NextResponse.json(payload)
  } catch (error) {
    console.error('[whale-alerts] unexpected error', error)
    return NextResponse.json({ error: 'Unexpected server error.' }, { status: 500 })
  }
}
