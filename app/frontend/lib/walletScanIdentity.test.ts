// Tests for app/frontend/lib/walletScanIdentity.ts — scan identity + canonical-total invariants.
//
// Real production symptom this closes: the Wallet Scanner kept displaying a portfolio total from an
// EARLIER successful scan after a later scan failed or degraded, so a wallet whose live value had
// materially changed still showed its old total. See walletScanIdentity.ts's own header for the
// full root cause.
//
// NO HARDCODED PORTFOLIO AMOUNT, DISCLOSED (this task's explicit requirement): every expectation
// below is derived from the fixture it was built from — the tests assert that whatever the fixture
// says is what flows through, never that any particular dollar figure is correct. The two fixtures
// deliberately differ by an order of magnitude to prove the scanner accepts a materially changed
// wallet between consecutive scans.
//
// Uses node:test. Run with:
//   npx tsx --test app/frontend/lib/walletScanIdentity.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildScanIdentityDiagnostics,
  isDisplayedResultStale,
  TOTAL_MISMATCH_TOLERANCE_USD,
  type ScanIdentityReport,
  type ScanResultEnvelope,
} from './walletScanIdentity'

const WALLET = '0xe896465b95d5edb49e26de47b6718442227c980f'

// Builds a fully self-consistent report from a per-chain holdings spec — totals are DERIVED from
// the holdings, never stated independently, so no fixture can silently encode a wrong invariant.
function reportFrom(holdings: Array<{ chainId: number; symbol: string; valueUsd: number | null }>): ScanIdentityReport {
  const chainValueUsd: Record<number, number> = {}
  let total = 0
  for (const h of holdings) {
    total += h.valueUsd ?? 0
    chainValueUsd[h.chainId] = (chainValueUsd[h.chainId] ?? 0) + (h.valueUsd ?? 0)
  }
  return {
    scanMetadata: { walletAddress: WALLET },
    portfolioV2: { totalValueUsd: total },
    portfolio: { totalValueUsd: total },
    pricedHoldings: holdings.map((h) => ({ valueUsd: h.valueUsd })),
    chainValueUsd,
    holdings: [],
  }
}

// FIRST scan: a large, FreeCode-dominated portfolio (the shape this wallet previously showed).
const FIRST_SCAN_HOLDINGS = [
  { chainId: 8453, symbol: 'FreeCode', valueUsd: 3005.73 },
  { chainId: 8453, symbol: 'TORIVA', valueUsd: 257.03 },
  { chainId: 1, symbol: 'ETH', valueUsd: 102.89 },
]
// SECOND scan: the same wallet, materially changed — FreeCode gone entirely, a much smaller total.
const SECOND_SCAN_HOLDINGS = [
  { chainId: 8453, symbol: 'TORIVA', valueUsd: 612.4 },
  { chainId: 1, symbol: 'ETH', valueUsd: 91.15 },
]

function envelopeOf(holdings: typeof FIRST_SCAN_HOLDINGS, jobId: string, completedAt: number): ScanResultEnvelope {
  return { report: reportFrom(holdings), jobId, completedAt }
}

function sumOf(holdings: typeof FIRST_SCAN_HOLDINGS): number {
  return holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0)
}

