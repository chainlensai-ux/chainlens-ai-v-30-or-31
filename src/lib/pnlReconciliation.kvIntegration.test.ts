// Integration tests for src/lib/pnlReconciliation.ts's recoverPrices wired against the REAL
// RequestPriceKvClient (src/lib/kvClient.ts) — not the plain mock interface
// pnlReconciliation.test.ts uses. This exercises the exact confirmed root cause of "recovery
// attempted 40 candidates, recovered prices: 0": src/pipeline/index.ts previously passed the
// ALREADY-KV-WRAPPED `requestPriceSources` (whose `.primary` itself calls
// `requestPriceKvClient.getPriceHistorical(...)` internally) into pnlReconciliation's `priceSources`
// config — recoverPrices then called `priceKvClient.getPriceHistorical(..., fetcher)` a SECOND time
// with that already-wrapped fetcher, so a KV miss/timeout fell through to `fetcher()`, which
// recomputed the IDENTICAL cache key and found the outer call's own still-pending promise sitting in
// `inFlight`, deadlocking forever. Fixed by passing the RAW, un-wrapped price source into
// pnlReconciliation's priceSources config instead — recoverPrices already owns the KV-wrapping step
// itself via the separately-supplied priceKvClient. These tests wire it the CORRECT (fixed) way and
// prove the required end-to-end behaviors. Run directly with:
//   npx tsx --test src/lib/pnlReconciliation.kvIntegration.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequestPriceKvClient } from './kvClient'
import { createPnlReconciliation } from './pnlReconciliation'
import { buildChainAwareHistoricalPriceSourceDetailed } from '../pipeline/pricingAtTimeAdapter'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

const quiet = { warn() {} }

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return { lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced', ...overrides }
}
function fifo(overrides: Partial<FifoOutput> = {}): FifoOutput {
  return { matchedLots: [], unmatchedBuys: 0, unmatchedSells: 0, realizedPnlUsd: null, unrealizedPnlUsd: 0, costBasisUsd: null, publicPnlStatus: 'unavailable', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 }, ...overrides }
}
function pnl(closedLots = 0, overrides: Partial<PnlSummaryResult> = {}): PnlSummaryResult {
  return { realizedPnlUsd: null, closedLots: [], winLossRate: { wins: 0, losses: 0, evaluated: 0, rate: 0 }, chainBreakdown: [], confidenceBasis: { high: 0, medium: 0, low: 0, aggregate: 'low' }, evidenceMissingCount: closedLots, ...overrides }
}

