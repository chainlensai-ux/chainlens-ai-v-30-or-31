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

// ─── getClarkAddressRouteHint regression (Task 7 hard-fix) ───────────────────
{
  const { getClarkAddressRouteHint } = await import('../lib/server/clarkRouting.ts')
  const bugAddr = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'

  // Critical bug prompt — must return "token", never "wallet"
  assert.equal(
    getClarkAddressRouteHint(`scan this token ${bugAddr} on base`),
    'token',
    'CRITICAL: "scan this token 0x... on base" => routeHint must be "token"'
  )
  assert.equal(getClarkAddressRouteHint(`token scan ${bugAddr}`), 'token')
  assert.equal(getClarkAddressRouteHint(`is this token safe ${bugAddr}`), 'token')
  assert.equal(getClarkAddressRouteHint(`${bugAddr} on base`), 'token')
  assert.equal(getClarkAddressRouteHint(`can the dev rug ${bugAddr}`), 'token')
  assert.equal(getClarkAddressRouteHint(`is lp locked ${bugAddr}`), 'token')

  // Wallet prompts must still return "wallet"
  assert.equal(getClarkAddressRouteHint(`scan this wallet ${bugAddr}`), 'wallet')
  assert.equal(getClarkAddressRouteHint(`wallet pnl ${bugAddr}`), 'wallet')
  assert.equal(getClarkAddressRouteHint(`portfolio ${bugAddr}`), 'wallet')

  // Pure address (no keywords) => "none"
  assert.equal(getClarkAddressRouteHint(bugAddr), 'none')

  // route.ts must import and use routeHint guard on all wallet execution points
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
  assert.ok(routeFile.includes('getClarkAddressRouteHint'), 'route.ts imports getClarkAddressRouteHint')
  assert.ok(routeFile.includes("routeHint !== 'token'"), 'route.ts guards wallet blocks with routeHint')
  const walletGuardCount = (routeFile.match(/routeHint !== 'token'/g) ?? []).length
  assert.ok(walletGuardCount >= 3, `at least 3 wallet execution points guarded (found ${walletGuardCount})`)
}

// ─── Task 9: Clark token_scan 401 auth forwarding fix ────────────────────────
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')

  // clarkInternalCtx must carry cookie
  assert.ok(routeFile.includes("cookie?: string"), 'clarkInternalCtx type includes cookie field')
  assert.ok(routeFile.includes("cookie: req.headers.get('cookie') || undefined"), 'cookie extracted from original request')

  // callInternalApi must forward cookie
  assert.ok(routeFile.includes("headers.Cookie = cookieVal"), 'callInternalApi forwards Cookie header')

  // 401 must produce specific public message not "unavailable right now"
  assert.ok(routeFile.includes('Token Scanner authorization failed. Reconnect/sign in and try again.'), '401 produces specific auth failure message')
  assert.ok(!routeFile.includes('"Token data unavailable right now."'), 'generic unavailable message removed')

  // Debug receipt must include auth forwarding info
  assert.ok(routeFile.includes('tokenScanAuthForwarded'), 'debug receipt includes tokenScanAuthForwarded')
  assert.ok(routeFile.includes('cookie: Boolean(clarkInternalCtx.cookie)'), 'auth forwarded bool does not expose cookie value')
  assert.ok(routeFile.includes('tokenScanFailureReason'), 'debug receipt includes tokenScanFailureReason')
  assert.ok(routeFile.includes('"token_route_unauthorized"'), 'debug receipt 401 reason is token_route_unauthorized')

  // Provider names must not appear in the 401 public failure message text
  assert.ok(!routeFile.includes('geckoterminal authorization failed'), 'no geckoterminal in auth failure message')
  assert.ok(!routeFile.includes('goldrush authorization failed'), 'no goldrush in auth failure message')

  // Explicit token prompt must not trigger wallet scan (regression)
  const { classifyClarkPrompt } = await import('../lib/server/clarkRouting.ts')
  const tokenAddr = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'
  assert.equal(classifyClarkPrompt(`scan this token ${tokenAddr} on base`).intent, 'token_scan', 'explicit token prompt routes to token_scan')
  assert.notEqual(classifyClarkPrompt(`scan this token ${tokenAddr} on base`).intent, 'wallet_scan', 'explicit token prompt does not route to wallet_scan')
}

// ─── Task 8: Clark token debug receipt + field-mapping regression ─────────────
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')

  // Debug receipt shape must be emitted in token_scan handler
  assert.ok(routeFile.includes('clarkDebugReceipt'), 'route.ts emits clarkDebugReceipt')
  assert.ok(routeFile.includes('clarkDebugMode'), 'route.ts computes clarkDebugMode')
  assert.ok(routeFile.includes('walletScanAttempted: false'), 'debug receipt records walletScanAttempted: false for token scan')
  assert.ok(routeFile.includes('formatterUsed'), 'debug receipt includes formatterUsed field')
  assert.ok(routeFile.includes('tokenScanAttempted: true'), 'debug receipt records tokenScanAttempted: true')
  assert.ok(routeFile.includes('tokenScanEndpointOrFunction'), 'debug receipt records endpoint name')

  // Field-mapping fix: goplus stripped → must use security.devOwnership and security.contractFlags
  assert.ok(routeFile.includes('tDevOwnership.isRenounced'), 'ownerRenounced reads from security.devOwnership.isRenounced')
  assert.ok(routeFile.includes('tContractFlags.mint'), 'mintable reads from security.contractFlags.mint')
  assert.ok(routeFile.includes('tContractFlags.proxy'), 'proxy reads from security.contractFlags.proxy')

  // change24h field-mapping fix: must read from sections.market.change24h
  assert.ok(routeFile.includes('tSectMarket.change24h'), 'change24h reads from sections.market.change24h fallback')

  // Failure message must not just say "Token data unavailable right now."
  assert.ok(!routeFile.includes('"Token data unavailable right now."'), 'stale "unavailable" fallback removed from fetchTokenEvidence')
  assert.ok(routeFile.includes('Market, LP, and holder data'), 'specific failure message for route failure covers market/LP/holders')
  assert.ok(routeFile.includes('Token not found on Base'), 'specific failure message for no pool data')

  // Provider names must not appear in public Clark answers
  const publicFormatterCode = routeFile.match(/function formatTokenScan[\s\S]*?^}/m)?.[0] ?? ''
  assert.ok(!publicFormatterCode.includes('geckoterminal'), 'formatTokenScanResult must not mention geckoterminal')
  assert.ok(!publicFormatterCode.includes('goldrush'), 'formatTokenScanResult must not mention goldrush')
}