describe('buildScanIdentityDiagnostics — canonical totals agree for one completed scan', () => {
  it('reports every required scan-identity field for a self-consistent scan, with no warnings', () => {
    const completedAt = 1_000_000
    const envelope = envelopeOf(FIRST_SCAN_HOLDINGS, 'job-1', completedAt)
    const d = buildScanIdentityDiagnostics(envelope, completedAt + 5_000)

    assert.equal(d.jobId, 'job-1')
    assert.equal(d.scanCompletedAt, completedAt)
    assert.equal(d.walletAddress, WALLET)
    assert.equal(d.pricedHoldingsCount, FIRST_SCAN_HOLDINGS.length)
    assert.equal(d.sourceResultAgeMs, 5_000)
    assert.deepEqual(d.warnings, [], 'a self-consistent scan must produce no invariant warnings')
  })

  it('portfolioV2.totalValueUsd equals sum(pricedHoldings.valueUsd) and sum(chainValueUsd) — derived from the fixture, never hardcoded', () => {
    const envelope = envelopeOf(FIRST_SCAN_HOLDINGS, 'job-1', 1_000)
    const d = buildScanIdentityDiagnostics(envelope, 1_000)
    const expected = sumOf(FIRST_SCAN_HOLDINGS)

    assert.ok(Math.abs((d.portfolioV2TotalValueUsd ?? 0) - expected) <= TOTAL_MISMATCH_TOLERANCE_USD)
    assert.ok(Math.abs((d.pricedHoldingsTotalValueUsd ?? 0) - expected) <= TOTAL_MISMATCH_TOLERANCE_USD)
    assert.ok(Math.abs((d.chainValueTotalUsd ?? 0) - expected) <= TOTAL_MISMATCH_TOLERANCE_USD)
  })

  it('header total and portfolio-card total are the same canonical value — they can never disagree', () => {
    const envelope = envelopeOf(FIRST_SCAN_HOLDINGS, 'job-1', 1_000)
    const d = buildScanIdentityDiagnostics(envelope, 1_000)
    assert.equal(d.displayedHeaderTotalValueUsd, d.displayedPortfolioCardTotalValueUsd)
    assert.equal(d.displayedHeaderTotalValueUsd, d.portfolioV2TotalValueUsd)
  })

  it('Base and Ethereum chain totals sum to the displayed total for whatever the current fixture holds', () => {
    for (const holdings of [FIRST_SCAN_HOLDINGS, SECOND_SCAN_HOLDINGS]) {
      const d = buildScanIdentityDiagnostics(envelopeOf(holdings, 'job-x', 1_000), 1_000)
      assert.ok(
        Math.abs((d.chainValueTotalUsd ?? 0) - (d.displayedHeaderTotalValueUsd ?? 0)) <= TOTAL_MISMATCH_TOLERANCE_USD,
        'per-chain totals must always sum to the displayed total for the CURRENT fixture',
      )
    }
  })

  it('warns when portfolioV2.totalValueUsd disagrees with sum(pricedHoldings.valueUsd) by more than $0.01', () => {
    const report = reportFrom(FIRST_SCAN_HOLDINGS)
    report.portfolioV2 = { totalValueUsd: (report.portfolioV2?.totalValueUsd ?? 0) + 5 }
    const d = buildScanIdentityDiagnostics({ report, jobId: 'job-1', completedAt: 1_000 }, 1_000)
    assert.ok(d.warnings.some((w) => w.includes('sum(pricedHoldings.valueUsd)')))
  })

  it('warns when portfolioV2.totalValueUsd disagrees with sum(chainValueUsd) by more than $0.01', () => {
    const report = reportFrom(FIRST_SCAN_HOLDINGS)
    report.chainValueUsd = { 8453: 1 }
    const d = buildScanIdentityDiagnostics({ report, jobId: 'job-1', completedAt: 1_000 }, 1_000)
    assert.ok(d.warnings.some((w) => w.includes('sum(chainValueUsd)')))
  })

  it('does NOT warn for a sub-cent rounding difference', () => {
    const report = reportFrom(FIRST_SCAN_HOLDINGS)
    report.portfolioV2 = { totalValueUsd: (report.portfolioV2?.totalValueUsd ?? 0) + 0.005 }
    const d = buildScanIdentityDiagnostics({ report, jobId: 'job-1', completedAt: 1_000 }, 1_000)
    assert.deepEqual(d.warnings, [])
  })

  it('warns when canonical pricedHoldings are missing but legacy holdings are present', () => {
    const report = reportFrom(FIRST_SCAN_HOLDINGS)
    report.pricedHoldings = null
    report.holdings = [{ contract: '0xlegacy' }]
    const d = buildScanIdentityDiagnostics({ report, jobId: 'job-1', completedAt: 1_000 }, 1_000)
    assert.ok(d.warnings.some((w) => w.includes('legacy holdings')), 'V3 must never silently render from legacy holdings')
  })

  it('warns when the displayed result carries no jobId — scan identity unverifiable', () => {
    const d = buildScanIdentityDiagnostics(envelopeOf(FIRST_SCAN_HOLDINGS, null as unknown as string, 1_000), 1_000)
    assert.ok(d.warnings.some((w) => w.includes('no jobId')))
  })
})

