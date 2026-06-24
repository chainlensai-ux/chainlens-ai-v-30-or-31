import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// 1. Moralis usable holdings are merged with fallback coverage instead of blindly replacing it —
// fallback positions for chains Moralis doesn't cover are kept, with dedupe against chains it does.
assert.match(snap, /const _moralisChainKeys = new Set\(activeChains\)/, 'merge is scoped to the chains Moralis actually attempted (activeChains)')
assert.match(snap, /holdings = \[\.\.\._moralisNormalizedHoldings, \.\.\._fallbackKept\]/, 'final holdings combine normalized moralis rows with kept fallback rows instead of discarding fallback coverage')
assert.match(snap, /return true \/\/ chain Moralis doesn't cover this scan — keep fallback coverage as-is/, 'fallback positions on chains Moralis does not cover are preserved')

// 2. Moralis empty holdings falls back cleanly, with an explicit rejected reason.
assert.match(snap, /_moralisRejectedReasonFinal = moralisHoldingsRaw\.length === 0\s*\n\s*\? 'moralis_empty_holdings'/, 'empty moralis holdings produce an explicit moralis_empty_holdings rejection reason')

// 3. Malformed Moralis rows are dropped individually rather than poisoning the whole source.
assert.match(snap, /const hasIdentity = Boolean\(h\.contract\) \|\| \(Boolean\(h\.symbol\) && h\.symbol !== '\?' && Boolean\(h\.chain\)\)/, 'normalization requires valid token identity per row')
assert.match(snap, /const hasPositiveBalance = Number\.isFinite\(h\.balance\) && h\.balance > 0/, 'normalization requires a finite positive balance per row')
assert.match(snap, /_moralisRejectedReasonFinal = moralisHoldingsRaw\.length === 0\s*\n\s*\? 'moralis_empty_holdings'\s*\n\s*: 'moralis_holdings_malformed'/, 'a source with only malformed rows is rejected with moralis_holdings_malformed')

// 4. No duplicate Moralis holdings calls — single attempt per active chain, reusing the existing
// fetchMoralisBalances cache/in-flight dedupe; no second/duplicate call site was added.
assert.equal((snap.match(/fetchMoralisBalances\(/g) ?? []).length, 1, 'fetchMoralisBalances is still called from exactly one call site')
assert.match(snap, /await Promise\.allSettled\(activeChains\.map\(async \(c\) => \{\s*\n\s*const _mbRes = await fetchMoralisBalances\(addr, c\)/, 'moralis holdings are fetched once per active chain via Promise.allSettled, not per-call duplication')

// 5. Debug consistency — the new walletHoldingsRoutingDebug object exists with the exact required
// shape and is wired into _diagnostics; providerFallback no longer reports GoldRush as "primary".
assert.match(snap, /walletHoldingsRoutingDebug\?: \{[\s\S]*moralisHoldingsAttempted: boolean[\s\S]*selectedHoldingsLayer: 'moralis' \| 'fallback' \| 'merged' \| 'none'[\s\S]*totalValue: number \| null\s*\n\s*\}/, 'walletHoldingsRoutingDebug type is declared with the full required shape')
assert.match(snap, /const walletHoldingsRoutingDebug: NonNullable<NonNullable<WalletSnapshot\['_diagnostics'\]>\['walletHoldingsRoutingDebug'\]> = \{/, 'walletHoldingsRoutingDebug object is constructed')
assert.match(snap, /walletHoldingsRoutingDebug,\n/, 'walletHoldingsRoutingDebug is wired into the returned _diagnostics object')
assert.match(snap, /primaryAttempted: _moralisAttemptedFinal,\s*\n\s*primaryUsable: _moralisHoldingsUsable,/, 'providerFallback.primary now refers to Moralis (the documented primary provider), not GoldRush')

// 6. Public provider-name safety — the routing/merge logic itself never emits provider names into
// any public-facing string field (debug objects may use provider names; this check is scoped to the
// merge/selection block only, which is what feeds the public holdings result).
const routingSection = snap.slice(snap.indexOf('_fallbackHoldingsBeforeMoralis: Holding[]'), snap.indexOf('const _grPrimaryUsable = _goldrushHoldingsUsed'))
assert.ok(!/"[^"]*\b(Moralis|Zerion|GoldRush)\b[^"]*"/.test(routingSection), 'the holdings merge/selection block never hardcodes a provider name into a quoted (potentially public-facing) string')

// 7. PnL lane unchanged — this task must not touch any PnL integrity/closed-lot/profit-skill fields.
assert.ok(!/rawMatchedLots|verifiedPnlLots|publicPerformanceLots|publicPnlIntegrityGate/.test(routingSection), 'the holdings routing/merge block does not reference any PnL-lane fields')

console.log('wallet holdings routing merge checks passed')
