import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { buildPumpIntelligenceReport, type PumpAlertInput, type WhaleAlertRow, type DexScreenerMarketEvidence } from '@/lib/server/pumpIntelligence'
import { fetchDexScreenerPairMomentum, computeSnapshotChange14d, getLatestPumpSnapshot, type PumpChainSlug } from '@/lib/server/pump14dEvidence'
import { fetchGoldRushHolderCount, fetchGoldRushConcentration } from '@/lib/server/goldrushHolderCount'

// WRONG-CHAIN GUARD, DISCLOSED (hard rule: "Do NOT use wrong-chain pools"): DexScreener's own
// chainId string per chain slug this route supports — a fetched pair's chainId must match before any
// of its data (buys/sells/market cap) is trusted. Robinhood Chain isn't indexed by DexScreener at
// all, same honest gap already established for CoinGecko elsewhere in this codebase.
const DEXSCREENER_CHAIN_ID: Partial<Record<PumpChainSlug, string>> = { base: 'base', eth: 'ethereum' }

export const dynamic = 'force-dynamic'

// PUMP-INTELLIGENCE-REPORT, DISCLOSED: gated at Pro/Elite because its wallet-intelligence section
// reads the same whale_alerts feed as /api/whale-alerts, which is itself Pro/Elite-gated — a Free
// user could otherwise see whale data through this route that the whale-alerts route deliberately
// withholds from them.
const INTEL_RATE_LIMIT: Record<'free' | 'pro' | 'elite', number> = { free: 0, pro: 12, elite: 30 }
const intelRate = new Map<string, { count: number; resetAt: number }>()

function getIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const contract = (searchParams.get('contract') ?? '').trim()
  const rawChain = (searchParams.get('chain') ?? 'base').trim().toLowerCase()
  if (rawChain !== 'base' && rawChain !== 'eth' && rawChain !== 'robinhood') {
    return NextResponse.json({ error: 'Unsupported chain.' }, { status: 400 })
  }
  const chain: PumpChainSlug = rawChain
  if (!contract) return NextResponse.json({ error: 'contract is required' }, { status: 400 })

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  let plan: 'free' | 'pro' | 'elite' = 'free'
  let userEmail: string | null = null
  if (token) {
    const planData = await getCurrentUserPlanFromBearerToken(token).catch(() => null)
    if (planData) { plan = planData.plan; userEmail = planData.email }
  }
  if (plan === 'free') {
    return NextResponse.json({ error: 'Pump Intelligence Reports are included in Pro and Elite.' }, { status: 403 })
  }

  const ip = getIp(req)
  const rk = `${ip}:${plan}`
  const now = Date.now()
  const rr = intelRate.get(rk)
  if (!rr || rr.resetAt <= now) intelRate.set(rk, { count: 1, resetAt: now + 60_000 })
  else if (rr.count >= INTEL_RATE_LIMIT[plan]) {
    return NextResponse.json({ error: 'Rate limit reached. Try again shortly.' }, { status: 429 })
  } else rr.count += 1

  // Alert snapshot fields the client already has (from the pump-alerts list) — used as a fallback
  // if the fresh /api/token call below fails, so the report can still render its price/volume/
  // liquidity context rather than showing nothing.
  // REQUIRED-DATA-FLOW FIX, DISCLOSED (requested: "Report must seed from Pump Alert card payload
  // first"). Two real bugs fixed here: (1) the Pump Alerts card only ever sends `change14d` in its
  // query string (see openReport() in page.tsx) — this route was reading `change7d`, a param that
  // never existed, so the "gate" change was ALWAYS unavailable regardless of what the card actually
  // had. (2) change6h/change1h/marketCapUsd/tokenAgeDays/pairAddress/evidenceGrade were on the card
  // but never read at all, so momentum/continuation/pullback had none of that live evidence to work
  // from. All of it is now read straight from the alert payload the card already sent.
  const alertPayloadReceived = searchParams.has('change24h') || searchParams.has('priceUsd')
  const alert: PumpAlertInput = {
    symbol: searchParams.get('symbol') ?? '?',
    name: searchParams.get('name') ?? 'Unknown',
    contract,
    priceUsd: numOrNull(searchParams.get('priceUsd')),
    change24h: numOrNull(searchParams.get('change24h')),
    change7d: numOrNull(searchParams.get('change14d')) ?? numOrNull(searchParams.get('change7d')),
    change6h: numOrNull(searchParams.get('change6h')),
    change1h: numOrNull(searchParams.get('change1h')),
    volume24hUsd: numOrNull(searchParams.get('volume24hUsd')),
    liquidityUsd: numOrNull(searchParams.get('liquidityUsd')),
    fdvUsd: numOrNull(searchParams.get('fdvUsd')),
    marketCapUsd: numOrNull(searchParams.get('marketCapUsd')),
    tokenAgeDays: numOrNull(searchParams.get('tokenAgeDays')),
    pairAddress: searchParams.get('pairAddress') || null,
    evidenceGrade: (searchParams.get('evidenceGrade') as PumpAlertInput['evidenceGrade']) || null,
    reason: searchParams.get('reason') ?? 'Flagged by pump detection.',
    riskLevel: (searchParams.get('riskLevel') as PumpAlertInput['riskLevel']) ?? 'MEDIUM',
  }

  // ── Enrich in parallel: CORTEX analysis (/api/token), DexScreener pair (txns/marketCap), and an
  // internal-snapshot 14d change when the alert didn't already carry an exact figure. Each is
  // independently best-effort — one failing never blocks the others or blanks the report. ──────────
  const origin = new URL(req.url).origin
  let tokenScannerAttempted = false
  let dexScreenerAttempted = false
  let dexScreenerSucceeded = false
  let snapshotsAttempted = false
  let snapshotsSucceeded = false

  const tokenAnalysisPromise: Promise<Record<string, unknown> | null> = (async () => {
    tokenScannerAttempted = true
    try {
      const tokenRes = await fetch(`${origin}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ contract, chain }),
        signal: AbortSignal.timeout(20_000),
        cache: 'no-store',
      })
      if (!tokenRes.ok) return null
      const json = await tokenRes.json()
      return json?.error ? null : json
    } catch { return null }
  })()

  // RELIABLE-MARKET-CAP FIX, DISCLOSED (requested: "Market Cap sometimes appears... it must be
  // reliable and always attempt every supported source before showing unavailable" — buys/sells/
  // transactions still showing "Provider unavailable" too). Root cause found auditing
  // fetchDexScreenerPairMomentum: the request URL never included a chain segment (DexScreener's real
  // endpoint is /latest/dex/pairs/{chainId}/{pairId}, not /latest/dex/pairs/{pairId}), AND a separate
  // operator-precedence bug in the response parser meant every SUCCESSFUL response was being thrown
  // away and treated as a failure (see the disclosure on fetchDexScreenerPairMomentumOnce in
  // pump14dEvidence.ts for the exact bug). Both are fixed there; this call site now also pulls the
  // FULL market evidence (marketCap, fdv, liquidity, volume/price-change per window, pairCreatedAt) —
  // not just buys/sells — so the report can resolve Market Cap from a second real source instead of
  // only ever trusting whatever the alert card already had.
  const dexScreenerPromise: Promise<DexScreenerMarketEvidence | null> = (async () => {
    if (!alert.pairAddress) return null
    const expectedChainId = DEXSCREENER_CHAIN_ID[chain as PumpChainSlug]
    if (!expectedChainId) return null // Robinhood Chain isn't indexed by DexScreener — honest skip.
    dexScreenerAttempted = true
    try {
      const ac = new AbortController()
      const tid = setTimeout(() => ac.abort(), 8_000)
      const result = await fetchDexScreenerPairMomentum(chain as PumpChainSlug, alert.pairAddress, ac.signal)
      clearTimeout(tid)
      if (!result?.ok || !result.data) return null
      // WRONG-CHAIN GUARD, DISCLOSED: reject the pair outright if DexScreener's own chainId doesn't
      // match the chain this report was opened for — never trust cross-chain data by pair-address
      // coincidence, even now that the request itself is chain-scoped.
      if (result.data.chainId && result.data.chainId !== expectedChainId) return null
      dexScreenerSucceeded = true
      return {
        priceUsd: result.data.priceUsd ?? null,
        marketCapUsd: result.data.marketCapUsd ?? null,
        fdvUsd: result.data.fdvUsd ?? null,
        liquidityUsd: result.data.liquidityUsd ?? null,
        volume24hUsd: result.data.volume24hUsd ?? null,
        volume6hUsd: result.data.volume6hUsd ?? null,
        volume1hUsd: result.data.volume1hUsd ?? null,
        priceChange24hPct: result.data.priceChange24hPct ?? null,
        priceChange6hPct: result.data.priceChange6hPct ?? null,
        priceChange1hPct: result.data.priceChange1hPct ?? null,
        buys24h: result.data.buys24h ?? null, sells24h: result.data.sells24h ?? null,
        buys6h: result.data.buys6h ?? null, sells6h: result.data.sells6h ?? null,
        buys1h: result.data.buys1h ?? null, sells1h: result.data.sells1h ?? null,
        pairCreatedAt: result.data.pairCreatedAt ?? null,
      }
    } catch { return null }
  })()

  const snapshotPromise: Promise<number | null> = (async () => {
    if (alert.change7d != null) return null // Already have an exact figure from the alert — no need.
    snapshotsAttempted = true
    try {
      const snap = await computeSnapshotChange14d(chain as PumpChainSlug, contract)
      if (snap.changePct != null) snapshotsSucceeded = true
      return snap.changePct
    } catch { return null }
  })()

  // MARKET-CAP FALLBACK TIER 6, DISCLOSED (requested order: "Internal cached token scan / pump
  // snapshot" as the last real source before showing Unavailable). Always attempted in parallel —
  // cheap (in-memory or a single indexed Supabase read) — and only actually used downstream when
  // every earlier tier (alert payload, DexScreener, Token Scanner) came back empty.
  const latestSnapshotPromise = getLatestPumpSnapshot(chain as PumpChainSlug, contract).catch(() => null)

  // HOLDER-EVIDENCE-ENRICHMENT, DISCLOSED (spec: "Holders/Top holder/Top 10 holders" had zero
  // fallback in this route — sourced exclusively from Token Scanner's /api/token call, so any Token
  // Scanner failure/timeout took all three straight to a bare "Unavailable" with no attempt at the
  // same GoldRush holder module Base Radar already relies on (lib/server/goldrushHolderCount.ts).
  // GoldRush only covers 'base'/'robinhood' — 'eth' is honestly reported as chain-unsupported rather
  // than retried against a provider that doesn't cover it.
  const holderProviderChainSupported = chain === 'base' || chain === 'robinhood'
  let holderProviderAttempted = false
  let holderProviderSucceeded = false
  const holderPromise: Promise<{ count: number | null; countCapped: boolean; top1: number | null; top10: number | null }> = (async () => {
    if (!holderProviderChainSupported) return { count: null, countCapped: false, top1: null, top10: null }
    holderProviderAttempted = true
    try {
      const [countResult, concentrationResult] = await Promise.all([
        fetchGoldRushHolderCount(contract, chain as 'base' | 'robinhood'),
        fetchGoldRushConcentration(contract, chain as 'base' | 'robinhood'),
      ])
      if (countResult.count != null || concentrationResult.top1 != null || concentrationResult.top10 != null) holderProviderSucceeded = true
      return {
        count: countResult.count, countCapped: countResult.isCapped ?? false,
        top1: concentrationResult.top1, top10: concentrationResult.top10,
      }
    } catch { return { count: null, countCapped: false, top1: null, top10: null } }
  })()

  const [tokenAnalysisResult, dexScreenerMarket, snapshotChange14d, latestSnapshot, holderProviderResult] = await Promise.all([
    tokenAnalysisPromise, dexScreenerPromise, snapshotPromise, latestSnapshotPromise, holderPromise,
  ])
  const tokenAnalysis = tokenAnalysisResult
  if (tokenAnalysis) {
    // Use the fresher, authoritative values from the live scan when present.
    if (tokenAnalysis.symbol) alert.symbol = tokenAnalysis.symbol as string
    if (tokenAnalysis.name) alert.name = tokenAnalysis.name as string
  }

  // ── Real per-token whale event log (Supabase) ──────────────────────────────────────────
  let whaleRows: WhaleAlertRow[] = []
  let trackedAddresses = new Set<string>()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (supabaseUrl && serviceRole) {
    try {
      const supabase = createClient(supabaseUrl, serviceRole)
      const [alertsRes, trackedRes] = await Promise.all([
        supabase
          .from('whale_alerts')
          .select('wallet_address, side, amount_usd, occurred_at')
          .eq('chain', chain)
          .ilike('token_address', contract)
          .order('occurred_at', { ascending: false })
          .limit(60),
        supabase.from('tracked_wallets').select('address, chain_slug').eq('is_active', true).eq('chain_slug', chain),
      ])
      if (!alertsRes.error && alertsRes.data) whaleRows = alertsRes.data as WhaleAlertRow[]
      if (!trackedRes.error && trackedRes.data) {
        trackedAddresses = new Set(
          (trackedRes.data as Array<{ address: string }>).map(r => r.address.toLowerCase())
        )
      }
    } catch { /* best-effort — wallet intelligence section degrades to "no data" honestly */ }
  }

  const report = buildPumpIntelligenceReport({
    alert, chain, tokenAnalysis, whaleRows, trackedAddresses,
    dexScreenerMarket, dexScreenerAttempted, dexScreenerSucceeded,
    snapshotChange14d, snapshotsAttempted, snapshotsSucceeded, latestSnapshot,
    tokenScannerAttempted, whaleDataAttempted: Boolean(supabaseUrl && serviceRole),
    goldRushHolderCount: holderProviderResult.count, goldRushHolderCountCapped: holderProviderResult.countCapped,
    goldRushTop1: holderProviderResult.top1, goldRushTop10: holderProviderResult.top10,
    holderProviderChainSupported, holderProviderAttempted, holderProviderSucceeded,
    includeDebugAudit: searchParams.get('debug') === 'true'
      && userEmail != null
      && new Set((process.env.ADMIN_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)).has(userEmail.toLowerCase()),
  })
  report.dataResolutionAudit.openedFromAlert = alertPayloadReceived
  report.dataResolutionAudit.alertPayloadReceived = alertPayloadReceived
  return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } })
}

function numOrNull(v: string | null): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