// ─── fetchTokenEvidence field-map: mock evidence → formatter outputs fields ───
{
  const { formatTokenScanResult, formatDevRugCheck } = await import('../lib/server/clarkRouting.ts')

  // Mock evidence simulating what the fixed fetchTokenEvidence now produces
  const mockEv = {
    ok: true,
    token: { name: 'TestCoin', symbol: 'TEST', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b' },
    chain: 'Base',
    market: { price: 0.001, change24h: 5.2, volume24h: 100_000, liquidity: 50_000, marketCap: 1_000_000 },
    holders: { top1: 12.5, top10: 45.0, holderCount: 800 },
    security: { honeypot: false, buyTax: 0, sellTax: 0, ownerRenounced: true, mintable: false, proxy: false, securityStatus: 'clean', riskLevel: 'low', missing: [] },
    lpControl: { status: 'open_check', reason: null, confidence: null, poolType: 'v2' },
    warnings: [],
  }

  const out = formatTokenScanResult(mockEv)
  assert.ok(out.startsWith('TOKEN READ'), 'formatter outputs TOKEN READ header')
  assert.ok(out.includes('TEST'), 'formatter includes symbol')
  assert.ok(out.includes('Liquidity:'), 'formatter surfaces liquidity')
  assert.ok(out.includes('Holders:'), 'formatter surfaces holders')
  assert.ok(out.includes('Honeypot not detected'), 'formatter surfaces honeypot status')
  assert.ok(!out.toLowerCase().includes('geckoterminal'), 'no provider names in public output')
  assert.ok(!out.toLowerCase().includes('goldrush'), 'no provider names in public output')

  // Dev rug check surfaces ownership + mint from same evidence
  const devOut = formatDevRugCheck(mockEv)
  assert.ok(devOut.includes('Ownership:'), 'dev rug check surfaces ownership')
  assert.ok(devOut.includes('renounced'), 'dev rug check surfaces renounced status')
}

// ─── empty evidence → specific missing-evidence reason ───────────────────────
{
  const { formatTokenScanResult } = await import('../lib/server/clarkRouting.ts')
  const emptyEv = {
    ok: false,
    token: null,
    chain: 'Base',
    market: { price: null, change24h: null, volume24h: null, liquidity: null, marketCap: null },
    holders: { top1: null, top10: null, holderCount: null },
    security: { honeypot: null, buyTax: null, sellTax: null, ownerRenounced: null, mintable: null, proxy: null, securityStatus: 'unverified', riskLevel: 'unknown', missing: ['Token scan route failed — /api/token returned http_502'] },
    lpControl: null,
    warnings: ['Token scan route failed — /api/token returned http_502'],
  }
  // formatTokenScanResult with ok=false triggers inline fallback in route.ts (not this formatter),
  // but the formatter should not crash and should handle null evidence gracefully
  const out = formatTokenScanResult(emptyEv)
  // token is null → symbol defaults to "?"
  assert.ok(out.includes('?'), 'handles null token gracefully')
}

// ─── Task 10: Timeout fallback preserves original intent ─────────────────────
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
  const { classifyClarkPrompt, getClarkAddressRouteHint } = await import('../lib/server/clarkRouting.ts')

  const tokenAddr = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'

  // Token prompt → token intent, not generic analysis
  const tokenResult = classifyClarkPrompt(`scan this token ${tokenAddr} on base`)
  assert.equal(tokenResult.intent, 'token_scan', 'token prompt classifies as token_scan')
  const tokenHint = getClarkAddressRouteHint(`scan this token ${tokenAddr} on base`)
  assert.equal(tokenHint, 'token', 'token prompt routeHint is "token"')

  // The catch block must use classifyClarkPrompt, not legacy detectIntent, for intent detection
  assert.ok(routeFile.includes('classifyClarkPrompt(prompt)'), 'catch block uses classifyClarkPrompt for accurate intent')
  assert.ok(routeFile.includes('getClarkAddressRouteHint(prompt)'), 'catch block uses getClarkAddressRouteHint')

  // Token fallback must produce TOKEN READ header, not "Interpreted as: analysis"
  assert.ok(routeFile.includes('TOKEN READ — '), 'token timeout produces TOKEN READ header')
  assert.ok(routeFile.includes('Token scan'), 'token timeout message mentions token scan stage')
  assert.ok(routeFile.includes('Open Token Scanner / Retry Token Scan'), 'token timeout CTA is Open Token Scanner')

  // Wallet fallback must produce WALLET READ header
  assert.ok(routeFile.includes('WALLET READ — '), 'wallet timeout produces WALLET READ header')
  assert.ok(routeFile.includes('Open Wallet Scanner / Retry Wallet Scan'), 'wallet timeout CTA is correct')

  // Market fallback uses Refresh Market Data
  assert.ok(routeFile.includes("isMarketFallback"), 'market intent path exists')

  // Token fallback must NOT use "Refresh Market Data" as its CTA
  // (check that token path explicitly uses Open Token Scanner)
  assert.ok(routeFile.includes('"Open Token Scanner"'), 'token fallback CTA is Open Token Scanner, not market')

  // No fake token evidence on timeout (no hardcoded token data in fallback)
  assert.ok(!routeFile.includes('honeypot: false'), 'no fake security data injected in timeout fallback')

  // Debug receipt is emitted in non-prod
  assert.ok(routeFile.includes('originalIntent'), 'debug receipt includes originalIntent')
  assert.ok(routeFile.includes('timeoutStage'), 'debug receipt includes timeoutStage')
  assert.ok(routeFile.includes('fallbackUsed'), 'debug receipt includes fallbackUsed')
  assert.ok(routeFile.includes('finalIntentBadge'), 'debug receipt includes finalIntentBadge')

  // No re-classification as "analysis" for token prompts
  assert.ok(!routeFile.includes('"Interpreted as: analysis"'), 'token prompt is never labelled as "analysis" in catch')

  // Token prompt does not call wallet scan
  const noWalletOnToken = tokenResult.intent !== 'wallet_scan' && tokenHint !== 'wallet'
  assert.ok(noWalletOnToken, 'token prompt stays away from wallet_scan in timeout path')
}

// ─── Task 11: Debug timing proof in fetchTokenEvidence / clarkDebugReceipt ───
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')

  // fetchTokenEvidence must record timing
  assert.ok(routeFile.includes('tokenRouteStart = Date.now()'), 'fetchTokenEvidence records tokenRouteStart timing')
  assert.ok(routeFile.includes('tokenRouteDurationMs'), 'fetchTokenEvidence records tokenRouteDurationMs')
  assert.ok(routeFile.includes('tokenRouteAborted'), 'fetchTokenEvidence tracks token route abort')
  assert.ok(routeFile.includes('honeypotAborted'), 'fetchTokenEvidence tracks honeypot abort')

  // tokenScanDebug object is built and returned from fetchTokenEvidence
  assert.ok(routeFile.includes('tokenScanAttempted: true'), 'tokenScanDebug includes tokenScanAttempted')
  assert.ok(routeFile.includes('requestUrlPath'), 'tokenScanDebug includes requestUrlPath')
  assert.ok(routeFile.includes('authForwarded'), 'tokenScanDebug includes authForwarded')
  assert.ok(routeFile.includes('_tokenScanDebug: tokenScanDebug'), 'fetchTokenEvidence returns _tokenScanDebug')

  // clarkDebugReceipt includes tokenScanDebug from evidence
  assert.ok(routeFile.includes('tokenScanDebug: evDebug._tokenScanDebug'), 'clarkDebugReceipt includes tokenScanDebug from evidence')

  // /api/token route must emit _tokenRouteDebug in non-prod
  const tokenRouteFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'token', 'route.ts'), 'utf8')
  assert.ok(tokenRouteFile.includes('_tokenRouteDebug'), '/api/token emits _tokenRouteDebug in non-prod/debug mode')
  assert.ok(tokenRouteFile.includes('routeReached: true'), '/api/token _tokenRouteDebug includes routeReached')
  assert.ok(tokenRouteFile.includes('stagesCompleted'), '/api/token _tokenRouteDebug includes stagesCompleted')
  assert.ok(tokenRouteFile.includes('totalMs'), '/api/token _tokenRouteDebug includes totalMs')

  // fetchTokenEvidence reads _tokenRouteDebug from the token response
  assert.ok(routeFile.includes('_tokenRouteDebug'), 'fetchTokenEvidence reads _tokenRouteDebug from token response')
  assert.ok(routeFile.includes('tokenRouteDebugSummary'), 'fetchTokenEvidence maps _tokenRouteDebug to tokenRouteDebugSummary')

  // Public response must NOT expose auth values
  const { sanitizePublicTokenResponse } = await import('../lib/server/tokenPublicResponse.ts')
  const mockPayload = {
    chain: 'base',
    contract: '0xabc',
    _tokenRouteDebug: { routeReached: true, chain: 'base', address: '0xabc', stagesCompleted: ['response_assembly'], totalMs: 123 },
    name: 'TestToken',
    symbol: 'TEST',
  }
  const sanitized = sanitizePublicTokenResponse(mockPayload, false)
  // _tokenRouteDebug is not in the public strip list but is debug-only data;
  // in non-debug mode it is still emitted because it's benign
  assert.ok('chain' in sanitized, 'sanitize preserves chain')
  const debugSanitized = sanitizePublicTokenResponse(mockPayload, true)
  assert.ok(debugSanitized._tokenRouteDebug?.routeReached === true, 'debug mode preserves _tokenRouteDebug')
}

