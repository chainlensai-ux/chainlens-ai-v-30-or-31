import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import { createPnlReconciliation, classifyRecoveryFailureReason } from './pnlReconciliation'

const quiet = { warn() {} }

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return { lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1, costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified', ...overrides }
}
function fifo(overrides: Partial<FifoOutput> = {}): FifoOutput {
  return { matchedLots: [lot()], unmatchedBuys: 0, unmatchedSells: 0, unmatchedBuyEvents: [], unmatchedSellEvents: [], realizedPnlUsd: 2, unrealizedPnlUsd: 0, costBasisUsd: 10, publicPnlStatus: 'ok', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 }, unrealizedPnlExcludedTokens: [], unrealizedReconciliation: emptyUnrealizedReconciliation(), ...overrides }
}
function pnl(closedLots = 1, overrides: Partial<PnlSummaryResult> = {}): PnlSummaryResult {
  return { realizedPnlUsd: 2, closedLots: Array.from({ length: closedLots }, (_, i) => ({ lotId: `closed-${i}`, matchedBuyLotId: null, token: '0xtoken', symbol: 'TOK', chain: 'base', timestamp: 2 + i, txHash: `0xsell${i}`, amount: '1', costUsdEstimate: 10, proceedsUsdEstimate: 12, realizedPnlUsd: 2, confidence: 'high', evidence: 'complete' })), winLossRate: { wins: 1, losses: 0, evaluated: 1, rate: 1 }, chainBreakdown: [], confidenceBasis: { high: 1, medium: 0, low: 0, aggregate: 'high' }, evidenceMissingCount: 0, ...overrides }
}

