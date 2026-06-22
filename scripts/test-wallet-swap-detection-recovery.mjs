import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// Scenario 1: same-tx inbound token + outbound USDC -> swapCandidateEvents > 0 (existing
// hasInboundOutbound && txHasStableOrWeth branch in buildSwapDetection).
assert.match(snap, /else if \(hasInboundOutbound && txHasStableOrWeth\) \{\s*\n\s*detection = \{ isSwapCandidate: true, confidence: 'medium', eventKind: 'swap_candidate', reason: 'Inbound\+outbound in same tx with stable\/WETH leg'/, 'same-tx inbound+outbound with stable/WETH leg is classified as a swap candidate')

// Scenario 2: tx to a known router with token legs -> routerSwapCandidateEvents > 0.
assert.match(snap, /if \(txToKnownRouter && walletIsInitiator\) \{[\s\S]{0,500}routerSwapCandidateEventsCount\+\+/, 'wallet-initiated known-router tx increments routerSwapCandidateEventsCount')
assert.match(snap, /const EXTENDED_DEX_ROUTERS = new Set<string>\(\[/, 'known router address set exists')
assert.match(snap, /const KNOWN_DEX_ROUTERS: Record<string, string> = \{/, 'named router protocol map exists')

// Scenario 3: activity exists, no swap candidates before receipt reconstruction -> reconstruction
// runs when eligible (gated on swapCandidateEvents === 0 && events exist && activity requested).
assert.match(snap, /const _shouldEnrich = activityRequested && walletSwapSummary\.swapCandidateEvents === 0 && walletEvidenceSummary\.totalEvents > 0/, 'receipt reconstruction is gated on zero swap candidates with real activity present')
assert.match(snap, /const enrichResult = await enrichSwapCandidatesFromReceipts\(_swapEvidenceWithDetection, addrNorm, _enrichAlchemyUrl, activityRequested, deepScan\)/, 'receipt reconstruction call site threads deepScan through')

// Scenario 4: receipt has a wallet-side leg + a quote leg -> reconstructed swap candidate created;
// caps widened to 20 (normal) / 50 (deep) candidate txs per spec.
assert.match(snap, /const maxCandidates = deepScan \? 50 : 20/, 'candidate tx cap is 20 normal / 50 deep scan')
assert.match(snap, /if \(hasWalletLeg && hasQuoteLeg\) \{\s*\n\s*isSwap = true\s*\n\s*enrichReason = 'wallet_leg_plus_quote_leg_in_receipt'/, 'receipt reconstruction requires BOTH a wallet-side leg and a quote leg before promoting')

// Scenario 5: transfer-only/airdrop activity must never be promoted to a fake swap candidate —
// the candidate-selection step for receipt reconstruction requires router/initiator/multi-token
// signal, and the per-event classifier has dedicated airdrop_candidate/transfer (non-swap) kinds.
assert.match(snap, /if \(!walletInitiated && !knownRouter && !hasMultipleTokenMovements\) continue/, 'receipt reconstruction candidate selection skips plain transfer-only/airdrop transactions')
assert.match(snap, /eventKind: 'airdrop_candidate', reason: 'Inbound-only transfer — no matching wallet-side outbound in tx'/, 'inbound-only transfers are classified as airdrop_candidate, never promoted to a swap')

// Scenario 6: missing quote leg -> no swap candidate and reason no_quote_leg is tracked/exposed.
assert.match(snap, /\} else if \(!hasQuoteLeg\) \{\s*\n\s*skippedNoQuoteLeg\+\+/, 'receipt reconstruction tracks skippedNoQuoteLeg when only a wallet-side leg is found')
assert.match(snap, /noTradesReason\?: 'sample_too_small' \| 'no_router_matches' \| 'no_quote_leg' \| 'transfer_only_activity' \| 'reconstruction_budget_capped'/, 'walletSwapSummary exposes a typed noTradesReason instead of implying the wallet has no trades')
assert.match(snap, /noTradesMessage = 'No swap evidence found in current sample'/, 'no-swap-candidates case reports the required UI-safe message')

// Scenario 7: budget cap -> reconstruction stops safely and reports the cap via skippedBudgetCap /
// the reconstruction_budget_capped reason, without throwing or fabricating evidence.
assert.match(snap, /const skippedBudgetCap = Math\.max\(0, candidateTxHashes\.length - maxCandidates\)/, 'reconstruction computes how many candidate txs were dropped at the budget cap')
assert.match(snap, /\} else if \(\(enrichResult\.debug\.skippedBudgetCap \?\? 0\) > 0\) \{[\s\S]{0,400}noTradesReason: 'reconstruction_budget_capped'/, 'a budget-capped reconstruction pass reports reconstruction_budget_capped instead of silently reporting no trades')

// Debug field coverage (Task 1-3 requested field names).
for (const field of ['txFromMissingCount', 'txToMissingCount', 'walletInitiatedDerivationSource', 'routerProtocolBreakdown', 'routerMatchedTxs']) {
  assert.match(snap, new RegExp(`${field}\\??:`), `walletSwapDetectionDebug exposes ${field}`)
}
for (const field of ['receiptReconstructionAttempted', 'candidateTxsChecked', 'transferLogsDecoded', 'walletSideLegsFound', 'quoteLegsFound', 'syntheticSwapEventsAdded', 'reconstructedSwapCandidateEvents', 'skippedNoQuoteLeg', 'skippedNoWalletLeg', 'skippedBudgetCap']) {
  assert.match(snap, new RegExp(`${field}\\??:`), `walletSwapEnrichmentDebug exposes ${field}`)
}

console.log('wallet swap detection recovery checks passed')
