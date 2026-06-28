import fs from 'node:fs'
import assert from 'node:assert/strict'

const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// --- A) Fast cache-hit early return ---

// recoverHistoricalFromCachedPayload must no longer make a live fetchWalletSnapshot call on a
// route-level cache hit — it must only annotate quality/status cheaply and return synchronously.
assert.doesNotMatch(
  route,
  /const recoverHistoricalFromCachedPayload[\s\S]{0,400}fetchWalletSnapshot\(/,
  'recoverHistoricalFromCachedPayload must not call fetchWalletSnapshot live on a cache hit',
)
assert.match(route, /const recoverHistoricalFromCachedPayload = \(cachedPayload: any, cacheAgeSeconds: number, _cacheBackend: 'memory' \| 'persistent'\) => \{/, 'recoverHistoricalFromCachedPayload is synchronous (no async/await live recovery)')

// Both cache-hit branches (memory + persistent) call it without await and surface the new debug fields.
const memoryCacheHitBlock = route.slice(route.indexOf('if (cached && cached.exp > Date.now())'), route.indexOf('// Blocked by cooldown'))
assert.match(memoryCacheHitBlock, /cp = recoverHistoricalFromCachedPayload\(cp, cacheAgeSeconds, 'memory'\)/, 'memory cache-hit branch calls recoverHistoricalFromCachedPayload synchronously')
assert.match(memoryCacheHitBlock, /cacheHitEarlyReturn: true,/, 'memory cache-hit branch reports cacheHitEarlyReturn: true')
assert.match(memoryCacheHitBlock, /postCacheDecorationMs: _postCacheDecorationMs,/, 'memory cache-hit branch reports postCacheDecorationMs')
assert.match(memoryCacheHitBlock, /providerCallsSkippedBecauseCacheHit: _providerCallsSkippedBecauseCacheHit,/, 'memory cache-hit branch reports providerCallsSkippedBecauseCacheHit')

const persistentCacheHitBlock = route.slice(route.indexOf("if (persCache) {"), route.indexOf('// --- Persistent cooldown check'))
assert.match(persistentCacheHitBlock, /cp = recoverHistoricalFromCachedPayload\(cp, cacheAgeSeconds, 'persistent'\)/, 'persistent cache-hit branch calls recoverHistoricalFromCachedPayload synchronously')
assert.match(persistentCacheHitBlock, /cacheHitEarlyReturn: true,/, 'persistent cache-hit branch reports cacheHitEarlyReturn: true')
assert.match(persistentCacheHitBlock, /postCacheDecorationMs: _postCacheDecorationMs,/, 'persistent cache-hit branch reports postCacheDecorationMs')
assert.match(persistentCacheHitBlock, /providerCallsSkippedBecauseCacheHit: _providerCallsSkippedBecauseCacheHit,/, 'persistent cache-hit branch reports providerCallsSkippedBecauseCacheHit')

// Both cache-hit branches still report providerCalls: [] / providerFetchNeeded: false (existing semantics preserved).
assert.match(memoryCacheHitBlock, /providerFetchNeeded: false/, 'memory cache-hit keeps providerFetchNeeded: false')
assert.match(memoryCacheHitBlock, /providerCalls: \[\],/, 'memory cache-hit keeps providerCalls: []')
assert.match(persistentCacheHitBlock, /providerFetchNeeded: false/, 'persistent cache-hit keeps providerFetchNeeded: false')
assert.match(persistentCacheHitBlock, /providerCalls: \[\],/, 'persistent cache-hit keeps providerCalls: []')

// --- B) Provider PnL Summary gate ---

// Eligibility now requires deepScan/deepActivity to have been requested — basic scans can never
// reach the live fetchMoralisProfitabilitySummary call regardless of value/debug.
assert.match(
  snap,
  /const _providerProfitDeepActivityRequested = Boolean\(deepScan \|\| deepActivity\)\s*\n\s*const _providerProfitEligible = _providerProfitDeepActivityRequested && _providerProfitFifoFoundNoLots && \(totalValue >= 1000 \|\| debug \|\| deepScan\) && _providerProfitBudgetOk/,
  'Provider PnL Summary eligibility requires deepScan/deepActivity to have been requested',
)

// Basic-scan skip path reports the required debug fields and downgrades the public summary status.
assert.match(snap, /skippedReason: !_providerProfitDeepActivityRequested\s*\n\s*\? 'basic_scan_deep_activity_required'/, 'walletMoralisProfitabilityDebug.skippedReason reports basic_scan_deep_activity_required')
assert.match(snap, /providerPnlSkippedReason: !_providerProfitDeepActivityRequested \? 'basic_scan_deep_activity_required' : null,/, 'walletMoralisProfitabilityDebug exposes providerPnlSkippedReason')
assert.match(snap, /providerPnlLiveCallBlockedInBasic: !_providerProfitDeepActivityRequested,/, 'walletMoralisProfitabilityDebug exposes providerPnlLiveCallBlockedInBasic on the skip path')
assert.match(snap, /if \(!_providerProfitDeepActivityRequested\) \{\s*\n\s*;\(snapshot as any\)\.walletProviderPnlSummary\.status = 'not_requested'\s*\n\s*;\(snapshot as any\)\.walletProviderPnlSummary\.skippedReason = 'deep_activity_required'/, 'walletProviderPnlSummary.status is forced to not_requested with skippedReason deep_activity_required for a basic scan')

// The eligible (deep-scan) path still exposes the cache-reuse debug field without blocking live calls.
assert.match(snap, /providerPnlLiveCallBlockedInBasic: false,\s*\n\s*providerPnlReusedFromCache: Boolean\(_profitRes\?\.cacheHit\),/, 'walletMoralisProfitabilityDebug exposes providerPnlReusedFromCache on the eligible path')

console.log('wallet cache fast-path and provider PnL basic-scan gate checks passed')
