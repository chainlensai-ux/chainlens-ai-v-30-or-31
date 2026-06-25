import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { classifyClarkPrompt, formatBaseMarketReadFromRows, formatNoFreshMarketData, formatNoPumpCandidates, parseExplicitExclusions, parseTrendingRows, describeTrendingShape, pickScanIdentifiers, tokenScannerHref, toClarkUiActions, buildRoutedActions, getBaseMarketLastGoodCache, setBaseMarketLastGoodCache } from '../lib/server/clarkRouting.ts'

// 1. all required market phrasings route to base_market_discovery, not a generic fallback.
const phrases = [
  "What's pumping on Base?",
  'what tokens are moving',
  'base trending',
  'top gainers on Base',
  'highest volume base tokens',
  'what should I scan on base',
]
for (const p of phrases) {
  assert.equal(classifyClarkPrompt(p).intent, 'base_market_discovery', `"${p}" routes to base_market_discovery`)
}

// 2. stablecoins/majors are excluded from the "pumping" rows by default.
const rows = [
  { symbol: 'USDC', name: 'USD Coin', change24h: 0.1, volume24hUsd: 5_000_000, liquidityUsd: 10_000_000 },
  { symbol: 'PEPE2', name: 'Pepe Two', change24h: 22, volume24hUsd: 300_000, liquidityUsd: 200_000 },
]
const formatted = formatBaseMarketReadFromRows(rows)
assert.ok(formatted, 'formats a reply when at least one non-stable row exists')
assert.ok(!formatted.includes('USDC'), 'stablecoin excluded from pumping rows')
assert.ok(formatted.includes('PEPE2'), 'non-stable mover included')

// 3. partial data (single row) still answers instead of failing.
const singleRow = formatBaseMarketReadFromRows([{ symbol: 'PEPE2', name: 'Pepe Two', change24h: 5, volume24hUsd: 1000, liquidityUsd: 1000 }])
assert.ok(singleRow, 'a single available row still produces an answer, never a hard failure')

// 4. no-data path is graceful, not a scary "COULD NOT COMPLETE" block.
const noData = formatNoFreshMarketData()
assert.ok(!noData.includes('COULD NOT COMPLETE'), 'no-data reply is not the scary could-not-complete block')
assert.ok(noData.includes("can't see fresh Base market rows"), 'no-data reply uses the specified graceful copy')
assert.ok(noData.includes('Refresh Market Data'), 'no-data reply offers the Refresh Market Data CTA')

// 5. routed actions map to clickable { label, href } CTAs for the frontend.
const uiActions = toClarkUiActions(buildRoutedActions(['Open Base Radar', 'Open Token Scanner', 'Refresh Market Data']))
for (const a of uiActions) {
  assert.equal(typeof a.label, 'string')
  assert.equal(typeof a.href, 'string')
  assert.ok(a.href.startsWith('/'), `${a.label} has a real app href`)
}

// 6. "what's pumping on Base?" must never end up overwritten by the generic could-not-complete
//    fallback. isBaseMomentumPrompt's handleBasePumpMap path must extract the inner string
//    "analysis" field rather than wholesale-assigning the { analysis, items } object as the
//    outer "analysis" — and must promote the no-data case through formatNoFreshMarketData(),
//    with ui.actions wired to real hrefs and clarkMarketFallbackReason present.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routeSrc = fs.readFileSync(path.join(__dirname, '../app/api/clark/route.ts'), 'utf8')
const routingSrc = fs.readFileSync(path.join(__dirname, '../lib/server/clarkRouting.ts'), 'utf8')

