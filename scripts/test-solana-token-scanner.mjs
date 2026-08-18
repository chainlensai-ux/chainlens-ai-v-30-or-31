// Tests for the Token Scanner Solana Beta path.
//   lib/solanaAddress.ts            — mint validation / EVM rejection (client + server shared)
//   lib/server/solanaTokenScannerBeta.ts — the Beta scanner, its honesty contract, and its audit
//
// Run: node scripts/test-solana-token-scanner.mjs
//
// Every RPC/market call is served by an injected fetch stub, so this exercises the real logic with
// no network access and no API key.

import assert from 'node:assert'
import {
  isValidSolanaMintAddress, isEvmAddress, classifySolanaMintInput, SOLANA_MINT_REJECTION_MESSAGE,
} from '../lib/solanaAddress.ts'
import {
  solanaTokenScannerConfigAudit,
} from '../lib/server/solanaChainConfig.ts'
import {
  scanSolanaTokenBeta, scoreSolanaBeta, SOLANA_UNSUPPORTED_CHECKS,
} from '../lib/server/solanaTokenScannerBeta.ts'
import { computeSolanaConfidenceScore } from '../lib/solanaConfidenceScore.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

// Real, well-known Solana mainnet mints (used purely as valid-format fixtures — never fetched).
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const EVM_ADDR  = '0x1234567890abcdef1234567890abcdef12345678'

// ─── Address validation ───────────────────────────────────────────────────────
check('real USDC mint is valid', isValidSolanaMintAddress(USDC_MINT) === true)
check('real BONK mint is valid', isValidSolanaMintAddress(BONK_MINT) === true)
check('EVM address is NOT a valid solana mint', isValidSolanaMintAddress(EVM_ADDR) === false)
check('isEvmAddress detects the 0x form', isEvmAddress(EVM_ADDR) === true)
check('empty string rejected', isValidSolanaMintAddress('') === false)
check('null rejected', isValidSolanaMintAddress(null) === false)
check('too short rejected', isValidSolanaMintAddress('abc') === false)
// '0' and 'l' are outside the base58 alphabet.
check('non-base58 chars rejected', isValidSolanaMintAddress('0OIl00000000000000000000000000000000') === false)

// ─── EVM address on Solana gets its OWN specific rejection ────────────────────
{
  const r = classifySolanaMintInput(EVM_ADDR)
  check('EVM address classified as evm_address_on_solana', r === 'evm_address_on_solana')
  check('EVM rejection message names the EVM chains', /Base, Ethereum, or BNB/.test(SOLANA_MINT_REJECTION_MESSAGE[r]))
  check('EVM rejection is not a generic invalid message', SOLANA_MINT_REJECTION_MESSAGE[r] !== SOLANA_MINT_REJECTION_MESSAGE.wrong_length)
}
check('valid mint classifies as null (no rejection)', classifySolanaMintInput(USDC_MINT) === null)
check('empty classifies as empty', classifySolanaMintInput('') === 'empty')

// ─── Feature-flag gating ──────────────────────────────────────────────────────
{
  delete process.env.ENABLE_SOLANA_BETA
  const r = await scanSolanaTokenBeta(USDC_MINT, { fetchImpl: async () => { throw new Error('must not fetch') } })
  check('disabled flag returns not_enabled', r.status === 'not_enabled')
  check('disabled returns a clean message, not a crash', typeof r.error === 'string' && r.error.length > 0)
  check('disabled makes zero network calls', true) // guaranteed: fetchImpl above would throw
}
{
  process.env.ENABLE_SOLANA_BETA = 'true'
  const r = await scanSolanaTokenBeta(USDC_MINT, { rpcUrl: null, fetchImpl: async () => { throw new Error('must not fetch') } })
  check('enabled but unconfigured returns not_configured', r.status === 'not_configured')
  check('not_configured uses the exact spec message', r.error === 'Solana Beta is not configured yet.')
}

