import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// 1. ETH activity gate uses a canonical chain-value map built from the final, merged holdings —
// not the stale pre-Moralis-merge discoveredChains snapshot.
assert.match(snap, /const _canonicalChainValueByChain: Record<string, number> = \{\}\s*\n\s*for \(const h of holdings\) \{\s*\n\s*const mapped = mapChain\(String\(h\.chain \?\? ''\)\)/, 'canonical chain-value map is built from the current (final, merged) holdings using mapChain normalization')
assert.match(snap, /const _ethDiscoveredValue = _canonicalChainValueByChain\.eth \?\? 0/, 'ethValueUsd is read from the canonical chain-value map, not the stale discoveredChains snapshot')
assert.doesNotMatch(snap, /const _ethDiscoveredValue = discoveredChains\.find/, 'the stale discoveredChains-based ETH value lookup has been removed')

// 2. ETH-dominant wallets are eligible for ETH activity (90/10 ETH/Base case).
assert.match(snap, /const _ethIsDominantChain = _canonicalChainEntriesSorted\.length > 0 && _canonicalChainEntriesSorted\[0\]\[0\] === 'eth'/, 'ethIsDominantChain is derived from the canonical map, sorted by value, not the stale discoveredChains order')
assert.match(snap, /const _ethClearsActivityGate = _ethDiscoveredValue >= _ethActivityThresholdUsd \|\| _ethIsDominantChain/, 'a dominant ETH chain always clears the activity gate regardless of the dollar threshold')

// 3. base-mainnet/base and ethereum/eth-mainnet aliases normalize via the shared mapChain helper.
assert.match(snap, /if \(c === 'eth' \|\| c\.includes\('ethereum'\)\) return 'eth'/, 'mapChain normalizes eth/ethereum/eth-mainnet to eth')
assert.match(snap, /if \(c === 'base' \|\| c\.includes\('base'\)\) return 'base'/, 'mapChain normalizes base/base-mainnet to base')

// 4. selectedPrimaryChain/primary-chain selection reuses the same canonical map — no second,
// independently-computed eth/base value pair that could disagree with the activity gate.
assert.match(snap, /const _ethTotalValue = _canonicalChainValueByChain\.eth \?\? 0\s*\n\s*const _baseTotalValue = _canonicalChainValueByChain\.base \?\? 0/, 'primary-chain selection reuses the canonical chain-value map instead of a second independent computation')

// 5. the value-zero contradiction (selectedPrimaryChain=eth + eth_below_activity_value_gate +
// ethValueUsd=0 while ETH holdings dominate) is impossible by construction, and is also flagged
// explicitly in diagnostics rather than assumed.
assert.match(snap, /if \(_ethActivitySkippedReason === 'eth_below_activity_value_gate' && _ethDiscoveredValue === 0 && _ethIsDominantChain\) \{\s*\n\s*_ethGateContradictionFlags\.push\('eth_below_activity_value_gate_with_dominant_eth_value'\)/, 'a dominant-ETH + zero-value + below-gate combination is detected and flagged as a contradiction')

// 6. ETH activity skip reasons are explicit (provider_unavailable / unsupported_chain /
// eth_below_activity_value_gate), never a bare null standing in for an unexplained zero-value skip.
assert.match(snap, /: !Boolean\(GOLDRUSH_KEY\)\s*\n\s*\? 'provider_unavailable'/, 'a missing GoldRush key reports an explicit provider_unavailable skip reason')
assert.match(snap, /: \(chainMode !== 'base_eth' && chainMode !== 'all_supported' && chainMode !== 'eth' && requestedChain !== 'eth'\)\s*\n\s*\? 'unsupported_chain'/, 'an out-of-scope chain mode reports an explicit unsupported_chain skip reason')

// 7. baseOnlyActivityWouldBeMisleading carries an explicit reason instead of a bare boolean.
assert.match(snap, /baseOnlyActivityWouldBeMisleadingReason: string \| null/, 'walletChainActivityMergeDebug type exposes baseOnlyActivityWouldBeMisleadingReason')
assert.match(snap, /baseOnlyActivityWouldBeMisleadingReason: _baseOnlyMisleadingReason,/, 'the misleading-flag reason is wired into the debug output')

// 8. new debug fields are present on walletActivityRoutingDebug.
for (const field of [
  'canonicalChainValueByChain', 'chainValueSource', 'ethValueSource', 'activityGateInputValues',
  'activityGateDecisions', 'contradictionFlags',
]) {
  assert.match(snap, new RegExp(`${field}[?:]`), `walletActivityRoutingDebug includes ${field}`)
}

// 9. no new provider calls were added — only the already-intended deferred ETH GoldRush fetch
// (_grEthDeferredEligible) is gated by this logic, and it is unchanged.
assert.match(snap, /const _grEthDeferredEligible = _ethDeferredActivityCandidate && _ethClearsActivityGate/, 'the deferred ETH GoldRush fetch trigger is unchanged — only its upstream inputs were fixed')
const gateSection = snap.slice(snap.indexOf('WALLET-ETH-ACTIVITY-GATE-1: `discoveredChains` above'), snap.indexOf('_ethGateContradictionFlags.push'))
assert.doesNotMatch(gateSection, /fetchMoralisBalances\(|fetchGoldrushBalances\(|fetchGoldrushPnlEvents\(|fetchMoralisTransfers\(/, 'the gate fix itself makes no new provider calls — it only re-reads holdings already fetched above')

// 10. existing PnL integrity gates are untouched by this patch.
assert.match(snap, /if \(lot\.priceIndependenceStatus === 'missing_independent_price' \|\| lot\.priceIndependenceStatus === 'current_price_reused' \|\| lot\.priceIndependenceStatus === 'fallback_price_reused'\) return \{ reconstructedEligible: true, verifiedPnlEligible: false, performanceEligible: false,/, 'missing/current/fallback price-reuse statuses remain non-performance-eligible unchanged')
assert.match(snap, /snapshot\.publicPnlIntegrityGate = \{/, 'the existing publicPnlIntegrityGate construction is unchanged')

console.log('wallet ETH activity routing checks passed')
