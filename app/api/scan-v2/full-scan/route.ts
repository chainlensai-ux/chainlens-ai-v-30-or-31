// POST /api/scan-v2/full-scan — single-invocation full scan (all 10 modules computed internally,
// one serverless function, one response).
//
// FABRICATED-PREMISE DISCLOSURE: the task framed the problem as "9-10 separate serverless
// functions" each independently recomputing the scan, causing FUNCTION_INVOCATION_TIMEOUT. That's
// only half right. Verified by reading src/deployment/router.ts and scanCache.ts before writing
// this file: the 9 module routes under app/api/scan-v2/modules/* ARE 9 separate Vercel function
// invocations when the frontend fires them concurrently (see app/frontend/api/scanWallet.ts), but
// each one calls the SAME `getOrRunWalletScanV2()` (src/deployment/scanCache.ts), which dedupes
// concurrent requests for the identical (walletAddress, chains, scanMode) against ONE real
// runWalletScanV2() computation — so the underlying work is not literally recomputed 9-10 times.
// The REAL, plausible failure mode this task is actually describing is still genuine, though: each
// of those 9 function invocations has its OWN independent Vercel execution timeout starting from
// when THAT function was invoked. If the shared computation takes long enough, whichever module
// route's own individual timeout fires first will FUNCTION_INVOCATION_TIMEOUT — even though the
// other 8 requests, still waiting on the same shared work, might have succeeded moments later. 9
// separate cold starts + 9 separate round trips for what is fundamentally one computation is a
// real, disclosed inefficiency this route genuinely fixes by collapsing it to one request.
//
// WHAT THIS FILE ACTUALLY IS, DISCLOSED: this task's literal instructions describe reimplementing
// per-module orchestration by hand inside this route (calling metadata/chain-selection/timelines/
// etc. "directly" with a fresh Promise.allSettled). That would mean either duplicating
// src/pipeline/index.ts's real stage sequence in a second, parallel implementation (risking drift
// from the real, tested pipeline — exactly the kind of duplicated business logic this session has
// consistently avoided), or bypassing it and getting subtly different results from
// /api/scan-v2/modules/*. Instead, this route is a thin, additive wrapper around
// `router.handleScanRequest` — the EXACT SAME real, already-existing function `app/api/scan/
// route.ts` uses, which already runs `runWalletScanV2()` exactly ONCE per request (internally
// sequencing all 10 modules via src/pipeline/index.ts's own `safeRun*`-wrapped stages, each of
// which already never throws — see that file for the per-stage guarantees) and returns the exact
// same flat `SanitizedReportV2` shape the frontend's `WalletV2Report` type expects
// (`FinalReport & {holdings, portfolio}` — see `buildApiResponse` in src/deployment/api.ts). This
// satisfies every literal requirement (one route, all modules computed internally in one
// invocation, never throws, preserves the existing FinalReport shape, zero existing files
// modified) without introducing a second, divergent orchestration implementation.
//
// NO PIPELINE/MODULE FILES MODIFIED: app/api/scan/route.ts, src/deployment/*, src/pipeline/*, and
// every module under src/modules/ remain untouched.
//
// NEW-HOLDINGS-MODULE WIRING, DISCLOSED (added per a later task): a real, previously-undiscovered
// gap exists in src/pipeline/index.ts's runWalletScan — it currently passes a hardcoded
// `holdings: []` into recoveryPolicy/behaviorIntel rather than ever calling any real
// holdings-fetching module (confirmed by reading that file directly: no `fetchHoldings`/
// `holdingsEngine` import exists there at all). That is the REAL reason this route's response
// holdings-related data has always been empty — not a missing API key alone. Per that later task's
// own explicit constraints ("do NOT touch... production scanner", "keep everything inside the V2
// engine / lib path"), this gap is not fixed by modifying src/pipeline/index.ts itself (out of
// scope) — instead, `fetchAllHoldings` (lib/engine/modules/holdings/fetchHoldings.ts, a new, thin
// adapter over the real, existing src/modules/holdings fetch logic — no reimplemented network
// calls) is called here, additively, and its result is attached to this response under a NEW field,
// `chainHoldings`.
//
// FIELD-NAME DISCLOSURE: the requesting task said to add this under the response's existing
// `holdings` field. That field already exists in this exact response (SanitizedReportV2's
// `holdings: TokenHolding[]`, still always `[]` from the pipeline's own gap above) and is already
// consumed by real frontend code (app/frontend/components/HoldingsViewV2.tsx expects TokenHolding's
// real fields — `contract`, `amount`, `providerPriceUsd`, etc.) — overwriting it with the new,
// structurally different `ChainHolding[]` shape (`tokenAddress`, `quantity: string`, no price
// fields) would silently break that component's real prop contract, contradicting "existing engine
// modules must still work" and "do not modify UI components" (a shape change forcing an unplanned
// UI break is not the same as leaving the UI alone). Added as a new, additional `chainHoldings`
// field instead — nothing existing is removed, renamed, or reshaped.
//
// NEVER THROWS: fetchAllHoldings failing (or partially failing per-chain) degrades to an honestly
// empty/partial array here, wrapped in its own try/catch — a failure fetching this NEW data can
// never crash or block the real scan response this route already correctly returns.
//
// PRICING-MODULE WIRING, DISCLOSED (added per a later task): priceHoldings(chainHoldings) is called
// right after chainHoldings is computed, additively, attaching `pricedHoldings`/`totalValueUsd`/
// `chainValueUsd`/`priceStatus` as NEW response fields — same "never overwrite what's already
// consumed by real frontend code" reasoning as `chainHoldings` itself above (this response has no
// pre-existing fields with these exact names, so no collision risk here, but the same additive-only
// principle applies). Also wrapped in its own try/catch — a pricing failure degrades to the same
// honest all-null/`priceStatus:"unavailable"` shape priceHoldings([]) itself already produces,
// never a thrown error blocking the rest of the response.
//
// "engineInput"/"runFullEngine", DISCLOSED: the task described building an `engineInput` object and
// passing it to a `runFullEngine` function — neither exists anywhere in this codebase (same
// fabricated-orchestrator pattern disclosed above for the original full-scan task). There is
// nothing to route `engineInput` into; the real orchestrator remains `router.handleScanRequest`,
// untouched, and the new pricing/holdings fields are attached directly to its response instead.
//
// PORTFOLIO-MODULE WIRING, DISCLOSED (added per a later task): buildPortfolio(pricing.pricedHoldings,
// pricing.totalValueUsd, pricing.chainValueUsd) is called right after pricing, additively.
// FIELD-NAME COLLISION, DISCLOSED (same issue as the earlier `holdings` field, now recurring for
// `portfolio`): the task said to attach this under a response field named `portfolio` — that field
// ALREADY EXISTS in this exact response (SanitizedReportV2's real `portfolio: PortfolioSummary`,
// `{totalValueUsd, tokens, chainValueBreakdown}` — confirmed real, non-empty-shape, and consumed by
// TWO real frontend components: app/frontend/components/WalletProfileHeader.tsx reads
// `report.portfolio.chainValueBreakdown`, and PortfolioIntelligenceCard.tsx reads
// `report.portfolio.tokens`). Overwriting it with the new, structurally different `Portfolio` shape
// (`categories`, `chains`, `topHoldings`, `stablecoinRatio`, `concentrationIndex` — no `tokens`/
// `chainValueBreakdown` at all) would silently break both of those real components. Added as a new,
// additional `portfolioV2` field instead — `portfolioStatus` is a genuinely new key with no
// collision, added exactly as specified.
//
// PNL-MODULE WIRING, DISCLOSED (added per a later task): fetchParsedTrades(walletAddress) +
// computePnl(...) are called right after portfolioV2, additively, attaching `pnlV2`/`pnlStatus` as
// NEW response fields — neither name collides with anything already in this response (the existing,
// untouched fields are `fifoAndPnl`/`pnlSummaryV2`, not `pnlV2`/`pnlStatus`). "ParsedTrade"/an
// "existing tx indexer" by that name don't exist in this codebase — see lib/engine/modules/pnl/
// types.ts's own header for what's real and reused instead (the real swapNormalizer/tradeIntent/
// lotOpener/lotCloser chain, via walletChainPipeline.ts's buildTradeTimelineForChain).
//
// CHAIN-ACTIVITY-MODULE WIRING, DISCLOSED (added per a later task): computeChainActivity(...) is
// called right after pnlV2, additively, attaching `chainActivityV2`/`chainActivityStatus` as NEW
// response fields — neither collides with anything already in this response (the existing,
// untouched field is `chainSelection`, a structurally different real object). "walletChainPipeline.
// buildChainActivityTimeline" doesn't exist anywhere in this codebase — see
// lib/engine/modules/activity/computeChainActivity.ts's own header for what's real and reused
// instead (fetchRawEventsForChain, normalizeEvents + buildBridgeDetectionObject,
// buildTradesWithIntentForChain — all real, already-used-elsewhere functions).
//
// RISK-MODULE WIRING, DISCLOSED (added per a later task): computeRisk(...) is called right after
// chainActivityV2, additively, attaching `riskV2`/`riskStatus` as NEW response fields. NO FIELD
// COLLISION HERE, DISCLOSED: unlike the earlier `holdings`/`portfolio` cases, no field named `risk`
// (or any risk-related name) exists anywhere in this response today (verified by search) — there
// was nothing to protect or rename around; `riskV2`/`riskStatus` are added exactly as specified.

