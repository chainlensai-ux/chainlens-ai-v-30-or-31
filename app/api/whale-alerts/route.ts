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

// ─── Wallet context enrichment ───────────────────────────────────────────────

type OnChainWalletData = { isContract: boolean | null; nativeBalanceEth: number | null; txCount: number | null }
type WalletBehavior = { alertCount24h: number; buyCount24h: number; sellCount24h: number; totalVerifiedUsd24h: number; tokenCounts: Map<string, number>; firstSeen: string | null; lastSeen: string | null }
type WalletContext = {
  address: string; shortAddress: string
  isContract: boolean | null; nativeBalanceEth: number | null; txCount: number | null
  recentActivityCount: number | null; firstSeenApprox: string | null; lastSeenApprox: string | null
  repeatedTokenCount: number; repeatedTokens: string[]
  alertCount24h: number; buyCount24h: number; sellCount24h: number; totalVerifiedUsd24h: number | null
  confidence: 'high' | 'medium' | 'low'; tags: string[]; status: 'ok' | 'partial' | 'unverified'
}

const walletOnChainCache = new Map<string, { exp: number; data: OnChainWalletData }>()
const WALLET_CTX_TTL_MS = 4 * 60 * 1000
const MAX_WALLETS_TO_ENRICH = 20

function resolveBaseRpc(): string {
  const explicit = process.env.ALCHEMY_BASE_RPC_URL ?? process.env.BASE_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_BASE_KEY ?? process.env.ALCHEMY_API_KEY
  if (key) return `https://base-mainnet.g.alchemy.com/v2/${key}`
  return 'https://mainnet.base.org'
}
const BASE_RPC_ENDPOINT = resolveBaseRpc()

async function fetchOnChainWalletData(address: string): Promise<OnChainWalletData> {
  const cached = walletOnChainCache.get(address.toLowerCase())
  if (cached && cached.exp > Date.now()) return cached.data
  let isContract: boolean | null = null
  let nativeBalanceEth: number | null = null
  let txCount: number | null = null
  try {
    const res = await fetch(BASE_RPC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_getBalance',          params: [address, 'latest'] },
        { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionCount', params: [address, 'latest'] },
        { jsonrpc: '2.0', id: 3, method: 'eth_getCode',             params: [address, 'latest'] },
      ]),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const results = (await res.json()) as Array<{ id: number; result?: string; error?: unknown }>
      for (const r of results) {
        if (!r.result || r.error) continue
        if (r.id === 1) { const wei = parseInt(r.result, 16); if (Number.isFinite(wei)) nativeBalanceEth = wei / 1e18 }
        if (r.id === 2) { const n = parseInt(r.result, 16); if (Number.isFinite(n)) txCount = n }
        if (r.id === 3) isContract = r.result !== '0x' && r.result.length > 2
      }
    }
  } catch { /* leave as null */ }
  const data: OnChainWalletData = { isContract, nativeBalanceEth, txCount }
  walletOnChainCache.set(address.toLowerCase(), { exp: Date.now() + WALLET_CTX_TTL_MS, data })
  return data
}