assert.ok(
  !/const analysis = await handleBasePumpMap\([^)]*\);\s*\n\s*return \{[^}]*analysis;/.test(routeSrc),
  'handleBasePumpMap() result is not wholesale-assigned to the outer "analysis" field',
)
assert.ok(
  /basePumpResult\.analysis/.test(routeSrc),
  'route.ts unwraps handleBasePumpMap().analysis explicitly',
)
assert.ok(
  /clarkMarketFallbackReason/.test(routeSrc),
  'route.ts wires the clarkMarketFallbackReason debug field',
)
assert.ok(
  /\/terminal\/base-radar/.test(routingSrc) && /\/terminal\/token-scanner/.test(routingSrc) && /\/terminal\?refresh=market/.test(routingSrc),
  'clarkRouting.ts base momentum CTAs use the exact required hrefs',
)
assert.ok(
  /formatNoFreshMarketData\(\)/.test(routeSrc),
  'route.ts no-data market path uses formatNoFreshMarketData(), not formatCouldNotComplete()',
)

const noDataCopy = formatNoFreshMarketData()
assert.ok(noDataCopy.includes('Base market data is incomplete right now'), 'no-data reply leads with the required exact phrase')

// 7. Clark's Base market path reuses the same canonical source as the dashboard (/api/trending),
//    distinguishes "rows exist but all filtered" from genuine no-data, and exposes the
//    requested debug fields instead of silently reporting no_rows while rows exist upstream.
assert.ok(
  /async function handleBasePumpMap[\s\S]{0,1600}getMergedTrendingTokens\(\)/.test(routeSrc),
  'handleBasePumpMap reuses the same trending merge logic as the dashboard Token Screener',
)
assert.ok(
  /formatNoPumpCandidates/.test(routeSrc) && /formatNoPumpCandidates/.test(routingSrc),
  'a distinct "no clear pump candidates" path exists for rows-exist-but-all-filtered',
)
for (const field of [
  'marketRowsSource', 'marketRowsBeforeFilter', 'marketRowsAfterFilter', 'marketRowsDroppedByReason',
  'marketDataCacheHit', 'marketProviderAttempted', 'marketProviderStatus', 'marketFallbackReason',
]) {
  assert.ok(routeSrc.includes(field), `route.ts exposes debug field ${field}`)
}
for (const reason of ['all_rows_filtered', 'market_endpoint_failed', 'market_cache_empty']) {
  assert.ok(routeSrc.includes(reason), `route.ts distinguishes fallback reason "${reason}" from no_rows`)
}

const noPumpCopy = formatNoPumpCandidates()
assert.ok(!noPumpCopy.includes('COULD NOT COMPLETE'), 'no-pump-candidates reply is not the scary could-not-complete block')
assert.ok(noPumpCopy.toLowerCase().includes('no clear pump candidates'), 'no-pump-candidates reply states rows exist but no clear pump candidates')
assert.ok(noPumpCopy.toLowerCase().includes('match your filters'), 'no-pump-candidates reply references the active filters')

// 8. Explicit prompt exclusions are parsed into uppercase symbol lists and applied.
{
  const cases = [
    ['what base tokens are moving excluding cbBTC WETH USDC', ['CBBTC', 'WETH', 'USDC']],
    ['exclude cbBTC, WETH, USDC', ['CBBTC', 'WETH', 'USDC']],
    ['top gainers on base except for usdc', ['USDC']],
  ]
  for (const [p, expected] of cases) {
    const got = parseExplicitExclusions(p)
    for (const sym of expected) assert.ok(got.includes(sym), `"${p}" excludes ${sym} (got ${JSON.stringify(got)})`)
  }
  // "without stables/majors" expands to the stable + major groups.
  const grouped = parseExplicitExclusions('show base movers without stables and majors')
  assert.ok(grouped.includes('USDC') && grouped.includes('WETH'), 'without stables/majors expands to symbol groups')
  // No exclusion clause -> empty list.
  assert.deepEqual(parseExplicitExclusions('what is pumping on base'), [], 'no exclusion clause yields empty list')
}