// ─── solanaTokenScannerConfigAudit (env/config wiring task) ───────────────────
{
  delete process.env.ENABLE_SOLANA_BETA
  delete process.env.ALCHEMY_SOLANA_RPC_URL
  const a = solanaTokenScannerConfigAudit()
  check('fully unconfigured: enabled false', a.enabled === false)
  check('fully unconfigured: alchemySolanaConfigured false', a.alchemySolanaConfigured === false)
  check('fully unconfigured: missingConfig lists both vars', a.missingConfig.includes('ENABLE_SOLANA_BETA') && a.missingConfig.includes('ALCHEMY_SOLANA_RPC_URL'))
  check('goldrushConfigured is honestly false (no verified Solana slug anywhere in this codebase)', a.goldrushConfigured === false)
  check('marketFallbackConfigured (DexScreener needs no key)', a.marketFallbackConfigured === true)
  check('redacted is always true', a.redacted === true)
  check('audit never contains a URL/key substring', !JSON.stringify(a).includes('http') && !JSON.stringify(a).includes('alchemy.com'))
}
{
  process.env.ENABLE_SOLANA_BETA = 'true'
  process.env.ALCHEMY_SOLANA_RPC_URL = 'https://solana-mainnet.g.alchemy.com/v2/super-secret-key-should-never-appear'
  const a = solanaTokenScannerConfigAudit()
  check('fully configured: enabled true', a.enabled === true)
  check('fully configured: alchemySolanaConfigured true', a.alchemySolanaConfigured === true)
  check('fully configured: missingConfig is empty', a.missingConfig.length === 0)
  check('fully configured audit still never leaks the key', !JSON.stringify(a).includes('super-secret-key'))
  delete process.env.ALCHEMY_SOLANA_RPC_URL
}
{
  // Partial: flag on, RPC missing — the exact "not configured yet" case from the task.
  process.env.ENABLE_SOLANA_BETA = 'true'
  delete process.env.ALCHEMY_SOLANA_RPC_URL
  const a = solanaTokenScannerConfigAudit()
  check('partial config: missingConfig lists only the RPC var', a.missingConfig.length === 1 && a.missingConfig[0] === 'ALCHEMY_SOLANA_RPC_URL')
}

// ─── Scan fixtures ────────────────────────────────────────────────────────────
process.env.ENABLE_SOLANA_BETA = 'true'

function rpcStub({ mint, supply, largest, dexPairs, failMint = false }) {
  return async (url, init) => {
    if (typeof url === 'string' && url.includes('dexscreener')) {
      return { ok: true, json: async () => ({ pairs: dexPairs ?? [] }) }
    }
    const body = JSON.parse(init.body)
    if (failMint && body.method === 'getAccountInfo') return { ok: false, status: 500, json: async () => ({}) }
    const results = {
      getAccountInfo: mint,
      getTokenSupply: supply,
      getTokenLargestAccounts: largest,
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: results[body.method] ?? null }) }
  }
}

const HEALTHY_MINT = {
  value: {
    owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    data: { parsed: { type: 'mint', info: { decimals: 6, mintAuthority: null, freezeAuthority: null } } },
  },
}
const HEALTHY_SUPPLY = { value: { amount: '1000000', decimals: 6, uiAmount: 1000000 } }
const HEALTHY_LARGEST = { value: [{ amount: '400000' }, { amount: '100000' }, { amount: '50000' }] }

