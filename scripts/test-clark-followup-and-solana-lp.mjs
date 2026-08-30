import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyClarkPrompt,
  parseClarkLiquidityIntent,
  isForcedLiquidityCheckPrompt,
  isLiquidityCheckIntent,
  isTokenFollowupPrompt,
  classifyTokenFollowupKind,
  applyClarkLiquidityIntentLock,
  formatEoaLpCheckReply,
  isClarkWatchlistAddCommand,
} from '../lib/server/clarkRouting.ts'
import {
  formatClarkLiquidityCheck,
  mapEvmLiquiditySafetyPayload,
  mapSolanaLiquidityPayload,
  rejectWrongChainLiquidityCache,
  liquidityAnswerAuditFromResult,
  publicLiquidityVerdict,
  explainLiquidityMeaning,
} from '../lib/server/clarkLiquidityCheck.ts'
import {
  resolveClarkContext,
  buildClarkFollowupRoutingAudit,
  isTokenLikeClarkSubject,
} from '../lib/server/clarkContextResolver.ts'

const BASE_TOKEN = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'
const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const PAIR = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

// 1. liquidity check on a Base token routes to LIQUIDITY CHECK, never wallet
{
  const r = classifyClarkPrompt(`check liquidity ${BASE_TOKEN}`)
  assert.equal(r.intent, 'liquidity_scan')
  assert.notEqual(r.intent, 'wallet_scan')
  assert.equal(r.address, BASE_TOKEN)
}

// 2. Follow-up phrases lock to liquidity_scan so lastClarkSubject can be reused
for (const prompt of [
  'is liquidity strong?',
  'is that enough liquidity?',
  'what about LP?',
  'liquidity strong',
  'liquidity risk',
  'exit liquidity',
  'how much liquidity',
]) {
  assert.ok(isForcedLiquidityCheckPrompt(prompt) || isLiquidityCheckIntent(prompt), `"${prompt}" must be a liquidity intent`)
  const r = classifyClarkPrompt(prompt)
  assert.equal(r.intent, 'liquidity_scan', `"${prompt}" must route to liquidity_scan, not ${r.intent}`)
}

assert.equal(isTokenFollowupPrompt('is liquidity strong?'), true)
assert.equal(classifyTokenFollowupKind('is liquidity strong?'), 'lp_lock')
assert.equal(classifyTokenFollowupKind('is that enough liquidity?'), 'lp_lock')
assert.equal(isTokenFollowupPrompt('should I watch it?'), true)
assert.equal(classifyTokenFollowupKind('should I watch it?'), 'analyst')
assert.equal(isTokenFollowupPrompt('what about holders?'), true)
assert.equal(isClarkWatchlistAddCommand('should I watch it?'), false, 'should I watch it is a follow-up, not a watchlist write')
assert.equal(isClarkWatchlistAddCommand('add it to watchlist'), true)

// Memory resolver: follow-up after a Base token reuses that token and chain
{
  const mem = {
    activeToken: {
      tokenAddress: BASE_TOKEN, chainSlug: 'base', chainId: 8453,
      symbol: 'AERO', name: 'Aerodrome', ts: Date.now() - 1000,
    },
  }
  const r = resolveClarkContext('is liquidity strong?', mem)
  assert.equal(r.resolvedToken, BASE_TOKEN)
  assert.equal(r.resolvedChain, 'base')
  assert.equal(r.needsClarification, false)
  assert.equal(r.intent, 'liquidity_question')
}

// Two recent subjects -> ask which one, never guess
{
  const now = Date.now()
  const r = resolveClarkContext('is it safe?', {
    activeToken: {
      tokenAddress: BASE_TOKEN, chainSlug: 'base', chainId: 8453,
      symbol: 'AERO', name: 'Aerodrome', ts: now - 1000,
    },
    recentTokens: [
      { address: BASE_TOKEN, chainSlug: 'base', symbol: 'AERO', ts: now - 1000 },
      { address: WALLET, chainSlug: 'eth', symbol: 'OTHER', ts: now - 2000 },
    ],
  }, {}, now)
  assert.equal(r.needsClarification, true)
  assert.match(r.clarificationQuestion ?? '', /more than one token|Do you mean/i)
}