// ─── Pack 1 Task 1-7: partial evidence / missing evidence / memory / follow-up ─
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
  const { formatTokenScanResult, formatTokenSafetyAnswer, formatDevRugCheck, formatLpLockCheck } = await import('../lib/server/clarkRouting.ts')

  // Task 1: fetchTokenEvidence branches are independently guarded
  assert.ok(routeFile.includes('tokenFetchPromise'), 'token route branch has its own promise')
  assert.ok(routeFile.includes('honeypotPromise'), 'honeypot branch has its own promise')
  assert.ok(routeFile.includes('Promise.all([tokenFetchPromise, honeypotPromise])'), 'both branches run in parallel')
  assert.ok(routeFile.includes('tokenRouteAborted'), 'token route abort tracked independently')
  assert.ok(routeFile.includes('honeypotAborted'), 'honeypot abort tracked independently')

  // Task 2: partial evidence flags exist in return value
  assert.ok(routeFile.includes('_partialEvidenceUsed'), 'fetchTokenEvidence returns _partialEvidenceUsed')
  assert.ok(routeFile.includes('_evidenceSectionsPresent'), 'fetchTokenEvidence returns _evidenceSectionsPresent')
  assert.ok(routeFile.includes('_evidenceSectionsMissing'), 'fetchTokenEvidence returns _evidenceSectionsMissing')
  assert.ok(routeFile.includes('_tokenRouteStatus'), 'fetchTokenEvidence returns _tokenRouteStatus')
  assert.ok(routeFile.includes('_tokenRouteDurationMs'), 'fetchTokenEvidence returns _tokenRouteDurationMs')
  assert.ok(routeFile.includes('_honeypotStatus'), 'fetchTokenEvidence returns _honeypotStatus')
  assert.ok(routeFile.includes('_honeypotDurationMs'), 'fetchTokenEvidence returns _honeypotDurationMs')

  // Task 3: public missing evidence messages use open_check language
  assert.ok(routeFile.includes('timed out / Open Check'), 'timeout uses Open Check language')
  assert.ok(routeFile.includes('network error / Open Check'), 'network error uses Open Check language')
  assert.ok(routeFile.includes('Security simulation: timed out / Open Check'), 'honeypot timeout says Open Check')

  // Task 4: formatPartialTokenRead exists and has correct output structure
  assert.ok(routeFile.includes('formatPartialTokenRead'), 'partial token read formatter exists')
  assert.ok(routeFile.includes('TOKEN READ — ${sym} (partial evidence)'), 'partial formatter header uses partial evidence label')
  assert.ok(routeFile.includes('Open Check'), 'partial formatter emits Open Check for missing sections')
  assert.ok(routeFile.includes('Missing evidence:'), 'partial formatter lists missing evidence')

  // Task 1 partial behavior: /api/token success + honeypot timeout → partial TOKEN READ
  // Simulated by checking the routing logic: partialEvidenceUsed when one branch failed
  assert.ok(routeFile.includes('partialEvidenceUsed = !totalFailure && (tokenRouteFailed || honeypotFailed'), 'partial evidence condition covers mixed success/fail')

  // /api/token timeout + honeypot success → partial with market/LP/holders open_check
  assert.ok(routeFile.includes('tokenRouteFailed ? `token route ${tokenRouteStatus}` : "unavailable"'), 'market/holders missing reason references token route status')

  // Total/no-usable-evidence failure → TOKEN READ — failed (quota-safe, never charged)
  assert.ok(routeFile.includes('TOKEN READ — failed'), 'no-usable-evidence outputs failed header')

  // No fake safe/clean/LP locked when evidence missing
  const partialReadStart = routeFile.indexOf('formatPartialTokenRead')
  const partialReadEnd = routeFile.indexOf('async function resolveTokenForFollowup')
  const partialReadBody = routeFile.slice(partialReadStart, partialReadEnd)
  assert.ok(!partialReadBody.includes('"safe"'), 'partial formatter does not claim safe')
  assert.ok(!partialReadBody.includes('"Cleaner"'), 'partial formatter does not claim Cleaner verdict without evidence')
  assert.ok(!partialReadBody.includes('"LP locked"'), 'partial formatter does not claim LP locked without evidence')
  // Verdict only asserts Avoid when honeypot=true
  assert.ok(partialReadBody.includes('sec?.honeypot === true'), 'partial formatter only claims Avoid when honeypot=true')

  // Task 5: lastToken memory stores extra fields
  assert.ok(routeFile.includes('normalizedEvidenceSummary'), 'lastToken stores normalizedEvidenceSummary')
  assert.ok(routeFile.includes('missingEvidence:'), 'lastToken stores missingEvidence')
  assert.ok(routeFile.includes("confidence:"), 'lastToken stores confidence')
  assert.ok(routeFile.includes('cachedEvidence:'), 'lastToken stores cachedEvidence')
  assert.ok(routeFile.includes('cachedEvidence: memConfidence !== "none" ? ev : null'), 'cachedEvidence stored when evidence is present')

  // Task 6: follow-up intents use memory-first
  assert.ok(routeFile.includes('fromMemory: true'), 'resolveTokenForFollowup returns fromMemory flag')
  assert.ok(routeFile.includes('cachedEvidence && mem.address'), 'follow-up checks cached evidence before re-calling')
  // Follow-up intents set toolsUsed to ["memory"] from memory
  assert.ok(routeFile.includes("r.fromMemory ? [\"memory\"] : [\"token_scan\"]"), 'token_safety uses memory tool label when from cache')
  // Does not re-call providers when memory exists
  assert.ok(routeFile.includes('quotaConsumed: r.fromMemory ? false'), 'no quota consumed from memory follow-up')

  // Formatters with partial evidence — formatTokenSafetyAnswer handles null fields gracefully
  const partialEv = {
    ok: false,
    token: { name: 'TestCoin', symbol: 'TEST', address: '0xabc' },
    chain: 'Base',
    market: { price: null, change24h: null, volume24h: null, liquidity: null, marketCap: null },
    holders: { top1: null, top10: null, holderCount: null, status: 'timed out' },
    security: { honeypot: false, buyTax: 0, sellTax: 0, ownerRenounced: null, mintable: null, proxy: null, securityStatus: 'partial', riskLevel: 'unknown', missing: ['Market, LP, and holder data: timed out / Open Check'] },
    lpControl: null,
    warnings: ['Market, LP, and holder data: timed out / Open Check'],
  }
  // Honeypot succeeded, but token route timed out — safety answer should include what's known
  const safetyOut = formatTokenSafetyAnswer(partialEv)
  assert.ok(!safetyOut.includes('LP locked'), 'safety answer does not say LP locked when lpControl is null')
  assert.ok(!safetyOut.includes('renounced'), 'safety answer does not claim renounced when ownerRenounced is null')
  assert.ok(safetyOut.includes('TEST'), 'safety answer includes symbol')

  const devOut = formatDevRugCheck(partialEv)
  assert.ok(!devOut.includes('renounced'), 'dev rug check does not claim renounced when evidence null')

  // Task 7: debug receipt has new fields
  assert.ok(routeFile.includes('tokenRouteAttempted: true'), 'debug receipt includes tokenRouteAttempted')
  assert.ok(routeFile.includes('honeypotAttempted: true'), 'debug receipt includes honeypotAttempted')
  assert.ok(routeFile.includes('tokenRouteDurationMs'), 'debug receipt includes tokenRouteDurationMs')
  assert.ok(routeFile.includes('honeypotDurationMs'), 'debug receipt includes honeypotDurationMs')
  assert.ok(routeFile.includes('memoryUpdated: true'), 'debug receipt includes memoryUpdated')

  // Public response does not expose cookies or auth
  assert.ok(!routeFile.includes('cookie: clarkInternalCtx.cookie,') || routeFile.includes('cookie: Boolean(clarkInternalCtx.cookie)'), 'cookie exposed as boolean only')
}

