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
  formatWalletCompareUnsupported,
  pickTopHoldingsByValue,
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
  assert.ok(out.includes('Module status'), 'locked modules surfaced as honest Module status')
}

// ─── buildRoutedActions ──────────────────────────────────────────────────────
{
  const out = buildRoutedActions(['Scan Wallet', 'Scan Wallet', 'Bogus Action'])
  assert.deepEqual(out, ['Scan Wallet'])
}

// ─── top holdings by value (no $0 dust) ───────────────────────────────────────
{
  const holdings = [
    { symbol: 'mUSDC', value: 0, chain: 'base' },
    { symbol: 'APE', value: 0, chain: 'base' },
    { symbol: 'FTM', value: 0, chain: 'base' },
    { symbol: 'WETH', value: 372_000, chain: 'base' },
    { symbol: 'DEGEN', value: 500, chain: 'base' },
  ]
  const top = pickTopHoldingsByValue(holdings, 5)
  assert.equal(top.length, 2, 'dust filtered out')
  assert.equal(top[0].symbol, 'WETH', 'highest value first')
  assert.equal(top[1].symbol, 'DEGEN')
}
{
  // formatWalletScanResult must surface the meaningful holding, not $0 dust
  const { formatWalletScanResult } = await import('../lib/server/clarkRouting.ts')
  const out = formatWalletScanResult(addr, {
    ok: true,
    totalValue: 372_700,
    holdings: [
      { symbol: 'mUSDC', value: 0, chain: 'base' },
      { symbol: 'APE', value: 0, chain: 'base' },
      { symbol: 'WETH', value: 372_700, chain: 'base' },
    ],
    walletScanHealth: { status: 'limited_pnl', summary: 'Holdings loaded, closed lots incomplete.', lockedModules: ['fifoPnL'] },
    walletModuleCoverage: { portfolio: { status: 'ok' }, activity: { status: 'open_check' }, fifoPnL: { status: 'locked_no_closed_lots', reason: 'no_closed_lots' }, tradeStats: { status: 'locked_no_closed_lots' } },
    walletTokenPnlSummary: { status: 'partial', reason: 'cost_basis_limited' },
    historicalRecoveryStatus: 'partial',
    dataFreshness: 'live',
  }, false)
  assert.ok(out.includes('WETH'), 'top holding by value shown')
  assert.ok(!/mUSDC \(\$0\)|APE \(\$0\)/.test(out), 'no $0 dust listed as top holdings')
  assert.ok(!out.includes('PnL coverage: not requested'), 'must not say PnL not requested after a scan')
  assert.ok(!out.includes('Activity status: not requested'), 'must not say activity not requested')
  assert.ok(out.toLowerCase().includes('attempted: limited'), 'PnL labelled as attempted: limited')
}

// ─── PnL never "not requested" for deep scan either ──────────────────────────
{
  const { formatWalletScanResult } = await import('../lib/server/clarkRouting.ts')
  const out = formatWalletScanResult(addr, {
    ok: true,
    totalValue: 1_000,
    holdings: [{ symbol: 'WETH', value: 1_000, chain: 'base' }],
    walletScanHealth: { status: 'limited_pnl', lockedModules: ['fifoPnL', 'tradeStats'] },
    walletModuleCoverage: { portfolio: { status: 'ok' }, activity: { status: 'open_check' }, fifoPnL: { status: 'locked_no_closed_lots', reason: 'no_closed_lots' }, tradeStats: { status: 'locked_no_closed_lots' } },
    walletTokenPnlSummary: { status: 'partial', reason: 'cost_basis_limited' },
    walletHistoricalCoverageSummary: { status: 'partial' },
  }, true)
  assert.ok(!out.includes('not requested'), 'deep scan must not produce "not requested" anywhere')
  assert.ok(out.includes('WETH'), 'meaningful holding shown')
}

// ─── cached portfolio preview labelling (API/debug truth) ─────────────────────
{
  const { formatWalletScanResult } = await import('../lib/server/clarkRouting.ts')
  const out = formatWalletScanResult(addr, {
    ok: true,
    totalValue: 1_000,
    holdings: [{ symbol: 'WETH', value: 1_000, chain: 'base' }],
    walletScanHealth: { status: 'cached', lockedModules: ['fifoPnL'] },
    walletModuleCoverage: { portfolio: { status: 'ok' }, fifoPnL: { status: 'locked_no_closed_lots' } },
    dataFreshness: 'cached',
    cacheAgeSeconds: 120,
  }, false)
  assert.ok(out.includes('cached portfolio preview'), 'cached preview labelled honestly')
}

// ─── wallet compare unsupported: names both addresses, scans neither ──────────
{
  const fakeLink = (a, d) => `/w/${a}?deep=${d ? 1 : 0}`
  const out = formatWalletCompareUnsupported({ addressA: addr, addressB: '0x79abcdefabcdefabcdefabcdefabcdefabcdefabcd', walletScannerDeepLink: fakeLink })
  assert.ok(out.includes('not fully wired yet'))
  assert.ok(out.toLowerCase().includes(addr.toLowerCase()))
  assert.ok(out.includes('0x79abcdefabcdefabcdefabcdefabcdefabcdefabcd'))
  assert.ok(!/WALLET READ/i.test(out), 'must not present a one-sided scan as a compare')
}

