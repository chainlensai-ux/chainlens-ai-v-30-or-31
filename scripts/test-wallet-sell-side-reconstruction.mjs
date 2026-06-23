import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')

// 1. Candidate selection: wallet-side outbound direction='sell' events on Base that the normal
// swap detector did not already classify as a swap candidate, excluding quote assets themselves.
assert.match(snap, /async function buildBaseSellSideReconstructionPass\(/, 'buildBaseSellSideReconstructionPass exists')
assert.match(snap, /e\.direction === 'sell' \|\| \(e\.direction as string\) === 'outbound' \|\| \(e as any\)\.side === 'outbound' \|\| \(e as any\)\.side === 'outflow' \|\| \(e as any\)\.outflow === true/, 'sell-side recon selects sell-direction and outbound/outflow wallet-side token events')
assert.match(snap, /!STABLE_USD_CONTRACTS\[e\.contract\.toLowerCase\(\)\] && !WETH_CONTRACTS_PRICE\[e\.contract\.toLowerCase\(\)\]/, 'sell-side recon excludes quote-asset tokens from outbound candidate selection')

// 2. Candidate cap: 15 normal / 40 deep scan, deduplicated by tx hash.
assert.match(snap, /const maxCandidates = deepScan \? 40 : 15/, 'sell-side recon caps candidate tx receipts to 15 normal / 40 deep scan')
assert.match(snap, /if \(seenTx\.has\(txHash\)\) continue\s*\n\s*seenTx\.add\(txHash\)/, 'sell-side recon dedupes candidates by tx hash')

// 3. Promotion proof: only promotes when the wallet has a same-tx inbound WETH/stable leg —
// no native-ETH-only promotion (no fake PnL from unprovable native proceeds).
assert.match(snap, /const quoteLeg = d\.walletInbound\.find\(leg => Boolean\(WETH_CONTRACTS_PRICE\[leg\.contract\]\) \|\| Boolean\(STABLE_USD_CONTRACTS\[leg\.contract\]\)\)/, 'sell-side recon requires a same-tx wallet-inbound WETH/stable leg before promoting')
assert.match(snap, /ETH-only proceeds without an ERC20 quote leg cannot be safely attributed without a trace/, 'sell-side recon explicitly documents why it never fabricates native-only proceeds')
assert.match(snap, /sellSideNativeProceedsDetected: 0,/, 'sell-side recon debug never claims native proceeds were detected (no trace-based attribution implemented)')

// 4. Rejection paths: outbound-with-no-quote-proceeds stays a transfer (no promotion), tracked by reason.
assert.match(snap, /const reason = hasAnyInbound \? 'inbound_leg_not_quote_asset' : 'no_quote_proceeds_found'/, 'sell-side recon tracks why an outbound transfer was rejected instead of silently dropping it')
assert.match(snap, /rejectedBreakdown\[reason\] = \(rejectedBreakdown\[reason\] \?\? 0\) \+ 1/, 'sell-side recon exposes a rejection-reason breakdown')

// 5. Promoted events keep their existing direction='sell' and become real swap candidates that
// flow into the same buildPriceAtTimeEvidence/FIFO pipeline as any other sell event.
assert.match(snap, /reason: `Sell-side recon: wallet-outbound token \+ same-tx wallet-inbound quote leg/, 'sell-side recon promotion reason cites the wallet-outbound + wallet-inbound quote leg proof')
assert.match(snap, /isSwapCandidate: true, confidence: 'medium' as const, eventKind: 'swap_candidate' as const,/, 'sell-side recon promotes by setting swapDetection.isSwapCandidate, the same field FIFO/pricing read for every other sell event')

// 6. Call site: runs after native ETH buy recovery (buildEthRouterSwapReconstructionPass call) and
// before pricing starts, and never re-runs buildSwapDetection over the mutated events (which would
// wipe the promotion — same constraint as the existing Base unknown-direction recon pass).
const ethReconIdx = snap.indexOf('_shouldRunEthRouterRecon')
const sellSideIdx = snap.indexOf('const sellSideResult = await buildBaseSellSideReconstructionPass(')
const pricingIdx = snap.indexOf("tokenMeter.startTokenMeter('priceInference')")
assert.ok(ethReconIdx >= 0 && sellSideIdx >= 0 && pricingIdx >= 0 && ethReconIdx < sellSideIdx && sellSideIdx < pricingIdx, 'sell-side recon call site runs after native ETH buy recovery and before pricing')
assert.match(snap, /re-running buildSwapDetection here would recompute from scratch and discard the\s*\n\s*\/\/ promotion/, 'call site documents why buildSwapDetection is not re-run after sell-side promotion')

// 7. Debug fields per spec are present on the diagnostics type and wired into the snapshot output.
for (const field of [
  'sellSideRecoveryAttempted', 'sellSideCandidateTxs', 'sellSideReceiptsFetched', 'sellSideWalletOutboundLegs',
  'sellSideQuoteProceedsLegs', 'sellSideNativeProceedsDetected', 'sellSideSyntheticEventsAdded',
  'sellSideEventsPromoted', 'sellSideEventsRejected', 'sellSideRejectedBreakdown',
  'sampleSellSidePromotions', 'sampleSellSideRejected', 'sellSidePromotionSource',
]) {
  assert.ok(snap.includes(field), `sellSideReconstructionDebug includes ${field}`)
}
assert.match(snap, /sellSideReconstructionDebug: _sellSideReconDebug,/, 'sell-side recon debug is wired into _diagnostics output')

for (const field of [
  'candidateCount', 'receiptsFetched', 'walletOutboundLegsFound', 'inboundQuoteLegsFound',
  'promotedSellEvents', 'rejectedSellEvents', 'sampleRejectedCandidates',
]) {
  assert.ok(snap.includes(field), `sellSideReconstructionDebug includes spec alias ${field}`)
}
assert.match(snap, /candidateOutboundLegs: _sellSideReconDebug\.candidateCount/, 'funnel exposes candidateOutboundLegs so outbound candidates are not hidden as zero sell legs')
assert.match(snap, /receiptProvenSellLegs: \(_sellSideReconDebug\.promotedSellEvents \?\? _sellSideReconDebug\.sellSideEventsPromoted \?\? 0\) \+ \(_swapReconstructionV1Debug\.swapReconstructionEventsPromotedSell \?\? 0\)/, 'funnel separates receipt-proven sell legs (Base sell-side + swap-recon-v1) from outbound candidates')
assert.match(snap, /receiptProvenQuoteSellEvents: \(_sellSideReconDebug\.promotedSellEvents \?\? _sellSideReconDebug\.sellSideEventsPromoted \?\? 0\) \+ \(_swapReconstructionV1Debug\.swapReconstructionEventsPromotedSell \?\? 0\)/, 'funnel clearly names receipt-proven quote sell events from both recon passes')
assert.match(snap, /publicSellEvents: _performanceClosedLotsFinal\.length/, 'funnel separates public sell events from raw outbound candidates')


// 8. Native ETH buy recovery and FIFO integrity gates must still exist untouched.
assert.match(snap, /async function buildEthRouterSwapReconstructionPass\(/, 'native ETH buy recovery pass still exists')
assert.match(snap, /async function buildBaseUnknownDirectionSwapReconstructionPass\(/, 'Base unknown-direction recon pass still exists')

// 9. Requirement #7: sampleOpenLots must carry the FULL normalized contract, not an abbreviated
// display address, since route.ts uses this field to match against full holdings contracts.
assert.match(snap, /tokenAddress: l\.tokenAddress\.toLowerCase\(\), symbol: l\.tokenSymbol \?\? '', chain: l\.chain,\s*\n\s*openedAt: l\.openedAt, amountRemaining: l\.amountRemaining,/, 'sampleOpenLots keeps the full lowercased contract instead of an abbreviated display address')
assert.match(route, /const matchedHolding = _snapHoldings\.find\(h => \{/, 'route.ts open-position performance matching still exists')

console.log('wallet sell-side reconstruction checks passed')
