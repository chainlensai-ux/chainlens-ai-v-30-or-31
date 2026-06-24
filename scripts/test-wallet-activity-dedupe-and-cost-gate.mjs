import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// 1. base/base-mainnet duplicate activity event removed — Phase 18's supplement merge now uses
// the chain-normalized canonical dedupe key (pnlEventDedupeKey), not raw e.chain, so the same
// on-chain transfer labeled 'base' by one provider and 'base-mainnet' by another collapses to one.
assert.match(snap, /WALLET-DEDUPE-1: chain-normalized dedupe key/, 'Phase 18 merge documents the chain-normalized dedupe fix')
assert.match(snap, /for \(const e of _p18All\) \{\s*\n\s*\/\/ WALLET-DEDUPE-1[\s\S]{0,200}const mk = pnlEventDedupeKey\(e\)/, 'Phase 18 merge key is the canonical pnlEventDedupeKey, which normalizes chain via normalizeChain()')
assert.ok(!/const mk = `\$\{e\.chain \?\? ''\}\|\$\{e\.txHash/.test(snap), 'the old raw, non-normalized chain merge key no longer exists')

// 2. distinct partial/log-index events preserved — pnlEventDedupeKey still includes logIndex, so
// two genuinely distinct legs of the same tx (different logIndex) are never collapsed into one.
assert.match(snap, /function pnlEventDedupeKey\(e: PnlEvent\): string \{[\s\S]{0,800}logIndexPart[\s\S]{0,400}\n\}/, 'pnlEventDedupeKey (now reused by Phase 18) still includes logIndex, preserving distinct partial-leg events')

// 3. token contract-like wallet detected — walletAddressType classification exists and flags an
// address that is itself a currently-held token contract.
assert.match(snap, /walletAddressType: 'normal_wallet' \| 'contract_wallet' \| 'token_contract_like' \| 'treasury_or_distributor_like' \| 'unknown'/, 'WalletFacts.sourceClassification carries the new walletAddressType field')
assert.match(snap, /const _addressIsHeldTokenContract = pricedHoldings\.some\(h => \(h\.contract \?\? ''\)\.toLowerCase\(\) === _walletAddressLower\)/, 'a scanned address matching one of its own held token contracts is detected from existing holdings evidence')
assert.match(snap, /if \(_addressIsHeldTokenContract\) \{\s*\n\s*walletAddressType = 'token_contract_like'/, 'an address matching a held token contract is classified as token_contract_like')

// 4. contract-like wallet does not trigger trader PnL recovery — the new gate locks profit skill
// and rewrites PnL display messaging for token_contract_like / treasury_or_distributor_like wallets.
assert.match(snap, /WALLET-ADDRESS-TYPE-GATE-1: a token-contract\/treasury\/distributor-like address is not a/, 'the contract-like PnL gate is present')
assert.match(snap, /const _walletIsContractLikeForPnl = _walletAddressTypeForGate === 'token_contract_like' \|\| _walletAddressTypeForGate === 'treasury_or_distributor_like'/, 'the gate applies to both token_contract_like and treasury_or_distributor_like classifications')
assert.match(snap, /snapshot\.tradeIntelligence\.profitSkillStatus = 'integrity_invalid_not_proven'\s*\n\s*snapshot\.tradeIntelligence\.tradeStyleSummary = `Portfolio\/activity read only/, 'a contract-like wallet has its profit-skill path locked and its trade style summary rewritten to portfolio/activity-read-only')

// 5. Moralis supplements skipped for low-value/no-swap chains — Phase 19's side-chain supplement
// now requires a meaningful chain value (not just the global $1 dust threshold) before spending a
// Moralis call, and records which chains were skipped and why.
assert.match(snap, /WALLET-MORALIS-COST-GATE-1: low-value side chains/, 'the Moralis side-chain cost gate is documented')
assert.match(snap, /const _p19MeaningfulChainValueUsd = 10/, 'a meaningful chain-value threshold above the $1 dust threshold gates the Phase 19 Moralis supplement')
assert.match(snap, /moralisSupplementSkipReasons\[c\.chain\] = 'below_meaningful_chain_value_threshold'/, 'chains below the meaningful value threshold are recorded as skipped with a reason')
assert.match(snap, /moralisSupplementSkipReasons\[c\.chain\] = 'max_additional_chains_reached'/, 'chains beyond the existing max-additional-chains cap are recorded as skipped, not silently dropped')

// 6. normal wallet behavior unchanged — a wallet with wallet-initiated txs and swap-like activity,
// and no held-token-contract self-match, still falls through to normal_wallet classification.
assert.match(snap, /\} else \{\s*\n\s*walletAddressType = 'normal_wallet'\s*\n\s*walletAddressTypeReason = 'wallet_initiates_transactions_with_trader_or_holder_like_activity'/, 'a wallet with ordinary trader/holder evidence still classifies as normal_wallet')

// 7. PnL gates unchanged — the existing hard-invalid/soft-partial integrity gates and the
// missing/current/fallback price-reuse rejection are untouched by this patch.
assert.match(snap, /if \(lot\.priceIndependenceStatus === 'missing_independent_price' \|\| lot\.priceIndependenceStatus === 'current_price_reused' \|\| lot\.priceIndependenceStatus === 'fallback_price_reused'\) return \{ reconstructedEligible: true, verifiedPnlEligible: false, performanceEligible: false,/, 'missing/current/fallback price-reuse statuses remain non-performance-eligible unchanged')
assert.match(snap, /snapshot\.publicPnlIntegrityGate = \{/, 'the existing publicPnlIntegrityGate construction is unchanged')

// 8. no provider calls added — the dedupe fix only changes a dedupe *key*, and the Moralis cost
// gate only narrows an existing eligibility filter; neither introduces a new fetch/provider call.
const p18Section = snap.slice(snap.indexOf('Phase 1.8: Cross-chain activity supplement'), snap.indexOf('Phase 19: deep-scan multi-chain supplement'))
const p18FetchCalls = p18Section.match(/fetchMoralisTransfers\(/g) ?? []
assert.equal(p18FetchCalls.length, 1, 'Phase 18 still makes exactly one fetchMoralisTransfers call (dedupe-only change, no new provider call)')
const p19Section = snap.slice(snap.indexOf('Phase 19: deep-scan multi-chain supplement'), snap.indexOf('Phase 20: DATA-SOURCE-PRIORITY-1'))
const p19FetchCalls = p19Section.match(/fetchMoralisTransfers\(/g) ?? []
assert.equal(p19FetchCalls.length, 1, 'Phase 19 still makes exactly one fetchMoralisTransfers call site (cost-gate only narrows eligibility, no new provider call)')

// Debug transparency — the new diagnostics fields are wired into the returned _diagnostics object.
assert.match(snap, /walletActivityDedupeDebug\?: \{\s*\n\s*activityEventsBeforeDedupe: number\s*\n\s*activityEventsAfterDedupe: number\s*\n\s*activityDuplicatesRemoved: number\s*\n\s*duplicateChainAliasCount: number/, 'the _diagnostics type carries the new walletActivityDedupeDebug block')
assert.match(snap, /walletActivityDedupeDebug: \{\s*\n\s*activityEventsBeforeDedupe: _budgetEventsBefore,\s*\n\s*activityEventsAfterDedupe: _budgetEventsAfterDedup,\s*\n\s*activityDuplicatesRemoved: _budgetEventsBefore - _budgetEventsAfterDedup,/, 'walletActivityDedupeDebug is wired into the returned diagnostics object from the real before/after counters')

console.log('wallet activity dedupe and cost gate checks passed')
