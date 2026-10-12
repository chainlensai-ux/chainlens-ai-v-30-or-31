// The wallet read's evidence panel must agree with the PnL card: when the full-wallet figure is locked but the
// verified bounded sample is published, realized PnL is partial (sample) and only the FULL-wallet figure is
// missing. The Robinhood open-position line names Robinhood, so it never reads as the whole wallet's PnL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEvidence } from '../app/frontend/lib/walletReadBuilder.ts'

const conf = (realized: 'Verified' | 'Partial' | 'Locked') => ({ realized, unrealized: 'Partial' as const, historicalCoverage: 'Bounded sample', openPositionCoveragePercent: null, integrity: null })
const base = { hasHoldingsData: true, robinhoodDisplayState: 'valued' as const, robinhoodPnlLane: 'not_verified' as const, matchedLotsCount: 43 }

test('locked full wallet + published verified sample → realized is partial, only full-wallet realized is missing', () => {
  const e = buildEvidence({ ...base, pnlConfidence: conf('Locked'), verifiedSampleRealizedShown: true } as Parameters<typeof buildEvidence>[0])
  assert.ok(e.partial.includes('Realized PnL (verified bounded sample)'))
  assert.ok(e.missing.includes('Full-wallet realized PnL'))
  assert.equal(e.missing.includes('Realized PnL'), false)
})

test('locked with no published sample → realized PnL is missing (unchanged)', () => {
  const e = buildEvidence({ ...base, pnlConfidence: conf('Locked') } as Parameters<typeof buildEvidence>[0])
  assert.ok(e.missing.includes('Realized PnL'))
  assert.equal(e.partial.some((x) => x.startsWith('Realized PnL')), false)
})

test('Robinhood open-position-only line is scoped to Robinhood', () => {
  const e = buildEvidence({
    ...base, pnlConfidence: conf('Locked'), verifiedSampleRealizedShown: true,
    robinhoodSwapEvidence: { swapsVerified: 1, swapsBothLegsPriced: 1, openPositionOnly: true, coverage: null },
  } as unknown as Parameters<typeof buildEvidence>[0])
  assert.ok(e.missing.includes('Robinhood realized closed-lot PnL (no verified buy→sell lot closed yet)'))
  assert.equal(e.missing.some((x) => x.startsWith('Realized closed-lot PnL')), false)
})