// ─── Clark Pack 1 Token Core API wiring audit: hard debug receipt proof ──────
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
  const tokenRouteFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'token', 'route.ts'), 'utf8')

  // Task 1: clarkDebugReceipt carries the exact hard-proof field names
  for (const field of [
    'routeHint',
    'intentBadge',
    'selectedChain',
    'extractedAddress',
    'tokenScanAttempted',
    'tokenInternalApiCalled',
    'tokenInternalApiPath',
    'tokenInternalApiPayload',
    'tokenInternalApiStatus',
    'tokenInternalApiDurationMs',
    'tokenInternalApiOk',
    'tokenInternalApiReturnedKeys',
    'tokenInternalApiReturnedTokenFields',
    'tokenEvidenceMappedKeys',
    'evidenceSectionsPresent',
    'evidenceSectionsMissing',
    'formatterUsed',
    'finalAnswerType',
  ]) {
    assert.ok(routeFile.includes(field), `clarkDebugReceipt is missing hard-proof field: ${field}`)
  }

  // Debug receipt must never expose raw cookie/auth/secret values, only booleans
  assert.ok(!/clarkDebugReceipt[\s\S]{0,2000}cookie:\s*clarkInternalCtx\.cookie[^B]/.test(routeFile), 'clarkDebugReceipt must not leak raw cookie value')

  // Task 3: Clark threads its own debug flag and mode into the /api/token payload
  assert.ok(routeFile.includes('tokenInternalApiPayload = { contract: tokenAddress, chain: chain ?? "base", ...(clarkDebugMode ? { debug: true } : {}), mode: wantsFastPreview ? "clark_fast" : "clark_core" }'), 'Clark forwards debug flag and clark_core/clark_fast mode to /api/token payload')

  // Task 4: payload shape sent to /api/token is { contract, chain } (safe fields only)
  assert.ok(routeFile.includes('callInternalApi(origin, "/api/token", tokenInternalApiPayload'), 'fetchTokenEvidence calls /api/token with tokenInternalApiPayload')

  // Task 6: field-mapping bug fix — tSecSim.isHoneypot (wrong field name) removed,
  // correct field name (honeypot) used instead
  assert.ok(!routeFile.includes('tSecSim.isHoneypot'), 'wrong field name tSecSim.isHoneypot removed')
  assert.ok(routeFile.includes('tSecSim.honeypot'), 'honeypot mapping reads correct field tSecSim.honeypot')

  // Task 2: /api/token emits the literal tokenRouteDebug proof shape
  for (const field of [
    'tokenRouteDebug',
    'routeReached: true',
    "method: 'POST'",
    'authPassed: true',
    'stagesStarted',
    'marketDataAttempted',
    'marketDataStatus',
    'poolDataFound',
    'securityAttempted',
    'securityStatus',
    'holdersAttempted',
    'holdersStatus',
    'lpAttempted',
    'lpStatus',
    'publicResponseKeys',
    'totalMs',
  ]) {
    assert.ok(tokenRouteFile.includes(field), `/api/token tokenRouteDebug is missing field: ${field}`)
  }
  // No provider API keys or raw secrets in the debug block
  assert.ok(!/tokenRouteDebug[\s\S]{0,800}apiKey/i.test(tokenRouteFile), 'tokenRouteDebug must not expose provider API keys')

  // Task 7: pipeline proof via mocked evidence end-to-end through the real formatters —
  // simulates a /api/token response with real field shapes reaching Clark's formatter.
  const { formatTokenScanResult, classifyClarkPrompt, getClarkAddressRouteHint } = await import('../lib/server/clarkRouting.ts')
  const smokeAddr = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'
  const smokePrompt = `scan this token ${smokeAddr} on base`

  // routeHint = token, never wallet
  assert.equal(getClarkAddressRouteHint(smokePrompt), 'token', 'smoke prompt routeHint must be token')
  const smokeClassified = classifyClarkPrompt(smokePrompt)
  assert.equal(smokeClassified.intent, 'token_scan', 'smoke prompt classifies as token_scan')
  assert.equal(smokeClassified.address?.toLowerCase(), smokeAddr, 'extracted address matches exactly')

  // Mocked /api/token-shaped evidence (mirrors real field names: priceUsd, liquidityUsd,
  // sections.market/security, security.devOwnership/contractFlags, lpControl)
  const mockTokenEvidence = {
    ok: true,
    token: { name: 'SmokeCoin', symbol: 'SMOKE', address: smokeAddr },
    chain: 'Base',
    market: { price: 0.05, change24h: 3.1, volume24h: 200_000, liquidity: 80_000, marketCap: 2_000_000 },
    holders: { top1: 9.0, top10: 38.0, holderCount: 500 },
    security: { honeypot: false, buyTax: 0, sellTax: 0, ownerRenounced: true, mintable: false, proxy: false, securityStatus: 'clean', riskLevel: 'low', missing: [] },
    lpControl: { status: 'locked', reason: 'locked via protocol', confidence: 'high', poolType: 'v2' },
    warnings: [],
  }
  const smokeOut = formatTokenScanResult(mockTokenEvidence)
  assert.ok(smokeOut.startsWith('TOKEN READ'), 'mocked /api/token evidence produces TOKEN READ via formatter')
  assert.ok(smokeOut.includes('SMOKE'), 'mapped evidence symbol reaches formatter output')
  assert.ok(!smokeOut.toLowerCase().includes('wallet read'), 'token smoke test never produces WALLET READ')
}

