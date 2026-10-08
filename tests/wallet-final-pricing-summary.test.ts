// The final Wallet Scanner pricing summary derives from ONE canonical collection: this job's Base/ETH lane merged
// with this job's Robinhood lane. Regression for job bff71a8c (wallet 0x9d69…4184): Robinhood holdings were
// 94/201 priced and Base/ETH 1/2, but the page rendered "24/193 holdings priced" because it kept a previous
// scan's Robinhood result (`prev ?? jobRobinhood`, never cleared on scan start).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  buildWalletFinalPricingSummaryAudit, canonicalPricedTokenCount, computeMergedTotalValueUsd, mergedCoverage,
  resolveRobinhoodResultOnJobComplete, resolveRobinhoodResultOnScanStart,
} from '../app/frontend/lib/mergedWalletView.ts'
import { evidenceFromHoldings, portfolioCoverageText, type PortfolioEvidence } from '../lib/walletScan/portfolioEvidence.ts'
import { buildEvidence } from '../app/frontend/lib/walletReadBuilder.ts'
import { PortfolioIntelligenceCard } from '../app/frontend/components/PortfolioIntelligenceCard.tsx'
import type { RobinhoodWalletScanResponse } from '../lib/walletScan/canonicalWalletSelectors.ts'

const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'

function robinhood(priced: number, total: number, wallet = WALLET): RobinhoodWalletScanResponse {
  const holdings = Array.from({ length: total }, (_, i) => ({
    chainId: 4663, tokenAddress: `0x${(i + 1).toString(16).padStart(40, '0')}`, address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    symbol: `T${i}`, name: null, decimals: 18, rawBalance: '1000000000000000000', normalizedQuantity: 1, uiBalance: 1,
    priceUsd: i < priced ? 1 : null, priceSource: i < priced ? 'dexscreener' : null, valueUsd: i < priced ? 1 : null,
    excludedFromValueReason: null,
  }))
  const portfolioEvidence = evidenceFromHoldings({ holdingsComplete: true, values: holdings.map((h) => h.valueUsd) })
  return {
    ok: true, wallet, chainSlug: 'robinhood', chainId: 4663,
    holdings: {
      status: 'partial', wallet, chainSlug: 'robinhood', chainId: 4663, native: null, holdings,
      portfolioTotalUsd: priced, unpricedTokenCount: total - priced, reason: 'some_holdings_unpriced', fromCache: false,
      portfolioEvidence,
    },
    activity: { status: 'ok', transfers: [], reason: null },
    pnl: { status: 'disabled', message: '', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 0, reason: null },
  } as unknown as RobinhoodWalletScanResponse
}

const EVM: PortfolioEvidence = evidenceFromHoldings({ holdingsComplete: true, values: [12.5, null] }) // Base/ETH 1/2
const FRESH = robinhood(94, 201) // this job's Robinhood lane
const STALE = robinhood(23, 191) // a previous scan's Robinhood lane

test('partial snapshot may show Base/ETH-only coverage before Robinhood completes', () => {
  const c = mergedCoverage(computeMergedTotalValueUsd(12.5, null, undefined, EVM))
  assert.deepEqual(c && { priced: c.priced, total: c.total }, { priced: 1, total: 2 })
})

test('the previous precedence (prev ?? job) reproduces the production 24/193', () => {
  const c = mergedCoverage(computeMergedTotalValueUsd(null, STALE, undefined, EVM))
  assert.deepEqual(c && { priced: c.priced, total: c.total, pct: c.pct }, { priced: 24, total: 193, pct: 12 })
})

test('after the job completes, its own Robinhood lane replaces an earlier one: 95/203, never 24/193', () => {
  const next = resolveRobinhoodResultOnJobComplete({ prev: STALE, wallet: WALLET, jobRobinhood: FRESH })
  assert.equal(next, FRESH)
  const c = mergedCoverage(computeMergedTotalValueUsd(null, next, undefined, EVM))
  assert.deepEqual(c && { priced: c.priced, total: c.total }, { priced: 95, total: 203 })
  assert.notEqual(`${c!.priced}/${c!.total}`, '24/193')
})

