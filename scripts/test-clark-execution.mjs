import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatBaseMarketReadFromRows,
  buildWalletApiRequestBody,
  formatEoaLpCheckReply,
  formatLpReadResult,
  formatCouldNotComplete,
  buildRoutedActions,
  rankBaseMarketRows,
} from '../lib/server/clarkRouting.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── formatBaseMarketReadFromRows ────────────────────────────────────────────
const mockRows = [
  { symbol: 'AERO', name: 'Aerodrome', change24h: 5.2, volume24hUsd: 2_000_000, liquidityUsd: 1_500_000, priceUsd: 1.2, marketCapUsd: 100_000_000, tokenAddress: '0xaero', poolAddress: '0xaeropool', reasonTags: ['liquid mover'] },
  { symbol: 'BRETT', name: 'Brett', change24h: 12.4, volume24hUsd: 5_000_000, liquidityUsd: 2_000_000, priceUsd: 0.08, marketCapUsd: 400_000_000, tokenAddress: '0xbrett', poolAddress: '0xbrettpool', reasonTags: ['volume expansion'] },
]
{
  const out = formatBaseMarketReadFromRows(mockRows)
  assert.ok(out, 'non-null for non-empty rows')
  assert.ok(out.startsWith('Here are the strongest Base movers I found right now:'))
  assert.ok(out.includes('CTA:'))
  // ─── product wording: "movers" not "confirmed pumps" ─────────────────────
  assert.ok(out.toLowerCase().includes('movers'))
  assert.ok(!out.toLowerCase().includes('confirmed pump'))
  assert.ok(!out.toLowerCase().includes('confirmed manipulation'))
  // ─── scan-by-rank prompts surfaced ─────────────────────────────────────────
  assert.ok(out.includes('Say "scan #1" to run Token Scanner.'))
  assert.ok(out.includes('Say "scan #2" to run Token Scanner.'))
}
assert.equal(formatBaseMarketReadFromRows([]), null)
assert.equal(formatBaseMarketReadFromRows(null), null)

// ─── buildWalletApiRequestBody ───────────────────────────────────────────────
const addr = '0x1234567890123456789012345678901234567890'
assert.deepEqual(buildWalletApiRequestBody(addr, false), {
  address: addr,
  walletAddress: addr,
  chain: 'auto',
  deepScan: false,
  debug: false,
  source: 'clark',
})
assert.deepEqual(buildWalletApiRequestBody(addr, true), {
  address: addr,
  walletAddress: addr,
  chain: 'auto',
  chainMode: 'all_supported',
  deepScan: true,
  debug: false,
  source: 'clark',
})

// ─── formatEoaLpCheckReply ────────────────────────────────────────────────────
{
  const out = formatEoaLpCheckReply()
  assert.ok(out.includes('Scan Wallet'))
  assert.ok(out.includes('wallet, not a token contract'))
}

// ─── formatLpReadResult ───────────────────────────────────────────────────────
{
  const mockResult = {
    token: { name: 'Brett', symbol: 'BRETT' },
    primaryPool: '0xpool',
    poolModel: 'Uniswap V2',
    lockBurnProof: 'Locked via UNCX',
    controllerVerification: 'Verified renounced',
    liquidityDepth: '$1.2M',
    exitRisk: 'Low',
    missingEvidence: [],
  }
  const out = formatLpReadResult(mockResult)
  assert.ok(out.startsWith('LP READ'))
  for (const field of ['Token:', 'Primary pool', 'Pool model:', 'Lock/burn proof:', 'Controller', 'Liquidity depth:', 'Exit risk:', 'Missing evidence:']) {
    assert.ok(out.includes(field), `missing field: ${field}`)
  }
}
{
  const out = formatLpReadResult(null)
  assert.ok(out.startsWith('LP READ — could not complete'))
}

// ─── formatCouldNotComplete ──────────────────────────────────────────────────
{
  const out = formatCouldNotComplete({
    intentBadge: 'base_radar',
    attempted: ['Base Radar feed'],
    reason: 'radar snapshot returned no candidates',
    actions: buildRoutedActions(['Open Base Radar', 'Refresh Market Data']),
  })
  assert.ok(out.includes('COULD NOT COMPLETE'))
  assert.ok(out.includes('base_radar'))
  assert.ok(out.includes('radar snapshot returned no candidates'))
  assert.ok(out.includes('CTA:'))
}

// ─── hard-requirement removal: "No data available right now" must not appear ──
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
  assert.ok(!routeFile.includes('No data available right now'), 'stale fallback string must be removed')

  // ─── base_market_discovery: movers saved to session memory ────────────────
  const baseMarketBlockIdx = routeFile.indexOf('routed.intent === "base_market_discovery"')
  assert.ok(baseMarketBlockIdx >= 0, 'base_market_discovery route block must exist')
  const baseMarketBlock = routeFile.slice(baseMarketBlockIdx, baseMarketBlockIdx + 6000)
  assert.ok(baseMarketBlock.includes('updateMemMomentum'), 'base movers must be saved via updateMemMomentum')
  assert.ok(baseMarketBlock.includes('rankBaseMarketRows'), 'movers must be ranked via rankBaseMarketRows')

  // ─── honest empty/timeout wording ──────────────────────────────────────────
  assert.ok(routeFile.includes('No live Base mover data is available right now.'))
  assert.ok(routeFile.includes('Base mover data source timed out. Try again shortly.'))
  assert.ok(!routeFile.includes('No tokens are moving.'))
}

// ─── rankBaseMarketRows ───────────────────────────────────────────────────────
{
  const ranked = rankBaseMarketRows(mockRows, 5)
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].symbol, 'BRETT') // higher change/volume/liquidity wins
  assert.deepEqual(rankBaseMarketRows([]), [])
  assert.deepEqual(rankBaseMarketRows(null), [])
}

// ─── buildRoutedActions ──────────────────────────────────────────────────────
{
  const out = buildRoutedActions(['Scan Wallet', 'Scan Wallet', 'Bogus Action'])
  assert.deepEqual(out, ['Scan Wallet'])
}

console.log('test-clark-execution.mjs: all assertions passed')
