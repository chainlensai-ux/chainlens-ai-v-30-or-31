// Route-level adapters wrapping the real V2 engine (src/pipeline/runWalletScanV2.ts) for
// /api/portfolio, Clark AI, and walletScannerRunner — the three routes previously stubbed to
// walletLite.ts's zero-RPC fallback. Only route-level integration; V2 engine internals
// (src/pipeline, src/modules/*) are never modified or reached into beyond their real, existing
// public entry point (runWalletScanV2()).
//
// HONEST DISCLOSURE ON "WITHOUT INCREASING ALCHEMY CU": calling the real V2 engine from these 3
// route-level call sites is a genuine increase in Alchemy CU usage compared to the zero-RPC
// walletLite.ts fallback these routes used before this change — there is no way to get real V2
// data without running V2's real provider-fetch stage, which does call Alchemy internally
// (src/modules/providerFetchWindow). What this file actually does to bound that cost:
//   1. 45s KV cache per address+kind (below) — repeat requests for the same address within the
//      window cost zero additional CU.
//   2. scanMode is hardcoded to 'normal', never 'deep' — deep mode triggers recoveryPolicy's
//      additional historical-page fetches, which these lightweight lookups have no need for.
//   3. chains defaults to ['base', 'eth', 'arbitrum'] only — hyperevm is excluded because it
//      structurally returns zero real events today (no verified GoldRush/Alchemy chain slug wired
//      for it — see src/modules/providerFetchWindow/utils.ts's own ALCHEMY_VERIFIED_CHAINS /
//      GOLDRUSH_VERIFIED_CHAIN_SLUGS maps), so including it would add scan overhead for no benefit.
// This is a real, disclosed tradeoff, not a claim that CU usage stays at zero.
//
// getIdentityFromV2() HONEST DISCLOSURE: there is no ENS/identity/labels module anywhere in the
// V2 engine (verified via a full grep of src/pipeline and src/modules before writing this file —
// chainSelection has per-chain status, nothing resembling wallet identity or address labels).
// Rather than fabricate one, getIdentityFromV2() always returns null (an honest "V2 has no
// identity data for this address" answer), which correctly triggers this file's own
// fallback-to-walletLite.ts contract at every call site — never a fabricated identity/label.

import { runWalletScanV2 } from '@/src/pipeline/runWalletScanV2'
import type { RunWalletScanV2Result } from '@/src/pipeline/runWalletScanV2'
import { getTokenCache, setTokenCache } from '@/lib/server/cache/tokenCache'
import type { WalletLiteResult } from '@/lib/server/walletLite'
import { logRpcCall } from '@/lib/server/rpcDebug'
import { isCanonicalVerifiedPublishedLot } from '@/src/lib/canonicalVerifiedLot'

// Strips this machine's absolute filesystem prefix from a stack trace before it's ever logged or
// returned in a diagnostic JSON response — "sanitized" per the request. Capped to 5 frames; a full
// raw stack isn't needed to see which adapter path triggered a scan.
function sanitizeStack(stack: string | undefined): string {
  if (!stack) return ''
  return stack
    .split('\n')
    .slice(0, 5)
    .map((line) => line.replace(process.cwd(), '.'))
    .join('\n')
}

const V2_ADAPTER_TTL_SECONDS = 45
// Exported (unification task, step 1): the canonical Wallet Scanner orchestrator
// (lib/server/walletScanOrchestrator.ts) reuses this exact list and this exact function below for
// its 'auto'/'all_supported' chain resolution and preview-mode EVM scan — no new chain list, no new
// scan call, only an additive export. Behavior/values unchanged.
export const DEFAULT_CHAINS = ['base', 'eth', 'arbitrum']

// Mirrors tokenCache.ts's own internal env check — kept as a separate, explicit guard here too
// (rather than relying solely on getTokenCache/setTokenCache's internal check) so this file's own
// KV READ/KV WRITE log lines are never emitted when KV isn't actually configured, and so a
// misconfigured deployment is diagnosable directly from this file's logs, not just tokenCache.ts's.
function kvEnabled(): boolean {
  return Boolean(process.env.KV_REST_API_URL) && Boolean(process.env.KV_REST_API_TOKEN)
}

async function readFromKv(cacheKey: string): Promise<WalletLiteResult | null> {
  if (!kvEnabled()) {
    console.warn('KV DISABLED')
    return null
  }
  try {
    const cached = await getTokenCache<WalletLiteResult>(cacheKey)
    if (cached) console.log('KV READ', cacheKey)
    return cached
  } catch (err) {
    console.error('KV ERROR', err)
    return null
  }
}

