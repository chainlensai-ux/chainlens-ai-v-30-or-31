import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { classifyClarkPrompt, formatBaseMarketReadFromRows, formatNoFreshMarketData, formatNoPumpCandidates, toClarkUiActions, buildRoutedActions } from '../lib/server/clarkRouting.ts'

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
  /async function handleBasePumpMap[\s\S]{0,1200}fetch\(`\$\{origin\}\/api\/trending`/.test(routeSrc),
  'handleBasePumpMap reuses the same /api/trending source as the dashboard Token Screener',
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

console.log('clark base market routing checks passed')
