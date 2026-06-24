import assert from 'node:assert/strict'
import { classifyClarkPrompt, formatBaseMarketReadFromRows, formatNoFreshMarketData, toClarkUiActions, buildRoutedActions } from '../lib/server/clarkRouting.ts'

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

console.log('clark base market routing checks passed')
