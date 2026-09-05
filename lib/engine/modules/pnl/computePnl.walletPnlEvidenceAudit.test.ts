// WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED — tests for the finalPnlStatus taxonomy and the
// walletPnlEvidenceAudit object (lib/engine/modules/pnl/types.ts / computePnl.ts). Prod issue:
// wallet scans complete (holdings/pricing/trades all finish) but PnL almost always reports
// unavailable/missing evidence even for wallets with real swaps — closedLots=0, fullyPricedLots=0.
// See src/modules/swapNormalizer/quoteLegRecovery.ts and app/api/_shared/walletChainPipeline.ts's
// recoverQuoteLegsForBundles for the root-cause fix (one-leg swap txs recovering their missing
// quote leg from real receipt logs); this file locks in the STATUS/AUDIT half of that fix.
//
// Run directly with:
//   npx tsx --test lib/engine/modules/pnl/computePnl.walletPnlEvidenceAudit.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePnl } from './computePnl'
import type { ChainEvidenceAudit } from './computePnl'
import type { ParsedTrade } from './types'
import type { PricedHolding } from '../pricing/types'

function trade(overrides: Partial<ParsedTrade>): ParsedTrade {
  return { tokenAddress: '0xtoken', chainId: 8453, type: 'buy', quantity: 1, valueUsd: 100, timestamp: 1000, ...overrides }
}

function priced(overrides: Partial<PricedHolding>): PricedHolding {
  return { chainId: 8453, tokenAddress: '0xtoken', symbol: 'TOK', decimals: 18, quantity: '0', priceUsd: 1, valueUsd: 0, classification: 'blue_chip', ...overrides }
}

function evidence(overrides: Partial<ChainEvidenceAudit> = {}): ChainEvidenceAudit[] {
  return [{
    chainId: 8453, transferEvents: 2, oneLegTxCount: 1, candidateSwapTxs: 1, receiptsFetched: 1,
    quoteLegsRecovered: 1, nativeQuoteLegsRecovered: 1, stableQuoteLegsRecovered: 0, rejectionReasons: {},
    ...overrides,
  }]
}

