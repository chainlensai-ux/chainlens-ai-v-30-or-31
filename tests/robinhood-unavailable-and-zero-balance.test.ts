// A Robinhood activity lookup that timed out is "couldn't check", never "No activity"; a completed holdings
// scan whose only entry has a zero balance is a verified $0, never "found holdings but could not price them".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectRobinhoodSwapEvidence, type RobinhoodWalletScanResponse, type RobinhoodPnlSummary } from '../lib/walletScan/canonicalWalletSelectors.ts'
import { computeRobinhoodDisplayState, robinhoodStatusCopy, ROBINHOOD_FOUND_UNPRICED_COPY, ROBINHOOD_ZERO_BALANCE_COPY } from '../app/frontend/lib/mergedWalletView.ts'

const WALLET = '0x30ec8aea2ab3d5000da703912193294a81430cc8'
const UNAVAILABLE = 'Robinhood wallet activity unavailable (timeout; Blockscout fallback failed: blockscout_returned_no_rows).'

function pnl(over: Partial<RobinhoodPnlSummary> = {}): RobinhoodPnlSummary {
  return {
    status: 'unavailable', structuralClosedLots: 0, verifiedClosedLots: 0, pricingCoverage: null, realizedPnlUsd: null, realizedRoiPct: null,
    unmatchedSellCount: 0, exactReason: UNAVAILABLE, swapsFound: 0, swapsVerified: 0, swapsBothLegsPriced: 0, ...over,
  }
}
function result(holdings: Record<string, unknown>, robinhoodPnl: RobinhoodPnlSummary = pnl()): RobinhoodWalletScanResponse {
  return {
    ok: true, wallet: WALLET, chainSlug: 'robinhood', chainId: 4663,
    holdings: { status: 'ok', native: null, holdings: [], portfolioTotalUsd: null, unpricedTokenCount: 0, reason: null, ...holdings },
    activity: { status: 'unavailable', items: [], skippedSwapLogs: 0, verifiedSwapCount: 0, reason: 'timeout' },
    pnl: { status: 'disabled', message: '', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 0, reason: UNAVAILABLE },
    robinhoodWalletScannerAudit: {},
    robinhoodPnlVerificationAudit: null,
    robinhoodPnl,
  } as unknown as RobinhoodWalletScanResponse
}

test('an unavailable (timed-out) Robinhood lane is not "No activity" and shows its real reason', () => {
  const ev = selectRobinhoodSwapEvidence(result({}))!
  assert.equal(ev.noActivity, false)
  assert.match(ev.reason!, /^Robinhood wallet activity unavailable \(timeout/)
})

test('a completed lane with zero swaps found is still "No activity"', () => {
  const ev = selectRobinhoodSwapEvidence(result({}, pnl({ status: 'not_verified', exactReason: 'No Robinhood transactions with token movements were found for this wallet.' })))!
  assert.equal(ev.noActivity, true)
})

test('a priced native asset with a zero balance is a verified $0 lane, not "could not price them"', () => {
  const r = result({ native: { rawBalance: '0', uiBalance: 0, priceUsd: 3000, valueUsd: 0 } })
  assert.equal(computeRobinhoodDisplayState(r), 'valued')
  assert.equal(robinhoodStatusCopy(r, false), ROBINHOOD_ZERO_BALANCE_COPY)
})

test('a real held but unpriced token still says "found holdings but could not price them"', () => {
  const r = result({ status: 'partial', holdings: [{ tokenAddress: '0x1', rawBalance: '5', uiBalance: 5, priceUsd: null, valueUsd: null }], unpricedTokenCount: 1 })
  assert.equal(computeRobinhoodDisplayState(r), 'partial_unpriced')
  assert.equal(robinhoodStatusCopy(r, false), ROBINHOOD_FOUND_UNPRICED_COPY)
})