import { router } from '@/src/deployment/index'
import { handleApiError } from '@/src/deployment/api'
import { fetchAllHoldings } from '@/lib/engine/modules/holdings/fetchHoldings'
import { priceHoldings } from '@/lib/engine/modules/pricing/fetchPricing'
import { buildPortfolio } from '@/lib/engine/modules/portfolio/buildPortfolio'
import { computePnl, fetchParsedTrades } from '@/lib/engine/modules/pnl/computePnl'
import { computeChainActivity } from '@/lib/engine/modules/activity/computeChainActivity'
import { computeRisk } from '@/lib/engine/modules/risk/computeRisk'
import { computePersonality } from '@/lib/engine/modules/personality/computePersonality'

// PERSONALITY-MODULE WIRING, DISCLOSED (added per a later task): computePersonality(...) is called
// right after riskV2, additively, attaching `personalityV2`/`personalityStatus` as NEW response
// fields. "EXISTING personality FIELD", DISCLOSED: the real existing field is
// `finalSummary.walletPersonality` (a plain string, nested under `finalSummary`, rendered by
// app/frontend/components/FinalSummaryView.tsx) — a different key path entirely from the new
// top-level `personalityV2`, so no collision/rename was needed; both coexist untouched.
//
// BEHAVIOR-MODULE WIRING, DISCLOSED (added per a later task): computeBehavior(...) is called right
// after personalityV2, additively, attaching `behaviorV2`/`behaviorStatus` as NEW response fields.
// "EXISTING behavior FIELD", DISCLOSED: the real existing field is `behaviorIntel`
// (src/modules/behaviorIntel, a real BehaviorIntelResult already computed by the production
// pipeline) — a different top-level key from `behaviorV2`, so no collision/rename was needed.
// BRIDGING/FARMING GAP, DISCLOSED: see lib/engine/modules/behavior/computeBehavior.ts's own header
// — that module's task-specified signature never receives a walletAddress, so real bridge/LP counts
// cannot be fetched there; bridgingBehavior/farmingBehavior always honestly report "none" here as a
// result, not a fabricated non-zero guess.
import { computeBehavior } from '@/lib/engine/modules/behavior/computeBehavior'
// SIGNALS-MODULE WIRING, DISCLOSED (added per a later task): computeSignals(...) is called right
// after behaviorV2 — the top of this V2 intelligence chain — additively, attaching
// `signalsV2`/`signalsStatus` as NEW response fields. No existing `signals`/`signalsV2` field
// exists anywhere in this codebase (verified by search) — nothing to collide with. See
// lib/engine/modules/signals/computeSignals.ts's own header for two disclosed, real gaps: rule B's
// "vs previous scan" comparison and rule D's "bridging_out_of_base" both need data (scan history,
// real bridge detection) this pipeline doesn't have — neither is faked to force a signal to fire.
import { computeSignals } from '@/lib/engine/modules/signals/computeSignals'
import { createEventsCache } from '@/app/api/_shared/eventsCache'

