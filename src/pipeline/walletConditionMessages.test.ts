// Unit tests for buildWalletConditionMessages (src/pipeline/walletConditionMessages.ts).
// Run with: npx tsx --test src/pipeline/walletConditionMessages.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildWalletConditionMessages, type WalletConditionInput } from './walletConditionMessages'

function baseInput(overrides: Partial<WalletConditionInput> = {}): WalletConditionInput {
  return {
    tokenCount: 10,
    deadTokens: 0,
    unindexedTokens: 0,
    zeroLiquidityTokens: 0,
    failedPricingAttempts: 0,
    fallbackAttempts: 0,
    providerErrors: 0,
    suppressionSkipped: 0,
    closedLots: 5,
    totalSells: 5,
    ...overrides,
  }
}

function findSection(sections: ReturnType<typeof buildWalletConditionMessages>, id: string) {
  return sections.find((s) => s.id === id)
}

describe('buildWalletConditionMessages — section 1: wallet health score', () => {
  it('is hidden for a small, clean wallet', () => {
    const sections = buildWalletConditionMessages(baseInput())
    assert.equal(findSection(sections, 'walletHealthScore'), undefined)
  })

  it('shows when tokenCount > 50', () => {
    const sections = buildWalletConditionMessages(baseInput({ tokenCount: 51 }))
    assert.match(findSection(sections, 'walletHealthScore')!.text, /^Wallet Health: \d+\/100 —/)
  })

  it('shows when deadTokens > 0 and describes it as Fragmented/Highly Fragmented, not Stable, once penalized', () => {
    const sections = buildWalletConditionMessages(baseInput({ deadTokens: 20 }))
    const text = findSection(sections, 'walletHealthScore')!.text
    assert.ok(text.includes('Fragmented'))
  })

  it('shows when unindexedTokens > 0', () => {
    const sections = buildWalletConditionMessages(baseInput({ unindexedTokens: 3 }))
    assert.ok(findSection(sections, 'walletHealthScore'))
  })

  it('never goes below 0 or above 100', () => {
    const sections = buildWalletConditionMessages(baseInput({ deadTokens: 999, unindexedTokens: 999, tokenCount: 999 }))
    const match = findSection(sections, 'walletHealthScore')!.text.match(/(\d+)\/100/)
    const score = Number(match![1])
    assert.ok(score >= 0 && score <= 100)
  })
})

describe('buildWalletConditionMessages — section 2: wallet issues detected', () => {
  it('is hidden when no issues exist', () => {
    const sections = buildWalletConditionMessages(baseInput())
    assert.equal(findSection(sections, 'walletIssuesDetected'), undefined)
  })

  it('lists only the issues that actually exist, with real counts', () => {
    const sections = buildWalletConditionMessages(baseInput({ deadTokens: 2, failedPricingAttempts: 7 }))
    const text = findSection(sections, 'walletIssuesDetected')!.text
    assert.match(text, /2 tokens have no liquidity or active markets\./)
    assert.match(text, /7 pricing attempts returned no data\./)
    assert.ok(!text.includes('unindexed'))
    assert.ok(!text.includes('fallback'))
  })

  it('includes all five issue types when all are present', () => {
    const sections = buildWalletConditionMessages(baseInput({
      deadTokens: 1, unindexedTokens: 1, zeroLiquidityTokens: 1, failedPricingAttempts: 1, fallbackAttempts: 1,
    }))
    const text = findSection(sections, 'walletIssuesDetected')!.text
    assert.match(text, /no liquidity or active markets/)
    assert.match(text, /lack metadata or pool indexing/)
    assert.match(text, /have zero liquidity/)
    assert.match(text, /pricing attempts returned no data/)
    assert.match(text, /fallback attempts were required/)
  })
})

