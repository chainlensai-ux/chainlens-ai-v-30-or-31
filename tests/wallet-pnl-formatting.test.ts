// Negative zero / float residue never renders "-$0.00", and a Robinhood-evidence wallet's PnL header never reads
// as if the whole PnL section failed — while combined realized PnL stays unavailable (no fabrication).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtSignedUsd, fmtUsd } from '../app/frontend/lib/holdingsHeuristics.ts'
import { buildWalletPnlViewModel, shouldSuppressUnverifiedZeroPnl } from '../app/frontend/lib/buildWalletPnlViewModel.ts'
import { robinhoodPnlCardView, type RobinhoodWalletScanResponse, type RobinhoodPnlSummary } from '../lib/walletScan/canonicalWalletSelectors.ts'

test('-0 and tiny negative float residue format as $0.00, never -$0.00', () => {
  for (const v of [-0, 0, -1e-12, -0.0049, 0.0049, -0.000000001]) {
    assert.equal(fmtSignedUsd(v), '$0.00', String(v))
    assert.equal(fmtUsd(v), '$0.00', String(v))
  }
  assert.equal(fmtSignedUsd(-0.005), '-$0.01')
  assert.equal(fmtSignedUsd(-12.34), '-$12.34')
  assert.equal(fmtSignedUsd(12.34), '+$12.34')
  assert.equal(fmtSignedUsd(null), '—')
  const card = robinhoodPnlCardView({ status: 'verified_bounded_sample', structuralClosedLots: 1, verifiedClosedLots: 1, pricingCoverage: 100, realizedPnlUsd: -1e-12, realizedRoiPct: 0, unmatchedSellCount: 0, exactReason: '', swapsFound: 2, swapsVerified: 2, swapsBothLegsPriced: 2 })
  assert.equal(card?.kind === 'sample' ? card.realized : null, '$0.00')
})

test('an unverified sub-cent figure (incl. -0) is suppressed like an unverified zero', () => {
  for (const v of [0, -0, -1e-12, 0.004]) assert.equal(shouldSuppressUnverifiedZeroPnl('Partial', v), true, String(v))
  assert.equal(shouldSuppressUnverifiedZeroPnl('Partial', -0.5), false)
  assert.equal(shouldSuppressUnverifiedZeroPnl('Verified', -0), false, 'a verified zero still shows $0.00')
  assert.equal(shouldSuppressUnverifiedZeroPnl('Partial', null), false)
})

function rh(pnl: Partial<RobinhoodPnlSummary> = {}): RobinhoodWalletScanResponse {
  return {
    ok: true, wallet: '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184', chainSlug: 'robinhood', chainId: 4663,
    holdings: { status: 'ok', native: null, holdings: [], portfolioTotalUsd: 0, unpricedTokenCount: 0, reason: null },
    activity: { status: 'ok', items: [], skippedSwapLogs: 0, verifiedSwapCount: 0, reason: null, blockscoutEvidence: { blockscoutAttempted: false, blockscoutSucceeded: false, blockscoutFallbackUsed: false, blockscoutStatus: 'not_attempted', blockscoutError: null, blockscoutVerifiedSwap: false } },
    pnl: { status: 'disabled', message: '', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 3, reason: null },
    robinhoodWalletScannerAudit: {},
    robinhoodPnl: { status: 'not_verified', structuralClosedLots: 0, verifiedClosedLots: 0, pricingCoverage: null, realizedPnlUsd: null, realizedRoiPct: null, unmatchedSellCount: 0, exactReason: 'x', swapsFound: 3, swapsVerified: 3, swapsBothLegsPriced: 3, ...pnl },
  }
}

test('combined PnL header: Robinhood open-position evidence → "Partial" + specific reason, combined realized still unavailable', () => {
  const vm = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: rh(), chainsScanned: ['base', 'eth'] })
  assert.equal(vm.combinedStatus, 'unavailable', 'the gate is unchanged')
  assert.equal(vm.evidenceBadgeLabel, 'Partial')
  assert.equal(vm.combinedReason, 'Realized PnL unavailable · Robinhood open-position evidence verified')
  assert.equal(vm.combinedRealizedBox.status, 'Unavailable')
  assert.equal(vm.combinedRealizedBox.value, null)
  assert.equal(vm.roiBox.value, null)
  assert.equal(vm.verifiedSampleRealizedBox.value, null)
  // verified swaps but not open-position-only (e.g. partial pricing) → named by count
  const counted = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: rh({ swapsBothLegsPriced: 2 }), chainsScanned: [] })
  assert.equal(counted.combinedReason, 'Realized PnL unavailable · 3 Robinhood swaps verified')
  // no Robinhood evidence → unchanged generic presentation
  const none = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: rh({ swapsVerified: 0, swapsBothLegsPriced: 0 }), chainsScanned: [] })
  assert.equal(none.evidenceBadgeLabel, null)
  assert.equal(none.combinedReason, 'PnL unavailable due to missing evidence')
  const noRh = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: null, chainsScanned: [] })
  assert.equal(noRh.evidenceBadgeLabel, null)
})