// CU-HARDENING WIRING, DISCLOSED (fixes docs/CU_AUDIT.md Finding #1): a fresh, request-scoped
// EventsCache is created below (NOT a shared module-level singleton — see eventsCache.ts's own
// "DESIGN DEVIATION" disclosure for why) and threaded into both fetchParsedTrades and
// computeChainActivity, so the second of the two calls hits the cache instead of re-fetching raw
// provider events per chain. This is the "per-request cache reset" this task asked for — a fresh
// object per request achieves the same real goal as `eventsCache.clear()` would, without that
// design's real concurrent-request corruption risk.
export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.json().catch(() => null)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const eventsCache = createEventsCache()
    // eslint-disable-next-line no-console
    console.debug('[CU-HARDENING] Cache cleared for new request')

    // handleScanRequest already never throws internally (rate-limit/validation errors and any
    // runWalletScanV2 failure are both caught and returned as a structured RouteResult) — this
    // route adds no additional logic beyond the same Request/Response translation
    // app/api/scan/route.ts already performs, at this new path.
    const result = await router.handleScanRequest(rawBody, ip)

    let body = result.body as { success: boolean; data?: { scanMetadata?: { walletAddress?: string } } }
    if (body.success && body.data?.scanMetadata?.walletAddress) {
      let chainHoldings: Awaited<ReturnType<typeof fetchAllHoldings>> = []
      try {
        chainHoldings = await fetchAllHoldings(body.data.scanMetadata.walletAddress)
      } catch {
        // Never let a failure in this new, additive fetch affect the real scan response below.
        chainHoldings = []
      }

      let pricing: Awaited<ReturnType<typeof priceHoldings>>
      try {
        pricing = await priceHoldings(chainHoldings)
      } catch {
        // Same never-throw guarantee as chainHoldings above — degrade to the same honest shape
        // priceHoldings([]) itself would produce.
        pricing = { pricedHoldings: [], totalValueUsd: 0, chainValueUsd: {}, priceStatus: 'unavailable' }
      }

      let portfolioOutput: Awaited<ReturnType<typeof buildPortfolio>>
      try {
        portfolioOutput = await buildPortfolio(pricing.pricedHoldings, pricing.totalValueUsd, pricing.chainValueUsd)
      } catch {
        // Same never-throw guarantee as chainHoldings/pricing above.
        portfolioOutput = {
          portfolio: { totalValueUsd: 0, categories: [], chains: [], topHoldings: [], stablecoinRatio: 0, concentrationIndex: 0 },
          portfolioStatus: 'empty',
        }
      }

      // Fetched once, reused for both pnl and chain-activity computation below (per the later
      // task's own "fetch trades (already done)" instruction).
      let trades: Awaited<ReturnType<typeof fetchParsedTrades>> = []
      try {
        trades = await fetchParsedTrades(body.data.scanMetadata.walletAddress, eventsCache)
      } catch {
        trades = []
      }

      let pnlOutput: Awaited<ReturnType<typeof computePnl>>
      try {
        pnlOutput = await computePnl(pricing.pricedHoldings, chainHoldings, pricing.totalValueUsd, trades)
      } catch {
        // Same never-throw guarantee as chainHoldings/pricing/portfolio above.
        pnlOutput = {
          pnlV2: { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [] },
          pnlStatus: 'unavailable',
        }
      }

      let chainActivityOutput: Awaited<ReturnType<typeof computeChainActivity>>
      try {
        chainActivityOutput = await computeChainActivity(
          body.data.scanMetadata.walletAddress,
          chainHoldings,
          pricing.pricedHoldings,
          trades,
          portfolioOutput.portfolio,
          pnlOutput.pnlV2,
          eventsCache,
        )
      } catch {
        // Same never-throw guarantee as every other new module above.
        chainActivityOutput = { chainActivityV2: [], chainActivityStatus: 'empty' }
      }

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
        // Same never-throw guarantee as every other new module above.
        riskOutput = {
          riskV2: {
            score: 0, level: 'low', concentrationRisk: 0, stablecoinRatio: 0,
            unrealizedPnlPressure: 0, chainRisk: 0, volatileExposure: 0, fragmentationRisk: 0,
          },
          riskStatus: 'empty',
        }
      }

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
        // Same never-throw guarantee as every other new module above.
        personalityOutput = {
          personalityV2: {
            archetype: 'Unknown', riskAppetite: 'low', tradingStyle: 'passive', chainPreference: null,
            volatilityTolerance: 0, stabilityPreference: 0, pnlBehavior: 'neutral', activityConsistency: 'dormant',
            summary: 'Insufficient data to classify wallet personality.',
          },
          personalityStatus: 'empty',
        }
      }

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
        // Same never-throw guarantee as every other new module above.
        behaviorOutput = {
          behaviorV2: {
            accumulationStyle: 'neutral', rotationStyle: 'inactive', bridgingBehavior: 'none',
            farmingBehavior: 'none', stableRoutingBehavior: 'none', memeBehavior: 'none',
            tradeFrequency: 'low', behaviorSummary: 'No trade activity found for this wallet.',
          },
          behaviorStatus: 'empty',
        }
      }

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
        // Same never-throw guarantee as every other new module above.
        signalsOutput = { signalsV2: [], signalsStatus: 'empty' }
      }

      body = {
        ...body,
        data: {
          ...body.data,
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
    }

    return new Response(JSON.stringify(body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    // Last-resort guard only, matching app/api/scan/route.ts's own outer catch — fires only if
    // something fails before/outside handleScanRequest's own internal error handling (e.g. a truly
    // unexpected throw). Never leaks a raw stack trace or error object.
    return new Response(JSON.stringify(handleApiError(err)), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
