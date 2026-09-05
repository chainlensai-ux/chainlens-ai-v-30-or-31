// Tests for src/lib/walletPnlCoverageRecoveryAudit.ts. NOT wired into `npm test`. Run with:
//   npx tsx --test src/lib/walletPnlCoverageRecoveryAudit.test.ts
//
// Covers the coverage-gate arithmetic, the per-lot reason taxonomy, recovery attribution
// (funded vs starved), and the honesty properties this audit exists to guarantee: it must never
// report a verified count the shared canonical predicate would not, and must never claim official
// PnL is eligible below the threshold.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWalletPnlCoverageRecoveryAudit,
  emptyCoverageMissingLotReasonCounts,
  COVERAGE_MISSING_LOT_REASONS,
} from './walletPnlCoverageRecoveryAudit'
import type { MatchedLot } from '../modules/fifoEngine/types'
import type { RecoveryPolicyResult } from '../modules/recoveryPolicy/types'

const WALLET = '0x1111111111111111111111111111111111111111'

function lot(over: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'l1', token: '0xtok', chain: 'base',
    openedAt: 1_000, closedAt: 2_000,
    openedTxHash: '0xa', closedTxHash: '0xb',
    amount: 1,
    costBasisUsd: 100, proceedsUsd: 150, realizedPnlUsd: 50,
    evidenceQuality: 'verified',
    ...over,
  } as MatchedLot
}

function verifiedLots(n: number): MatchedLot[] {
  return Array.from({ length: n }, (_, i) => lot({ lotId: `v${i}` }))
}

function emptyRecovery(over: Partial<RecoveryPolicyResult> = {}): RecoveryPolicyResult {
  return {
    triggerRecoveryWhen: { token_value_usd_gte: 1000, in_top_3_holdings: true, repeated_in_sell_timeline_min_count: 1 },
    caps: { maxHistoricalPagesPerWallet: 6, maxHistoricalPagesPerToken: 4 },
    evaluation: [],
    totalPagesUsedThisWallet: 0,
    ...over,
  }
}

describe('buildWalletPnlCoverageRecoveryAudit — coverage arithmetic', () => {
  it('reproduces the reported live shape: 51/110 = 46.36%, below the 50% gate', () => {
    const lots = [...verifiedLots(51), ...Array.from({ length: 59 }, (_, i) => lot({ lotId: `u${i}`, costBasisUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }))]
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base', 'ethereum'], matchedLots: lots, recoveryPolicy: emptyRecovery() })
    assert.equal(a.closedLotsTotal, 110)
    assert.equal(a.verifiedClosedLots, 51)
    assert.equal(a.verifiedCoveragePercent, 46.36)
    assert.equal(a.officialPnlEligibleAfterRecovery, false)
    assert.equal(a.missingLotsCount, 59)
    assert.equal(a.stillExcludedLots, 59)
  })

  it('exactly at the threshold is eligible (>= not >)', () => {
    const lots = [...verifiedLots(5), ...Array.from({ length: 5 }, (_, i) => lot({ lotId: `u${i}`, costBasisUsd: null, evidenceQuality: 'unpriced' }))]
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: lots, recoveryPolicy: emptyRecovery() })
    assert.equal(a.verifiedCoveragePercent, 50)
    assert.equal(a.officialPnlEligibleAfterRecovery, true)
    assert.equal(a.officialPnlStillBlockedReason, null)
  })

  it('never claims eligibility just below the threshold', () => {
    const lots = [...verifiedLots(49), ...Array.from({ length: 51 }, (_, i) => lot({ lotId: `u${i}`, costBasisUsd: null, evidenceQuality: 'unpriced' }))]
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: lots, recoveryPolicy: emptyRecovery() })
    assert.equal(a.officialPnlEligibleAfterRecovery, false)
    assert.match(a.officialPnlStillBlockedReason!, /below the required 50%/)
  })

  it('zero closed lots is explained, never reported as eligible', () => {
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: [], recoveryPolicy: emptyRecovery() })
    assert.equal(a.officialPnlEligibleAfterRecovery, false)
    assert.equal(a.verifiedCoveragePercent, 0)
    assert.match(a.officialPnlStillBlockedReason!, /No closed lots/)
  })

  it('states how many more verified lots are needed', () => {
    const lots = [...verifiedLots(4), ...Array.from({ length: 6 }, (_, i) => lot({ lotId: `u${i}`, costBasisUsd: null, evidenceQuality: 'unpriced' }))]
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: lots, recoveryPolicy: emptyRecovery() })
    assert.match(a.officialPnlStillBlockedReason!, /1 more verified closed lot needed/)
  })
})