describe('walletPnlEvidenceAudit / finalPnlStatus', () => {
  it('a wallet with a verified buy+sell produces a closed lot and finalPnlStatus "verified"', async () => {
    const trades = [
      trade({ type: 'buy', quantity: 1000, valueUsd: 100, timestamp: 1000 }),
      trade({ type: 'sell', quantity: 1000, valueUsd: 150, timestamp: 2000 }),
    ]
    const result = await computePnl([], [], 0, trades, evidence(), '0xwallet')
    const audit = result.walletPnlEvidenceAudit!
    assert.equal(audit.finalPnlStatus, 'verified')
    assert.equal(audit.closedLots, 1)
    assert.equal(audit.fullyPricedClosedLots, 1)
    assert.equal(audit.realizedPnlUsd, 50)
    assert.equal(audit.failureReason, null)
    assert.equal(audit.walletAddress, '0xwallet')
    assert.equal(audit.chainId, 8453)
  })

  it('a wallet with only buys shows finalPnlStatus "open_position_only"', async () => {
    const trades = [trade({ type: 'buy', quantity: 1000, valueUsd: 100, timestamp: 1000 })]
    const result = await computePnl([priced({ quantity: '1000', valueUsd: 120 })], [], 0, trades, evidence())
    const audit = result.walletPnlEvidenceAudit!
    assert.equal(audit.finalPnlStatus, 'open_position_only')
    assert.equal(audit.closedLots, 0)
    assert.equal(audit.openPositions, 1)
    assert.match(audit.failureReason ?? '', /Open position only — no verified closed trades/)
  })

  it('partial PnL appears (finalPnlStatus "partial") when at least one closed lot is verified but coverage is limited by an unpriced trade elsewhere', async () => {
    const trades = [
      trade({ tokenAddress: '0xa', type: 'buy', quantity: 10, valueUsd: 100, timestamp: 1000 }),
      trade({ tokenAddress: '0xa', type: 'sell', quantity: 10, valueUsd: 150, timestamp: 2000 }),
      // A second token's buy has no price evidence at all — never fabricated, but must not block
      // the first token's already-verified closed lot from being reported.
      trade({ tokenAddress: '0xb', type: 'buy', quantity: 5, valueUsd: null, timestamp: 1500 }),
    ]
    const result = await computePnl([], [], 0, trades, evidence())
    const audit = result.walletPnlEvidenceAudit!
    assert.equal(audit.finalPnlStatus, 'partial')
    assert.equal(audit.closedLots, 1)
    assert.equal(audit.realizedPnlUsd, 50)
  })

  it('sells with no matching buy never fabricate a closed lot — finalPnlStatus "unavailable" with an honest reason', async () => {
    const trades = [trade({ type: 'sell', quantity: 1000, valueUsd: 150, timestamp: 2000 })]
    const result = await computePnl([], [], 0, trades, evidence())
    const audit = result.walletPnlEvidenceAudit!
    assert.equal(audit.finalPnlStatus, 'unavailable')
    assert.equal(audit.closedLots, 0)
    assert.equal(audit.realizedPnlUsd, null)
    assert.match(audit.failureReason ?? '', /did not match any earlier buy/)
  })

  it('no trades at all, but real on-chain activity was seen -> "transfer_only", never a bare "unavailable"', async () => {
    const result = await computePnl([], [], 0, [], evidence({ candidateSwapTxs: 0, quoteLegsRecovered: 0, transferEvents: 3 }), '0xwallet')
    const audit = result.walletPnlEvidenceAudit!
    assert.equal(audit.finalPnlStatus, 'transfer_only')
    assert.match(audit.failureReason ?? '', /No verified swaps were found/)
  })

  it('no trades and no evidence of any activity at all -> "unavailable"', async () => {
    const result = await computePnl([], [], 0, [])
    const audit = result.walletPnlEvidenceAudit!
    assert.equal(audit.finalPnlStatus, 'unavailable')
    assert.equal(audit.rawEvents, 0)
  })

  it('the real quote-leg-recovery counters (oneLegTxCount/quoteLegsRecovered/native vs stable) are folded into the audit honestly, aggregated across chains', async () => {
    const trades = [
      trade({ type: 'buy', quantity: 10, valueUsd: 100, timestamp: 1000 }),
      trade({ type: 'sell', quantity: 10, valueUsd: 150, timestamp: 2000 }),
    ]
    const multiChain: ChainEvidenceAudit[] = [
      { chainId: 8453, transferEvents: 4, oneLegTxCount: 2, candidateSwapTxs: 2, receiptsFetched: 2, quoteLegsRecovered: 1, nativeQuoteLegsRecovered: 1, stableQuoteLegsRecovered: 0, rejectionReasons: { no_quote_transfer_in_receipt: 1 } },
      { chainId: 1, transferEvents: 2, oneLegTxCount: 1, candidateSwapTxs: 1, receiptsFetched: 1, quoteLegsRecovered: 1, nativeQuoteLegsRecovered: 0, stableQuoteLegsRecovered: 1, rejectionReasons: {} },
    ]
    const result = await computePnl([], [], 0, trades, multiChain)
    const audit = result.walletPnlEvidenceAudit!
    assert.equal(audit.oneLegTxCount, 3)
    assert.equal(audit.quoteLegsRecovered, 2)
    assert.equal(audit.nativeQuoteLegsRecovered, 1)
    assert.equal(audit.stableQuoteLegsRecovered, 1)
    assert.equal(audit.rejectionReasons.no_quote_transfer_in_receipt, 1)
    // Multiple chains contributed -> chainId is honestly null (a single-chain figure would be
    // misleading for a multi-chain wallet), never guessed to one arbitrary chain.
    assert.equal(audit.chainId, null)
  })

  it('omitting evidenceByChain/walletAddress (every pre-existing computePnl call site) still returns a well-formed, honest audit', async () => {
    const result = await computePnl([], [], 0, [trade({ type: 'buy' })])
    const audit = result.walletPnlEvidenceAudit!
    assert.equal(audit.walletAddress, '')
    assert.equal(audit.rawEvents, 0)
    assert.equal(audit.finalPnlStatus, 'open_position_only')
  })
})
