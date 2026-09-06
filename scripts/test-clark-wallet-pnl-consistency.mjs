import assert from 'node:assert/strict'
import fs from 'node:fs'
import { formatCanonicalWalletRead, formatCanonicalPnlEvidence, formatWalletFollowupFromMemory } from '../lib/server/clarkRouting.ts'

// Clark/CORTEX audit Item 11: Unavailable PnL != $0. Canonical lanes only.
// Robinhood stays separate. No candidate PnL shown as verified.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
assert.match(routeSrc, /function formatSnapshotCanonicalPnl/, 'wallet snapshot formatters consume canonical PnL')
assert.match(routeSrc, /formatSnapshotCanonicalPnl\(snapshot\)/, 'balance summary uses canonical PnL, not a null walletPnlRead stub')
assert.doesNotMatch(
  routeSrc.slice(routeSrc.indexOf('function formatWalletBalanceSummary'), routeSrc.indexOf('function wantsWalletDeepScan')),
  /formatWalletPnlRead\(snapshot\.walletPnlRead \?\? null\)/,
  'formatWalletBalanceSummary must not ignore canonicalPnl in favour of a null V1 walletPnlRead',
)

{
  const unavailableZero = formatCanonicalPnlEvidence({
    pnlStatus: 'unavailable',
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    evmPnlLaneStatus: 'unavailable',
    robinhoodPnlLaneStatus: 'unavailable',
    missingEvidence: ['No verified swaps found for this wallet.'],
    scanMode: 'preview',
  }).join('\n')
  assert.match(unavailableZero, /Public PnL status: unavailable/)
  assert.match(unavailableZero, /Realized PnL: Unavailable: not verified/)
  assert.match(unavailableZero, /Unrealized PnL: Unavailable: not verified/)
  assert.match(unavailableZero, /Blocking reason: No verified swaps found for this wallet\./)
  assert.doesNotMatch(unavailableZero, /Realized PnL: \$0/)
  assert.doesNotMatch(unavailableZero, /Unrealized PnL: \$0/)
}

{
  const verifiedZero = formatCanonicalPnlEvidence({
    pnlStatus: 'available',
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    evmPnlLaneStatus: 'verified',
    robinhoodPnlLaneStatus: 'unavailable',
    scanMode: 'preview',
  }).join('\n')
  assert.match(verifiedZero, /Realized PnL: \$0/, 'a verified $0 is a real number, not an unavailable stand-in')
}

{
  const blended = formatCanonicalWalletRead('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', {
    chainsScanned: ['base', 'eth', 'robinhood'],
    totalValueUsd: 100,
    holdings: [{ chain: 'base', symbol: 'ETH', valueUsd: 100 }],
    activitySummary: { uniqueTransactions: 1, note: null },
    pnlStatus: 'unavailable',
    realizedPnlUsd: 27542.22,
    unrealizedPnlUsd: 0,
    pricingCoverage: 'partial',
    evidenceSources: ['v2_pipeline', 'robinhood_chain'],
    missingEvidence: [],
    scanMode: 'preview',
    evmPnlLaneStatus: 'unavailable',
    robinhoodPnlLaneStatus: 'verified',
    robinhoodPnlProof: { source: 'Robinhood Phase 3 sidecar', verifiedSwapCount: 4, fifoClosedLots: 3, priceEvidenceBothLegs: true },
  })
  assert.match(blended, /Robinhood PnL: Verified/)
  assert.match(blended, /Realized PnL: Unavailable: not verified/)
  assert.doesNotMatch(blended, /Realized PnL: \$27,542/)
  assert.doesNotMatch(blended, /Unrealized PnL: \$0/)
}

{
  const follow = formatWalletFollowupFromMemory('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', {
    ok: true,
    address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    totalValue: 100,
    holdings: [],
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    walletModuleCoverage: { fifoPnL: { status: 'provider_unavailable' } },
    walletTokenPnlSummary: { realizedPnlUsd: 0, unrealizedPnlUsd: 0, reason: 'no closed lots' },
  }, 'wallet_profitability')
  assert.match(follow, /Unavailable:/)
  assert.doesNotMatch(follow, /Realized PnL: \$0/)
  assert.doesNotMatch(follow, /Realized PnL: 0([^\d]|$)/)
}

console.log('test-clark-wallet-pnl-consistency.mjs: all assertions passed')
