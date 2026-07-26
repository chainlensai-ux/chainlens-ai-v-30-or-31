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

  it('1. corrected unrealized PnL reconciles with portfolio holdings — the same inflated lot is excluded once a real (much smaller) canonical balance is supplied', () => {
    const lots = [openLot({ amountRemaining: 10_000_000, amountOpened: 10_000_000, costBasisUsd: 100 })]
    const currentPriceUsdLookup = () => 0.0545
    // The wallet's REAL, independently-fetched current balance for this token is only 100 —
    // 100,000x smaller than fifoEngine's own event-replay-derived open quantity.
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 100

    const { unrealizedPnlUsd, unrealizedPnlExcludedTokens } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)

    assert.equal(unrealizedPnlUsd, null, 'the entire fabricated-looking figure must be excluded, never partially included')
    assert.deepEqual(unrealizedPnlExcludedTokens, [`${CHAIN}:${TOKEN.toLowerCase()}`], 'the specific mismatched token must be named, not silently hidden')
  })

  it('2. malformed decimals cannot inflate value — a raw-unit-scaled quantity (10^18x too large) is excluded even with a tiny per-unit price', () => {
    // Simulates a token whose amount was accidentally left in raw (undecimalized) units upstream —
    // amountRemaining is ~10^18x what the real (decimal-adjusted) balance actually is.
    const lots = [openLot({ amountRemaining: 3_000_000_000_000, amountOpened: 3_000_000_000_000, costBasisUsd: 5 })]
    const currentPriceUsdLookup = () => 0.001
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 3_000 // real decimal-adjusted balance

    const { unrealizedPnlUsd, unrealizedPnlExcludedTokens } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)

    assert.equal(unrealizedPnlUsd, null, 'a decimal-scaling-inflated quantity must never contribute to official unrealized PnL')
    assert.equal(unrealizedPnlExcludedTokens.length, 1)
  })

  it('3. duplicate open lots cannot exceed the current canonical balance — two lots that individually look fine still fail reconciliation as a SUM', () => {
    // Two separate open lots for the SAME token (e.g. a provider double-reporting one real
    // transfer as two normalized buy events) — reconciliation must check the TOTAL, not each lot
    // in isolation (a per-lot check would wrongly pass both).
    const lots = [
      openLot({ lotId: 'lot-a', openedTxHash: '0xbuy-a', amountRemaining: 600, amountOpened: 600, costBasisUsd: 60 }),
      openLot({ lotId: 'lot-b', openedTxHash: '0xbuy-b', amountRemaining: 600, amountOpened: 600, costBasisUsd: 60 }),
    ]
    const currentPriceUsdLookup = () => 1
    // Real balance is only 600 — exactly ONE of the two duplicated lots, not both summed.
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 600

    const { unrealizedPnlUsd, unrealizedPnlExcludedTokens } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)

    assert.equal(unrealizedPnlUsd, null, 'the duplicated total (1200) exceeds the real balance (600) — both lots must be excluded together')
    assert.equal(unrealizedPnlExcludedTokens.length, 1, 'excluded once per TOKEN, not once per lot')
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
