import assert from 'node:assert/strict'
import fs from 'node:fs'

// Regression: a wallet (0x30ec8aea...) that used to produce swap pairs, closed lots, and PnL
// started reporting walletSwapSummary.swapCandidateEvents = 0, noTradesReason = "no_router_matches",
// and walletHistoricalSourceBudget.stoppedReason = "scan_mode_blocks_moralis_transfers" on a Deep
// Scan, even though 19 grouped txs / 228 evidence events were present.
//
// Root cause: "Simplify wallet scan modes" gated the Moralis-transfers activity supplement behind
// WALLET_SCAN_MODE_CONFIG[mode].allowMoralisTransfers and defaulted `deep` to false. Before that
// commit, the Moralis-transfers fallback fired for ANY deepActivity request once GoldRush activity
// came back thin/zero (see _shouldTryMoralisFallback), independent of scan tier.
//
// This matters beyond raw event count: normalizeMoralisTransfers resolves direction strictly from
// to/from vs. the wallet address and DROPS anything that doesn't match ('unknown' rows are
// discarded, never kept as context) — so a real two-leg swap recovered via Moralis always lands as
// a same-tx wallet-side buy + sell pair. That satisfies the router-INDEPENDENT "Pairing" swap
// classification path (hasInboundOutbound && hasMultipleDistinctTokens, buildSwapDetection) even
// when the router itself isn't in KNOWN_DEX_ROUTERS/EXTENDED_DEX_ROUTERS. GoldRush, by contrast,
// keeps direction='unknown' for third-party/pool-internal legs, which routinely leaves only ONE
// wallet-side leg per tx (buy-only or sell-only) for multi-hop/aggregator swaps — never satisfying
// hasInboundOutbound, and falling through to "no_router_matches" whenever the router also isn't
// recognized. Restoring the Moralis supplement for deep scans lets real (not synthetic) paired
// evidence reach the classifier again.

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')

// ── Fix: deep scans can reach the Moralis transfers supplement again ──
assert.match(snap, /deep: \{[\s\S]{0,2500}allowMoralisTransfers: true,/, 'deep scan mode config restores allowMoralisTransfers')
assert.match(snap, /deep: \{[\s\S]{0,2500}allowMoralisProviderPnl: false,/, 'deep scan mode does NOT gain the Moralis provider-computed PnL shortcut (stays full_recovery/admin-only)')
assert.match(snap, /normal: \{[\s\S]{0,400}allowMoralisTransfers: false,/, 'normal (non-deep) scan mode is unchanged — fix is scoped to the deep tier only')

// ── The gate this restores still reads the same scanModeConfig flag everywhere — no new bypass ──
assert.match(snap, /_moralisTransfersAllowedByMode = Boolean\(scanModeConfig\?\.allowMoralisTransfers\)/, 'Moralis-transfer fallback gate still reads scanModeConfig.allowMoralisTransfers')
assert.match(snap, /_shouldTryMoralisFallback = _moralisTransfersAllowedByMode && deepActivity/, 'Moralis activity supplement still requires deepActivity in addition to the mode flag')

// ── The mechanism this fix restores: Moralis drops (not keeps) unknown-direction rows, so a
// recovered swap's legs are always correctly wallet-attributed and can satisfy the
// router-independent Pairing path ──
assert.match(snap, /direction: 'buy' \| 'sell' \| 'unknown' = to === lower \? 'buy' : from === lower \? 'sell' : 'unknown'/, 'Moralis normalization resolves direction strictly against the wallet address')
assert.match(snap, /if \(direction === 'unknown'\) \{ skippedNotWalletSide\+\+; continue \}/, 'Moralis normalization drops unknown-direction rows entirely (never emits GoldRush-style context-only legs)')
assert.match(snap, /hasInboundOutbound && hasMultipleDistinctTokens\) \{\s*\n\s*detection = \{ isSwapCandidate: true/, 'the router-independent Pairing classification path is untouched by this fix')

// ── noTradesReason branching itself is untouched — this fix restores evidence supply, it does not
// loosen (or bypass) the existing no_router_matches / transfer_only_activity / no_quote_leg logic ──
assert.match(snap, /knownRouterMatchCount === 0 && walletInitiatedSwapLikeTxCount === 0\) \{\s*\n\s*noTradesReason = 'no_router_matches'/, 'no_router_matches still only fires when there is truly no router match and no wallet-initiated swap-like pattern')

// ── Admin gating and PnL integrity gates are untouched by this fix ──
assert.match(route, /const fullRecoveryAllowed = \(authInfo\.email \?\? ''\)\.toLowerCase\(\) === 'chainlensai@gmail\.com'/, 'full_recovery/smart_recovery admin email gate is untouched')
assert.doesNotMatch(route, /body(?:\?\.|\.)userEmail/, 'route still never trusts a client-supplied email for admin authorization')
assert.match(snap, /_providerProfitDeepActivityRequested = Boolean\(deepScan \|\| deepActivity\) && Boolean\(scanModeConfig\?\.allowMoralisProviderPnl\)/, 'Moralis provider-computed PnL shortcut is still gated separately and stays false for deep')

console.log('test-wallet-swap-detection-moralis-fallback-fix: all assertions passed')
