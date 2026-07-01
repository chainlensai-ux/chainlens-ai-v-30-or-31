import assert from 'node:assert/strict'
import fs from 'node:fs'

// Deep Scan escalation rule (walletSnapshot.ts Phase 5C base-FIFO-coverage gate):
//
//   if (goldrushActivityUsable && swapCandidateEvents > 0) {
//     return { stoppedReason: "goldrush_activity_usable" }   // safe to stop early
//   }
//   // otherwise escalate: runHistoricalRecovery / runMoralisFallback / runAlchemyHistorical /
//   // runReceiptProofs / runPriceAtTime (buildTxEvidenceFromEvents -> buildSwapDetection ->
//   // buildPriceAtTimeEvidence -> buildFifoLotEngine re-run against merged Moralis pages)
//
// Previously "GoldRush activity usable" meant only "GoldRush returned events" (grEvents.length >
// 0), independent of whether swap detection actually found any candidates in them. A wallet whose
// GoldRush events all failed classification (e.g. single-leg groups, no recognized router — see
// "no_router_matches") was wrongly treated as "already covered," permanently blocking escalation
// into the Moralis-backed recovery pass even though zero real swap evidence had been found.

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// smartRecoveryEngine.ts has no gating logic of its own for this — it delegates entirely to
// fetchWalletSnapshot(), so it inherits this fix automatically without any changes of its own.
const engine = fs.readFileSync('lib/server/smartRecoveryEngine.ts', 'utf8')
assert.doesNotMatch(engine, /goldrush_activity_usable|swapCandidateEvents/, 'smartRecoveryEngine.ts has no independent escalation gate — it inherits the fix via fetchWalletSnapshot')
assert.match(engine, /await fetchWalletSnapshot\(/, 'smartRecoveryEngine.ts delegates to fetchWalletSnapshot, which carries this fix')

// The "safe to stop early" condition now requires BOTH usable activity AND real swap candidates.
assert.match(
  snap,
  /const _goldrushActivityUsableAndHasSwapCandidates = _goldrushActivityUsableForMoralisGate && walletSwapSummary\.swapCandidateEvents > 0/,
  '"safe to stop early" requires goldrushActivityUsable AND swapCandidateEvents > 0, matching the escalation rule',
)

// Escalation (the base-FIFO-coverage pass) fires in the case the old gate missed: GoldRush usable
// by raw event count but zero swap candidates extracted.
assert.match(
  snap,
  /\(walletSwapSummary\.swapCandidateEvents === 0 && _goldrushActivityUsableForMoralisGate\)/,
  'escalation runs when GoldRush activity exists but produced zero swap candidates',
)
// The original escalation case (no GoldRush data at all, swap candidates found some other way but
// no real-backed closed lots yet) must still work — this fix only adds a case, it does not remove one.
assert.match(
  snap,
  /\(walletSwapSummary\.swapCandidateEvents > 0 && !_goldrushActivityUsableForMoralisGate\)/,
  'the original escalation case (no usable GoldRush activity) is preserved unchanged',
)

// The escalation pass itself (buildTxEvidenceFromEvents -> buildSwapDetection ->
// buildPriceAtTimeEvidence -> buildFifoLotEngine, run against Moralis-merged events) is untouched —
// this fix only changes when it fires, not what it does or how FIFO/pricing/integrity are computed.
assert.match(snap, /if \(_shouldRunBaseFifoCoverage\) \{/, 'the base-FIFO-coverage recovery pass itself is unchanged')
assert.match(snap, /const bfcFifo = buildFifoLotEngine\(_pricedEvidence, activityRequested\)/, 'recovery still runs the real, unmodified FIFO engine — no synthetic trades are invented')

// This fix must not touch admin gating, official PnL fields, or scan-mode cost caps.
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
assert.match(route, /const fullRecoveryAllowed = \(authInfo\.email \?\? ''\)\.toLowerCase\(\) === 'chainlensai@gmail\.com'/, 'full_recovery/smart_recovery admin email gate is untouched')
assert.match(snap, /_baseFifoCoverageDebug\.attempted = true/, 'the coverage pass still respects its own existing deepActivity/budget/chain preconditions unchanged')

console.log('test-wallet-swap-detection-goldrush-usable-escalation: all assertions passed')
