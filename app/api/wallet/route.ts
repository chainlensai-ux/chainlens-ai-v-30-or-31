import { NextResponse } from 'next/server'
import { fetchWalletSnapshot, type WalletSnapshotOptions } from '@/lib/server/walletSnapshot'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'

const WALLET_CACHE_TTL_MS = 3 * 60 * 1000
const walletCache = new Map<string, { exp: number; payload: unknown; cachedAt: number }>()
const walletRate = new Map<string, { count: number; resetAt: number }>()
const WALLET_RATE_BY_PLAN: Record<string, number> = { free: 20, pro: 60, elite: 180 }
async function walletPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  try { return (await getCurrentUserPlanFromBearerToken(token)).plan } catch { return 'free' }
}
function walletIp(req: Request): string { return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown' }
async function walletAllowed(req: Request): Promise<boolean> { const plan=await walletPlan(req); const key=`${plan}:${walletIp(req)}`; const now=Date.now(); const cur=walletRate.get(key); const lim=WALLET_RATE_BY_PLAN[plan]; if(!cur||cur.resetAt<=now){walletRate.set(key,{count:1,resetAt:now+60000}); return true} if(cur.count>=lim)return false; cur.count+=1; return true }

export async function POST(req: Request) {
  const plan = await walletPlan(req)
  if (plan === 'free') return NextResponse.json({ error: 'Included in Pro and Elite.' }, { status: 403 })
  if (!(await walletAllowed(req))) return NextResponse.json({ error: "Rate limit reached. Try again shortly." }, { status: 429 })
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
    const debugFresh = requestUrl.searchParams.get('debugFresh') === 'true' || body?.debugFresh === true || body?.debugFresh === 'true'
    const hasBearerToken = (req.headers.get('authorization') ?? '').startsWith('Bearer ')
    const allowDebugFresh = debugFresh && (process.env.NODE_ENV !== 'production' || hasBearerToken)
    const key = String(address ?? '').toLowerCase()
    if (!/^0x[a-fA-F0-9]{40}$/.test(key)) {
      return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 })
    }
    const cacheKey = `${key}:${cacheMode}`
    const cached = allowDebugFresh || refresh || (debug && deepActivity) ? null : walletCache.get(cacheKey)
    if (cached && cached.exp > Date.now()) {
      const cacheAgeSeconds = Math.floor((Date.now() - cached.cachedAt) / 1000)
      const cp: any = typeof cached.payload === 'object' && cached.payload ? { ...(cached.payload as any), dataFreshness: 'cached', cacheAgeSeconds } : cached.payload
      if (cp && typeof cp === 'object' && debug) cp._debug = {
        routeName: '/api/wallet', cacheHit: true, cacheMode,
        requestDurationMs: Date.now() - startedAt,
        walletSnapshotCache: { memoryHit: true, persistentHit: false, providerFetchNeeded: false, refreshBypassedCache: false, cacheAgeSeconds, cacheTtlSeconds: WALLET_CACHE_TTL_MS / 1000 },
        providerFlow: null,
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
        },
      }
      if (cp && typeof cp === 'object') delete cp._diagnostics
      return NextResponse.json(cp)
    }
    const snapshot = await fetchWalletSnapshot(address ?? '', { refresh, chain, deepScan, deepActivity, chainMode } satisfies WalletSnapshotOptions)
    const providers: any = (snapshot as any)._diagnostics?.providers ?? {}
    const snapshotCacheDebug = (snapshot as any)._diagnostics?.snapshotCache ?? null
    if (debug) {
      ;(snapshot as any)._debug = {
        routeName: '/api/wallet',
        cacheHit: false,
        goldrushUsage: {
          endpointName: 'balances_v2 + transactions_v3',
          feature: 'wallet-scanner',
          trigger: 'scan_button',
          attempted: Boolean(providers.goldrush?.configured),
          cacheHit: Boolean((snapshot as any)._diagnostics?.snapshotCache?.memoryHit),
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
        providerFallback: (snapshot as any)._diagnostics?.providerFallback ?? null,
        walletProviderRouting: (snapshot as any)._diagnostics?.walletProviderRouting ?? null,
        moralisUsage: (snapshot as any)._diagnostics?.moralisUsage ?? null,
        providerFlow: (snapshot as any)._diagnostics?.providerFlow ?? null,
        chainUsage: (snapshot as any)._diagnostics?.chainUsage ?? null,
        walletTxEvidenceDebug: (snapshot as any)._diagnostics?.walletTxEvidenceDebug ?? null,
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
          fetchedPnlEvents: (snapshot as any).walletEvidenceSummary?.totalEvents ?? 0,
          fetchedEvidenceEvents: (snapshot as any).walletEvidenceSummary?.eventsWithHash ?? 0,
          evidenceStatus: (snapshot as any).walletEvidenceSummary?.status ?? 'unknown',
          reason: (deepActivity || deepScan) ? null : 'deep_activity_not_requested',
        },
      }
    }
    if (!debug) {
      ;(snapshot as any).providerUsed = 'holdings_layer'
      ;(snapshot as any).portfolioSource = 'portfolio_layer'
      ;(snapshot as any).behaviorSource = (snapshot as any).behaviorSource === 'unavailable' ? 'unavailable' : 'activity_layer'
      ;(snapshot as any).pnlSource = (snapshot as any).pnlSource === 'unavailable' ? 'unavailable' : 'activity_layer'
    }
    delete (snapshot as any)._diagnostics
    if (!allowDebugFresh && !refresh && !debug) walletCache.set(cacheKey, { exp: Date.now() + WALLET_CACHE_TTL_MS, payload: snapshot, cachedAt: Date.now() })
    return NextResponse.json(snapshot)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Wallet scan failed'
    const status = msg === 'Invalid wallet address' ? 400 : 500
    return NextResponse.json({ error: status === 400 ? 'Invalid wallet address' : 'Wallet scan unavailable right now.' }, { status })
  }
}
