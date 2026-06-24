import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// 1. Stable same-tx quote leg promotes a lot to public-grade — selectSameTxStableQuoteLeg already
// derives price from a same-tx, opposite-direction stable leg; this is unchanged and still feeds
// 'stable_leg', which computePriceIndependence/QUOTE_LEG_PRICE_SOURCES classify as independent.
assert.match(snap, /const stableQuote = selectSameTxStableQuoteLeg\(txGroup, e\)\s*\n\s*if \(stableQuote\) \{\s*\n\s*quoteLegCandidates\+\+/, 'a same-tx stable quote leg is counted as a quote-leg candidate before deriving price')
assert.match(snap, /stableQuoteProofsUsed\+\+\s*\n\s*return priced\(e, derivedPrice, 'stable_leg', 'high', stableQuote\.reason\)/, 'a valid same-tx stable quote leg derives price and is counted as a used stable quote proof')

// 2. WETH same-tx quote leg promotes only with a valid WETH price — the derived price is only
// accepted when positive and finite; an invalid/zero WETH price is rejected, not faked.
assert.match(snap, /wethQuoteProofsUsed\+\+\s*\n\s*return priced\(e, derivedPrice, 'weth_leg', 'medium', `Derived from WETH leg/, 'a valid same-tx WETH quote leg derives price and is counted as a used weth quote proof')
assert.match(snap, /rejectQuoteProof\('weth_quote_derived_price_invalid'\)/, 'an invalid/zero WETH-derived price is rejected, never faked into a price')

// 3. Wrapped/native quote equivalents — a same-tx unwrapped native transfer (ETH/BNB) is also
// usable as quote-leg proof, chain-scoped via normalizeChain + WRAPPED_NATIVE_CONTRACT_BY_CHAIN,
// and only for symbols verified by the existing isVerifiedNativeQuoteLeg allowlist.
assert.match(snap, /const WRAPPED_NATIVE_CONTRACT_BY_CHAIN: Record<string, string> = \{/, 'a chain -> wrapped-native contract map exists for native quote-leg pricing')
assert.match(snap, /const chainKey = normalizeChain\(e\.chain\)\s*\n\s*const wrappedContract = WRAPPED_NATIVE_CONTRACT_BY_CHAIN\[chainKey\]/, 'native quote-leg detection normalizes the chain alias before looking up the wrapped-native contract')
assert.match(snap, /&& isVerifiedNativeQuoteLeg\(ev\.chain, ev\.symbol \?\? ''\)/, 'a native leg is only accepted as quote-leg proof when isVerifiedNativeQuoteLeg confirms the symbol for that chain')
assert.match(snap, /nativeQuoteProofsUsed\+\+\s*\n\s*return priced\(e, derivedPrice, 'native_leg', 'medium', `Derived from native quote leg/, 'a valid same-tx native quote leg derives price and is counted as a used native quote proof')
assert.match(snap, /source: 'stable_leg' \| 'weth_leg' \| 'native_leg' \| 'historical_price'/, "PriceAtTimeEvidence['source'] includes the new 'native_leg' value")
assert.match(snap, /const QUOTE_LEG_PRICE_SOURCES = new Set\(\['stable_leg', 'weth_leg', 'native_leg',/, "'native_leg' is registered as an independent quote-leg price source")

// 4. Weak/missing quote legs remain excluded — no resolved quote leg still falls through to
// skippedNoStableOrWethLeg/skippedNoQuoteLeg exactly as before; the native-leg branch only adds a
// candidate path, it never changes the existing fallthrough when nothing resolves.
assert.match(snap, /if \(!_resolvedFromWethOrStable\) \{ skippedNoStableOrWethLeg\+\+; skippedNoQuoteLeg\+\+ \}/, 'a token event with no resolved stable/weth/native quote leg still falls through to the existing skipped counters')

// 5. Same-source flat estimate remains excluded — computePriceIndependence's flat-estimate gate
// is untouched by this change.
assert.match(snap, /\} else if \(pricesEqual && sameSource\) \{\s*\n\s*priceIndependenceStatus = sameSource \? 'same_source_flat_estimate' : 'missing_independent_price'/, 'same_source_flat_estimate gating in computePriceIndependence is unchanged')

// 6. Synthetic/dust lots remain excluded — classifyClosedLotForPublicPerformance's synthetic/dust
// rejection paths are untouched by this change.
assert.match(snap, /if \(synthetic \|\| lot\.costBasisUsd == null \|\| lot\.costBasisUsd <= 0\) return \{ reconstructedEligible: true, verifiedPnlEligible: false, performanceEligible: false, rejectReason: 'synthetic_cost_basis_missing'/, 'synthetic/missing-cost-basis lots are still rejected unchanged')
assert.match(snap, /if \(lot\.costBasisUsd < dustThreshold\) return \{ reconstructedEligible: true, verifiedPnlEligible: true, performanceEligible: false, rejectReason: 'dust_or_micro_lot'/, 'dust lots are still rejected unchanged')

// 7. No new provider calls — the native-leg branch reuses fetchGoldrushHistoricalPrice (same call
// already used by the weth_leg branch) and isGoldrushPriceCached for cache-awareness; it never
// calls a new provider function.
const nativeLegSection = snap.slice(snap.indexOf("QUOTE-LEG-PROOF-FIX: wrapped/native quote equivalents"), snap.indexOf("if (!_resolvedFromWethOrStable) { skippedNoStableOrWethLeg++; skippedNoQuoteLeg++ }"))
assert.match(nativeLegSection, /fetchGoldrushHistoricalPrice\(chainKey, wrappedContract!, e\.timestamp, reqCache\)/, 'native quote-leg pricing reuses the existing fetchGoldrushHistoricalPrice call, no new provider call is introduced')
assert.ok(!/fetch\([^G]/.test(nativeLegSection), 'the native quote-leg branch makes no new direct fetch() calls of its own')

// PnL gates unchanged — computePriceIndependence and classifyClosedLotForPublicPerformance
// thresholds (coverage/price-failure invalid gates, missing_independent_price rejection) are
// untouched; this patch is additive proof-extraction only.
assert.match(snap, /if \(lot\.priceIndependenceStatus === 'missing_independent_price' \|\| lot\.priceIndependenceStatus === 'current_price_reused' \|\| lot\.priceIndependenceStatus === 'fallback_price_reused'\) return \{ reconstructedEligible: true, verifiedPnlEligible: false, performanceEligible: false, rejectReason: 'missing_independent_price'/, 'missing/current/fallback price-reuse statuses remain non-performance-eligible unchanged')

// Debug transparency — quoteLegCandidates/stableQuoteProofsUsed/wethQuoteProofsUsed/
// nativeQuoteProofsUsed/quoteProofsRejected(+reasons) and publicGradeLotsBefore/After are wired
// into the diagnostics return objects.
assert.match(snap, /nativeLegPricedEvents: number\s*\n\s*quoteLegCandidates: number\s*\n\s*stableQuoteProofsUsed: number\s*\n\s*wethQuoteProofsUsed: number\s*\n\s*nativeQuoteProofsUsed: number\s*\n\s*quoteProofsRejected: number\s*\n\s*quoteProofsRejectedReasons: Record<string, number>/, 'walletPriceAtTimeDebug type carries the new quote-leg proof transparency fields')
assert.match(snap, /nativeLegPricedEvents,\s*\n\s*quoteLegCandidates,\s*\n\s*stableQuoteProofsUsed,\s*\n\s*wethQuoteProofsUsed,\s*\n\s*nativeQuoteProofsUsed,\s*\n\s*quoteProofsRejected,\s*\n\s*quoteProofsRejectedReasons,/, 'the new quote-leg proof debug fields are wired into the returned debug object')
assert.match(snap, /publicGradeLotsBefore: number\s*\n\s*publicGradeLotsAfter: number/, 'closedLotPriceUpgradeDebug type carries publicGradeLotsBefore/After')
assert.match(snap, /publicGradeLotsBefore: publicPerformanceLotsBefore, publicGradeLotsAfter: publicPerformanceLotsAfter,/, 'publicGradeLotsBefore/After are wired from the actual performance-eligible lot counts')

console.log('wallet quote leg proof checks passed')