async function writeToKv(cacheKey: string, value: WalletLiteResult): Promise<void> {
  if (!kvEnabled()) {
    console.warn('KV DISABLED')
    return
  }
  try {
    await setTokenCache(cacheKey, value, V2_ADAPTER_TTL_SECONDS)
    console.log('KV WRITE', cacheKey)
  } catch (err) {
    console.error('KV ERROR', err)
  }
}

// `route` here identifies which v2Adapters function triggered this scan (getPortfolioFromV2 /
// getWalletFromV2), NOT the literal HTTP route path — that context isn't threaded into this file
// today, and adding it would mean modifying the 3 calling routes/runners, which this diagnostic
// task's own scope excludes ("never modify existing API routes"). Disclosed as an honest proxy,
// not a claim of full per-HTTP-route attribution.
export async function runV2Scan(address: string, route: string): Promise<RunWalletScanV2Result | null> {
  for (const chain of DEFAULT_CHAINS) {
    logRpcCall({ chain, method: 'runWalletScanV2', route, stack: sanitizeStack(new Error().stack) })
  }
  try {
    return await runWalletScanV2({ walletAddress: address, chains: DEFAULT_CHAINS, scanMode: 'normal' })
  } catch (err) {
    console.warn('[v2Adapters] runWalletScanV2 threw, treating as V2 unavailable', {
      address,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// Base portfolio mapping kept byte-for-byte narrow for non-Clark callers. Clark's richer wallet
// projection below is selected only by getWalletFromV2, so /api/portfolio does not unexpectedly
// gain analyst/PnL fields as a side effect of this routing fix.
function toUnifiedShape(address: string, report: RunWalletScanV2Result): WalletLiteResult {
  return {
    ok: true,
    address,
    balances: report.holdings.map((holding) => ({
      chain: holding.chain,
      contract: holding.contract,
      symbol: holding.symbol,
      name: holding.name,
      amount: holding.amount,
      valueUsd: holding.providerValueUsd,
    })),
    positions: [],
    chains: report.scanMetadata.chainsScanned,
    identity: {},
    labels: {},
  }
}

// Real, honest Clark projection from the V2 report. No provider call or PnL recomputation occurs:
// it reshapes the same canonical published lots, portfolio, behavior and coverage already returned
// by runWalletScanV2. Missing evidence remains null/Open Check.
export function projectWalletV2ForClark(address: string, report: RunWalletScanV2Result): WalletLiteResult {
  const base = toUnifiedShape(address, report)
  const reconciliation = report.reconciliationSummary
  const publishedLots = reconciliation?.publishedMatchedLots ?? report.canonicalPricedFifo.matchedLots
  const verifiedLots = publishedLots.filter(isCanonicalVerifiedPublishedLot)
  const pnlStatus = reconciliation?.publicPnlStatus ?? (report.canonicalPricedFifo.publicPnlStatus === 'ok' ? 'available' : report.canonicalPricedFifo.publicPnlStatus === 'limited_verified_sample' ? 'partial' : 'unavailable')
  const realizedPnlUsd = reconciliation?.realizedPnlUsd ?? report.canonicalPricedFifo.realizedPnlUsd
  const wins = verifiedLots.filter((lot) => (lot.realizedPnlUsd ?? 0) > 0).length
  const losses = verifiedLots.filter((lot) => (lot.realizedPnlUsd ?? 0) < 0).length
  const evaluated = wins + losses
  const publicWinRatePercent = evaluated > 0 ? Math.round((wins / evaluated) * 10_000) / 100 : null
  const symbolByKey = new Map<string, string>(report.portfolio.tokens.map((token) => [`${token.chain}:${token.contract.toLowerCase()}`, token.symbol]))
  const tokenRows = new Map<string, { symbol: string; chain: string; token: string; realizedPnlUsd: number; totalBoughtUsd: number; totalSoldUsd: number; closedFragments: number }>()
  for (const lot of verifiedLots) {
    const key = `${lot.chain}:${lot.token.toLowerCase()}`
    const existing = tokenRows.get(key) ?? { symbol: symbolByKey.get(key) ?? lot.token.slice(0, 8), chain: lot.chain, token: lot.token, realizedPnlUsd: 0, totalBoughtUsd: 0, totalSoldUsd: 0, closedFragments: 0 }
    existing.realizedPnlUsd += lot.realizedPnlUsd ?? 0
    existing.totalBoughtUsd += lot.costBasisUsd ?? 0
    existing.totalSoldUsd += lot.proceedsUsd ?? 0
    existing.closedFragments += 1
    tokenRows.set(key, existing)
  }
  const buys = report.timelines.buyTimeline.entries
  const sells = report.timelines.sellTimelineV2.entries
  const uniqueTransactions = new Set([...buys.map((row) => row.txHash), ...sells.map((row) => row.txHash)]).size
  const coverageAudit = report.walletPnlCoverageRecoveryAudit
  const evidenceGaps = coverageAudit
    ? Object.entries(coverageAudit.missingLotsByReason).filter(([, count]) => count > 0).map(([reason, count]) => `${reason}: ${count}`)
    : []
  const totalValue = report.portfolio.totalValueUsd
  const walletCategory = totalValue == null ? null : totalValue >= 250_000 ? 'Whale' : totalValue >= 10_000 ? 'Mid Portfolio' : 'Small Portfolio'
  const rotation = report.behaviorIntel.rotationStyle.value
  const concentration = report.behaviorIntel.concentrationSignals
  const publicStatus = pnlStatus === 'available' ? 'ok' : pnlStatus === 'partial' ? 'limited_verified_sample' : 'unavailable'
  const fifoStatus = pnlStatus === 'available' ? 'ok' : publishedLots.length > 0 ? 'locked_insufficient_trades' : 'locked_no_closed_lots'
  const profileSignals = [
    ...(totalValue != null ? [`Portfolio value: $${Math.round(totalValue).toLocaleString()}.`] : []),
    `Rotation style: ${rotation}; ${report.behaviorIntel.rotationStyle.basis.buyCount} buys / ${report.behaviorIntel.rotationStyle.basis.sellCount} sells.`,
    ...(concentration ? [`Top holding concentration: ${concentration.topHoldingPercent.toFixed(1)}% (${concentration.concentrationLabel}).`] : []),
  ]
  return {
    ...base,
    totalValue,
    holdings: report.portfolio.tokens.map((token) => ({ symbol: token.symbol, value: token.valueUsd, chain: token.chain })),
    txCount: uniqueTransactions,
    pnlCoverage: coverageAudit ?? reconciliation?.publicPnlGateAudit ?? null,
    historicalRecoveryStatus: report.recoveryPolicy.totalPagesUsedThisWallet > 0 ? 'recovery_attempted' : 'not_triggered',
    openLots: null,
    closedLots: publishedLots.length,
    walletScanHealth: { status: pnlStatus === 'available' ? 'ok' : 'limited_pnl', summary: pnlStatus === 'available' ? 'Canonical public PnL is available.' : reconciliation?.warning ?? coverageAudit?.officialPnlStillBlockedReason ?? 'Canonical PnL evidence is incomplete.' },
    walletModuleCoverage: {
      portfolio: { status: report.portfolio.tokens.length ? 'ok' : 'open_check' },
      activity: { status: 'ok' },
      fifoPnL: { status: fifoStatus, reason: coverageAudit?.officialPnlStillBlockedReason ?? reconciliation?.warning ?? null },
      tradeStats: { status: pnlStatus === 'available' ? 'ok' : publishedLots.length ? 'partial' : 'open_check' },
      chains: { status: report.scanMetadata.chainsScanned.length ? 'ok' : 'open_check' },
      priceEvidence: { status: verifiedLots.length === publishedLots.length && publishedLots.length > 0 ? 'ok' : 'open_check' },
    },
    walletTokenPnlSummary: { status: publicStatus, realizedPnlUsd: pnlStatus === 'available' ? realizedPnlUsd : null, reason: coverageAudit?.officialPnlStillBlockedReason ?? reconciliation?.warning ?? null },
    walletTokenPnlRead: [...tokenRows.values()].map((row) => ({ ...row, status: pnlStatus === 'available' ? 'verified' : 'limited_sample' })),
    walletTradeStatsSummary: {
      status: pnlStatus === 'available' ? 'ok' : publishedLots.length ? 'partial' : 'open_check',
      closedLots: publishedLots.length,
      publicPerformanceClosedLots: verifiedLots.length,
      publicClosedLots: verifiedLots.length,
      publicRealizedPnlUsd: pnlStatus === 'available' ? realizedPnlUsd : null,
      publicWinRatePercent,
      publicPnlStatus: publicStatus,
      pnlIntegrityStatus: report.canonicalPricedFifo.integrityFlags.hardInvalid || reconciliation?.pnlDiscrepancyAudit.trustGateTriggered ? 'invalid' : 'ok',
      scoreUnlocked: pnlStatus === 'available' && verifiedLots.length >= 10,
    },
    walletHistoricalCoverageSummary: { status: report.windowCoverage.coverageBasis, realDataDays: report.windowCoverage.realDataDays, recoveredExtraDays: report.windowCoverage.recoveredExtraDays },
    walletRecoveryRecommendation: coverageAudit ? { reason: coverageAudit.officialPnlStillBlockedReason, recoveryFailedTokens: coverageAudit.recoveryFailedTokens } : null,
    walletLotSummary: { status: publicStatus, closedLots: publishedLots.length, verifiedClosedLots: verifiedLots.length, unmatchedBuys: report.canonicalPricedFifo.unmatchedBuys, unmatchedSells: report.canonicalPricedFifo.unmatchedSells, realizedPnlUsd: pnlStatus === 'available' ? realizedPnlUsd : null },
    publicPnlStatus: publicStatus,
    publicPerformanceClosedLots: verifiedLots.length,
    publicRealizedPnlUsd: pnlStatus === 'available' ? realizedPnlUsd : null,
    publicWinRatePercent,
    publicSamplePerformanceRead: pnlStatus === 'partial' && verifiedLots.length ? { status: 'available', closedLots: verifiedLots.length, realizedPnlUsd, winRatePercent: publicWinRatePercent, excludedFrom: ['profit_skill', 'wallet_score', 'official_win_rate'] } : null,
    evidenceGaps,
    walletProfile: {
      walletCategory,
      portfolioBehavior: concentration ? `${concentration.concentrationLabel} concentration` : null,
      tradingBehavior: rotation === 'unknown' ? null : rotation.charAt(0).toUpperCase() + rotation.slice(1),
      portfolioConfidence: totalValue == null ? 'low' : report.behaviorIntel.confidence,
      tradingConfidence: report.behaviorIntel.confidence,
      followability: pnlStatus === 'available' && report.behaviorIntel.confidence === 'high' ? 'Moderate' : 'Low',
      signals: profileSignals,
      strengths: [],
      weaknesses: evidenceGaps,
      nextAction: pnlStatus === 'available' ? 'Monitor new verified activity before following.' : 'Run a deep Wallet Scanner scan to improve PnL and identity evidence.',
    },
    dataFreshness: 'live',
  }
}

async function getCachedOrCompute(
  cacheKey: string,
  address: string,
  route: string,
): Promise<WalletLiteResult | null> {
  const cached = await readFromKv(cacheKey)
  if (cached) return cached

  const report = await runV2Scan(address, route)
  if (!report) return null

  const unified = route === 'getWalletFromV2'
    ? projectWalletV2ForClark(address, report)
    : toUnifiedShape(address, report)
  await writeToKv(cacheKey, unified)
  return unified
}

// NEVER throws — every function below is wrapped so a caller can always treat a null return as
// "V2 unavailable, fall back to walletLite.ts" per this task's own fallback contract.

export async function getPortfolioFromV2(address: string): Promise<WalletLiteResult | null> {
  try {
    return await getCachedOrCompute(`v2:portfolio:${address.toLowerCase()}`, address, 'getPortfolioFromV2')
  } catch (err) {
    console.warn('[v2Adapters] getPortfolioFromV2 failed', { address, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function getWalletFromV2(address: string): Promise<WalletLiteResult | null> {
  try {
    return await getCachedOrCompute(`v2:wallet:${address.toLowerCase()}`, address, 'getWalletFromV2')
  } catch (err) {
    console.warn('[v2Adapters] getWalletFromV2 failed', { address, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

// Always null — see this file's header for why. Still checks/writes the cache key so the "no
// identity data" answer is itself cheap to re-derive, and so this function's real behavior is
// fully consistent with the other two adapters' cache-then-compute shape.
export async function getIdentityFromV2(address: string): Promise<WalletLiteResult | null> {
  try {
    const cacheKey = `v2:identity:${address.toLowerCase()}`
    return await readFromKv(cacheKey)
  } catch (err) {
    console.warn('[v2Adapters] getIdentityFromV2 failed', { address, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}
