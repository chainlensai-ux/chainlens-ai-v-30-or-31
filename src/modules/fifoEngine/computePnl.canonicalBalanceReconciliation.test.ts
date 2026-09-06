// Regression tests for computePnl's canonical-balance reconciliation (src/modules/fifoEngine/
// index.ts) — added after a confirmed production bug: a false ~$545,000 unrealized PnL figure
// traced to fifoEngine's own event-replay-derived open-lot quantity (remainingOpenLots) never
// being cross-checked against the wallet's real, independently-fetched current token balance
// before being multiplied by a current price. See fifoEngine/types.ts's CanonicalBalanceLookup
// header and computePnl's own "RECONCILED PATH" comment for the full mechanism.
//
// NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/fifoEngine/computePnl.canonicalBalanceReconciliation.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePnl } from './index'
import type { CanonicalBalanceLookup, MatchedLot, OpenLot } from './types'

const CHAIN = 'base' as const
const TOKEN = '0xspam000000000000000000000000000000000f'

function openLot(overrides: Partial<OpenLot> = {}): OpenLot {
  return {
    lotId: 'lot-1', token: TOKEN, chain: CHAIN, openedAt: 1, openedTxHash: '0xbuy',
    amountOpened: 1, amountRemaining: 1, costBasisUsd: 0, evidenceQuality: 'verified',
    ...overrides,
  }
}

