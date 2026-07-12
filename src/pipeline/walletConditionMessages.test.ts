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
  it('shows LIMITED with real counts when closedLots < totalSells', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 3, totalSells: 10 }))
    assert.equal(findSection(sections, 'pnlEvidenceLevel')!.text, 'PnL Evidence Level: LIMITED — 3 of 10 sells had verifiable pricing.')
  })

  it('shows FULL when closedLots === totalSells', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5 }))
    assert.equal(findSection(sections, 'pnlEvidenceLevel')!.text, 'PnL Evidence Level: FULL — All priced sells had complete on-chain evidence.')
  })

  it('shows FULL when there are zero sells (vacuously complete, not "limited")', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 0, totalSells: 0 }))
    assert.match(findSection(sections, 'pnlEvidenceLevel')!.text, /^PnL Evidence Level: FULL/)
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

  it('is 100% when there are zero sells (guarded against divide-by-zero)', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 0, totalSells: 0 }))
    assert.equal(findSection(sections, 'pnlConfidenceScore')!.text, 'PnL Confidence: 100% — Based on available pricing evidence.')
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
  it('is LIMITED with a real count when closedLots < totalSells', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 2, totalSells: 9 }))
    assert.equal(findSection(sections, 'scanDepthIndicator')!.text, 'Scan Depth: LIMITED — Only 2 priced sells reconstructed.')
  })

  it('is FULL when closedLots === totalSells', () => {
    const sections = buildWalletConditionMessages(baseInput({ closedLots: 5, totalSells: 5 }))
    assert.equal(findSection(sections, 'scanDepthIndicator')!.text, 'Scan Depth: FULL.')
  })
})

describe('buildWalletConditionMessages — never fabricates a cause', () => {
  it('a perfectly clean wallet only shows the always-on sections (3, 6, 7, 8, 10), nothing invented', () => {
    const sections = buildWalletConditionMessages(baseInput())
    const ids = sections.map((s) => s.id)
    assert.deepEqual(ids, ['pnlEvidenceLevel', 'walletComplexityLevel', 'walletRiskPosture', 'pnlConfidenceScore', 'scanDepthIndicator'])
  })
})
