import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyClarkPrompt,
  parseClarkLiquidityIntent,
  isLiquidityCheckIntent,
  isTokenFollowupPrompt,
  classifyTokenFollowupKind,
  getClarkAddressRouteHint,
  formatEoaLpCheckReply,
} from '../lib/server/clarkRouting.ts'
import {
  resolveClarkLiquidityEntity,
  inferLpPairFromPayload,
  buildClarkLiquidityRoutingAudit,
  rejectWrongChainLiquidityCache,
  formatClarkLiquidityCheck,
  formatUnknownLiquidityEntityReply,
  mapEvmLiquiditySafetyPayload,
} from '../lib/server/clarkLiquidityCheck.ts'

const TOKEN = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'
const WALLET = '0x1234567890123456789012345678901234567890'
const PAIR = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
const SOL_MINT = 'So11111111111111111111111111111111111111112'

// ─── Intent first: liquidity/LP/pool questions never default 0x to wallet ─────
const liquidityPrompts = [
  `liquidity check ${TOKEN}`,
  `check liquidity ${TOKEN}`,
  `how much liquidity does ${TOKEN} have`,
  `LP check ${TOKEN}`,
  `pool check ${PAIR}`,
  `is liquidity strong ${TOKEN}`,
]
for (const prompt of liquidityPrompts) {
  const r = classifyClarkPrompt(prompt)
  assert.equal(r.intent, 'liquidity_scan', `"${prompt}" must route as liquidity_scan, not ${r.intent}`)
  assert.notEqual(r.intent, 'wallet_scan', `"${prompt}" must never route to wallet_scan`)
  assert.ok(r.address, `"${prompt}" must keep the 0x address`)
  assert.equal(getClarkAddressRouteHint(prompt), 'token', `"${prompt}" route hint must be token, not wallet`)
}

assert.equal(parseClarkLiquidityIntent(`liquidity check ${TOKEN}`), 'liquidity_check')
assert.equal(parseClarkLiquidityIntent(`check liquidity ${TOKEN}`), 'liquidity_check')
assert.equal(parseClarkLiquidityIntent(`how much liquidity does ${TOKEN} have`), 'liquidity_check')
assert.equal(parseClarkLiquidityIntent(`is liquidity strong`), 'liquidity_check')
assert.equal(parseClarkLiquidityIntent(`LP check ${TOKEN}`), 'lp_check')
assert.equal(parseClarkLiquidityIntent(`pool check ${PAIR}`), 'pool_check')
assert.equal(parseClarkLiquidityIntent(`scan this wallet ${WALLET}`), null)
assert.ok(isLiquidityCheckIntent(`liquidity check ${TOKEN}`))
assert.ok(isLiquidityCheckIntent(`pool check ${PAIR}`))
assert.equal(isLiquidityCheckIntent(`scan this wallet ${WALLET}`), false)

{
  const r = classifyClarkPrompt(`liquidity check ${WALLET}`)
  assert.equal(r.intent, 'liquidity_scan', 'liquidity check on an EOA still classifies as liquidity, never wallet_scan')
}

{
  const r = classifyClarkPrompt(`scan this wallet ${WALLET}`)
  assert.equal(r.intent, 'wallet_scan', 'explicit wallet language still routes to wallet_scan')
}

// ─── Follow-up after token scan uses the same token ───────────────────────────
assert.equal(isTokenFollowupPrompt('what about liquidity?'), true)
assert.equal(classifyTokenFollowupKind('what about liquidity?'), 'lp_lock')
assert.equal(isTokenFollowupPrompt('is liquidity strong'), true)
assert.equal(classifyTokenFollowupKind('is liquidity strong'), 'lp_lock')

// ─── Entity resolution ────────────────────────────────────────────────────────
assert.equal(resolveClarkLiquidityEntity({ hasContractCode: false }), 'wallet')
assert.equal(resolveClarkLiquidityEntity({ hasContractCode: true, isLpPair: false }), 'token_contract')
assert.equal(resolveClarkLiquidityEntity({ hasContractCode: true, isLpPair: true }), 'lp_pair')
assert.equal(resolveClarkLiquidityEntity({ hasContractCode: null }), 'unknown')
assert.equal(inferLpPairFromPayload({ pairAddress: PAIR, token0: TOKEN, token1: WALLET }, PAIR), true)
assert.equal(inferLpPairFromPayload({ primaryPoolAddress: TOKEN }, PAIR), false)
assert.equal(inferLpPairFromPayload({ isLpPair: true }, PAIR), true)

// ─── Wallet not-applicable wording: no portfolio / PnL ────────────────────────
const eoa = formatEoaLpCheckReply()
assert.ok(eoa.includes('This is a wallet, not a token or pool'))
assert.ok(eoa.includes('Liquidity checks do not apply'))
assert.ok(!/holdings|portfolio|walletScanHealth|PnL|pnl/i.test(eoa))
assert.ok(!eoa.toLowerCase().includes('i can scan the wallet instead'))

const unknown = formatUnknownLiquidityEntityReply()
assert.ok(/token contract|LP\/pool|wallet/i.test(unknown))
assert.ok(unknown.includes('Base, Ethereum, Robinhood, or Solana'))

