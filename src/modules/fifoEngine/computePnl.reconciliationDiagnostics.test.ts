// Tests for computePnl's per-position + scan-level unrealized-PnL reconciliation DIAGNOSTICS
// (src/modules/fifoEngine/index.ts). These are diagnostics on top of the already-shipped
// fail-closed reconciliation that fixed the false ~$545k unrealized PnL — the official number's
// fail-closed behavior is asserted here to be unchanged, and every excluded position is proven to
// report its exact quantities, prices, candidate figures and a typed exclusion reason.
//
// NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/fifoEngine/computePnl.reconciliationDiagnostics.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePnl } from './index'
import type {
  CanonicalBalanceLookup,
  CanonicalPositionMetadata,
  CanonicalPositionMetadataLookup,
  CurrentPriceUsdLookup,
  MatchedLot,
  OpenLot,
} from './types'
import type { SupportedChain } from '../providerFetchWindow/types'

// The real native-ETH pseudo-address this codebase synthesizes for native legs
// (src/modules/providerFetchWindow/utils.ts's NATIVE_ASSET_ADDRESS) and Base's real canonical WETH
// contract (src/modules/quoteLegPricing/index.ts's CANONICAL_WETH_ADDRESSES) — genuinely different
// addresses, deliberately never merged by this engine.
const NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const SHARED_ADDRESS = '0x1111111111111111111111111111111111111111'

function openLot(overrides: Partial<OpenLot> = {}): OpenLot {
  return {
    lotId: 'lot-1', token: SHARED_ADDRESS, chain: 'base', openedAt: 1, openedTxHash: '0xbuy',
    amountOpened: 1, amountRemaining: 1, costBasisUsd: 0, evidenceQuality: 'verified',
    ...overrides,
  }
}

function metadataLookup(entries: Record<string, CanonicalPositionMetadata>): CanonicalPositionMetadataLookup {
  return (token, chain) => entries[`${chain}:${token.toLowerCase()}`] ?? null
}

function meta(chain: SupportedChain, token: string, overrides: Partial<CanonicalPositionMetadata> = {}): CanonicalPositionMetadata {
  return { symbol: 'TOK', decimals: 18, resolvedChain: chain, resolvedTokenAddress: token, ...overrides }
}

