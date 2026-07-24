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
})