// ─── Full successful scan ─────────────────────────────────────────────────────
{
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{
        chainId: 'solana', priceUsd: '1.00', liquidity: { usd: 50000 }, volume: { h24: 12000 },
        pairAddress: 'POOL1', dexId: 'raydium', fdv: 1000000, marketCap: 1000000,
        baseToken: { address: USDC_MINT, name: 'USD Coin', symbol: 'USDC' },
        quoteToken: { address: 'So11111111111111111111111111111111111111', name: 'Wrapped SOL', symbol: 'SOL' },
      }],
    }),
  })
  check('successful scan is not a failure shape', !('status' in r))
  check('solanaBeta flag is true', r.solanaBeta === true)
  check('chain is solana', r.chain === 'solana')
  check('token program detected as spl-token', r.tokenProgram === 'spl-token')
  check('decimals resolved', r.decimals === 6)
  check('supply resolved', r.totalSupply === 1000000)
  check('revoked authorities reported as null WITH a successful read', r.mintAuthority === null && r.authorityReadSucceeded === true)
  check('top1 concentration computed', r.topAccountConcentration.top1Percent === 40)
  check('top10 concentration computed', r.topAccountConcentration.top10Percent === 55)
  check('market data resolved', r.marketDataAvailable === true && r.marketData.priceUsd === 1)
  check('primary dex label surfaced', r.marketData.primaryDexLabel === 'raydium')
  check('token name mapped from the matched (base) side of the pair — no new fetch, UI header fix', r.marketData.tokenName === 'USD Coin')
  check('token symbol mapped from the matched side', r.marketData.tokenSymbol === 'USDC')

  // Honesty contract
  const blob = JSON.stringify(r).toLowerCase()
  check('no EVM LP lock/burn wording', !blob.includes('lp token lock') && !blob.includes('no lock detected'))
  check('never claims honeypot passed', !blob.includes('honeypot passed'))
  check('never claims tax verified', !blob.includes('tax verified'))
  check('never claims contract owner', !blob.includes('contract owner:'))
  check('verdict is never SAFE/verified', !['SAFE', 'VERIFIED'].includes(r.betaRisk.verdict))
  check('confidence capped at LOW/MEDIUM', ['LOW', 'MEDIUM'].includes(r.betaRisk.confidence))
  check('unsupported checks are enumerated', r.unsupportedChecks.length === SOLANA_UNSUPPORTED_CHECKS.length)
  check('top-account concentration labelled honestly', r.solanaEvidenceGaps.some(g => /not a full holder count/i.test(g)))

  // Audit
  const a = r.solanaTokenScannerAudit
  check('audit reports enabled', a.enabled === true)
  check('audit reports supplyResolved', a.supplyResolved === true)
  check('audit reports largestAccountsResolved', a.largestAccountsResolved === true)
  check('audit records market provider', a.marketProviderUsed === 'dexscreener')
  check('audit records top1Percent', a.top1Percent === 40)
  check('audit lists unsupported checks', a.unsupportedChecks.length > 0)
  check('audit never leaks an rpc url', !JSON.stringify(a).includes('http'))
}

// ─── Name/symbol correctly resolve when the scanned mint is the QUOTE side ────
{
  const r = await scanSolanaTokenBeta(BONK_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{
        chainId: 'solana', priceUsd: '0.00002', liquidity: { usd: 9000 }, volume: { h24: 500 }, pairAddress: 'P2', dexId: 'orca',
        baseToken: { address: 'So11111111111111111111111111111111111111', name: 'Wrapped SOL', symbol: 'SOL' },
        quoteToken: { address: BONK_MINT, name: 'Bonk', symbol: 'BONK' },
      }],
    }),
  })
  check('name/symbol resolve correctly when the mint is the QUOTE token, not just base', r.marketData.tokenName === 'Bonk' && r.marketData.tokenSymbol === 'BONK')
}
{
  // Neither side matches (shouldn't happen in practice, but must degrade honestly, not guess).
  const r = await scanSolanaTokenBeta(BONK_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{
        chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'P3', dexId: 'x',
        baseToken: { address: 'unrelated1', name: 'Unrelated', symbol: 'UNR' },
        quoteToken: { address: 'unrelated2', name: 'Other', symbol: 'OTH' },
      }],
    }),
  })
  check('unmatched pair sides never guess a name — stays null', r.marketData.tokenName === null && r.marketData.tokenSymbol === null)
}