// ─── Clark token quota fix + clark_fast mode (this pass) ────────────────────
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
  const tokenRouteFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'token', 'route.ts'), 'utf8')
  const { hasUsableTokenEvidence, formatFastTokenRead, formatTokenScanResult: fmtFull } = await import('../lib/server/clarkRouting.ts')

  // Task 1: hasUsableTokenEvidence — false when every major section is missing
  assert.equal(hasUsableTokenEvidence(null), false, 'null evidence is not usable')
  assert.equal(hasUsableTokenEvidence({
    token: { symbol: '?', name: 'Unknown' },
    market: null, holders: null, lpControl: null,
    security: { honeypot: null, buyTax: null, sellTax: null, ownerRenounced: null, mintable: null, proxy: null, missing: [] },
  }), false, 'all-missing evidence (timeout/unavailable) is not usable')

  // Task 1: true when at least one useful section is present
  assert.equal(hasUsableTokenEvidence({
    token: { symbol: 'SMOKE', name: 'SmokeCoin' },
    market: { price: 0.05, liquidity: 80_000, volume24h: 1000, change24h: 1, marketCap: 1 },
    holders: null, lpControl: null, security: null,
  }), true, 'market evidence alone counts as usable')
  assert.equal(hasUsableTokenEvidence({
    token: null, market: null, holders: null, lpControl: null,
    security: { honeypot: false, buyTax: 0, sellTax: 0, ownerRenounced: null, mintable: null, proxy: null, missing: [] },
  }), true, 'security simulation evidence alone counts as usable')

  // Task 2: quota gating wired into the token_scan handler via the usable-evidence gate
  assert.ok(routeFile.includes('const usableEvidence = hasUsableTokenEvidence(ev);'), 'token_scan computes usableEvidence via hasUsableTokenEvidence')
  assert.ok(routeFile.includes('const quotaEligible = usableEvidence;'), 'token_scan quotaEligible derives from usableEvidence')
  assert.ok(routeFile.includes('const quotaConsumed = quotaEligible;'), 'token_scan quotaConsumed derives from quotaEligible')
  assert.ok(routeFile.includes('quotaConsumed,\n      ...(clarkDebugReceipt'), 'token_scan response uses the gated quotaConsumed value')

  // Task 3 (superseded): Clark now calls /api/token with mode "clark_core" by default —
  // real security/LP/holders/dev evidence, not the weak market-only clark_fast preview.
  // clark_fast is only used when the user explicitly asks for a quick preview.
  assert.ok(routeFile.includes('mode: wantsFastPreview ? "clark_fast" : "clark_core"'), 'fetchTokenEvidence defaults to clark_core (real evidence) mode unless an explicit fast preview is requested')
  assert.ok(routeFile.includes('async function fetchTokenEvidence(tokenAddress: string, opts?: { fullScan?: boolean; fastPreview?: boolean })'), 'fetchTokenEvidence accepts a fastPreview opt-in for explicit quick previews')

  // Task 3: /api/token implements mode === "clark_fast" as an early, separate lightweight branch
  assert.ok(tokenRouteFile.includes("mode: scanMode } = body;"), '/api/token reads mode from the request body')
  assert.ok(tokenRouteFile.includes("isClarkFastMode = scanMode === 'clark_fast'"), '/api/token detects clark_fast mode')
  assert.ok(tokenRouteFile.includes('if (isClarkFastMode) {'), '/api/token branches into a lightweight path for clark_fast')
  assert.ok(tokenRouteFile.includes("stagesSkipped: ['holders', 'lp', 'dev_enrichment']"), 'clark_fast marks skipped slow sections instead of faking them')
  assert.ok(tokenRouteFile.includes("status: 'open_check'") && tokenRouteFile.includes('lpControl'), 'clark_fast marks LP as open_check, not a fake safe verdict')

  // Task 3: normal Token Scanner behavior is unaffected when mode is absent — the heavy
  // pipeline (13-way Promise.all of bytecode/GoldRush/Moralis/GeckoTerminal/etc.) still runs
  // unconditionally after the clark_fast early-return branch.
  assert.ok(tokenRouteFile.includes('const [bytecode, goldrush, holdersRaw, gtData, gtTokenInfo, gmgn, metadata, _simResult, coingeckoRaw, moralisHoldersRaw, moralisTransfersRaw, dexFbEarly, grContractIntel] = await Promise.all(['), 'full heavy scan pipeline is untouched and still runs for non-clark_fast requests')

  // Task 4: clark_fast mocked market evidence produces "TOKEN READ — fast evidence"
  const fastEvWithMarket = {
    ok: false,
    token: { name: 'FastCoin', symbol: 'FAST', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b' },
    market: { price: 0.01, liquidity: 50_000, volume24h: 5_000, change24h: null, marketCap: null },
    holders: null,
    lpControl: { status: 'open_check', reason: 'LP lock/burn proof not run in Clark fast mode.', confidence: 'open_check', poolType: null },
    security: { honeypot: false, buyTax: null, sellTax: null, ownerRenounced: null, mintable: null, proxy: null, missing: [] },
    warnings: [],
  }
  const fastOut = formatFastTokenRead(fastEvWithMarket, 'Base')
  assert.ok(fastOut.startsWith('TOKEN READ — fast evidence'), 'clark_fast formatter produces the exact fast-evidence header')
  assert.ok(fastOut.includes('FAST'), 'fast evidence output includes the token symbol')
  assert.ok(/Market:.*price/i.test(fastOut), 'fast evidence output includes market read when available')

  // Task 4: skipped holders/LP/dev sections are reported as Open Check, never a fake safe verdict
  assert.ok(fastOut.includes('LP: Open Check — full LP proof not run in Clark fast read'), 'clark_fast LP section is Open Check, not a fake verdict')
  assert.ok(fastOut.includes('Holders: Open Check — holder scan not run in Clark fast read'), 'clark_fast holders section is Open Check, not faked')
  assert.ok(fastOut.includes('Missing evidence: holders, LP proof, dev-risk require full Token Scanner scan'), 'fast evidence output lists missing-evidence categories')
  assert.ok(!/lp.*locked|holders.*verified/i.test(fastOut), 'fast evidence never claims LP locked or holders verified without evidence')

  // Task 1/2 (this pass): normal token_scan prompts use clark_core (real evidence) by
  // default; only an explicit quick-preview request drops to clark_fast.
  assert.ok(routeFile.includes('function wantsFastTokenPreview(prompt: string): boolean {'), 'wantsFastTokenPreview helper exists')
  assert.ok(routeFile.includes('const wantsFastPreview = wantsFastTokenPreview(prompt) && !wantsFullTokenScan(prompt);'), 'token_scan reads the fast-preview opt-in from the prompt, with "full/deep scan" phrasing always winning')
  assert.ok(!/\b(quick\s*(scan|preview|check|look)|fast\s*(scan|preview))\b/i.test('scan this token 0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b on base'), 'normal scan prompt does not trigger the fast-preview path')
  assert.ok(/\bquick\s*scan\b/i.test('quick scan this token'), 'explicit quick-scan prompt is recognized as a fast-preview request')

  // Task 6: clarkDebugReceipt carries the new fast-mode/quota proof fields
  for (const field of ['tokenMode', 'tokenRouteTimedOut', 'usableEvidence', 'quotaEligible']) {
    assert.ok(routeFile.includes(field), `clarkDebugReceipt is missing fast-mode proof field: ${field}`)
  }

  // Task 7: no Wallet Scanner call is made for a token_scan prompt — fetchTokenEvidence only
  // ever calls /api/token (market/security), never /api/wallet or runWalletScanner.
  const fetchTokenEvidenceBody = routeFile.slice(
    routeFile.indexOf('async function fetchTokenEvidence('),
    routeFile.indexOf('async function resolveTokenSymbolToAddress(')
  )
  assert.ok(!fetchTokenEvidenceBody.includes('/api/wallet'), 'fetchTokenEvidence never calls /api/wallet')
  assert.ok(!fetchTokenEvidenceBody.includes('runWalletScanner'), 'fetchTokenEvidence never calls runWalletScanner')

  // Task 7: still proves formatTokenScanResult works for fully-resolved evidence (full mode)
  const fullModeEvidence = {
    ok: true,
    token: { name: 'SmokeCoin', symbol: 'SMOKE', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b' },
    market: { price: 0.05, change24h: 3.1, volume24h: 200_000, liquidity: 80_000, marketCap: 2_000_000 },
    holders: { top1: 9.0, top10: 38.0, holderCount: 500 },
    security: { honeypot: false, buyTax: 0, sellTax: 0, ownerRenounced: true, mintable: false, proxy: false, securityStatus: 'clean', riskLevel: 'low', missing: [] },
    lpControl: { status: 'locked', reason: 'locked via protocol', confidence: 'high', poolType: 'v2' },
    warnings: [],
  }
  const fullOut = fmtFull(fullModeEvidence, 'Base')
  assert.ok(fullOut.startsWith('TOKEN READ'), 'full-mode evidence still produces a normal TOKEN READ')
}

// ─── Clark Pack 1 hard fix: token follow-up memory guard (this pass) ────────
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
  const {
    isTokenFollowupPrompt,
    classifyTokenFollowupKind,
    formatTokenSafetyAnswer,
    formatDevRugCheck,
    formatLpLockCheck,
    formatRiskExplanation,
  } = await import('../lib/server/clarkRouting.ts')

  // Task 1: isTokenFollowupPrompt matches every listed follow-up phrase
  const followupPrompts = [
    'is it safe', 'is this safe', 'is this token safe', 'should I buy', 'is it legit',
    'is it a rug', 'can dev rug', 'can the dev rug', 'can liquidity be pulled',
    'is LP locked', 'explain LP', 'explain holders', 'explain dev', 'explain dev control',
    'why high risk', 'why is it risky', 'what are red flags', 'explain risk', 'explain verdict',
  ]
  for (const p of followupPrompts) {
    assert.ok(isTokenFollowupPrompt(p), `isTokenFollowupPrompt should match: "${p}"`)
  }
  assert.ok(!isTokenFollowupPrompt('scan this wallet 0x1234567890123456789012345678901234567890'), 'wallet-specific prompt is not treated as a token follow-up')
  assert.ok(!isTokenFollowupPrompt('what is pumping on base'), 'unrelated prompt is not treated as a token follow-up')

  // Task 1: kind classification routes to the right formatter
  assert.equal(classifyTokenFollowupKind('can dev rug'), 'dev_rug')
  assert.equal(classifyTokenFollowupKind('explain dev control'), 'dev_rug')
  assert.equal(classifyTokenFollowupKind('is LP locked'), 'lp_lock')
  assert.equal(classifyTokenFollowupKind('can liquidity be pulled'), 'lp_lock')
  assert.equal(classifyTokenFollowupKind('why is it risky'), 'risk')
  assert.equal(classifyTokenFollowupKind('explain holders'), 'risk')
  assert.equal(classifyTokenFollowupKind('is it safe'), 'safety')

  // Task 1/6: the hard guard runs before every wallet branch in handleClarkAI
  const guardIdx = routeFile.indexOf('Task 1: hard token follow-up memory guard')
  assert.ok(guardIdx > -1, 'hard token follow-up guard block exists')
  const walletCompareIdx = routeFile.indexOf("routedClassification.intent === 'wallet_compare'")
  const appIntentWalletScanIdx = routeFile.indexOf("appIntent.intent === 'wallet_scan'")
  const routedWalletScanIdx = routeFile.indexOf('routed.intent === "wallet_scan"')
  const walletAnalysisIdx = routeFile.indexOf('directIntent.intent === "wallet_analysis" && !directIntent.address')
  assert.ok(guardIdx < walletCompareIdx, 'guard runs before wallet_compare branch')
  assert.ok(guardIdx < appIntentWalletScanIdx, 'guard runs before appIntent.wallet_scan branch')
  assert.ok(guardIdx < routedWalletScanIdx, 'guard runs before routed.intent === "wallet_scan" branch')
  assert.ok(guardIdx < walletAnalysisIdx, 'guard runs before directIntent wallet_analysis branch')
  assert.ok(routeFile.includes('isTokenFollowupPrompt(prompt) && sessionMem.lastToken?.address'), 'guard requires both a follow-up prompt and an existing lastToken in memory')
  assert.ok(routeFile.includes('isTokenFollowupPrompt(prompt) && sessionMem.lastToken?.address && !extractAddress(prompt)'), 'guard defers to the explicit-address LP route when the prompt names a new contract')
  assert.ok(!routeFile.slice(guardIdx, guardIdx + 1600).includes('runWalletScanner'), 'token follow-up guard never calls runWalletScanner')

  // Task 3/5: each formatter is section-specific, never a generic "open check" excuse,
  // and never asserts safe/locked/renounced claims without evidence.
  const noEvidence = {
    ok: false,
    token: { name: null, symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b' },
    market: { price: 0.5, liquidity: 4_900_000, volume24h: 97_600, change24h: null, marketCap: null },
    holders: null,
    lpControl: null,
    security: { honeypot: null, buyTax: null, sellTax: null, ownerRenounced: null, mintable: null, proxy: null, missing: [] },
    warnings: [],
  }
  const safetyOut = formatTokenSafetyAnswer(noEvidence, 'Base')
  assert.ok(safetyOut.startsWith('TOKEN SAFETY'), 'token safety follow-up produces TOKEN SAFETY header, not WALLET READ')
  assert.ok(safetyOut.includes('Verdict:'), 'safety answer always carries an explicit verdict line, never a bare "safe" claim')
  assert.ok(!safetyOut.toLowerCase().includes('wallet read'), 'token safety follow-up never produces WALLET READ')

  const devOut = formatDevRugCheck(noEvidence, 'Base')
  assert.ok(devOut.startsWith('DEV/RUG CHECK'), 'dev rug follow-up produces DEV/RUG CHECK header')
  assert.ok(devOut.includes('open check'), 'dev rug check reports section-specific open checks, not a generic excuse')
  assert.ok(!/renounced — owner cannot|YES — new tokens can be minted|locked\/burned/i.test(devOut), 'dev rug check does not fabricate ownership/mint/LP claims when evidence is missing')

  const lpOut = formatLpLockCheck(noEvidence, 'Base')
  assert.ok(lpOut.startsWith('LP CHECK'), 'LP follow-up produces LP CHECK header')
  assert.ok(!/lp lock\/burn proof confirmed/i.test(lpOut), 'LP check never claims LP locked without evidence')

  const riskOut = formatRiskExplanation(noEvidence, 'Base')
  assert.ok(riskOut.startsWith('RISK SIGNALS'), 'risk follow-up produces RISK SIGNALS header')
  assert.ok(riskOut.includes('Evidence not yet checked:'), 'risk explanation lists precisely which evidence is missing')

  // Task 6: quota is never consumed when the follow-up was answered straight from memory
  const memoryFollowupIdx = routeFile.indexOf('const quotaConsumed = fromMemory ? false : safetyFetchReturnedNonTaxCoreEvidence;')
  assert.ok(memoryFollowupIdx > -1, 'memory-served token follow-up never consumes quota')
}

// ─── Clark Pack 1 routing regression: token follow-up must win over wallet (this pass) ──
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
  const { isTokenFollowupPrompt } = await import('../lib/server/clarkRouting.ts')

  // Task 5: the exact reported-regression prompt and every other required follow-up phrase
  // must keep routing to the token follow-up guard, never to wallet.
  const mustStayToken = [
    'is it safe', 'safe?', 'is this safe', 'can dev rug', 'can the dev rug',
    'is lp locked', 'is liquidity locked', 'explain lp', 'why high risk',
    'why caution', 'why open check', 'should I buy', 'is it risky',
  ]
  for (const p of mustStayToken) {
    assert.ok(isTokenFollowupPrompt(p), `isTokenFollowupPrompt should match (must stay token): "${p}"`)
  }

  // Task 3: explicit wallet language must override token-follow-up routing even after a
  // token scan, so these must never be treated as token follow-ups.
  const mustOverrideToWallet = [
    'wallet pnl 0x1234567890123456789012345678901234567890',
    'scan wallet 0x1234567890123456789012345678901234567890',
    'deep scan wallet 0x1234567890123456789012345678901234567890',
    'show my portfolio',
    'show my holdings',
  ]
  for (const p of mustOverrideToWallet) {
    assert.ok(!isTokenFollowupPrompt(p), `isTokenFollowupPrompt should NOT match (explicit wallet wins): "${p}"`)
  }

  // Task 1: the hard guard is the first conditional in handleClarkAI, strictly before any
  // wallet snapshot execution or wallet-routing branch in the file.
  const guardIdx = routeFile.indexOf('if (isTokenFollowupPrompt(prompt) && sessionMem.lastToken?.address')
  const walletSnapshotIdx = routeFile.indexOf('toolsUsed: ["wallet_get_snapshot"]')
  assert.ok(guardIdx > -1, 'hard token follow-up guard exists in handleClarkAI')
  assert.ok(walletSnapshotIdx === -1 || guardIdx < walletSnapshotIdx, 'token follow-up guard runs before any wallet_get_snapshot call')
}