function buildWalletContext(address: string, beh: WalletBehavior, onChain: OnChainWalletData): WalletContext {
  const { isContract, nativeBalanceEth, txCount } = onChain
  const repeatedTokens = [...beh.tokenCounts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t)
  const repeatedTokenCount = repeatedTokens.length
  const totalVerifiedUsd24h = beh.totalVerifiedUsd24h > 0 ? beh.totalVerifiedUsd24h : null
  const hasRepeated = beh.alertCount24h >= 3 || repeatedTokenCount >= 2
  const hasVerifiedUsd = (totalVerifiedUsd24h ?? 0) > 0
  const confidence: 'high' | 'medium' | 'low' =
    (hasRepeated && hasVerifiedUsd && isContract === false) ? 'high' :
    (hasRepeated || hasVerifiedUsd) ? 'medium' : 'low'
  const tags: string[] = []
  if (isContract === true) tags.push('Contract wallet')
  if (txCount !== null && txCount < 50) tags.push('Fresh wallet')
  else if (txCount !== null && txCount >= 1000) tags.push('Active wallet')
  if (repeatedTokenCount >= 2) tags.push('Repeat flow')
  if (beh.alertCount24h >= 5) tags.push('High frequency')
  if (beh.buyCount24h === 0 && beh.sellCount24h === 0 && beh.alertCount24h > 0) tags.push('Direction unverified')
  if (txCount === null) tags.push('History limited')
  const status: 'ok' | 'partial' | 'unverified' =
    (nativeBalanceEth !== null && txCount !== null) ? 'ok' :
    (nativeBalanceEth !== null || txCount !== null) ? 'partial' : 'unverified'
  return {
    address, shortAddress: `${address.slice(0, 6)}…${address.slice(-4)}`,
    isContract, nativeBalanceEth, txCount,
    recentActivityCount: beh.alertCount24h,
    firstSeenApprox: beh.firstSeen, lastSeenApprox: beh.lastSeen,
    repeatedTokenCount, repeatedTokens,
    alertCount24h: beh.alertCount24h, buyCount24h: beh.buyCount24h, sellCount24h: beh.sellCount24h,
    totalVerifiedUsd24h, confidence, tags, status,
  }
}

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
//   skipFloor=true (feedMode=all): bypass the quality floor entirely, keep all rows.
// range: require known amount_usd within [min, max).
function filterByValueRange(
  rows: RawRow[],
  range: ValueRangeSpec,
  skipFloor = false,
): { rows: RawRow[]; hiddenByFilter: number; hiddenAsDust: number } {
  if (range === null) {
    if (skipFloor) return { rows, hiddenByFilter: 0, hiddenAsDust: 0 }
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
// Also normalizes amount_usd=0 → null (same as enrichRowUsd).
function enrichRowWithTokenPrice(row: RawRow, tokenPrices: Map<string, number>): RawRow {
  const existingUsd = row.amount_usd as number | null
  const base: RawRow = existingUsd !== null && existingUsd <= 0 ? { ...row, amount_usd: null } : row
  if ((base.amount_usd as number | null) !== null) return base
  const addr = (base.token_address as string | null)?.toLowerCase()
  if (!addr) return base
  const amt = base.amount_token as number | null
  if (amt === null || amt <= 0) return base
  const price = tokenPrices.get(addr)
  if (price === undefined) return base
  const usd = Math.round(amt * price * 100) / 100
  return usd > 0 ? { ...base, amount_usd: usd } : base
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
//   Everything else                     → leave amount_usd as null (unverified)
// DB may store amount_usd=0 for rows without verified pricing — treat as null.
function enrichRowUsd(row: RawRow, prices: MajorPrices): RawRow {
  const existingUsd = row.amount_usd as number | null
  // Normalize 0 → null: 0 is not a valid verified price, re-run enrichment
  const base: RawRow = existingUsd !== null && existingUsd <= 0 ? { ...row, amount_usd: null } : row
  if ((base.amount_usd as number | null) !== null) return base  // already has positive USD
  const sym = ((base.token_symbol as string | null) ?? '').toUpperCase().trim()
  const amt = base.amount_token as number | null
  if (amt === null || amt <= 0) return base

  let usd: number | null = null
  if (sym === 'USDC' || sym === 'USDT' || sym === 'DAI' || sym === 'USDBC') {
    usd = amt
  } else if (sym === 'WETH' || sym === 'ETH') {
    usd = prices.eth !== null ? Math.round(amt * prices.eth * 100) / 100 : null
  } else if (sym === 'CBBTC' || sym === 'WBTC') {
    usd = prices.btc !== null ? Math.round(amt * prices.btc * 100) / 100 : null
  }

  return usd !== null && usd > 0 ? { ...base, amount_usd: usd } : base
}

// ─── On-chain wallet enrichment ──────────────────────────────────────────────

type OnChainData = { isContract: boolean | null; nativeBalanceEth: number | null; txCount: number | null }
const onChainCache = new Map<string, { exp: number; data: OnChainData }>()
const ONCHAIN_TTL_MS = 4 * 60 * 1000
const MAX_WALLETS = 20

function resolveBaseRpc(): string {
  const explicit = process.env.ALCHEMY_BASE_RPC_URL ?? process.env.BASE_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_BASE_KEY ?? process.env.ALCHEMY_API_KEY
  if (key) return `https://base-mainnet.g.alchemy.com/v2/${key}`
  return 'https://mainnet.base.org'
}
const BASE_RPC = resolveBaseRpc()

async function fetchOnChain(address: string): Promise<OnChainData> {
  const cached = onChainCache.get(address.toLowerCase())
  if (cached && cached.exp > Date.now()) return cached.data
  let isContract: boolean | null = null, nativeBalanceEth: number | null = null, txCount: number | null = null
  try {
    const res = await fetch(BASE_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_getBalance',          params: [address, 'latest'] },
        { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionCount', params: [address, 'latest'] },
        { jsonrpc: '2.0', id: 3, method: 'eth_getCode',             params: [address, 'latest'] },
      ]),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const results = (await res.json()) as Array<{ id: number; result?: string; error?: unknown }>
      for (const r of results) {
        if (!r.result || r.error) continue
        if (r.id === 1) { const wei = parseInt(r.result, 16); if (Number.isFinite(wei)) nativeBalanceEth = wei / 1e18 }
        if (r.id === 2) { const n = parseInt(r.result, 16); if (Number.isFinite(n)) txCount = n }
        if (r.id === 3) isContract = r.result !== '0x' && r.result.length > 2
      }
    }
  } catch { /* leave as null */ }
  const data: OnChainData = { isContract, nativeBalanceEth, txCount }
  onChainCache.set(address.toLowerCase(), { exp: Date.now() + ONCHAIN_TTL_MS, data })
  return data
}

// ─── Wallet behavior analysis ─────────────────────────────────────────────────

type BehaviorWindow = {
  alertCount: number; verifiedUsdFlow: number | null; uniqueTokens: number
  buyCount: number; sellCount: number; unknownDirectionCount: number; repeatedTokens: string[]
}
type BehaviorType =
  | 'repeat_accumulator' | 'active_rotator' | 'fresh_wallet' | 'one_off'
  | 'seller_distribution' | 'mixed_flow' | 'contract_or_router' | 'unverified'
type WalletBehavior = {
  address: string; shortAddress: string
  windows: { h24: BehaviorWindow; d7: BehaviorWindow }
  behaviorType: BehaviorType; behaviorScore: number
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]; monitorReason: string; nextWatch: string
  isContract: boolean | null; nativeBalanceEth: number | null; txCount: number | null
}

const behaviorHistCache = new Map<string, { exp: number; rows: RawRow[] }>()
const BEHAV_HIST_TTL_MS = 4 * 60 * 1000

function buildBehaviorWindow(rows: RawRow[]): BehaviorWindow {
  const tokenCounts = new Map<string, number>()
  let buyCount = 0, sellCount = 0, unknownDir = 0, usdSum = 0, hasUsd = false
  for (const row of rows) {
    const s = (row.side as string | null)?.toLowerCase()
    if (s === 'buy') buyCount++; else if (s === 'sell') sellCount++; else unknownDir++
    const usd = row.amount_usd as number | null
    if (usd != null && usd > 0) { usdSum += usd; hasUsd = true }
    const tok = ((row.focus_token_symbol as string | null) ?? (row.token_symbol as string | null))?.split(' / ')[0]?.trim()?.toUpperCase() ?? null
    if (tok && !LOW_SIGNAL_ROUTING.has(tok)) tokenCounts.set(tok, (tokenCounts.get(tok) ?? 0) + 1)
  }
  const repeatedTokens = [...tokenCounts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t)
  return { alertCount: rows.length, verifiedUsdFlow: hasUsd ? usdSum : null, uniqueTokens: tokenCounts.size, buyCount, sellCount, unknownDirectionCount: unknownDir, repeatedTokens }
}

function deriveBehaviorType(d7: BehaviorWindow, onChain: OnChainData): BehaviorType {
  if (onChain.isContract === true) return 'contract_or_router'
  if (d7.alertCount === 0) return 'unverified'
  if (d7.alertCount === 1) return 'one_off'
  if (d7.repeatedTokens.length >= 2 && d7.buyCount >= 2 && d7.buyCount >= d7.sellCount * 2) return 'repeat_accumulator'
  if (d7.sellCount >= 2 && d7.sellCount >= d7.buyCount * 2) return 'seller_distribution'
  if (d7.uniqueTokens >= 4 && d7.alertCount >= 5) return 'active_rotator'
  if (onChain.txCount !== null && onChain.txCount < 50 && d7.alertCount < 4) return 'fresh_wallet'
  if (d7.buyCount > 0 && d7.sellCount > 0) return 'mixed_flow'
  return 'unverified'
}

function computeBehaviorScore(d7: BehaviorWindow, behaviorType: BehaviorType, onChain: OnChainData): number {
  let score = 0
  if (d7.alertCount >= 5)  score += 20
  if (d7.alertCount >= 10) score += 15
  if (d7.repeatedTokens.length >= 2) score += 15
  if ((d7.verifiedUsdFlow ?? 0) > 0)     score += 20
  if ((d7.verifiedUsdFlow ?? 0) > 10000) score += 10
  if (onChain.isContract === false) score += 10
  if ((onChain.txCount ?? 0) >= 100) score += 10
  if (d7.unknownDirectionCount > d7.alertCount * 0.6) score -= 15
  if (behaviorType === 'contract_or_router') score -= 15
  if (d7.alertCount <= 1) score -= 10
  if (d7.verifiedUsdFlow == null) score -= 10
  return Math.max(0, Math.min(100, score))
}

function buildWalletBehavior(address: string, h24Rows: RawRow[], d7Rows: RawRow[], onChain: OnChainData): WalletBehavior {
  const h24 = buildBehaviorWindow(h24Rows)
  const d7  = buildBehaviorWindow(d7Rows)
  const behaviorType = deriveBehaviorType(d7, onChain)
  const behaviorScore = computeBehaviorScore(d7, behaviorType, onChain)
  const confidence: WalletBehavior['confidence'] =
    (behaviorScore >= 60 && d7.alertCount >= 3 && (d7.verifiedUsdFlow ?? 0) > 0) ? 'high' :
    (behaviorScore >= 30 || d7.alertCount >= 2) ? 'medium' : 'low'
  const reasons: string[] = []
  if (d7.alertCount >= 3) reasons.push(`${d7.alertCount} alerts in 7d`)
  if (d7.repeatedTokens.length >= 2) reasons.push(`Repeated: ${d7.repeatedTokens.slice(0, 2).join(', ')}`)
  if ((d7.verifiedUsdFlow ?? 0) > 0) reasons.push(`~$${Math.round(d7.verifiedUsdFlow!).toLocaleString()} 7d flow`)
  if (onChain.txCount !== null) reasons.push(`${onChain.txCount.toLocaleString()} on-chain txs`)
  if (d7.unknownDirectionCount > d7.alertCount * 0.5) reasons.push('Direction mostly unverified')
  const MONITOR_REASON: Record<BehaviorType, string> = {
    repeat_accumulator:  `Repeated buy/swap into ${d7.repeatedTokens.slice(0, 2).join(' & ') || 'non-stable tokens'} over 7d with limited sell pressure`,
    active_rotator:      `High-frequency rotations across ${d7.uniqueTokens} unique tokens — early signal potential`,
    fresh_wallet:        'New or limited-history wallet with recent activity — pattern still forming',
    one_off:             'Single alert only — insufficient data to assess',
    seller_distribution: 'Sell-heavy activity — potential distribution or exit pattern',
    mixed_flow:          'Mixed buy/sell — no clear directional signal yet',
    contract_or_router:  'Detected as contract or routing address — likely automated',
    unverified:          'Behavior signal is still forming',
  }
  const NEXT_WATCH: Record<BehaviorType, string> = {
    repeat_accumulator:  `Watch if ${d7.repeatedTokens[0] ?? 'token'} activity continues or new tokens enter rotation`,
    active_rotator:      'Monitor for concentration — does rotation narrow to 1–2 tokens?',
    fresh_wallet:        'Check again in 24h — fresh wallets can signal early positioning',
    one_off:             'Gather more data over next 24h before drawing conclusions',
    seller_distribution: 'Monitor if sell clusters expand or volume accelerates',
    mixed_flow:          'Watch for directional shift — does buy or sell side dominate?',
    contract_or_router:  'No further monitoring needed unless linked to a known protocol',
    unverified:          'Gather more activity data over the next 24h window',
  }
  return {
    address, shortAddress: `${address.slice(0, 6)}…${address.slice(-4)}`,
    windows: { h24, d7 }, behaviorType, behaviorScore, confidence, reasons,
    monitorReason: MONITOR_REASON[behaviorType], nextWatch: NEXT_WATCH[behaviorType],
    isContract: onChain.isContract, nativeBalanceEth: onChain.nativeBalanceEth, txCount: onChain.txCount,
  }
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
    const debugMode = params.get('debug') === 'true'
    const type = params.get('type')?.trim() || null
    const side = params.get('side')?.trim() || null
    const severity = params.get('severity')?.trim() || null
    const limit = parseLimit(params.get('limit'))
    const cacheKey = `whale:${plan}:${selectedWindow}:${valueRangeRaw}:${interestingRaw}:${type ?? ''}:${side ?? ''}:${severity ?? ''}:${limit}`
    const bypassCache = params.has('t')
    const cached = whaleCache.get(cacheKey)
    if (!bypassCache && cached && cached.exp > now) return NextResponse.json(cached.payload, { headers: { 'Cache-Control': 'no-store' } })

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
      return NextResponse.json({ error: 'Failed to load alerts.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
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
    const { rows: valueFiltered, hiddenByFilter, hiddenAsDust } = filterByValueRange(scored, valueRange, !interestingMode)
    const { rows: boringFiltered, hiddenAsBoring } = filterBoringAssets(valueFiltered, interestingMode)
    const stableFiltered = interestingMode ? filterStablecoinNoise(boringFiltered) : boringFiltered
    const deNoised = filterRoutingOnlySwaps(stableFiltered).map(applyHeadlineTokenFocus)
    const { rows: diversityCapped, cappedTokenCounts } = applyDiversityCap(deNoised)
    // Sort by interest score (non-stablecoin buys/swaps first, stablecoins last)
    const interestSorted = [...diversityCapped].sort(
      (a, b) => ((b.interesting_score as number) ?? 0) - ((a.interesting_score as number) ?? 0),
    )
    const grouped  = collapseRapidRepeats(interestSorted).slice(0, limit)

    // ─── Wallet behavior analysis ─────────────────────────────────────────────
    const walletAddrs = [...new Set(
      grouped.map(r => (r.wallet_address as string | null)?.toLowerCase()).filter((a): a is string => !!a)
    )].slice(0, MAX_WALLETS)
    // h24 rows: derive from grouped (already in memory)
    const h24ByWallet = new Map<string, RawRow[]>()
    for (const alert of grouped) {
      const addr = (alert.wallet_address as string | null)?.toLowerCase()
      if (!addr) continue
      const list = h24ByWallet.get(addr) ?? []; list.push(alert); h24ByWallet.set(addr, list)
    }
    // d7 rows: one extra DB query for uncached wallets, select only needed columns
    const d7ByWallet = new Map<string, RawRow[]>()
    const needsHistory = walletAddrs.filter(a => { const c = behaviorHistCache.get(a); return !c || c.exp <= Date.now() })
    let historyRowsUsed = 0
    if (needsHistory.length > 0) {
      try {
        const histRes = await supabase
          .from('whale_alerts')
          .select('wallet_address, side, amount_usd, token_symbol, focus_token_symbol')
          .gte('occurred_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
          .in('wallet_address', needsHistory)
          .limit(500)
        if (!histRes.error && histRes.data) {
          historyRowsUsed = histRes.data.length
          const tempMap = new Map<string, RawRow[]>()
          for (const row of histRes.data as RawRow[]) {
            const addr = (row.wallet_address as string | null)?.toLowerCase()
            if (!addr) continue
            const list = tempMap.get(addr) ?? []; list.push(row); tempMap.set(addr, list)
          }
          for (const addr of needsHistory) behaviorHistCache.set(addr, { exp: Date.now() + BEHAV_HIST_TTL_MS, rows: tempMap.get(addr) ?? [] })
        }
      } catch { /* non-critical — falls back to h24 rows */ }
    }
    for (const addr of walletAddrs) {
      const c = behaviorHistCache.get(addr)
      d7ByWallet.set(addr, c ? c.rows : (h24ByWallet.get(addr) ?? []))
    }
    // On-chain enrichment: parallel, cached, timeout-protected
    const onChainResults = await Promise.allSettled(walletAddrs.map(addr => fetchOnChain(addr)))
    const walletBehaviorMap = new Map<string, WalletBehavior>()
    let behaviorSkippedCount = 0
    for (let i = 0; i < walletAddrs.length; i++) {
      const addr = walletAddrs[i]
      const h24Rows = h24ByWallet.get(addr) ?? []
      const d7Rows  = d7ByWallet.get(addr) ?? h24Rows
      if (h24Rows.length === 0 && d7Rows.length === 0) { behaviorSkippedCount++; continue }
      const r = onChainResults[i]
      const onChain: OnChainData = r.status === 'fulfilled' ? r.value : { isContract: null, nativeBalanceEth: null, txCount: null }
      walletBehaviorMap.set(addr, buildWalletBehavior(addr, h24Rows, d7Rows, onChain))
    }
    // Attach walletContext to alert rows
    const alertsWithContext = grouped.map(alert => {
      const addr = (alert.wallet_address as string | null)?.toLowerCase()
      const beh = addr ? walletBehaviorMap.get(addr) : undefined
      if (!beh) return alert
      return {
        ...alert,
        walletContext: {
          shortAddress: beh.shortAddress, behaviorType: beh.behaviorType,
          behaviorScore: beh.behaviorScore, confidence: beh.confidence,
          repeatedTokens: beh.windows.d7.repeatedTokens,
          alertCount24h: beh.windows.h24.alertCount, alertCount7d: beh.windows.d7.alertCount,
          verifiedUsdFlow7d: beh.windows.d7.verifiedUsdFlow,
          monitorReason: beh.monitorReason, nextWatch: beh.nextWatch,
          tags: beh.reasons.slice(0, 3), isContract: beh.isContract,
        },
      }
    })
    // Intelligence aggregate
    const tokenToWallets = new Map<string, { wallets: Set<string>; usdSum: number }>()
    for (const [, beh] of walletBehaviorMap) {
      for (const tok of beh.windows.d7.repeatedTokens) {
        const e = tokenToWallets.get(tok) ?? { wallets: new Set(), usdSum: 0 }
        e.wallets.add(beh.shortAddress); e.usdSum += beh.windows.d7.verifiedUsdFlow ?? 0
        tokenToWallets.set(tok, e)
      }
    }
    const repeatedTokenWalletMap = [...tokenToWallets.entries()]
      .map(([token, { wallets, usdSum }]) => ({ token, walletCount: wallets.size, wallets: [...wallets].slice(0, 4), totalVerifiedUsd: usdSum > 0 ? usdSum : null }))
      .sort((a, b) => b.walletCount - a.walletCount).slice(0, 8)
    const behaviorLeaders = [...walletBehaviorMap.values()]
      .filter(b => b.behaviorScore > 0 && b.behaviorType !== 'unverified' && b.behaviorType !== 'one_off')
      .sort((a, b) => b.behaviorScore - a.behaviorScore || b.windows.d7.alertCount - a.windows.d7.alertCount)
      .slice(0, 5)
      .map(b => ({
        address: b.address, shortAddress: b.shortAddress, behaviorType: b.behaviorType,
        behaviorScore: b.behaviorScore, confidence: b.confidence,
        repeatedTokens: b.windows.d7.repeatedTokens, verifiedUsdFlow24h: b.windows.h24.verifiedUsdFlow,
        alertCount24h: b.windows.h24.alertCount, alertCount7d: b.windows.d7.alertCount,
        monitorReason: b.monitorReason, nextWatch: b.nextWatch,
      }))
    const intelligence = {
      walletBehavior: { monitoredWallets: walletBehaviorMap.size, behaviorLeaders, repeatedTokenWalletMap },
    }

    const pricedCount   = grouped.filter(r => (r.amount_usd as number | null) != null && (r.amount_usd as number) > 0).length
    const unpricedCount = grouped.filter(r => (r.amount_usd as number | null) == null).length
    const zeroValueCount = grouped.filter(r => r.amount_usd === 0).length

    // ─── Wallet behavioral stats ──────────────────────────────────────────────
    const walletBehaviorMap = new Map<string, WalletBehavior>()
    for (const alert of grouped) {
      const addr = (alert.wallet_address as string | null)?.toLowerCase()
      if (!addr) continue
      const beh = walletBehaviorMap.get(addr) ?? { alertCount24h: 0, buyCount24h: 0, sellCount24h: 0, totalVerifiedUsd24h: 0, tokenCounts: new Map<string, number>(), firstSeen: null, lastSeen: null }
      beh.alertCount24h++
      const s = (alert.side as string | null)?.toLowerCase()
      if (s === 'buy') beh.buyCount24h++; if (s === 'sell') beh.sellCount24h++
      const usd = alert.amount_usd as number | null
      if (usd != null && usd > 0) beh.totalVerifiedUsd24h += usd
      const tok = ((alert.focus_token_symbol as string | null) ?? (alert.token_symbol as string | null))?.split(' / ')[0]?.trim()?.toUpperCase() ?? null
      if (tok && !LOW_SIGNAL_ROUTING.has(tok)) beh.tokenCounts.set(tok, (beh.tokenCounts.get(tok) ?? 0) + 1)
      const ts = alert.occurred_at as string | null
      if (ts) { if (!beh.lastSeen || ts > beh.lastSeen) beh.lastSeen = ts; if (!beh.firstSeen || ts < beh.firstSeen) beh.firstSeen = ts }
      walletBehaviorMap.set(addr, beh)
    }

    // ─── On-chain enrichment (max 20 wallets, cached, parallel) ─────────────
    const walletAddrs = [...walletBehaviorMap.keys()].slice(0, MAX_WALLETS_TO_ENRICH)
    let enrichCacheHits = 0, enrichFailed = 0
    const onChainSettled = await Promise.allSettled(
      walletAddrs.map(async addr => {
        const c = walletOnChainCache.get(addr)
        if (c && c.exp > Date.now()) { enrichCacheHits++; return { addr, data: c.data } }
        return { addr, data: await fetchOnChainWalletData(addr) }
      })
    )
    const walletContextMap = new Map<string, WalletContext>()
    for (const r of onChainSettled) {
      if (r.status === 'rejected') { enrichFailed++; continue }
      const beh = walletBehaviorMap.get(r.value.addr)
      if (beh) walletContextMap.set(r.value.addr, buildWalletContext(r.value.addr, beh, r.value.data))
    }
    for (const [addr, beh] of walletBehaviorMap) {
      if (!walletContextMap.has(addr)) walletContextMap.set(addr, buildWalletContext(addr, beh, { isContract: null, nativeBalanceEth: null, txCount: null }))
    }

    // ─── Attach walletContext to alerts ───────────────────────────────────────
    const alertsWithContext = grouped.map(alert => {
      const addr = (alert.wallet_address as string | null)?.toLowerCase()
      const ctx = addr ? walletContextMap.get(addr) : undefined
      return ctx ? { ...alert, walletContext: ctx } : alert
    })

    // ─── Intelligence aggregate ───────────────────────────────────────────────
    const tokenGlobalFreq = new Map<string, number>()
    for (const [, beh] of walletBehaviorMap) for (const [tok, cnt] of beh.tokenCounts) if (cnt >= 2) tokenGlobalFreq.set(tok, (tokenGlobalFreq.get(tok) ?? 0) + 1)
    const topRepeatedTokens = [...tokenGlobalFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t)
    const topWallets = [...walletContextMap.values()]
      .sort((a, b) => b.alertCount24h - a.alertCount24h || (b.totalVerifiedUsd24h ?? 0) - (a.totalVerifiedUsd24h ?? 0))
      .slice(0, 5)
      .map(ctx => ({ address: ctx.address, shortAddress: ctx.shortAddress, alertCount24h: ctx.alertCount24h, totalVerifiedUsd24h: ctx.totalVerifiedUsd24h, repeatedTokens: ctx.repeatedTokens, tags: ctx.tags, confidence: ctx.confidence }))
    const intelligence = {
      walletCount: walletBehaviorMap.size,
      activeWalletCount: [...walletBehaviorMap.values()].filter(b => b.alertCount24h >= 2).length,
      pricedAlertCount: pricedCount, unpricedAlertCount: unpricedCount,
      topRepeatedTokens, topWallets,
    }

    let debugExtra: Record<string, unknown> | null = null
    if (debugMode) {
      const rawData = (alertsRes.data ?? []) as RawRow[]
      const missingTokenAddressCount = rawData.filter(r => !(r.token_address as string | null)).length
      const missingAmountCount       = rawData.filter(r => (r.amount_token as number | null) == null).length
      const missingPriceCount        = enriched.filter(r => (r.amount_usd as number | null) == null).length
      const sampleUnpricedReasons: string[] = []
      for (const r of grouped) {
        if ((r.amount_usd as number | null) != null) continue
        if (sampleUnpricedReasons.length >= 5) break
        const sym  = ((r.token_symbol as string | null) ?? 'unknown').slice(0, 12)
        const addr = r.token_address as string | null
        const amt  = r.amount_token as number | null
        if (!addr)       sampleUnpricedReasons.push(`${sym}: no_token_address`)
        else if (amt == null) sampleUnpricedReasons.push(`${sym}: no_amount`)
        else             sampleUnpricedReasons.push(`${sym}: price_lookup_failed`)
      }
      debugExtra = { pricedCount, unpricedCount, zeroValueCount, missingTokenAddressCount, missingAmountCount, missingDecimalsCount: 0, missingPriceCount, sampleUnpricedReasons,
        behaviorDiagnostics: { walletsAnalyzed: walletBehaviorMap.size, alertHistoryRowsUsed: historyRowsUsed, historyWindowUsed: '7d', behaviorLeadersCount: behaviorLeaders.length, skippedWallets: behaviorSkippedCount } }
    }

    const payload = {
      alerts: alertsWithContext,
      intelligence,
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
        pricedCount,
        unpricedCount,
        filtersActive:            { type: type ?? null, side: side ?? null, severity: severity ?? null },
        priceEnrichment:          { ethPrice: majorPrices.eth, btcPrice: majorPrices.btc },
        randomTokenPriceLookups:  randomAddresses.length,
        randomTokenPriceHits,
        randomTokenPriceMisses,
        cacheHit: false,
        providerStatus: 'ok',
        rateLimited: false,
        ...(debugExtra ?? {}),
      },
    }
    whaleCache.set(cacheKey, { exp: Date.now() + WHALE_CACHE_TTL_MS, payload })
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[whale-alerts] unexpected error', error)
    return NextResponse.json({ error: 'Unexpected server error.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