// ─── Real liquidity answer shape ──────────────────────────────────────────────
{
  const mapped = mapEvmLiquiditySafetyPayload({
    symbol: 'AERO',
    lp_total_liquidity_usd: 450_700,
    lpLockStatus: 'unverified',
    lpController: 'protocol',
    lpExitRisk: 'medium',
    displayLpModel: 'concentrated_liquidity',
    lpMeta: { primaryPoolAddress: PAIR, primaryPoolDex: 'Uniswap V3', primaryPoolType: 'v3' },
    pool_breakdown: [{ volume24h: 1_700_000, address: PAIR }],
    fdvUsd: 120_000_000,
  }, { chainSlug: 'base', tokenAddressOrMint: TOKEN, symbol: 'AERO' })
  const out = formatClarkLiquidityCheck(mapped)
  assert.ok(out.startsWith('LIQUIDITY CHECK — AERO'))
  assert.ok(out.includes('Chain: Base'))
  assert.ok(out.includes('Liquidity: $450.7K'))
  assert.ok(out.includes('DEX: Uniswap V3'))
  assert.ok(out.includes(`Pool: ${PAIR}`))
  assert.ok(out.includes('24h Volume: $1.70M'))
  assert.ok(out.includes('Exit risk: Medium'))
  assert.ok(out.includes('Confidence:'))
  assert.ok(out.includes('Evidence:'))
  assert.ok(out.includes('Meaning:'))
  assert.ok(out.includes('Open Token Scanner'))
  assert.ok(!out.toLowerCase().includes('wallet read'))
  assert.ok(!out.toLowerCase().includes('holdings count'))
  assert.ok(!/pnl partial/i.test(out))
  assert.ok(!/technicalDebug/i.test(out))
}

// ─── Wrong-chain cached liquidity rejected ────────────────────────────────────
assert.equal(
  rejectWrongChainLiquidityCache(
    { chainSlug: 'base', tokenAddressOrMint: TOKEN },
    { chainSlug: 'ethereum', tokenAddressOrMint: TOKEN },
  ),
  true,
  'wrong-chain cached liquidity must be rejected',
)
assert.equal(
  rejectWrongChainLiquidityCache(
    { chainSlug: 'base', tokenAddressOrMint: TOKEN },
    { chainSlug: 'base', tokenAddressOrMint: TOKEN },
  ),
  false,
)

// ─── Routing audit shape ──────────────────────────────────────────────────────
{
  const audit = buildClarkLiquidityRoutingAudit({
    prompt: `liquidity check ${TOKEN}`,
    parsedIntent: 'liquidity_check',
    address: TOKEN,
    requestedChain: 'base',
    hasContractCode: true,
    resolvedEntityType: 'token_contract',
    routeSelected: 'token_lp_module',
    liquiditySourcesAttempted: ['liquidity-safety'],
    liquiditySourcesSucceeded: ['liquidity-safety'],
    liquidityUsd: 450700,
    poolAddress: PAIR,
    dex: 'Uniswap V3',
    cacheChainMatched: true,
    notApplicableReason: null,
  })
  for (const key of [
    'prompt', 'parsedIntent', 'address', 'requestedChain', 'hasContractCode',
    'resolvedEntityType', 'routeSelected', 'liquiditySourcesAttempted',
    'liquiditySourcesSucceeded', 'liquidityUsd', 'poolAddress', 'dex',
    'cacheChainMatched', 'notApplicableReason',
  ]) {
    assert.ok(key in audit, `clarkLiquidityRoutingAudit missing ${key}`)
  }
}

{
  const walletAudit = buildClarkLiquidityRoutingAudit({
    prompt: `liquidity check ${WALLET}`,
    parsedIntent: 'liquidity_check',
    address: WALLET,
    hasContractCode: false,
    resolvedEntityType: 'wallet',
    routeSelected: 'not_applicable',
    notApplicableReason: 'wallet_not_token_or_pool',
  })
  assert.equal(walletAudit.routeSelected, 'not_applicable')
  assert.equal(walletAudit.resolvedEntityType, 'wallet')
}

// Solana mint still liquidity, never wallet
{
  const r = classifyClarkPrompt(`liquidity check ${SOL_MINT}`)
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.address, SOL_MINT)
}

// ─── Route source: never default 0x to wallet on liquidity, never leak portfolio
const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /clarkLiquidityRoutingAudit/, 'Clark route must emit clarkLiquidityRoutingAudit')
assert.match(routeCode, /parseClarkLiquidityIntent/, 'Clark route must parse liquidity sub-intent')
assert.match(routeCode, /liquidity_scan/, 'liquidity_scan must stay in TOKEN_INTENTS so wallet_scan cannot win')
assert.match(routeCode, /!isLiquidityCheckIntent\(prompt\)/, 'wallet-analysis page mode must skip liquidity questions')
assert.match(routeCode, /formatEoaLpCheckReply\(\)/, 'wallet liquidity answers must use the not-applicable reply')
assert.doesNotMatch(
  routeCode,
  /I can scan the wallet instead/,
  'liquidity questions must not offer a wallet-scan fallback in the LP READ body',
)
assert.match(routeCode, /formatUnknownLiquidityEntityReply/, 'unknown entity must ask for chain/token instead of guessing wallet')
assert.match(
  routeCode,
  /const addressKind = await classifyAddressForClark\(routed\.address, chainForClarkTools\);/,
  'EOA guard must keep the chain-aware classifyAddressForClark check',
)

console.log('test-clark-liquidity-routing.mjs: all assertions passed')
