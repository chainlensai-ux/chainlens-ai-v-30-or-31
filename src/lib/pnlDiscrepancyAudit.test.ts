// Tests for src/lib/pnlDiscrepancyAudit.ts — Wallet Scanner trust-gate task.
//
// Run with:
//   npx tsx --test src/lib/pnlDiscrepancyAudit.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MatchedLot, UnmatchedEventIdentity } from '../modules/fifoEngine/types'
import type { PnlMismatchClass } from './pnlReconciliation'
import {
  buildPnlDiscrepancyAudit, emptyPnlDiscrepancyAudit,
  ENGINE_DIVERGENCE_ABS_THRESHOLD_USD, ENGINE_DIVERGENCE_PCT_THRESHOLD, PRICING_COVERAGE_TRUST_THRESHOLD,
  PARTIAL_TRUST_GATE_HEADLINE_LABEL,
} from './pnlDiscrepancyAudit'

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return { lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1, costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified', ...overrides }
}

function unmatchedSell(overrides: Partial<UnmatchedEventIdentity> = {}): UnmatchedEventIdentity {
  return { chain: 'base', txHash: '0xsell', token: '0xtoken', timestamp: 1, direction: 'outbound', amount: 1, fromAddress: '0xfrom', toAddress: '0xto', amountRaw: null, ...overrides }
}

function baseParams(overrides: Partial<Parameters<typeof buildPnlDiscrepancyAudit>[0]> = {}) {
  return {
    publicPnlStatus: 'partial' as const,
    canonicalRealizedPnlUsd: -100,
    alternateEngineRealizedPnlUsd: -100,
    verifiedLotCount: 10,
    structuralClosedLots: 10,
    pricingCoverage: 1,
    criticalTradeEvidenceMissing: 0,
    genuineUnmatchedSells: 0,
    publishedMatchedLots: [],
    mismatches: new Map<string, PnlMismatchClass>(),
    unmatchedSellEvents: [],
    ...overrides,
  }
}

describe('buildPnlDiscrepancyAudit — engine divergence', () => {
  it('never treats a $250 divergence as a trigger — the rule is strictly greater than $250 (and stays under the 10% relative rule too)', () => {
    // -10000 vs -10250: exactly $250 absolute (not > 250) and 2.5% relative (well under 10%).
    const audit = buildPnlDiscrepancyAudit(baseParams({ canonicalRealizedPnlUsd: -10000, alternateEngineRealizedPnlUsd: -10000 - ENGINE_DIVERGENCE_ABS_THRESHOLD_USD }))
    assert.deepEqual(audit.likelyReasonCodes, [])
  })

  it('HARD ASSERTION (required regression): a divergence just over $250 (absolute) triggers engine_divergence_exceeds_threshold', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ canonicalRealizedPnlUsd: -1000, alternateEngineRealizedPnlUsd: -1000 - (ENGINE_DIVERGENCE_ABS_THRESHOLD_USD + 1) }))
    assert.ok(audit.likelyReasonCodes.includes('engine_divergence_exceeds_threshold'))
    assert.equal(audit.trustGateTriggered, true)
  })

  it('HARD ASSERTION (required regression): a divergence over 10% (but under the absolute $250 floor) still triggers via the percent rule', () => {
    // 10 vs 12 = $2 absolute (well under $250) but 20% relative — must still trigger.
    const audit = buildPnlDiscrepancyAudit(baseParams({ canonicalRealizedPnlUsd: 10, alternateEngineRealizedPnlUsd: 12 }))
    assert.ok(audit.likelyReasonCodes.includes('engine_divergence_exceeds_threshold'))
  })

  it('a small wallet with a genuinely small divergence (both under $250 AND under 10%) never triggers', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ canonicalRealizedPnlUsd: 1000, alternateEngineRealizedPnlUsd: 1050 }))
    assert.deepEqual(audit.likelyReasonCodes, [])
  })

  it('percent denominator uses the LARGER magnitude, never the smaller — avoids inflating % for a tiny canonical figure', () => {
    // canonical near-zero, alternate large — denominator must be the alternate's own magnitude,
    // not canonical (which would manufacture a huge, meaningless percentage).
    const audit = buildPnlDiscrepancyAudit(baseParams({ canonicalRealizedPnlUsd: 1, alternateEngineRealizedPnlUsd: 300 }))
    assert.ok(audit.engineDivergencePct! < 1, 'percent must be computed against the larger magnitude (300), not the tiny canonical figure (1)')
  })

  it('null when either side is null — never a fabricated divergence', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ canonicalRealizedPnlUsd: null, alternateEngineRealizedPnlUsd: -100 }))
    assert.equal(audit.engineDivergenceUsd, null)
    assert.equal(audit.engineDivergencePct, null)
    assert.ok(!audit.likelyReasonCodes.includes('engine_divergence_exceeds_threshold'))
  })
})