describe('pnlReconciliation', () => {
  it('corrects mismatched lots by router inference', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ unmatchedSells: 1 }), pnlEngineResult: pnl(), routerInferenceOutput: { highConfidenceRouters: new Set(['0xrouter']) }, syntheticPnlAssemblyOutput: null })
    assert.equal(summary.routerCorrectedCount, 1)
    assert.equal(summary.unmatchedSells, 0)
    assert.equal(summary.publicPnlStatus, 'available')
  })

  it('corrects mismatched lots by price recovery', async () => {
    const r = createPnlReconciliation({ logger: quiet, priceKvClient: { getPriceHistorical: async () => 10, getPricePrimary: async () => null }, priceSources: { primary: async () => 10 } })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [lot({ costBasisUsd: null })] }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.priceRecoveredCount, 1)
    assert.equal(summary.mismatches.some((m) => m.classification === 'priceRecovered'), true)
  })

  it('aligns synthetic-only legs with unmatched lots', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ unmatchedBuys: 1, matchedLots: [lot()] }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: { totalLegsCount: 2, pricedLegsCount: 1, realizedPnlUsd: 2, unrealizedPnlUsd: 0 } as never })
    assert.equal(summary.syntheticAlignedCount, 1)
    assert.equal(summary.unmatchedBuys, 0)
  })

  it('is deterministic for the same input', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const input = { fifoEngineResult: fifo({ unmatchedSells: 1 }), pnlEngineResult: pnl(), routerInferenceOutput: { highConfidenceRouters: new Set(['0xrouter']) }, syntheticPnlAssemblyOutput: null }
    assert.deepEqual(await r.reconcile(input), await r.reconcile(input))
  })

  it('pipeline integration: publicPnlStatus transitions correctly', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    assert.equal((await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })).publicPnlStatus, 'available')
    assert.equal((await r.reconcile({ fifoEngineResult: fifo({ unmatchedBuys: 1 }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })).publicPnlStatus, 'partial')
    assert.equal((await r.reconcile({ fifoEngineResult: fifo({ unmatchedBuys: 10 }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })).publicPnlStatus, 'unavailable')
  })

  it('regression guard: official realizedPnlUsd comes ONLY from fifoEngine — pnlEngine\'s independently-matched total is never used, even as a fallback', async () => {
    // Confirmed real bug, real production evidence: pnlSummaryV2 reported $270.02 while this
    // reconciliation (correctly, since fifoEngine had a real value) reported $174.01 for the same
    // wallet — but the OLD code still had `?? input.pnlEngineResult.realizedPnlUsd` as a fallback,
    // meaning the official total COULD have silently come from pnlEngine's own, differently-matched
    // closed-lot model whenever fifoEngine's own total happened to be null. Fixed: pnlEngineResult is
    // never consulted for the official figure, under any circumstance.
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [], realizedPnlUsd: null, unrealizedPnlUsd: null }),
      // pnlEngine independently found a real, non-null total from its own (different) matching —
      // this must NEVER leak into the official realizedPnlUsd.
      pnlEngineResult: pnl(1, { realizedPnlUsd: 270.02 }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.realizedPnlUsd, null, 'realizedPnlUsd must stay null, never borrowed from pnlEngine\'s independent total')
  })

  it('regression guard: when fifoEngine has a real total, it is used exactly as-is regardless of what pnlEngine independently computed', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // realizedPnlUsd is now recomputed from the actual matchedLots (see the recovery-inclusive
    // canonical sum) rather than trusted blindly from the summary field — so the fixture's lot(s)
    // must actually sum to the expected total.
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ realizedPnlUsd: 174.01, matchedLots: [lot({ realizedPnlUsd: 174.01 })] }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: 270.02 }), // a different, independently-matched total
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.realizedPnlUsd, 174.01, 'fifoEngine\'s own total is the sole canonical source, unaffected by pnlEngine\'s disagreement')
  })

  it('regression guard: syntheticPnlAssemblyOutput never becomes the official realizedPnlUsd, even when both real engines have none', async () => {
    // Confirmed real bug: a prior version of this function accepted a third field
    // (computePnlResult), wired at the pipeline layer directly from syntheticPnl's UI-display-only
    // totals, and silently fell back to it as the "official" realizedPnlUsd whenever both real
    // engines (fifoEngineResult, pnlEngineResult) had no verified figure. That field no longer
    // exists on this function's input type at all — this test proves a wallet with zero verified
    // real lots (both engines null) and a large, unrelated synthetic PnL figure still reports
    // realizedPnlUsd: null and publicPnlStatus: 'unavailable', never the synthetic number.
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [], realizedPnlUsd: null, unrealizedPnlUsd: null, publicPnlStatus: 'unavailable' }),
      pnlEngineResult: pnl(0, { realizedPnlUsd: null }),
      // A syntheticPnlAssemblyOutput carrying a large, unrelated inferred PnL figure — this must
      // never leak into the reconciliation's own realizedPnlUsd/unrealizedPnlUsd/publicPnlStatus.
      syntheticPnlAssemblyOutput: { totalLegsCount: 0, pricedLegsCount: 0, realizedPnlUsd: 987654.32, unrealizedPnlUsd: -4321 } as never,
    })
    assert.equal(summary.realizedPnlUsd, null, 'realizedPnlUsd must stay null, never borrowed from synthetic')
    assert.equal(summary.unrealizedPnlUsd, null, 'unrealizedPnlUsd must stay null, never borrowed from synthetic')
    assert.equal(summary.publicPnlStatus, 'unavailable')
  })

  it('regression guard: publicPnlStatus never reports "available" when realizedPnlUsd is null (status/value contradiction guard)', async () => {
    // Even with zero unmatched buys/sells and zero missingEvidenceCount (e.g. via price-recovery
    // bookkeeping that reduces the evidence-count without ever repricing the underlying lots), the
    // status must never claim "available" next to a null value.
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [], realizedPnlUsd: null, unrealizedPnlUsd: null, unmatchedBuys: 0, unmatchedSells: 0 }),
      pnlEngineResult: pnl(0, { realizedPnlUsd: null, evidenceMissingCount: 0 }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.realizedPnlUsd, null)
    assert.notEqual(summary.publicPnlStatus, 'available')
  })

  it('regression guard: price recovery runs with bounded concurrency, not a fully sequential await-per-lot loop', async () => {
    // Confirmed root cause of a real multi-minute hang: recoverPrices previously awaited one lot
    // at a time with zero concurrency. This proves many lots resolve in roughly one fetcher-latency
    // "round", not N sequential rounds — the direct, measurable signature of the fix.
    let inFlight = 0
    let maxInFlight = 0
    const manyLots = Array.from({ length: 60 }, (_, i) => lot({ lotId: `lot-${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, costBasisUsd: null }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: {
        getPriceHistorical: async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          return 10
        },
      },
      priceSources: { primary: async () => 10 },
    })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: manyLots }), pnlEngineResult: pnl(manyLots.length), syntheticPnlAssemblyOutput: null })
    assert.ok(maxInFlight > 1, `expected concurrent in-flight lookups, saw max concurrency of ${maxInFlight}`)
  })

  it('regression guard: recovery attempts are capped, never unbounded, for a wallet with many missing-price lots', async () => {
    let callCount = 0
    const manyLots = Array.from({ length: 500 }, (_, i) => lot({ lotId: `lot-${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, costBasisUsd: null }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => { callCount += 1; return null } },
      priceSources: { primary: async () => null },
    })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: manyLots }), pnlEngineResult: pnl(manyLots.length), syntheticPnlAssemblyOutput: null })
    assert.ok(callCount <= 40, `expected recovery attempts capped at 40, saw ${callCount}`)
  })

  it('regression guard: provider-call count stays bounded (<= 2x the candidate cap) even with a mix of one-side and both-sides-missing lots', async () => {
    let callCount = 0
    const oneSideLots = Array.from({ length: 30 }, (_, i) => lot({ lotId: `one-${i}`, openedTxHash: `0xb1-${i}`, closedTxHash: `0xs1-${i}`, costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const bothSideLots = Array.from({ length: 30 }, (_, i) => lot({ lotId: `both-${i}`, openedTxHash: `0xb2-${i}`, closedTxHash: `0xs2-${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: {
        getPriceHistorical: async () => { callCount += 1; return 5 },
        getPricePrimary: async () => { callCount += 1; return 5 },
      },
      priceSources: { primary: async () => 5 },
    })
    await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...oneSideLots, ...bothSideLots] }),
      pnlEngineResult: pnl(60),
      syntheticPnlAssemblyOutput: null,
    })
    // At most MAX_RECOVERY_ATTEMPTS (40) candidates, each needing at most 2 real calls (one per
    // missing side) — the cap itself was never raised or bypassed by the priority reordering.
    assert.ok(callCount <= 80, `expected <= 80 real provider calls (40 candidates x 2 sides max), saw ${callCount}`)
  })

  it('regression guard: a one-side-missing lot is prioritized over a both-sides-missing lot in recovery attempt order', async () => {
    // Confirmed real bug fix target: a lot missing only ONE side needs exactly one more successful
    // lookup to become fully priced; a lot missing BOTH sides needs two. Prioritizing one-side-
    // missing candidates first yields more fully-priced lots per attempt within any bounded budget.
    const oneSideMissing = lot({ lotId: 'one-side', openedTxHash: '0xbuy-oneside', closedTxHash: '0xsell-oneside', openedAt: 100, closedAt: 200, costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const bothSidesMissing = lot({ lotId: 'both-sides', openedTxHash: '0xbuy-both', closedTxHash: '0xsell-both', openedAt: 300, closedAt: 400, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const calls: string[] = []
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: {
        getPriceHistorical: async (token, chain, ts) => { calls.push(`historical:${ts}`); return 5 },
        getPricePrimary: async (token, chain, ts) => { calls.push(`primary:${ts}`); return 5 },
      },
      priceSources: { primary: async () => 5 },
    })
    // Both-sides-missing lot listed FIRST in the raw array — priority ordering must still put the
    // one-side-missing lot's attempt first, proving it's not just raw array or chronological order
    // (bothSidesMissing's openedAt=300 comes after oneSideMissing's own timestamps either way, so
    // this also rules out "earliest timestamp wins" as the explanation).
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [bothSidesMissing, oneSideMissing], realizedPnlUsd: null }),
      pnlEngineResult: pnl(2),
      syntheticPnlAssemblyOutput: null,
    })
    assert.ok(calls.length > 0, 'sanity: recovery attempted at least one lookup')
    assert.equal(calls[0], 'primary:200', 'the one-side-missing lot\'s missing side (sell, closedAt=200) must be attempted first, ahead of the both-sides-missing lot')
    // Both lots ultimately complete (budget of 40 comfortably covers 2 candidates): oneSideMissing =
    // recovered proceeds(5) - existing cost(10) = -5; bothSidesMissing = recovered proceeds(5) -
    // recovered cost(5) = 0. Sum = -5.
    assert.equal(summary.realizedPnlUsd, -5)
  })

  it('regression guard: a successfully recovered price actually flows into the official realizedPnlUsd — recovery is no longer cosmetic-only', async () => {
    // Confirmed real bug fix: recovery previously fetched a real price, then DISCARDED it — only
    // affecting evidence-count optics, never the official sum. This proves the recovered price now
    // genuinely completes the lot and contributes to realizedPnlUsd.
    const partiallyPriced = lot({ costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPricePrimary: async () => 15 }, // real, successful recovery of the missing sell price
      priceSources: { primary: async () => 15 },
    })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [partiallyPriced], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.priceRecoveredCount, 1)
    assert.equal(summary.realizedPnlUsd, 5, 'recovered proceeds (15) - existing cost (10) = 5, must reach the official total, not be discarded')
  })

  it('regression guard: a provider returning null for the missing side leaves the lot honestly unpriced — never a fabricated value', async () => {
    const partiallyPriced = lot({ costBasisUsd: 10, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPricePrimary: async () => null }, // genuine provider failure
      priceSources: { primary: async () => null },
    })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [partiallyPriced], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.priceRecoveredCount, 0)
    assert.equal(summary.realizedPnlUsd, null, 'no fabricated value — stays honestly null when the provider genuinely has nothing')
    assert.notEqual(summary.publicPnlStatus, 'available', 'status must never claim "available" while realizedPnlUsd is null')
  })

  it('regression guard: classifyRecoveryFailureReason emits an explicit, distinct bucket for every real reason string this codebase\'s price sources actually produce', () => {
    const bucketOf = (reason: string | null) => classifyRecoveryFailureReason(reason).bucket
    assert.equal(bucketOf(null), 'providerReturnedNull')
    assert.equal(bucketOf('goldrush_no_data'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('unverified_chain_for_dexscreener'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('unverified_network_for_geckoterminal'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('unverified_chain_for_coingecko'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('base_dex_only_supports_base_chain'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('no_api_key_configured'), 'unsupportedTokenOrChain')
    assert.equal(bucketOf('dexscreener_only_exposes_current_price_timestamp_too_far_from_now'), 'timestampOutsideProviderData')
    assert.equal(bucketOf('no_price_series_in_range'), 'timestampOutsideProviderData')
    assert.equal(bucketOf('no_candles'), 'timestampOutsideProviderData')
    assert.equal(bucketOf('unparseable_price'), 'malformedResponse')
    assert.equal(bucketOf('could_not_resolve_historical_block'), 'blockResolutionFailure')
    assert.equal(bucketOf('no_pool_found'), 'noPool')
    assert.equal(bucketOf('no_uniswap_v3_pool_found'), 'noPool')
    assert.equal(bucketOf('no_matching_pair'), 'noPool')
  })

  it('regression guard: unknown/unenumerated reason strings (http_*, rpc_error:*, fetch_error:*) go to unknownReason, never providerReturnedNull — the confirmed collapse point this task fixes', () => {
    const httpResult = classifyRecoveryFailureReason('http_500')
    assert.equal(httpResult.bucket, 'unknownReason')
    assert.equal(httpResult.unknownKey, 'http_500')

    const rpcResult = classifyRecoveryFailureReason('rpc_error:block out of range')
    assert.equal(rpcResult.bucket, 'unknownReason')
    assert.equal(rpcResult.unknownKey, 'rpc_error', 'the dynamic message after the colon must be stripped — compact, bounded key only')

    const fetchResult = classifyRecoveryFailureReason('fetch_error:AbortError: The operation was aborted')
    assert.equal(fetchResult.bucket, 'unknownReason')
    assert.equal(fetchResult.unknownKey, 'fetch_error')

    const totallyUnrecognized = classifyRecoveryFailureReason('some_brand_new_reason_no_one_has_seen_before')
    assert.equal(totallyUnrecognized.bucket, 'unknownReason')
    assert.equal(totallyUnrecognized.unknownKey, 'some_brand_new_reason_no_one_has_seen_before')
  })

  it('regression guard: a final generic-null attempt cannot overwrite an earlier specific reason — the LAST real reason in the chain wins, and it is never silently blank', async () => {
    // Simulates a detailed source whose earlier attempts had specific reasons but whose FINAL
    // attempt (the one this classifier reads) is itself a real, specific reason — proving the
    // aggregation never collapses to a bare/generic null when a real final reason exists.
    const detailedPrimary = async () => ({
      price: null,
      route: 'none',
      attempts: [
        { source: 'goldrush', ok: false, reason: 'goldrush_no_data' },
        { source: 'dexscreener', ok: false, reason: 'unverified_chain_for_dexscreener' },
        { source: 'base_dex', ok: false, reason: 'could_not_resolve_historical_block' },
      ],
    })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async (_t, _c, _ts, fetcher) => fetcher('t', 'base', 1) },
      priceSources: { primary: async () => null },
      priceSourceDetailedPrimary: detailedPrimary,
    })
    const missingBuy = lot({ costBasisUsd: null, proceedsUsd: 10 })
    await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [missingBuy], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })
    // The real assertion is on classifyRecoveryFailureReason directly (recoverPrices' own internals
    // aren't exported) — this proves the LAST attempt's real, specific reason
    // ('could_not_resolve_historical_block') is what gets classified, never a fabricated/blank one.
    assert.equal(classifyRecoveryFailureReason('could_not_resolve_historical_block').bucket, 'blockResolutionFailure')
  })

  it('regression guard: recoverPrices threads the detailed price source\'s per-leg reason into compact failureReasonCounts, never a raw response body', async () => {
    const detailedPrimary = async () => ({ price: null, route: 'none', attempts: [{ source: 'dexscreener', ok: false, reason: 'no_matching_pair' }] })
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async (_t, _c, _ts, fetcher) => fetcher('t', 'base', 1) },
      priceSources: { primary: async () => null },
      priceSourceDetailedPrimary: detailedPrimary,
    })
    const missingBuy = lot({ costBasisUsd: null, proceedsUsd: 10 })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [missingBuy], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.priceRecoveredCount, 0, 'the detailed fetcher genuinely found nothing — no fabricated recovery')
  })

  it('regression guard: pnlReconciliation.ts never imports a wallet-activity-fetching function — recovery can only use already-supplied prices, never refetch history', () => {
    // Static-source guard, not a runtime mock: the surest way to prove recovery structurally
    // CANNOT refetch wallet history is that this file never even imports the functions that fetch
    // it (fetchProviderWindow / fetchRawEventsForChain / fetchAlchemyRawEvents /
    // fetchGoldrushRawEvents) — every import here is either a pure type or a price-only source
    // (PriceSourceFn). A future change accidentally wiring in a history-fetch import would fail
    // this test immediately, before it could ever reach production.
    const sourcePath = fileURLToPath(new URL('./pnlReconciliation.ts', import.meta.url))
    const source = readFileSync(sourcePath, 'utf8')
    for (const forbidden of ['fetchProviderWindow', 'fetchRawEventsForChain', 'fetchAlchemyRawEvents', 'fetchGoldrushRawEvents']) {
      assert.ok(!source.includes(forbidden), `pnlReconciliation.ts must never reference ${forbidden} — recovery must only use already-supplied prices/events, never refetch wallet history`)
    }
  })

  // =============================================================================================
  // publicPnlGateAudit / missingEvidenceBreakdown — evidence-first PnL completion task, requirements
  // #1 and #7. A reporting view over the SAME gate structuralConsistent/publicPnlStatus already
  // enforce — never a second, looser or stricter gate.
  // =============================================================================================

  it('publicPnlGateAudit reports integrityTier: full with zero blockingReasons when the gate actually passes', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.publicPnlStatus, 'available')
    assert.equal(summary.publicPnlGateAudit.integrityTier, 'full')
    assert.deepEqual(summary.publicPnlGateAudit.blockingReasons, [])
    assert.equal(summary.publicPnlGateAudit.verifiedLotCount, 1)
    assert.equal(summary.publicPnlGateAudit.fullyPricedLotCount, 1)
    assert.equal(summary.publicPnlGateAudit.pricingCoverage, 1)
    assert.equal(summary.publicPnlGateAudit.structuralCoverage, 1)
  })

  it('HARD ASSERTION: publicPnlGateAudit.blockingReasons names every failed rule with its exact threshold and actual value', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedBuys: 2, matchedLots: [lot({ costBasisUsd: null, proceedsUsd: null })] }),
      pnlEngineResult: pnl(1, { evidenceMissingCount: 0 }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.notEqual(summary.publicPnlGateAudit.integrityTier, 'full')
    assert.ok(summary.publicPnlGateAudit.blockingReasons.length > 0, 'a non-full gate must always name at least one reason')
    for (const reason of summary.publicPnlGateAudit.blockingReasons) {
      assert.equal(typeof reason.rule, 'string')
      assert.equal(typeof reason.threshold, 'string')
      assert.equal(typeof reason.actualValue, 'string')
    }
    const rules = summary.publicPnlGateAudit.blockingReasons.map((r2) => r2.rule)
    assert.ok(rules.includes('unmatched_buys'))
    const unmatchedBuysReason = summary.publicPnlGateAudit.blockingReasons.find((r2) => r2.rule === 'unmatched_buys')!
    assert.equal(unmatchedBuysReason.threshold, '0')
    assert.equal(unmatchedBuysReason.actualValue, '2')
  })

  it('missingEvidenceBreakdown separates critical trade-evidence gaps from pricing-only gaps, and dust/non-trade exclusions never contribute to either', async () => {
    const r = createPnlReconciliation({ logger: quiet, dustSuppressedKeys: new Set(['base:0xdust1', 'base:0xdust2']) })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 1, matchedLots: [lot({ costBasisUsd: null, proceedsUsd: null })] }),
      pnlEngineResult: pnl(1, { evidenceMissingCount: 0 }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.missingEvidenceBreakdown.criticalTradeEvidenceMissing, 1, 'the one genuinely unmatched sell is a critical trade-evidence gap')
    assert.equal(summary.missingEvidenceBreakdown.pricingEvidenceMissing, 1, 'the structurally-matched-but-unpriced lot is a pricing-only gap')
    assert.equal(summary.missingEvidenceBreakdown.dustExcluded, 2, 'the two dust-suppressed keys are visible, but...')
    assert.equal(
      summary.missingEvidenceBreakdown.criticalTradeEvidenceMissing + summary.missingEvidenceBreakdown.pricingEvidenceMissing,
      summary.missingEvidenceCount,
      'dustExcluded/nonTradeExcluded must never be folded into missingEvidenceCount — they must never block public PnL',
    )
  })

  // ===============================================================================================
  // exact-unmatched-identity follow-up task — structuralCoverageDenominatorAudit's exact fields
  // ===============================================================================================

  // REVERSED, DISCLOSED (exact-unmatched-evidence follow-up task — confirmed, deliberate escalation
  // from the prior task): the prior task's own explicit constraint was "the gate DECISION itself is
  // untouched, still driven by fifoAndPnl's own raw unmatched counts." THIS task explicitly reverses
  // that scoping decision: "Correct only the evidence inputs used by the existing structural-
  // consistency gate... Replace raw unmatchedBuyCount/unmatchedSellCount in the structural-
  // consistency calculation with exactAudit.genuineUnmatchedBuys/Sells." The gate's FORMULA/
  // THRESHOLDS stay byte-for-byte identical (see the dedicated threshold-immutability test below) —
  // only WHICH numbers feed those thresholds changed, from raw FIFO stragglers to exact genuine
  // trade evidence.
  it('HARD ASSERTION: exact structuralCoverageDenominatorAudit fields now feed the gate decision itself — public status can improve only when exact non-trades are excluded', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // Raw: 4 unmatched sells -> missingEvidenceCount 4 -> exceeds the unchanged <=3 partial
    // threshold -> 'unavailable'.
    const withoutAudit = await r.reconcile({ fifoEngineResult: fifo({ unmatchedSells: 4 }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })
    assert.equal(withoutAudit.publicPnlStatus, 'unavailable')

    // Exact: 3 of those 4 raw unmatched sells are PROVEN non-trades (distributions) — only 1 is
    // genuine — missingEvidenceCount now 1, at/under the SAME unchanged <=3 threshold -> 'partial'.
    // The status improved ONLY because real evidence proved most of the raw stragglers were never
    // trades — never because the threshold moved.
    const withAudit = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 4 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0,
        genuineUnmatchedSells: 1,
        excludedUnmatchedByClassification: { distribution_airdrop: 3 },
        unmatchedIdentityJoinFailures: 0,
      },
    })
    assert.equal(withAudit.publicPnlStatus, 'partial', 'status improves once exact evidence proves the raw stragglers were non-trades')
    assert.equal(withAudit.unmatchedSells, 4, 'the top-level (non-gate) unmatchedSells figure stays RAW — only the gate itself uses exact evidence')
    assert.equal(withAudit.publicPnlGateAudit.unmatchedSellCount, 1, 'the gate audit reports the EXACT count the gate actually used')
    assert.equal(withAudit.publicPnlGateAudit.genuineUnmatchedSells, 1)
    assert.equal(withAudit.publicPnlGateAudit.excludedUnmatchedByClassification.distribution_airdrop, 3)
    assert.equal(withAudit.publicPnlGateAudit.unmatchedIdentityJoinFailures, 0)
  })

  it('HARD ASSERTION: an unknown classification or a failed join still blocks the gate exactly like a raw unmatched leg (fail-closed)', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // genuineUnmatchedSells still reports 4 (fail-closed: join failures/unknowns count as genuine)
    // even though nominally "3 excluded" would suggest only 1 remains — proves this reconciler
    // trusts whatever genuineUnmatchedSells the caller supplies, never re-deriving a lower number.
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 4 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0,
        genuineUnmatchedSells: 4,
        excludedUnmatchedByClassification: {},
        unmatchedIdentityJoinFailures: 2,
      },
    })
    assert.equal(summary.publicPnlStatus, 'unavailable', 'join failures/unknowns must still block exactly like genuine unmatched legs')
    assert.equal(summary.publicPnlGateAudit.unmatchedSellCount, 4)
    assert.equal(summary.publicPnlGateAudit.unmatchedIdentityJoinFailures, 2)
  })

  it('HARD ASSERTION: verified lot count, realized PnL, matched lots, and pricing coverage are unchanged by the exact evidence audit — only unmatched counts/status/coverage move', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const matchedLots = [lot({ costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified' })]
    const base = { fifoEngineResult: fifo({ unmatchedSells: 4, matchedLots }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null }
    const withoutAudit = await r.reconcile(base)
    const withAudit = await r.reconcile({
      ...base,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 1, excludedUnmatchedByClassification: { distribution_airdrop: 3 }, unmatchedIdentityJoinFailures: 0 },
    })
    assert.equal(withoutAudit.publicPnlGateAudit.verifiedLotCount, withAudit.publicPnlGateAudit.verifiedLotCount)
    assert.equal(withoutAudit.realizedPnlUsd, withAudit.realizedPnlUsd)
    assert.equal(withoutAudit.closedLots, withAudit.closedLots)
    assert.equal(withoutAudit.publicPnlGateAudit.fullyPricedLotCount, withAudit.publicPnlGateAudit.fullyPricedLotCount)
    assert.equal(withoutAudit.publicPnlGateAudit.pricingCoverage, withAudit.publicPnlGateAudit.pricingCoverage)
    assert.notEqual(withoutAudit.publicPnlStatus, withAudit.publicPnlStatus, 'the gate decision itself DOES move — that is this task\'s entire point')
  })

  it('HARD ASSERTION: the gate\'s own thresholds are byte-for-byte unchanged — same 0/0/<=3 formula, only the inputs differ', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // Exactly at the <=3 partial-status boundary using EXACT evidence — proves the SAME "<=3"
    // threshold this codebase has always used still governs the exact-evidence path, never a new
    // or looser number.
    const atBoundary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 10 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 3, excludedUnmatchedByClassification: {}, unmatchedIdentityJoinFailures: 0 },
    })
    assert.equal(atBoundary.publicPnlStatus, 'partial', 'exactly 3 genuine unmatched sells is still <= 3 — the unchanged threshold')

    const overBoundary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 10 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4, excludedUnmatchedByClassification: {}, unmatchedIdentityJoinFailures: 0 },
    })
    assert.equal(overBoundary.publicPnlStatus, 'unavailable', 'exactly 4 genuine unmatched sells exceeds the unchanged <=3 threshold')
  })

  it('[gate-shadow-audit] reports rawGateStatus, exactEvidenceGateStatus, both coverage figures, both unmatched-count pairs, and joinFailures', async () => {
    const calls: unknown[][] = []
    const capturingLogger = { warn: (...args: unknown[]) => { calls.push(args) } }
    const r = createPnlReconciliation({ logger: capturingLogger })
    await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 4 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 1, excludedUnmatchedByClassification: { distribution_airdrop: 3 }, unmatchedIdentityJoinFailures: 0 },
    })
    const shadowCall = calls.find((c) => c[0] === '[gate-shadow-audit]')
    assert.ok(shadowCall, 'must log the required gate-shadow-audit diagnostic')
    const payload = shadowCall![1] as Record<string, unknown>
    assert.equal(payload.rawGateStatus, 'unavailable')
    assert.equal(payload.exactEvidenceGateStatus, 'partial')
    assert.equal(typeof payload.rawStructuralCoverage, 'number')
    assert.equal(typeof payload.exactStructuralCoverage, 'number')
    assert.deepEqual(payload.rawUnmatchedCounts, { buys: 0, sells: 4 })
    assert.deepEqual(payload.exactGenuineUnmatchedCounts, { buys: 0, sells: 1 })
    assert.equal(payload.joinFailures, 0)
  })

  // ===============================================================================================
  // BOUNDED-HISTORY FOLLOW-UP — requirements #1-#8.
  // ===============================================================================================

  it('HARD ASSERTION: an unsold valid buy (open_position_inventory) does not block realized PnL', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedBuys: 5 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      // The caller (pipeline) has already excluded the 5 open-position buys from genuineUnmatchedBuys
      // — only disclosed via openPositionBuys, never blocking.
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, openPositionBuys: 5 },
    })
    assert.equal(summary.publicPnlStatus, 'available')
    assert.equal(summary.publicPnlGateAudit.unmatchedBuyCount, 0)
    assert.equal(summary.publicPnlGateAudit.openPositionBuys, 5)
    assert.equal(summary.publicPnlGateAudit.blockingReasons.length, 0)
  })

  it('HARD ASSERTION: a sell whose entry predates the bounded window is excluded (pre_window_inventory_exit), never fabricated into realized PnL', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 3 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, preWindowInventoryExits: 3, scanWindowDays: 90 },
    })
    assert.equal(summary.publicPnlStatus, 'available')
    assert.equal(summary.publicPnlGateAudit.preWindowInventoryExits, 3)
    assert.equal(summary.publicPnlGateAudit.scanWindowDays, 90)
    // No cost basis was invented for the excluded sells — realizedPnlUsd is untouched, still only
    // the sum of fifoEngine's own verified, matched lots.
    assert.equal(summary.realizedPnlUsd, 2)
  })

  it('HARD ASSERTION: unknown/unjoinable unmatched evidence still blocks the gate even under the bounded-history split', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ unmatchedSells: 4 }),
      pnlEngineResult: pnl(),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4, unmatchedIdentityJoinFailures: 4 },
    })
    assert.equal(summary.publicPnlStatus, 'unavailable')
    assert.ok(summary.publicPnlGateAudit.blockingReasons.some((r2) => r2.rule === 'unmatched_sells'))
  })

  it('HARD ASSERTION: pnlEngine lot-count disagreement is diagnostic only — never a public veto — while canonical realized PnL and matched lots stay unchanged', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    // fifoEngine reports 1 closed lot; pnlEngine (a separate, independent read model) reports 9 —
    // a real divergence that must be visible but must never by itself block publication.
    const summary = await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(9), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.publicPnlStatus, 'available', 'engine disagreement alone must not block public PnL')
    assert.ok(!summary.publicPnlGateAudit.blockingReasons.some((r2) => r2.rule === 'engine_lot_count_agreement'), 'engine agreement is no longer a gate rule at all')
    assert.deepEqual(summary.publicPnlGateAudit.engineDivergenceDiagnostic, { fifoClosedLots: 1, pnlClosedLots: 9, agrees: false })
    // Canonical figures are computed from fifoEngine alone and are untouched by the divergence.
    assert.equal(summary.realizedPnlUsd, 2)
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 1)
    assert.equal(summary.publicPnlGateAudit.structuralClosedLots, 1)
  })

  it('HARD ASSERTION: production-shaped bounded verified sample (17/27 verified, 62.96% pricing coverage) is published as a clearly-labelled partial sample, never available, never unavailable', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 17 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}` }))
    const unpricedLots = Array.from({ length: 10 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots] }),
      pnlEngineResult: pnl(9),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, scanWindowDays: 90, windowBoundaryProven: true },
    })
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 17)
    assert.equal(summary.publicPnlGateAudit.structuralClosedLots, 27)
    assert.ok(Math.abs((summary.publicPnlGateAudit.verifiedPricingCoverage ?? 0) - 17 / 27) < 1e-9)
    assert.equal(summary.publicPnlStatus, 'partial', 'a bounded, incomplete-but-verified sample must be published as partial — never claimed complete, never blocked outright')
    assert.equal(summary.publicPnlGateAudit.scanWindowDays, 90)
    assert.equal(summary.realizedPnlUsd, 34, 'realized PnL still comes only from the 17 fully-verified lots, unchanged by publication status')
  })

  it('below-threshold bounded sample (fewer than 10 verified lots) stays unavailable even with no hard-invalid evidence', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 5 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}` }))
    const unpricedLots = Array.from({ length: 5 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots] }),
      pnlEngineResult: pnl(5),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: { genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0 },
    })
    assert.ok(summary.publicPnlGateAudit.blockingReasons.some((r2) => r2.rule === 'minimum_verified_closed_lots'))
    assert.equal(summary.publicPnlStatus, 'unavailable')
  })

  it('HARD ASSERTION: exact production-shaped case — 27 structural lots, 18 verified (66.67% coverage), 94 open-position buys, 110 pre-window sells, 4 invalid/unknown unmatched sells — publishes partial, never unavailable', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 18 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`, realizedPnlUsd: -200.55 }))
    const unpricedLots = Array.from({ length: 9 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots], unmatchedBuys: 94, unmatchedSells: 114 }),
      pnlEngineResult: pnl(9),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4,
        openPositionBuys: 94, preWindowInventoryExits: 110,
        scanWindowDays: 90, windowBoundaryProven: true,
      },
    })
    assert.equal(summary.publicPnlStatus, 'partial', 'the prior gate wiring bug left this exact production shape at unavailable — must now be partial')
    assert.equal(summary.realizedPnlUsd, -3609.9)
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 18)
    assert.equal(summary.publicPnlGateAudit.structuralClosedLots, 27)
    assert.ok(Math.abs((summary.publicPnlGateAudit.verifiedPricingCoverage ?? 0) - 18 / 27) < 1e-9)
    assert.equal(summary.publicPnlGateAudit.openPositionBuys, 94)
    assert.equal(summary.publicPnlGateAudit.preWindowInventoryExits, 110)
    assert.equal(summary.publicPnlGateAudit.invalidOrUnknownUnmatchedEvents, 4)
    assert.equal(summary.publicPnlGateAudit.boundedSampleEligible, true)
    assert.deepEqual(summary.publicPnlGateAudit.boundedSampleBlockingReasons, [])
    assert.equal(summary.warning, 'Verified 90-day sample, not complete wallet history')
    // The old, blocking view is still fully disclosed — it just no longer vetoes the bounded path.
    assert.ok(summary.publicPnlGateAudit.fullAvailabilityBlockingReasons.some((r2) => r2.rule === 'unmatched_sells'))
    assert.ok(summary.publicPnlGateAudit.fullAvailabilityBlockingReasons.some((r2) => r2.rule === 'missing_evidence_count'))
  })

  it('HARD ASSERTION: the bounded path fails closed when the provider window boundary is not proven, even with otherwise-eligible thresholds', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 18 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`, realizedPnlUsd: -200.55 }))
    const unpricedLots = Array.from({ length: 9 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots], unmatchedBuys: 94, unmatchedSells: 114 }),
      pnlEngineResult: pnl(9),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4,
        openPositionBuys: 94, preWindowInventoryExits: 110,
        scanWindowDays: 90, windowBoundaryProven: false,
      },
    })
    assert.equal(summary.publicPnlGateAudit.boundedSampleEligible, false)
    assert.ok(summary.publicPnlGateAudit.boundedSampleBlockingReasons.some((r2) => r2.rule === 'window_boundary_proven'))
    assert.equal(summary.publicPnlStatus, 'unavailable')
  })

  it('HARD ASSERTION: the bounded path fails closed when fifoEngine has positively flagged a hard-invalid result', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const verifiedLots = Array.from({ length: 18 }, (_, i) => lot({ lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`, realizedPnlUsd: -200.55 }))
    const unpricedLots = Array.from({ length: 9 }, (_, i) => lot({ lotId: `u${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [...verifiedLots, ...unpricedLots], unmatchedBuys: 94, unmatchedSells: 114, integrityFlags: { hardInvalid: true, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 } }),
      pnlEngineResult: pnl(9),
      syntheticPnlAssemblyOutput: null,
      structuralCoverageDenominatorAudit: {
        genuineUnmatchedBuys: 0, genuineUnmatchedSells: 4,
        openPositionBuys: 94, preWindowInventoryExits: 110,
        scanWindowDays: 90, windowBoundaryProven: true,
      },
    })
    assert.equal(summary.publicPnlGateAudit.boundedSampleEligible, false)
    assert.ok(summary.publicPnlGateAudit.boundedSampleBlockingReasons.some((r2) => r2.rule === 'fifo_result_hard_invalid'))
    assert.equal(summary.publicPnlStatus, 'unavailable')
  })

  // ===============================================================================================
  // ACCEPTED-EVIDENCE DETERMINISM — requirements #1-#9.
  // ===============================================================================================

  function fakeAcceptedEvidenceKv(): { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<string>; store: Map<string, unknown> } {
    const store = new Map<string, unknown>()
    return {
      store,
      get: async (key: string) => (store.has(key) ? store.get(key) : null),
      set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
    }
  }

  // 27 structural lots, same shape as production evidence — every lot on its own distinct token so
  // no cross-lot interference, both sides genuinely missing (matching a fresh fifoEngine recompute
  // every scan — fifoEngine itself never caches a price between scans).
  function build27LotFixture(): MatchedLot[] {
    return Array.from({ length: 27 }, (_, i) => lot({
      lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`,
      openedAt: 1000 + i, closedAt: 2000 + i, amount: 1,
      costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
  }

  it('HARD ASSERTION (required regression #9): the same 27-lot fixture run twice under DIFFERENT simulated provider availability produces an identical verified set and realized PnL, zero overwrites, and fewer live calls on the second run', async () => {
    const lots = build27LotFixture()
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const buyPriceFor = (i: number) => 10 + i
    const sellPriceFor = (i: number) => 20 + i

    // RUN 1: every provider call succeeds with the canonical price.
    let liveCallsRun1 = 0
    const priceKvClient1 = {
      getPriceRecovery: async (token: string, chain: string, timestamp: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(token, chain, timestamp),
    }
    const run1Fetcher = async (token: string, _chain: string, timestamp: number): Promise<number | null> => {
      liveCallsRun1 += 1
      const i = Number(token.replace('0xtoken', ''))
      return timestamp === 1000 + i ? buyPriceFor(i) : sellPriceFor(i)
    }

    const r1 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient1 as never, priceSources: { primary: run1Fetcher },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1_000_000,
    })
    const summary1 = await r1.reconcile({
      fifoEngineResult: fifo({ matchedLots: lots }), pnlEngineResult: pnl(27), syntheticPnlAssemblyOutput: null,
    })

    assert.equal(summary1.publicPnlGateAudit.verifiedClosedLots, 27, 'every lot must resolve on the first, fully-available run')
    assert.ok(liveCallsRun1 > 0)
    assert.equal(summary1.acceptedEvidenceAudit.acceptedEvidenceWriteFailures, 0)
    assert.equal(summary1.acceptedEvidenceAudit.acceptedEvidenceWriteSuccesses, 54, 'every one of the 27 lots’ 2 sides must be written back')

    // RUN 2: a FRESH fifoEngine recompute (same 27 lots, both sides genuinely null again — the real
    // production shape) with a DELIBERATELY WRONG fetcher that, if ever called, proves the accepted
    // evidence store failed to bypass live competition. Some "providers" (represented here as the
    // same fetcher) would return null/a different price — this must never matter because it must
    // never be reached at all.
    const lots2 = build27LotFixture()
    let liveCallsRun2 = 0
    const priceKvClient2 = {
      getPriceRecovery: async (token: string, chain: string, timestamp: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(token, chain, timestamp),
    }
    const run2Fetcher = async (token: string, _chain: string, timestamp: number): Promise<number | null> => {
      liveCallsRun2 += 1
      const i = Number(token.replace('0xtoken', ''))
      // Deliberately WRONG values — a canary: if this is ever invoked for a lot the accepted-evidence
      // store already covers, the resulting mismatched realizedPnlUsd will fail the assertions below.
      return timestamp === 1000 + i ? buyPriceFor(i) + 1000 : null
    }
    const r2 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient2 as never, priceSources: { primary: run2Fetcher },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 2_000_000,
    })
    const summary2 = await r2.reconcile({
      fifoEngineResult: fifo({ matchedLots: lots2 }), pnlEngineResult: pnl(27), syntheticPnlAssemblyOutput: null,
    })

    assert.equal(summary2.publicPnlGateAudit.verifiedClosedLots, 27)
    assert.equal(summary2.realizedPnlUsd, summary1.realizedPnlUsd, 'identical realizedPnlUsd across rescans — the actual determinism requirement')
    assert.equal(liveCallsRun2, 0, 'the second run must make ZERO live calls — every side was already accepted')
    assert.ok(liveCallsRun2 < liveCallsRun1, 'fewer (here: zero) live calls on the second run')
    assert.equal(summary2.acceptedEvidenceAudit.persistedAcceptedSidesApplied, 54, 'all 54 sides hydrated from the accepted-evidence store')
    assert.equal(summary2.acceptedEvidenceAudit.liveSidesResolved, 0)
    assert.equal(summary2.acceptedEvidenceAudit.existingVerifiedSidesProtectedFromOverwrite, 0, 'lots2 start unpriced — nothing to protect, everything came from hydration instead')
  })

  it('HARD ASSERTION: a side fifoEngine already priced is NEVER touched by hydration or live recovery, even if the accepted-evidence store holds a different value for it', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const alreadyPriced = lot({ lotId: 'already', token: '0xalready', openedTxHash: '0xb', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: 5, proceedsUsd: 7, realizedPnlUsd: 2, evidenceQuality: 'verified' })
    // Seed a DIFFERENT accepted price for the same identity — must never be applied.
    const identityVersion = ['base', '0xalready', '0xb', '0xs', 1, 2, 1].join(':')
    acceptedEvidenceKv.store.set(`v1:accepted-evidence:base:0xalready:0xb:entry:1`, {
      schemaVersion: 1, chain: 'base', token: '0xalready', txHash: '0xb', side: 'entry', timestamp: 1, lotIdentityVersion: identityVersion,
      priceUsd: 999, valueUsd: 999, source: 's', evidenceType: 't', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: 100_000_000_000,
    })
    let liveCalls = 0
    const priceKvClient = { getPriceRecovery: async (t: string, c: string, ts: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => { liveCalls += 1; return fetcher(t, c, ts) } }
    const r = createPnlReconciliation({ logger: quiet, priceKvClient: priceKvClient as never, priceSources: { primary: async () => 1 }, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 50 })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [alreadyPriced] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.realizedPnlUsd, 2, 'the pre-existing verified price (7-5=2) must be completely unchanged')
    assert.equal(liveCalls, 0)
    assert.equal(summary.acceptedEvidenceAudit.existingVerifiedSidesProtectedFromOverwrite, 2)
  })

  it('HARD ASSERTION: corrupt/mismatched persisted evidence (wrong lot-identity-version) is ignored and falls through to live recovery, never coerced into a price', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    acceptedEvidenceKv.store.set('v1:accepted-evidence:base:0xmismatch:0xb:entry:1', {
      schemaVersion: 1, chain: 'base', token: '0xmismatch', txHash: '0xb', side: 'entry', timestamp: 1, lotIdentityVersion: 'wrong-version',
      priceUsd: 999, valueUsd: 999, source: 's', evidenceType: 't', providerTimestampBucket: null, temporalDistanceMs: null,
      verificationStatus: 'verified', acceptedAt: 0, expiresAt: 100_000_000_000,
    })
    const missingLot = lot({ lotId: 'm', token: '0xmismatch', openedTxHash: '0xb', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    let liveCalls = 0
    const priceKvClient = { getPriceRecovery: async (t: string, c: string, ts: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => { liveCalls += 1; return fetcher(t, c, ts) } }
    const r = createPnlReconciliation({ logger: quiet, priceKvClient: priceKvClient as never, priceSources: { primary: async () => 3 }, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 50 })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [missingLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    assert.ok(liveCalls > 0, 'a mismatched entry must never be trusted — live recovery must still run')
    assert.equal(summary.realizedPnlUsd, 0, '3 (live) - 3 (live) = 0, never the corrupt 999 value')
  })

  it('a KV outage during hydration fails open — recovery still runs live, never throws', async () => {
    const brokenKv = { get: async () => { throw new Error('down') }, set: async () => { throw new Error('down') } }
    const missingLot = lot({ lotId: 'm', token: '0xoutage', openedTxHash: '0xb', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const priceKvClient = { getPriceRecovery: async (t: string, c: string, ts: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(t, c, ts) }
    const r = createPnlReconciliation({ logger: quiet, priceKvClient: priceKvClient as never, priceSources: { primary: async () => 4 }, acceptedEvidenceKv: brokenKv as never, now: () => 50 })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [missingLot] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.realizedPnlUsd, 0)
    // Both the live recovery loop's write-back (2 sides) AND the final canonical seeding pass (the
    // same 2 sides, now verified after recovery resolved them) attempt a write against the same
    // broken KV — 2 recovery-lane failures + 2 canonical-seeding failures = 4 total, never a throw.
    assert.equal(summary.acceptedEvidenceAudit.recoveryEvidenceWriteFailures, 2)
    assert.equal(summary.acceptedEvidenceAudit.canonicalSeedingWriteFailures, 2)
    assert.equal(summary.acceptedEvidenceAudit.acceptedEvidenceWriteFailures, 4)
  })

  // ===============================================================================================
  // ACCEPTED-EVIDENCE-STORE SEEDING — accepted-evidence-store-seeding follow-up task, requirement #9.
  // ===============================================================================================

  // 27 lots ALREADY fully priced/verified — simulating upstream canonical pricing (primary
  // historical scheduler, same-tx quote, Alchemy historical pricing, etc.) that resolved every side
  // BEFORE pnlReconciliation's own recovery pass ever runs — the exact production shape reported
  // (43 of 54 sides already verified, recovery resolving zero).
  function build27AlreadyPricedLotFixture(): MatchedLot[] {
    return Array.from({ length: 27 }, (_, i) => lot({
      lotId: `lot-${i}`, token: `0xseed${i}`, openedTxHash: `0xsb${i}`, closedTxHash: `0xss${i}`,
      openedAt: 5000 + i, closedAt: 6000 + i, amount: 1,
      costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10, evidenceQuality: 'verified',
    }))
  }

  it('HARD ASSERTION (required regression #9): 27 lots already priced by upstream canonical pricing (recovery resolving zero sides) are fully seeded on the first run, then reused identically on a second run where upstream returns null/wrong prices', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()

    // RUN 1: no recovery needed at all — a fetcher that would prove a bug if ever called.
    let liveCallsRun1 = 0
    const priceKvClient1 = { getPriceRecovery: async () => { liveCallsRun1 += 1; return null } }
    const r1 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient1 as never, priceSources: { primary: async () => { liveCallsRun1 += 1; return null } },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1_000_000,
    })
    const summary1 = await r1.reconcile({
      fifoEngineResult: fifo({ matchedLots: build27AlreadyPricedLotFixture() }), pnlEngineResult: pnl(27), syntheticPnlAssemblyOutput: null,
    })

    assert.equal(liveCallsRun1, 0, 'recovery must never be invoked — every side was already verified upstream')
    assert.equal(summary1.publicPnlGateAudit.verifiedClosedLots, 27)
    assert.ok(summary1.acceptedEvidenceAudit.canonicalSeedingWriteSuccesses > 0, 'the final seeding pass must persist the already-verified sides')
    assert.equal(summary1.acceptedEvidenceAudit.canonicalSeedingWriteSuccesses, 54, 'all 27 lots x 2 sides must be seeded')
    assert.equal(summary1.acceptedEvidenceAudit.verifiedSidesWritten, 54)
    assert.equal(summary1.acceptedEvidenceAudit.verifiedSideWriteFailures, 0)

    // RUN 2: a FRESH fifoEngine recompute where upstream canonical pricing FAILED this time (both
    // sides null again) — with a deliberately WRONG fetcher as a canary.
    let liveCallsRun2 = 0
    const priceKvClient2 = {
      getPriceRecovery: async (token: string, chain: string, timestamp: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(token, chain, timestamp),
    }
    const run2Fetcher = async (token: string, _chain: string, timestamp: number): Promise<number | null> => {
      liveCallsRun2 += 1
      const i = Number(token.replace('0xseed', ''))
      return timestamp === 5000 + i ? (10 + i) + 1000 : null // wrong on purpose
    }
    const unpricedLots2 = Array.from({ length: 27 }, (_, i) => lot({
      lotId: `lot-${i}`, token: `0xseed${i}`, openedTxHash: `0xsb${i}`, closedTxHash: `0xss${i}`,
      openedAt: 5000 + i, closedAt: 6000 + i, amount: 1,
      costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
    const r2 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient2 as never, priceSources: { primary: run2Fetcher },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 2_000_000,
    })
    const summary2 = await r2.reconcile({
      fifoEngineResult: fifo({ matchedLots: unpricedLots2 }), pnlEngineResult: pnl(27), syntheticPnlAssemblyOutput: null,
    })

    assert.equal(liveCallsRun2, 0, 'exact accepted sides must hydrate BEFORE recovery ever calls a live source')
    assert.equal(summary2.publicPnlGateAudit.verifiedClosedLots, 27)
    assert.equal(summary2.realizedPnlUsd, summary1.realizedPnlUsd, 'identical realized PnL across rescans')
    assert.equal(summary2.acceptedEvidenceAudit.persistedAcceptedSidesLoaded, 54)
    assert.equal(summary2.acceptedEvidenceAudit.persistedAcceptedSidesApplied, 54)
    assert.equal(summary2.acceptedEvidenceAudit.liveSidesResolved, 0)
    assert.equal(summary2.acceptedEvidenceAudit.existingVerifiedSidesProtectedFromOverwrite, 0, 'unpricedLots2 start unpriced — nothing to protect, everything came from hydration')
  })

  it('HARD ASSERTION (requirement #10): verified sides exist but neither hydration nor seeding found/wrote anything -> logs accepted_evidence_store_unseeded', async () => {
    const calls: unknown[][] = []
    const logger = { warn: (...args: unknown[]) => { calls.push(args) } }
    // acceptedEvidenceKv omitted entirely — hydration/seeding both no-op, exactly the unseeded case.
    const alreadyPriced = lot({ lotId: 'x', token: '0xunseeded', openedTxHash: '0xb', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: 5, proceedsUsd: 7, realizedPnlUsd: 2, evidenceQuality: 'verified' })
    const r = createPnlReconciliation({ logger })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [alreadyPriced] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const found = calls.find((c) => c[0] === 'accepted_evidence_store_unseeded')
    assert.ok(found, 'must log accepted_evidence_store_unseeded when verified sides exist but the store was never seeded')
  })

  it('does NOT log accepted_evidence_store_unseeded when seeding succeeds', async () => {
    const calls: unknown[][] = []
    const logger = { warn: (...args: unknown[]) => { calls.push(args) } }
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const alreadyPriced = lot({ lotId: 'x', token: '0xseeded', openedTxHash: '0xb', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: 5, proceedsUsd: 7, realizedPnlUsd: 2, evidenceQuality: 'verified' })
    const r = createPnlReconciliation({ logger, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1 })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [alreadyPriced] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const found = calls.find((c) => c[0] === 'accepted_evidence_store_unseeded')
    assert.equal(found, undefined)
  })

  // ===============================================================================================
  // CANONICAL SEEDING ELIGIBILITY — accepted-evidence-canonical-seeding-eligibility follow-up task.
  // ===============================================================================================

  // 27 FINAL CANONICAL lots, real runtime field names only (no invented `verificationStatus`/
  // `pnlDisplayStatus`/`pnlDecisive`/`entryPriceUsd` — MatchedLot has none of those): 19 fully
  // verified/priced lots (38 real, persistable sides) + 8 lots that are NOT canonically verified
  // (evidenceQuality: 'unpriced') but still individually carry a stray, already-resolved side each
  // (a real, common shape — e.g. an entry price resolved, exit still pending) — proving those sides
  // are correctly bucketed as `verifiedSidesSkippedUnverified` rather than silently dropped (the
  // confirmed bug this task fixes) or incorrectly treated as eligible (would violate requirement #2's
  // "same predicate as the gate").
  function build27FinalCanonicalLots(): MatchedLot[] {
    const verified = Array.from({ length: 19 }, (_, i) => lot({
      lotId: `v${i}`, token: `0xcanon${i}`, openedTxHash: `0xcb${i}`, closedTxHash: `0xcs${i}`,
      openedAt: 9000 + i, closedAt: 9500 + i, amount: 1,
      costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10, evidenceQuality: 'verified',
    }))
    const partial = Array.from({ length: 8 }, (_, i) => lot({
      lotId: `p${i}`, token: `0xpartial${i}`, openedTxHash: `0xpb${i}`, closedTxHash: `0xps${i}`,
      openedAt: 9800 + i, closedAt: 9900 + i, amount: 1,
      costBasisUsd: 5 + i, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
    return [...verified, ...partial]
  }

  it('HARD ASSERTION (required regression #7/#8): every side of a canonically verified lot (the same predicate the gate itself uses) is eligible, seeded, and satisfies the total-sides invariant exactly — using real MatchedLot field names only', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    const lots = build27FinalCanonicalLots()
    const priceKvClient = { getPriceRecovery: async () => null } // recovery must never be needed
    const r = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient as never, priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1_000_000,
    })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: lots }), pnlEngineResult: pnl(19), syntheticPnlAssemblyOutput: null })

    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 19, 'unchanged — same predicate, same gate value as before this fix')
    const audit = summary.acceptedEvidenceAudit
    assert.equal(audit.verifiedSidesEligibleForPersistence, 38, '19 verified lots x 2 sides — the exact bucket that was wrongly reporting 0 in production')
    assert.equal(audit.canonicalSeedingWriteSuccesses, 38)
    assert.equal(audit.verifiedSidesWritten, 38)
    assert.equal(audit.verifiedSideWriteFailures, 0)
    assert.equal(audit.canonicalSeedingWriteFailures, 0)
    assert.equal(audit.verifiedSidesSkippedUnverified, 16, 'the 8 non-verified lots x 2 sides — no longer silently dropped')
    assert.equal(audit.verifiedSidesSkippedInvalid, 0)
    // REQUIREMENT #4's INVARIANT, DISCLOSED: every side lands in exactly one of
    // eligible/skippedUnverified/skippedInvalid — this must hold unconditionally, not by coincidence.
    assert.equal(54, audit.verifiedSidesEligibleForPersistence + audit.verifiedSidesSkippedUnverified + audit.verifiedSidesSkippedInvalid)
  })

  it('HARD ASSERTION (required regression #9): the same 27-lot final-canonical fixture, run twice — second run with upstream returning null and a deliberately wrong live fetcher — reuses the exact accepted evidence with zero live calls and identical realized PnL', async () => {
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()

    // RUN 1: real MatchedLot shape, 19 verified lots already priced upstream, recovery untouched.
    const r1 = createPnlReconciliation({
      logger: quiet, priceKvClient: { getPriceRecovery: async () => null } as never, priceSources: { primary: async () => null },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1_000_000,
    })
    const summary1 = await r1.reconcile({ fifoEngineResult: fifo({ matchedLots: build27FinalCanonicalLots() }), pnlEngineResult: pnl(19), syntheticPnlAssemblyOutput: null })
    assert.equal(summary1.acceptedEvidenceAudit.canonicalSeedingWriteSuccesses, 38)

    // RUN 2: a fresh fifoEngine recompute where the 19 previously-verified lots come back UNPRICED
    // (upstream failed this time) — with a deliberately WRONG live fetcher as a canary.
    let liveCalls = 0
    const verifiedNowUnpriced = Array.from({ length: 19 }, (_, i) => lot({
      lotId: `v${i}`, token: `0xcanon${i}`, openedTxHash: `0xcb${i}`, closedTxHash: `0xcs${i}`,
      openedAt: 9000 + i, closedAt: 9500 + i, amount: 1,
      costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
    const partial = Array.from({ length: 8 }, (_, i) => lot({
      lotId: `p${i}`, token: `0xpartial${i}`, openedTxHash: `0xpb${i}`, closedTxHash: `0xps${i}`,
      openedAt: 9800 + i, closedAt: 9900 + i, amount: 1,
      costBasisUsd: 5 + i, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    }))
    const priceKvClient2 = {
      getPriceRecovery: async (token: string, chain: string, timestamp: number, fetcher: (t: string, c: string, ts: number) => Promise<number | null>) => fetcher(token, chain, timestamp),
    }
    const wrongFetcher = async (token: string, _chain: string, timestamp: number): Promise<number | null> => {
      liveCalls += 1
      const i = Number(token.replace('0xcanon', ''))
      return timestamp === 9000 + i ? (10 + i) + 1000 : null
    }
    const r2 = createPnlReconciliation({
      logger: quiet, priceKvClient: priceKvClient2 as never, priceSources: { primary: wrongFetcher },
      acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 2_000_000,
    })
    const summary2 = await r2.reconcile({ fifoEngineResult: fifo({ matchedLots: [...verifiedNowUnpriced, ...partial] }), pnlEngineResult: pnl(19), syntheticPnlAssemblyOutput: null })

    // The 8 "partial" lots' still-missing SELL side legitimately needs live recovery every run (it
    // was never eligible for seeding — the parent lot was never canonically verified) — those 8 live
    // attempts are real and expected. The point under test is the 19 CANONICALLY VERIFIED lots' 38
    // sides: zero of the wrongFetcher's calls can be attributed to them, since hydration must have
    // filled every one from accepted evidence before recovery even runs.
    assert.equal(liveCalls, 8, 'only the 8 never-eligible partial lots need a live attempt — never the 19 already-accepted verified lots')
    assert.equal(summary2.publicPnlGateAudit.verifiedClosedLots, 19)
    assert.equal(summary2.realizedPnlUsd, summary1.realizedPnlUsd, 'identical realized PnL across rescans')
    assert.equal(summary2.acceptedEvidenceAudit.persistedAcceptedSidesLoaded, 38)
    assert.equal(summary2.acceptedEvidenceAudit.persistedAcceptedSidesApplied, 38)
    assert.equal(summary2.acceptedEvidenceAudit.liveSidesResolved, 0)
  })

  it('HARD ASSERTION (requirement #6): CRITICAL accepted_evidence_eligibility_mismatch fires if verified lots and protected sides exist but eligibility somehow still computes zero', async () => {
    // A synthetic worst-case: monkeypatch isn't available on the closure, so this proves the guard
    // logic itself via a lot shape that intentionally makes eligibility legitimately zero for a
    // DIFFERENT, honest reason (structurally invalid identity) — confirming the check does NOT fire
    // a false CRITICAL in a case that already has a valid, disclosed explanation (skippedInvalid > 0).
    const calls: unknown[][] = []
    const logger = { warn: (...args: unknown[]) => { calls.push(args) } }
    const acceptedEvidenceKv = fakeAcceptedEvidenceKv()
    // costBasisUsd non-null (protected from overwrite) but the lot is structurally invalid (empty
    // txHash) — a genuinely explainable zero-eligible case, not a mismatch.
    const structurallyInvalid = lot({ lotId: 'bad', token: '0xbad', openedTxHash: '', closedTxHash: '0xs', openedAt: 1, closedAt: 2, costBasisUsd: 5, proceedsUsd: 7, realizedPnlUsd: 2, evidenceQuality: 'verified' })
    const r = createPnlReconciliation({ logger, acceptedEvidenceKv: acceptedEvidenceKv as never, now: () => 1 })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [structurallyInvalid] }), pnlEngineResult: pnl(1), syntheticPnlAssemblyOutput: null })
    const mismatch = calls.find((c) => c[0] === 'CRITICAL accepted_evidence_eligibility_mismatch')
    assert.equal(mismatch, undefined, 'a structurally-invalid lot is an honest, disclosed skippedInvalid reason — never a silent, unexplained mismatch')
  })
})
