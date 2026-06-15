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
} from '../lib/server/clarkRouting.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── formatBaseMarketReadFromRows ────────────────────────────────────────────
const mockRows = [
  { symbol: 'AERO', name: 'Aerodrome', change24h: 5.2, volume24hUsd: 2_000_000, liquidityUsd: 1_000_000, priceUsd: 1.2, marketCapUsd: 100_000_000, poolAddress: '0xpoola', reasonTags: ['volume expansion'] },
  { symbol: 'BRETT', name: 'Brett', change24h: 12.4, volume24hUsd: 5_000_000, liquidityUsd: 2_500_000, priceUsd: 0.08, marketCapUsd: 400_000_000, poolAddress: '0xpoolb', reasonTags: ['volume spike', 'price move'] },
]
{
  const out = formatBaseMarketReadFromRows(mockRows)
  assert.ok(out, 'non-null for non-empty rows')
  assert.ok(out.startsWith('Here are the strongest Base movers'))
  assert.ok(out.includes('BRETT'))
  assert.ok(out.includes('Why:'))
  assert.ok(out.includes('Risk:'))
  assert.ok(out.includes('Want me to scan the top one in Token Scanner?'))
  assert.ok(out.includes('CTA:'))
}
assert.equal(formatBaseMarketReadFromRows([]), null)

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
  assert.ok(!routeFile.includes('const walletRes = await callInternalApi(origin, "/api/wallet", scanPayload'), 'routed Clark wallet execution must not use unauthenticated internal wallet API path')
  assert.ok(routeFile.includes('runWalletScanner'), 'Clark wallet execution should call the Wallet Scanner runner')
}


// ─── wallet scan formatting surfaces scanner modules ─────────────────────────
{
  const { formatWalletScanResult } = await import('../lib/server/clarkRouting.ts')
  const out = formatWalletScanResult(addr, {
    ok: true,
    totalValue: 1234,
    holdings: [{ symbol: 'DEGEN', value: 1000, chain: 'base' }],
    walletScanHealth: { status: 'limited_pnl', summary: 'Holdings were loaded, but closed lots/cost basis are incomplete.', lockedModules: ['fifoPnL', 'tradeStats'] },
    walletModuleCoverage: { portfolio: { status: 'ok' }, activity: { status: 'partial' }, fifoPnL: { status: 'locked_no_closed_lots' }, tradeStats: { status: 'locked_no_closed_lots' } },
    walletTokenPnlSummary: { status: 'partial', reason: 'cost_basis_limited' },
    walletTokenPnlRead: [{ symbol: 'DEGEN', status: 'cost_basis_only' }],
    historicalRecoveryStatus: 'not_started',
  }, false)
  assert.ok(out.includes('Portfolio found. PnL is limited'))
  assert.ok(out.includes('walletScanHealth'))
  assert.ok(out.includes('walletModuleCoverage'))
  assert.ok(out.includes('Token-level read'))
  assert.ok(out.includes('Locked modules'))
}

// ─── buildRoutedActions ──────────────────────────────────────────────────────
{
  const out = buildRoutedActions(['Scan Wallet', 'Scan Wallet', 'Bogus Action'])
  assert.deepEqual(out, ['Scan Wallet'])
}

console.log('test-clark-execution.mjs: all assertions passed')
