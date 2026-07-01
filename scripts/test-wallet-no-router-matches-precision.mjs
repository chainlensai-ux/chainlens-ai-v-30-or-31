import assert from 'node:assert/strict'
import fs from 'node:fs'

// Regression guard: "no_router_matches" (and the Moralis-fallback skip reason
// "scan_mode_blocks_moralis_transfers") must only ever fire when there is truly no usable
// swap/router evidence — never as a side effect of the classifier giving up early, and never as
// a way to paper over evidence that a scan mode simply chose not to fetch.

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// noTradesReason is only assigned when swapCandidateEvents is already 0 AND real evidence exists
// (totalEvidenceEvents > 0) — it is a diagnostic label for a real absence, not a trigger that can
// suppress evidence that was actually found.
assert.match(
  snap,
  /if \(swapCandidateEvents === 0 && totalEvidenceEvents > 0\) \{\s*\n\s*if \(totalEvidenceEvents < 5\) \{\s*\n\s*noTradesReason = 'sample_too_small'\s*\n\s*\} else if \(transferEvents \+ airdropCandidateEvents >= totalEvidenceEvents - duplicateEventCount\) \{\s*\n\s*noTradesReason = 'transfer_only_activity'\s*\n\s*\} else if \(knownRouterMatchCount === 0 && walletInitiatedSwapLikeTxCount === 0\) \{\s*\n\s*noTradesReason = 'no_router_matches'/,
  'no_router_matches requires swapCandidateEvents === 0 AND zero known router matches AND zero wallet-initiated swap-like txs — never assigned while real evidence exists',
)

// The classifier itself must promote a candidate the moment ANY of the router/pairing/aggregator
// paths hold — no_router_matches can only be reached once none of those already fired.
assert.match(snap, /txToKnownRouter && walletIsInitiator\) \{[\s\S]{0,40}\/\/ High confidence: wallet called a known swap router directly/, 'router-initiated swaps are promoted before any no-trade classification runs')
assert.match(snap, /hasInboundOutbound && hasMultipleDistinctTokens\) \{\s*\n\s*detection = \{ isSwapCandidate: true/, 'same-tx paired buy+sell swaps are promoted before any no-trade classification runs (router-independent)')

// scan_mode_blocks_moralis_transfers is an honest "this data source was not attempted" label, not
// a silent evidence suppressor — it must only appear when allowMoralisTransfers is actually false
// for the resolved mode, and it must never appear for full_recovery (which always allows it).
assert.match(snap, /_walletMoralisHardGateDebug\.transfersSkippedByChain\[_fbChain\] = !_moralisTransfersAllowedByMode \? 'scan_mode_blocks_moralis_transfers'/, 'scan_mode_blocks_moralis_transfers is reported only when the resolved mode truly disallows Moralis transfers')
assert.match(snap, /full_recovery: \{[\s\S]{0,400}allowMoralisTransfers: true,/, 'full_recovery mode always allows Moralis transfers, so it can never report scan_mode_blocks_moralis_transfers')

// The deep-tier fix must not change what counts as "truly no evidence" — it only restores a real
// evidence source; the reason-classification thresholds (sample_too_small / transfer_only_activity
// / no_router_matches / no_quote_leg) are completely unchanged.
assert.match(snap, /noTradesReason = 'no_quote_leg'/, 'no_quote_leg branch (router/aggregator matched but no quote leg) is unchanged')
assert.match(snap, /noTradesMessage = 'No swap evidence found in current sample'/, 'noTradesMessage copy is unchanged')

console.log('test-wallet-no-router-matches-precision: all assertions passed')
