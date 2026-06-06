import { NextResponse } from 'next/server'
import { fetchWalletSnapshot, type WalletSnapshotOptions } from '@/lib/server/walletSnapshot'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import {
  walletScanPersistentCacheAvailable,
  readPersistentWalletCache,
  readStalePersistentWalletCache,
  writePersistentWalletCache,
  readPersistentCooldown,
  writePersistentCooldown,
} from '@/lib/server/walletScanPersistentCache'

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {}
  if (origin && origin.endsWith('.vercel.app')) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    headers['Access-Control-Max-Age'] = '86400'
  }
  return headers
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get('origin')
  return new Response(null, { status: 200, headers: corsHeaders(origin) })
}

const WALLET_BASIC_CACHE_TTL_MS  = 5  * 60 * 1000  // 5 min for basic scans
const WALLET_DEEP_CACHE_TTL_MS   = 15 * 60 * 1000  // 15 min for deep scans
const WALLET_DEEP_COOLDOWN_MS    = 10 * 60 * 1000  // 10 min cooldown per wallet after deep live scan
const WALLET_SNAPSHOT_SCHEMA_VERSION = 'v39'
const walletCache = new Map<string, { exp: number; payload: unknown; cachedAt: number }>()
const walletRate = new Map<string, { count: number; resetAt: number }>()
const WALLET_RATE_BY_PLAN: Record<string, number> = { free: 20, pro: 60, elite: 180 }

// Cost safety — historical cooldown, deep cooldown, cost hints, in-flight dedup
const WALLET_HC_COOLDOWN_MS  = 10 * 60 * 1000  // 10 min cooldown per wallet after historical live scan
const WALLET_COST_HINT_TTL_MS = 60 * 60 * 1000  // retain cost hints 1 hour
const walletHistoricalCooldown = new Map<string, number>()    // cooldownKey -> expiry timestamp
const walletDeepCooldown = new Map<string, number>()          // cacheKey -> expiry timestamp for deep scans
const walletCostHints = new Map<string, { rawLogEvents: number; requestDurationMs: number; cachedAt: number }>()
const walletDeepInFlight = new Map<string, Promise<unknown>>() // inFlightKey -> live scan promise

const WALLET_DEEP_DEBUG_ENABLED = process.env.WALLET_DEEP_DEBUG_ENABLED === 'true'

function stripUndefinedInPlace(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      if (value[i] === undefined) value.splice(i, 1)
      else stripUndefinedInPlace(value[i])
    }
    return value
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const current = (value as Record<string, unknown>)[key]
      if (current === undefined) delete (value as Record<string, unknown>)[key]
      else stripUndefinedInPlace(current)
    }
  }
  return value
}

function pruneWalletScannerDebug(payload: any, debug: boolean) {
  if (!payload || typeof payload !== 'object') return
  if (!debug) {
    const walletScannerDiagnostics = payload._debug?.walletScannerDiagnostics
    const walletFactsShapeIssues = payload._debug?.walletFactsShapeIssues
    if (walletScannerDiagnostics || walletFactsShapeIssues) {
      payload._debug = {
        ...(walletFactsShapeIssues ? { walletFactsShapeIssues } : {}),
        ...(walletScannerDiagnostics ? { walletScannerDiagnostics } : {}),
      }
    } else {
      delete payload._debug
    }
  }
  delete payload._diagnostics
  delete payload._cachedDiagnosticsSlim  // slim debug is surfaced in _debug if debug=true; always remove from payload
  stripUndefinedInPlace(payload)
}

