import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// 1. token_contract_like / treasury_or_distributor_like addresses never recommend PnL recovery.
assert.match(snap, /_walletIsNonTraderAddressType = _walletAddressTypeForRecovery === 'token_contract_like' \|\| _walletAddressTypeForRecovery === 'treasury_or_distributor_like'/, 'non-trader address types are identified before recovery recommendation runs')
assert.match(snap, /const _walletRecoveryRecommendation: WalletSnapshot\['walletRecoveryRecommendation'\] = _walletIsNonTraderAddressType\s*\n\s*\? \{ recommended: false, mode: 'none', targetTokens: \[\], reason: 'non_trader_address_type', estimatedExtraPages: 0 \}/, 'non-trader address types never get recommended=true for PnL recovery')
assert.match(snap, /eligible: \(walletFacts\.sourceClassification\?\.walletAddressType !== 'token_contract_like' && walletFacts\.sourceClassification\?\.walletAddressType !== 'treasury_or_distributor_like'\) && /, 'walletHistoricalScanDebug.eligible is never true for non-trader address types')

// 2. non-trader addresses show not-applicable/non-trader copy, not generic "no trades" copy.
assert.match(snap, /const _contractLikeLabel = 'Portfolio\/activity read only — not a trader wallet'/, 'non-trader public PnL display label is the dedicated non-trader copy')
assert.match(snap, /walletNoPnlReason = 'non_trader_address_type'/, 'non-trader addresses report walletNoPnlReason=non_trader_address_type')
assert.match(snap, /walletNoPnlReasonLabel = 'Not applicable — token\/distributor address'/, 'non-trader addresses get a not-applicable label, not a generic no-trades label')
assert.match(snap, /ts\.economicSignificanceReason = 'non_trader_address_type'/, 'walletTradeStatsSummary.economicSignificanceReason is non_trader_address_type for non-trader addresses, not no_closed_lots')
assert.match(ui, /isNonTraderAddressType = result\.walletNoPnlReason === 'non_trader_address_type'/, 'UI derives non-trader status from walletNoPnlReason')
assert.match(ui, /label: 'Trader PnL', note: 'Not applicable — token\/distributor address'/, 'UI shows Trader PnL: Not applicable for non-trader addresses')
assert.match(ui, /label: 'Trade stats', note: 'Not evaluated for this address type'/, 'UI shows Trade stats: Not evaluated for this address type for non-trader addresses')

// 3. normal_wallet with activity but no swap candidates (and other precise no-PnL cases) gets
// walletNoPnlReason classified from real evidence, never a bare boolean/empty fallback.
for (const reason of [
  'no_wallet_initiated_transactions', 'no_swap_candidates', 'transfer_or_airdrop_only_activity',
  'missing_counterparty_direction_data', 'budget_capped_before_recovery', 'historical_recovery_needed',
  'unsupported_router_or_unparsed_receipts',
]) {
  assert.match(snap, new RegExp(`_noPnlReason = '${reason}'`), `normal_wallet no-PnL classification includes ${reason}`)
}
assert.match(snap, /walletNoPnlReason\?:\s*'non_trader_address_type' \| 'no_wallet_initiated_transactions'/, 'WalletSnapshot type exposes walletNoPnlReason')
assert.match(snap, /walletNoPnlCanRecover\?:\s*boolean/, 'WalletSnapshot type exposes walletNoPnlCanRecover')

// 4. existing PnL integrity gates are untouched by this patch.
assert.match(snap, /if \(lot\.priceIndependenceStatus === 'missing_independent_price' \|\| lot\.priceIndependenceStatus === 'current_price_reused' \|\| lot\.priceIndependenceStatus === 'fallback_price_reused'\) return \{ reconstructedEligible: true, verifiedPnlEligible: false, performanceEligible: false,/, 'missing/current/fallback price-reuse statuses remain non-performance-eligible unchanged')
assert.match(snap, /snapshot\.publicPnlIntegrityGate = \{/, 'the existing publicPnlIntegrityGate construction is unchanged')

// 5. low-cost recovery reuse for normal wallets with no swap candidates — same function, same
// receipt cap, no new provider call sites, no raised caps.
assert.match(snap, /_noSwapCandidateRecoveryEligible =\s*\n\s*_syntheticClosedLots\.length === 0 &&\s*\n\s*_realBackedClosedLotsCountForV2 === 0 &&\s*\n\s*walletSwapSummary\.swapCandidateEvents === 0 &&\s*\n\s*_rankedHistoricalTargets\.length > 0/, 'the no-swap-candidate recovery path is gated on zero lots and zero swap candidates, using only already-ranked targets')
assert.match(snap, /\? await buildWalletPnlRecoveryV2Base\(\s*\n\s*addrNorm,\s*\n\s*baseRpcUrl,\s*\n\s*\[\.\.\._hcMergedAllHistoricalEvidence, \.\.\._swapEvidenceWithDetection\],\s*\n\s*_pnlRecoveryV2TargetTokens,\s*\n\s*2,/, 'the broadened recovery path reuses the same buildWalletPnlRecoveryV2Base call with the same 2-receipt cap')
const recoverySection = snap.slice(snap.indexOf('PNL-RECOVERY-V2-BASE:'), snap.indexOf('MORALIS-MISSING-BUY-RECOVERY:'))
const recoveryCallSites = recoverySection.match(/await buildWalletPnlRecoveryV2Base\(/g) ?? []
assert.equal(recoveryCallSites.length, 1, 'no new provider/reconstruction call sites were added — exactly one buildWalletPnlRecoveryV2Base invocation')

// 6. no public provider names leak into new UI/copy strings added by this patch.
const newUiSnippets = [
  "Not applicable — token/distributor address",
  "Not evaluated for this address type",
]
for (const s of newUiSnippets) {
  assert.ok(!/goldrush|moralis|covalent|alchemy|infura/i.test(s), `new UI copy "${s}" does not leak a provider name`)
}
const newBackendCopy = snap.slice(snap.indexOf('WALLET-ADDRESS-TYPE-GATE-1'), snap.indexOf('}\n  } catch') === -1 ? snap.length : snap.indexOf('}\n  } catch'))
assert.doesNotMatch(newBackendCopy.slice(0, 6000), /goldrush|moralis|covalent|alchemy|infura/i, 'the new no-PnL classification block does not leak a provider name into reason/label strings')

console.log('wallet no-PnL UX checks passed')