describe('computePnl reconciliation diagnostics — per-position detail', () => {
  it('1. reports the EXACT open quantity from FIFO and the exact canonical balance (plus symbol/decimals from the snapshot)', () => {
    // The original ~$545k-class inflation: 10,000,000 open units against a real balance of 100.
    const lots = [openLot({ amountRemaining: 10_000_000, amountOpened: 10_000_000, costBasisUsd: 100 })]
    const currentPriceUsdLookup: CurrentPriceUsdLookup = () => 0.0545
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 100

    const { unrealizedReconciliation } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup, {
      positionMetadataLookup: metadataLookup({ [`base:${SHARED_ADDRESS}`]: meta('base', SHARED_ADDRESS, { symbol: 'SPAM', decimals: 9 }) }),
      currentPriceSourceLookup: () => 'dexscreener',
    })

    assert.equal(unrealizedReconciliation.excludedPositions.length, 1)
    const p = unrealizedReconciliation.excludedPositions[0]
    assert.equal(p.chainId, 'base')
    assert.equal(p.tokenAddress, SHARED_ADDRESS)
    assert.equal(p.symbol, 'SPAM')
    assert.equal(p.openQuantityFromFifo, 10_000_000, 'the exact FIFO-derived open quantity must be reported verbatim')
    assert.equal(p.canonicalCurrentBalance, 100, 'the exact canonical balance must be reported verbatim')
    assert.equal(p.decimalsUsed, 9)
    assert.equal(p.currentPriceUsd, 0.0545)
    assert.equal(p.currentPriceSource, 'dexscreener')
    assert.equal(p.openCostBasisUsd, 100)
    assert.equal(p.exclusionReason, 'open_quantity_exceeds_balance')
  })

  it('2. excess quantity and candidate inflation are calculated correctly', () => {
    const lots = [openLot({ amountRemaining: 10_000_000, amountOpened: 10_000_000, costBasisUsd: 100 })]
    const currentPriceUsdLookup: CurrentPriceUsdLookup = () => 0.0545
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 100

    const { unrealizedPnlUsd, unrealizedReconciliation } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)
    const p = unrealizedReconciliation.excludedPositions[0]

    assert.equal(p.excessOpenQuantity, 10_000_000 - 100, 'excess = FIFO open quantity - canonical balance')
    assert.equal(p.candidateMarketValueUsd, 10_000_000 * 0.0545, 'candidate market value = price * FIFO open quantity')
    assert.equal(p.candidateUnrealizedPnlUsd, 10_000_000 * 0.0545 - 100, 'candidate PnL = candidate market value - open cost basis')
    // The candidate really is the ~$545k figure this whole fix exists to refuse.
    assert.ok(p.candidateUnrealizedPnlUsd! > 544_000 && p.candidateUnrealizedPnlUsd! < 546_000, `expected the ~$545k candidate, got ${p.candidateUnrealizedPnlUsd}`)
    // ...and it is reported, never counted.
    assert.equal(unrealizedPnlUsd, null, 'official unrealized PnL must remain null — the candidate is never restored into it')
    assert.equal(unrealizedReconciliation.officialUnrealizedPnlUsd, null)
  })

  it('3. native ETH and WETH are separate positions and never collide', () => {
    const lots = [
      openLot({ lotId: 'native', token: NATIVE_ETH, amountRemaining: 5, amountOpened: 5, costBasisUsd: 10 }),
      openLot({ lotId: 'weth', token: WETH_BASE, amountRemaining: 5_000_000, amountOpened: 5_000_000, costBasisUsd: 10 }),
    ]
    const currentPriceUsdLookup: CurrentPriceUsdLookup = () => 3000
    // Native ETH reconciles (real balance 5); WETH does NOT (real balance only 1).
    const canonicalBalanceLookup: CanonicalBalanceLookup = (token) => (token.toLowerCase() === NATIVE_ETH ? 5 : 1)

    const { unrealizedPnlUsd, unrealizedReconciliation } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup, {
      positionMetadataLookup: metadataLookup({
        [`base:${NATIVE_ETH}`]: meta('base', NATIVE_ETH, { symbol: 'ETH' }),
        [`base:${WETH_BASE}`]: meta('base', WETH_BASE, { symbol: 'WETH' }),
      }),
    })

    assert.equal(unrealizedReconciliation.totalOpenPositions, 2, 'native ETH and WETH must be two distinct positions, never merged into one')
    assert.equal(unrealizedReconciliation.excludedOpenPositions, 1)
    assert.equal(unrealizedReconciliation.reconciledOpenPositions, 1)
    assert.equal(unrealizedReconciliation.excludedPositions[0].tokenAddress, WETH_BASE, 'only WETH failed — native ETH must be untouched by it')
    assert.equal(unrealizedReconciliation.excludedPositions[0].symbol, 'WETH')
    // Native ETH still priced normally: 3000*5 - 10 = 14990.
    assert.equal(unrealizedPnlUsd, 14_990, 'the reconciling native-ETH position must still be valued, unaffected by WETH failing')
  })

  it('4. the same token address on different chains does not collide', () => {
    const lots = [
      openLot({ lotId: 'on-base', chain: 'base', token: SHARED_ADDRESS, amountRemaining: 100, amountOpened: 100, costBasisUsd: 50 }),
      openLot({ lotId: 'on-eth', chain: 'eth', token: SHARED_ADDRESS, amountRemaining: 999_999, amountOpened: 999_999, costBasisUsd: 50 }),
    ]
    const currentPriceUsdLookup: CurrentPriceUsdLookup = () => 2
    // Same address, different chains, deliberately different real balances.
    const canonicalBalanceLookup: CanonicalBalanceLookup = (_token, chain) => (chain === 'base' ? 100 : 1)

    const { unrealizedPnlUsd, unrealizedReconciliation } = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)

    assert.equal(unrealizedReconciliation.totalOpenPositions, 2, 'the same address on two chains must be two distinct positions')
    assert.equal(unrealizedReconciliation.excludedOpenPositions, 1)
    const excluded = unrealizedReconciliation.excludedPositions[0]
    assert.equal(excluded.chainId, 'eth', 'only the eth-chain position failed reconciliation')
    assert.equal(excluded.canonicalCurrentBalance, 1)
    // The base position reconciles: 2*100 - 50 = 150.
    assert.equal(unrealizedPnlUsd, 150, 'the base-chain position must be valued independently of the eth-chain failure')
  })

  it('5. missing price and outlier price report DISTINCT typed reasons', () => {
    const noPriceLots = [openLot({ token: SHARED_ADDRESS, amountRemaining: 10, amountOpened: 10, costBasisUsd: 5 })]
    const outlierLots = [openLot({ token: SHARED_ADDRESS, amountRemaining: 10, amountOpened: 10, costBasisUsd: 5 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 10

    const missing = computePnl([], noPriceLots, () => null, canonicalBalanceLookup)
    const outlier = computePnl([], outlierLots, () => 5e9, canonicalBalanceLookup)

    assert.equal(missing.unrealizedReconciliation.excludedPositions[0].exclusionReason, 'missing_verified_current_price')
    assert.equal(missing.unrealizedReconciliation.excludedPositions[0].currentPriceUsd, null)
    assert.equal(missing.unrealizedReconciliation.excludedPositions[0].candidateMarketValueUsd, null, 'no price means no computable candidate — never a fabricated 0')

    assert.equal(outlier.unrealizedReconciliation.excludedPositions[0].exclusionReason, 'unverified_or_outlier_price')
    assert.equal(outlier.unrealizedReconciliation.excludedPositions[0].currentPriceUsd, 5e9, 'the outlier price itself is reported, so the refusal is auditable')
    assert.equal(outlier.unrealizedReconciliation.excludedPositions[0].candidateMarketValueUsd, 5e10)

    assert.notEqual(
      missing.unrealizedReconciliation.excludedPositions[0].exclusionReason,
      outlier.unrealizedReconciliation.excludedPositions[0].exclusionReason,
      'the two failure modes must never collapse into one reason',
    )
    assert.equal(missing.unrealizedPnlUsd, null)
    assert.equal(outlier.unrealizedPnlUsd, null, 'an outlier price must never be summed into official unrealized PnL')
  })

  it('reports every other typed exclusion reason from a real code path', () => {
    const balance: CanonicalBalanceLookup = () => 100
    const price: CurrentPriceUsdLookup = () => 1

    // missing_canonical_balance
    const missingBalance = computePnl([], [openLot({ amountRemaining: 10, costBasisUsd: 1 })], price, () => null)
    assert.equal(missingBalance.unrealizedReconciliation.excludedPositions[0].exclusionReason, 'missing_canonical_balance')
    assert.equal(missingBalance.unrealizedReconciliation.excludedPositions[0].excessOpenQuantity, null, 'no balance to compare against means excess is honestly null, never 0')

    // invalid_open_quantity — a corrupted (non-finite) event-replayed quantity.
    const invalidQty = computePnl([], [openLot({ amountRemaining: Number.NaN, costBasisUsd: 1 })], price, balance)
    assert.equal(invalidQty.unrealizedReconciliation.excludedPositions[0].exclusionReason, 'invalid_open_quantity')

    // invalid_decimals — snapshot reported an impossible token-decimals value.
    const invalidDecimals = computePnl([], [openLot({ amountRemaining: 10, costBasisUsd: 1 })], price, balance, {
      positionMetadataLookup: metadataLookup({ [`base:${SHARED_ADDRESS}`]: meta('base', SHARED_ADDRESS, { decimals: 999 }) }),
    })
    assert.equal(invalidDecimals.unrealizedReconciliation.excludedPositions[0].exclusionReason, 'invalid_decimals')
    assert.equal(invalidDecimals.unrealizedReconciliation.excludedPositions[0].decimalsUsed, 999, 'the offending decimals value itself is reported')

    // chain_or_token_key_mismatch — the snapshot answered for a DIFFERENT position.
    const keyMismatch = computePnl([], [openLot({ amountRemaining: 10, costBasisUsd: 1 })], price, balance, {
      positionMetadataLookup: metadataLookup({ [`base:${SHARED_ADDRESS}`]: meta('eth', WETH_BASE) }),
    })
    assert.equal(keyMismatch.unrealizedReconciliation.excludedPositions[0].exclusionReason, 'chain_or_token_key_mismatch')

    // synthetic_or_quarantined_position — only ever from an explicit snapshot flag.
    const quarantined = computePnl([], [openLot({ amountRemaining: 10, costBasisUsd: 1 })], price, balance, {
      positionMetadataLookup: metadataLookup({ [`base:${SHARED_ADDRESS}`]: meta('base', SHARED_ADDRESS, { quarantined: true }) }),
    })
    assert.equal(quarantined.unrealizedReconciliation.excludedPositions[0].exclusionReason, 'synthetic_or_quarantined_position')
  })
})

describe('computePnl reconciliation diagnostics — scan-level totals', () => {
  it('6. official unrealized PnL stays null and reconciliationStatus is "failed" when every position fails reconciliation', () => {
    const lots = [
      openLot({ lotId: 'a', token: SHARED_ADDRESS, amountRemaining: 10_000, costBasisUsd: 10 }),
      openLot({ lotId: 'b', token: WETH_BASE, amountRemaining: 20_000, costBasisUsd: 20 }),
    ]
    const { unrealizedPnlUsd, unrealizedReconciliation } = computePnl([], lots, () => 1, () => 1)

    assert.equal(unrealizedPnlUsd, null, 'official unrealized PnL must be null/unavailable, never a partial or clamped figure')
    assert.equal(unrealizedReconciliation.officialUnrealizedPnlUsd, null)
    assert.equal(unrealizedReconciliation.reconciliationStatus, 'failed')
    assert.equal(unrealizedReconciliation.totalOpenPositions, 2)
    assert.equal(unrealizedReconciliation.reconciledOpenPositions, 0)
    assert.equal(unrealizedReconciliation.excludedOpenPositions, 2)
    assert.equal(unrealizedReconciliation.excludedCandidateMarketValueUsd, 30_000, 'excluded candidate market value sums the refused figures')
    assert.equal(unrealizedReconciliation.excludedCandidateUnrealizedPnlUsd, 30_000 - 30)
  })

  it('reports "partial" when some positions reconcile and some do not, and "ok" when all reconcile', () => {
    const mixed = computePnl(
      [],
      [
        openLot({ lotId: 'good', token: SHARED_ADDRESS, amountRemaining: 10, costBasisUsd: 5 }),
        openLot({ lotId: 'bad', token: WETH_BASE, amountRemaining: 10_000, costBasisUsd: 5 }),
      ],
      () => 1,
      (token) => (token.toLowerCase() === SHARED_ADDRESS ? 10 : 1),
    )
    assert.equal(mixed.unrealizedReconciliation.reconciliationStatus, 'partial')
    assert.equal(mixed.unrealizedReconciliation.reconciledOpenPositions, 1)
    assert.equal(mixed.unrealizedReconciliation.excludedOpenPositions, 1)
    assert.equal(mixed.unrealizedPnlUsd, 5, 'only the reconciling position contributes: 1*10 - 5')

    const allGood = computePnl([], [openLot({ amountRemaining: 10, costBasisUsd: 5 })], () => 1, () => 10)
    assert.equal(allGood.unrealizedReconciliation.reconciliationStatus, 'ok')
    assert.equal(allGood.unrealizedReconciliation.excludedOpenPositions, 0)
    assert.equal(allGood.unrealizedReconciliation.excludedCandidateMarketValueUsd, 0)
  })

  it('reports "not_reconciled" (and zero excluded positions) when no canonicalBalanceLookup is supplied', () => {
    const { unrealizedPnlUsd, unrealizedReconciliation } = computePnl(
      [],
      [openLot({ amountRemaining: 10_000_000, costBasisUsd: 100 })],
      () => 0.0545,
    )
    assert.equal(unrealizedReconciliation.reconciliationStatus, 'not_reconciled')
    assert.equal(unrealizedReconciliation.excludedOpenPositions, 0)
    assert.equal(unrealizedReconciliation.totalOpenPositions, 1)
    // The pre-existing, unchanged behavior: without reconciliation the inflated figure IS counted.
    assert.ok(unrealizedPnlUsd !== null && unrealizedPnlUsd > 540_000, 'zero-change path must remain byte-identical to the pre-reconciliation formula')
    assert.equal(unrealizedReconciliation.officialUnrealizedPnlUsd, unrealizedPnlUsd)
  })

  it('7. realized PnL and FIFO lot identities remain unchanged by diagnostics', () => {
    const matchedLots: MatchedLot[] = [
      { lotId: 'closed-1', token: SHARED_ADDRESS, chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 10, costBasisUsd: 10, proceedsUsd: 25, realizedPnlUsd: 15, evidenceQuality: 'verified' },
    ]
    const matchedLotsSnapshot = JSON.parse(JSON.stringify(matchedLots))
    const openLots = [openLot({ amountRemaining: 10_000_000, costBasisUsd: 100 })]
    const openLotsSnapshot = JSON.parse(JSON.stringify(openLots))

    const withoutDiagnostics = computePnl(matchedLots, openLots, () => 0.0545, () => 100)
    const withDiagnostics = computePnl(matchedLots, openLots, () => 0.0545, () => 100, {
      positionMetadataLookup: metadataLookup({ [`base:${SHARED_ADDRESS}`]: meta('base', SHARED_ADDRESS) }),
      currentPriceSourceLookup: () => 'coingecko',
    })

    assert.equal(withoutDiagnostics.realizedPnlUsd, 15)
    assert.equal(withDiagnostics.realizedPnlUsd, 15, 'realizedPnlUsd must be identical with and without diagnostics')
    assert.equal(withDiagnostics.unrealizedPnlUsd, withoutDiagnostics.unrealizedPnlUsd, 'official unrealized PnL must be identical with and without diagnostics')
    assert.deepEqual(matchedLots, matchedLotsSnapshot, 'matchedLots must never be mutated')
    assert.deepEqual(openLots, openLotsSnapshot, 'open lot identities/quantities must never be mutated (no clamping)')
    // Explicitly: quantities are never clamped down to the canonical balance.
    assert.equal(openLots[0].amountRemaining, 10_000_000, 'the open quantity must be reported as-is, never clamped')
  })
})