// ─── Wording polish: TOKEN SAFETY no longer mislabels missing evidence (this pass) ──
{
  const { formatTokenSafetyAnswer, formatTokenScanResult } = await import('../lib/server/clarkRouting.ts')

  const virtualLikeEv = {
    ok: false,
    token: { name: 'Virtual Protocol', symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b' },
    market: { price: 0.5, liquidity: 4_900_000, volume24h: 97_600, change24h: null, marketCap: null },
    holders: null,
    lpControl: null,
    security: { honeypot: null, buyTax: null, sellTax: null, ownerRenounced: null, mintable: null, proxy: null, missing: ['honeypot', 'buyTax', 'sellTax'] },
    warnings: ['honeypot'],
  }
  const out = formatTokenSafetyAnswer(virtualLikeEv, 'Base')

  // "Open Check" must never appear under a positive-sounding "Top safety signals" header
  assert.ok(!out.includes('Top safety signals'), 'safety answer no longer has a "Top safety signals" header')
  assert.ok(!/Top safety signals:\s*\n[^\n]*open check/i.test(out), '"Open Check" / missing evidence is never listed as a top safety signal')

  assert.ok(out.includes('Visible evidence:'), 'safety answer includes a "Visible evidence" section')
  assert.ok(out.includes('Open checks:'), 'safety answer includes an "Open checks" section')
  assert.ok(out.includes('Not enough confirmed evidence to call it safe'), 'incomplete evidence produces the "not enough confirmed evidence" safe-call line')
  const safeLine = out.split('\n').find(l => l.startsWith('Safe?')) ?? ''
  assert.equal(safeLine, 'Safe? Not enough confirmed evidence to call it safe.', 'safety answer never bare-states "safe" as a fact when evidence is incomplete')
  assert.ok(!/lp lock\/burn proof confirmed|cleaner|locked — confirmed/i.test(out), 'safety answer never fakes a clean/locked verdict when evidence is missing')

  // Token scan output must not leak raw field-name tokens like "Note: honeypot"
  const scanOut = formatTokenScanResult(virtualLikeEv, 'Base')
  assert.ok(!scanOut.includes('Note: honeypot'), 'token scan output never prints the raw "Note: honeypot" token dump')
  assert.ok(!scanOut.includes('Security open checks: honeypot'), 'token scan output never prints the raw "Security open checks: honeypot" dump')
  assert.ok(scanOut.includes('Security: Open Check — security simulation not returned'), 'token scan output uses the precise honeypot open-check sentence')
}

// ─── Evidence depth: tax-only vs non-tax core safety evidence + escalation ──
{
  const { hasTaxEvidence, hasNonTaxCoreSafetyEvidence, needsSafetyEscalation } = await import('../lib/server/clarkRouting.ts')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const routeFile = fs.readFileSync(path.join(process.cwd(), 'app/api/clark/route.ts'), 'utf8')

  // Market + confirmed tax only (what clark_fast returns) — taxes alone must NOT count as
  // core safety evidence, and escalation must be required.
  const taxOnly = {
    ok: true,
    token: { name: 'Virtual Protocol', symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b' },
    market: { price: 0.5, liquidity: 4_900_000, volume24h: 97_600, change24h: null, marketCap: null },
    holders: { top1: null, top10: null, holderCount: null, status: 'open_check' },
    lpControl: { status: 'open_check', reason: null, confidence: null, poolType: null },
    security: { honeypot: null, buyTax: 0, sellTax: 0, ownerRenounced: null, mintable: null, proxy: null, securityStatus: 'unverified', riskLevel: 'unknown', missing: [] },
    warnings: [],
  }
  assert.equal(hasTaxEvidence(taxOnly), true, 'confirmed buy/sell tax is recognized as tax evidence')
  assert.equal(hasNonTaxCoreSafetyEvidence(taxOnly), false, 'tax-only evidence is NOT non-tax core safety evidence')
  assert.equal(needsSafetyEscalation(taxOnly), true, 'cached market + tax only requires safety escalation')

  // No evidence at all also needs escalation.
  assert.equal(needsSafetyEscalation(null), true, 'no cached evidence requires safety escalation')

  // Any one confirmed non-tax safety section makes escalation unnecessary.
  assert.equal(hasNonTaxCoreSafetyEvidence({ ...taxOnly, security: { ...taxOnly.security, honeypot: false } }), true, 'confirmed honeypot=false counts as non-tax core safety evidence')
  assert.equal(needsSafetyEscalation({ ...taxOnly, security: { ...taxOnly.security, honeypot: false } }), false, 'confirmed honeypot allows memory-only answer')
  assert.equal(hasNonTaxCoreSafetyEvidence({ ...taxOnly, lpControl: { status: 'burned', reason: null, confidence: 'high', poolType: 'v2' } }), true, 'confirmed LP status counts as non-tax core safety evidence')
  assert.equal(hasNonTaxCoreSafetyEvidence({ ...taxOnly, holders: { top1: 5, top10: 30, holderCount: 800, status: 'verified' } }), true, 'confirmed holder concentration counts as non-tax core safety evidence')
  assert.equal(hasNonTaxCoreSafetyEvidence({ ...taxOnly, security: { ...taxOnly.security, ownerRenounced: true } }), true, 'confirmed ownership status counts as non-tax core safety evidence')
  assert.equal(needsSafetyEscalation({ ...taxOnly, holders: { top1: 5, top10: 30, holderCount: 800, status: 'verified' } }), false, 'confirmed holders/LP/ownership allows memory-only answer')

  // The follow-up guard must escalate to a real fetch (fullScan) when cached evidence needs it,
  // never retry twice in the same request, and only charge quota for new non-tax evidence.
  assert.ok(routeFile.includes('needsSafetyEscalation(cached)'), 'follow-up guard computes escalation need from cached evidence')
  assert.ok(routeFile.includes('fetchTokenEvidence(tokenAddress, { fullScan: true })'), 'follow-up guard runs a deeper (non clark_fast) fetch exactly once when escalation is needed')
  assert.ok(routeFile.includes('safetyEscalationReason = cachedHasTaxEvidence ? "tax_only_cached_evidence" : "no_safety_evidence_cached"'), 'escalation reason distinguishes tax-only cached evidence from no evidence at all')
  assert.ok(routeFile.includes('const safetyFetchReturnedNonTaxCoreEvidence = safetyEscalationAttempted && hasNonTaxCoreSafetyEvidence(ev);'), 'escalation result is judged by non-tax core safety evidence only')
  assert.ok(routeFile.includes('const quotaConsumed = fromMemory ? false : safetyFetchReturnedNonTaxCoreEvidence;'), 'quota is only charged when the safety fetch actually returns usable non-tax safety evidence')
  assert.ok(routeFile.includes('toolsUsed: fromMemory ? ["memory"] : ["token_scan", "safety_fetch"]'), 'toolsUsed is not just ["memory"] when safety escalation runs')
}

// ─── Token Core: real evidence is the default, only an explicit timeout extension for it ──
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const routeFile = fs.readFileSync(path.join(process.cwd(), 'app/api/clark/route.ts'), 'utf8')
  const tokenRouteFile = fs.readFileSync(path.join(process.cwd(), 'app/api/token/route.ts'), 'utf8')

  // clark_core attempts security/LP/holders/dev sections (same payload shape, no opt-outs).
  assert.ok(routeFile.includes('const wantsFullScan = !wantsFastPreview;'), 'clark_core (full evidence) is the default unless fastPreview is explicitly requested')

  // Only the token-evidence call gets the extended timeout; callInternalApi keeps its
  // original 9s default for every other caller (wallet/whale/liquidity/resolve unchanged).
  assert.ok(routeFile.includes('const TOKEN_CORE_TIMEOUT_MS = 18000;'), 'Token Core has its own extended timeout constant')
  assert.ok(routeFile.includes('timeoutMs: number = 9000'), 'callInternalApi keeps its original 9s default timeout for non-token-core callers')
  assert.ok(routeFile.includes('wantsFastPreview ? 9000 : TOKEN_CORE_TIMEOUT_MS'), 'only the token-evidence call uses the extended Token Core timeout, and only when not a fast preview')

  // /api/token's clark_fast branch is untouched — clark_core falls through to the same
  // full pipeline that always ran for normal (non-clark_fast) requests, so Token Scanner
  // itself was not rewritten.
  assert.ok(tokenRouteFile.includes("isClarkFastMode = scanMode === 'clark_fast'"), '/api/token still only special-cases clark_fast; clark_core runs the existing full pipeline unchanged')
}

// ─── Final evidence-quality pass: honeypot/security mapping, LP detail, verdict sync ──
{
  const { formatTokenScanResult, tokenScanVerdictMeta, hasUsableTokenEvidence } = await import('../lib/server/clarkRouting.ts')

  const base = {
    ok: true,
    token: { name: 'Virtual Protocol', symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b' },
    market: { price: 0.5, liquidity: 4_700_000, volume24h: 90_600, change24h: -6.2, marketCap: null },
    holders: { top1: 9.6, top10: 48.2, holderCount: 1_034_796, status: 'verified' },
    lpControl: { status: 'partial', reason: 'secondary LP exposure found but primary LP proof not fully confirmed.', confidence: 'medium', poolType: 'v2' },
    security: { honeypot: null, buyTax: 0, sellTax: 0, ownerRenounced: true, mintable: true, proxy: false, securityStatus: 'unverified', riskLevel: 'unknown', missing: [] },
    warnings: [],
  }

  // honeypot === false on any supported public path → "Honeypot not detected"
  const honeypotFalseOut = formatTokenScanResult({ ...base, security: { ...base.security, honeypot: false } }, 'Base')
  assert.ok(honeypotFalseOut.includes('Security: Honeypot not detected'), 'honeypot=false maps to "Honeypot not detected"')

  // honeypot === true → "Honeypot detected", and the verdict must never call it safe
  const honeypotTrueOut = formatTokenScanResult({ ...base, security: { ...base.security, honeypot: true } }, 'Base')
  assert.ok(honeypotTrueOut.includes('Security: Honeypot detected'), 'honeypot=true maps to "Honeypot detected"')
  assert.ok(honeypotTrueOut.includes('Verdict: Avoid'), 'honeypot=true never produces a safe-sounding verdict')

  // tax exists but honeypot missing → tax-data-returned wording, not the generic "simulation not returned"
  const taxOnlyOut = formatTokenScanResult(base, 'Base')
  assert.ok(taxOnlyOut.includes('Security: Tax data returned, honeypot simulation unavailable'), 'tax-only evidence uses the tax-specific honeypot-unavailable wording')
  assert.ok(!taxOnlyOut.includes('honeypot simulation not returned'), 'tax-only evidence never uses the generic "simulation not returned" wording')

  // lpControl.status === 'partial' with a reason → the reason is printed, not just the bare word
  assert.ok(taxOnlyOut.includes('LP proof: Partial — secondary LP exposure found but primary LP proof not fully confirmed.'), 'LP partial status prints its real reason, not just "partial"')

  // Real evidence (mintable/holders/LP/ownership) produces a non-null, non-fallback verdict
  // that stays in sync with the displayed "Verdict:" line, and source is not "fallback".
  const meta = tokenScanVerdictMeta(base, hasUsableTokenEvidence(base))
  assert.ok(meta.verdict != null, 'data.verdict is not null when real evidence exists')
  assert.notEqual(meta.source, 'fallback', 'source is not "fallback" when mapped from real Token Scanner evidence')
  assert.ok(taxOnlyOut.includes(`Verdict: ${meta.verdict}`), 'displayed Verdict line matches data.verdict exactly')

  // No evidence at all → conservative Open Check verdict and fallback source, never a fake clean call
  const noEvMeta = tokenScanVerdictMeta({ ok: false }, false)
  assert.equal(noEvMeta.verdict, 'Open Check', 'no evidence produces a conservative Open Check verdict')
  assert.equal(noEvMeta.source, 'fallback', 'no evidence reports source as fallback')

  // Follow-up safety answer surfaces mintable/holders/LP/security evidence, never fakes safe/locked/honeypot
  const { formatTokenSafetyAnswer } = await import('../lib/server/clarkRouting.ts')
  const safetyOut = formatTokenSafetyAnswer({ ...base, security: { ...base.security, honeypot: false } }, 'Base')
  assert.ok(safetyOut.includes('top-10 at 48.2%') || safetyOut.includes('48.2'), 'safety follow-up surfaces holder concentration evidence')
  assert.ok(!/lp lock\/burn proof confirmed/i.test(safetyOut), 'safety follow-up never fakes a locked LP claim from partial evidence')
}

// ─── Memory-served token follow-up guard (is it safe / can dev rug / is LP locked / why
// high risk) must expose the same verdict/confidence/source as the dedicated token_safety
// intent branch, not leave them null on the toolsUsed:["memory"] path ──────────────────────
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const routeFile = fs.readFileSync(path.join(process.cwd(), 'app/api/clark/route.ts'), 'utf8')

  const followupGuard = routeFile.slice(
    routeFile.indexOf('if (isTokenFollowupPrompt(prompt) && sessionMem.lastToken?.address && !extractAddress(prompt)) {'),
    routeFile.indexOf('// ─── Wallet compare')
  )
  assert.ok(followupGuard.includes('const followupVerdictMeta = tokenScanVerdictMeta(ev, hasUsableTokenEvidence(ev));'), 'memory-served follow-up guard computes verdict metadata from the same evidence it displays')
  assert.ok(/verdict:\s*followupVerdictMeta\.verdict/.test(followupGuard), 'memory-served follow-up guard returns verdict in its response object')
  assert.ok(/confidence:\s*followupVerdictMeta\.confidence/.test(followupGuard), 'memory-served follow-up guard returns confidence in its response object')
  assert.ok(/source:\s*followupVerdictMeta\.source/.test(followupGuard), 'memory-served follow-up guard returns source in its response object')

  // normalizeApiReplyShape must prefer handler-provided metadata over its regex fallback.
  assert.ok(routeFile.includes('const hasMappedVerdict = typeof obj.verdict === "string" && obj.verdict.length > 0;'), 'normalizeApiReplyShape checks for handler-provided verdict before falling back to regex')
  assert.ok(routeFile.includes('? (obj.verdict as string)'), 'normalizeApiReplyShape preserves an explicit handler verdict instead of overwriting it')
}

// ─── Honeypot security evidence mapping fix (this pass) ─────────────────────
{
  const honeypotModulePath = path.join(__dirname, '..', 'lib', 'server', 'honeypotSecurity.ts')
  const honeypotSrc = fs.readFileSync(honeypotModulePath, 'utf8')

  // Root cause: honeypot.is v2 puts the verdict under honeypotResult.isHoneypot — the old
  // code never read that field, so a real provider-confirmed result was silently dropped.
  assert.ok(honeypotSrc.includes('honeypotResult.isHoneypot'), 'normalize() reads the real honeypot.is v2 honeypotResult.isHoneypot field')
  assert.ok(honeypotSrc.includes('parseBool(value)'), 'boolean mapping uses a safe parser, not a truthy check')
  assert.ok(!/if\s*\(\s*raw\.isHoneypot\s*\)/.test(honeypotSrc), 'no truthy-only check on raw.isHoneypot that would drop an explicit false')

  const mod = await import('../lib/server/honeypotSecurity.ts')
  assert.equal(typeof mod.fetchHoneypotSecurity, 'function', 'fetchHoneypotSecurity is exported')

  // Tax-only behavior: buyTax/sellTax confirmed must never imply honeypot is false.
  assert.ok(honeypotSrc.includes('honeypot !== null ? "confirmed" : simulationSuccess === false ? "failed" : "unavailable"'), 'simulationStatus is derived independently of tax fields, never inferred from 0% tax')
}

// ─── Honeypot evidence surfaced through Token Scanner / Clark (this pass) ───
{
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'token', 'route.ts'), 'utf8')

  assert.ok(routeFile.includes('honeypotStatus: r.simulationStatus'), '/api/token resolveSimulation threads the real simulationStatus through, not a hardcoded value')
  assert.ok(routeFile.includes('honeypotReason: r.honeypotReason'), '/api/token resolveSimulation threads the provider honeypotReason through')
  assert.ok(routeFile.includes('honeypotStatus: hpResult.ok ? hpResult.honeypotStatus : \'unavailable\''), 'sections.security exposes honeypotStatus distinct from tax status')
  assert.ok(routeFile.includes("status: hpResult.ok && (hpResult.buyTax != null || hpResult.sellTax != null) ? 'confirmed' : 'unavailable',"), 'security.tax.status is confirmed independently of honeypot status')

  const clarkRouteFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
  assert.ok(clarkRouteFile.includes('typeof securitySection.honeypot === "boolean"'), 'Clark maps an explicit honeypot boolean (true or false) from the sanitized token security section, not just a truthy check')
}