describe('buildWalletPnlCoverageRecoveryAudit — per-lot reason taxonomy', () => {
  it('classifies a missing cost basis as missing_entry_buy', () => {
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: [lot({ costBasisUsd: null })], recoveryPolicy: emptyRecovery() })
    assert.equal(a.missingLotsByReason.missing_entry_buy, 1)
  })

  it('classifies missing proceeds as missing_exit_sell', () => {
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: [lot({ proceedsUsd: null })], recoveryPolicy: emptyRecovery() })
    assert.equal(a.missingLotsByReason.missing_exit_sell, 1)
  })

  it('classifies an impossible chronology as untrusted_graph_event', () => {
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: [lot({ openedAt: 5_000, closedAt: 1_000 })], recoveryPolicy: emptyRecovery() })
    assert.equal(a.missingLotsByReason.untrusted_graph_event, 1, 'a sell stamped before its own buy must never count as verified')
  })

  it('classifies a non-verified evidence quality as missing_price', () => {
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: [lot({ evidenceQuality: 'unpriced' })], recoveryPolicy: emptyRecovery() })
    assert.equal(a.missingLotsByReason.missing_price, 1)
  })

  it('every taxonomy key is always present so a zero is a measured zero', () => {
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: verifiedLots(3), recoveryPolicy: emptyRecovery() })
    assert.deepEqual(Object.keys(a.missingLotsByReason).sort(), [...COVERAGE_MISSING_LOT_REASONS].sort())
    assert.deepEqual(a.missingLotsByReason, emptyCoverageMissingLotReasonCounts())
  })

  it('reason counts always sum to missingLotsCount — no lot is silently uncounted', () => {
    const lots = [
      lot({ lotId: 'a', costBasisUsd: null }),
      lot({ lotId: 'b', proceedsUsd: null }),
      lot({ lotId: 'c', openedAt: 9, closedAt: 1 }),
      lot({ lotId: 'd', evidenceQuality: 'unpriced' }),
      lot({ lotId: 'e' }),
    ]
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: lots, recoveryPolicy: emptyRecovery() })
    const summed = Object.values(a.missingLotsByReason).reduce((s, n) => s + n, 0)
    assert.equal(summed, a.missingLotsCount)
    assert.equal(a.verifiedClosedLots + a.missingLotsCount, a.closedLotsTotal)
  })
})