describe('buildWalletConditionMessages — section 3: PnL evidence level', () => {
  it('shows "Limited coverage" with real counts when closedLots < totalSells', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 3, totalSells: 10 }))
    assert.equal(findSection(sections, 'pnlEvidenceLevel')!.text, 'PnL Evidence Level: Limited coverage — 3 of 10 sells had verifiable pricing.')
  })

  it('shows FULL when closedLots === totalSells and there is no coverage issue', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5 }))
    assert.equal(findSection(sections, 'pnlEvidenceLevel')!.text, 'PnL Evidence Level: FULL — All priced sells had complete on-chain evidence.')
  })

  // REVERSED, DISCLOSED (observability/public-evidence-truthfulness task — confirmed bug #2): this
  // test previously asserted the exact bug production caught — a scan with ZERO evaluated lots
  // (closedLots === 0, totalSells === 0, e.g. because Alchemy transaction history never arrived)
  // was reported as "PnL Evidence Level: FULL", i.e. vacuously complete. Zero evaluated lots can
  // never mean full evidence — it means no evidence was evaluated at all.
  it('shows "Insufficient evidence" (never FULL) when there are zero sells — zero evaluated lots is never vacuously complete', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 0, totalSells: 0 }))
    assert.match(findSection(sections, 'pnlEvidenceLevel')!.text, /^PnL Evidence Level: Insufficient evidence/)
  })

  it('shows "Limited coverage" (never FULL) when closedLots === totalSells but providerErrors indicate a coverage issue', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5, providerErrors: 2 }))
    assert.match(findSection(sections, 'pnlEvidenceLevel')!.text, /^PnL Evidence Level: Limited coverage/)
  })

  it('shows "Limited coverage" (never FULL) when publicPnlStatus is unavailable, even with a perfect ratio', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5, publicPnlStatus: 'unavailable' }))
    assert.match(findSection(sections, 'pnlEvidenceLevel')!.text, /^PnL Evidence Level: Limited coverage/)
  })

  it('shows "Limited coverage" (never FULL) when transaction history is partial, even with a perfect ratio', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5, transactionHistoryPartial: true }))
    assert.match(findSection(sections, 'pnlEvidenceLevel')!.text, /^PnL Evidence Level: Limited coverage/)
  })

  it('shows "Limited coverage" (never FULL) when a provider rate limit was detected, even with a perfect ratio', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5, rateLimitDetected: true }))
    assert.match(findSection(sections, 'pnlEvidenceLevel')!.text, /^PnL Evidence Level: Limited coverage/)
  })
})

describe('buildWalletConditionMessages — section 4: evidence gaps (cause-aware)', () => {
  it('is hidden when no gap causes exist', () => {
    const sections = buildWalletConditionMessages(baseInput())
    assert.equal(findSection(sections, 'evidenceGaps'), undefined)
  })

  it('attributes zero-liquidity gaps honestly (not blaming the scanner)', () => {
    const sections = buildWalletConditionMessages(baseInput({ deadTokens: 1 }))
    assert.match(findSection(sections, 'evidenceGaps')!.text, /due to zero liquidity/)
  })

  it('attributes provider errors to the provider, not the wallet', () => {
    const sections = buildWalletConditionMessages(baseInput({ providerErrors: 4 }))
    assert.match(findSection(sections, 'evidenceGaps')!.text, /provider errors or rate limits/)
  })

  it('attributes suppression-skipped tokens to the scanner\'s own policy, not the wallet', () => {
    const sections = buildWalletConditionMessages(baseInput({ suppressionSkipped: 6 }))
    assert.match(findSection(sections, 'evidenceGaps')!.text, /intentionally skipped due to dust suppression rules/)
  })

  it('shows multiple independent gap causes together', () => {
    const sections = buildWalletConditionMessages(baseInput({ deadTokens: 1, unindexedTokens: 1, providerErrors: 1, suppressionSkipped: 1 }))
    const text = findSection(sections, 'evidenceGaps')!.text
    assert.match(text, /zero liquidity/)
    assert.match(text, /missing metadata or pool indexing/)
    assert.match(text, /provider errors or rate limits/)
    assert.match(text, /dust suppression rules/)
  })
})

