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
  scanSolanaTokenBeta, scoreSolanaBeta, SOLANA_UNSUPPORTED_CHECKS,
} from '../lib/server/solanaTokenScannerBeta.ts'

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
      dexPairs: [{ chainId: 'solana', priceUsd: '1.00', liquidity: { usd: 50000 }, volume: { h24: 12000 }, pairAddress: 'POOL1', dexId: 'raydium', fdv: 1000000, marketCap: 1000000 }],
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

console.log(`test-solana-token-scanner.mjs: all ${passed} assertions passed`)