describe('computePnl — canonical-balance reconciliation (false ~$545k unrealized PnL fix)', () => {
  it('REPRODUCES the exact failure mode: an inflated open quantity times a tiny real price computes ~$545k with no reconciliation', () => {
    // A duplicated/mis-normalized buy event opened a lot for 10,000,000 raw units of a near-
    // worthless token, with a near-zero cost basis (a classic raw-unit/decimal-scaling or
    // duplicate-event artifact) — currentPrice * amountRemaining - costBasis lands right in the
    // reported failure's own ballpark.
    const lots = [openLot({ amountRemaining: 10_000_000, amountOpened: 10_000_000, costBasisUsd: 100 })]
    const currentPriceUsdLookup = () => 0.0545
    const { unrealizedPnlUsd, unrealizedPnlExcludedTokens } = computePnl([], lots, currentPriceUsdLookup)

    // Without a canonicalBalanceLookup (existing behavior, unchanged), this really does compute
    // the ~$545k figure — reproducing the exact reported defect from first principles.
    assert.ok(unrealizedPnlUsd !== null && unrealizedPnlUsd > 540_000 && unrealizedPnlUsd < 550_000, `expected ~$545k, got ${unrealizedPnlUsd}`)
    assert.deepEqual(unrealizedPnlExcludedTokens, [], 'sanity: no reconciliation was requested, so nothing is excluded here')
  })

  it('1. HARD ASSERTION (Wallet PnL Item 3): inflated FIFO open qty is capped to the real canonical balance for unrealized, never excluded and never valued at the FIFO quantity', () => {
    const lots = [openLot({ amountRemaining: 10_000_000, amountOpened: 10_000_000, costBasisUsd: 100 })]
    const currentPriceUsdLookup = () => 0.0545
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 100

    const { unrealizedPnlUsd, unrealizedPnlExcludedTokens, unrealizedReconciliation } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)

    assert.deepEqual(unrealizedPnlExcludedTokens, [])
    assert.equal(unrealizedReconciliation.cappedOpenPositions, 1)
    const scale = 100 / 10_000_000
    assert.equal(unrealizedPnlUsd, 0.0545 * 10_000_000 * scale - 100 * scale)
    assert.ok((unrealizedPnlUsd ?? 0) < 10, 'official unrealized must be the held-quantity figure, never the ~$545k FIFO-qty candidate')
  })

  it('2. malformed decimals cannot inflate value — a raw-unit-scaled quantity is capped to the real decimal-adjusted balance', () => {
    const lots = [openLot({ amountRemaining: 3_000_000_000_000, amountOpened: 3_000_000_000_000, costBasisUsd: 5 })]
    const currentPriceUsdLookup = () => 0.001
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 3_000

    const { unrealizedPnlUsd, unrealizedPnlExcludedTokens } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)

    assert.equal(unrealizedPnlExcludedTokens.length, 0)
    const scale = 3_000 / 3_000_000_000_000
    assert.equal(unrealizedPnlUsd, 0.001 * 3_000_000_000_000 * scale - 5 * scale)
    assert.ok((unrealizedPnlUsd ?? 0) < 10, 'must never contribute the raw-unit inflated figure')
  })

  it('3. duplicate open lots are capped as a SUM to the canonical balance, never valued twice', () => {
    const lots = [
      openLot({ lotId: 'lot-a', openedTxHash: '0xbuy-a', amountRemaining: 600, amountOpened: 600, costBasisUsd: 60 }),
      openLot({ lotId: 'lot-b', openedTxHash: '0xbuy-b', amountRemaining: 600, amountOpened: 600, costBasisUsd: 60 }),
    ]
    const currentPriceUsdLookup = () => 1
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 600

    const { unrealizedPnlUsd, unrealizedPnlExcludedTokens, unrealizedReconciliation } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)

    assert.equal(unrealizedPnlExcludedTokens.length, 0)
    assert.equal(unrealizedReconciliation.cappedOpenPositions, 1, 'capped once per TOKEN, not once per lot')
    const scale = 600 / 1200
    assert.equal(unrealizedPnlUsd, 1 * 1200 * scale - 120 * scale)
  })

  it('4. unverified/unknown canonical balance fails closed — a null lookup result excludes the token rather than assuming it is fine', () => {
    const lots = [openLot({ amountRemaining: 50, amountOpened: 50, costBasisUsd: 10 })]
    const currentPriceUsdLookup = () => 5
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => null // genuinely unknown/untrusted

    const { unrealizedPnlUsd, unrealizedPnlExcludedTokens } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)

    assert.equal(unrealizedPnlUsd, null, 'an unknown canonical balance must fail closed, never be treated as "no constraint"')
    assert.equal(unrealizedPnlExcludedTokens.length, 1)
  })

  it('a token that DOES reconcile within tolerance is still priced normally — this is a targeted exclusion, not a blanket regression', () => {
    const lots = [openLot({ amountRemaining: 100, amountOpened: 100, costBasisUsd: 50 })]
    const currentPriceUsdLookup = () => 1
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 100 // matches exactly

    const { unrealizedPnlUsd, unrealizedPnlExcludedTokens } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)

    assert.equal(unrealizedPnlUsd, 50, '100 * 1 - 50 = 50, priced normally when reconciliation actually passes')
    assert.deepEqual(unrealizedPnlExcludedTokens, [])
  })

  it('5. realized PnL and FIFO lot identities remain unchanged by reconciliation — only unrealizedPnlUsd/unrealizedPnlExcludedTokens are affected', () => {
    const matchedLots: MatchedLot[] = [
      { lotId: 'closed-1', token: TOKEN, chain: CHAIN, openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 10, costBasisUsd: 10, proceedsUsd: 25, realizedPnlUsd: 15, evidenceQuality: 'verified' },
    ]
    const openLots = [openLot({ amountRemaining: 10_000_000, amountOpened: 10_000_000, costBasisUsd: 100 })]
    const currentPriceUsdLookup = () => 0.0545

    const withoutReconciliation = computePnl(matchedLots, openLots, currentPriceUsdLookup)
    const withReconciliation = computePnl(matchedLots, openLots, currentPriceUsdLookup, () => 100)

    assert.equal(withoutReconciliation.realizedPnlUsd, 15)
    assert.equal(withReconciliation.realizedPnlUsd, 15, 'realizedPnlUsd must be byte-identical regardless of canonical-balance reconciliation')
    assert.deepEqual(matchedLots, [
      { lotId: 'closed-1', token: TOKEN, chain: CHAIN, openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 10, costBasisUsd: 10, proceedsUsd: 25, realizedPnlUsd: 15, evidenceQuality: 'verified' },
    ], 'matchedLots array/identities must never be mutated by the reconciliation pass')
  })

  it('when canonicalBalanceLookup is omitted entirely, unrealizedPnlUsd is byte-identical to the pre-fix formula (zero behavior change by default)', () => {
    const lots = [
      openLot({ lotId: 'a', amountRemaining: 3, costBasisUsd: 1 }),
      openLot({ lotId: 'b', token: '0xother0000000000000000000000000000000000', amountRemaining: 7, costBasisUsd: 2 }),
    ]
    const currentPriceUsdLookup = (token: string) => (token === TOKEN ? 2 : 3)
    const { unrealizedPnlUsd } = computePnl([], lots, currentPriceUsdLookup)
    // (2*3 - 1) + (3*7 - 2) = 5 + 19 = 24
    assert.equal(unrealizedPnlUsd, 24)
  })
})