describe('buildWalletPnlCoverageRecoveryAudit — recovery attribution', () => {
  const recovered = (to: string | null, from: string | null) => ({
    provider: 'goldrush' as const, chain: 'base' as const, txHash: '0x1', timestamp: '2024-01-01T00:00:00Z',
    fromAddress: from, toAddress: to, contract: '0xtok', symbol: 'T', amountRaw: '1', tokenDecimals: 18,
  })

  it('separates funded-and-productive tokens from starved ones', () => {
    const rp = emptyRecovery({
      evaluation: [
        { token: '0xa', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 2, recoveredEvents: [recovered(WALLET, '0xdead')] },
        { token: '0xb', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 2, recoveredEvents: [recovered(WALLET, '0xdead')] },
        { token: '0xc', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 2, recoveredEvents: [recovered(WALLET, '0xdead')] },
        // starved by the wallet page cap — triggered but never funded
        { token: '0xd', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 0, recoveredEvents: [] },
        { token: '0xe', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 0, recoveredEvents: [] },
      ],
      totalPagesUsedThisWallet: 6,
    })
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: verifiedLots(1), recoveryPolicy: rp })
    assert.equal(a.triggeredRecoveryTokens.length, 5)
    assert.equal(a.recoverySucceededTokens.length, 3)
    assert.equal(a.recoveryFailedTokens.length, 2)
    assert.deepEqual(a.recoveryFailedTokens, ['base:0xd', 'base:0xe'])
  })

  it('a shared-page match with pagesUsed=0 still counts as recovery success', () => {
    const rp = emptyRecovery({
      evaluation: [
        { token: '0xa', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 2, recoveredEvents: [recovered(WALLET, '0xdead')], rankedEligible: true, includedInSharedRequest: true, sharedPagesAvailable: 1 },
        { token: '0xb', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 0, recoveredEvents: [recovered(WALLET, '0xdead')], rankedEligible: true, includedInSharedRequest: true, sharedPagesAvailable: 1 },
        { token: '0xc', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 0, recoveredEvents: [recovered(WALLET, '0xdead')], rankedEligible: true, includedInSharedRequest: true, sharedPagesAvailable: 1 },
        { token: '0xd', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 0, recoveredEvents: [recovered(WALLET, '0xdead')], rankedEligible: true, includedInSharedRequest: true, sharedPagesAvailable: 1 },
        { token: '0xe', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 0, recoveredEvents: [recovered(WALLET, '0xdead')], rankedEligible: true, includedInSharedRequest: true, sharedPagesAvailable: 1 },
        { token: '0xf', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 2, recoveredEvents: [recovered(WALLET, '0xdead')], rankedEligible: true, includedInSharedRequest: true, sharedPagesAvailable: 1 },
        { token: '0x1', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 2, recoveredEvents: [recovered(WALLET, '0xdead')], rankedEligible: true, includedInSharedRequest: true, sharedPagesAvailable: 1 },
        { token: '0x2', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 0, recoveredEvents: [recovered(WALLET, '0xdead')], rankedEligible: true, includedInSharedRequest: true, sharedPagesAvailable: 1 },
      ],
      totalPagesUsedThisWallet: 6,
    })
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: verifiedLots(1), recoveryPolicy: rp })
    assert.equal(a.triggeredRecoveryTokens.length, 8)
    assert.equal(a.recoverySucceededTokens.length, 8)
    assert.equal(a.recoveryFailedTokens.length, 0)
    assert.equal(a.pnlRecoveryFlowAudit.length, 8)
    assert.ok(a.pnlRecoveryFlowAudit.every((row) => row.includedInSharedRequest && row.matchingEventsFound > 0))
    assert.ok(a.officialPnlStillBlockedReason == null || !/funds only 3 tokens/.test(a.officialPnlStillBlockedReason))
  })

  it('names the page-cap starvation explicitly in the blocked reason', () => {
    const rp = emptyRecovery({
      evaluation: [
        { token: '0xa', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 2, recoveredEvents: [recovered(WALLET, '0xd')], rankedEligible: true, includedInSharedRequest: true, sharedPagesAvailable: 1 },
        { token: '0xd', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 0, recoveredEvents: [], rankedEligible: true, includedInSharedRequest: false, sharedPagesAvailable: 0 },
      ],
    })
    const lots = [...verifiedLots(1), lot({ lotId: 'u', costBasisUsd: null, evidenceQuality: 'unpriced' })]
    // 1/2 = 50%... force it under by adding another unpriced lot
    lots.push(lot({ lotId: 'u2', costBasisUsd: null, evidenceQuality: 'unpriced' }))
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: lots, recoveryPolicy: rp })
    assert.match(a.officialPnlStillBlockedReason!, /received no historical pages/)
    assert.match(a.officialPnlStillBlockedReason!, /outside the paid shared chain request/)
    const starved = a.pnlRecoveryFlowAudit.find((row) => row.token === 'base:0xd')
    assert.ok(starved)
    assert.equal(starved!.dropStage, 'shared_request')
  })

  it('splits recovered legs into entry vs exit by wallet direction', () => {
    const rp = emptyRecovery({
      evaluation: [{
        token: '0xa', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 2,
        recoveredEvents: [
          recovered(WALLET, '0xdead'),     // inbound  -> entry
          recovered(WALLET, '0xbeef'),     // inbound  -> entry
          recovered('0xcafe', WALLET),     // outbound -> exit
        ],
      }],
    })
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: verifiedLots(1), recoveryPolicy: rp })
    assert.equal(a.recoveredEntryLots, 2)
    assert.equal(a.recoveredExitLots, 1)
    assert.equal(a.recoverablePreWindowExits, 1)
  })

  it('reports no attempted graph sources when nothing was funded', () => {
    const rp = emptyRecovery({
      evaluation: [{ token: '0xa', chain: 'base', triggeredBy: [], recoveryTriggered: true, pagesUsed: 0, recoveredEvents: [] }],
    })
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: verifiedLots(1), recoveryPolicy: rp })
    assert.deepEqual(a.graphSourcesAttempted, [], 'a starved candidate never attempted a provider')
    assert.deepEqual(a.graphSourcesSucceeded, [])
    assert.deepEqual(a.graphSourcesAvailable, ['goldrush', 'alchemy'])
  })

  it('a null recovery policy degrades to empty lists, never to invented activity', () => {
    const a = buildWalletPnlCoverageRecoveryAudit({ wallet: WALLET, chains: ['base'], matchedLots: verifiedLots(2), recoveryPolicy: null })
    assert.deepEqual(a.triggeredRecoveryTokens, [])
    assert.deepEqual(a.recoverySucceededTokens, [])
    assert.equal(a.recoveredEntryLots, 0)
    assert.equal(a.recoveredExitLots, 0)
  })

  it('reports accepted-evidence reuse when persisted sides actually removed pricing requirements', () => {
    const lots = [...verifiedLots(1), lot({ lotId: 'u', costBasisUsd: null, evidenceQuality: 'unpriced' })]
    const a = buildWalletPnlCoverageRecoveryAudit({
      wallet: WALLET, chains: ['base'], matchedLots: lots, recoveryPolicy: emptyRecovery(),
      acceptedEvidenceReuse: { acceptedSidesLoaded: 240, pricingRequirementsRemoved: 180 },
    })
    assert.deepEqual(a.acceptedEvidenceReuse, {
      acceptedSidesLoaded: 240,
      pricingRequirementsRemoved: 180,
      reused: true,
    })
  })

  it('does not claim reuse when accepted sides loaded but none were applied', () => {
    const a = buildWalletPnlCoverageRecoveryAudit({
      wallet: WALLET, chains: ['base'], matchedLots: verifiedLots(1), recoveryPolicy: emptyRecovery(),
      acceptedEvidenceReuse: { acceptedSidesLoaded: 240, pricingRequirementsRemoved: 0 },
    })
    assert.equal(a.acceptedEvidenceReuse?.reused, false)
  })
})
