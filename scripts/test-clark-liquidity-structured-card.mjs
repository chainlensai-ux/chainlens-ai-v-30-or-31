// Tests for the Clark liquidity/LP structured-card task: every liquidity/LP query (whether phrased
// as "check liquidity" -> liquidity_scan, or "is LP locked"/"run LP check" -> lp_lock_check) must
// return the exact same LP-intelligence card shape, with a Verdict line locked to the task's fixed
// vocabulary (verified/partial/risky/unsupported proof/unavailable), never fabricated lock/burn/
// controller proof, and never EVM lock/burn wording leaking onto Solana or Base assumptions leaking
// onto Robinhood.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  runClarkLiquidityCheck,
  formatClarkLiquidityCheck,
  mapEvmLiquiditySafetyPayload,
  mapSolanaLiquidityPayload,
} from '../lib/server/clarkLiquidityCheck.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const ADDR = '0x1234567890123456789012345678901234567890'
const SOL_MINT = 'So11111111111111111111111111111111111111112'

const REQUIRED_CARD_LINES = [
  /^LIQUIDITY CHECK — /,
  /^Chain: /,
  /^Liquidity: /,
  /^Primary pool: /,
  /^LP model: /,
  /^Pool address: /,
  /^LP lock\/burn: /,
  /^Controller: /,
  /^Pool age: /,
  /^Exit risk: /,
  /^Confidence: /,
  /^Good signs:$/,
  /^Risks:$/,
  /^Missing LP evidence:$/,
  /^Verdict:$/,
  /^CTA:$/,
]

function assertFullCardShape(out, label) {
  for (const re of REQUIRED_CARD_LINES) {
    check(`${label}: card includes required line matching ${re}`, out.split('\n').some((l) => re.test(l)))
  }
  check(`${label}: CTA block lists all 3 required actions`, out.includes('- Open Token Scanner') && out.includes('- Run full LP Safety') && out.includes('- Add to Watchlist'))
}

// ── Verdict vocabulary is locked to the task's fixed words, per chain/status ─────────────────────
{
  const verified = mapEvmLiquiditySafetyPayload({
    symbol: 'AERO', lp_total_liquidity_usd: 12_000_000, lpLockStatus: 'locked', lpController: 'burn_address',
    lpMeta: { primaryPoolDex: 'Aerodrome' },
  }, { chainSlug: 'base', tokenAddressOrMint: ADDR, symbol: 'AERO' })
  check('a locked/burned pool with real liquidity verdicts exactly "Liquidity verified"', verified.verdict === 'Liquidity verified')
  assertFullCardShape(formatClarkLiquidityCheck(verified), 'base verified')
}
{
  const risky = mapEvmLiquiditySafetyPayload({
    symbol: 'RUG', lp_total_liquidity_usd: 5_000, lpLockStatus: 'unlocked', lpController: 'team wallet',
    lpMeta: { primaryPoolDex: 'Uniswap' },
  }, { chainSlug: 'ethereum', tokenAddressOrMint: ADDR, symbol: 'RUG' })
  check('an unlocked, wallet-controlled pool verdicts exactly "Liquidity risky"', risky.verdict === 'Liquidity risky')
  assertFullCardShape(formatClarkLiquidityCheck(risky), 'ethereum risky')
}
{
  const partial = mapEvmLiquiditySafetyPayload({
    symbol: 'CL', lp_total_liquidity_usd: 800_000, lpLockStatus: 'unverified', lpController: 'not verified',
    displayLpModel: 'concentrated_liquidity', lpProofApplicability: 'not_applicable',
    lpMeta: { primaryPoolDex: 'Uniswap V3' },
  }, { chainSlug: 'base', tokenAddressOrMint: ADDR, symbol: 'CL' })
  check('a concentrated-liquidity pool (lock/burn not applicable) verdicts exactly "Liquidity partial"', partial.verdict === 'Liquidity partial')
  assertFullCardShape(formatClarkLiquidityCheck(partial), 'base concentrated partial')
}
{
  const unavailable = mapEvmLiquiditySafetyPayload({ symbol: 'NONE' }, { chainSlug: 'base', tokenAddressOrMint: ADDR, symbol: 'NONE' })
  check('no liquidity data at all verdicts exactly "Liquidity unavailable"', unavailable.verdict === 'Liquidity unavailable')
  assertFullCardShape(formatClarkLiquidityCheck(unavailable), 'base unavailable')
}
{
  const rh = mapEvmLiquiditySafetyPayload({
    symbol: 'RH', lp_total_liquidity_usd: 50_000, lpLockStatus: 'unverified', lpMeta: { primaryPoolDex: 'Robinhood DEX' },
  }, { chainSlug: 'robinhood', tokenAddressOrMint: ADDR, symbol: 'RH' })
  check('Robinhood with detected liquidity but unsupported lock/controller proof verdicts exactly "Liquidity unsupported proof"', rh.verdict === 'Liquidity unsupported proof')
  const out = formatClarkLiquidityCheck(rh)
  assertFullCardShape(out, 'robinhood unsupported proof')
  check('Robinhood card discloses lock proof is unsupported, never fabricated as locked/burned', out.includes('LP lock proof unsupported for this Robinhood pool model'))
  check('Robinhood card discloses controller is not verified, never fabricated as verified', out.includes('LP controller not verified'))
  check('Robinhood card never uses Base/Ethereum-only wording like "renounced ownership"', !/renounced ownership/i.test(out))
}
{
  const rhEmpty = mapEvmLiquiditySafetyPayload({ symbol: 'RH2' }, { chainSlug: 'robinhood', tokenAddressOrMint: ADDR, symbol: 'RH2' })
  check('Robinhood with no liquidity at all verdicts exactly "Liquidity partial", never claims verified/risky from nothing', rhEmpty.verdict === 'Liquidity partial')
}
{
  const sol = mapSolanaLiquidityPayload({
    resolvedTokenSymbol: 'BONK',
    marketData: { liquidityUsd: 800_000, primaryDexLabel: 'Raydium', primaryPoolAddress: 'pool1', pairAgeLabel: '42d' },
    poolProgram: { label: 'Raydium', poolAddress: 'pool1' },
  }, { tokenAddressOrMint: SOL_MINT, symbol: 'BONK' })
  check('Solana with real AMM liquidity verdicts exactly "Liquidity partial" (no EVM lock/burn concept exists to claim "verified")', sol.verdict === 'Liquidity partial')
  const out = formatClarkLiquidityCheck(sol)
  assertFullCardShape(out, 'solana partial')
  check('Solana card shows pool age', out.includes('42d'))
  check('Solana card labels LP lock/burn as unsupported, never verified', /LP lock\/burn: unsupported/.test(out) && !/LP lock\/burn: verified/.test(out))
  check('Solana card never uses erc-20 lp wording', !/erc-?20\s+lp/i.test(out))
  check('Solana card labels controller as unsupported', /Controller: unsupported/.test(out))
}
{
  const solEmpty = mapSolanaLiquidityPayload({}, { tokenAddressOrMint: SOL_MINT, symbol: 'GONE' })
  check('Solana with no market data at all verdicts exactly "Liquidity unavailable"', solEmpty.verdict === 'Liquidity unavailable')
}

