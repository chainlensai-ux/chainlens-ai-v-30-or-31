import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// Fix 1: buildBasePnlReconstructionPass (decodes WETH/stable inbound legs — i.e. sell proceeds)
// used to bail out entirely the moment ANY swap candidate existed (e.g. once buys were detected),
// so sells with native/WETH/stable proceeds never got a chance to run. It must now only bail when
// a SELL-side swap candidate already exists.
assert.match(snap, /const existingSellSwapCount = evidenceWithDetection\.filter\(e => e\.swapDetection\?\.isSwapCandidate && e\.direction === 'sell'\)\.length\s*\n\s*if \(existingSellSwapCount > 0\) return \{ mergedEvidence: evidenceWithDetection, debug: emptyDebug\('sell_swap_candidates_already_present'\) \}/, 'buildBasePnlReconstructionPass only skips when a sell candidate already exists, not merely because buys exist')

// Fix 2: its candidate tx selection used to require txFromAddress === wallet for EVERY candidate
// (including sells), dropping router/relayer-initiated swaps where the wallet is not tx.from.
// Native-ETH-buy detection still needs tx.from === wallet (msg.value is attributed to the sender),
// but sell legs are wallet-side evidence via the Transfer log itself and must not be gated on tx.from.
assert.match(snap, /if \(e\.direction === 'buy' && e\.txFromAddress && e\.txFromAddress\.toLowerCase\(\) !== walletLower\) continue/, 'tx.from === wallet gate in buildBasePnlReconstructionPass is now scoped to buy-side native-ETH-spend detection only, not sells')

// Fix 3: the call-site gate for buildBasePnlReconstructionPass used to require zero swap
// candidates overall; it must now re-run whenever there are zero existing SELL swap candidates,
// even if buyEvents > 0 already produced candidates.
assert.match(snap, /const _existingSellSwapCandidates = _swapEvidenceWithDetection\.filter\(e => e\.swapDetection\?\.isSwapCandidate && e\.direction === 'sell'\)\.length/, 'call site computes existing sell swap candidate count before deciding whether to run Base PnL reconstruction')
assert.match(snap, /_existingSellSwapCandidates === 0 &&/, 'Base PnL reconstruction call-site gate runs whenever no sell swap candidates exist yet, independent of buyEvents')

// Fix 4: buildBaseUnknownDirectionSwapReconstructionPass exists specifically to recover MIXED txs
// where a buy leg is already classified but a same-tx sell/quote leg is still direction=unknown —
// it explicitly supports relayer/aggregator txs where txFrom != wallet. It used to bail the moment
// ANY swap candidate existed, defeating its own purpose once a buy was already detected.
assert.match(snap, /const existingSellSwapCount = evidenceWithDetection\.filter\(e => e\.swapDetection\?\.isSwapCandidate && e\.direction === 'sell'\)\.length\s*\n\s*if \(existingSellSwapCount > 0\) return \{ enrichedEvidence: evidenceWithDetection, debug: emptyDebug\('sell_swap_candidates_already_present'\) \}/, 'buildBaseUnknownDirectionSwapReconstructionPass only skips when a sell candidate already exists')

// Fix 5: its call-site gate must follow the same broadening.
assert.match(snap, /const _existingSellSwapCandidatesForUnknownDir = _swapEvidenceWithDetection\.filter\(e => e\.swapDetection\?\.isSwapCandidate && e\.direction === 'sell'\)\.length/, 'unknown-direction recon call site computes existing sell swap candidate count')
assert.match(snap, /_existingSellSwapCandidatesForUnknownDir === 0 &&/, 'unknown-direction recon call-site gate runs whenever no sell swap candidates exist yet, independent of buyEvents')

console.log('wallet swap direction attribution checks passed')
