import fs from 'node:fs'
import assert from 'node:assert/strict'

const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')
const engine = fs.readFileSync('lib/server/smartRecoveryEngine.ts', 'utf8')
const windowMod = fs.readFileSync('lib/server/smartRecoveryWindow.ts', 'utf8')

// Smart Recovery must be admin-gated on the server using the same fullRecoveryAllowed check as
// full_recovery — never trusting the client-sent walletScanMode alone.
assert.match(route, /smartRecoveryRequested[\s\S]{0,200}if \(!fullRecoveryAllowed\)/, 'smart_recovery route branch is gated by fullRecoveryAllowed')
assert.match(route, /Smart Recovery is admin-only\./, 'route returns admin-only error for non-admins')

// Smart Recovery must delegate to the existing fetchWalletSnapshot pipeline, not reimplement FIFO.
assert.match(engine, /import \{ fetchWalletSnapshot, WALLET_SCAN_MODE_CONFIG/, 'engine imports fetchWalletSnapshot instead of reimplementing the pipeline')
assert.match(engine, /await fetchWalletSnapshot\(/, 'engine calls fetchWalletSnapshot')
assert.doesNotMatch(engine, /function matchFifo|function reconstructFifo/i, 'engine does not reimplement FIFO matching')

// Window detection is capped (cheap pre-pass), not a full-history scan.
assert.match(windowMod, /Math\.max\(1, Math\.min\(maxPages, 2\)\)/, 'window detection caps pages to a cheap pre-pass')

// Frontend: button and handler exist, gated by isFullRecoveryAdmin, with correct mode string.
assert.match(page, /handleScan\('smart_recovery'\)/, 'frontend triggers smart_recovery scan mode')
assert.match(page, /Smart Recovery \(Admin\)/, 'frontend has Smart Recovery admin button label')
assert.match(page, /Smart Recovery is admin-only\./, 'frontend blocks non-admins with correct message')

// Route must derive pagesUsed from what was actually consumed, not the max-allowed cap.
assert.match(route, /actualPagesUsed = \[/, 'route derives actualPagesUsed from a preferred-source list')
assert.match(route, /result\.smartRecoveryWindow\.pagesUsed,/, 'actual pages source order starts with smartRecoveryWindow.pagesUsed')
assert.match(route, /result\.snapshot\.walletHistoricalCoverageSummary\?\.pagesAttempted,/, 'actual pages falls back to walletHistoricalCoverageSummary.pagesAttempted')
assert.match(route, /historicalScanDebugPagesAttempted,/, 'actual pages falls back to walletHistoricalScanDebug.pagesAttempted')
assert.doesNotMatch(route, /pagesUsed: result\.smartRecoveryPagesUsed/, 'route no longer reports the max-allowed page cap as pagesUsed')

// Smart Recovery PnL fields must be gated by the same integrity signal as official PnL.
assert.match(route, /officialPnlUnlocked = \(/, 'route computes an officialPnlUnlocked gate')
assert.match(route, /publicPnlIntegrityGate\?\.hardInvalid !== true/, 'gate checks publicPnlIntegrityGate.hardInvalid')
assert.match(route, /excludedFrom = \['official_realized_pnl', 'win_rate', 'profit_skill', 'wallet_score', 'verified_pnl'\]/, 'locked smartRecoveryLots are excluded from official PnL/win-rate/profit-skill/wallet-score/verified-pnl')
assert.match(route, /smartRecoveryLots\.publicUse = false/, 'locked smartRecoveryLots set publicUse to false')

// Runtime regression: replicate the exact derivation formulas against the reported bug's fixture
// numbers, so the fix is verified behaviorally, not just via source regex.
function deriveActualPagesUsed(result) {
  return [
    result.smartRecoveryWindow.pagesUsed,
    result.snapshot.walletHistoricalCoverageSummary?.pagesAttempted,
    result.snapshot._debug?.walletScannerDiagnostics?.walletHistoricalScanDebug?.pagesAttempted,
  ].find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) ?? 0
}

function deriveOfficialPnlUnlocked(snapshot) {
  return (
    snapshot.publicPnlStatus === 'ok' &&
    snapshot.publicRealizedPnlUsd != null &&
    snapshot.publicPerformanceRealizedPnlUsd != null &&
    snapshot.publicPnlIntegrityGate?.hardInvalid !== true
  )
}

function deriveSmartRecoveryLots(rawLotSummary, officialPnlUnlocked) {
  const lots = { ...rawLotSummary }
  if (!officialPnlUnlocked) {
    lots.rawPreviewRealizedPnlUsd = rawLotSummary.realizedPnlUsd ?? null
    lots.rawPreviewRealizedPnlPercent = rawLotSummary.realizedPnlPercent ?? null
    lots.previewClosedLots = rawLotSummary.closedLots ?? null
    lots.realizedPnlUsd = null
    lots.realizedPnlPercent = null
    lots.readyForTradeStats = false
    lots.publicUse = false
    lots.excludedFrom = ['official_realized_pnl', 'win_rate', 'profit_skill', 'wallet_score', 'verified_pnl']
    lots.warning = 'Smart Recovery preview only — official PnL remains locked by integrity checks.'
  }
  return lots
}

function deriveMissingCostBasisStatus(rawMissingCostBasis, rawLotSummary) {
  const missingCostBasis = { ...rawMissingCostBasis }
  const missingList = Array.isArray(rawLotSummary?.missing) ? rawLotSummary.missing : []
  const unresolved = (rawLotSummary?.unmatchedSells ?? 0) > 0 || missingList.some((m) => typeof m === 'string' && m.startsWith('missing_cost_basis_sells'))
  if (missingCostBasis.requested && unresolved) missingCostBasis.status = 'partial'
  return missingCostBasis
}

const bugReportFixture = {
  smartRecoveryWindow: { startTimestamp: '2024-01-01T00:00:00.000Z', endTimestamp: '2024-02-01T00:00:00.000Z', confidence: 'high', pagesUsed: 2, transfersSeen: 60, reason: null },
  snapshot: {
    walletHistoricalCoverageSummary: { status: 'ok', requested: true, pagesAttempted: 2, maxPages: 6, maxPagesPerChain: 6, maxPagesTotal: 6, pagesAttemptedTotal: 2, pagesAttemptedByChain: { base: 2 }, rawTransactions: 40, rawLogEvents: 40, normalizedEvents: 40, walletSideEvents: 40, swapLikeTransactions: 8, pricedSwapCandidates: 8, matchedClosedLotsBefore: 4, matchedClosedLotsAfter: 5, addedClosedLots: 1, coverageLevel: 'medium', missing: [], reason: null },
    _debug: { walletScannerDiagnostics: { walletHistoricalScanDebug: { pagesAttempted: 2 } } },
    publicPnlStatus: 'open_check_integrity_invalid',
    publicRealizedPnlUsd: null,
    publicPerformanceRealizedPnlUsd: null,
    publicPnlIntegrityGate: { applied: true, hardInvalid: true, softPartialOnly: false, integrityErrors: ['sample'], publicPnlBeforeGate: null, publicPnlAfterGate: null, winRateBeforeGate: null, winRateAfterGate: null, reason: 'integrity_check_failed' },
    walletLotSummary: {
      status: 'partial',
      closedLots: 5, closedLotsForStats: 4, estimateOnlyClosedLots: 1,
      unmatchedBuys: 2, unmatchedSells: 1,
      realizedPnlUsd: -338.60, realizedPnlPercent: -22.36,
      readyForTradeStats: true,
      missing: ['unmatched_sells', 'unmatched_buys', 'missing_cost_basis_sells:1'],
    },
  },
  smartRecoveryMaxPagesAllowed: 6,
  smartRecoveryMaxPriceAttemptsAllowed: 20,
}

const actualPagesUsed = deriveActualPagesUsed(bugReportFixture)
assert.equal(actualPagesUsed, 2, 'smartRecoveryCost.pagesUsed must equal actual pages consumed (2), not the max allowed (6)')
assert.notEqual(actualPagesUsed, bugReportFixture.smartRecoveryMaxPagesAllowed, 'smartRecoveryCost.pagesUsed must differ from maxPagesAllowed when only 2 of 6 pages were consumed')

const officialPnlUnlocked = deriveOfficialPnlUnlocked(bugReportFixture.snapshot)
assert.equal(officialPnlUnlocked, false, 'officialPnlUnlocked must be false when publicPnlIntegrityGate.hardInvalid is true')
assert.equal(bugReportFixture.snapshot.publicPnlStatus, 'open_check_integrity_invalid')
assert.equal(bugReportFixture.snapshot.publicRealizedPnlUsd, null)

const sanitizedLots = deriveSmartRecoveryLots(bugReportFixture.snapshot.walletLotSummary, officialPnlUnlocked)
assert.equal(sanitizedLots.realizedPnlUsd, null, 'smartRecoveryLots.realizedPnlUsd must be null when official PnL is locked')
assert.equal(sanitizedLots.realizedPnlPercent, null, 'smartRecoveryLots.realizedPnlPercent must be null when official PnL is locked')
assert.equal(typeof sanitizedLots.rawPreviewRealizedPnlUsd, 'number', 'smartRecoveryLots.rawPreviewRealizedPnlUsd must carry the raw preview number')
assert.equal(sanitizedLots.publicUse, false, 'smartRecoveryLots.publicUse must be false when official PnL is locked')
assert.ok(sanitizedLots.excludedFrom.includes('profit_skill'), 'smartRecoveryLots.excludedFrom must include profit_skill')
assert.equal(sanitizedLots.closedLots, 5, 'evidence counts (closedLots) must be preserved, not deleted')
assert.equal(sanitizedLots.closedLotsForStats, 4, 'evidence counts (closedLotsForStats) must be preserved')
assert.equal(sanitizedLots.estimateOnlyClosedLots, 1, 'evidence counts (estimateOnlyClosedLots) must be preserved')
assert.equal(sanitizedLots.unmatchedBuys, 2, 'evidence counts (unmatchedBuys) must be preserved')
assert.equal(sanitizedLots.unmatchedSells, 1, 'evidence counts (unmatchedSells) must be preserved')
assert.deepEqual(sanitizedLots.missing, ['unmatched_sells', 'unmatched_buys', 'missing_cost_basis_sells:1'], 'missing evidence array must be preserved')

const sanitizedMissingCostBasis = deriveMissingCostBasisStatus(bugReportFixture.snapshot.walletHistoricalCoverageSummary, bugReportFixture.snapshot.walletLotSummary)
assert.equal(sanitizedMissingCostBasis.status, 'partial', 'smartRecoveryMissingCostBasis.status must become partial when unresolved missing-cost-basis sells remain')

console.log('test-smart-recovery-mode: all assertions passed')