describe('buildPnlDiscrepancyAudit — pricing coverage / critical evidence / unmatched sells', () => {
  it(`pricingCoverage exactly at the ${PRICING_COVERAGE_TRUST_THRESHOLD} threshold does NOT trigger — the rule is strictly less than`, () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ pricingCoverage: PRICING_COVERAGE_TRUST_THRESHOLD }))
    assert.ok(!audit.likelyReasonCodes.includes('pricing_coverage_below_threshold'))
  })

  it('pricingCoverage just under the threshold triggers pricing_coverage_below_threshold', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ pricingCoverage: PRICING_COVERAGE_TRUST_THRESHOLD - 0.001 }))
    assert.ok(audit.likelyReasonCodes.includes('pricing_coverage_below_threshold'))
  })

  it('criticalTradeEvidenceMissing > 0 triggers critical_trade_evidence_missing', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ criticalTradeEvidenceMissing: 1 }))
    assert.ok(audit.likelyReasonCodes.includes('critical_trade_evidence_missing'))
  })

  it('genuineUnmatchedSells > 0 triggers genuine_unmatched_sells_present', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ genuineUnmatchedSells: 1 }))
    assert.ok(audit.likelyReasonCodes.includes('genuine_unmatched_sells_present'))
  })
})

describe('buildPnlDiscrepancyAudit — trust gate is publicPnlStatus-gated', () => {
  it('HARD ASSERTION (required regression): trustGateTriggered is ALWAYS false for publicPnlStatus "available", even with every reason code present', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({
      publicPnlStatus: 'available',
      pricingCoverage: 0.1, criticalTradeEvidenceMissing: 99, genuineUnmatchedSells: 99,
      canonicalRealizedPnlUsd: -1000, alternateEngineRealizedPnlUsd: -50000,
    }))
    assert.ok(audit.likelyReasonCodes.length > 0, 'sanity: reason codes still fire')
    assert.equal(audit.trustGateTriggered, false, 'a fully verified result is never trust-gated')
    assert.equal(audit.headlineOverrideLabel, null)
  })

  it('trustGateTriggered is ALWAYS false for publicPnlStatus "unavailable"', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ publicPnlStatus: 'unavailable', genuineUnmatchedSells: 1 }))
    assert.equal(audit.trustGateTriggered, false)
  })

  it('HARD ASSERTION (required regression): "partial" + zero reason codes never triggers — a healthy bounded sample is never falsely gated', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ publicPnlStatus: 'partial' }))
    assert.deepEqual(audit.likelyReasonCodes, [])
    assert.equal(audit.trustGateTriggered, false)
  })

  it('HARD ASSERTION (required regression): "partial" + at least one reason code triggers, with the exact literal headline label', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ publicPnlStatus: 'partial', genuineUnmatchedSells: 1 }))
    assert.equal(audit.trustGateTriggered, true)
    assert.equal(audit.headlineOverrideLabel, PARTIAL_TRUST_GATE_HEADLINE_LABEL)
    assert.equal(audit.headlineOverrideLabel, 'Partial verified sample — not comparable to Nansen yet')
  })

  it('externalComparatorHint is always null — never auto-set by this module', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams({ genuineUnmatchedSells: 1 }))
    assert.equal(audit.externalComparatorHint, null)
  })
})