describe('pnlReconciliation.recoverPrices — real RequestPriceKvClient integration (confirmed double-wrap deadlock fix)', () => {
  it('a KV read that times out still falls through to the live (raw) provider — recovery succeeds', async () => {
    const kv = { get: async () => new Promise<null>(() => {}), set: async () => 'OK' } // never resolves -> always times out
    const priceKvClient = createRequestPriceKvClient({ kv: kv as never, timeoutMs: 5, maxRetries: 0, maxLookupsPerToken: 10, random: () => 0 })
    const rawPrimary: PriceSourceFn = async () => 42 // the real, raw, un-wrapped price source

    const r = createPnlReconciliation({ logger: quiet, priceKvClient, priceSources: { primary: rawPrimary } })
    const oneSideMissing = lot({ costBasisUsd: 10, proceedsUsd: null, openedAt: 100, closedAt: 200, openedTxHash: '0xa', closedTxHash: '0xb' })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [oneSideMissing] }),
      pnlEngineResult: pnl(1),
      syntheticPnlAssemblyOutput: null,
    })

    assert.equal(summary.priceRecoveredCount, 1, 'a KV timeout must still let the raw provider resolve a real price')
    assert.equal(summary.realizedPnlUsd, 32) // 42 (recovered proceeds) - 10 (existing cost)
  })

  it('an open read breaker skips KV only — provider pricing still runs and recovery still succeeds', async () => {
    const kv = { get: async () => new Promise<null>(() => {}), set: async () => 'OK' }
    // maxConsecutiveTimeouts: 1 -> the breaker opens after the very first KV timeout.
    const priceKvClient = createRequestPriceKvClient({ kv: kv as never, timeoutMs: 5, maxRetries: 0, maxConsecutiveTimeouts: 1, cooldownMs: 60_000, maxLookupsPerToken: 10, random: () => 0 })
    let providerCalls = 0
    const rawPrimary: PriceSourceFn = async () => { providerCalls += 1; return 7 }

    // Pre-open the breaker with one real, sequential, genuinely-timed-out lookup — isolated from
    // recoverPrices' own concurrency (which would otherwise fire multiple candidates' KV reads
    // simultaneously, before any of them has had a chance to observe the breaker opening).
    await priceKvClient.getPricePrimary('0xwarmup', 'base', 1, async () => 1)
    assert.equal(priceKvClient.stats.timeouts, 1, 'the warm-up lookup must have genuinely timed out, opening the breaker')

    const r = createPnlReconciliation({ logger: quiet, priceKvClient, priceSources: { primary: rawPrimary } })
    const candidate = lot({ token: '0xb', costBasisUsd: 1, proceedsUsd: null, openedAt: 300, closedAt: 400, openedTxHash: '0xb1', closedTxHash: '0xb2' })

    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [candidate] }),
      pnlEngineResult: pnl(1),
      syntheticPnlAssemblyOutput: null,
    })

    assert.ok(priceKvClient.stats.breakerSkips >= 1, 'the now-open breaker must have skipped this candidate\'s KV read')
    assert.equal(summary.priceRecoveredCount, 1, 'the candidate must still recover a real price via the provider despite the breaker skipping KV')
    assert.equal(providerCalls, 1, 'the provider must still be called — the breaker must never accidentally skip provider resolution')
  })

  it('identical recovery lookups (same chain+token+timestamp) coalesce into one real provider call', async () => {
    const priceKvClient = createRequestPriceKvClient({ kv: { get: async () => null, set: async () => 'OK' } as never, maxLookupsPerToken: 10, random: () => 0 })
    let providerCalls = 0
    const rawPrimary: PriceSourceFn = async () => { providerCalls += 1; await new Promise((res) => setTimeout(res, 5)); return 3 }

    const r = createPnlReconciliation({ logger: quiet, priceKvClient, priceSources: { primary: rawPrimary } })
    // Two distinct lots that both need the SAME token's price at the SAME buy timestamp (e.g. two
    // partial-fill closed lots opened by the same real buy tx).
    const lotA = lot({ token: '0xshared', costBasisUsd: null, proceedsUsd: 20, openedAt: 500, closedAt: 600, openedTxHash: '0xsharedbuy', closedTxHash: '0xsellA' })
    const lotB = lot({ token: '0xshared', costBasisUsd: null, proceedsUsd: 25, openedAt: 500, closedAt: 700, openedTxHash: '0xsharedbuy', closedTxHash: '0xsellB' })

    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [lotA, lotB] }),
      pnlEngineResult: pnl(2),
      syntheticPnlAssemblyOutput: null,
    })

    assert.equal(providerCalls, 1, 'two lots requesting the identical (chain, token, timestamp) must coalesce into ONE real provider call')
    assert.equal(summary.priceRecoveredCount, 2, 'both lots must still receive the coalesced result')
  })

  it('end-to-end: the real detailed chain-aware router feeds real per-source attempts into recoverPrices — a specific reason never collapses to providerReturnedNull', async () => {
    // 'hyperevm' is deliberately unverified in every real source's own chain map (dexscreener,
    // geckoterminal, coingecko) — every real attempt resolves via a cheap, synchronous "unverified
    // chain" check, so this test needs no fetch mocking and is fully deterministic (see
    // pricingAtTimeAdapter.test.ts's own header for the same convention).
    const goldrushStub: PriceSourceFn = async () => null
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrushStub)
    const primary: PriceSourceFn = async (t, c, ts) => (await detailed(t, c, ts)).price

    const priceKvClient = createRequestPriceKvClient({ kv: { get: async () => null, set: async () => 'OK' } as never, maxLookupsPerToken: 10, random: () => 0 })
    const logs: Array<{ label: string; payload: unknown }> = []
    const capturingLogger = { warn: (label: string, payload?: unknown) => { logs.push({ label, payload }) } }
    const r = createPnlReconciliation({ logger: capturingLogger, priceKvClient, priceSources: { primary }, priceSourceDetailedPrimary: detailed })

    const missingBuy = lot({ chain: 'hyperevm', costBasisUsd: null, proceedsUsd: 10, openedAt: 100, closedAt: 200, openedTxHash: '0xh1', closedTxHash: '0xh2' })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [missingBuy], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })

    assert.equal(summary.priceRecoveredCount, 0, 'hyperevm has no real coverage in any source — genuinely unpriced, never fabricated')

    const recoveryLog = logs.find((l) => l.label === '[pnl-reconciliation] recovery')?.payload as {
      failureReasonCounts: { providerReturnedNull: number; unknownReason: Record<string, number> }
      sourceAttemptCounts: Record<string, number>
      sourceSuccessCounts: Record<string, number>
    }
    assert.ok(recoveryLog, 'the recovery diagnostic log must have fired')
    // Real per-source attempts (goldrush, dexscreener, geckoterminal, coingecko) must all be
    // present — proving the per-source counters survive real end-to-end wiring, not just the
    // synthetic unit-test fixtures above.
    assert.ok(recoveryLog.sourceAttemptCounts.goldrush >= 1, 'goldrush must have been attempted')
    assert.ok(recoveryLog.sourceAttemptCounts.dexscreener >= 1, 'dexscreener must have been attempted')
    assert.ok(recoveryLog.sourceAttemptCounts.geckoterminal >= 1, 'geckoterminal must have been attempted')
    assert.ok(recoveryLog.sourceAttemptCounts.coingecko >= 1, 'coingecko must have been attempted')
    // The confirmed collapse this task fixes: every one of hyperevm's real, specific
    // "unverified chain" reasons must classify away from providerReturnedNull.
    assert.equal(recoveryLog.failureReasonCounts.providerReturnedNull, 0, 'a real, specific "unverified chain" reason must never collapse into providerReturnedNull')
  })

  function captureRecoveryLog(): { logger: { warn: (label: string, payload?: unknown) => void }; getPayload: () => Record<string, unknown> | undefined } {
    const logs: Array<{ label: string; payload: unknown }> = []
    return {
      logger: { warn: (label, payload) => { logs.push({ label, payload }) } },
      getPayload: () => logs.find((l) => l.label === '[pnl-reconciliation] recovery')?.payload as Record<string, unknown> | undefined,
    }
  }

  it('a KV hit may have no live attempts — the detailed fetcher is never invoked when the KV client already has the value', async () => {
    const store = new Map<string, number>([['v2:price:primary:base:0xcached:2', 5]])
    const priceKvClient = createRequestPriceKvClient({
      kv: { get: async (key: string) => store.get(key) ?? null, set: async () => 'OK' } as never,
      maxLookupsPerToken: 10,
      random: () => 0,
    })
    let detailedCalls = 0
    const detailedPrimary = async () => { detailedCalls += 1; return { price: 999, route: 'goldrush', attempts: [{ source: 'goldrush', ok: true, reason: null }] } }
    const { logger, getPayload } = captureRecoveryLog()
    const r = createPnlReconciliation({ logger, priceKvClient, priceSources: { primary: async () => null }, priceSourceDetailedPrimary: detailedPrimary })

    const missingSell = lot({ token: '0xcached', costBasisUsd: 1, proceedsUsd: null, openedAt: 1, closedAt: 2 })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [missingSell], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })

    assert.equal(summary.priceRecoveredCount, 1, 'the cached KV value must still resolve the leg')
    assert.equal(detailedCalls, 0, 'a KV cache hit must never invoke the detailed fetcher — nothing to observe')
    const payload = getPayload()
    assert.equal(payload?.detailedAttemptsObserved, 0, 'detailedAttemptsObserved must reflect that no live call happened')
  })

  it('a KV miss uses exactly one live lookup and records detailed attempts', async () => {
    const priceKvClient = createRequestPriceKvClient({ kv: { get: async () => null, set: async () => 'OK' } as never, maxLookupsPerToken: 10, random: () => 0 })
    let detailedCalls = 0
    const detailedPrimary = async () => { detailedCalls += 1; return { price: 7, route: 'goldrush', attempts: [{ source: 'goldrush', ok: true, reason: null }] } }
    const { logger, getPayload } = captureRecoveryLog()
    const r = createPnlReconciliation({ logger, priceKvClient, priceSources: { primary: async () => null }, priceSourceDetailedPrimary: detailedPrimary })

    const missingBuy = lot({ token: '0xmiss', costBasisUsd: null, proceedsUsd: 10, openedAt: 1, closedAt: 2 })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [missingBuy], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })

    assert.equal(summary.priceRecoveredCount, 1)
    assert.equal(detailedCalls, 1, 'a KV miss must invoke the detailed fetcher exactly once')
    const payload = getPayload()
    assert.equal(payload?.detailedAttemptsObserved, 1)
    assert.equal((payload?.sourceAttemptCounts as Record<string, number> | undefined)?.goldrush, 1)
  })

  it('breaker-open still records detailed attempts — the breaker only skips the KV read, never the detailed provider call', async () => {
    const kv = { get: async () => new Promise<null>(() => {}), set: async () => 'OK' }
    const priceKvClient = createRequestPriceKvClient({ kv: kv as never, timeoutMs: 5, maxRetries: 0, maxConsecutiveTimeouts: 1, cooldownMs: 60_000, maxLookupsPerToken: 10, random: () => 0 })
    let detailedCalls = 0
    const detailedPrimary = async () => { detailedCalls += 1; return { price: 3, route: 'goldrush', attempts: [{ source: 'goldrush', ok: true, reason: null }] } }

    // Pre-open the breaker with one real, sequential, genuinely-timed-out lookup (same isolation
    // technique as the earlier breaker test above — avoids recoverPrices' own concurrency racing
    // multiple candidates' KV reads before any of them observes the breaker opening).
    await priceKvClient.getPricePrimary('0xwarmup', 'base', 1, async () => 1)
    assert.equal(priceKvClient.stats.timeouts, 1)

    const { logger, getPayload } = captureRecoveryLog()
    const r = createPnlReconciliation({ logger, priceKvClient, priceSources: { primary: async () => null }, priceSourceDetailedPrimary: detailedPrimary })
    const candidate = lot({ token: '0xafterbreaker', costBasisUsd: null, proceedsUsd: 10, openedAt: 1, closedAt: 2 })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [candidate], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })

    assert.ok(priceKvClient.stats.breakerSkips >= 1, 'the breaker must have actually skipped this candidate\'s KV read')
    assert.equal(summary.priceRecoveredCount, 1, 'the detailed provider must still resolve the price despite the breaker skipping KV')
    assert.equal(detailedCalls, 1, 'the detailed fetcher must still run exactly once even though the KV read was skipped')
    assert.equal(getPayload()?.detailedAttemptsObserved, 1)
  })

  it('no duplicate provider call is introduced by detailed capture — exactly one real provider call per leg, same as the plain path', async () => {
    const priceKvClient = createRequestPriceKvClient({ kv: { get: async () => null, set: async () => 'OK' } as never, maxLookupsPerToken: 10, random: () => 0 })
    let realProviderCalls = 0
    const goldrushStub: PriceSourceFn = async () => { realProviderCalls += 1; return 4.2 }
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrushStub)
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient,
      priceSources: { primary: async (t, c, ts) => (await detailed(t, c, ts)).price },
      priceSourceDetailedPrimary: detailed,
    })
    const candidate = lot({ chain: 'hyperevm', token: '0xnodup', costBasisUsd: null, proceedsUsd: 10, openedAt: 1, closedAt: 2 })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [candidate], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })

    assert.equal(summary.priceRecoveredCount, 1)
    assert.equal(realProviderCalls, 1, 'the detailed capture must observe the SAME single real goldrush call, never fire a second one')
  })

  it('when a detailed source is configured, it is the SOLE live fetcher — the plain primary/fallback are never separately attempted, even when the detailed lookup fails', async () => {
    let plainPrimaryCalls = 0
    let plainFallbackCalls = 0
    const priceKvClient = createRequestPriceKvClient({ kv: { get: async () => null, set: async () => 'OK' } as never, maxLookupsPerToken: 10, random: () => 0 })
    // Detailed genuinely finds nothing (a real, honest failure) — proves the plain slots are never
    // separately consulted as a fallback attempt for the SAME leg once a detailed source exists.
    const detailedPrimary = async () => ({ price: null, route: 'none', attempts: [{ source: 'goldrush', ok: false, reason: 'goldrush_no_data' }] })
    const plainPrimary: PriceSourceFn = async () => { plainPrimaryCalls += 1; return 111 } // would poison the result if wrongly invoked
    const plainFallback: PriceSourceFn = async () => { plainFallbackCalls += 1; return 222 }

    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient,
      priceSources: { primary: plainPrimary, fallback: plainFallback },
      priceSourceDetailedPrimary: detailedPrimary,
    })
    const candidate = lot({ token: '0xdetailedonly', costBasisUsd: null, proceedsUsd: 10, openedAt: 1, closedAt: 2 })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [candidate], realizedPnlUsd: null }),
      pnlEngineResult: pnl(1, { realizedPnlUsd: null }),
      syntheticPnlAssemblyOutput: null,
    })

    assert.equal(summary.priceRecoveredCount, 0, 'the detailed source genuinely found nothing — no fabricated recovery from a plain fallback')
    assert.equal(plainPrimaryCalls, 0, 'the plain primary must never be separately attempted once a detailed source is configured')
    assert.equal(plainFallbackCalls, 0, 'the plain fallback must never be separately attempted once a detailed source is configured')
  })
})