function buildWalletModuleCoverage(snap: any) {
  const ev = snap.walletEvidenceSummary
  const sw = snap.walletSwapSummary
  const pr = snap.walletPriceEvidenceSummary
  const ls = snap.walletLotSummary
  const ts = snap.walletTradeStatsSummary
  const bh = snap.walletBehavior
  const holdingsCount: number = snap.holdingsCount ?? (snap.holdings?.length ?? 0)
  const totalUsdAvailable: boolean = snap.totalUsdAvailable !== false && (snap.totalValue ?? 0) > 0

  // Portfolio
  const portStatus = holdingsCount > 0 && totalUsdAvailable ? 'ok' : holdingsCount > 0 ? 'partial' : 'open_check'

  // Activity
  const totalEvents: number = ev?.totalEvents ?? 0
  const eventsWithHash: number = ev?.eventsWithHash ?? 0
  const eventsWithTs: number = ev?.eventsWithTimestamp ?? 0
  const hashCov = totalEvents > 0 ? eventsWithHash / totalEvents : 0
  const tsCov = totalEvents > 0 ? eventsWithTs / totalEvents : 0
  const actUnavailable = ev?.status === 'provider_unavailable' || ev?.missing?.includes('activity_provider_unavailable')
  const actStatus = actUnavailable ? 'open_check' : totalEvents > 0 && hashCov >= 0.8 && tsCov >= 0.8 ? 'ok' : totalEvents > 0 ? 'partial' : 'open_check'
  const actReason = actUnavailable ? 'provider_unavailable' : totalEvents === 0 ? 'no_activity_events' : actStatus === 'partial' ? `${totalEvents}_events_low_hash_coverage` : `${totalEvents}_events_indexed`

  // Swap detection
  const swapCandidates: number = sw?.swapCandidateCount ?? pr?.swapCandidateEvents ?? 0
  const swapStatus = swapCandidates > 0 ? (sw?.status === 'open_check' ? 'open_check' : 'ok') : totalEvents > 0 ? 'open_check' : 'open_check'
  const swapReason = swapCandidates > 0 ? `${swapCandidates}_swap_candidates_found` : totalEvents > 0 ? 'activity_found_no_swap_patterns' : 'no_activity_events'

  // Price evidence
  const pricedEvents: number = pr?.pricedEvents ?? 0
  const swapCandidateEvents: number = pr?.swapCandidateEvents ?? swapCandidates
  const priceStatus = pricedEvents > 0 ? (pr?.status ?? 'ok') : swapCandidateEvents > 0 ? 'open_check' : 'open_check'
  const priceReason = pricedEvents > 0 ? `${pricedEvents}_events_priced` : swapCandidateEvents > 0 ? 'swap_candidates_not_priced' : 'no_swap_candidates_to_price'

  // FIFO PnL
  const closedLots: number = ls?.closedLots ?? 0
  const pricedSwapEvents: number = ls?.pricedSwapEvents ?? pricedEvents
  const fifoStatus = closedLots > 0 ? (ls?.status ?? 'ok') : pricedSwapEvents > 0 ? 'open_check' : 'open_check'
  const fifoReason = closedLots > 0 ? `${closedLots}_closed_lots_matched` : pricedSwapEvents > 0 ? 'priced_events_found_no_matched_lots' : 'no_priced_swap_events'

  // Trade stats
  const tradeClosedLots: number = ts?.closedLots ?? 0
  const openedLots: number = ls?.openedLots ?? 0
  const readyForWinRate = tradeClosedLots >= 10 && ts?.economicSignificance === 'meaningful'
  const tradeStatus = readyForWinRate ? (ts?.status ?? 'ok') : tradeClosedLots > 0 ? 'partial' : openedLots > 0 ? 'partial' : 'open_check'
  const tradeReason = tradeClosedLots >= 10 ? `${tradeClosedLots}_closed_lots_ready` : tradeClosedLots > 0 ? `${tradeClosedLots}_closed_lots_below_threshold` : openedLots > 0 ? 'open_lots_tracked_no_closed_trades' : 'no_closed_lots'

  // Open position summary — derived from FIFO debug sampleOpenLots (up to 5 lots)
  const _sampleOpenLots = (snap._diagnostics?.walletLotEngineDebug?.sampleOpenLots ?? []) as Array<{ tokenAddress: string; symbol: string; chain: string; openedAt: string; amountRemaining: number; entryPriceUsd: number; confidence: string }>
  const walletOpenPositionSummary = openedLots > 0 ? (() => {
    const tokenMap = new Map<string, { symbol: string; chain: string; openLots: number; totalAmount: number; totalCostBasis: number; firstOpenedAt: string; latestOpenedAt: string }>()
    for (const lot of _sampleOpenLots) {
      const key = lot.tokenAddress.toLowerCase()
      const existing = tokenMap.get(key)
      const costBasis = lot.amountRemaining * lot.entryPriceUsd
      if (existing) {
        existing.openLots++
        existing.totalAmount += lot.amountRemaining
        existing.totalCostBasis += costBasis
        if (lot.openedAt < existing.firstOpenedAt) existing.firstOpenedAt = lot.openedAt
        if (lot.openedAt > existing.latestOpenedAt) existing.latestOpenedAt = lot.openedAt
      } else {
        tokenMap.set(key, { symbol: lot.symbol, chain: lot.chain, openLots: 1, totalAmount: lot.amountRemaining, totalCostBasis: costBasis, firstOpenedAt: lot.openedAt, latestOpenedAt: lot.openedAt })
      }
    }
    const tokens = Array.from(tokenMap.entries()).map(([addr, t]) => ({
      symbol: t.symbol, chain: t.chain, openLots: t.openLots,
      totalAmount: t.totalAmount,
      avgEntryPriceUsd: t.totalAmount > 0 ? t.totalCostBasis / t.totalAmount : null,
      totalCostBasisUsd: t.totalCostBasis,
      firstOpenedAt: t.firstOpenedAt, latestOpenedAt: t.latestOpenedAt,
    }))
    const totalOpenCostBasisUsd = tokens.reduce((s, t) => s + t.totalCostBasisUsd, 0)
    const uniqueTokens = tokenMap.size
    return {
      status: 'partial' as const,
      openLots: openedLots, uniqueTokens,
      totalOpenCostBasisUsd: totalOpenCostBasisUsd > 0 ? totalOpenCostBasisUsd : null,
      tokens, missing: [], reason: 'open_lots_tracked_no_closed_trades',
    }
  })() : null

  // Open position performance — match open lots against holdings by exact chain + contract
  const _snapHoldings: Array<{ contract?: string; symbol?: string; chain?: string | null; price?: number | null; value?: number; balance?: number }> =
    snap.holdings ?? []
  const openPositionPerformanceSummary = walletOpenPositionSummary ? (() => {
    type PerfToken = {
      symbol: string; chain: string; openLots: number
      amountRemaining: number
      avgEntryPriceUsd: number | null
      currentPriceUsd: number | null
      currentValueUsd: number | null
      costBasisUsd: number
      unrealizedPnlUsd: number | null
      unrealizedPnlPercent: number | null
    }
    // Build a symbol+chain → tokenAddress map from _sampleOpenLots for contract-based matching
    const _lotAddressMap = new Map<string, string>()
    for (const lot of _sampleOpenLots) {
      const k = `${(lot.chain ?? '').toLowerCase()}:${lot.symbol.toUpperCase()}`
      if (!_lotAddressMap.has(k)) _lotAddressMap.set(k, lot.tokenAddress.toLowerCase())
    }

    const perfTokens: PerfToken[] = walletOpenPositionSummary.tokens.map(t => {
      const lotKey = `${(t.chain ?? '').toLowerCase()}:${t.symbol.toUpperCase()}`
      const lotAddressKey = _lotAddressMap.get(lotKey) ?? null
      const matchedHolding = _snapHoldings.find(h => {
        if (!h) return false
        const hChain = (h.chain ?? '').toLowerCase()
        const tChain = (t.chain ?? '').toLowerCase()
        if (lotAddressKey && h.contract && h.contract.toLowerCase() === lotAddressKey && hChain === tChain) return true
        // fallback: same chain + same symbol (only if no contract ambiguity)
        return hChain === tChain && (h.symbol ?? '').toUpperCase() === t.symbol.toUpperCase()
      })
      const currentPriceUsd = matchedHolding?.price ?? null
      const currentValueUsd = currentPriceUsd !== null ? t.totalAmount * currentPriceUsd : null
      const costBasisUsd = t.totalCostBasisUsd
      const unrealizedPnlUsd = currentValueUsd !== null ? currentValueUsd - costBasisUsd : null
      const unrealizedPnlPercent = unrealizedPnlUsd !== null && costBasisUsd > 0 ? (unrealizedPnlUsd / costBasisUsd) * 100 : null
      return {
        symbol: t.symbol, chain: t.chain, openLots: t.openLots,
        amountRemaining: t.totalAmount,
        avgEntryPriceUsd: t.avgEntryPriceUsd,
        currentPriceUsd, currentValueUsd, costBasisUsd,
        unrealizedPnlUsd, unrealizedPnlPercent,
      }
    })
    const totalCostBasis = perfTokens.reduce((s, t) => s + t.costBasisUsd, 0)
    const matchedTokens = perfTokens.filter(t => t.currentValueUsd !== null)
    const unmatchedTokens = perfTokens.filter(t => t.currentValueUsd === null)
    const matchedTokenCount = matchedTokens.length
    const unmatchedTokenCount = unmatchedTokens.length

    // Full-coverage totals — only set when every token is matched
    const totalCurrentValueUsd = matchedTokenCount === perfTokens.length
      ? matchedTokens.reduce((s, t) => s + (t.currentValueUsd ?? 0), 0)
      : null
    const totalUnrealizedPnlUsd = totalCurrentValueUsd !== null ? totalCurrentValueUsd - totalCostBasis : null
    const totalUnrealizedPnlPercent = totalUnrealizedPnlUsd !== null && totalCostBasis > 0
      ? (totalUnrealizedPnlUsd / totalCostBasis) * 100
      : null

    // Partial-coverage matched-only aggregates
    const matchedOpenCostBasisUsd = matchedTokens.reduce((s, t) => s + t.costBasisUsd, 0)
    const matchedCurrentOpenValueUsd = matchedTokenCount > 0
      ? matchedTokens.reduce((s, t) => s + (t.currentValueUsd ?? 0), 0)
      : null
    const matchedUnrealizedPnlUsd = matchedCurrentOpenValueUsd !== null
      ? matchedCurrentOpenValueUsd - matchedOpenCostBasisUsd
      : null
    const matchedUnrealizedPnlPercent = matchedUnrealizedPnlUsd !== null && matchedOpenCostBasisUsd > 0
      ? (matchedUnrealizedPnlUsd / matchedOpenCostBasisUsd) * 100
      : null

    const coverageLabel: 'full' | 'partial' | 'cost_basis_only' =
      matchedTokenCount === perfTokens.length && perfTokens.length > 0 ? 'full'
      : matchedTokenCount > 0 ? 'partial'
      : 'cost_basis_only'

    const unmatchedSymbols = unmatchedTokens.map(t => t.symbol)

    return {
      status: 'partial' as const,
      openLots: walletOpenPositionSummary.openLots,
      uniqueTokens: walletOpenPositionSummary.uniqueTokens,
      totalOpenCostBasisUsd: totalCostBasis > 0 ? totalCostBasis : null,
      totalCurrentValueUsd,
      totalUnrealizedPnlUsd,
      totalUnrealizedPnlPercent,
      allTokensMatched: matchedTokenCount === perfTokens.length,
      matchedTokenCount,
      unmatchedTokenCount,
      matchedOpenCostBasisUsd: matchedOpenCostBasisUsd > 0 ? matchedOpenCostBasisUsd : null,
      matchedCurrentOpenValueUsd,
      matchedUnrealizedPnlUsd,
      matchedUnrealizedPnlPercent,
      coverageLabel,
      unmatchedSymbols,
      tokens: perfTokens,
    }
  })() : null

  // Behavior
  const txCount: number = bh?.txCount ?? 0
  const bhStatus = bh?.status === 'ok' && txCount > 0 ? 'ok' : bh?.status === 'ok' || bh?.status === 'partial' ? 'partial' : 'open_check'

  return {
    portfolio: { status: portStatus, evidence: holdingsCount > 0 ? ['holdings', ...(totalUsdAvailable ? ['total_value'] : [])] : [], reason: portStatus === 'ok' ? `${holdingsCount}_holdings_loaded` : portStatus === 'partial' ? 'holdings_loaded_value_incomplete' : 'no_holdings_found' },
    activity: { status: actStatus, evidence: totalEvents > 0 ? ['transfer_events', ...(hashCov >= 0.8 ? ['tx_hashes'] : []), ...(tsCov >= 0.8 ? ['timestamps'] : [])] : [], eventCount: totalEvents, reason: actReason },
    swapDetection: { status: swapStatus, evidence: swapCandidates > 0 ? ['same_tx_in_out', 'router_match', 'wallet_initiated_multi_token'] : [], candidateCount: swapCandidates, reason: swapReason },
    priceEvidence: { status: priceStatus, pricedEvents, reason: priceReason },
    fifoPnL: { status: fifoStatus, closedLots, reason: fifoReason },
    tradeStats: { status: tradeStatus, closedLots: tradeClosedLots, openedLots, readyForWinRate, reason: tradeReason },
    behavior: { status: bhStatus, reason: bhStatus === 'ok' ? 'activity_detected' : bhStatus === 'partial' ? 'limited_activity_signal' : 'no_activity_data' },
    walletOpenPositionSummary,
    openPositionPerformanceSummary,
  }
}

