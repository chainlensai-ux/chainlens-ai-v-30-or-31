// Wallet Scanner result semantics: successful partial evidence must not read as a failed scan, and every surface must
// keep verified swaps, closed trades/lots, priced swaps, realized PnL and behavioral-only intelligence apart.
// Gates are unchanged: a verified swap never becomes a closed trade, and realized PnL stays unverified until a lot closes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  selectRobinhoodSwapEvidence, robinhoodPnlCardView, selectRobinhoodPnlLaneStatus, ROBINHOOD_PNL_NOT_VERIFIED_REASON,
  type RobinhoodWalletScanResponse, type RobinhoodPnlSummary,
} from '../lib/walletScan/canonicalWalletSelectors.ts'
import { buildWalletPnlViewModel } from '../app/frontend/lib/buildWalletPnlViewModel.ts'
import { buildPnlLanes, buildKeySignals, buildEvidence, buildHeadline } from '../app/frontend/lib/walletReadBuilder.ts'
import { SmartMoneyScoreCard } from '../app/frontend/components/SmartMoneyScoreCard.tsx'
import { buildRobinhoodPnlVerificationAuditFromV1, robinhoodWalletPnlFromV1 } from '../lib/server/robinhoodWalletScanner.ts'
import type { SmartMoneyScore } from '../lib/engine/modules/smartMoney/types.ts'
import type { RobinhoodPnlV1 } from '../lib/server/robinhoodPnlV1.ts'

const OPEN_COPY = '3 swaps verified · 3/3 priced on both legs · no verified buy→sell lot closed yet.'
const V1_EXACT = '3 swaps proven, 3 priced on both legs, but no buy→sell pair closed a lot in this sample.'

function v1Summary(over: Partial<RobinhoodPnlSummary> = {}): RobinhoodPnlSummary {
  return {
    status: 'not_verified', structuralClosedLots: 0, verifiedClosedLots: 0, pricingCoverage: null, realizedPnlUsd: null, realizedRoiPct: null,
    unmatchedSellCount: 0, exactReason: V1_EXACT, swapsFound: 3, swapsVerified: 3, swapsBothLegsPriced: 3, ...over,
  }
}
// The production shape for 0x9d69…: 3 proven swaps, 3/3 both-leg priced, 0 FIFO closed lots.
function rhResult(pnl: Partial<RobinhoodPnlSummary> = {}): RobinhoodWalletScanResponse {
  return {
    ok: true, wallet: '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184', chainSlug: 'robinhood', chainId: 4663,
    holdings: { status: 'ok', native: null, holdings: [], portfolioTotalUsd: 0, unpricedTokenCount: 0, reason: null },
    activity: { status: 'ok', items: [], skippedSwapLogs: 0, verifiedSwapCount: 0, blockscoutEvidence: { blockscoutAttempted: false, blockscoutSucceeded: false, blockscoutFallbackUsed: false, blockscoutStatus: 'not_attempted', blockscoutError: null, blockscoutVerifiedSwap: false }, reason: null },
    pnl: { status: 'disabled', message: '', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 3, reason: V1_EXACT },
    robinhoodWalletScannerAudit: {},
    robinhoodPnl: v1Summary(pnl),
  }
}

test('3 swaps verified + 3 priced + 0 closed lots → OPEN POSITION ONLY copy on every surface, never the missing-evidence copy', () => {
  const r = rhResult()
  assert.equal(selectRobinhoodPnlLaneStatus(r), 'not_verified', 'realized PnL is still NOT verified — the gate is unchanged')
  const ev = selectRobinhoodSwapEvidence(r)!
  assert.deepEqual([ev.swapsVerified, ev.swapsBothLegsPriced, ev.closedLots, ev.openPositionOnly, ev.reason], [3, 3, 0, true, OPEN_COPY])

  const card = robinhoodPnlCardView(r.robinhoodPnl)!
  assert.deepEqual([card.kind, card.statusLabel, card.kind === 'blocker' ? card.blocker : null], ['blocker', 'OPEN POSITION ONLY', OPEN_COPY])

  const vm = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: r, chainsScanned: ['base', 'eth'] })
  assert.equal(vm.robinhoodBox.status, 'Open position only')
  assert.equal(vm.robinhoodBox.reason, OPEN_COPY)
  assert.equal(vm.robinhoodBox.value, null, 'no realized figure is fabricated')
  const row = vm.chainRows.find((c) => c.chain === 'robinhood')!
  assert.deepEqual([row.status, row.reason, row.value], ['Open position only', OPEN_COPY, null])

  const lanes = buildPnlLanes({ evmPnlLane: 'unavailable', robinhoodPnlLane: 'not_verified', robinhoodResult: r })
  assert.deepEqual([lanes[1].status, lanes[1].statusLabel, lanes[1].detail], ['not_verified', 'Open position only', OPEN_COPY])

  for (const text of [card.kind === 'blocker' ? card.blocker : '', vm.robinhoodBox.reason, row.reason, lanes[1].detail]) {
    assert.notEqual(text, ROBINHOOD_PNL_NOT_VERIFIED_REASON)
    assert.ok(!text.includes('Requires verified Robinhood swaps'))
  }
})

