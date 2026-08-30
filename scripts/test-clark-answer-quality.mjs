// Clark answer-quality pass: /lp /token /wallet and follow-ups must explain the result,
// without changing command routing or leaking raw debug fields.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  formatClarkLiquidityCheck,
  formatClarkLiquidityFollowup,
  formatClarkLiquidityLockFollowup,
  isLiquidityStrengthFollowupPrompt,
  isLiquidityLockFollowupPrompt,
  mapEvmLiquiditySafetyPayload,
  mapSolanaLiquidityPayload,
} from '../lib/server/clarkLiquidityCheck.ts'
import {
  classifyClarkPrompt,
  classifyTokenFollowupKind,
  formatFastTokenRead,
  formatLpLockCheck,
  formatTokenAnalystFollowup,
  formatTokenSafetyAnswer,
  formatWalletScanResult,
  renderClarkTokenVerdictForEvm,
  renderClarkTokenVerdictForSolana,
} from '../lib/server/clarkRouting.ts'

const ADDR = '0x1234567890123456789012345678901234567890'
const PAIR = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
const SOL_MINT = 'So11111111111111111111111111111111111111112'

function evmPayload(overrides = {}) {
  return mapEvmLiquiditySafetyPayload({
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
    ...overrides,
  }, { chainSlug: 'base', tokenAddressOrMint: ADDR, symbol: 'AERO' })
}

{
  assert.equal(classifyClarkPrompt('/lp ' + ADDR).intent, 'liquidity_scan')
  assert.equal(classifyClarkPrompt('/token ' + ADDR).intent, 'token_scan')
  assert.equal(classifyClarkPrompt('/wallet ' + ADDR).intent, 'wallet_scan')
  assert.equal(classifyClarkPrompt('is liquidity strong?').intent, 'liquidity_scan')
  assert.equal(classifyTokenFollowupKind('is it safe?'), 'safety')
  assert.equal(classifyTokenFollowupKind('what should I watch?'), 'analyst')
  assert.equal(isLiquidityStrengthFollowupPrompt('is liquidity strong?'), true)
  assert.equal(isLiquidityStrengthFollowupPrompt('is that enough liquidity'), true)
  assert.equal(isLiquidityStrengthFollowupPrompt(`/lp ${ADDR}`), false)
  assert.equal(isLiquidityStrengthFollowupPrompt('is LP locked'), false)
  assert.equal(isLiquidityLockFollowupPrompt('is LP locked'), true)
  assert.equal(isLiquidityLockFollowupPrompt('explain LP'), true)
  assert.equal(isLiquidityLockFollowupPrompt('is it locked?'), true)
  assert.equal(isLiquidityLockFollowupPrompt(`/lp ${ADDR}`), false)
  assert.equal(isLiquidityLockFollowupPrompt('is liquidity strong?'), false)
  assert.equal(isLiquidityLockFollowupPrompt('run LP check'), false)
  assert.equal(classifyClarkPrompt('is LP locked').intent, 'liquidity_scan')
}

{
  const out = formatClarkLiquidityCheck(evmPayload())
  assert.ok(out.startsWith('LIQUIDITY CHECK — AERO'))
  assert.match(out, /Verdict:/)
  assert.match(out, /Meaning:/)
  assert.match(out, /Missing evidence:/)
  assert.match(out, /Liquidity: \$450\.7K/)
  assert.match(out, /24h Volume:/)
  assert.match(out, /Volume\/liquidity ratio:/)
  assert.match(out, /Market cap:/)
  assert.match(out, /FDV:/)
  assert.match(out, /Chain: Base/)
  assert.match(out, /DEX: Uniswap V3/)
  assert.match(out, /Pool address:/)
  assert.match(out, /Exit risk:/)
  assert.match(out, /Confidence:/)
  assert.doesNotMatch(out, /technicalDebug/)
  assert.doesNotMatch(out, /walletScanHealth/)
}

{
  const follow = formatClarkLiquidityFollowup(evmPayload())
  assert.ok(follow.startsWith('LIQUIDITY READ — AERO'))
  assert.match(follow, /Is liquidity strong\?/)
  assert.match(follow, /Why:/)
  assert.match(follow, /Verdict:/)
  assert.match(follow, /Missing evidence:/)
  assert.doesNotMatch(follow, /^TOKEN READ/m)
  assert.doesNotMatch(follow, /technicalDebug/)
  assert.ok(!follow.startsWith('LIQUIDITY CHECK'), 'strength follow-up must not dump the full LP card')
  const full = formatClarkLiquidityCheck(evmPayload())
  assert.ok(follow.length < full.length, 'follow-up should be shorter than the full LP card')
}

