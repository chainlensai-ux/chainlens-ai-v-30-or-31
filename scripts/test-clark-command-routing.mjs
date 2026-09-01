import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyClarkPrompt,
  parseClarkSlashCommand,
  parseClarkLiquidityIntent,
  isForcedLiquidityCheckPrompt,
  isLiquidityCheckIntent,
  isTokenFollowupPrompt,
  classifyTokenFollowupKind,
  getClarkAddressRouteHint,
  slashCommandQuestionCategory,
  isDeepScanItFollowup,
  resolveSlashCommandMemoryTarget,
  formatEoaLpCheckReply,
  formatTokenContractNotWalletReply,
  applyClarkLiquidityIntentLock,
} from '../lib/server/clarkRouting.ts'
import {
  resolveClarkContext,
  isTokenLikeClarkSubject,
} from '../lib/server/clarkContextResolver.ts'
import {
  rejectWrongChainLiquidityCache,
  formatClarkLiquidityCheck,
  mapEvmLiquiditySafetyPayload,
  mapSolanaLiquidityPayload,
} from '../lib/server/clarkLiquidityCheck.ts'

const BASE_TOKEN = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'
const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const PAIR = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const radarSrc = fs.readFileSync(new URL('../components/ClarkRadar.tsx', import.meta.url), 'utf8')
const memSrc = fs.readFileSync(new URL('../lib/client/clarkMemory.ts', import.meta.url), 'utf8')
const pageSrc = fs.readFileSync(new URL('../app/terminal/clark-ai/page.tsx', import.meta.url), 'utf8')
const routingSrc = fs.readFileSync(new URL('../lib/server/clarkRouting.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

// 1. /lp 0xTOKEN → LP check, not TOKEN READ, not wallet
{
  const r = classifyClarkPrompt(`/lp ${BASE_TOKEN}`)
  assert.equal(r.intent, 'liquidity_scan', '/lp 0xTOKEN must be liquidity_scan')
  assert.notEqual(r.intent, 'token_scan')
  assert.notEqual(r.intent, 'wallet_scan')
  assert.equal(r.address, BASE_TOKEN)
  assert.equal(getClarkAddressRouteHint(`/lp ${BASE_TOKEN}`), 'token')
  assert.equal(slashCommandQuestionCategory(`/lp ${BASE_TOKEN}`), 'token')
  assert.ok(isForcedLiquidityCheckPrompt(`/lp ${BASE_TOKEN}`))
  assert.equal(parseClarkLiquidityIntent(`/lp ${BASE_TOKEN}`), 'lp_check')
  const locked = applyClarkLiquidityIntentLock({ intent: 'token_scan', address: BASE_TOKEN, symbol: null }, `/lp ${BASE_TOKEN}`)
  assert.equal(locked.routed.intent, 'liquidity_scan')
}

{
  const r = classifyClarkPrompt(`check liquidity ${BASE_TOKEN}`)
  assert.equal(r.intent, 'liquidity_scan')
  assert.notEqual(r.intent, 'wallet_scan')
}
assert.equal(classifyClarkPrompt('liquidity check').intent, 'liquidity_scan', 'liquidity check = /lp')
assert.equal(classifyClarkPrompt(`/lp ${BASE_TOKEN}`).intent, classifyClarkPrompt(`liquidity check ${BASE_TOKEN}`).intent)
assert.equal(classifyClarkPrompt('check holders').intent, 'holders_check', 'check holders = /holders')
assert.equal(classifyClarkPrompt(`/holders ${BASE_TOKEN}`).intent, classifyClarkPrompt(`check holders ${BASE_TOKEN}`).intent)
assert.equal(classifyClarkPrompt('who deployed it').intent, 'deployer_check', 'who deployed it = /deployer')
assert.equal(classifyClarkPrompt(`/deployer ${BASE_TOKEN}`).intent, classifyClarkPrompt(`who deployed it ${BASE_TOKEN}`).intent)
assert.equal(classifyClarkPrompt(`/wallet ${WALLET}`).intent, 'wallet_scan')

// 2. /token 0xTOKEN then "what about LP?" → LP check on same token
{
  const tokenCmd = classifyClarkPrompt(`/token ${BASE_TOKEN}`)
  assert.equal(tokenCmd.intent, 'token_scan')
  assert.equal(tokenCmd.address, BASE_TOKEN)
  assert.notEqual(tokenCmd.intent, 'wallet_scan')
  assert.equal(getClarkAddressRouteHint(`/token ${BASE_TOKEN}`), 'token')
}
{
  const follow = classifyClarkPrompt('what about LP?')
  assert.equal(follow.intent, 'liquidity_scan', 'what about LP? must stay LP check, not TOKEN READ')
  assert.ok(isForcedLiquidityCheckPrompt('what about LP?') || isLiquidityCheckIntent('what about LP?'))
  assert.equal(classifyTokenFollowupKind('what about LP?'), 'lp_lock')
  const mem = {
    activeToken: {
      tokenAddress: BASE_TOKEN, chainSlug: 'base', chainId: 8453,
      symbol: 'AERO', name: 'Aerodrome', ts: Date.now() - 1000,
    },
  }
  const resolved = resolveClarkContext('what about LP?', mem)
  assert.equal(resolved.resolvedToken, BASE_TOKEN)
  assert.equal(resolved.needsClarification, false)
}

// 3. /wallet 0xWALLET then "deep scan it" → deep wallet scan
{
  const w = classifyClarkPrompt(`/wallet ${WALLET}`)
  assert.equal(w.intent, 'wallet_scan')
  assert.equal(w.address, WALLET)
  assert.equal(getClarkAddressRouteHint(`/wallet ${WALLET}`), 'wallet')
  assert.equal(slashCommandQuestionCategory(`/wallet ${WALLET}`), 'wallet')
}
assert.equal(isDeepScanItFollowup('deep scan it'), true)
assert.equal(isDeepScanItFollowup('deep scan this'), true)
assert.equal(isTokenFollowupPrompt('deep scan it'), false, 'deep scan it is a wallet action, never a token follow-up')
assert.match(routeCode, /deepScanItOnWallet/, 'route must intercept deep-scan-it after a wallet')
assert.match(routeCode, /routed\.intent = "wallet_scan"/, 'deep scan it after a wallet must force wallet_scan')
assert.match(routeCode, /routed\.deep = true/, 'deep scan it after a wallet must be a deep wallet scan')

// 4. /lp 0xWALLET → not applicable, not wallet portfolio
{
  const r = classifyClarkPrompt(`/lp ${WALLET}`)
  assert.equal(r.intent, 'liquidity_scan', '/lp on a wallet still classifies as LP, never wallet_scan')
  assert.notEqual(r.intent, 'wallet_scan')
}
{
  const filled = resolveSlashCommandMemoryTarget({
    command: 'lp',
    promptAddress: null,
    lastSubject: { entityType: 'wallet', address: WALLET },
  })
  assert.equal(filled.mismatch, 'wallet_not_token_or_pool')
}
const eoa = formatEoaLpCheckReply()
assert.ok(eoa.includes('This is a wallet, not a token or pool'))
assert.ok(eoa.includes('Liquidity checks do not apply'))
assert.ok(!/holdings|portfolio|walletScanHealth|PnL|pnl/i.test(eoa))
assert.match(routeCode, /formatEoaLpCheckReply\(\)/, 'wallet LP answers must use the not-applicable reply')
assert.match(routeCode, /slash_lp_on_wallet_subject/, '/lp on last wallet subject must not-applicable')

// 5. /wallet 0xTOKEN → not wallet, offer token scan
{
  const notWallet = formatTokenContractNotWalletReply('Base')
  assert.ok(notWallet.includes('token contract'))
  assert.ok(/not a wallet/i.test(notWallet))
  assert.ok(/Open Token Scanner/i.test(notWallet))
  assert.ok(!/Deep Scan Token/i.test(notWallet), 'token-contract-not-wallet reply must not show fake Deep Scan Token')
  assert.ok(!/WALLET READ|holdings count|PnL/i.test(notWallet))
}
assert.match(routeCode, /formatTokenContractNotWalletReply/, '/wallet on a token contract must use the not-wallet reply')
assert.equal(slashCommandQuestionCategory(`/wallet ${BASE_TOKEN}`), 'wallet', 'entity gate must treat /wallet as a wallet question')

// 6. /lp after token scan → same token, no re-ask
{
  const filled = resolveSlashCommandMemoryTarget({
    command: 'lp',
    promptAddress: null,
    lastSubject: { entityType: 'token', address: BASE_TOKEN },
    lastTokenAddress: BASE_TOKEN,
  })
  assert.equal(filled.address, BASE_TOKEN)
  assert.equal(filled.reusedSubject, true)
  assert.equal(filled.mismatch, null)
}
{
  const filled = resolveSlashCommandMemoryTarget({
    command: 'token',
    promptAddress: null,
    lastSubject: { entityType: 'token', address: BASE_TOKEN },
  })
  assert.equal(filled.address, BASE_TOKEN)
}

// 7. /lp SOLANA_MINT → LP check, not TOKEN READ
{
  const r = classifyClarkPrompt(`/lp ${SOL_MINT}`)
  assert.equal(r.intent, 'liquidity_scan', '/lp Solana mint must stay liquidity_scan')
  assert.notEqual(r.intent, 'token_scan')
  assert.equal(r.address, SOL_MINT)
  assert.ok(isForcedLiquidityCheckPrompt(`/lp ${SOL_MINT}`))
}
{
  const r = classifyClarkPrompt(`check liquidity ${SOL_MINT}`)
  assert.equal(r.intent, 'liquidity_scan')
}
{
  const locked = applyClarkLiquidityIntentLock({ intent: 'token_scan', address: SOL_MINT, symbol: null }, `/lp ${SOL_MINT}`)
  assert.equal(locked.routed.intent, 'liquidity_scan')
}
const sol = mapSolanaLiquidityPayload({
  resolvedTokenSymbol: 'WSOL',
  marketData: { liquidityUsd: 57_200, volume24hUsd: 12_000, marketCapUsd: 412_200, fdvUsd: 412_200, primaryDexLabel: 'Raydium', primaryPoolAddress: 'pool1' },
  poolProgram: { label: 'Raydium', poolAddress: 'pool1' },
  solanaEvidenceGaps: [],
  unsupportedChecks: [{ check: 'LP lock / burn proof' }],
}, { tokenAddressOrMint: SOL_MINT, symbol: 'WSOL' })
const solOut = formatClarkLiquidityCheck(sol)
assert.ok(solOut.startsWith('LIQUIDITY CHECK'))
assert.ok(!solOut.startsWith('TOKEN READ'))
assert.ok(!/technicalDebug/i.test(solOut))

// 8. Follow-up "is liquidity strong?" → same lastClarkSubject
{
  assert.ok(isForcedLiquidityCheckPrompt('is liquidity strong?') || isLiquidityCheckIntent('is liquidity strong?'))
  const r = classifyClarkPrompt('is liquidity strong?')
  assert.equal(r.intent, 'liquidity_scan')
  const resolved = resolveClarkContext('is liquidity strong?', {
    activeToken: {
      tokenAddress: BASE_TOKEN, chainSlug: 'base', chainId: 8453,
      symbol: 'AERO', name: 'Aerodrome', ts: Date.now() - 500,
    },
    lastClarkSubject: {
      entityType: 'token', chainSlug: 'base', chainId: 8453, address: BASE_TOKEN,
      symbol: 'AERO', name: 'Aerodrome', lastIntent: 'liquidity_scan', lastResultSummary: null, timestamp: Date.now() - 500,
    },
  })
  assert.equal(resolved.resolvedToken, BASE_TOKEN)
  assert.equal(resolved.resolvedChain, 'base')
  assert.equal(resolved.needsClarification, false)
}

// 9. Two recent tokens + "what about LP?" → ask which one
{
  const now = Date.now()
  const r = resolveClarkContext('what about LP?', {
    activeToken: {
      tokenAddress: BASE_TOKEN, chainSlug: 'base', chainId: 8453,
      symbol: 'AERO', name: 'Aerodrome', ts: now - 1000,
    },
    recentTokens: [
      { address: BASE_TOKEN, chainSlug: 'base', symbol: 'AERO', ts: now - 1000 },
      { address: PAIR, chainSlug: 'eth', symbol: 'OTHER', ts: now - 2000 },
    ],
  }, {}, now)
  assert.equal(r.needsClarification, true)
  assert.match(r.clarificationQuestion ?? '', /more than one token|Do you mean/i)
}

// 10. Missing chain on /lp → try supported LP chains, do not silently use Base-only cache
assert.equal(slashCommandQuestionCategory(`/lp ${BASE_TOKEN}`), 'token')
assert.match(routeCode, /slashCommandQuestionCategory/, 'entity gate must classify slash commands so auto-chain probe runs')
assert.match(routeCode, /const detected = await detectChainForAddress\(inlineAddress\);/, '/lp with no named chain must probe supported chains')
assert.match(routeCode, /const allChains: \(SupportedChain \| "robinhood"\)\[\] = \["base", "ethereum", "bnb"\];/, 'LP missing-chain probe includes Base, ETH, BNB')
assert.match(routeCode, /if \(isRobinhoodChainAvailable\(\)\) allChains\.push\("robinhood"\);/, 'LP missing-chain probe includes Robinhood when configured')
assert.equal(
  rejectWrongChainLiquidityCache(
    { chainSlug: 'base', tokenAddressOrMint: BASE_TOKEN },
    { chainSlug: 'ethereum', tokenAddressOrMint: BASE_TOKEN },
  ),
  true,
  'wrong-chain cached liquidity must be rejected',
)
assert.doesNotMatch(routeSrc, /runChain === "solana" \? "base"/, 'Solana LP memory must not collapse onto Base')

// Commands bypass generic routing
assert.match(routingSrc, /Command-first: \/lp \/token \/wallet \/base/, 'classifyClarkPrompt must parse slash commands first')
assert.equal(parseClarkSlashCommand(`/lp ${BASE_TOKEN}`)?.command, 'lp')
assert.equal(parseClarkSlashCommand(`/token ${BASE_TOKEN}`)?.intent, 'token_scan')
assert.equal(parseClarkSlashCommand(`/wallet ${WALLET}`)?.intent, 'wallet_scan')
assert.equal(parseClarkSlashCommand('/base')?.intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt('/base').intent, 'base_market_discovery')
assert.equal(isLiquidityCheckIntent(`scan this wallet ${WALLET}`), false)

// Bare /lp fills from last token, never asks again
assert.match(routeCode, /resolveSlashCommandMemoryTarget/, 'bare slash commands reuse lastClarkSubject')
assert.match(routeCode, /slashCanFill/, 'bare /token /wallet must not ask for input when last subject exists')

// Chips: /lp inserts "/lp " and auto-runs current-token LP when token context exists
assert.match(radarSrc, /resolveClarkCommandChipTarget/, 'ClarkRadar chips must read last token/wallet context')
assert.match(radarSrc, /sendToClark\(`\$\{prefix\} \$\{target\}`\)/, 'chip with token/wallet context must auto-run the command')
assert.match(radarSrc, /setInput\(`\$\{prefix\} `\)/, 'chip with no context must insert "/cmd "')
assert.match(pageSrc, /applyCommandChip/, 'clark-ai page chips must be real command modes')
assert.match(memSrc, /LAST_CLARK_SUBJECT_KEY/, 'client must persist lastClarkSubject')
assert.match(memSrc, /resolveClarkCommandChipTarget/, 'chip target helper must live in shared client memory')

// Raw debug fields never render
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
assert.ok(evmOut.startsWith('LIQUIDITY CHECK'))
assert.ok(evmOut.includes('Verdict:'))
assert.ok(!/technicalDebug/i.test(evmOut))
assert.ok(!evmOut.includes('walletScanHealth'))
assert.ok(!/goldrush|covalent|geckoterminal/i.test(evmOut))

assert.equal(isTokenLikeClarkSubject({
  entityType: 'token', chainSlug: 'base', chainId: 8453, address: BASE_TOKEN,
  symbol: 'AERO', name: 'Aerodrome', lastIntent: 'token_scan', lastResultSummary: null, timestamp: Date.now(),
}), true)

console.log('test-clark-command-routing.mjs: all assertions passed')
