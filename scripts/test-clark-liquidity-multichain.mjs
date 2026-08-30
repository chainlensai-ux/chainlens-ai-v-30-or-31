import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyClarkPrompt,
  extractRequestedChainFromPrompt,
  extractLiquiditySymbol,
  isLiquidityCheckIntent,
  isTokenFollowupPrompt,
  classifyTokenFollowupKind,
} from '../lib/server/clarkRouting.ts'
import {
  runClarkLiquidityCheck,
  formatClarkLiquidityCheck,
  formatAmbiguousLiquiditySymbol,
  formatNeedsTokenLiquidityReply,
  rejectWrongChainLiquidityCache,
  clarkLiquidityCacheKey,
  mapEvmLiquiditySafetyPayload,
  mapSolanaLiquidityPayload,
} from '../lib/server/clarkLiquidityCheck.ts'

const ADDR = '0x1234567890123456789012345678901234567890'
const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'
const SOL_MINT = 'So11111111111111111111111111111111111111112'

{
  const r = classifyClarkPrompt('Liquidity check AERO')
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.symbol, 'AERO')
  assert.equal(r.address, null)
}
{
  const r = classifyClarkPrompt('Check LP for AERO on Base')
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.symbol, 'AERO')
  assert.equal(extractRequestedChainFromPrompt('Check LP for AERO on Base'), 'base')
}
{
  const r = classifyClarkPrompt(`LP check ${ADDR} on Ethereum`)
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.address, ADDR)
  assert.equal(extractRequestedChainFromPrompt(`LP check ${ADDR} on Ethereum`), 'ethereum')
}
{
  const r = classifyClarkPrompt(`liquidity check ${SOL_MINT}`)
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.address, SOL_MINT)
}
assert.equal(classifyClarkPrompt('is LP locked').intent, 'lp_lock_check')
assert.equal(classifyClarkPrompt('is liquidity safe').intent, 'lp_lock_check')
assert.ok(isLiquidityCheckIntent('liquidity safety for this token'))
assert.ok(isLiquidityCheckIntent('where is liquidity'))
assert.equal(extractLiquiditySymbol('Liquidity check AERO'), 'AERO')
assert.equal(extractLiquiditySymbol('liquidity check'), null)

assert.equal(isTokenFollowupPrompt('is it locked'), true)
assert.equal(classifyTokenFollowupKind('is it locked'), 'lp_lock')
assert.equal(classifyTokenFollowupKind('what about LP'), 'lp_lock')

const needs = formatNeedsTokenLiquidityReply()
assert.ok(needs.includes('Send a token contract and I will check pool model'))
assert.ok(needs.includes('Base, Ethereum, Robinhood, or Solana'))

{
  const mapped = mapEvmLiquiditySafetyPayload({
    symbol: 'AERO',
    lp_total_liquidity_usd: 12_000_000,
    lpLockStatus: 'locked',
    lpController: 'protocol',
    lpExitRisk: 'low',
    displayLpModel: 'v2',
    lpMeta: { primaryPoolAddress: AERO, primaryPoolDex: 'Aerodrome', primaryPoolType: 'v2', protocolPoolCandidatesCount: 2 },
    lp_evidence_gaps: [],
  }, { chainSlug: 'base', tokenAddressOrMint: AERO, symbol: 'AERO' })
  const out = formatClarkLiquidityCheck(mapped)
  assert.ok(out.startsWith('LIQUIDITY CHECK — AERO'))
  assert.ok(out.includes('Chain: Base'))
  assert.ok(out.includes('Liquidity: $12.00M'))
  assert.ok(!out.toLowerCase().includes('send a token contract'))
}

{
  const rh = mapEvmLiquiditySafetyPayload({
    symbol: 'RH',
    lp_total_liquidity_usd: 50_000,
    lpLockStatus: 'unverified',
    lpMeta: { primaryPoolDex: 'Robinhood DEX' },
  }, { chainSlug: 'robinhood', tokenAddressOrMint: ADDR, symbol: 'RH' })
  const out = formatClarkLiquidityCheck(rh)
  assert.ok(out.includes('LP lock proof unsupported for this Robinhood pool model'))
  assert.ok(out.includes('LP controller not verified'))
  assert.ok(out.includes('Liquidity detected but exit risk is partial'))
}