{
  const lock = formatClarkLiquidityLockFollowup(evmPayload())
  assert.ok(lock.startsWith('LP LOCK READ — AERO'))
  assert.match(lock, /Is LP locked\?/)
  assert.match(lock, /Why:/)
  assert.match(lock, /Verdict:/)
  assert.match(lock, /Missing evidence:/)
  assert.match(lock, /concentrated pool/i)
  assert.doesNotMatch(lock, /^TOKEN READ/m)
  assert.doesNotMatch(lock, /^LIQUIDITY CHECK/m)
  assert.doesNotMatch(lock, /technicalDebug/)
  const full = formatClarkLiquidityCheck(evmPayload())
  assert.ok(lock.length < full.length, 'lock follow-up should be shorter than the full LP card')
}

{
  const sol = mapSolanaLiquidityPayload({
    resolvedTokenSymbol: 'BONK',
    marketData: { liquidityUsd: 800_000, primaryDexLabel: 'Raydium', primaryPoolAddress: 'pool1', pairAgeLabel: '42d' },
    poolProgram: { label: 'Raydium', poolAddress: 'pool1' },
  }, { tokenAddressOrMint: SOL_MINT, symbol: 'BONK' })
  const follow = formatClarkLiquidityFollowup(sol)
  assert.match(follow, /Is liquidity strong\?/)
  assert.match(follow, /Solana AMM/)
  assert.doesNotMatch(follow, /erc-?20\s+lp/i)
  assert.doesNotMatch(follow, /owner renounced/i)
  const lock = formatClarkLiquidityLockFollowup(sol)
  assert.match(lock, /Is LP locked\?/)
  assert.match(lock, /Solana AMM|not an EVM LP lock/i)
  assert.doesNotMatch(lock, /lock\/burn proof is verified/i)
  assert.doesNotMatch(lock, /owner renounced/i)
}

{
  const ev = {
    ok: true,
    token: { name: 'Test Token', symbol: 'TEST', address: ADDR },
    market: { price: 0.01, change24h: 5, volume24h: 100_000, liquidity: 80_000, marketCap: 1_000_000, fdv: 1_200_000 },
    holders: { top1: 4, top10: 18, holderCount: 900, status: 'ok' },
    security: { honeypot: false, buyTax: 1, sellTax: 1, ownerRenounced: true, mintable: false, proxy: false, blacklist: false, securityStatus: 'ok', simulationStatus: 'ok', riskLevel: 'Low', missing: [], missingReason: null },
    lpControl: { status: 'locked', reason: 'locked', confidence: 'High', poolType: 'v2', proofApplicability: 'applicable', displayLpModel: 'locked', lockStatus: 'locked', burnStatus: null, proofStatus: 'confirmed', rawLpState: 'locked', lpController: null, lpControllerType: null, positionProofStatus: 'confirmed', positionProofReason: null },
    deployerProfile: { rugHistory: 0 },
  }
  const rendered = renderClarkTokenVerdictForEvm(ev, ADDR, 'Base', true)
  assert.match(rendered, /^TOKEN READ/)
  assert.match(rendered, /Verdict:\s*\nSafer Watch/)
  assert.match(rendered, /Meaning:/)
  assert.match(rendered, /Market quality:/)
  assert.match(rendered, /LP\/liquidity:/)
  assert.match(rendered, /Holders\/concentration:/)
  assert.match(rendered, /Deployer\/ownership:/)
  assert.match(rendered, /Security checks:/)
  assert.match(rendered, /Risks:/)
  assert.doesNotMatch(rendered, /_token(Api|ScanDebug|RouteStatus)/i)
  assert.doesNotMatch(rendered, /walletScanHealth/)
}

{
  const rendered = renderClarkTokenVerdictForSolana({
    tokenAddress: SOL_MINT,
    tokenName: 'Bonk', tokenSymbol: 'BONK',
    mintAuthority: null, mintAuthorityResolved: true,
    freezeAuthority: null, freezeAuthorityResolved: true,
    marketCap: 500_000, fdv: 600_000, liquidityUsd: 90_000, volume24h: 40_000,
    primaryDexLabel: 'Raydium', primaryPoolAddress: 'PoolAddr1111111111111111111111111111111111',
    top1Pct: 5, top10Pct: 20, accountsSampled: 500,
    likelyCreator: 'CreatorAddr111111111111111111111111111111', creatorConfidenceTier: 'high',
    deployerRugHistoryCount: 0,
    usableEvidence: true,
  })
  assert.match(rendered, /Meaning:/)
  assert.match(rendered, /Creator\/authority:/)
  assert.match(rendered, /Check Creator/)
  assert.doesNotMatch(rendered, /\bproxy\b/i)
  assert.doesNotMatch(rendered, /\bowner renounced\b/i)
  assert.doesNotMatch(rendered, /honeypot simulation (?:flagged|detected|clear|not detected)/i)
}