describe('buildPnlDiscrepancyAudit — per-lot contributor debug (requirement #3)', () => {
  it('largestNegativeClosedLotsTop10 is sorted most-negative first, capped at 10, and only includes priced negative lots', () => {
    const lots = [
      lot({ lotId: 'small-loss', realizedPnlUsd: -5 }),
      lot({ lotId: 'big-loss', realizedPnlUsd: -500 }),
      lot({ lotId: 'mid-loss', realizedPnlUsd: -50 }),
      lot({ lotId: 'a-gain', realizedPnlUsd: 10 }),
      lot({ lotId: 'unpriced', realizedPnlUsd: null, evidenceQuality: 'unpriced' }),
    ]
    const audit = buildPnlDiscrepancyAudit(baseParams({ publishedMatchedLots: lots }))
    assert.deepEqual(audit.largestNegativeClosedLotsTop10.map((l) => l.lotId), ['big-loss', 'mid-loss', 'small-loss'])
  })

  it('largestPositiveClosedLotsTop10 is sorted most-positive first', () => {
    const lots = [
      lot({ lotId: 'small-gain', realizedPnlUsd: 5 }),
      lot({ lotId: 'big-gain', realizedPnlUsd: 500 }),
      lot({ lotId: 'a-loss', realizedPnlUsd: -10 }),
    ]
    const audit = buildPnlDiscrepancyAudit(baseParams({ publishedMatchedLots: lots }))
    assert.deepEqual(audit.largestPositiveClosedLotsTop10.map((l) => l.lotId), ['big-gain', 'small-gain'])
  })

  it('HARD ASSERTION (required regression): caps at 10, never more, even with 20 real negative lots', () => {
    const lots = Array.from({ length: 20 }, (_, i) => lot({ lotId: `l${i}`, realizedPnlUsd: -1 - i }))
    const audit = buildPnlDiscrepancyAudit(baseParams({ publishedMatchedLots: lots }))
    assert.equal(audit.largestNegativeClosedLotsTop10.length, 10)
  })

  it('a contributor carries token/chain/lotId/openedAt/closedAt/buy-tx/sell-tx/evidence, and real entry/exit price derived from costBasis/proceeds ÷ amount', () => {
    const l = lot({ lotId: 'lot-x', token: '0xtok', chain: 'eth', openedAt: 111, closedAt: 222, openedTxHash: '0xb', closedTxHash: '0xs', amount: 2, costBasisUsd: 20, proceedsUsd: 8, realizedPnlUsd: -12, evidenceQuality: 'verified' })
    const audit = buildPnlDiscrepancyAudit(baseParams({ publishedMatchedLots: [l] }))
    const c = audit.largestNegativeClosedLotsTop10[0]
    assert.equal(c.token, '0xtok')
    assert.equal(c.chain, 'eth')
    assert.equal(c.lotId, 'lot-x')
    assert.equal(c.openedAt, 111)
    assert.equal(c.closedAt, 222)
    assert.equal(c.openedTxHash, '0xb')
    assert.equal(c.closedTxHash, '0xs')
    assert.equal(c.evidenceQuality, 'verified')
    assert.equal(c.entryPriceUsd, 10, 'costBasisUsd 20 / amount 2 = $10/unit entry price')
    assert.equal(c.exitPriceUsd, 4, 'proceedsUsd 8 / amount 2 = $4/unit exit price')
    // HONEST NULL, DISCLOSED: not a signal this layer actually has — never guessed.
    assert.equal(c.receiptOrTransferDerived, null)
  })

  it('HARD ASSERTION (required regression): priceSourceHint reflects the real recovered/priced/unpriced state via the SAME lotKey the mismatches map is keyed by', () => {
    const recoveredLot = lot({ lotId: 'recovered', openedTxHash: '0xrb', closedTxHash: '0xrs', realizedPnlUsd: -1 })
    const mismatches = new Map<string, PnlMismatchClass>([
      [['base', '0xtoken', '0xrb', '0xrs', 1, 2].join(':'), 'priceRecovered'],
    ])
    const audit = buildPnlDiscrepancyAudit(baseParams({ publishedMatchedLots: [recoveredLot], mismatches }))
    assert.equal(audit.largestNegativeClosedLotsTop10[0].priceSourceHint, 'recovered')
  })
})