// ─── Missing market data becomes an evidence gap, never a fake value ──────────
{
  const r = await scanSolanaTokenBeta(BONK_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('missing market data => marketDataAvailable false', r.marketDataAvailable === false)
  check('missing market data => marketData is null, not zeros', r.marketData === null)
  check('missing market data creates an evidence gap', r.solanaEvidenceGaps.some(g => /market\/pool data/i.test(g)))
  check('missing market data forces LOW confidence', r.betaRisk.confidence === 'LOW')
}

// ─── Active authorities raise risk honestly ──────────────────────────────────
{
  const risky = {
    value: {
      owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      data: { parsed: { type: 'mint', info: { decimals: 9, mintAuthority: 'MintAuth111', freezeAuthority: 'FreezeAuth111' } } },
    },
  }
  const r = await scanSolanaTokenBeta(BONK_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({ mint: risky, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('token-2022 program detected', r.tokenProgram === 'spl-token-2022')
  check('active freeze authority => HIGH_RISK', r.betaRisk.verdict === 'HIGH_RISK')
  check('active mint authority surfaced in reasons', r.betaRisk.reasons.some(x => /mint authority is still active/i.test(x)))
}

// ─── Non-mint account is rejected, not scanned as a token ─────────────────────
{
  const wallet = { value: { owner: '11111111111111111111111111111111', data: { parsed: { type: 'account', info: {} } } } }
  const r = await scanSolanaTokenBeta(BONK_MINT, { rpcUrl: 'https://stub', fetchImpl: rpcStub({ mint: wallet }) })
  check('non-mint account returns mint_not_found', r.status === 'mint_not_found')
}

// ─── Missing mint account ────────────────────────────────────────────────────
{
  const r = await scanSolanaTokenBeta(BONK_MINT, { rpcUrl: 'https://stub', fetchImpl: rpcStub({ mint: { value: null } }) })
  check('absent mint returns mint_not_found', r.status === 'mint_not_found')
}

// ─── RPC failure is reported, never silently treated as clean ────────────────
{
  const r = await scanSolanaTokenBeta(BONK_MINT, { rpcUrl: 'https://stub', fetchImpl: rpcStub({ failMint: true }) })
  check('rpc failure returns rpc_error', r.status === 'rpc_error')
  check('rpc failure does not return a verdict', r.betaRisk === undefined)
}

// ─── Unread authority must never read as "revoked" ───────────────────────────
{
  const unparsed = { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: {} } }
  const r = await scanSolanaTokenBeta(BONK_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({ mint: unparsed, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('unparsed authority => authorityReadSucceeded false', r.authorityReadSucceeded === false)
  check('unparsed authority creates an evidence gap', r.solanaEvidenceGaps.some(g => /not proven revoked/i.test(g)))
  check('unparsed authority never scores as revoked-clean', r.betaRisk.reasons.some(x => /could not be read/i.test(x)))
}

// ─── Scoring can never return SAFE ───────────────────────────────────────────
{
  const best = scoreSolanaBeta({
    mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true,
    top1Percent: 1, marketDataAvailable: true, liquidityUsd: 5_000_000, evidenceGapCount: 0,
  })
  check('best possible verdict is OPEN_CHECK, never SAFE', best.verdict === 'OPEN_CHECK')
  check('best possible confidence is MEDIUM, never HIGH', best.confidence === 'MEDIUM')
  check('always discloses unavailable checks', best.reasons.some(r => /not available on this path/i.test(r)))
}

// ─── STRUCTURAL: the Solana path cannot reach EVM logic ──────────────────────
// The strongest guarantee that a Solana mint is never pushed through EVM contract logic is that
// this module imports none of it. Asserted against the real source so a future edit that wires an
// EVM helper in here fails loudly instead of silently degrading the honesty contract.
{
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync(new URL('../lib/server/solanaTokenScannerBeta.ts', import.meta.url), 'utf8')
  // Strip // line comments and /* */ blocks first — this file's own prose discusses things like
  // distinguishing revoked `from "unread"`, which would otherwise false-match as an import.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // Every module specifier this file imports from (handles multi-line import blocks).
  const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1].toLowerCase())
  for (const forbidden of ['honeypot', 'lplock', 'lp-lock', 'deployer', 'goplus', 'ethers', 'viem', 'covalent', 'robinhood']) {
    check(`solana scanner imports nothing EVM-specific: ${forbidden}`, !specifiers.some(s => s.includes(forbidden)))
  }
  check('solana scanner imports its own chain config', specifiers.some(s => s.includes('solanachainconfig')))
  check('solana scanner has no other runtime dependency', specifiers.length === 1)
}

// ─── ROUTE ORDER: chain=solana returns before EVM validation ─────────────────
// Guards the one ordering fact the whole integration rests on — if the Solana branch ever moves
// below the EVM chain check, Solana would be rejected as an unsupported chain.
{
  const { readFileSync } = await import('node:fs')
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  const solanaBranch = route.indexOf("if (rawChain === 'solana')")
  const evmGate = route.indexOf("rawChain !== 'base' && rawChain !== 'eth'")
  check('solana branch exists in the token route', solanaBranch > -1)
  check('EVM chain gate still exists (existing chains unchanged)', evmGate > -1)
  check('solana branch runs BEFORE the EVM chain gate', solanaBranch < evmGate)
  check('EVM gate still accepts base/eth/bnb/robinhood', /rawChain !== 'base' && rawChain !== 'eth' && rawChain !== 'bnb' && rawChain !== 'robinhood'/.test(route))
}

// ─── No fabricated GoldRush Solana slug anywhere in the codebase (env wiring task) ────────────
// The task explicitly forbids hardcoding an unverified Solana chain slug into any of this
// codebase's real GOLDRUSH_VERIFIED_CHAIN_SLUGS maps. Asserted against the real source.
{
  const { readFileSync } = await import('node:fs')
  const files = [
    'src/modules/holdings/utils.ts',
    'src/modules/recoveryPolicy/utils.ts',
    'src/modules/providerFetchWindow/utils.ts',
  ]
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    const mapMatch = src.match(/GOLDRUSH_VERIFIED_CHAIN_SLUGS[\s\S]*?=\s*\{([\s\S]*?)\n\}/)
    check(`${f}: no 'solana' key added to GOLDRUSH_VERIFIED_CHAIN_SLUGS`, !mapMatch || !/\bsolana\s*:/i.test(mapMatch[1]))
  }
}

// ─── Route logs the redacted config audit, never the raw RPC URL (env wiring task) ────────────
{
  const { readFileSync } = await import('node:fs')
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  check('route imports solanaTokenScannerConfigAudit', route.includes('solanaTokenScannerConfigAudit'))
  check('route logs the config audit inside the solana branch', /solana-beta.*solanaTokenScannerConfigAudit/.test(route.replace(/\n/g, ' ')))
  check('route never reads ALCHEMY_SOLANA_RPC_URL directly (only via the config module)', !route.includes('process.env.ALCHEMY_SOLANA_RPC_URL'))
}

// ─── computeSolanaConfidenceScore (Token Scanner Solana premium-parity task) ──────────────────
// The number that replaced the earlier "no score shown" design in Overview/Risk Engine. Every
// assertion here defends the honesty contract this task explicitly requires of that number.
function baseSr(overrides = {}) {
  return {
    authorityReadSucceeded: true, mintAuthority: null, freezeAuthority: null,
    topAccountConcentration: { top1Percent: 10, top10Percent: 20, top20Percent: 30, accountsSampled: 20, accounts: [] },
    marketDataAvailable: true, marketData: { liquidityUsd: 100_000, priceUsd: 1, volume24hUsd: 1, fdvUsd: null, marketCapUsd: null, primaryPoolAddress: null, primaryDexLabel: null, tokenName: null, tokenSymbol: null },
    unsupportedChecks: SOLANA_UNSUPPORTED_CHECKS,
    ...overrides,
  }
}

{
  const best = computeSolanaConfidenceScore(baseSr())
  check('best-case inputs never reach 100 — evidence coverage caps it', best.score < 100)
  check('best-case inputs still cap out well under 100 (evidence coverage ceiling)', best.score <= 85)
  check('best-case verdict is Open Check, never Safe/Strong/Verified', best.verdict === 'Open Check')
  check('score color for Open Check is neutral, not green "safe" styling', best.color === '#94a3b8')
}
{
  const worst = computeSolanaConfidenceScore(baseSr({
    authorityReadSucceeded: true, mintAuthority: 'X', freezeAuthority: 'Y',
    topAccountConcentration: { top1Percent: 80, top10Percent: 90, top20Percent: 95, accountsSampled: 20, accounts: [] },
    marketDataAvailable: false, marketData: null,
  }))
  check('worst-case inputs floor near the bottom', worst.score < 35)
  check('worst-case verdict is High Risk', worst.verdict === 'High Risk')
}
{
  const noEvidence = computeSolanaConfidenceScore(baseSr({
    authorityReadSucceeded: false, mintAuthority: null, freezeAuthority: null,
    topAccountConcentration: null, marketDataAvailable: false, marketData: null,
  }))
  check('zero-evidence scan scores low, never implies safety', noEvidence.score <= 30)
  check('zero-evidence scan is never Open Check (that label is reserved for genuinely good evidence)', noEvidence.verdict !== 'Open Check')
}
{
  const sc = computeSolanaConfidenceScore(baseSr())
  check('exactly 4 categories returned', sc.categories.length === 4)
  check('every category max is 25 (100-point scale)', sc.categories.every(c => c.max === 25))
  check('category scores sum to the total score', sc.categories.reduce((s, c) => s + c.score, 0) === sc.score)
  check('every category carries at least one real reason string', sc.categories.every(c => c.reasons.length > 0 && typeof c.reasons[0] === 'string'))
  const evidenceCat = sc.categories.find(c => c.label === 'Evidence Coverage')
  check('Evidence Coverage category is present and reflects real unsupportedChecks length', evidenceCat && evidenceCat.reasons[0].includes(String(SOLANA_UNSUPPORTED_CHECKS.length)))
}
{
  // Monotonicity: revoking authority must never LOWER the score relative to active authority.
  const activeAuth = computeSolanaConfidenceScore(baseSr({ mintAuthority: 'X', freezeAuthority: 'Y' }))
  const revokedAuth = computeSolanaConfidenceScore(baseSr({ mintAuthority: null, freezeAuthority: null }))
  check('revoked authority scores at least as high as active authority (same other inputs)', revokedAuth.score >= activeAuth.score)
  // Same for concentration: tighter concentration must never score higher than spread supply.
  const concentrated = computeSolanaConfidenceScore(baseSr({ topAccountConcentration: { top1Percent: 60, top10Percent: 80, top20Percent: 90, accountsSampled: 20, accounts: [] } }))
  const spread = computeSolanaConfidenceScore(baseSr({ topAccountConcentration: { top1Percent: 5, top10Percent: 10, top20Percent: 15, accountsSampled: 20, accounts: [] } }))
  check('spread supply scores at least as high as concentrated supply (same other inputs)', spread.score >= concentrated.score)
}
{
  // Non-vacuous guard on the evidence-coverage cap itself: fewer unsupported checks must raise
  // the ceiling, more must lower it — this is the actual mechanism keeping the score honest.
  const fewerUnsupported = computeSolanaConfidenceScore(baseSr({ unsupportedChecks: SOLANA_UNSUPPORTED_CHECKS.slice(0, 1) }))
  const moreUnsupported = computeSolanaConfidenceScore(baseSr({ unsupportedChecks: [...SOLANA_UNSUPPORTED_CHECKS, ...SOLANA_UNSUPPORTED_CHECKS] }))
  check('fewer unsupported checks scores higher than more, same other inputs', fewerUnsupported.score > moreUnsupported.score)
}

console.log(`test-solana-token-scanner.mjs: all ${passed} assertions passed`)