test('not open-position cases keep their own honest copy (lots closed but unpriced; partial pricing; nothing proven)', () => {
  const unpriced = selectRobinhoodSwapEvidence(rhResult({ structuralClosedLots: 2, exactReason: '2 lots closed, but none had verified prices on both the buy and the sell.' }))!
  assert.deepEqual([unpriced.openPositionOnly, unpriced.reason], [false, '2 lots closed, but none had verified prices on both the buy and the sell.'])
  const partial = selectRobinhoodSwapEvidence(rhResult({ swapsBothLegsPriced: 2, exactReason: 'x' }))!
  assert.equal(partial.openPositionOnly, false)
  assert.equal(robinhoodPnlCardView(rhResult({ swapsBothLegsPriced: 2 }).robinhoodPnl)!.statusLabel, 'NOT VERIFIED')
  const none = rhResult({ swapsVerified: 0, swapsBothLegsPriced: 0, swapsFound: 0, exactReason: '0 swaps found / 0 proven as wallet V4 trades.' })
  assert.equal(selectRobinhoodSwapEvidence(none)!.openPositionOnly, false)
  assert.equal(selectRobinhoodSwapEvidence({ ...rhResult(), ok: false }), null)
})

test('generic Robinhood missing-evidence reason cannot overwrite the specific no-closed-lots reason (API contract + UI)', () => {
  const v1 = { ...v1Summary(), ingestionAudit: {}, priceEvidence: [], metrics: {} } as unknown as RobinhoodPnlV1
  const pnl = robinhoodWalletPnlFromV1(v1)
  const audit = buildRobinhoodPnlVerificationAuditFromV1({ wallet: rhResult().wallet, holdings: null, activity: null, pnl, robinhoodPnl: v1 })
  assert.equal(audit.rejectedReasonIfNotVerified, V1_EXACT)
  assert.equal(audit.pnlDisabledReason, V1_EXACT)
  assert.equal(pnl.reason, V1_EXACT)
  // with no proven swap at all, the generic reason is still the honest one
  const empty = { ...v1, swapsVerified: 0, swapsBothLegsPriced: 0, swapsFound: 0, exactReason: '0 swaps found / 0 proven as wallet V4 trades.' } as RobinhoodPnlV1
  assert.equal(buildRobinhoodPnlVerificationAuditFromV1({ wallet: rhResult().wallet, holdings: null, activity: null, pnl: robinhoodWalletPnlFromV1(empty), robinhoodPnl: empty }).rejectedReasonIfNotVerified, ROBINHOOD_PNL_NOT_VERIFIED_REASON)
  // a sidecar response carrying a specific audit reason never renders the generic one in the PnL view model
  const withAudit = { ...rhResult(), robinhoodPnlVerificationAudit: audit }
  const vm = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: withAudit, chainsScanned: [] })
  assert.equal(vm.robinhoodBox.reason, OPEN_COPY)
})

function smartMoney(over: Partial<SmartMoneyScore> = {}): SmartMoneyScore {
  return {
    status: 'not_yet_rated', officialScore: null, provisionalBehaviorScore: null,
    evidenceConfidence: { value: 0.1, level: 'low', fullyPricedTradeCount: 0, totalMatchedLotCount: 0, verifiedCoveragePercent: null, historyDays: null },
    breakdown: { verifiedProfitability: null, verifiedWinQuality: null, riskAdjustedPerformance: null, timingQuality: null, consistency: null, behaviorQuality: 65 },
    notes: ['Only 0 fully priced, verified trades — at least 10 are required.'], reasonNotRated: 'Only 0 fully priced, verified trades — at least 10 are required.',
    ...over,
  }
}
const render = (score: SmartMoneyScore, swaps: number | null) => renderToStaticMarkup(createElement(SmartMoneyScoreCard, { smartMoneyScore: score, robinhoodVerifiedSwapCount: swaps }))

