import assert from 'node:assert/strict'
import { projectWalletV2ForClark } from '../lib/server/v2Adapters.ts'

const address = `0x${'a'.repeat(40)}`
const token = `0x${'b'.repeat(40)}`
const verifiedLot = {
  lotId: 'lot-1', token, chain: 'base', openedAt: 1, closedAt: 2,
  openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1,
  costBasisUsd: 100, proceedsUsd: 125, realizedPnlUsd: 25, evidenceQuality: 'verified',
}
const fifo = {
  matchedLots: [verifiedLot], unmatchedBuys: 0, unmatchedSells: 0,
  unmatchedBuyEvents: [], unmatchedSellEvents: [], realizedPnlUsd: 25,
  unrealizedPnlUsd: null, costBasisUsd: 100, publicPnlStatus: 'ok',
  integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
  unrealizedPnlExcludedTokens: [], unrealizedReconciliation: { totalOpenPositions: 0 },
}
const report = {
  canonicalPricedFifo: fifo,
  fifoAndPnl: fifo,
  reconciliationSummary: {
    publishedMatchedLots: [verifiedLot], publicPnlStatus: 'available', realizedPnlUsd: 25,
    publicPnlGateAudit: { verifiedClosedLots: 1 }, warning: null,
    pnlDiscrepancyAudit: { trustGateTriggered: false },
  },
  holdings: [{ chain: 'base', contract: token, symbol: 'TEST', name: 'Test', amount: 1, providerValueUsd: 300_000 }],
  portfolio: { totalValueUsd: 300_000, tokens: [{ chain: 'base', contract: token, symbol: 'TEST', name: 'Test', amount: 1, priceUsd: 300_000, valueUsd: 300_000 }], chainValueBreakdown: [{ chain: 'base', valueUsd: 300_000, percent: 100 }] },
  timelines: {
    buyTimeline: { entries: [{ txHash: '0xbuy' }] },
    sellTimelineV2: { entries: [{ txHash: '0xsell' }] },
  },
  scanMetadata: { chainsScanned: ['base'] },
  recoveryPolicy: { totalPagesUsedThisWallet: 0 },
  windowCoverage: { coverageBasis: 'full_window', realDataDays: 180, recoveredExtraDays: 0 },
  behaviorIntel: {
    rotationStyle: { value: 'accumulator', basis: { buyCount: 1, sellCount: 1 } },
    concentrationSignals: { topHoldingPercent: 100, concentrationLabel: 'high' },
    confidence: 'high',
  },
}

const read = projectWalletV2ForClark(address, report)
assert.equal(read.totalValue, 300_000)
assert.deepEqual(read.holdings, [{ symbol: 'TEST', value: 300_000, chain: 'base' }])
assert.equal(read.closedLots, 1)
assert.equal(read.publicPnlStatus, 'ok')
assert.equal(read.publicRealizedPnlUsd, 25)
assert.equal(read.publicWinRatePercent, 100)
assert.equal(read.walletTokenPnlRead[0].symbol, 'TEST')
assert.equal(read.walletProfile.walletCategory, 'Whale')

console.log('Clark V2 wallet projection checks passed')
