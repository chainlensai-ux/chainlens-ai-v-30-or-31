import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { canAccessFeature } from '@/lib/planFeatures'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import {
  getCachedRobinhoodWalletHoldings,
  getCachedRobinhoodWalletActivity,
  buildRobinhoodWalletScannerAudit,
  buildRobinhoodPriceUsdLookup,
  resolveRobinhoodWalletPnl,
  formatRobinhoodPnlMessage,
} from '@/lib/server/robinhoodWalletScanner'
import { resolvePoolCurrenciesViaRpc } from '@/lib/server/robinhoodSwapDecoder'

// ROBINHOOD WALLET SCANNER ROUTE, DISCLOSED (phased Robinhood Chain Wallet Scanner rollout,
// Phase 1+2). Deliberately its OWN route, not a branch inside app/api/wallet-scan/route.ts's
// job-queue pipeline — see lib/server/robinhoodWalletScanner.ts's own header for the full
// architecture rationale. Synchronous (holdings + a bounded transaction-history fetch, both single
// bounded HTTP round-trips) rather than job-queued, since Phase 1/2's workload is far lighter than
// the deep multi-chain FIFO/PnL scan the queue exists for. Never touches wallet-scan's queue,
// worker, or V2 pipeline files.
export const runtime = 'nodejs'
export const maxDuration = 30

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })

async function getPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  if (process.env.BETA_ALL_ELITE === 'true') return 'elite'
  try { return (await getCurrentUserPlanFromBearerToken(token)).plan } catch { return 'free' }
}

export async function GET(req: Request): Promise<Response> {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ error: { message: 'Too many requests.', category: 'rate_limit' } }, { status: 429 })
  }

  const { searchParams } = new URL(req.url)
  const wallet = (searchParams.get('address') ?? searchParams.get('wallet') ?? '').trim()
  if (!isAddress(wallet)) {
    return NextResponse.json({ error: { message: 'Invalid wallet address', category: 'validation' } }, { status: 400 })
  }

  const plan = await getPlan(req)
  if (!canAccessFeature(plan, 'wallet-scanner')) {
    return NextResponse.json({ error: { message: 'Wallet Scanner requires a Pro or Elite plan.', category: 'plan' } }, { status: 403 })
  }

  const fetchImpl: typeof fetch = fetch
  // Holdings first, DISCLOSED (Phase 3/4): activity's swap decoding and PnL both need a real
  // priceUsdLookupForToken — built directly from THIS scan's own holdings prices (see
  // buildRobinhoodPriceUsdLookup) rather than a second, independent pricing path — so holdings must
  // resolve before activity/PnL can use it.
  const holdings = await getCachedRobinhoodWalletHoldings(wallet, fetchImpl)
  const priceUsdLookupForToken = buildRobinhoodPriceUsdLookup(holdings, fetchImpl)
  const resolvePoolCurrencies = (poolId: string) => resolvePoolCurrenciesViaRpc(poolId, fetchImpl)

  const activity = await getCachedRobinhoodWalletActivity(wallet, fetchImpl, { resolvePoolCurrencies, priceUsdLookupForToken })
  const pnl = await resolveRobinhoodWalletPnl(wallet, activity, { priceUsdLookupForToken, fetchImpl })

  const audit = buildRobinhoodWalletScannerAudit({
    wallet,
    holdings,
    activity,
    pnl,
    wrongChainCacheRejected: holdings.wrongChainCacheRejected || activity.wrongChainCacheRejected,
  })

  return NextResponse.json({
    ok: true,
    wallet,
    chainSlug: 'robinhood',
    chainId: audit.chainId,
    holdings,
    activity,
    // HARD RULE, DISCLOSED: "Do NOT show verified Robinhood PnL until swaps + prices are proven" —
    // this now reflects the real, per-scan pnlStatus (verified swaps + FIFO output, or a genuine
    // zero-verified-evidence reason) rather than a single fixed Phase-2 message.
    pnl: {
      status: pnl.status,
      message: formatRobinhoodPnlMessage(pnl.status),
      realizedPnlUsd: pnl.realizedPnlUsd,
      matchedLotsCount: pnl.matchedLotsCount,
      verifiedSwapCount: pnl.verifiedSwapCount,
      reason: pnl.reason,
    },
    robinhoodWalletScannerAudit: audit,
  })
}