// 3 + 4. Solana liquidity prompts stay LIQUIDITY CHECK, never TOKEN READ
{
  const r = classifyClarkPrompt(`check liquidity ${SOL_MINT}`)
  assert.equal(r.intent, 'liquidity_scan', 'check liquidity <sol mint> must stay liquidity_scan')
  assert.notEqual(r.intent, 'token_scan')
  assert.equal(r.address, SOL_MINT)
}
{
  const r = classifyClarkPrompt(`liquidity check ${SOL_MINT}`)
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.address, SOL_MINT)
}
{
  const locked = applyClarkLiquidityIntentLock({ intent: 'token_scan', address: SOL_MINT, symbol: null }, `check liquidity ${SOL_MINT}`)
  assert.equal(locked.routed.intent, 'liquidity_scan')
  assert.equal(locked.audit.fallbackPrevented, true)
}

const sol = mapSolanaLiquidityPayload({
  resolvedTokenSymbol: 'SOLANASLOTH',
  marketData: {
    liquidityUsd: 57_200,
    volume24hUsd: 12_000,
    marketCapUsd: 412_200,
    fdvUsd: 412_200,
    primaryDexLabel: 'Raydium',
    primaryPoolAddress: 'pool1',
    pairAgeLabel: '42d',
  },
  poolProgram: { label: 'Raydium', poolAddress: 'pool1' },
  solanaEvidenceGaps: [],
  unsupportedChecks: [{ check: 'LP lock / burn proof' }],
}, { tokenAddressOrMint: SOL_MINT, symbol: 'SOLANASLOTH' })
const solOut = formatClarkLiquidityCheck(sol)
assert.ok(solOut.startsWith('LIQUIDITY CHECK — SOLANASLOTH'))
assert.ok(solOut.includes('Chain: Solana'))
assert.ok(solOut.includes('Meaning:'))
assert.ok(/Solana AMM/i.test(solOut))
assert.ok(solOut.includes('DEX / pool source:'))
assert.ok(solOut.includes('LP/control evidence:') || solOut.includes('LP lock proof is not an EVM-style check on Solana'))
assert.ok(!/erc-20/i.test(solOut))
assert.ok(!/honeypot tax/i.test(solOut))
assert.ok(!/contract verified/i.test(solOut))
assert.ok(!solOut.startsWith('TOKEN READ'))
assert.ok(!/technicalDebug/i.test(solOut))
assert.ok(!solOut.includes('Deep Scan Token'), 'LP answers must not show fake Deep Scan Token')
assert.ok(solOut.includes('/holders') || solOut.includes('/deployer'))
assert.ok(explainLiquidityMeaning(sol).length > 40)
assert.ok(['Decent', 'Thin', 'Partial', 'Risky', 'Strong'].includes(publicLiquidityVerdict(sol)))

const solAudit = liquidityAnswerAuditFromResult(`check liquidity ${SOL_MINT}`, sol)
for (const key of [
  'prompt', 'chainSlug', 'address', 'symbol', 'liquidityUsd', 'volume24hUsd',
  'volumeLiquidityRatio', 'marketCapUsd', 'fdvUsd', 'dex', 'poolAddress',
  'poolAge', 'verdict', 'confidence', 'sourcesUsed', 'missingEvidence',
]) {
  assert.ok(key in solAudit, `clarkLiquidityAnswerAudit missing ${key}`)
}
assert.equal(solAudit.chainSlug, 'solana')
assert.equal(solAudit.liquidityUsd, 57200)

// 5. Follow-up after Solana token read reuses the mint
{
  const r = resolveClarkContext('is liquidity strong?', {
    activeToken: {
      tokenAddress: SOL_MINT, chainSlug: 'solana', chainId: null,
      symbol: 'SOL', name: 'Wrapped SOL', ts: Date.now() - 500,
    },
  })
  assert.equal(r.resolvedToken, SOL_MINT)
  assert.equal(r.resolvedChain, 'solana')
  assert.equal(r.needsClarification, false)
}

// 6. Missing prior context -> ask for token/chain
{
  const r = resolveClarkContext('is liquidity strong?', {})
  assert.equal(r.needsClarification, true)
  assert.equal(r.resolvedToken, null)
}

