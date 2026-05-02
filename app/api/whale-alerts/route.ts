import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getOrFetchCached } from '@/lib/coingeckoCache'

type WindowKey = '15m' | '1h' | '6h' | '24h'
type RawRow = Record<string, unknown>

const WINDOW_MS: Record<WindowKey, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
}

function parseWindow(value: string | null): WindowKey {
  if (value === '15m' || value === '1h' || value === '6h' || value === '24h') return value
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

const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'USDbC'])

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

// Post-enrichment, post-grouping value filter.
// minUsd > 0: require known amount_usd >= minUsd.
// minUsd = 0 ("All"): apply quality floor — hide known-tiny moves, keep unpriced rows.
function filterByValueFloor(
  rows: RawRow[],
  minUsd: number,
): { rows: RawRow[]; hiddenByFilter: number; hiddenAsDust: number } {
  let hiddenByFilter = 0
  let hiddenAsDust   = 0
  const result = rows.filter(row => {
    const usd = row.amount_usd as number | null
    if (minUsd > 0) {
      if (usd === null || usd < minUsd) { hiddenByFilter++; return false }
      return true
    }
    if (!passesQualityFloor(row)) { hiddenAsDust++; return false }
    return true
  })
  return { rows: result, hiddenByFilter, hiddenAsDust }
}

// Count distinct tx_hash values from a stats query result, applying per-row enrichment
// and the same value floor used for the feed. Used for metric cards.
function countStatsFiltered(data: unknown, prices: MajorPrices, minUsd: number): number {
  type StatRow = { tx_hash: string | null; token_symbol?: string | null; amount_token?: number | null; amount_usd?: number | null }
  const rows = data as StatRow[] | null
  if (!rows || rows.length === 0) return 0
  const txHashes = new Set<string>()
  for (const r of rows) {
    const enriched = enrichRowUsd(r as RawRow, prices)
    const passes   = minUsd > 0
      ? ((enriched.amount_usd as number | null) !== null && (enriched.amount_usd as number) >= minUsd)
      : passesQualityFloor(enriched)
    if (passes && r.tx_hash) txHashes.add(r.tx_hash)
  }
  return txHashes.size
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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRole) {
    return emptyUnavailable('missing_supabase_env')
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRole)
    const params = req.nextUrl.searchParams

    const selectedWindow = parseWindow(params.get('window'))
    const minUsdRaw = params.get('minUsd')
    const minUsd = minUsdRaw && Number.isFinite(Number(minUsdRaw)) ? Number(minUsdRaw) : null
    const type = params.get('type')?.trim() || null
    const side = params.get('side')?.trim() || null
    const severity = params.get('severity')?.trim() || null
    const limit = parseLimit(params.get('limit'))

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
    const STATS_SELECT = 'tx_hash, token_symbol, amount_token, amount_usd'
    const effectiveMinUsd = minUsd ?? 0

    const [alertsRes, stats15m, stats1h, stats24h, trackedCount, majorPrices] = await Promise.all([
      query,
      supabase.from('whale_alerts').select(STATS_SELECT).gte('occurred_at', new Date(Date.now() - WINDOW_MS['15m']).toISOString()).or(meaningfulFilter).not('tx_hash', 'is', null).limit(5000),
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
    //   1. Enrich USD JS-side (USDC 1:1, WETH×ETH, cbBTC×BTC)
    //   2. Group by (tx_hash, wallet_address) — sums enriched USD across legs
    //   3. Score signal quality
    //   4. Apply value floor / minUsd filter (JS-side, after enrichment)
    //   5. Drop stablecoin-only dust as a secondary safety net
    //   6. Collapse rapid repeats
    //   7. Limit
    const enriched = ((alertsRes.data ?? []) as RawRow[]).map(row => enrichRowUsd(row, majorPrices))
    const scored   = groupAlertsByTx(enriched).map(row => ({ ...row, signal_score: computeSignalScore(row) }))
    const { rows: valueFiltered, hiddenByFilter, hiddenAsDust } = filterByValueFloor(scored, effectiveMinUsd)
    const grouped  = collapseRapidRepeats(filterStablecoinNoise(valueFiltered)).slice(0, limit)

    return NextResponse.json({
      alerts: grouped,
      stats: {
        alerts15m:      countStatsFiltered(stats15m.data, majorPrices, effectiveMinUsd),
        alerts1h:       countStatsFiltered(stats1h.data,  majorPrices, effectiveMinUsd),
        alerts24h:      countStatsFiltered(stats24h.data, majorPrices, effectiveMinUsd),
        trackedWallets: trackedCount.count ?? 0,
      },
      diagnostics: {
        returnedCount:      grouped.length,
        rawCount:           (alertsRes.data ?? []).length,
        appliedWindow:      selectedWindow,
        appliedMinUsd:      effectiveMinUsd,
        hiddenByFilter,
        hiddenAsDust,
        filtersActive:      { type: type ?? null, side: side ?? null, severity: severity ?? null },
        priceEnrichment:    { ethPrice: majorPrices.eth, btcPrice: majorPrices.btc },
      },
    })
  } catch (error) {
    console.error('[whale-alerts] unexpected error', error)
    return NextResponse.json({ error: 'Unexpected server error.' }, { status: 500 })
  }
}