describe('buildPnlDiscrepancyAudit — token-level breakdowns', () => {
  it('topMissingEvidenceTokens groups real priceUnavailable mismatches by (chain, token), sorted by count', () => {
    const mismatches = new Map<string, PnlMismatchClass>([
      [['base', '0xaaa', '0xb1', '0xs1', 1, 2].join(':'), 'priceUnavailable'],
      [['base', '0xaaa', '0xb2', '0xs2', 3, 4].join(':'), 'priceUnavailable'],
      [['base', '0xbbb', '0xb3', '0xs3', 5, 6].join(':'), 'priceUnavailable'],
      [['base', '0xccc', '0xb4', '0xs4', 7, 8].join(':'), 'priceRecovered'], // not missing evidence
    ])
    const audit = buildPnlDiscrepancyAudit(baseParams({ mismatches }))
    assert.equal(audit.topMissingEvidenceTokens[0].token, '0xaaa')
    assert.equal(audit.topMissingEvidenceTokens[0].count, 2)
    assert.ok(!audit.topMissingEvidenceTokens.some((t) => t.token === '0xccc'), 'a recovered price is never reported as missing evidence')
  })

  it('topUnmatchedSellTokens groups real unmatchedSellEvents by (chain, token)', () => {
    const events = [
      unmatchedSell({ chain: 'base', token: '0xaaa' }),
      unmatchedSell({ chain: 'base', token: '0xaaa' }),
      unmatchedSell({ chain: 'eth', token: '0xbbb' }),
    ]
    const audit = buildPnlDiscrepancyAudit(baseParams({ unmatchedSellEvents: events }))
    assert.equal(audit.topUnmatchedSellTokens[0].token, '0xaaa')
    assert.equal(audit.topUnmatchedSellTokens[0].count, 2)
    assert.equal(audit.topUnmatchedSellTokens[1].token, '0xbbb')
  })

  it('empty inputs produce empty (never fabricated) breakdowns', () => {
    const audit = buildPnlDiscrepancyAudit(baseParams())
    assert.deepEqual(audit.topMissingEvidenceTokens, [])
    assert.deepEqual(audit.topUnmatchedSellTokens, [])
  })
})

describe('emptyPnlDiscrepancyAudit — honest all-null/zero/empty fixture default', () => {
  it('never triggers the trust gate and carries no fabricated data', () => {
    const audit = emptyPnlDiscrepancyAudit()
    assert.equal(audit.trustGateTriggered, false)
    assert.equal(audit.headlineOverrideLabel, null)
    assert.equal(audit.canonicalRealizedPnlUsd, null)
    assert.deepEqual(audit.likelyReasonCodes, [])
    assert.deepEqual(audit.largestNegativeClosedLotsTop10, [])
  })
})

// Sanity: the exported threshold constants exist and match this task's own literal spec — a test
// that would fail loudly if a future edit silently changed the numbers without updating this file.
describe('exported thresholds match this task\'s own explicit spec', () => {
  it('$250 absolute / 10% relative / 0.85 coverage', () => {
    assert.equal(ENGINE_DIVERGENCE_ABS_THRESHOLD_USD, 250)
    assert.equal(ENGINE_DIVERGENCE_PCT_THRESHOLD, 0.10)
    assert.equal(PRICING_COVERAGE_TRUST_THRESHOLD, 0.85)
  })
})