// 7. Wallet + liquidity -> not applicable wording
{
  const eoa = formatEoaLpCheckReply()
  assert.ok(eoa.includes('This is a wallet, not a token or pool'))
  assert.ok(eoa.includes('Liquidity checks do not apply'))
  assert.ok(!/holdings|portfolio|walletScanHealth|PnL/i.test(eoa))
}
{
  const r = classifyClarkPrompt(`liquidity check ${WALLET}`)
  assert.equal(r.intent, 'liquidity_scan')
  assert.notEqual(r.intent, 'wallet_scan')
}

// 8. Token question never routes to wallet scanner
{
  const r = classifyClarkPrompt(`check liquidity ${BASE_TOKEN}`)
  assert.notEqual(r.intent, 'wallet_scan')
}

// 9. Wrong-chain cache rejected
assert.equal(
  rejectWrongChainLiquidityCache(
    { chainSlug: 'base', tokenAddressOrMint: BASE_TOKEN },
    { chainSlug: 'solana', tokenAddressOrMint: SOL_MINT },
  ),
  true,
)

// 10. Raw debug fields never shown
const evm = mapEvmLiquiditySafetyPayload({
  symbol: 'AERO',
  lp_total_liquidity_usd: 450_700,
  lpLockStatus: 'unverified',
  lpController: 'protocol',
  lpExitRisk: 'medium',
  displayLpModel: 'concentrated_liquidity',
  lpMeta: { primaryPoolAddress: PAIR, primaryPoolDex: 'Uniswap V3' },
  pool_breakdown: [{ volume24h: 1_700_000, address: PAIR }],
  fdvUsd: 120_000_000,
  marketCapUsd: 80_000_000,
}, { chainSlug: 'base', tokenAddressOrMint: BASE_TOKEN, symbol: 'AERO' })
const evmOut = formatClarkLiquidityCheck(evm)
assert.ok(evmOut.includes('Meaning:'))
assert.ok(evmOut.includes('Market cap:'))
assert.ok(evmOut.includes('Volume/liquidity ratio:'))
assert.ok(/concentrated/i.test(evmOut))
assert.ok(!/technicalDebug/i.test(evmOut))
assert.ok(!evmOut.includes('walletScanHealth'))

const followupAudit = buildClarkFollowupRoutingAudit({
  prompt: 'is liquidity strong?',
  hasNewAddress: false,
  previousSubject: {
    entityType: 'token', chainSlug: 'base', chainId: 8453, address: BASE_TOKEN,
    symbol: 'AERO', name: 'Aerodrome', lastIntent: 'liquidity_scan', lastResultSummary: null, timestamp: Date.now(),
  },
  reusedSubject: true,
  parsedIntent: 'liquidity_check',
  resolvedChain: 'base',
  resolvedAddress: BASE_TOKEN,
  routeSelected: 'liquidity_scan',
  reason: 'reused_last_clark_subject',
})
for (const key of ['prompt', 'hasNewAddress', 'previousSubject', 'reusedSubject', 'parsedIntent', 'resolvedChain', 'resolvedAddress', 'routeSelected', 'reason']) {
  assert.ok(key in followupAudit, `clarkFollowupRoutingAudit missing ${key}`)
}

assert.equal(isTokenLikeClarkSubject(followupAudit.previousSubject), true)

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
assert.match(routeSrc, /lastClarkSubject/, 'route must store lastClarkSubject')
assert.match(routeSrc, /clarkFollowupRoutingAudit/, 'route must emit clarkFollowupRoutingAudit')
assert.match(routeSrc, /clarkLiquidityAnswerAudit/, 'route must emit clarkLiquidityAnswerAudit')
assert.match(routeSrc, /rememberClarkSubject/, 'route must write lastClarkSubject on token/wallet/deployer memory updates')
assert.doesNotMatch(routeSrc, /runChain === "solana" \? "base"/, 'Solana LP memory must not collapse onto Base')
assert.match(routeSrc, /classifyTokenFollowupKind\(prompt\) !== "lp_lock"/, 'LP follow-ups must not take the TOKEN READ memory path')

console.log('test-clark-followup-and-solana-lp.mjs: all assertions passed')