// ── runClarkLiquidityCheck's own empty-payload fallbacks also use the locked vocabulary ──────────
{
  const evmDown = await runClarkLiquidityCheck(
    { chainSlug: 'base', tokenAddressOrMint: ADDR, symbol: 'DOWN', source: 'clark' },
    { fetchEvmLiquidity: async () => null, fetchSolanaLiquidity: async () => null },
  )
  check('an EVM provider outage verdicts exactly "Liquidity unavailable", never fabricated data', evmDown.verdict === 'Liquidity unavailable')
}
{
  const solDown = await runClarkLiquidityCheck(
    { chainSlug: 'solana', tokenAddressOrMint: SOL_MINT, symbol: 'DOWN', source: 'clark' },
    { fetchEvmLiquidity: async () => null, fetchSolanaLiquidity: async () => null },
  )
  check('a Solana provider outage verdicts exactly "Liquidity unavailable", never fabricated data', solDown.verdict === 'Liquidity unavailable')
}

// ── lp_lock_check is no longer chain-blind: route.ts must resolve the real chain instead of
//    silently forcing "base" for a Robinhood/Solana "is LP locked" prompt ────────────────────────
{
  const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
  const lpLockStart = routeSrc.indexOf('if (routed.intent === "lp_lock_check")')
  check('located the lp_lock_check branch', lpLockStart > -1)
  const lpLockBlock = routeSrc.slice(lpLockStart, lpLockStart + 6000)
  const lpLockBlockCode = lpLockBlock.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  check('lp_lock_check no longer hardcodes chain: chain === "ethereum" ? "eth" : "base" (outside of comments)', !lpLockBlockCode.includes('chain: chain === "ethereum" ? "eth" : "base"'))
  check('lp_lock_check resolves the real requested chain via resolveLiquidityChainForClark, same as liquidity_scan', lpLockBlock.includes('resolveLiquidityChainForClark('))
  check('lp_lock_check calls the same chain-aware runClarkLiquidityCheck engine liquidity_scan uses', lpLockBlock.includes('runClarkLiquidityCheck('))
  check('lp_lock_check formats through the same structured card formatter, not the old chain-blind formatLpLockCheck', lpLockBlock.includes('formatClarkLiquidityCheck(check)') && !lpLockBlock.includes('formatLpLockCheck('))
  check('lp_lock_check still handles a Solana mint via the Solana-native path, never EVM-only', lpLockBlock.includes('isSol'))
  check('lp_lock_check still guards a wallet address (EOA) from being treated as a token LP check', lpLockBlock.includes('formatEoaLpCheckReply'))
}

console.log(`test-clark-liquidity-structured-card.mjs: all ${passed} assertions passed`)