{
  const sol = mapSolanaLiquidityPayload({
    resolvedTokenSymbol: 'BONK',
    marketData: { liquidityUsd: 800_000, primaryDexLabel: 'Raydium', primaryPoolAddress: 'pool1', pairAgeLabel: '42d' },
    poolProgram: { label: 'Raydium', poolAddress: 'pool1' },
    solanaEvidenceGaps: [],
    unsupportedChecks: [{ check: 'LP lock / burn proof' }],
  }, { tokenAddressOrMint: SOL_MINT, symbol: 'BONK' })
  const out = formatClarkLiquidityCheck(sol)
  assert.ok(out.includes('Solana AMM liquidity detected'))
  assert.ok(out.includes('LP lock proof is not an EVM-style check on Solana'))
  assert.ok(!/erc-20 lp token/i.test(out))
  assert.ok(!out.toLowerCase().includes('burned lp'))
}

{
  const fetched = []
  const result = await runClarkLiquidityCheck({
    chainSlug: 'ethereum',
    tokenAddressOrMint: ADDR,
    symbol: 'TEST',
    source: 'clark',
    cached: {
      status: 'verified',
      chainSlug: 'base',
      symbol: 'WRONG',
      tokenAddressOrMint: ADDR,
      liquidityUsd: 1,
      poolCount: 1,
      primaryPool: null,
      dexName: null,
      pairAddress: null,
      lpModel: 'v2',
      lockBurnStatus: 'locked',
      controllerStatus: 'ok',
      exitRisk: 'Low',
      poolAge: null,
      confidence: 'High',
      missingEvidence: [],
      sourceLabels: [],
      goodSigns: [],
      risks: [],
      verdict: 'cached-wrong-chain',
      technicalDebug: {},
    },
  }, {
    fetchEvmLiquidity: async (tokenAddress, chain) => {
      fetched.push({ tokenAddress, chain })
      return { symbol: 'TEST', lp_total_liquidity_usd: 9_000, lpLockStatus: 'unverified', lpMeta: { primaryPoolDex: 'Uniswap' } }
    },
    fetchSolanaLiquidity: async () => null,
  })
  assert.equal(fetched.length, 1)
  assert.equal(fetched[0].chain, 'eth')
  assert.equal(result.chainSlug, 'ethereum')
  assert.notEqual(result.verdict, 'cached-wrong-chain')
  assert.equal(rejectWrongChainLiquidityCache({ chainSlug: 'base', tokenAddressOrMint: ADDR }, { chainSlug: 'ethereum', tokenAddressOrMint: ADDR }), true)
  assert.equal(clarkLiquidityCacheKey('ethereum', ADDR), `clarkLiquidity:ethereum:${ADDR.toLowerCase()}`)
}

{
  const out = formatAmbiguousLiquiditySymbol('AERO', [
    { address: AERO, chainSlug: 'base', symbol: 'AERO' },
    { address: ADDR, chainSlug: 'ethereum', symbol: 'AERO' },
  ])
  assert.ok(out.includes('Do you want AERO on Base or another chain?'))
  assert.ok(!out.toLowerCase().includes('send a token contract'))
}

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
assert.ok(routeSrc.includes('runClarkLiquidityCheck('), 'Clark route must call runClarkLiquidityCheck')
assert.ok(routeSrc.includes('clarkLiquidityCheckAudit'), 'Clark route must emit clarkLiquidityCheckAudit')
assert.ok(routeSrc.includes('formatNeedsTokenLiquidityReply'), 'empty LP check still uses the needs-token reply')
assert.ok(fs.readFileSync(new URL('../lib/server/clarkLiquidityCheck.ts', import.meta.url), 'utf8').includes('Send a token contract and I will check pool model'), 'no-target fallback still asks for a contract')
assert.match(routeSrc, /if \(!isSol\) \{[\s\S]*classifyAddressForClark\(routed\.address, chainForClarkTools\)/, 'EOA guard skipped for Solana mints')

console.log('test-clark-liquidity-multichain.mjs: all assertions passed')
