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

// Drop stablecoin-only rows with amount < 1000 (e.g. 200 USDC swaps).
// Keeps: mixed stable+non-stable pairs, rows with unknown amount (sync rows), amount >= 1000.
function filterStablecoinNoise(rows: RawRow[]): RawRow[] {
  return rows.filter(row => {
    if (!isStablecoinOnly(row.token_symbol as string | null)) return true
    const amt = row.amount_token as number | null
    return amt === null || amt >= 1000
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

// Count distinct tx_hash values in a tx_hash-only result set.
function distinctTxHashCount(data: unknown): number {
  const rows = data as { tx_hash: string | null }[] | null
  if (!rows) return 0
  return new Set(rows.map(r => r.tx_hash).filter(Boolean)).size
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

    // Only apply the minimum-usd filter when value is explicitly > 0.
    // minUsd = 0 means "All" — do not filter, which also preserves rows
    // where amount_usd IS NULL (webhook and sync rows with unknown value).
    if (minUsd !== null && minUsd > 0) query = query.gte('amount_usd', minUsd)
    if (type) query = query.eq('alert_type', type)
    if (side) query = query.eq('side', side)
    if (severity) query = query.eq('severity', severity)

    const [alertsRes, txHash15m, txHash1h, txHash24h, trackedCount, majorPrices] = await Promise.all([
      query,
      // Fetch tx_hash column only and count distinct values server-side.
      // This counts distinct on-chain transactions, not raw transfer legs.
      supabase.from('whale_alerts').select('tx_hash').gte('occurred_at', new Date(Date.now() - WINDOW_MS['15m']).toISOString()).or(meaningfulFilter).not('tx_hash', 'is', null).limit(5000),
      supabase.from('whale_alerts').select('tx_hash').gte('occurred_at', new Date(Date.now() - WINDOW_MS['1h']).toISOString()).or(meaningfulFilter).not('tx_hash', 'is', null).limit(5000),
      supabase.from('whale_alerts').select('tx_hash').gte('occurred_at', new Date(Date.now() - WINDOW_MS['24h']).toISOString()).or(meaningfulFilter).not('tx_hash', 'is', null).limit(5000),
      supabase.from('tracked_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
      fetchMajorPrices(),
    ])

    if (alertsRes.error) {
      console.error('[whale-alerts] query failed', alertsRes.error.message)
      return NextResponse.json({ error: 'Failed to load alerts.' }, { status: 500 })
    }

    // Pipeline: enrich USD → group by tx+wallet → score → filter stablecoin noise → collapse rapid repeats → limit
    // Enrichment runs before grouping so groupAlertsByTx sums real USD values.
    const enriched = ((alertsRes.data ?? []) as RawRow[]).map(row => enrichRowUsd(row, majorPrices))
    const grouped = collapseRapidRepeats(
      filterStablecoinNoise(
        groupAlertsByTx(enriched).map(row => ({
          ...row,
          signal_score: computeSignalScore(row),
        }))
      )
    ).slice(0, limit)

    return NextResponse.json({
      alerts: grouped,
      stats: {
        alerts15m:      distinctTxHashCount(txHash15m.data),
        alerts1h:       distinctTxHashCount(txHash1h.data),
        alerts24h:      distinctTxHashCount(txHash24h.data),
        trackedWallets: trackedCount.count ?? 0,
      },
      diagnostics: {
        returnedCount: grouped.length,
        rawCount:      (alertsRes.data ?? []).length,
        appliedWindow: selectedWindow,
        appliedMinUsd: minUsd ?? 0,
        filtersActive: { type: type ?? null, side: side ?? null, severity: severity ?? null },
        priceEnrichment: {
          ethPrice: majorPrices.eth,
          btcPrice: majorPrices.btc,
        },
      },
    })
  } catch (error) {
    console.error('[whale-alerts] unexpected error', error)
    return NextResponse.json({ error: 'Unexpected server error.' }, { status: 500 })
  }
}