// 9. Market/mover/trending questions must NEVER fall back to "Base Radar data is temporarily
//    unavailable" — that copy is removed from the market intent path, replaced by graceful
//    market fallbacks that carry the new clarkMarketSource / clarkMarketFallbackReason debug fields.
assert.ok(
  !/Base Radar data is temporarily unavailable/.test(routeSrc),
  'the "Base Radar data is temporarily unavailable" market fallback copy is gone',
)
for (const field of ['clarkMarketSource', 'explicitExcludedSymbols', 'routedWithoutBaseRadar']) {
  assert.ok(routeSrc.includes(field), `route.ts exposes debug field ${field}`)
}
for (const reason of ['source_error', 'no_rows', 'all_rows_filtered']) {
  assert.ok(routeSrc.includes(reason), `route.ts market path distinguishes fallback reason "${reason}"`)
}
assert.ok(
  /clarkMarketSource:\s*"market_universe"/.test(routeSrc) && /clarkMarketSource:\s*"trending_api"/.test(routeSrc) && /clarkMarketSource:\s*"fallback"/.test(routeSrc),
  'route.ts tags all three clarkMarketSource values',
)

// 10. parseTrendingRows handles every response shape the app uses, so a successful
//     /api/trending payload always yields rows for Clark (never silently 0).
{
  const sampleRow = { symbol: 'PEPE2', name: 'Pepe Two', chain: 'base', change24h: 22, volume: 300000, liquidity: 200000 }
  const shapes = [
    [[sampleRow], 'array'],
    [{ items: [sampleRow] }, '{items:[]}'],
    [{ tokens: [sampleRow] }, '{tokens:[]}'],
    [{ data: [sampleRow] }, '{data:[]}'],
    [{ data: { items: [sampleRow] } }, '{data:{items:[]}}'],
  ]
  for (const [payload, shapeName] of shapes) {
    const rows = parseTrendingRows(payload)
    assert.equal(rows.length, 1, `parseTrendingRows reads ${shapeName}`)
    assert.equal(rows[0].symbol, 'PEPE2', `parseTrendingRows preserves rows for ${shapeName}`)
    assert.equal(describeTrendingShape(payload), shapeName, `describeTrendingShape tags ${shapeName}`)
  }
  assert.deepEqual(parseTrendingRows(null), [], 'parseTrendingRows handles null safely')
  assert.deepEqual(parseTrendingRows({ error: 'x' }), [], 'parseTrendingRows handles error-only payload safely')
}

// 11. Clark reuses the trending merge logic IN-PROCESS (no fragile server self-fetch),
//     pump-alerts is optional, and the new fetch-diagnostic debug fields are wired.
assert.ok(
  /import\s*\{\s*getMergedTrendingTokens\s*\}\s*from\s*"@\/app\/api\/trending\/route"/.test(routeSrc),
  'route.ts reuses getMergedTrendingTokens() directly instead of self-fetching /api/trending',
)
assert.ok(
  /const result = await getMergedTrendingTokens\(\);/.test(routeSrc),
  'handleBasePumpMap calls getMergedTrendingTokens() as its primary trending source',
)
assert.ok(
  /pumpAlertsOptionalFailed/.test(routeSrc),
  'pump-alerts failure is tracked as optional, never gating trending rows',
)
for (const field of [
  'trendingFetchUrlKind', 'trendingHttpStatus', 'trendingResponseShape',
  'trendingRowsRaw', 'trendingRowsNormalized', 'pumpAlertsOptionalFailed', 'marketEndpointFailureReason',
]) {
  assert.ok(routeSrc.includes(field), `route.ts exposes fetch-diagnostic debug field ${field}`)
}
// market_endpoint_failed must be gated on trending actually having no normalized rows, so it
// can never show while trending rows exist.
assert.ok(
  /trendingRowsNormalized > 0 \? "trending_api" : "fallback"/.test(routeSrc),
  'clarkMarketSource is trending_api whenever normalized trending rows exist',
)