describe('buildWalletConditionMessages — section 5: why PnL changed', () => {
  it('is hidden when previousPnL/currentPnL are not supplied (never fabricates "unchanged")', () => {
    const sections = buildWalletConditionMessages(baseInput())
    assert.equal(findSection(sections, 'whyPnlChanged'), undefined)
  })

  it('is hidden when PnL did not change', () => {
    const sections = buildWalletConditionMessages(baseInput({ previousPnL: 100, currentPnL: 100 }))
    assert.equal(findSection(sections, 'whyPnlChanged'), undefined)
  })

  it('shows and separates wallet-side vs provider/scanner-side causes when PnL changed', () => {
    const sections = buildWalletConditionMessages(baseInput({
      previousPnL: 100,
      currentPnL: 150,
      deadTokens: 2,
      suppressionSkipped: 3,
    }))
    const text = findSection(sections, 'whyPnlChanged')!.text
    assert.match(text, /Wallet-side: 2 dead \(no-liquidity\) tokens\./)
    assert.match(text, /Scanner\/provider-side: 3 tokens skipped by dust-suppression rules\./)
  })

  it('shows the base message alone when PnL changed but no specific cause is known', () => {
    const sections = buildWalletConditionMessages(baseInput({ previousPnL: 100, currentPnL: 150 }))
    const text = findSection(sections, 'whyPnlChanged')!.text
    assert.ok(text.startsWith('PnL changed because'))
    assert.ok(!text.includes('Wallet-side'))
    assert.ok(!text.includes('Scanner/provider-side'))
  })
})

describe('buildWalletConditionMessages — section 6: wallet complexity level', () => {
  it('is NORMAL for a small wallet', () => {
    const sections = buildWalletConditionMessages(baseInput({ tokenCount: 20 }))
    assert.equal(findSection(sections, 'walletComplexityLevel')!.text, 'Complexity: NORMAL.')
  })

  it('is HIGH above 50 tokens', () => {
    const sections = buildWalletConditionMessages(baseInput({ tokenCount: 51 }))
    assert.match(findSection(sections, 'walletComplexityLevel')!.text, /^Complexity: HIGH/)
  })
})

describe('buildWalletConditionMessages — section 7: wallet risk posture', () => {
  it('is MODERATE when lowLiquidityTokens/microcaps are not supplied', () => {
    const sections = buildWalletConditionMessages(baseInput())
    assert.equal(findSection(sections, 'walletRiskPosture')!.text, 'Risk Posture: MODERATE.')
  })

  it('is HIGH when lowLiquidityTokens > 0', () => {
    const sections = buildWalletConditionMessages(baseInput({ lowLiquidityTokens: 1 }))
    assert.match(findSection(sections, 'walletRiskPosture')!.text, /^Risk Posture: HIGH/)
  })

  it('is HIGH when microcaps > 0', () => {
    const sections = buildWalletConditionMessages(baseInput({ microcaps: 1 }))
    assert.match(findSection(sections, 'walletRiskPosture')!.text, /^Risk Posture: HIGH/)
  })
})

describe('buildWalletConditionMessages — section 8: PnL confidence score', () => {
  it('computes the real ratio', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 3, totalSells: 4 }))
    assert.equal(findSection(sections, 'pnlConfidenceScore')!.text, 'PnL Confidence: 75% — Based on available pricing evidence.')
  })

  // REVERSED, DISCLOSED (observability/public-evidence-truthfulness task — confirmed bug #2): this
  // test previously asserted the exact production bug — a scan with ZERO evaluated lots (guarded
  // against divide-by-zero by falling back to 100%) was reported as "100% confident". Zero evaluated
  // lots can never equal 100% confidence — there is no evidence to be confident about.
  it('HARD ASSERTION: zero evaluated lots can never equal 100% confidence', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 0, totalSells: 0 }))
    assert.equal(findSection(sections, 'pnlConfidenceScore')!.text, 'PnL Confidence: 0% — Based on available pricing evidence.')
  })

  it('HARD ASSERTION: a provider rate limit lowers confidence below 100%, even with a perfect ratio', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5, rateLimitDetected: true }))
    const text = findSection(sections, 'pnlConfidenceScore')!.text
    assert.notEqual(text, 'PnL Confidence: 100% — Based on available pricing evidence.')
  })

  it('caps confidence below 100% when publicPnlStatus is unavailable, even with a perfect ratio', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5, publicPnlStatus: 'unavailable' }))
    const text = findSection(sections, 'pnlConfidenceScore')!.text
    assert.notEqual(text, 'PnL Confidence: 100% — Based on available pricing evidence.')
  })
})

