// Tests for src/lib/walletScannerPipelineAudit.ts (Wallet Scanner audit, Item 11 — the master
// per-scan funnel object). Pure unit tests: no provider calls, no pipeline invocation.
//
// Run directly with:
//   npx tsx --test src/lib/walletScannerPipelineAudit.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildWalletScannerPipelineAudit } from './walletScannerPipelineAudit'
import type { EventClassification } from '../modules/eventClassification/index'

function classificationCounts(overrides: Partial<Record<EventClassification, number>> = {}): Record<EventClassification, number> {
  return {
    genuine_trade_leg: 0, ordinary_transfer: 0, distribution_airdrop: 0, router_intermediary: 0,
    bridge: 0, lp_staking: 0, dust_non_economic: 0, unknown: 0,
    ...overrides,
  }
}

function baseInput() {
  return {
    wallet: '0xwallet',
    chains: ['base', 'eth'],
    rawEventCount: 100,
    normalizedEventCount: 90,
    dedupedEventCount: 85,
    inboundEventCount: 40,
    outboundEventCount: 45,
    eventsByClassification: classificationCounts({ genuine_trade_leg: 60, distribution_airdrop: 10 }),
    knownRouterHits: 12,
    routerCandidates: 20,
    swapCandidates: 30 as number | null,
    receiptCandidates: 25 as number | null,
    receiptsFetched: 10 as number | null,
    receiptBudgetRejected: 5,
    verifiedBuys: 30,
    verifiedSells: 30,
    fifoInputBuys: 35,
    fifoInputSells: 35,
    closedLots: 30,
    verifiedClosedLots: 15,
    quoteLegsRecovered: 4,
    recoveryCalls: 3,
    finalPnlStatus: 'ok' as const,
    exactFailureReason: null,
  }
}

describe('buildWalletScannerPipelineAudit — pure passthrough of real, already-computed counts', () => {
  it('carries every real count through unchanged', () => {
    const audit = buildWalletScannerPipelineAudit(baseInput())
    assert.equal(audit.wallet, '0xwallet')
    assert.deepEqual(audit.chains, ['base', 'eth'])
    assert.equal(audit.rawEvents, 100)
    assert.equal(audit.normalizedEvents, 90)
    assert.equal(audit.dedupedEvents, 85)
    assert.equal(audit.inboundEvents, 40)
    assert.equal(audit.outboundEvents, 45)
    assert.equal(audit.distributionsExcluded, 10)
    assert.equal(audit.knownRouterHits, 12)
    assert.equal(audit.routerCandidates, 20)
    assert.equal(audit.routersAccepted, 12, 'a verified-registry hit needs no inference — accepted equals knownRouterHits')
    assert.equal(audit.swapCandidates, 30)
    assert.equal(audit.receiptCandidates, 25)
    assert.equal(audit.receiptsFetched, 10)
    assert.equal(audit.receiptBudgetRejected, 5)
    assert.equal(audit.verifiedBuys, 30)
    assert.equal(audit.verifiedSells, 30)
    assert.equal(audit.fifoInputBuys, 35)
    assert.equal(audit.fifoInputSells, 35)
    assert.equal(audit.closedLots, 30)
    assert.equal(audit.verifiedClosedLots, 15)
    assert.equal(audit.quoteLegsRecovered, 4)
    assert.equal(audit.recoveryCalls, 3)
    assert.equal(audit.robinhoodVerifiedSwaps, null, 'this V2 pipeline never touches the separate Robinhood scanner')
  })

  it('computes pricingCoverage as a real ratio, never fabricated when closedLots is 0', () => {
    const withLots = buildWalletScannerPipelineAudit(baseInput())
    assert.equal(withLots.pricingCoverage, 0.5)

    const noLots = buildWalletScannerPipelineAudit({ ...baseInput(), closedLots: 0, verifiedClosedLots: 0, finalPnlStatus: 'unavailable' })
    assert.equal(noLots.pricingCoverage, null)
  })

  it('firstFailureStage is null whenever finalPnlStatus is ok, regardless of upstream counts', () => {
    const audit = buildWalletScannerPipelineAudit(baseInput())
    assert.equal(audit.firstFailureStage, null)
    assert.equal(audit.exactFailureReason, null, 'a reason is never attached when PnL is actually ok')
  })

  it('firstFailureStage reports provider_fetch when zero raw events were ever returned', () => {
    const audit = buildWalletScannerPipelineAudit({ ...baseInput(), rawEventCount: 0, normalizedEventCount: 0, fifoInputBuys: 0, fifoInputSells: 0, closedLots: 0, verifiedClosedLots: 0, finalPnlStatus: 'unavailable', exactFailureReason: 'no data' })
    assert.equal(audit.firstFailureStage, 'provider_fetch')
    assert.equal(audit.exactFailureReason, 'no data')
  })

  it('firstFailureStage reports classification when raw/normalized events exist but nothing survived to FIFO input', () => {
    const audit = buildWalletScannerPipelineAudit({ ...baseInput(), fifoInputBuys: 0, fifoInputSells: 0, closedLots: 0, verifiedClosedLots: 0, finalPnlStatus: 'unavailable', exactFailureReason: 'all events excluded' })
    assert.equal(audit.firstFailureStage, 'classification')
  })

  it('firstFailureStage reports fifo_matching when FIFO had input but produced zero closed lots', () => {
    const audit = buildWalletScannerPipelineAudit({ ...baseInput(), closedLots: 0, verifiedClosedLots: 0, finalPnlStatus: 'unavailable', exactFailureReason: 'no closed lots' })
    assert.equal(audit.firstFailureStage, 'fifo_matching')
  })

  it('firstFailureStage reports pricing_verification when closed lots exist but the coverage gate still blocks', () => {
    const audit = buildWalletScannerPipelineAudit({ ...baseInput(), finalPnlStatus: 'limited_verified_sample', exactFailureReason: 'coverage below threshold' })
    assert.equal(audit.firstFailureStage, 'pricing_verification')
    assert.equal(audit.exactFailureReason, 'coverage below threshold')
  })

  it('swapCandidates/receiptCandidates/receiptsFetched stay honestly null when the receipt decoder never ran (e.g. non-Base chain)', () => {
    const audit = buildWalletScannerPipelineAudit({ ...baseInput(), swapCandidates: null, receiptCandidates: null, receiptsFetched: null })
    assert.equal(audit.swapCandidates, null)
    assert.equal(audit.receiptCandidates, null)
    assert.equal(audit.receiptsFetched, null)
  })
})