async function walletPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  try {
    const result = await getCurrentUserPlanFromBearerToken(token)
    const { plan, userId, settingsRowFound } = result
    console.log("planCheck", { userId, plan })
    // Defensive fallback: authenticated user with no settings row yet → treat as elite for this request
    // This prevents false-negatives for newly-subscribed users whose row hasn't propagated yet.
    if (userId && !settingsRowFound) return 'elite'
    return plan
  } catch { return 'free' }
}
function walletIp(req: Request): string { return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown' }
async function walletAllowed(req: Request): Promise<boolean> { const plan=await walletPlan(req); const key=`${plan}:${walletIp(req)}`; const now=Date.now(); const cur=walletRate.get(key); const lim=WALLET_RATE_BY_PLAN[plan]; if(!cur||cur.resetAt<=now){walletRate.set(key,{count:1,resetAt:now+60000}); return true} if(cur.count>=lim)return false; cur.count+=1; return true }

export async function POST(req: Request) {
  const _origin = req.headers.get('origin')
  const json = (data: unknown, init?: { status?: number }): Response => {
    return new Response(JSON.stringify(data), {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(_origin) },
    })
  }
  // Dev-only auth bypass: NODE_ENV check guarantees this NEVER activates in production.
  // In production NODE_ENV is always 'production' so _devBypass evaluates to false unconditionally.
  const _devBypass = process.env.NODE_ENV !== 'production' && req.headers.get('x-dev-test') === 'chainlens-local'
  const plan = _devBypass ? 'elite' : await walletPlan(req)
  if (plan === 'free') return json({ error: 'Included in Pro and Elite.' }, { status: 403 })
  if (!_devBypass && !(await walletAllowed(req))) return json({ error: "Rate limit reached. Try again shortly." }, { status: 429 })
  try {
    const startedAt = Date.now()
    const requestUrl = new URL(req.url)
    const debugRequested = requestUrl.searchParams.get('debug') === 'true'
    const debugAllowed = debugRequested && (plan === 'pro' || plan === 'elite')
    const debug = debugAllowed
    const body = await req.json()
    const address = body?.address
    const refresh = body?.refresh === true
    const chain = body?.chain === 'eth' ? 'eth' : 'base'
    const deepScan = body?.deepScan === true || body?.deepScan === 'true'
    const deepActivityFlag = body?.deepActivity === true || body?.deepActivity === 'true'
    const includeActivityFlag = body?.includeActivity === true || body?.includeActivity === 'true'
    const deepActivity = deepActivityFlag || includeActivityFlag
    const cacheMode: 'activity' | 'holdings' = (deepScan || deepActivity) ? 'activity' : 'holdings'
    const chainMode = body?.chainMode === 'base' || body?.chainMode === 'eth' || body?.chainMode === 'base_eth' || body?.chainMode === 'all_supported' ? body.chainMode : 'auto'

    // Historical coverage: ONLY when explicitly requested — debug=true no longer auto-triggers it
    const historicalCoverageRequested = (body?.historicalCoverage === true || body?.historicalCoverage === 'true') && deepActivity

    // Production page cap: max 2 in prod unless WALLET_DEEP_DEBUG_ENABLED=true, default 1
    const isProd = process.env.NODE_ENV === 'production'
    const hcPageLimit = (!isProd || WALLET_DEEP_DEBUG_ENABLED) ? 5 : 2
    const maxHistoricalPages = Math.max(1, Math.min(hcPageLimit, Number(body?.maxHistoricalPages ?? 1) || 1))
    const maxFallbackPages = debug ? Math.max(1, Math.min(3, Number(body?.maxFallbackPages ?? 2) || 2)) : 2

    const hcSuffix = historicalCoverageRequested ? `:hcv1p${maxHistoricalPages}` : ''
    const debugFresh = requestUrl.searchParams.get('debugFresh') === 'true' || body?.debugFresh === true || body?.debugFresh === 'true'
    const hasBearerToken = (req.headers.get('authorization') ?? '').startsWith('Bearer ')
    const allowDebugFresh = debugFresh && (process.env.NODE_ENV !== 'production' || hasBearerToken)
    const key = String(address ?? '').toLowerCase()
    if (!/^0x[a-fA-F0-9]{40}$/.test(key)) {
      return json({ error: 'Invalid wallet address' }, { status: 400 })
    }

    // ETH scan gating fix: force ETH into activeChains for deep/debug/activity scans.
    // walletSnapshot derives activeChains from chainMode; 'base_eth' guarantees both chains are activated.
    // Only upgrades 'auto' or 'base' — explicit 'eth', 'base_eth', or 'all_supported' already include ETH.
    // deepActivity also triggers upgrade so ETH-heavy wallets get ETH activity on activity-only scans.
    const resolvedChainMode: typeof chainMode =
      (debug || deepScan || deepActivity) && (chainMode === 'auto' || chainMode === 'base')
        ? 'base_eth'
        : chainMode

    // Historical cooldown — 10 min per wallet after a live historical scan
    const hcCooldownKey = `${key}:historical:${plan}`
    const cooldownActive = historicalCoverageRequested && (walletHistoricalCooldown.get(hcCooldownKey) ?? 0) > Date.now()

    // Cost guard — skip live re-run if previous scan was very expensive
    const costHintKey = `${key}:${cacheMode}`  // cacheMode kept for costHints (separate map)
    const costHint = walletCostHints.get(costHintKey)
    const costGuardHit = historicalCoverageRequested && !cooldownActive
      && Boolean(costHint)
      && (costHint!.rawLogEvents > 100_000 || costHint!.requestDurationMs > 25_000)
      && (Date.now() - costHint!.cachedAt < WALLET_COST_HINT_TTL_MS)

    // Effective historical coverage: only run live when not blocked by cooldown/cost guard
    const effectiveHistoricalCoverage = historicalCoverageRequested && !cooldownActive && !costGuardHit

    // Deep scan cooldown — prevents rapid repeat deep scans from burning credits
    const deepCooldownKey = `${key}:deep:${plan}`
    const deepCooldownActive = deepActivity && !effectiveHistoricalCoverage && (walletDeepCooldown.get(deepCooldownKey) ?? 0) > Date.now()

    // Stable, deterministic cache key: address + logical scan mode + chain + schema version
    // Does NOT include volatile fields (debug, refresh, request id, body order)
    const scanModeKey = effectiveHistoricalCoverage ? 'historical' : deepActivity ? 'deep' : 'basic'
    const chainKey = resolvedChainMode !== 'auto' ? resolvedChainMode : chain
    const cacheKey = `${key}:${scanModeKey}:${chainKey}:${WALLET_SNAPSHOT_SCHEMA_VERSION}${hcSuffix}`

    // Cache bypass: only explicit debugFresh bypasses — refresh=true does NOT bypass when cooldown active
    // refresh=true outside cooldown: still bypasses hot cache (user wants fresh data)
    const _cacheReadAttempted = !(allowDebugFresh || refresh)
    const cachedRaw = _cacheReadAttempted ? walletCache.get(cacheKey) : null
    // Simplified validation: cache key includes schema version (v7), so stale-schema entries
    // have different keys and need no aggressive field-based invalidation that could delete good entries
    const cached = cachedRaw ?? null

    // Determine cost mode
    type WalletScanCostMode = 'basic' | 'basic_cached' | 'deep_cached' | 'deep_live' | 'historical_cached' | 'historical_live' | 'blocked_by_cooldown' | 'blocked_by_cost_guard'
    const getCostMode = (fromCache: boolean): WalletScanCostMode => {
      if (cooldownActive) return 'blocked_by_cooldown'
      if (costGuardHit) return 'blocked_by_cost_guard'
      if (effectiveHistoricalCoverage) return fromCache ? 'historical_cached' : 'historical_live'
      if (deepActivity) return fromCache ? 'deep_cached' : 'deep_live'
      return fromCache ? 'basic_cached' : 'basic'
    }
    const getCacheNote = (mode: WalletScanCostMode, cacheAgeSeconds?: number): string | undefined => {
      if (mode === 'basic') return 'Basic scan — no deep history used.'
      if (mode === 'basic_cached') return `Basic scan served from cache${cacheAgeSeconds != null ? ` (${cacheAgeSeconds}s ago)` : ''}.`
      if (mode === 'deep_cached') return `Deep result served from cache${cacheAgeSeconds != null ? ` (${cacheAgeSeconds}s ago)` : ''}.`
      if (mode === 'historical_cached') return `Historical scan served from cache to protect API usage${cacheAgeSeconds != null ? ` (${cacheAgeSeconds}s ago)` : ''}.`
      if (mode === 'blocked_by_cooldown') return 'Enhanced scan cooling down. Try again later.'
      if (mode === 'blocked_by_cost_guard') return 'Historical scan cached due to cost guard — wallet has heavy history.'
      return undefined
    }

    if (cached && cached.exp > Date.now()) {
      const cacheAgeSeconds = Math.floor((Date.now() - cached.cachedAt) / 1000)
      const cp: any = typeof cached.payload === 'object' && cached.payload ? { ...(cached.payload as any), dataFreshness: 'cached', cacheAgeSeconds } : cached.payload
      if (cp && typeof cp === 'object') {
        const costMode = getCostMode(true)
        cp.walletScanCostMode = costMode
        const note = getCacheNote(costMode, cacheAgeSeconds)
        if (note) cp.walletScanCacheNote = note
      }
      const _deepCooldownExpiry = walletDeepCooldown.get(deepCooldownKey) ?? 0
      const _cooldownExpiresInSeconds = _deepCooldownExpiry > Date.now() ? Math.floor((_deepCooldownExpiry - Date.now()) / 1000) : null
      if (cp && typeof cp === 'object' && debug) cp._debug = {
        routeName: '/api/wallet', cacheHit: true, cacheMode,
        requestDurationMs: Date.now() - startedAt,
        walletSnapshotCache: { memoryHit: true, persistentHit: false, providerFetchNeeded: false, refreshBypassedCache: false, cacheAgeSeconds, cacheTtlSeconds: (deepActivity ? WALLET_DEEP_CACHE_TTL_MS : WALLET_BASIC_CACHE_TTL_MS) / 1000 },
        providerFlow: null,
        walletCostGuardDebug: {
          requestedDeepActivity: deepActivity,
          requestedHistoricalCoverage: historicalCoverageRequested,
          requestedMaxHistoricalPages: body?.maxHistoricalPages ?? null,
          effectiveMaxHistoricalPages: maxHistoricalPages,
          cacheKey,
          cacheHit: true,
          cooldownHit: cooldownActive,
          costGuardHit,
          inFlightDeduped: false,
          reason: 'route_cache_hit',
        },
        walletActivityRequestDebug: {
          deepActivityRequested: deepScan || deepActivity,
          deepActivityFlagSent: deepActivityFlag,
          includeActivityFlagSent: includeActivityFlag,
          deepScanFlagSent: deepScan,
          cacheMode,
          cacheKey,
          cacheKeyIncludesDeepActivity: cacheMode === 'activity',
          cacheHit: true,
          cacheAgeSeconds,
          routeAllowed: true,
          plan,
          reason: 'cache_hit',
          evidenceStatus: (cp as any).walletEvidenceSummary?.status ?? 'unknown',
          primaryActivityAttempted: false,
          primaryActivityFailed: false,
          primaryActivityStatusCode: null,
          primaryActivityErrorKind: null,
          fallbackActivityAttempted: false,
          fallbackActivityUsed: false,
          fallbackActivityReason: 'cache_hit',
          finalEvidenceStatus: (cp as any).walletEvidenceSummary?.status ?? 'unknown',
        },
        walletScanCostDebug: {
          scanId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          address: key,
          requestedDeepActivity: deepActivity,
          requestedHistoricalCoverage: historicalCoverageRequested,
          requestedMaxHistoricalPages: body?.maxHistoricalPages ?? null,
          effectiveMaxHistoricalPages: maxHistoricalPages,
          scanMode: scanModeKey,
          dataFreshness: 'cached' as const,
          cacheKey,
          cacheReadAttempted: _cacheReadAttempted,
          cacheWriteAttempted: false,
          cacheWriteSucceeded: false,
          cooldownKey: deepCooldownKey,
          cooldownHit: deepCooldownActive,
          cooldownExpiresInSeconds: _cooldownExpiresInSeconds,
          cacheBackend: 'memory' as const,
          persistentCacheReadAttempted: false,
          persistentCacheHit: false,
          persistentCacheWriteAttempted: false,
          persistentCacheWriteSucceeded: false,
          persistentCooldownReadAttempted: false,
          persistentCooldownHit: false,
          cacheMissReason: null,
          servedFromCacheReason: 'route_cache_hit',
          blockedLiveFetchReason: 'cache_hit',
          cacheHit: true,
          inFlightDeduped: false,
          providerCalls: [],
          totals: {
            liveProviderCalls: 0,
            cachedProviderCalls: 1,
            pagesFetched: 0,
            rawItems: 0,
            rawLogEvents: 0,
            normalizedEvents: 0,
            estimatedCreditUnits: 0,
            durationMs: Date.now() - startedAt,
          },
          reason: 'route_cache_hit',
        },
      }
      pruneWalletScannerDebug(cp, debug)
      return json(cp)
    }

    // Blocked by cooldown — try to serve stale cache or return a safe blocked response
    if (cooldownActive) {
      const stale = walletCache.get(cacheKey)
      if (stale) {
        const cacheAgeSeconds = Math.floor((Date.now() - stale.cachedAt) / 1000)
        const cp: any = typeof stale.payload === 'object' && stale.payload ? { ...(stale.payload as any), dataFreshness: 'cached', cacheAgeSeconds } : stale.payload
        if (cp && typeof cp === 'object') {
          cp.walletScanCostMode = 'blocked_by_cooldown'
          cp.walletScanCacheNote = 'Enhanced scan cooling down. Try again later.'
        }
        pruneWalletScannerDebug(cp, debug)
        return json(cp)
      }
      return json({ error: 'Enhanced historical scan is cooling down. Try again in a few minutes.', walletScanCostMode: 'blocked_by_cooldown' }, { status: 429 })
    }

    // Blocked by cost guard — serve from cache if available
    if (costGuardHit) {
      const stale = walletCache.get(cacheKey)
      if (stale) {
        const cacheAgeSeconds = Math.floor((Date.now() - stale.cachedAt) / 1000)
        const cp: any = typeof stale.payload === 'object' && stale.payload ? { ...(stale.payload as any), dataFreshness: 'cached', cacheAgeSeconds } : stale.payload
        if (cp && typeof cp === 'object') {
          cp.walletScanCostMode = 'blocked_by_cost_guard'
          cp.walletScanCacheNote = 'Historical scan served from cache — wallet has heavy history.'
        }
        pruneWalletScannerDebug(cp, debug)
        return json(cp)
      }
      // No cache available — fall through to live scan without historical
    }

    // Memory deep cooldown — serve stale memory cache if available, else fall through to persistent check
    if (deepCooldownActive) {
      const stale = walletCache.get(cacheKey)
      if (stale) {
        const cacheAgeSeconds = Math.floor((Date.now() - stale.cachedAt) / 1000)
        const cp: any = typeof stale.payload === 'object' && stale.payload ? { ...(stale.payload as any), dataFreshness: 'cached', cacheAgeSeconds } : stale.payload
        if (cp && typeof cp === 'object') {
          cp.walletScanCostMode = 'deep_cached'
          cp.walletScanCacheNote = 'Deep scan cooling down — serving recent result to protect API budget.'
        }
        pruneWalletScannerDebug(cp, debug)
        return json(cp)
      }
      // No memory stale — fall through to persistent cooldown check below
    }

    // Persistent cache + cooldown checks (cross-instance, survives serverless cold-starts)
    // Tracks: did we read/write the persistent store, and what happened?
    let _persistentAvailable = false
    let _persistentCacheReadAttempted = false
    let _persistentCacheHit = false
    let _persistentCooldownReadAttempted = false
    let _persistentCooldownHit = false
    let _persistentCooldownExpiresInSeconds: number | null = null
    let _persistentCacheWriteAttempted = false
    let _persistentCacheWriteSucceeded = false
    let _cacheBackend: 'memory' | 'persistent' | 'none' = 'none'
    let _cacheMissReason: string | null = null

    if (deepActivity && !cooldownActive && !costGuardHit) {
      _persistentAvailable = walletScanPersistentCacheAvailable()

      // --- Persistent cache read (same bypass rules as memory cache: skip for refresh/debugFresh) ---
      if (_cacheReadAttempted) {
        _persistentCacheReadAttempted = _persistentAvailable
        const persCache = _persistentAvailable ? await readPersistentWalletCache(cacheKey) : null

        if (persCache) {
          _persistentCacheHit = true
          _cacheBackend = 'persistent'
          // Repopulate in-memory cache + cooldown so same instance reuses them without another DB hit
          walletCache.set(cacheKey, { exp: persCache.expiresAt.getTime(), payload: persCache.payload, cachedAt: persCache.createdAt.getTime() })
          if (!deepCooldownActive) walletDeepCooldown.set(deepCooldownKey, persCache.createdAt.getTime() + WALLET_DEEP_COOLDOWN_MS)

          const cacheAgeSeconds = Math.floor((Date.now() - persCache.createdAt.getTime()) / 1000)
          const cp: any = typeof persCache.payload === 'object' && persCache.payload
            ? { ...(persCache.payload as any), dataFreshness: 'cached', cacheAgeSeconds }
            : persCache.payload
          if (cp && typeof cp === 'object') {
            const costMode = getCostMode(true)
            cp.walletScanCostMode = costMode
            const note = getCacheNote(costMode, cacheAgeSeconds)
            if (note) cp.walletScanCacheNote = note
          }
          const _dce = walletDeepCooldown.get(deepCooldownKey) ?? 0
          const _dces = _dce > Date.now() ? Math.floor((_dce - Date.now()) / 1000) : null
          if (cp && typeof cp === 'object' && debug) {
            const _slim: any = cp._cachedDiagnosticsSlim ?? {}
            cp._debug = {
              routeName: '/api/wallet', cacheHit: true, cacheMode,
              requestDurationMs: Date.now() - startedAt,
              walletSnapshotCache: { memoryHit: false, persistentHit: true, providerFetchNeeded: false, refreshBypassedCache: false, cacheAgeSeconds, cacheTtlSeconds: WALLET_DEEP_CACHE_TTL_MS / 1000 },
              providerFlow: null,
              walletScanCostDebug: {
                scanId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                address: key, scanMode: scanModeKey, dataFreshness: 'cached' as const,
                cacheKey, cacheReadAttempted: _cacheReadAttempted,
                cacheWriteAttempted: false, cacheWriteSucceeded: false,
                cooldownKey: deepCooldownKey, cooldownHit: deepCooldownActive,
                cooldownExpiresInSeconds: _dces,
                cacheBackend: 'persistent' as const,
                persistentCacheReadAttempted: true, persistentCacheHit: true,
                persistentCacheWriteAttempted: false, persistentCacheWriteSucceeded: false,
                persistentCooldownReadAttempted: false, persistentCooldownHit: false,
                cacheMissReason: null,
                servedFromCacheReason: 'persistent_cache_hit', blockedLiveFetchReason: 'persistent_cache_hit',
                cacheHit: true, inFlightDeduped: false, providerCalls: [],
                totals: { liveProviderCalls: 0, cachedProviderCalls: 1, pagesFetched: 0, rawItems: 0, rawLogEvents: 0, normalizedEvents: 0, estimatedCreditUnits: 0, durationMs: Date.now() - startedAt },
                reason: 'persistent_cache_hit',
              },
              walletPriceAtTimeDebug: _slim.walletPriceAtTimeDebug ?? null,
              unmatchedSellBackfillDebug: _slim.unmatchedSellBackfillDebug ?? null,
              ethSwapReconstructionDebug: _slim.ethSwapReconstructionDebug ?? null,
              basePnlReconstructionDebug: _slim.basePnlReconstructionDebug ?? null,
              baseFifoCoverageDebug: _slim.baseFifoCoverageDebug ?? null,
              walletActivityRoutingDebug: _slim.walletActivityRoutingDebug ?? null,
              walletChainActivityMergeDebug: _slim.walletChainActivityMergeDebug ?? null,
              walletEthNormalizationDebug: _slim.walletEthNormalizationDebug ?? null,
              baseFifoMatchDebug: _slim.baseFifoMatchDebug ?? null,
              walletCacheQualityDebug: _slim.walletCacheQualityDebug ?? null,
            }
          }
          pruneWalletScannerDebug(cp, debug)
          return json(cp)
        }
      }

      // --- Persistent cooldown check (runs even for refresh=true to prevent credit burn) ---
      _persistentCooldownReadAttempted = _persistentAvailable
      const persCooldown = _persistentAvailable ? await readPersistentCooldown(deepCooldownKey) : null
      if (persCooldown) {
        _persistentCooldownHit = true
        _persistentCooldownExpiresInSeconds = Math.floor((persCooldown.expiresAt.getTime() - Date.now()) / 1000)
        // Repopulate in-memory cooldown
        walletDeepCooldown.set(deepCooldownKey, persCooldown.expiresAt.getTime())
        // Try stale persistent cache for graceful response
        const stale = await readStalePersistentWalletCache(cacheKey)
        if (stale) {
          const cacheAgeSeconds = Math.floor((Date.now() - stale.createdAt.getTime()) / 1000)
          const cp: any = typeof stale.payload === 'object' && stale.payload
            ? { ...(stale.payload as any), dataFreshness: 'cached', cacheAgeSeconds }
            : stale.payload
          if (cp && typeof cp === 'object') {
            cp.walletScanCostMode = 'deep_cached'
            cp.walletScanCacheNote = 'Deep scan cooling down — serving recent result to protect API budget.'
          }
          pruneWalletScannerDebug(cp, debug)
          return json(cp)
        }
        return json({ error: 'Deep scan is cooling down. Try again in a few minutes.', walletScanCostMode: 'deep_cached' }, { status: 429 })
      }

      _cacheMissReason = _persistentAvailable ? 'persistent_cache_miss' : 'persistent_cache_unavailable'
    } else if (deepCooldownActive) {
      // Fell through memory cooldown with no memory stale — final 429 guard
      return json({ error: 'Deep scan is cooling down. Try again in a few minutes.', walletScanCostMode: 'deep_cached' }, { status: 429 })
    }

    // In-flight dedup for deep/historical scans
    let inFlightDeduped = false
    const inFlightKey = deepActivity ? `${key}:${scanModeKey}:${chainKey}${effectiveHistoricalCoverage ? `:hc${maxHistoricalPages}` : ''}` : ''
    let rawSnapshot: any

    const existingInFlight = inFlightKey ? walletDeepInFlight.get(inFlightKey) : undefined
    if (existingInFlight) {
      inFlightDeduped = true
      rawSnapshot = { ...(await existingInFlight as any) }
    } else {
      const scanPromise: Promise<unknown> = fetchWalletSnapshot(address ?? '', {
        refresh,
        chain,
        deepScan,
        deepActivity,
        chainMode: resolvedChainMode,
        historicalCoverage: effectiveHistoricalCoverage,
        maxHistoricalPages,
        maxFallbackPages,
      } satisfies WalletSnapshotOptions)
      if (inFlightKey) walletDeepInFlight.set(inFlightKey, scanPromise)
      try {
        rawSnapshot = { ...(await scanPromise as any) }
      } finally {
        if (inFlightKey) walletDeepInFlight.delete(inFlightKey)
      }
    }

    const snapshot: any = rawSnapshot
    const providers: any = snapshot._diagnostics?.providers ?? {}
    const snapshotCacheDebug = snapshot._diagnostics?.snapshotCache ?? null

    // Capture cost hints from diagnostics before they're deleted
    const diagRawLogEvents: number = snapshot._diagnostics?.walletHistoricalCoverageDebug?.rawLogEvents
      ?? snapshot._diagnostics?.providers?.goldrush?.rawItemCount
      ?? 0
    const diagRequestDurationMs: number = Date.now() - startedAt
    if (deepActivity && diagRawLogEvents >= 0) {
      walletCostHints.set(costHintKey, { rawLogEvents: diagRawLogEvents, requestDurationMs: diagRequestDurationMs, cachedAt: Date.now() })
    }

    // Set cooldown after a live historical scan
    if (effectiveHistoricalCoverage) {
      walletHistoricalCooldown.set(hcCooldownKey, Date.now() + WALLET_HC_COOLDOWN_MS)
    }
    // Set deep scan cooldown after a live deep scan
    if (deepActivity && !effectiveHistoricalCoverage && !inFlightDeduped) {
      walletDeepCooldown.set(deepCooldownKey, Date.now() + WALLET_DEEP_COOLDOWN_MS)
    }

    const costMode = getCostMode(false)
    const cacheNote = getCacheNote(costMode)
    snapshot.walletScanCostMode = costMode
    if (cacheNote) snapshot.walletScanCacheNote = cacheNote

    // Pre-compute cache write decision for debug observability (Map.set is synchronous, always succeeds)
    const _cacheTtlMs = deepActivity ? WALLET_DEEP_CACHE_TTL_MS : WALLET_BASIC_CACHE_TTL_MS
    const _cacheWriteAttempted = !allowDebugFresh  // write after every live scan (even refresh=true)
    const _deepCooldownExpiry = walletDeepCooldown.get(deepCooldownKey) ?? 0
    const _cooldownExpiresInSeconds = _deepCooldownExpiry > Date.now() ? Math.floor((_deepCooldownExpiry - Date.now()) / 1000) : null

    // Build module coverage from public snapshot fields (always, not just debug)
    const walletModuleCoverage = buildWalletModuleCoverage(snapshot)
    snapshot.walletModuleCoverage = walletModuleCoverage
    if (walletModuleCoverage.walletOpenPositionSummary) {
      snapshot.walletOpenPositionSummary = walletModuleCoverage.walletOpenPositionSummary
    }
    if (walletModuleCoverage.openPositionPerformanceSummary) {
      snapshot.openPositionPerformanceSummary = walletModuleCoverage.openPositionPerformanceSummary
    }

    // Cache quality gate — block writes when portfolio clearly failed while activity succeeded
    const _snapHoldingsCount = (snapshot as any).holdings?.length ?? (snapshot as any).holdingsCount ?? 0
    const _snapTotalValue = (snapshot as any).totalValue ?? 0
    const _snapActivityEvents = (snapshot as any).walletEvidenceSummary?.totalEvents ?? 0
    const _snapProviderStatus = (snapshot as any).providerStatus ?? null
    let _cacheQuality: 'good' | 'portfolio_failed' | 'activity_only' = 'good'
    let _cacheWriteBlocked = false
    let _blockedWriteReason: string | null = null
    if (_snapHoldingsCount === 0 && _snapTotalValue === 0 && _snapActivityEvents > 0) {
      _cacheQuality = 'portfolio_failed'
      _cacheWriteBlocked = true
      _blockedWriteReason = `portfolio_empty_with_${_snapActivityEvents}_activity_events`
    } else if (_snapHoldingsCount === 0 && _snapTotalValue === 0 && (_snapProviderStatus === 'failed' || _snapProviderStatus === 'partial')) {
      _cacheQuality = 'portfolio_failed'
      _cacheWriteBlocked = true
      _blockedWriteReason = `portfolio_provider_${_snapProviderStatus}`
    }

    // Persistent cache + cooldown writes — cross-instance, survives Vercel cold-starts
    if (_cacheWriteAttempted && deepActivity && !effectiveHistoricalCoverage && !inFlightDeduped && _persistentAvailable && !_cacheWriteBlocked) {
      _persistentCacheWriteAttempted = true
      const _ppayload: any = { ...snapshot }
      // Extract slim diagnostics before pruning so cached responses can surface them with debug=true
      const _lotDbgForSlim = snapshot._diagnostics?.walletLotEngineDebug ?? null
      const _priceDbgForSlim = snapshot._diagnostics?.walletPriceAtTimeDebug ?? null
      const _slimDiag: Record<string, unknown> = {
        walletPriceAtTimeDebug: _priceDbgForSlim,
        unmatchedSellBackfillDebug: snapshot._diagnostics?.unmatchedSellBackfillDebug ?? null,
        ethSwapReconstructionDebug: snapshot._diagnostics?.ethSwapReconstructionDebug ?? null,
        basePnlReconstructionDebug: snapshot._diagnostics?.basePnlReconstructionDebug ?? null,
        baseUnknownSwapReconstructionDebug: snapshot._diagnostics?.baseUnknownSwapReconstructionDebug ?? null,
        baseUnknownSwapPricingDebug: snapshot._diagnostics?.baseUnknownSwapPricingDebug ?? null,
        finalSummarySourceDebug: snapshot._diagnostics?.finalSummarySourceDebug ?? null,
        baseFifoCoverageDebug: snapshot._diagnostics?.baseFifoCoverageDebug ?? null,
        walletActivityRoutingDebug: snapshot._diagnostics?.walletActivityRoutingDebug ?? null,
        walletChainActivityMergeDebug: snapshot._diagnostics?.walletChainActivityMergeDebug ?? null,
        walletEthNormalizationDebug: snapshot._diagnostics?.walletEthNormalizationDebug ?? null,
        walletCacheQualityDebug: {
          cacheQuality: _cacheQuality, writeAllowed: !_cacheWriteBlocked,
          blockedWriteReason: _blockedWriteReason, holdingsCount: _snapHoldingsCount,
          totalValue: _snapTotalValue, activityEvents: _snapActivityEvents,
          providerStatus: _snapProviderStatus,
        },
        baseFifoMatchDebug: (_lotDbgForSlim || _priceDbgForSlim) ? {
          baseCandidateEvents: snapshot.walletSwapSummary?.swapCandidateEvents ?? 0,
          pricedEvents: snapshot.walletPriceEvidenceSummary?.pricedEvents ?? 0,
          fifoBuyEvents: _lotDbgForSlim?.buyEvents ?? 0,
          fifoSellEvents: _lotDbgForSlim?.sellEvents ?? 0,
          closedLots: _lotDbgForSlim?.closedLots ?? 0,
          openedLots: _lotDbgForSlim?.openedLots ?? 0,
          unmatchedBuys: _lotDbgForSlim?.unmatchedBuys ?? 0,
          unmatchedSells: _lotDbgForSlim?.unmatchedSells ?? 0,
          skippedUnpriced: _lotDbgForSlim?.skippedUnpricedEvents ?? 0,
          sampleUnpricedReasons: _priceDbgForSlim?.sampleUnpricedReasons ?? [],
          priceAtTimeReasons: _priceDbgForSlim?.reasons ?? [],
          fifoReasons: _lotDbgForSlim?.reasons ?? [],
        } : null,
      }
      pruneWalletScannerDebug(_ppayload, false)
      _ppayload._cachedDiagnosticsSlim = _slimDiag
      const [cacheResult] = await Promise.allSettled([
        writePersistentWalletCache(cacheKey, key, scanModeKey, chainKey, _ppayload, WALLET_DEEP_CACHE_TTL_MS),
        writePersistentCooldown(deepCooldownKey, key, chainKey, WALLET_DEEP_COOLDOWN_MS),
      ])
      _persistentCacheWriteSucceeded = cacheResult.status === 'fulfilled' && cacheResult.value === true
    }

    if (debug) {
      ;snapshot._debug = {
        routeName: '/api/wallet',
        cacheHit: false,
        goldrushUsage: {
          endpointName: 'balances_v2 + transactions_v3',
          feature: 'wallet-scanner',
          trigger: 'scan_button',
          attempted: Boolean(providers.goldrush?.configured),
          cacheHit: Boolean(snapshot._diagnostics?.snapshotCache?.memoryHit),
          deduped: false,
          statusCode: providers.goldrush?.httpStatus ?? null,
          durationMs: Date.now() - startedAt,
          failureStage: providers.goldrush?.reason || null,
          reason: providers.goldrush?.reason || null,
        },
        alchemyConfigured: Boolean(providers.alchemy?.configured),
        alchemyCallsAttempted: providers.alchemy?.behaviorAttempted ? 1 : 0,
        alchemyCallsSucceeded: Number(providers.alchemy?.transfersReturned ?? 0) > 0 ? 1 : 0,
        alchemyCallsFailed: providers.alchemy?.behaviorAttempted && Number(providers.alchemy?.transfersReturned ?? 0) === 0 ? 1 : 0,
        rpcMethodsUsed: providers.alchemy?.behaviorAttempted ? ['alchemy_getAssetTransfers'] : [],
        skippedReason: providers.alchemy?.behaviorAttempted ? null : 'alchemy_not_configured',
        requestDurationMs: Date.now() - startedAt,
        walletSnapshotCache: snapshotCacheDebug,
        providerFallback: snapshot._diagnostics?.providerFallback ?? null,
        walletProviderRouting: snapshot._diagnostics?.walletProviderRouting ?? null,
        moralisUsage: snapshot._diagnostics?.moralisUsage ?? null,
        providerFlow: snapshot._diagnostics?.providerFlow ?? null,
        chainUsage: snapshot._diagnostics?.chainUsage ?? null,
        walletTxEvidenceDebug: snapshot._diagnostics?.walletTxEvidenceDebug ?? null,
        walletSwapDetectionDebug: snapshot._diagnostics?.walletSwapDetectionDebug ?? null,
        walletPriceAtTimeDebug: snapshot._diagnostics?.walletPriceAtTimeDebug ?? null,
        unmatchedSellBackfillDebug: snapshot._diagnostics?.unmatchedSellBackfillDebug ?? null,
        walletLotEngineDebug: snapshot._diagnostics?.walletLotEngineDebug ?? null,
        walletTradeStatsDebug: snapshot._diagnostics?.walletTradeStatsDebug ?? null,
        ethSwapReconstructionDebug: snapshot._diagnostics?.ethSwapReconstructionDebug ?? null,
        basePnlReconstructionDebug: snapshot._diagnostics?.basePnlReconstructionDebug ?? null,
        baseUnknownSwapReconstructionDebug: snapshot._diagnostics?.baseUnknownSwapReconstructionDebug ?? null,
        baseUnknownSwapPricingDebug: snapshot._diagnostics?.baseUnknownSwapPricingDebug ?? null,
        finalSummarySourceDebug: snapshot._diagnostics?.finalSummarySourceDebug ?? null,
        baseFifoCoverageDebug: snapshot._diagnostics?.baseFifoCoverageDebug ?? null,
        walletActivityRoutingDebug: snapshot._diagnostics?.walletActivityRoutingDebug ?? null,
        walletChainActivityMergeDebug: snapshot._diagnostics?.walletChainActivityMergeDebug ?? null,
        walletEthNormalizationDebug: snapshot._diagnostics?.walletEthNormalizationDebug ?? null,
        walletHistoricalCoverageDebug: snapshot._diagnostics?.walletHistoricalCoverageDebug ?? null,
        walletHistoricalCandidateDebug: snapshot._diagnostics?.walletHistoricalCandidateDebug ?? null,
        walletHistoricalPricingPreviewDebug: snapshot._diagnostics?.walletHistoricalPricingPreviewDebug ?? null,
        walletHistoricalFifoPreviewDebug: snapshot._diagnostics?.walletHistoricalFifoPreviewDebug ?? null,
        walletBudgetDebug: snapshot._diagnostics?.walletBudgetDebug ?? null,
        walletFactsDebug: snapshot._diagnostics?.walletFactsDebug ?? null,
        baseFifoMatchDebug: (() => {
          const lotDbg = snapshot._diagnostics?.walletLotEngineDebug ?? null
          const priceDbg = snapshot._diagnostics?.walletPriceAtTimeDebug ?? null
          return {
            baseCandidateEvents: snapshot.walletSwapSummary?.swapCandidateEvents ?? 0,
            pricedEvents: snapshot.walletPriceEvidenceSummary?.pricedEvents ?? 0,
            fifoBuyEvents: lotDbg?.buyEvents ?? 0,
            fifoSellEvents: lotDbg?.sellEvents ?? 0,
            closedLots: lotDbg?.closedLots ?? 0,
            openedLots: lotDbg?.openedLots ?? 0,
            unmatchedBuys: lotDbg?.unmatchedBuys ?? 0,
            unmatchedSells: lotDbg?.unmatchedSells ?? 0,
            uniqueBuyTokenKeys: lotDbg?.uniqueBuyTokenKeys ?? 0,
            uniqueSellTokenKeys: lotDbg?.uniqueSellTokenKeys ?? 0,
            matchedTokenKeys: lotDbg?.matchedTokenKeys ?? 0,
            unmatchedBuyTokenKeys: lotDbg?.unmatchedBuyTokenKeys ?? [],
            unmatchedSellTokenKeys: lotDbg?.unmatchedSellTokenKeys ?? [],
            skippedUnknownSide: lotDbg?.skippedUnknownSide ?? 0,
            skippedMissingTokenKey: lotDbg?.skippedMissingFields ?? 0,
            skippedQuoteAssetOnly: lotDbg?.skippedStableQuoteAssets ?? 0,
            skippedUnpriced: lotDbg?.skippedUnpricedEvents ?? 0,
            samplePricedEvents: priceDbg?.samplePricedEvents ?? [],
            sampleBuyEvents: lotDbg?.sampleBuyEvents ?? [],
            sampleSellEvents: lotDbg?.sampleSellEvents ?? [],
            sampleClosedLots: lotDbg?.sampleClosedLots ?? [],
            sampleUnmatchedReasons: lotDbg?.sampleUnmatchedReasons ?? [],
            fifoReasons: lotDbg?.reasons ?? [],
            priceAtTimeReasons: priceDbg?.reasons ?? [],
          }
        })(),
        walletCacheQualityDebug: {
          cacheQuality: _cacheQuality,
          writeAllowed: !_cacheWriteBlocked,
          blockedWriteReason: _blockedWriteReason,
          holdingsCount: _snapHoldingsCount,
          totalValue: _snapTotalValue,
          activityEvents: _snapActivityEvents,
          providerStatus: _snapProviderStatus,
        },
        apiAudit: snapshot._diagnostics?.apiAudit ?? null,
        walletModuleCoverageRaw: {
          portfolioProvider: providers.goldrush?.configured ? 'goldrush' : providers.zerion?.configured ? 'zerion' : 'none',
          activityProvider: snapshot._diagnostics?.walletActivityFallbackDebug?.fallbackActivityProvider ?? (providers.goldrush?.configured ? 'goldrush' : 'none'),
          swapDetectionSource: 'wallet_snapshot_engine',
          priceSource: 'price_at_time_cache',
          fifoSource: 'fifo_lot_engine',
          coverage: walletModuleCoverage,
        },
        walletCostGuardDebug: {
          requestedDeepActivity: deepActivity,
          requestedHistoricalCoverage: historicalCoverageRequested,
          requestedMaxHistoricalPages: body?.maxHistoricalPages ?? null,
          effectiveMaxHistoricalPages: maxHistoricalPages,
          effectiveHistoricalCoverage,
          cacheKey,
          cacheHit: false,
          cooldownHit: cooldownActive,
          costGuardHit,
          inFlightDeduped,
          previousCostHint: costHint ? { rawLogEvents: costHint.rawLogEvents, requestDurationMs: costHint.requestDurationMs } : null,
          reason: costGuardHit ? 'historical_scan_cached_due_to_cost_guard' : cooldownActive ? 'historical_scan_cached_due_to_cooldown' : null,
        },
        walletActivityRequestDebug: {
          deepActivityRequested: deepActivity || deepScan,
          deepActivityFlagSent: deepActivityFlag,
          includeActivityFlagSent: includeActivityFlag,
          deepScanFlagSent: deepScan,
          cacheMode,
          cacheKey,
          cacheKeyIncludesDeepActivity: cacheMode === 'activity',
          cacheHit: false,
          cacheAgeSeconds: null,
          deepActivityAllowed: true,
          routeAllowed: true,
          plan,
          routeMethod: 'POST /api/wallet',
          fetchedPnlEvents: snapshot.walletEvidenceSummary?.totalEvents ?? 0,
          fetchedEvidenceEvents: snapshot.walletEvidenceSummary?.eventsWithHash ?? 0,
          evidenceStatus: snapshot.walletEvidenceSummary?.status ?? 'unknown',
          primaryActivityAttempted: snapshot._diagnostics?.walletActivityRequestDebug?.primaryActivityAttempted ?? false,
          primaryActivityFailed: snapshot._diagnostics?.walletActivityRequestDebug?.primaryActivityFailed ?? false,
          primaryActivityStatusCode: snapshot._diagnostics?.walletActivityRequestDebug?.primaryActivityStatusCode ?? null,
          primaryActivityErrorKind: snapshot._diagnostics?.walletActivityRequestDebug?.primaryActivityErrorKind ?? null,
          fallbackActivityAttempted: snapshot._diagnostics?.walletActivityRequestDebug?.fallbackActivityAttempted ?? false,
          fallbackActivityUsed: snapshot._diagnostics?.walletActivityRequestDebug?.fallbackActivityUsed ?? false,
          fallbackActivityReason: snapshot._diagnostics?.walletActivityRequestDebug?.fallbackActivityReason ?? 'not_wired',
          finalEvidenceStatus: snapshot._diagnostics?.walletActivityRequestDebug?.finalEvidenceStatus ?? snapshot.walletEvidenceSummary?.status ?? 'unknown',
          reason: (deepActivity || deepScan) ? null : 'deep_activity_not_requested',
          // Activity fallback telemetry (populated when primary providers returned nothing)
          ...(() => {
            const fb = snapshot._diagnostics?.walletActivityFallbackDebug
            if (!fb) return {}
            return {
              primaryActivityAttempted: fb.primaryActivityAttempted,
              primaryActivityFailed: fb.primaryActivityFailed,
              primaryActivityStatusCode: fb.primaryActivityStatusCode,
              primaryActivityErrorKind: fb.primaryActivityErrorKind,
              fallbackActivityAttempted: fb.fallbackActivityAttempted,
              fallbackActivityUsed: fb.fallbackActivityUsed,
              fallbackActivityProvider: fb.fallbackActivityProvider,
              fallbackActivityStatusCode: fb.fallbackActivityStatusCode,
              fallbackActivityRawCount: fb.fallbackActivityRawCount,
              fallbackActivityNormalizedEvents: fb.fallbackActivityNormalizedEvents,
              fallbackActivityReason: fb.fallbackActivityReason,
              finalEvidenceStatus: fb.finalEvidenceStatus,
              fallbackActivitySampleShape: fb.fallbackActivitySampleShape ?? null,
              fallbackNormalizationDebug: fb.fallbackNormalizationDebug ?? null,
              fallbackPagesAttempted: fb.fallbackPagesAttempted,
              fallbackPagesUsed: fb.fallbackPagesUsed,
              fallbackCursorsSeen: fb.fallbackCursorsSeen,
              fallbackRawTotal: fb.fallbackRawTotal,
              fallbackNormalizedTotal: fb.fallbackNormalizedTotal,
              fallbackDedupeRemoved: fb.fallbackDedupeRemoved,
              fallbackPaginationReason: fb.fallbackPaginationReason,
              fallbackPaginationStoppedReason: fb.fallbackPaginationStoppedReason,
              fallbackClosedLotsAfterPage1: fb.fallbackClosedLotsAfterPage1,
              fallbackClosedCostBasisAfterPage1: fb.fallbackClosedCostBasisAfterPage1 ?? null,
              fallbackRealizedPnlAfterPage1: fb.fallbackRealizedPnlAfterPage1 ?? null,
              fallbackMeaningfulEvidenceReached: fb.fallbackMeaningfulEvidenceReached,
              fallbackMeaningfulEvidenceReason: fb.fallbackMeaningfulEvidenceReason,
            }
          })(),
        },
        walletScanCostDebug: (() => {
          const hcDbg = snapshot._diagnostics?.walletHistoricalCoverageDebug ?? null
          const hcSum = snapshot.walletHistoricalCoverageSummary ?? null
          const grConf = Boolean(providers.goldrush?.configured)
          const grCache = Boolean(snapshotCacheDebug?.memoryHit)
          const alchAtt = Boolean(providers.alchemy?.behaviorAttempted)
          const txPg: number = hcSum?.pagesAttempted ?? (deepActivity ? 1 : 0)
          type PC = { provider: string; endpointName: string; attempted: boolean; cacheHit: boolean; statusCode?: number | null; durationMs?: number | null; pagesFetched?: number | null; rawItems?: number | null; rawLogEvents?: number | null; normalizedEvents?: number | null; estimatedCreditUnits?: number | null; failureKind?: string | null; reason?: string | null }
          const calls: PC[] = []
          const activityDbg = snapshot._diagnostics?.walletActivityRequestDebug ?? null
          const grFailureKind = activityDbg?.primaryActivityFailed ? activityDbg.primaryActivityErrorKind ?? 'fetch_failed' : null
          const grReason = activityDbg?.primaryActivityFailed ? 'primary_activity_failed' : null
          const grStatusCode = activityDbg?.primaryActivityFailed ? null : providers.goldrush?.httpStatus ?? null
          const grCredits = (inFlightDeduped || grCache) ? 0 : activityDbg?.primaryActivityFailed ? 1 : grConf ? (1 + (deepActivity ? txPg : 0)) : 0
          calls.push({ provider: 'goldrush', endpointName: deepActivity ? 'balances_v2 + transactions_v3' : 'balances_v2', attempted: grConf, cacheHit: grCache, statusCode: grStatusCode, durationMs: null, pagesFetched: deepActivity ? txPg : null, rawItems: providers.goldrush?.rawItemCount ?? null, rawLogEvents: null, normalizedEvents: providers.goldrush?.normalizedEventCount ?? null, estimatedCreditUnits: grCredits, failureKind: grFailureKind, reason: grReason })
          if (effectiveHistoricalCoverage) {
            const hcPg: number = hcSum?.pagesAttempted ?? maxHistoricalPages
            calls.push({ provider: 'goldrush', endpointName: 'log_events_by_address (historical)', attempted: true, cacheHit: false, statusCode: null, durationMs: null, pagesFetched: hcPg, rawItems: null, rawLogEvents: hcDbg?.rawLogEvents ?? hcSum?.rawLogEvents ?? null, normalizedEvents: hcDbg?.normalizedEvents ?? hcSum?.normalizedEvents ?? null, estimatedCreditUnits: inFlightDeduped ? 0 : hcPg })
          }
          if (alchAtt) {
            calls.push({ provider: 'alchemy', endpointName: 'alchemy_getAssetTransfers', attempted: true, cacheHit: false, statusCode: null, durationMs: null, pagesFetched: null, rawItems: providers.alchemy?.transfersReturned ?? null, rawLogEvents: null, normalizedEvents: null, estimatedCreditUnits: inFlightDeduped ? 0 : 1 })
          }
          // Moralis activity fallback calls — one entry per page attempted
          const fbDbg = snapshot._diagnostics?.walletActivityFallbackDebug ?? null
          if (fbDbg?.fallbackActivityAttempted && fbDbg.fallbackActivityProvider === 'moralis') {
            const fbPages: number = (fbDbg as any).fallbackPagesAttempted ?? 1
            for (let pg = 1; pg <= fbPages; pg++) {
              const isPage1 = pg === 1
              const pgRaw = isPage1 ? fbDbg.fallbackActivityRawCount : null
              const pgNorm = isPage1 ? fbDbg.fallbackActivityNormalizedEvents : null
              const pgCache = isPage1 ? (fbDbg.fallbackActivityStatusCode === null && fbDbg.fallbackActivityRawCount > 0) : false
              calls.push({ provider: 'activity_fallback', endpointName: `erc20_transfers_page${pg}`, attempted: true, cacheHit: pgCache, statusCode: isPage1 ? fbDbg.fallbackActivityStatusCode : null, durationMs: null, pagesFetched: 1, rawItems: pgRaw, rawLogEvents: null, normalizedEvents: pgNorm, estimatedCreditUnits: inFlightDeduped || pgCache ? 0 : 1 })
            }
          }
          const totalCu = calls.reduce((s, c) => s + (c.estimatedCreditUnits ?? 0), 0)
          const liveCalls = inFlightDeduped ? 0 : calls.filter(c => c.attempted && !c.cacheHit).length
          const cachedCalls = calls.filter(c => c.cacheHit).length
          return {
            scanId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            address: key,
            requestedDeepActivity: deepActivity,
            requestedHistoricalCoverage: historicalCoverageRequested,
            requestedMaxHistoricalPages: body?.maxHistoricalPages ?? null,
            effectiveMaxHistoricalPages: maxHistoricalPages,
            scanMode: scanModeKey,
            dataFreshness: 'live' as const,
            cacheKey,
            cacheReadAttempted: _cacheReadAttempted,
            cacheWriteAttempted: _cacheWriteAttempted,
            cacheWriteSucceeded: _cacheWriteAttempted && (_persistentCacheWriteSucceeded || !_persistentAvailable),
            cooldownKey: deepCooldownKey,
            cooldownHit: deepCooldownActive,
            cooldownExpiresInSeconds: _cooldownExpiresInSeconds,
            cacheBackend: _cacheBackend,
            persistentCacheReadAttempted: _persistentCacheReadAttempted,
            persistentCacheHit: _persistentCacheHit,
            persistentCacheWriteAttempted: _persistentCacheWriteAttempted,
            persistentCacheWriteSucceeded: _persistentCacheWriteSucceeded,
            persistentCooldownReadAttempted: _persistentCooldownReadAttempted,
            persistentCooldownHit: _persistentCooldownHit,
            cacheMissReason: _cacheMissReason,
            servedFromCacheReason: null,
            blockedLiveFetchReason: null,
            cacheHit: false,
            inFlightDeduped,
            providerCalls: calls,
            totals: {
              liveProviderCalls: liveCalls,
              cachedProviderCalls: cachedCalls,
              pagesFetched: calls.reduce((s, c) => s + (c.pagesFetched ?? 0), 0),
              rawItems: calls.reduce((s, c) => s + (c.rawItems ?? 0), 0),
              rawLogEvents: calls.reduce((s, c) => s + (c.rawLogEvents ?? 0), 0),
              normalizedEvents: calls.reduce((s, c) => s + (c.normalizedEvents ?? 0), 0),
              estimatedCreditUnits: totalCu,
              durationMs: Date.now() - startedAt,
            },
            reason: null,
          }
        })(),
      }
    }
    if (!debug) {
      ;snapshot.providerUsed = 'holdings_layer'
      ;snapshot.portfolioSource = 'portfolio_layer'
      ;snapshot.behaviorSource = snapshot.behaviorSource === 'unavailable' ? 'unavailable' : 'activity_layer'
      ;snapshot.pnlSource = snapshot.pnlSource === 'unavailable' ? 'unavailable' : 'activity_layer'
    }
    const _budgetDbg = (snapshot._diagnostics as any)?.walletBudgetDebug
    if (_budgetDbg?.budgetCapped) {
      snapshot.walletScanBudgetNote = `Activity scan capped at ${_budgetDbg.capLimit} events (${_budgetDbg.dedupRemoved} duplicates removed from ${_budgetDbg.eventsBefore} raw).`
    }
    pruneWalletScannerDebug(snapshot, debug)
    // Write to cache after every live scan (including refresh=true) so subsequent normal requests benefit.
    // Only allowDebugFresh (explicit admin override) or a poisoned result skips the write.
    if (_cacheWriteAttempted && !_cacheWriteBlocked) walletCache.set(cacheKey, { exp: Date.now() + _cacheTtlMs, payload: snapshot, cachedAt: Date.now() })
    return json(snapshot)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Wallet scan failed'
    const status = msg === 'Invalid wallet address' ? 400 : 500
    return json({ error: status === 400 ? 'Invalid wallet address' : 'Wallet scan unavailable right now.' }, { status })
  }
}