describe('buildWalletConditionMessages — section 9: tokens excluded from PnL', () => {
  it('is hidden when excludedTokens is not supplied', () => {
    const sections = buildWalletConditionMessages(baseInput())
    assert.equal(findSection(sections, 'tokensExcludedFromPnl'), undefined)
  })

  it('is hidden when excludedTokens is empty', () => {
    const sections = buildWalletConditionMessages(baseInput({ excludedTokens: [] }))
    assert.equal(findSection(sections, 'tokensExcludedFromPnl'), undefined)
  })

  it('lists the real excluded tokens when present', () => {
    const sections = buildWalletConditionMessages(baseInput({ excludedTokens: ['DUST', 'SPAM'] }))
    assert.equal(findSection(sections, 'tokensExcludedFromPnl')!.text, 'Excluded from PnL: DUST, SPAM — Missing pricing evidence.')
  })
})

describe('buildWalletConditionMessages — section 10: scan depth indicator', () => {
  it('shows "Limited coverage" with a real count when closedLots < totalSells', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 2, totalSells: 9 }))
    assert.equal(findSection(sections, 'scanDepthIndicator')!.text, 'Scan Depth: Limited coverage — Only 2 priced sells reconstructed.')
  })

  it('is FULL when closedLots === totalSells and there is no coverage issue', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5 }))
    assert.equal(findSection(sections, 'scanDepthIndicator')!.text, 'Scan Depth: FULL.')
  })

  it('shows "Insufficient evidence" (never FULL) with zero evaluated lots', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 0, totalSells: 0 }))
    assert.equal(findSection(sections, 'scanDepthIndicator')!.text, 'Scan Depth: Insufficient evidence — 0 priced sells reconstructed.')
  })

  // HARD ASSERTION (this task's explicit rule): "partial transaction history can never equal FULL
  // scan depth" — even with a perfect closedLots/totalSells ratio.
  it('HARD ASSERTION: partial transaction history can never equal FULL scan depth', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5, transactionHistoryPartial: true }))
    assert.notEqual(findSection(sections, 'scanDepthIndicator')!.text, 'Scan Depth: FULL.')
  })
})

describe('buildWalletConditionMessages — never fabricates a cause', () => {
  it('a perfectly clean wallet only shows the always-on sections (3, 6, 7, 8, 10), nothing invented', () => {
    const sections = buildWalletConditionMessages(baseInput())
    const ids = sections.map((s) => s.id)
    assert.deepEqual(ids, ['pnlEvidenceLevel', 'walletComplexityLevel', 'walletRiskPosture', 'pnlConfidenceScore', 'scanDepthIndicator'])
  })
})

// =================================================================================================
// REGRESSION — the exact production scenario this task's bug #2 report described, DISCLOSED:
// providerErrors: 2, partial provider status on both chains, 0 closed lots, publicPnlStatus
// unavailable, Alchemy transaction history missing. Before this fix, all three of pnlEvidenceLevel,
// pnlConfidenceScore, and scanDepthIndicator reported FULL / 100% / FULL for this exact input.
// =================================================================================================
describe('buildWalletConditionMessages — REGRESSION: production rate-limited/missing-history scan', () => {
  it('never reports FULL evidence, 100% confidence, or FULL scan depth for a rate-limited, zero-evidence scan', () => {
    const sections = buildWalletConditionMessages(baseInput({
      closedLots: 0,
      totalSells: 0,
      providerErrors: 2,
      publicPnlStatus: 'unavailable',
      rateLimitDetected: true,
      transactionHistoryPartial: true,
    }))
    const evidence = findSection(sections, 'pnlEvidenceLevel')!.text
    const confidence = findSection(sections, 'pnlConfidenceScore')!.text
    const scanDepth = findSection(sections, 'scanDepthIndicator')!.text

    assert.doesNotMatch(evidence, /^PnL Evidence Level: FULL/, 'evidence must never read FULL for this scan')
    assert.match(evidence, /Insufficient evidence/)

    assert.notEqual(confidence, 'PnL Confidence: 100% — Based on available pricing evidence.')
    assert.equal(confidence, 'PnL Confidence: 0% — Based on available pricing evidence.')

    assert.notEqual(scanDepth, 'Scan Depth: FULL.')
    assert.match(scanDepth, /Insufficient evidence/)
  })
})