test('a job-backed route result for the same job is replaced by identical data, never by an older lane', () => {
  const next = resolveRobinhoodResultOnJobComplete({ prev: FRESH, wallet: WALLET, jobRobinhood: robinhood(94, 201) })
  const c = mergedCoverage(computeMergedTotalValueUsd(null, next, undefined, EVM))
  assert.equal(`${c!.priced}/${c!.total}`, '95/203')
})

test('scan start keeps a previous Robinhood lane only for the same wallet; a job without Robinhood never adopts another wallet', () => {
  assert.equal(resolveRobinhoodResultOnScanStart(STALE, WALLET.toUpperCase().replace('0X', '0x')), STALE)
  assert.equal(resolveRobinhoodResultOnScanStart(robinhood(5, 9, '0x' + '1'.repeat(40)), WALLET), null)
  assert.equal(resolveRobinhoodResultOnScanStart(null, WALLET), null)
  assert.equal(resolveRobinhoodResultOnJobComplete({ prev: robinhood(5, 9, '0x' + '1'.repeat(40)), wallet: WALLET, jobRobinhood: null }), null)
  assert.equal(resolveRobinhoodResultOnJobComplete({ prev: FRESH, wallet: WALLET, jobRobinhood: null }), FRESH)
})

test('[wallet-final-pricing-summary-audit] reports each lane, the canonical merge and the rendered coverage', () => {
  const audit = buildWalletFinalPricingSummaryAudit({ evmEvidence: EVM, robinhoodResult: FRESH, jobId: 'job-1', robinhoodResultJobId: 'job-1' })
  assert.deepEqual(
    [audit.evmPriced, audit.evmTotal, audit.robinhoodPriced, audit.robinhoodTotal, audit.combinedPriced, audit.combinedTotal, audit.renderedPriced, audit.renderedTotal],
    [1, 2, 94, 201, 95, 203, 95, 203],
  )
  assert.equal(audit.sources.robinhood, 'robinhoodResult.holdings.portfolioEvidence')
})

test('Priced Tokens and the Pricing Coverage numerator use the same canonical evidence', () => {
  const merged = computeMergedTotalValueUsd(null, FRESH, undefined, EVM)
  assert.equal(canonicalPricedTokenCount(merged, 999), merged.evidence!.pricedHoldings)
  assert.equal(canonicalPricedTokenCount({ evidence: null }, 7), 7, 'legacy count only without evidence')
  const html = renderToStaticMarkup(createElement(PortfolioIntelligenceCard, {
    portfolio: null, portfolioV2: null, chainsScanned: ['base', 'eth'], robinhoodResult: FRESH, evmEvidence: EVM,
  }))
  assert.match(html, /95\/203 holdings priced/)
  assert.match(html, /Priced Tokens<\/div><div[^>]*>95<\/div>/)
  assert.doesNotMatch(html, /24\/193/)
})

test('evidence-panel coverage copy matches the main portfolio coverage (recent-verified included)', () => {
  const merged = computeMergedTotalValueUsd(null, FRESH, undefined, EVM)
  const evidence = buildEvidence({
    hasHoldingsData: true, pnlConfidence: { realized: 'Partial', unrealized: 'Unavailable', historicalCoverage: 'Not available' } as never,
    robinhoodDisplayState: 'valued', robinhoodPnlLane: 'not_verified', matchedLotsCount: 0, portfolioEvidence: merged.evidence,
  })
  assert.ok(evidence.partial.includes('Portfolio value (pricing coverage 95/203)'), evidence.partial.join(' | '))
  assert.equal(portfolioCoverageText(merged.evidence), '95/203 holdings priced')
  // A recent-verified holding counts in the denominator of both surfaces.
  const withStale: PortfolioEvidence = { ...merged.evidence!, staleVerifiedHoldings: 1, staleVerifiedSubtotalUsd: 3 }
  const e2 = buildEvidence({
    hasHoldingsData: true, pnlConfidence: { realized: 'Partial', unrealized: 'Unavailable', historicalCoverage: 'Not available' } as never,
    robinhoodDisplayState: 'valued', robinhoodPnlLane: 'not_verified', matchedLotsCount: 0, portfolioEvidence: withStale,
  })
  const c = mergedCoverage({ evidence: withStale })!
  assert.ok(e2.partial.includes(`Portfolio value (pricing coverage ${c.priced}/${c.total})`), e2.partial.join(' | '))
})
