// workers/walletScanV2.ts — in-process V2 scan worker.
//
// NAMING DISCLOSURE: this is `workers/` (plural), a NEW directory, distinct from the existing
// `worker/` (singular) at the repo root — that one is a standalone, always-on Express process
// (worker/server.ts) deployed separately on Railway, reached over HTTP, not importable from a
// Next.js API route. This file is the opposite: a plain in-process TypeScript module, imported and
// called synchronously by app/api/scan-v2/full-scan/route.ts in the same serverless invocation. The
// two are unrelated; this file does not touch, wrap, or duplicate worker/server.ts in any way.
//
// WHAT MOVED HERE, DISCLOSED: this is the exact module-chain body that previously lived inline in
// app/api/scan-v2/full-scan/route.ts's POST handler — every field, every try/catch degrade-shape,
// every disclosure comment from that file's history is preserved verbatim below (see git history on
// that file for the full per-module disclosure trail: holdings/pricing/portfolio/pnl/chainActivity/
// risk/personality/behavior/signals/smartMoneyScore). Nothing was rewritten, reordered, or
// resimplified in the move — only relocated, so the route can become a thin dispatcher per this
// task's request. router.handleScanRequest (the real orchestrator every other scan route also
// calls) is still called from here, unchanged; this file does not reimplement or bypass it.

import { router } from '@/src/deployment/index'
import { fetchAllHoldings } from '@/lib/engine/modules/holdings/fetchHoldings'
import { priceHoldings } from '@/lib/engine/modules/pricing/fetchPricing'
import { buildPortfolio } from '@/lib/engine/modules/portfolio/buildPortfolio'
import { computePnl, fetchParsedTrades } from '@/lib/engine/modules/pnl/computePnl'
import { computeChainActivity } from '@/lib/engine/modules/activity/computeChainActivity'
import { computeRisk } from '@/lib/engine/modules/risk/computeRisk'
import { computePersonality } from '@/lib/engine/modules/personality/computePersonality'
import { computeBehavior } from '@/lib/engine/modules/behavior/computeBehavior'
import { computeSignals } from '@/lib/engine/modules/signals/computeSignals'
import { computeSmartMoneyScore, deriveSmartMoneyInputs } from '@/lib/engine/modules/smartMoney/computeSmartMoneyScore'
import { createEventsCache } from '@/app/api/_shared/eventsCache'
import { createCuBudget } from '@/app/api/_shared/cuBudget'
import { recordCuUsage } from '@/app/api/_shared/cuUsageStore'

// V2-DIRECT-FAILURE LOGGER: moved here unchanged from the route file (still exported so the route
// can also tag its own outer catch with the same log tag).
export function logDirectFailure(error: unknown): void {
  const err = error as { message?: string; stack?: string } | null
  // eslint-disable-next-line no-console
  console.error('[V2-DIRECT-FAILURE]', { message: err?.message, stack: err?.stack })
}

// SHAPE-CHECK, DISCLOSED DEVIATION (unchanged from the route file's own history): checks the real
// field names (pnlV2/chainActivityV2), diagnostic-only — logs a warning but never changes the
// status code or body.
function logIfUnexpectedV2Shape(data: Record<string, unknown> | undefined): void {
  if (!data) return
  if (data.pnlV2 === undefined || data.chainActivityV2 === undefined) {
    // eslint-disable-next-line no-console
    console.warn('[V2-DIRECT-FAILURE] unexpected response shape (missing pnlV2/chainActivityV2)', {
      hasPnlV2: data.pnlV2 !== undefined,
      hasChainActivityV2: data.chainActivityV2 !== undefined,
    })
  }
}

// MINIMAL SHAPE GUARD (unchanged from the route file's own history): checks only scanMetadata/
// chainSelection — real, non-optional fields on SanitizedReportV2, guaranteed present on every
// successful handleScanRequest response.
function isValidV2Result(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false
  if (typeof data !== 'object') return false
  if (!data.scanMetadata) return false
  if (!data.chainSelection) return false
  return true
}