test('behaviorQuality 65 + no closed trades → performance score stays unrated; Behavioral Intelligence renders 65 separately', () => {
  const html = render(smartMoney(), 3)
  assert.ok(html.includes('Insufficient Performance History'))
  assert.ok(html.includes('Behavioral Intelligence:'))
  assert.ok(html.includes('65/100'))
  assert.ok(html.includes('Low confidence'))
  assert.ok(html.includes('behavior only, not part of the performance score'))
  assert.ok(!html.includes('Provisional Behaviour Score'), 'no /100 Smart Money headline built from behaviour alone')
  assert.ok(!html.includes('Not official'))
  // an official score never shows the behavioral-only line
  const official = render(smartMoney({ status: 'official', officialScore: 72, evidenceConfidence: { value: 0.9, level: 'high', fullyPricedTradeCount: 12, totalMatchedLotCount: 12, verifiedCoveragePercent: 100, historyDays: 30 } }), 3)
  assert.ok(!official.includes('Behavioral Intelligence:'))
  // a provisional score (1+ verified lot) keeps its existing header and does not duplicate behaviour
  const provisional = render(smartMoney({ provisionalBehaviorScore: 58, evidenceConfidence: { value: 0.3, level: 'low', fullyPricedTradeCount: 2, totalMatchedLotCount: 4, verifiedCoveragePercent: 50, historyDays: 5 } }), null)
  assert.ok(provisional.includes('Provisional Behaviour Score') && !provisional.includes('Behavioral Intelligence:'))
})

test('verified swaps and verified closed trades render as separate counts', () => {
  const html = render(smartMoney(), 3)
  assert.ok(html.includes('Verified Closed Trades'))
  assert.ok(!html.includes('>Verified Trades<'))
  assert.ok(html.includes('Verified Closed Trades</div><div style="font-size:14px;font-weight:800;color:#e2e8f0">0 / 10 minimum'), 'closed trades stay 0 / 10')
  assert.ok(html.includes('>3 swaps verified — a verified swap is not a closed trade<'), 'the swap count sits next to, and apart from, the closed-trade count')
  assert.ok(!render(smartMoney(), null).includes('swap'), 'no swap line without Robinhood swap evidence')
  // CORTEX evidence panel: swaps verified/priced are VERIFIED; closed-lot PnL and the performance score are MISSING
  const evidence = buildEvidence({
    hasHoldingsData: true, pnlConfidence: { realized: 'Partial', unrealized: 'Unavailable', historicalCoverage: 'Not available' } as never,
    robinhoodDisplayState: 'valued', robinhoodPnlLane: 'not_verified', matchedLotsCount: 0,
    robinhoodSwapEvidence: selectRobinhoodSwapEvidence(rhResult()), behaviorProfileAvailable: true,
    portfolioEvidence: { valueUsd: null, pricedSubtotalUsd: 100, status: 'partial', pricedHoldings: 98, unpricedHoldings: 106, holdingsComplete: true, reason: null },
    smartMoneyStatus: 'not_yet_rated',
  })
  assert.ok(evidence.verified.includes('Robinhood holdings scan'))
  assert.ok(evidence.verified.includes('3 Robinhood swaps verified'))
  assert.ok(evidence.verified.includes('3 swaps priced on both legs'))
  assert.ok(!evidence.verified.includes('Closed-lot sample'))
  assert.ok(evidence.partial.includes('Behavioral profile'))
  assert.ok(evidence.partial.includes('Portfolio value (pricing coverage 98/204)'))
  assert.ok(!evidence.partial.includes('Robinhood PnL (real evidence, not fully verified)'))
  assert.ok(evidence.missing.includes('Realized closed-lot PnL (no verified buy→sell lot closed yet)'))
  assert.ok(evidence.missing.includes('Closed-trade performance score'))
})

test('"chains scanned" and the personality card\'s active EVM chains never share the ambiguous "active chains" label', () => {
  const signals = buildKeySignals({
    chainsScanned: ['base', 'eth'], robinhoodIncluded: true, totalValueUsd: 100, topChain: null, pricedTokenCount: 1,
    lastActiveMs: null, buyCount: 2, sellCount: 0, rotationStyle: 'accumulator',
  })
  assert.equal(signals.find((s) => s.label === 'Chains scanned')?.value, 'Base, ETH, Robinhood')
  assert.ok(!signals.some((s) => /active/i.test(s.label) && /chain/i.test(s.label)))
  const headline = buildHeadline({ personalityLabel: 'Accumulator', activeChainCount: 3, topChain: null, evmPnlLane: 'unavailable' })
  assert.ok(headline.includes('across 3 scanned chains'), headline)
})