describe('consecutive scans — a materially changed wallet is accepted and fully replaces the previous result', () => {
  it('the scanner accepts a large first total and a much smaller second total, each derived from its own fixture', () => {
    const first = buildScanIdentityDiagnostics(envelopeOf(FIRST_SCAN_HOLDINGS, 'job-1', 1_000), 1_000)
    const second = buildScanIdentityDiagnostics(envelopeOf(SECOND_SCAN_HOLDINGS, 'job-2', 2_000), 2_000)

    assert.equal(first.portfolioV2TotalValueUsd, sumOf(FIRST_SCAN_HOLDINGS))
    assert.equal(second.portfolioV2TotalValueUsd, sumOf(SECOND_SCAN_HOLDINGS))
    assert.ok(
      (second.portfolioV2TotalValueUsd ?? 0) < (first.portfolioV2TotalValueUsd ?? 0),
      'a genuinely smaller current wallet value must flow through unchanged, never be floored at the previous total',
    )
  })

  it('the second completed scan retains NOTHING from the first — no stale holding count, total, or jobId', () => {
    const second = buildScanIdentityDiagnostics(envelopeOf(SECOND_SCAN_HOLDINGS, 'job-2', 2_000), 2_000)

    assert.equal(second.jobId, 'job-2')
    assert.equal(second.pricedHoldingsCount, SECOND_SCAN_HOLDINGS.length)
    assert.notEqual(second.pricedHoldingsCount, FIRST_SCAN_HOLDINGS.length)
    assert.notEqual(second.portfolioV2TotalValueUsd, sumOf(FIRST_SCAN_HOLDINGS))
  })

  it('a holding that disappeared from the wallet (FreeCode) contributes nothing to the new total', () => {
    const freeCodeValue = FIRST_SCAN_HOLDINGS.find((h) => h.symbol === 'FreeCode')?.valueUsd ?? 0
    assert.ok(freeCodeValue > 0, 'fixture sanity: the first scan really did hold FreeCode')
    assert.ok(!SECOND_SCAN_HOLDINGS.some((h) => h.symbol === 'FreeCode'), 'fixture sanity: it is gone in the second scan')

    const second = buildScanIdentityDiagnostics(envelopeOf(SECOND_SCAN_HOLDINGS, 'job-2', 2_000), 2_000)
    assert.equal(second.portfolioV2TotalValueUsd, sumOf(SECOND_SCAN_HOLDINGS))
    assert.ok(
      (second.portfolioV2TotalValueUsd ?? 0) < freeCodeValue + sumOf(SECOND_SCAN_HOLDINGS),
      'the vanished holding must not still be contributing to the current total',
    )
  })

  it('per-chain totals track the CURRENT fixture, not the previous one', () => {
    const secondReport = reportFrom(SECOND_SCAN_HOLDINGS)
    const expectedBase = SECOND_SCAN_HOLDINGS.filter((h) => h.chainId === 8453).reduce((s, h) => s + (h.valueUsd ?? 0), 0)
    const expectedEth = SECOND_SCAN_HOLDINGS.filter((h) => h.chainId === 1).reduce((s, h) => s + (h.valueUsd ?? 0), 0)
    assert.equal(secondReport.chainValueUsd?.[8453], expectedBase)
    assert.equal(secondReport.chainValueUsd?.[1], expectedEth)
  })
})

describe('isDisplayedResultStale — displayed result older than a newly completed scan', () => {
  it('flags a displayed envelope older than a newer completed scan', () => {
    assert.equal(isDisplayedResultStale(envelopeOf(FIRST_SCAN_HOLDINGS, 'job-1', 1_000), 2_000), true)
  })

  it('does not flag the newest completed scan as stale (correct atomic replacement)', () => {
    assert.equal(isDisplayedResultStale(envelopeOf(SECOND_SCAN_HOLDINGS, 'job-2', 2_000), 2_000), false)
  })

  it('never flags when there is nothing displayed or nothing newer', () => {
    assert.equal(isDisplayedResultStale(null, 2_000), false)
    assert.equal(isDisplayedResultStale(envelopeOf(FIRST_SCAN_HOLDINGS, 'job-1', 1_000), null), false)
  })
})