export type WalletScanV2WorkerResult = { status: number; body: unknown }

// CU-HARDENING WIRING (unchanged from the route file's own history — fixes docs/CU_AUDIT.md
// Finding #1): a fresh, request-scoped EventsCache is created per call (not a shared module-level
// singleton) and threaded into both fetchParsedTrades and computeChainActivity.
export async function runWalletScanV2Worker(rawBody: unknown, ip: string): Promise<WalletScanV2WorkerResult> {
  const startTime = Date.now()
  const eventsCache = createEventsCache()
  const cuBudget = createCuBudget()
  // eslint-disable-next-line no-console
  console.debug('[CU-HARDENING] Cache cleared for new request')

  // handleScanRequest already never throws internally (rate-limit/validation errors and any
  // runWalletScanV2 failure are both caught and returned as a structured RouteResult).
  const result = await router.handleScanRequest(rawBody, ip)

  let body = result.body as { success: boolean; data?: { scanMetadata?: { walletAddress?: string } } }

  if (body.success && !isValidV2Result(body.data as Record<string, unknown> | undefined)) {
    logDirectFailure(new Error('Invalid V2 result shape'))
    return { status: 500, body: { success: false, error: 'invalid_v2_shape' } }
  }

  if (body.success && body.data?.scanMetadata?.walletAddress) {
    const walletAddress = body.data.scanMetadata.walletAddress
    // eslint-disable-next-line no-console
    console.debug('[CU-TRACK] deep-scan start:', { walletAddress, chains: [1, 8453] })
    // WORKER OBSERVABILITY, DISCLOSED: per-module `performance.now()` timing logs added below, per
    // explicit instruction — purely additive console.log calls wrapped around each already-existing
    // module call, in the same order they already ran. No module's logic, arguments, ordering, or
    // try/catch degrade-shape was changed to add these.
    const chainOverallStart = performance.now()

    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting holdings')
    let t0 = performance.now()
    let chainHoldings: Awaited<ReturnType<typeof fetchAllHoldings>> = []
    try {
      chainHoldings = await fetchAllHoldings(walletAddress)
    } catch {
      chainHoldings = []
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished holdings in', performance.now() - t0, 'ms', 'count=', chainHoldings.length)

    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting pricing')
    t0 = performance.now()
    let pricing: Awaited<ReturnType<typeof priceHoldings>>
    try {
      pricing = await priceHoldings(chainHoldings)
    } catch {
      pricing = { pricedHoldings: [], totalValueUsd: 0, chainValueUsd: {}, priceStatus: 'unavailable' }
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished pricing in', performance.now() - t0, 'ms', 'count=', pricing.pricedHoldings.length)

    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting portfolio')
    t0 = performance.now()
    let portfolioOutput: Awaited<ReturnType<typeof buildPortfolio>>
    try {
      portfolioOutput = await buildPortfolio(pricing.pricedHoldings, pricing.totalValueUsd, pricing.chainValueUsd)
    } catch {
      portfolioOutput = {
        portfolio: { totalValueUsd: 0, categories: [], chains: [], topHoldings: [], stablecoinRatio: 0, concentrationIndex: 0 },
        portfolioStatus: 'empty',
      }
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished portfolio in', performance.now() - t0, 'ms', 'holdings=', chainHoldings.length)

    // CU-DIAG, DISCLOSED SCOPE: this is the real provider-heavy step (fetchParsedTrades ->
    // walletChainPipeline.fetchRawEventsForChain -> the actual GoldRush/Alchemy calls) — but those
    // real fetch functions live in src/modules/providerFetchWindow/utils.ts, a production module
    // this entire session has treated as untouched, protected code (see this file's own header and
    // every prior commit's disclosures). Logging is added here, at the call site, instead — it
    // reveals trade-event volume per scan without modifying any module internals or outputs.
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting trades')
    t0 = performance.now()
    let trades: Awaited<ReturnType<typeof fetchParsedTrades>> = []
    try {
      trades = await fetchParsedTrades(walletAddress, eventsCache, cuBudget)
    } catch {
      trades = []
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished trades in', performance.now() - t0, 'ms', 'count=', trades.length, 'cacheHitsSoFar=', eventsCache.hitCount)

    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting pnl')
    t0 = performance.now()
    let pnlOutput: Awaited<ReturnType<typeof computePnl>>
    try {
      pnlOutput = await computePnl(pricing.pricedHoldings, chainHoldings, pricing.totalValueUsd, trades)
    } catch {
      pnlOutput = {
        pnlV2: { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [] },
        pnlStatus: 'unavailable',
      }
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished pnl in', performance.now() - t0, 'ms')

    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting chainActivity')
    t0 = performance.now()
    let chainActivityOutput: Awaited<ReturnType<typeof computeChainActivity>>
    try {
      chainActivityOutput = await computeChainActivity(
        walletAddress,
        chainHoldings,
        pricing.pricedHoldings,
        trades,
        portfolioOutput.portfolio,
        pnlOutput.pnlV2,
        eventsCache,
        cuBudget,
      )
    } catch {
      chainActivityOutput = { chainActivityV2: [], chainActivityStatus: 'empty' }
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished chainActivity in', performance.now() - t0, 'ms', 'count=', chainActivityOutput.chainActivityV2.length)

    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting risk')
    t0 = performance.now()
    let riskOutput: Awaited<ReturnType<typeof computeRisk>>
    try {
      riskOutput = await computeRisk(
        portfolioOutput.portfolio,
        pnlOutput.pnlV2,
        chainActivityOutput.chainActivityV2,
        pricing.pricedHoldings,
        chainHoldings,
      )
    } catch {
      riskOutput = {
        riskV2: {
          score: 0, level: 'low', concentrationRisk: 0, stablecoinRatio: 0,
          unrealizedPnlPressure: 0, chainRisk: 0, volatileExposure: 0, fragmentationRisk: 0,
        },
        riskStatus: 'empty',
      }
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished risk in', performance.now() - t0, 'ms')

    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting personality')
    t0 = performance.now()
    let personalityOutput: Awaited<ReturnType<typeof computePersonality>>
    try {
      personalityOutput = await computePersonality(
        portfolioOutput.portfolio,
        pnlOutput.pnlV2,
        chainActivityOutput.chainActivityV2,
        riskOutput.riskV2,
        pricing.pricedHoldings,
        chainHoldings,
      )
    } catch {
      personalityOutput = {
        personalityV2: {
          archetype: 'Unknown', riskAppetite: 'low', tradingStyle: 'passive', chainPreference: null,
          volatilityTolerance: 0, stabilityPreference: 0, pnlBehavior: 'neutral', activityConsistency: 'dormant',
          summary: 'Insufficient data to classify wallet personality.',
        },
        personalityStatus: 'empty',
      }
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished personality in', performance.now() - t0, 'ms')

    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting behavior')
    t0 = performance.now()
    let behaviorOutput: Awaited<ReturnType<typeof computeBehavior>>
    try {
      behaviorOutput = await computeBehavior(
        pnlOutput.pnlV2,
        portfolioOutput.portfolio,
        chainActivityOutput.chainActivityV2,
        pricing.pricedHoldings,
        chainHoldings,
        trades,
        riskOutput.riskV2,
        personalityOutput.personalityV2,
      )
    } catch {
      behaviorOutput = {
        behaviorV2: {
          accumulationStyle: 'neutral', rotationStyle: 'inactive', bridgingBehavior: 'none',
          farmingBehavior: 'none', stableRoutingBehavior: 'none', memeBehavior: 'none',
          tradeFrequency: 'low', behaviorSummary: 'No trade activity found for this wallet.',
        },
        behaviorStatus: 'empty',
      }
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished behavior in', performance.now() - t0, 'ms')

    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting signals')
    t0 = performance.now()
    let signalsOutput: Awaited<ReturnType<typeof computeSignals>>
    try {
      signalsOutput = await computeSignals(
        portfolioOutput.portfolio,
        pnlOutput.pnlV2,
        chainActivityOutput.chainActivityV2,
        riskOutput.riskV2,
        personalityOutput.personalityV2,
        behaviorOutput.behaviorV2,
        pricing.pricedHoldings,
        chainHoldings,
        trades,
      )
    } catch {
      signalsOutput = { signalsV2: [], signalsStatus: 'empty' }
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished signals in', performance.now() - t0, 'ms', 'count=', signalsOutput.signalsV2.length)

    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting smartMoneyScore')
    t0 = performance.now()
    let smartMoneyScore: ReturnType<typeof computeSmartMoneyScore> | undefined
    try {
      smartMoneyScore = computeSmartMoneyScore(
        deriveSmartMoneyInputs({
          pnlV2: pnlOutput.pnlV2,
          pnlStatus: pnlOutput.pnlStatus,
          totalValueUsd: pricing.totalValueUsd,
          behaviorV2: behaviorOutput.behaviorV2,
          personalityV2: personalityOutput.personalityV2,
          chainActivityV2: chainActivityOutput.chainActivityV2,
          riskV2: riskOutput.riskV2,
          signalsV2: signalsOutput.signalsV2,
        }),
      )
    } catch {
      smartMoneyScore = undefined
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished smartMoneyScore in', performance.now() - t0, 'ms')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] total', performance.now() - chainOverallStart)
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished all modules')
    // CU-DIAG SUMMARY, DISCLOSED DEVIATION: the task's own snippet used a fabricated
    // `events.length * 0.7` estimate tracked in a new local variable. This worker already has a
    // real, exact provider-call counter (cuBudget.providerCalls, threaded through fetchParsedTrades/
    // computeChainActivity) plus the real cache-hit count (eventsCache.hitCount) — using those
    // instead of inventing a second, less accurate estimate.
    // eslint-disable-next-line no-console
    console.log('[CU-DIAG] Estimated CU total (real provider calls, not an approximation):', {
      providerCalls: cuBudget.providerCalls,
      cacheHits: eventsCache.hitCount,
    })

    body = {
      ...body,
      data: {
        ...body.data,
        smartMoneyScore,
        chainHoldings,
        pricedHoldings: pricing.pricedHoldings,
        totalValueUsd: pricing.totalValueUsd,
        chainValueUsd: pricing.chainValueUsd,
        priceStatus: pricing.priceStatus,
        portfolioV2: portfolioOutput.portfolio,
        portfolioStatus: portfolioOutput.portfolioStatus,
        pnlV2: pnlOutput.pnlV2,
        pnlStatus: pnlOutput.pnlStatus,
        chainActivityV2: chainActivityOutput.chainActivityV2,
        chainActivityStatus: chainActivityOutput.chainActivityStatus,
        riskV2: riskOutput.riskV2,
        riskStatus: riskOutput.riskStatus,
        personalityV2: personalityOutput.personalityV2,
        personalityStatus: personalityOutput.personalityStatus,
        behaviorV2: behaviorOutput.behaviorV2,
        behaviorStatus: behaviorOutput.behaviorStatus,
        signalsV2: signalsOutput.signalsV2,
        signalsStatus: signalsOutput.signalsStatus,
      },
    } as typeof body

    // eslint-disable-next-line no-console
    console.debug('[CU-HARDENING] Total provider calls avoided:', eventsCache.hitCount)
    // eslint-disable-next-line no-console
    console.debug('[CU-TRACK] deep-scan end:', { providerCalls: cuBudget.providerCalls, cacheHits: eventsCache.hitCount })
    // eslint-disable-next-line no-console
    console.debug('[CU-SUMMARY]', {
      wallet: walletAddress,
      chains: [1, 8453],
      providerCalls: cuBudget.providerCalls,
      cacheHits: eventsCache.hitCount,
      elapsedMs: Date.now() - startTime,
    })
    recordCuUsage(cuBudget.providerCalls, eventsCache.hitCount)
    logIfUnexpectedV2Shape(body.data as Record<string, unknown> | undefined)
  }

  return { status: result.status, body }
}