// ─── Pack 1: formatTokenScanResult ───────────────────────────────────────────
{
  const { formatTokenScanResult, formatTokenSafetyAnswer, formatDevRugCheck, formatLpLockCheck, formatRiskExplanation, formatNoTokenInMemory } = await import('../lib/server/clarkRouting.ts')
  const ev = {
    token: { name: 'Brett', symbol: 'BRETT', address: '0xabcdef1234567890abcdef1234567890abcdef12' },
    chain: 'Base',
    market: { price: 0.08, change24h: 12.4, volume24h: 5_000_000, liquidity: 2_000_000, marketCap: 400_000_000 },
    holders: { top1: 8.2, top10: 42.1, holderCount: 12000 },
    security: { honeypot: false, buyTax: 0, sellTax: 0, ownerRenounced: true, mintable: false, proxy: false, securityStatus: 'clean', riskLevel: 'low', missing: [] },
    lpControl: { status: 'locked', reason: 'locked via protocol', confidence: 'high', poolType: 'v2' },
    warnings: [],
    ok: true,
  }

  // TOKEN_SCAN output
  {
    const out = formatTokenScanResult(ev)
    assert.ok(out.startsWith('TOKEN READ'), 'starts with TOKEN READ')
    assert.ok(out.includes('BRETT'))
    assert.ok(out.includes('LP proof'), 'LP status surfaced')
    assert.ok(out.includes('Verdict:'), 'verdict present')
    assert.ok(out.includes('CTA:'), 'CTA present')
    assert.ok(!out.toLowerCase().includes('confirmed safe'), 'no fake certainty')
    assert.ok(!out.toLowerCase().includes('provider'), 'no provider names exposed')
  }

  // TOKEN_SAFETY: verdict-first, not "this token is safe"
  {
    const out = formatTokenSafetyAnswer(ev)
    assert.ok(out.startsWith('TOKEN SAFETY'))
    assert.ok(out.includes('Verdict:'))
    assert.ok(!out.toLowerCase().includes('this token is safe'), 'never asserts "this token is safe"')
    assert.ok(out.includes('CTA:'))
  }

  // DEV_RUG: surfaces ownership + mint + LP
  {
    const out = formatDevRugCheck(ev)
    assert.ok(out.startsWith('DEV/RUG CHECK'))
    assert.ok(out.includes('Ownership:'))
    assert.ok(out.includes('Mint authority:'))
    assert.ok(out.includes('LP control:'))
    assert.ok(!out.toLowerCase().includes('confirmed rug'), 'no fake rug claim')
  }

  // LP_LOCK: leads with lock/burn/control status, not raw liquidity depth
  {
    const out = formatLpLockCheck(ev)
    assert.ok(out.startsWith('LP CHECK'))
    const statusLine = out.split('\n')[1] ?? ''
    assert.ok(statusLine.toLowerCase().includes('status:'), 'second line is Status')
    assert.ok(!statusLine.match(/^\s*-\s*Liquidity depth/), 'does not lead with liquidity depth')
  }

  // RISK_EXPLANATION: signals not a fake score formula
  {
    const out = formatRiskExplanation(ev)
    assert.ok(out.startsWith('RISK SIGNALS'))
    assert.ok(out.includes('CTA:'))
    assert.ok(!out.includes('formula'), 'no fake formula')
  }

  // NO_TOKEN_IN_MEMORY
  {
    const out = formatNoTokenInMemory()
    assert.ok(out.includes('contract address') || out.includes('token'))
    assert.ok(out.includes('CTA:'))
  }

  // Pack 1 route.ts: handlers wired
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
  assert.ok(routeFile.includes("routed.intent === \"token_scan\""), 'token_scan handler exists')
  assert.ok(routeFile.includes("routed.intent === \"token_safety\""), 'token_safety handler exists')
  assert.ok(routeFile.includes("routed.intent === \"dev_rug_check\""), 'dev_rug_check handler exists')
  assert.ok(routeFile.includes("routed.intent === \"lp_lock_check\""), 'lp_lock_check handler exists')
  assert.ok(routeFile.includes("routed.intent === \"risk_explanation\""), 'risk_explanation handler exists')
  assert.ok(routeFile.includes('updateMemToken'), 'token scan saves to session memory')
  assert.ok(!routeFile.includes('No data available right now'), 'stale fallback removed')
  // Token routing priority guard: wallet_scan block must not fire when routedIsToken is true
  assert.ok(routeFile.includes('routedIsToken'), 'route.ts has token-over-wallet priority guard')
  assert.ok(routeFile.includes('!routedIsToken'), 'wallet_scan block skipped when routed intent is token')
}

// ─── Token address routing priority (classifyClarkPrompt) ────────────────────
{
  const { classifyClarkPrompt: classify } = await import('../lib/server/clarkRouting.ts')

  const addr = '0xabcdef1234567890abcdef1234567890abcdef12'

  // explicit token keyword must win
  assert.equal(classify(`scan this token ${addr} on base`).intent, 'token_scan', '"scan this token ... on base" => token_scan')
  assert.equal(classify(`token scan ${addr}`).intent, 'token_scan', '"token scan 0x" => token_scan')

  // wallet keyword with address must still work
  assert.equal(classify(`scan this wallet ${addr}`).intent, 'wallet_scan', '"scan this wallet 0x" => wallet_scan')
  assert.equal(classify(`wallet pnl ${addr}`).intent, 'wallet_scan', '"wallet pnl 0x" => wallet_scan')

  // address + "on base" must not be wallet_scan
  const onBaseResult = classify(`${addr} on base`)
  assert.notEqual(onBaseResult.intent, 'wallet_scan', '"0x on base" must not be wallet_scan')
}

console.log('test-clark-execution.mjs: all assertions passed')
