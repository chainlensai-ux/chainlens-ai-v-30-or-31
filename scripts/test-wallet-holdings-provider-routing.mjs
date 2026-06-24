import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')

// 1. The explicit holdings provider routing diagnostic exists with the full requested shape.
assert.match(snap, /walletHoldingsProviderRoutingDebug\?: \{[\s\S]*moralisConfigured: boolean[\s\S]*moralisSkippedReason: string \| null[\s\S]*selectedProvider: 'moralis' \| 'zerion' \| 'goldrush' \| 'none'[\s\S]*fallbackReason: string \| null\s*\n\s*\}/, 'walletHoldingsProviderRoutingDebug type is declared with the full requested shape')
assert.match(snap, /const walletHoldingsProviderRoutingDebug: NonNullable<NonNullable<WalletSnapshot\['_diagnostics'\]>\['walletHoldingsProviderRoutingDebug'\]> = \{/, 'walletHoldingsProviderRoutingDebug object is constructed')
assert.match(snap, /walletHoldingsProviderRoutingDebug,/, 'walletHoldingsProviderRoutingDebug is wired into _diagnostics')

// 2. If Moralis holdings are disabled (explicit kill switch) or not configured, that is reported
// honestly — not as an ambiguous empty/failed call.
assert.match(snap, /const _moralisHoldingsDisabled = process\.env\.MORALIS_HOLDINGS_DISABLED === '1'/, 'explicit Moralis holdings disable switch exists')
assert.match(snap, /!_moralisConfigured \? 'moralis_not_configured'\s*\n\s*: _moralisHoldingsDisabled \? 'moralis_holdings_disabled'/, 'moralis skip reason distinguishes not_configured from explicitly disabled')
assert.match(snap, /if \(_moralisConfigured && !_moralisHoldingsDisabled\) \{/, 'Moralis holdings call is gated on configured AND not explicitly disabled — no extra calls when disabled')

// 3. Selected provider is derived from what actually produced the holdings array, with moralis
// winning only when it actually ran and returned data — not merely because it is configured.
assert.match(snap, /const _selectedHoldingsProvider: 'moralis' \| 'zerion' \| 'goldrush' \| 'none' =\s*\n\s*_moralisUsed \? 'moralis'\s*\n\s*: _goldrushHoldingsUsed \? 'goldrush'\s*\n\s*: \(providerUsed === 'fallback_layer' && _zerionUsableForRouting && holdings\.length > 0\) \? 'zerion'\s*\n\s*: 'none'/, 'selectedProvider reflects the provider that actually supplied holdings, not just configuration')

// 4. The previously hardcoded _grPrimaryUsable = false bug (which made GoldRush-as-fallback always
// report unused even when it supplied the holdings) is fixed to reflect the real rescue outcome.
assert.ok(!/const _grPrimaryUsable = false/.test(snap), 'GoldRush primaryUsable is no longer hardcoded false')
assert.match(snap, /const _grPrimaryUsable = _goldrushHoldingsUsed/, 'GoldRush primaryUsable reflects whether the goldrush rescue actually populated holdings')

// 5. The goldrush-rescue path now also updates providerUsed, so providerUsed never silently stays
// 'none'/stale while holdings actually came from GoldRush.
assert.match(snap, /_goldrushHoldingsUsed = true\s*\n\s*\}\s*\n\s*\}\s*\n\s*const _grPrimaryUsable/, 'goldrush rescue sets _goldrushHoldingsUsed before primaryUsable is derived')
assert.match(snap, /providerUsed = 'fallback_layer'\s*\n\s*providerStatus = 'partial'\s*\n\s*reason = ''\s*\n\s*_goldrushHoldingsUsed = true/, 'goldrush rescue updates providerUsed to match the provider that actually supplied holdings')

// 6. ROUTE: providerUsed/portfolioSource are no longer blindly overwritten to fixed literal values on
// every non-debug response — the real selected-provider values from walletSnapshot.ts are preserved.
assert.ok(!/snapshot\.providerUsed = 'holdings_layer'/.test(route), 'route no longer force-overwrites providerUsed to holdings_layer regardless of actual provider')
assert.ok(!/snapshot\.portfolioSource = 'portfolio_layer'/.test(route), 'route no longer force-overwrites portfolioSource to portfolio_layer regardless of actual provider')

// 7. ROUTE: walletModuleCoverageRaw.portfolioProvider agrees with the actual selected provider instead
// of guessing purely from which providers are configured.
assert.match(route, /portfolioProvider: snapshot\._diagnostics\?\.walletHoldingsProviderRoutingDebug\?\.selectedProvider/, 'walletModuleCoverageRaw.portfolioProvider reads the real selected provider')

// 8. ROUTE: cached snapshots cannot keep a stale walletModuleCoverageRaw.portfolioProvider label that
// contradicts the provider actually selected when the snapshot was live-fetched.
assert.match(route, /function normalizeCachedFreshness\(cp: any\): any \{[\s\S]*_cachedSelected[\s\S]*portfolioProvider: _cachedSelected/, 'normalizeCachedFreshness re-aligns portfolioProvider with the cached selected provider')

// 9. No new provider calls were added for a normal scan — Moralis is still gated behind the same
// existing fetchMoralisBalances call, just with honest accounting around it; no new fetch/track call
// site was introduced for holdings.
assert.equal((snap.match(/fetchMoralisBalances\(/g) || []).length, 1, 'fetchMoralisBalances is still called from exactly one call site — no duplicate/new holdings calls added')
assert.equal((snap.match(/_trackCall\('moralis', 'erc20_holdings'/g) || []).length, 1, 'moralis erc20_holdings call tracking is not duplicated')

// 10. PnL/profit-skill/win-rate/public-lock logic is untouched by this pass.
assert.match(snap, /excludedFrom: \['profit_skill', 'wallet_score', 'official_win_rate'\]/, 'publicSamplePerformanceRead exclusions are unchanged')
assert.match(snap, /const _limitedVerifiedPublicSample = _performanceClosedLotsFinal\.length > 0 && _performanceClosedLotsFinal\.length < 10/, 'the 10-lot profit-skill threshold gate is unchanged')

console.log('wallet holdings provider routing checks passed')