{
  const safety = formatTokenSafetyAnswer({
    ok: false,
    token: { name: 'Virtual Protocol', symbol: 'VIRTUAL', address: ADDR },
    market: { price: 0.5, liquidity: 4_900_000, volume24h: 97_600, change24h: null, marketCap: null },
    holders: null,
    lpControl: null,
    security: { honeypot: null, buyTax: null, sellTax: null, ownerRenounced: null, mintable: null, proxy: null, missing: ['honeypot'] },
  }, 'Base')
  assert.ok(safety.startsWith('TOKEN SAFETY'))
  assert.match(safety, /Verdict:/)
  assert.match(safety, /^Safe\? Not enough confirmed evidence to call it safe\.$/m)
  assert.match(safety, /Why:/)
  assert.doesNotMatch(safety, /walletScanHealth/)
}

{
  const watch = formatTokenAnalystFollowup({
    ok: true,
    token: { name: 'Brett', symbol: 'BRETT', address: ADDR },
    market: { liquidity: 80_000, volume24h: 20_000 },
    holders: { top1: 22, top10: 45 },
    lpControl: { status: 'unverified' },
    security: { honeypot: false, ownerRenounced: false, mintable: false, proxy: false },
  }, 'Base')
  assert.match(watch, /WATCH READ/)
  assert.match(watch, /Should you watch it\?/)
  assert.match(watch, /Why watch:/)
  assert.match(watch, /Watch for \(risks\):/)
  assert.match(watch, /Ownership is active/)
  assert.doesNotMatch(watch, /walletScanHealth/)
}

{
  const fast = formatFastTokenRead({
    ok: false,
    token: { name: 'FastCoin', symbol: 'FAST', address: ADDR },
    market: { price: 0.01, liquidity: 50_000, volume24h: 5_000, change24h: null, marketCap: null },
    holders: null,
    lpControl: { status: 'open_check', reason: 'LP lock/burn proof not run in Clark fast mode.', confidence: 'open_check' },
    security: { honeypot: false, buyTax: null, sellTax: null, ownerRenounced: null, mintable: null, proxy: null, missing: [] },
  }, 'Base')
  assert.ok(fast.startsWith('TOKEN READ — fast evidence'))
  assert.match(fast, /Meaning:/)
  assert.match(fast, /Next:/)
  assert.match(fast, /LP: Open Check — full LP proof not run in Clark fast read/)
  assert.match(fast, /Holders: Open Check — holder scan not run in Clark fast read/)
  assert.doesNotMatch(fast, /lp lock\/burn proof confirmed/i)
  assert.doesNotMatch(fast, /walletScanHealth/)
}

{
  const lpMem = formatLpLockCheck({
    ok: true,
    token: { name: 'Brett', symbol: 'BRETT', address: ADDR },
    market: { liquidity: 80_000 },
    holders: null,
    lpControl: { status: 'unverified' },
    security: null,
  }, 'Base')
  assert.ok(lpMem.startsWith('LP CHECK — BRETT (Base)'))
  assert.match(lpMem, /^Status: LP proof not confirmed$/m)
  assert.match(lpMem, /Why:/)
  assert.match(lpMem, /Meaning:/)
  assert.match(lpMem, /Next:/)
  assert.doesNotMatch(lpMem, /lp lock\/burn proof confirmed/i)
}

{
  const lpSol = formatLpLockCheck({
    ok: true,
    token: { name: 'Bonk', symbol: 'BONK', address: SOL_MINT },
    market: { liquidity: 90_000 },
    lpControl: { status: 'locked', reason: 'should not be treated as EVM lock' },
  }, 'Solana')
  assert.match(lpSol, /not an EVM-style check on Solana/)
  assert.doesNotMatch(lpSol, /LP lock\/burn proof confirmed/)
}

{
  const out = formatWalletScanResult(ADDR, {
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
  assert.ok(out.includes('PnL status: Partial'))
  assert.ok(out.includes('Scan health: partial (PnL evidence limited)'))
  assert.match(out, /Portfolio value:/)
  assert.match(out, /Meaning:/)
  assert.match(out, /Behavior:/)
  assert.match(out, /Confidence:/)
  assert.match(out, /Deep Scan Wallet/)
  assert.ok(!out.includes('walletScanHealth'))
  assert.ok(!out.includes('walletModuleCoverage'))
  assert.doesNotMatch(out, /technicalDebug/)
}

{
  const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
  assert.match(routeSrc, /isLiquidityStrengthFollowupPrompt\(prompt\)/)
  assert.match(routeSrc, /formatClarkLiquidityFollowup\(check\)/)
  assert.match(routeSrc, /isLiquidityLockFollowupPrompt\(prompt\)/)
  assert.match(routeSrc, /formatClarkLiquidityLockFollowup\(check\)/)
  assert.match(routeSrc, /formatClarkLiquidityCheck\(check\)/)
}

console.log('test-clark-answer-quality.mjs: all assertions passed')
