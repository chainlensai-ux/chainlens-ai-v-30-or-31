import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyClarkPrompt,
  parseClarkSlashCommand,
  resolveSlashCommandMemoryTarget,
  isForcedLiquidityCheckPrompt,
  isHoldersCheckPrompt,
  isDeployerCheckPrompt,
  isTokenFollowupPrompt,
  classifyTokenFollowupKind,
  formatTokenContractNotWalletReply,
  formatHoldersCheck,
  buildClarkTokenAnswerActions,
  buildClarkLpAnswerActions,
  buildClarkWalletAnswerActions,
  isClarkTrackWalletCommand,
} from '../lib/server/clarkRouting.ts'
import {
  formatClarkLiquidityCheck,
  formatClarkLiquidityLockFollowup,
  isLiquidityLockFollowupPrompt,
  mapEvmLiquiditySafetyPayload,
} from '../lib/server/clarkLiquidityCheck.ts'

const BASE_TOKEN = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'
const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const pageSrc = fs.readFileSync(new URL('../app/terminal/clark-ai/page.tsx', import.meta.url), 'utf8')
const configSrc = fs.readFileSync(new URL('../app/terminal/clark-ai/clarkAiPageConfig.ts', import.meta.url), 'utf8')
const radarSrc = fs.readFileSync(new URL('../components/ClarkRadar.tsx', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

// Slash commands
assert.equal(parseClarkSlashCommand(`/token ${BASE_TOKEN}`)?.intent, 'token_scan')
assert.equal(parseClarkSlashCommand(`/lp ${BASE_TOKEN}`)?.intent, 'liquidity_scan')
assert.equal(parseClarkSlashCommand(`/wallet ${WALLET}`)?.intent, 'wallet_scan')
assert.equal(parseClarkSlashCommand(`/deployer ${BASE_TOKEN}`)?.intent, 'deployer_check')
assert.equal(parseClarkSlashCommand(`/holders ${BASE_TOKEN}`)?.intent, 'holders_check')
assert.equal(parseClarkSlashCommand('/explain lp')?.intent, 'liquidity_scan')
assert.equal(parseClarkSlashCommand(`/explain lp ${BASE_TOKEN}`)?.address, BASE_TOKEN)
assert.equal(parseClarkSlashCommand('/explain')?.command, 'explain')
assert.equal(parseClarkSlashCommand('/explain risks'), null, '/explain risks is not /explain lp')
assert.equal(isForcedLiquidityCheckPrompt('/explain risks'), false, '/explain risks must not lock to LP')

assert.equal(classifyClarkPrompt(`/token ${BASE_TOKEN}`).intent, 'token_scan')
assert.equal(classifyClarkPrompt(`/lp ${BASE_TOKEN}`).intent, 'liquidity_scan')
assert.equal(classifyClarkPrompt(`/deployer ${BASE_TOKEN}`).intent, 'deployer_check')
assert.equal(classifyClarkPrompt(`/holders ${BASE_TOKEN}`).intent, 'holders_check')
assert.equal(classifyClarkPrompt(`/explain lp ${BASE_TOKEN}`).intent, 'liquidity_scan')
assert.equal(classifyClarkPrompt('/wallet ' + WALLET).intent, 'wallet_scan')

assert.equal(isHoldersCheckPrompt('holders?'), true)
assert.equal(isHoldersCheckPrompt('/holders'), true)
assert.equal(isDeployerCheckPrompt('who deployed it?'), true)
assert.equal(isDeployerCheckPrompt('/deployer'), true)
assert.equal(isForcedLiquidityCheckPrompt('/explain lp'), true)
assert.equal(isLiquidityLockFollowupPrompt('/explain lp'), true)
assert.equal(isLiquidityLockFollowupPrompt('what does LP mean?'), true)

assert.equal(isTokenFollowupPrompt('explain lp'), true)
assert.equal(isTokenFollowupPrompt('what does LP mean?'), true)
assert.equal(isTokenFollowupPrompt('holders'), true)
assert.equal(isTokenFollowupPrompt('holders?'), true)
assert.equal(isTokenFollowupPrompt('who deployed it?'), true)
assert.equal(isTokenFollowupPrompt('is it safe?'), true)
assert.equal(isTokenFollowupPrompt('should I watch it?'), true)
assert.equal(classifyTokenFollowupKind('holders?'), 'holders')
assert.equal(classifyTokenFollowupKind('who deployed it?'), 'deployer')
assert.equal(classifyTokenFollowupKind('what does LP mean?'), 'lp_lock')

// Follow-up memory: /explain lp, /holders, /deployer reuse last token
for (const command of ['explain', 'holders', 'deployer', 'lp', 'token']) {
  const filled = resolveSlashCommandMemoryTarget({
    command,
    promptAddress: null,
    lastSubject: { entityType: 'token', address: BASE_TOKEN },
    lastTokenAddress: BASE_TOKEN,
  })
  assert.equal(filled.address, BASE_TOKEN, `bare /${command} must reuse last token`)
  assert.equal(filled.reusedSubject, true)
}

// /explain lp with no token context is classified as LP, not token read
{
  const r = classifyClarkPrompt('/explain lp')
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.address, null)
}

// Token/LP answers must not show Deep Scan Token
const tokenActions = buildClarkTokenAnswerActions(BASE_TOKEN, 'base')
assert.ok(tokenActions.every((a) => a.label !== 'Deep Scan Token'))
assert.deepEqual(tokenActions.map((a) => a.label), ['/lp', '/holders', '/deployer', '/explain lp', 'Open Token Scanner', 'Add to Watchlist'])
const lpActions = buildClarkLpAnswerActions(BASE_TOKEN, 'base')
assert.ok(lpActions.every((a) => a.label !== 'Deep Scan Token'))
assert.deepEqual(lpActions.map((a) => a.label), ['/holders', '/deployer', '/explain lp', 'Open Token Scanner', 'Add to Watchlist'])
const walletActions = buildClarkWalletAnswerActions(WALLET)
assert.ok(walletActions.some((a) => a.label === 'Deep Scan Wallet'))
assert.deepEqual(walletActions.map((a) => a.label), ['Deep Scan Wallet', 'Open Wallet Scanner', 'Track Wallet', 'Explain PnL'])
assert.equal(isClarkTrackWalletCommand('track this wallet'), true)

const notWallet = formatTokenContractNotWalletReply('Base')
assert.ok(!/Deep Scan Token/i.test(notWallet))

const ev = {
  token: { symbol: 'AERO', address: BASE_TOKEN },
  holders: { top1: 12.5, top10: 41.2, holderCount: 18400 },
}
const holdersOut = formatHoldersCheck(ev, 'Base')
assert.ok(holdersOut.startsWith('HOLDERS READ'))
assert.match(holdersOut, /Top holder: 12\.5%/)
assert.match(holdersOut, /Top 10: 41\.2%/)
assert.match(holdersOut, /Holder count: 18,400/)
assert.doesNotMatch(holdersOut, /Deep Scan Token/)

const missingHolders = formatHoldersCheck({ token: { symbol: 'X' } }, 'Base')
assert.match(missingHolders, /unverified/)
assert.match(missingHolders, /top holder percent/)

const lpCard = formatClarkLiquidityCheck(mapEvmLiquiditySafetyPayload({
  symbol: 'AERO',
  lp_total_liquidity_usd: 450_700,
  lpLockStatus: 'unverified',
  displayLpModel: 'concentrated_liquidity',
}, { chainSlug: 'base', tokenAddressOrMint: BASE_TOKEN, symbol: 'AERO' }))
assert.doesNotMatch(lpCard, /Deep Scan Token/)
assert.match(lpCard, /\/holders/)
assert.match(lpCard, /\/deployer/)

const lock = formatClarkLiquidityLockFollowup(mapEvmLiquiditySafetyPayload({
  symbol: 'AERO',
  lp_total_liquidity_usd: 450_700,
  displayLpModel: 'concentrated_liquidity',
}, { chainSlug: 'base', tokenAddressOrMint: BASE_TOKEN, symbol: 'AERO' }))
assert.doesNotMatch(lock, /Deep Scan Token/)
assert.match(lock, /concentrated/i)
assert.match(lock, /standard LP lock\/burn proof does not apply/i)

assert.doesNotMatch(routeCode, /label: "Deep Scan Token"/)
assert.match(routeCode, /buildClarkTokenAnswerActions/)
assert.match(routeCode, /buildClarkLpAnswerActions/)
assert.match(routeCode, /buildClarkWalletAnswerActions/)
assert.match(routeCode, /routed\.intent === "holders_check"/)
assert.match(routeCode, /routed\.intent === "deployer_check"/)
assert.match(pageSrc, /\/holders/)
assert.match(pageSrc, /\/deployer/)
assert.match(configSrc, /\/holders/)
assert.match(radarSrc, /\/holders/)

console.log('test-clark-real-actions.mjs: all assertions passed')