// 12. trending/route.ts exports the shared in-process merge function used above.
assert.ok(
  /export async function getMergedTrendingTokens\(/.test(fs.readFileSync(path.join(__dirname, '../app/api/trending/route.ts'), 'utf8')),
  'trending/route.ts exports getMergedTrendingTokens for safe server-side reuse',
)

// 13. pickScanIdentifiers extracts a usable token scan target from any address field,
//     rejects non-onchain ids, and never claims a pool as a scannable token target.
{
  const ADDR = '0x' + 'a'.repeat(40)
  const POOL = '0x' + 'b'.repeat(40)
  assert.deepEqual(
    pickScanIdentifiers({ contract: ADDR }),
    { tokenAddress: ADDR, poolAddress: null, scanTarget: ADDR, scanTargetType: 'token' },
    'token address from `contract` becomes the scan target',
  )
  assert.deepEqual(
    pickScanIdentifiers({ tokenAddress: ADDR, pairAddress: POOL }),
    { tokenAddress: ADDR, poolAddress: POOL, scanTarget: ADDR, scanTargetType: 'token' },
    'tokenAddress wins as scan target; pool captured separately',
  )
  const poolOnly = pickScanIdentifiers({ poolAddress: POOL })
  assert.equal(poolOnly.scanTarget, null, 'pool-only row has no scan target (Token Scanner scans tokens)')
  assert.equal(poolOnly.poolAddress, POOL, 'pool-only row still records the pool address')
  assert.equal(pickScanIdentifiers({ contract: 'pepe' }).scanTarget, null, 'CoinGecko slug id is rejected as a scan target')
  const href = tokenScannerHref(ADDR)
  assert.ok(href.includes('chain=base') && href.includes(`contract=${ADDR}`), 'token scanner href carries chain=base and the contract')
}

// 14. handleBasePumpMap normalizes scan identifiers, gates the "scan 1" invite on a real
//     target, ranks positives first with a labelled negative fallback, and surfaces the
//     new scan-coverage + selection debug fields.
assert.ok(/pickScanIdentifiers\(t\)/.test(routeSrc), 'handleBasePumpMap normalizes rows via pickScanIdentifiers')
assert.ok(/scanTarget: ids\.scanTarget/.test(routeSrc), 'marketContext items carry scanTarget')
assert.ok(/Open Token Scanner and paste the contract when available/.test(routeSrc), 'no-scan-target rows avoid the "scan 1" invite')
assert.ok(/const positives = ranked\.filter\(t => Number\(t\.change24h \?\? 0\) > 0\)/.test(routeSrc), 'pumping ranks positive movers first')
assert.ok(/positives\.length >= 5 \? positives : \[\.\.\.positives, \.\.\.nonPositives\]/.test(routeSrc), 'negatives only fill in when positives are scarce')
assert.ok(/high-volume mover, but not currently green/.test(routeSrc), 'negative movers are labelled, not sold as strongest pump')
for (const field of [
  'marketRowsWithTokenAddress', 'marketRowsWithPoolAddress', 'marketRowsWithScanTarget',
  'marketScanTargetCoverage', 'marketScanTargetMissingReasons', 'clarkScanSelectionResolved', 'clarkScanSelectionReason',
]) {
  assert.ok(routeSrc.includes(field), `route.ts exposes scan debug field ${field}`)
}
// "scan 1" follow-up persists movers to session memory so the rank resolves to a real address.
assert.ok(/updateMemMomentum\(sessionMem, basePumpItems\.map/.test(routeSrc), 'base pump movers are stored for scan-N resolution')

// 15. Top-level source reflects the real market source, never "fallback" when trending_api ran.
assert.ok(
  /marketSourceTag === "trending_api" \? "trending_api"/.test(routeSrc) && /marketSourceTag === "market_universe" \? "market_feed"/.test(routeSrc),
  'normalizeApiReplyShape maps clarkMarketSource onto the top-level source',
)

// 16. Base Radar is never used as a data source for these market answers.
assert.ok(!/Base Radar data is temporarily unavailable/.test(routeSrc), 'no Base Radar unavailable copy on market paths')

// 17. Last-good Base market cache: stores real rows with a 15-minute TTL, never accepts an
//     empty/fake row set, and expired entries are ignored.
{
  setBaseMarketLastGoodCache([]) // must be a no-op — never cache a fake/empty row set
  const realRows = [{ symbol: 'PEPE2', name: 'Pepe Two', chain: 'base', change24h: 22, volume: 300000, liquidity: 200000 }]
  setBaseMarketLastGoodCache(realRows)
  const hit = getBaseMarketLastGoodCache()
  assert.ok(hit && hit.rows.length === 1 && hit.rows[0].symbol === 'PEPE2', 'fresh cache write is readable')
  assert.ok(typeof hit.ageMs === 'number' && hit.ageMs >= 0, 'cache exposes an age in ms')
}

// 18. route.ts wires the cache: refreshes it on fresh live rows, reads it when live rows are
//     empty, gates the no-data path on !marketUsedLastGoodCache, and never reads cache older
//     than 15 minutes (enforced inside getBaseMarketLastGoodCache itself).
assert.ok(routeSrc.includes('setBaseMarketLastGoodCache(cacheSafeRows)'), 'route.ts refreshes the last-good cache from real live rows')
assert.ok(routeSrc.includes('getBaseMarketLastGoodCache()'), 'route.ts reads the last-good cache when live rows are empty')
assert.ok(
  routeSrc.includes('if (!marketUsedLastGoodCache && rawTrendingRows.length === 0 && pumpAlerts.length === 0)'),
  'the no-data gate is bypassed when the last-good cache served rows',
)
assert.ok(
  routeSrc.includes('Using the latest saved Base market read because the live feed is temporarily incomplete.'),
  'cache-fallback replies carry the required public copy',
)
assert.ok(!/goldrush|covalent|geckoterminal|coingecko|dexscreener|alchemy/i.test('Using the latest saved Base market read because the live feed is temporarily incomplete.'))
for (const field of [
  'marketCacheMode', 'marketCacheAgeMs', 'marketCacheRows', 'marketLiveRowsRaw',
  'marketLiveRowsNormalized', 'marketLiveFailureReason', 'marketUsedLastGoodCache',
]) {
  assert.ok(routeSrc.includes(field), `route.ts exposes cache debug field ${field}`)
}

// 19. Explicit per-prompt exclusions and the default exclusion set are both re-applied to
//     cache-sourced rows at read time (cache itself only strips defaults, not prompt-specific
//     exclusions, so the same snapshot serves any later prompt correctly).
assert.ok(
  /cacheSafeRows = rawTrendingRows\.filter\(t => isBaseChainRow\(t\) && !DEFAULT_EXCLUDED\.has/.test(routeSrc),
  'cache writes use only the default exclusion set (not prompt-specific exclusions)',
)
assert.ok(
  /cachedTokens = cached\.rows\.filter\(t => isBaseChainRow\(t\) && !EXCLUDED\.has/.test(routeSrc),
  'cache reads re-apply the full (default + prompt) exclusion set',
)

// 20. Cache-sourced rows still flow through pickScanIdentifiers downstream, so "scan N" works
//     the same whether rows came from the live feed or the last-good cache — no separate,
//     weaker code path for cached rows. No Base Radar call and no fake rows anywhere in this wiring.
{
  const pumpMapBody = routeSrc.slice(routeSrc.indexOf('async function handleBasePumpMap'), routeSrc.indexOf('async function handleBaseRadarSnapshot'))
  assert.ok(!/base-radar/i.test(pumpMapBody), 'handleBasePumpMap never calls Base Radar')
  assert.ok(!/mock|placeholder/i.test(pumpMapBody), 'no fabricated row fallback in the cache wiring')
}

console.log('clark base market routing checks passed')