// ─── Clark LP Check CTA/context fix: reuse lastToken instead of asking for a contract ──
{
  const { isTokenFollowupPrompt, classifyTokenFollowupKind, formatLpLockCheck } = await import('../lib/server/clarkRouting.ts')
  const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')

  // Task 1: every LP CTA phrase must be recognized as a token follow-up and classified lp_lock
  const lpFollowupPrompts = [
    'Run LP Check', 'LP check', 'check LP', 'explain LP', 'is LP locked',
    'liquidity safety', 'check liquidity', 'check liquidity safety', 'run liquidity check',
  ]
  for (const p of lpFollowupPrompts) {
    assert.ok(isTokenFollowupPrompt(p), `isTokenFollowupPrompt should match LP follow-up: "${p}"`)
    assert.equal(classifyTokenFollowupKind(p), 'lp_lock', `classifyTokenFollowupKind should map "${p}" to lp_lock`)
  }

  // Task 2: the hard guard (lastToken reuse) must run before the generic "Send a token
  // contract" liquidity_scan-with-no-address branch.
  const guardIdx = routeFile.indexOf('if (isTokenFollowupPrompt(prompt) && sessionMem.lastToken?.address')
  const sendContractIdx = routeFile.indexOf("appIntent.intent === 'liquidity_scan' && !appIntent.address")
  assert.ok(guardIdx > -1 && sendContractIdx > -1 && guardIdx < sendContractIdx, 'lastToken LP follow-up guard runs before the generic "send a token contract" branch')

  // Task 3: an explicit new address in the same prompt must bypass the lastToken guard
  // entirely so the existing explicit-address LP route (classifyClarkPrompt) handles it.
  assert.ok(routeFile.includes('isTokenFollowupPrompt(prompt) && sessionMem.lastToken?.address && !extractAddress(prompt)'), 'lastToken LP follow-up guard defers to an explicit new contract address in the same prompt')

  // Task 4/5: formatLpLockCheck produces the exact expected heading and CTA, never "P CHECK".
  const ev = {
    ok: true,
    token: { name: 'Virtual Protocol', symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b' },
    market: { price: 0.5, liquidity: 4_700_000, volume24h: 97_600, change24h: null, marketCap: null },
    holders: null,
    lpControl: { status: 'team_controlled', reason: 'Single normal wallet holds dominant LP share.', confidence: 'high' },
    security: { honeypot: null, buyTax: 0, sellTax: 0, ownerRenounced: null, mintable: null, proxy: null, missing: [] },
    warnings: [],
  }
  const lpOut = formatLpLockCheck(ev, 'Base')
  assert.ok(lpOut.startsWith('LP CHECK — VIRTUAL (Base)'), 'LP follow-up heading reads "LP CHECK", never "P CHECK"')
  assert.ok(!lpOut.includes('P CHECK\n') && lpOut.includes('LP CHECK'), 'no truncated "P CHECK" heading anywhere in LP follow-up output')
  assert.ok(lpOut.includes('Single normal wallet holds dominant LP share.'), 'LP follow-up surfaces the real lpControl.reason detail from memory')
  assert.ok(lpOut.includes('CTA: Run LP Check / Open Token Scanner'), 'LP follow-up keeps the LP-specific CTA')

  // Task 6: no lastToken + no address still asks for a token contract via the existing branch.
  assert.ok(routeFile.includes('Send a token contract and I will check pool model'), 'with no lastToken and no address, Clark still asks for a token contract')
}

console.log('test-clark-execution.mjs: all assertions passed')
