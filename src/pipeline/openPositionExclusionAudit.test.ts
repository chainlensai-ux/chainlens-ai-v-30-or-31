// Tests for openPositionExclusionAudit — exact exclusion reasons in public language.
//   npx tsx --test src/pipeline/openPositionExclusionAudit.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenPositionExclusionAudit, PUBLIC_EXCLUSION_REASON_LABELS } from './openPositionExclusionAudit'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import type { ExcludedUnrealizedPosition, UnrealizedReconciliationSummary } from '../modules/fifoEngine/types'

function excluded(overrides: Partial<ExcludedUnrealizedPosition>): ExcludedUnrealizedPosition {
  return {
    chainId: 'base',
    tokenAddress: '0xabc',
    symbol: 'FOO',
    openQuantityFromFifo: 10,
    canonicalCurrentBalance: null,
    excessOpenQuantity: null,
    decimalsUsed: 18,
    currentPriceUsd: null,
    currentPriceSource: null,
    openCostBasisUsd: 5,
    candidateMarketValueUsd: null,
    candidateUnrealizedPnlUsd: null,
    exclusionReason: 'missing_canonical_balance',
    classification: 'missing_balance',
    ...overrides,
  }
}

function reconciliation(overrides: Partial<UnrealizedReconciliationSummary> = {}): UnrealizedReconciliationSummary {
  const base = emptyUnrealizedReconciliation()
  return { ...base, ...overrides }
}

describe('buildOpenPositionExclusionAudit', () => {
  it('classifies each excluded position with an exact public-language reason', () => {
    const positions: ExcludedUnrealizedPosition[] = [
      excluded({ exclusionReason: 'missing_verified_current_price', classification: 'missing_price', symbol: 'AERO', currentPriceUsd: null, canonicalCurrentBalance: 10 }),
      excluded({ exclusionReason: 'missing_canonical_balance', classification: 'missing_balance', symbol: 'OLD', tokenAddress: '0xold' }),
      excluded({ exclusionReason: 'open_quantity_exceeds_balance', classification: 'balance_less_than_fifo_open', symbol: 'WETH', canonicalCurrentBalance: 1, currentPriceUsd: 1.2, tokenAddress: '0xweth' }),
      excluded({ exclusionReason: 'missing_verified_current_price', classification: 'dust_spam', symbol: 'CLAIM-REWARDS.COM', tokenAddress: '0xspam' }),
    ]
    const audit = buildOpenPositionExclusionAudit(reconciliation({
      totalOpenPositions: 10,
      reconciledOpenPositions: 6,
      excludedOpenPositions: 4,
      unrealizedCoveragePercent: 60,
      openPositionCoveragePercent: 75,
      excludedPositions: positions,
      excludedReasonCounts: {
        missing_verified_current_price: 2,
        missing_canonical_balance: 1,
        open_quantity_exceeds_balance: 1,
      },
      excludedClassificationCounts: {
        missing_price: 1,
        missing_balance: 1,
        balance_less_than_fifo_open: 1,
        dust_spam: 1,
      },
      deadOrSpamPositionsCount: 1,
    }))
    assert.equal(audit.excludedOpenPositions, 4)
    assert.equal(audit.currentlyHeldCoveragePercent, 75)
    assert.equal(audit.unrealizedCoveragePercent, 60)
    assert.equal(audit.byReason.missing_verified_current_price, 2)
    assert.ok(audit.publicReasons.some((r) => r.label === PUBLIC_EXCLUSION_REASON_LABELS.missing_verified_current_price))
    assert.ok(audit.publicReasons.some((r) => r.label === 'dust or spam token'))
    assert.equal(audit.examples[0].publicReason, PUBLIC_EXCLUSION_REASON_LABELS.missing_verified_current_price)
    assert.equal(audit.examples[0].hadCanonicalBalance, true)
    assert.equal(audit.examples[1].hadVerifiedCurrentPrice, false)
  })

  it('does not invent coverage or official unrealized', () => {
    const audit = buildOpenPositionExclusionAudit(reconciliation({
      officialUnrealizedPnlUsd: null,
      totalOpenPositions: 0,
      unrealizedCoveragePercent: 0,
      openPositionCoveragePercent: 0,
    }))
    assert.equal(audit.officialUnrealizedPnlUsd, null)
    assert.equal(audit.examples.length, 0)
    assert.deepEqual(audit.publicReasons, [])
  })
})
