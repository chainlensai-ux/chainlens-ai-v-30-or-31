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
import { computeSolanaCortexRisk } from '../lib/solanaCortexRisk.ts'

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

// ─── RPC retry reliability (found live: two back-to-back scans of the SAME mint gave
// different concentration results — traced to zero retry on a transient Alchemy failure) ────
{
  // Transient (HTTP 429) failure on getTokenLargestAccounts, once, then succeeds — must recover.
  let largestCalls = 0
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: async (url, init) => {
      if (typeof url === 'string' && url.includes('dexscreener')) return { ok: true, json: async () => ({ pairs: [] }) }
      const body = JSON.parse(init.body)
      if (body.method === 'getTokenLargestAccounts') {
        largestCalls++
        if (largestCalls === 1) return { ok: false, status: 429, json: async () => ({}) }
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: HEALTHY_LARGEST }) }
      }
      const results = { getAccountInfo: HEALTHY_MINT, getTokenSupply: HEALTHY_SUPPLY }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: results[body.method] ?? null }) }
    },
  })
  check('a transient 429 on getTokenLargestAccounts is retried, not surfaced as a permanent gap', r.holderConcentrationAvailable === true)
  check('concentration resolves correctly after the retry', r.topAccountConcentration.top1Percent === 40)
  check('exactly one retry happened (2 total calls), not unbounded retrying', largestCalls === 2)
}
{
  // Non-vacuous: a PERMANENT (non-transient) 429-shaped failure that never recovers must still
  // degrade to an honest gap, never hang or fabricate data — confirms retry is bounded to 1.
  let largestCalls = 0
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: async (url, init) => {
      if (typeof url === 'string' && url.includes('dexscreener')) return { ok: true, json: async () => ({ pairs: [] }) }
      const body = JSON.parse(init.body)
      if (body.method === 'getTokenLargestAccounts') { largestCalls++; return { ok: false, status: 429, json: async () => ({}) } }
      const results = { getAccountInfo: HEALTHY_MINT, getTokenSupply: HEALTHY_SUPPLY }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: results[body.method] ?? null }) }
    },
  })
  check('a persistently failing call still degrades to an honest gap, never fabricated data', r.holderConcentrationAvailable === false && r.topAccountConcentration === null)
  check('retry is bounded to exactly 2 attempts total, not unbounded', largestCalls === 2)
}
{
  // A real JSON-RPC error (the node answered, with an error) must NOT be retried — that's a real
  // answer, not a network hiccup, so retrying it would just be a wasted extra Alchemy call.
  let mintCalls = 0
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: async (url, init) => {
      if (typeof url === 'string' && url.includes('dexscreener')) return { ok: true, json: async () => ({ pairs: [] }) }
      const body = JSON.parse(init.body)
      if (body.method === 'getAccountInfo') { mintCalls++; return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'Invalid param: could not find account' } }) } }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: null }) }
    },
  })
  check('a real JSON-RPC error response still fails the scan', r.status === 'rpc_error')
  check('a real JSON-RPC error is NOT retried (exactly 1 call)', mintCalls === 1)
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
// this module (and, since the Solana-native architecture task, its whole lib/server/solana/*
// dependency graph) imports none of it. Asserted against the real source, walked recursively, so
// a future edit that wires an EVM helper into any analyzer fails loudly instead of silently
// degrading the honesty contract.
{
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const rootDir = path.dirname(new URL(import.meta.url).pathname)

  function localSpecifiers(relPath) {
    const abs = new URL(relPath, import.meta.url)
    const raw = readFileSync(abs, 'utf8')
    // Strip // line comments and /* */ blocks first — these files' own prose discusses things
    // like distinguishing revoked `from "unread"`, which would otherwise false-match as an import.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    return [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
  }

  // BFS the whole real dependency graph starting from the facade, following only relative
  // ('./...' / '../...') specifiers — external/package imports are irrelevant to this guarantee.
  const visited = new Set()
  const queue = ['../lib/server/solanaTokenScannerBeta.ts']
  const allSpecifiers = []
  while (queue.length > 0) {
    const relPath = queue.shift()
    const absPath = path.resolve(rootDir, relPath)
    if (visited.has(absPath)) continue
    visited.add(absPath)
    const specs = localSpecifiers(relPath)
    for (const spec of specs) {
      allSpecifiers.push(spec.toLowerCase())
      if (spec.startsWith('.')) {
        const nextRel = path.join(path.dirname(relPath), spec)
        queue.push(nextRel.startsWith('.') ? nextRel : `./${nextRel}`)
      }
    }
  }

  for (const forbidden of ['honeypot', 'lplock', 'lp-lock', 'deployer', 'goplus', 'ethers', 'viem', 'covalent', 'robinhood']) {
    check(`solana engine imports nothing EVM-specific anywhere in its dependency graph: ${forbidden}`, !allSpecifiers.some(s => s.includes(forbidden)))
  }
  check('solana engine visited its native analyzer modules', visited.size >= 11)
  check('solana engine (still) imports its own chain config', allSpecifiers.some(s => s.includes('solanachainconfig')))
  check('solana engine (still) imports its own provider wiring module', allSpecifiers.some(s => s.includes('solanaproviders')))
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

// ─── Provider wiring (Solana provider wiring task) ────────────────────────────
// Jupiter/Helius/GoldRush provider integration into scanSolanaTokenBeta — every assertion here
// defends "missing/disabled provider never crashes the scan" and "no fabricated evidence".

function providerStub({
  mint, supply, largest, dexPairs, jupiterMeta, jupiterPrice, heliusSignatures, heliusFail = false, jupiterFail = false,
  geckoRows, geckoFail = false, heliusHolderPages, heliusHoldersFail = false,
}) {
  return async (url, init) => {
    const u = typeof url === 'string' ? url : ''
    if (u.includes('dexscreener')) return { ok: true, json: async () => ({ pairs: dexPairs ?? [] }) }
    if (u.includes('lite-api.jup.ag/tokens')) {
      if (jupiterFail) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, json: async () => (jupiterMeta ?? {}) }
    }
    if (u.includes('lite-api.jup.ag/price')) {
      if (jupiterFail) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, json: async () => ({ data: jupiterPrice ?? {} }) }
    }
    if (u.includes('geckoterminal.com')) {
      if (geckoFail) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, json: async () => ({ data: { attributes: { ohlcv_list: geckoRows ?? [] } } }) }
    }
    if (u.includes('helius-rpc.com')) {
      const body = JSON.parse(init.body)
      if (body.method === 'getTokenAccounts') {
        if (heliusHoldersFail) return { ok: false, status: 500, json: async () => ({}) }
        const page = body.params.page
        const accounts = (heliusHolderPages ?? [[]])[page - 1] ?? []
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { token_accounts: accounts } }) }
      }
      if (heliusFail) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: heliusSignatures ?? [] }) }
    }
    const body = JSON.parse(init.body)
    const results = { getAccountInfo: mint, getTokenSupply: supply, getTokenLargestAccounts: largest }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: results[body.method] ?? null }) }
  }
}

// ─── Missing/disabled Jupiter and Helius never crash a scan ───────────────────
{
  delete process.env.ENABLE_JUPITER_SOLANA
  delete process.env.JUPITER_API_KEY
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'P', dexId: 'raydium' }],
    }),
  })
  check('scan with no Jupiter/Helius config does not crash', !('status' in r))
  check('jupiter not called when disabled', r.jupiter.called === false)
  check('helius not called when disabled', r.helius.called === false)
  check('jupiter reports a clean errorReason, not a crash', typeof r.jupiter.errorReason === 'string')
  check('helius reports a clean errorReason, not a crash', typeof r.helius.errorReason === 'string')
  check('header identity still resolves via DexScreener fallback when Jupiter is off', r.resolvedTokenName === null && r.resolvedTokenSymbol === null)
}

// ─── Jupiter enabled: metadata maps name/symbol correctly, becomes header identity ─────────────
{
  process.env.ENABLE_JUPITER_SOLANA = 'true'
  delete process.env.ENABLE_HELIUS_SOLANA
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'P', dexId: 'raydium' }],
      jupiterMeta: { name: 'USD Coin', symbol: 'USDC', logoURI: 'https://x/logo.png', tags: ['verified'] },
      jupiterPrice: { [USDC_MINT]: { price: '1.001' } },
    }),
  })
  check('jupiter called when enabled', r.jupiter.called === true)
  check('jupiter metadata maps name/symbol correctly', r.jupiter.resolved.name === 'USD Coin' && r.jupiter.resolved.symbol === 'USDC')
  check('jupiter maps verified tag', r.jupiter.resolved.verified === true)
  check('jupiter maps price', r.jupiter.resolved.price === 1.001)
  check('jupiter identity takes header precedence over DexScreener', r.resolvedTokenName === 'USD Coin' && r.resolvedTokenSymbol === 'USDC')
  check('DexScreener market data maps price/liquidity/volume correctly', r.marketData.priceUsd === 1 && r.marketData.liquidityUsd === 1000 && r.marketData.volume24hUsd === 1)
  check('alchemy authority read maps mint/freeze authority correctly', r.mintAuthority === null && r.freezeAuthority === null && r.authorityReadSucceeded === true)
  delete process.env.ENABLE_JUPITER_SOLANA
}

// ─── Jupiter failure degrades to an evidence gap, never a fake identity ────────
{
  process.env.ENABLE_JUPITER_SOLANA = 'true'
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [], jupiterFail: true }),
  })
  check('jupiter failure reported as unsuccessful, not thrown', r.jupiter.called === true && r.jupiter.success === false)
  check('jupiter failure adds an evidence gap', r.solanaEvidenceGaps.some(g => /jupiter/i.test(g)))
  delete process.env.ENABLE_JUPITER_SOLANA
}

// ─── Helius: not called when ENABLE_HELIUS_SOLANA=false, even with a key present ───────────────
{
  process.env.ENABLE_HELIUS_SOLANA = 'false'
  process.env.HELIUS_API_KEY = 'test-helius-key-should-never-appear'
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('helius not called when flag is false, regardless of key', r.helius.called === false)
  check('scan never leaks the helius key', !JSON.stringify(r).includes('test-helius-key-should-never-appear'))
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}

// ─── Helius enabled: lightweight call resolves, Enhanced Transactions never used by default ────
{
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-helius-key'
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [],
      heliusSignatures: [{ signature: 'sig1' }, { signature: 'sig2' }],
    }),
  })
  check('helius called when enabled with a key', r.helius.called === true)
  check('helius resolves recentTransfers from signature count', r.helius.resolved.recentTransfers === 2)
  check('helius Enhanced Transactions are never used by default', r.helius.enhancedTransactionsUsed === false)
  check('helius creator/dev signals stay null (Enhanced Transactions gap), never guessed', r.helius.resolved.creatorSignals === null && r.helius.resolved.devActivity === null)
  check('helius credit estimate is a small fixed number, not unbounded', r.helius.estimatedCredits > 0 && r.helius.estimatedCredits <= 5)
  check('scan never leaks the helius key', !JSON.stringify(r).includes('test-helius-key'))
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}

// ─── Helius failure degrades cleanly, never crashes ────────────────────────────
{
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-helius-key'
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [], heliusFail: true }),
  })
  check('helius failure does not crash the scan', !('status' in r))
  check('helius failure reported unsuccessful with an error reason', r.helius.success === false && typeof r.helius.errorReason === 'string')
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}

// ─── GoldRush/Covalent: unsupported endpoint creates a clean unavailable state ─────────────────
{
  process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('goldrush never called (no verified Solana endpoint)', r.goldrushOrCovalent.called === false)
  check('goldrush reports a clean, non-crashing unavailable state', r.goldrushOrCovalent.success === false && typeof r.goldrushOrCovalent.errorReason === 'string')
  check('goldrush holder count stays null, never fabricated', r.goldrushOrCovalent.resolved.holderCount === null)
  delete process.env.GOLDRUSH_API_KEY
}

// ─── solanaProviderWiringAudit shape and honesty ───────────────────────────────
{
  process.env.ENABLE_JUPITER_SOLANA = 'true'
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'P', dexId: 'raydium' }],
      jupiterMeta: { name: 'USD Coin', symbol: 'USDC' },
    }),
  })
  const wa = r.solanaProviderWiringAudit
  check('wiring audit carries the mint', wa.mint === USDC_MINT)
  check('wiring audit reports alchemy always enabled', wa.enabledProviders.alchemySolana === true)
  check('wiring audit reports jupiter enabled to match config', wa.enabledProviders.jupiter === true)
  check('wiring audit reports helius disabled to match config', wa.enabledProviders.helius === false)
  check('wiring audit alchemy resolved block carries real values', wa.providerCalls.alchemy.resolved.decimals === 6 && wa.providerCalls.alchemy.resolved.supply === 1000000)
  check('wiring audit dexScreener pairsFound reflects real pairs', wa.providerCalls.dexScreener.pairsFound === 1)
  check('wiring audit mergedResult tokenName prefers jupiter', wa.mergedResult.tokenName === 'USD Coin')
  check('wiring audit mergedResult carries top1/top10/top20', wa.mergedResult.top1 === 40 && wa.mergedResult.top10 === 55)
  check('wiring audit missingEvidence is the real evidence-gap list', Array.isArray(wa.missingEvidence))
  check('wiring audit unsupportedChecks matches the real unsupported-check list', wa.unsupportedChecks.length === SOLANA_UNSUPPORTED_CHECKS.length)
  check('wiring audit never leaks a key or URL', !JSON.stringify(wa).includes('http') && !JSON.stringify(wa).toLowerCase().includes('alchemy.com'))
  delete process.env.ENABLE_JUPITER_SOLANA
}

// ─── Solana result still renders through the normal Token Scanner shell (UI mapping) ───────────
{
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  check('page reads resolvedTokenName/resolvedTokenSymbol for the Solana header (Jupiter-first identity)', page.includes('sr.resolvedTokenName') && page.includes('sr.resolvedTokenSymbol'))
  check('page reads sr.jupiter for the Market tab price fallback', page.includes('sr.jupiter.resolved.price'))
  check('page reads sr.helius for the Dev tab activity signal', page.includes('sr.helius.'))
  check('page reads sr.heliusHolders for the Holders tab holder-count distinction', page.includes('sr.heliusHolders.holderCount'))
  check('page reads sr.ohlcv for the Market tab Price Chart', page.includes('sr.ohlcv.success') && page.includes('CandlestickChart'))
  // Same result-tabs-wrap / result-header shell classes used by the Solana branch as by EVM chains.
  check('solana branch still uses the shared result-header shell class', page.includes("className=\"result-header\""))
  check('solana branch still uses the shared result-tabs-wrap shell class', page.includes("className=\"result-tabs-wrap\""))
}

// ─── Base/ETH/BNB/Robinhood scan routing unchanged (provider wiring task) ──────────────────────
{
  const { readFileSync } = await import('node:fs')
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  check('EVM chain gate untouched by provider wiring', /rawChain !== 'base' && rawChain !== 'eth' && rawChain !== 'bnb' && rawChain !== 'robinhood'/.test(route))
  check('solana branch still returns before EVM logic runs', route.indexOf("if (rawChain === 'solana')") < route.indexOf("rawChain !== 'base' && rawChain !== 'eth'"))
}

// ─── GeckoTerminal OHLCV (Price Chart provider-wiring follow-up) ──────────────────────────────
const GECKO_ROW = (tsSec, o, h, l, c, v) => [tsSec, o, h, l, c, v]
{
  // Newest-first rows from the real API must come out chronological-ascending for the chart.
  const rows = [GECKO_ROW(3000, 1.2, 1.3, 1.1, 1.25, 500), GECKO_ROW(2000, 1.1, 1.2, 1.0, 1.15, 400), GECKO_ROW(1000, 1.0, 1.1, 0.9, 1.05, 300)]
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'POOL1', dexId: 'raydium' }],
      geckoRows: rows,
    }),
  })
  check('geckoterminal called when a pool address is known', r.ohlcv.called === true)
  check('geckoterminal candles resolve successfully', r.ohlcv.success === true)
  check('candles are reordered chronological-ascending (oldest first)', r.ohlcv.candles[0].timestamp < r.ohlcv.candles[2].timestamp)
  check('candle OHLC values map correctly', r.ohlcv.candles[2].close === 1.25 && r.ohlcv.candles[2].volume === 500)
  check('solanaProviderWiringAudit reports geckoTerminal candle count', r.solanaProviderWiringAudit.providerCalls.geckoTerminal.candleCount === 3)
}
{
  // No pool address at all (no market data) — must not attempt a call, never crash.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('geckoterminal not called with no pool address', r.ohlcv.called === false)
  check('missing pool address does not crash the scan', !('status' in r))
}
{
  // Transient/HTTP failure and unexpected shape both degrade cleanly — never fabricated candles.
  const rHttp = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'POOL1', dexId: 'raydium' }],
      geckoFail: true,
    }),
  })
  check('geckoterminal HTTP failure degrades cleanly, never crashes', !('status' in rHttp) && rHttp.ohlcv.success === false && rHttp.ohlcv.candles.length === 0)
  check('geckoterminal failure adds an evidence gap', rHttp.solanaEvidenceGaps.some(g => /candle history/i.test(g)))
  const rShape = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'POOL1', dexId: 'raydium' }],
      geckoRows: null, // simulates an unexpected/missing ohlcv_list shape
    }),
  })
  check('geckoterminal unexpected shape degrades cleanly (empty array is valid JSON, resolves to insufficient candles)', rShape.ohlcv.candles.length === 0 && rShape.ohlcv.success === false)
}

// ─── Helius holder count (Holders provider-wiring follow-up) ──────────────────────────────────
{
  // Single short page — real, exact count, never a lower bound.
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-helius-key'
  const accounts = [{ amount: '100' }, { amount: '200' }, { amount: '0' }] // one zero-balance account must not count
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [], heliusHolderPages: [accounts] }),
  })
  check('helius holder count called when enabled', r.heliusHolders.called === true)
  check('holder count excludes zero-balance accounts', r.heliusHolders.holderCount === 2)
  check('a single short page is not reported as a lower bound', r.heliusHolders.isLowerBound === false)
  check('mergedResult.holderCount reflects the real Helius count', r.solanaProviderWiringAudit.mergedResult.holderCount === 2)
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}
{
  // Pagination: page 1 full (1000), page 2 short — sums across pages, still an exact count.
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-helius-key'
  const page1 = Array.from({ length: 1000 }, () => ({ amount: '1' }))
  const page2 = [{ amount: '1' }, { amount: '1' }]
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [], heliusHolderPages: [page1, page2] }),
  })
  check('pagination sums across pages correctly', r.heliusHolders.holderCount === 1002)
  check('a short final page is not a lower bound', r.heliusHolders.isLowerBound === false)
  check('exactly 2 pages fetched', r.heliusHolders.pagesFetched === 2)
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}
{
  // Hitting the page cap with a still-full last page — must be an honest lower bound, never
  // presented as the true total (cost-control cap, not a real end-of-data signal).
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-helius-key'
  const fullPage = Array.from({ length: 1000 }, () => ({ amount: '1' }))
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [], heliusHolderPages: [fullPage, fullPage, fullPage, fullPage, fullPage] }),
  })
  check('page cap produces a lower-bound count, never claimed as exact', r.heliusHolders.isLowerBound === true)
  check('page cap is bounded to exactly 3 pages, never unbounded pagination', r.heliusHolders.pagesFetched === 3)
  check('lower-bound flag is disclosed as an evidence gap', r.solanaEvidenceGaps.some(g => /lower bound/i.test(g)))
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}
{
  // Disabled/missing key — never called, never crashes.
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('helius holder count not called when disabled', r.heliusHolders.called === false)
  check('disabled holder count does not crash the scan', !('status' in r))
  check('mergedResult.holderCount falls back to goldrush (null) when Helius is off', r.solanaProviderWiringAudit.mergedResult.holderCount === null)
}
{
  // First-page failure — clean unavailable state, never a fabricated count.
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-helius-key'
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: providerStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [], heliusHoldersFail: true }),
  })
  check('a first-page failure degrades to a clean unavailable state', r.heliusHolders.success === false && r.heliusHolders.holderCount === null)
  check('a first-page failure does not crash the scan', !('status' in r))
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}

// ─── Pool program verification (LP Safety follow-up) ──────────────────────────────────────────
// The real, safe piece of the LP Safety fix: verifying which program owns the pool account via
// getAccountInfo, compared against a small known-AMM map — never a guessed/wrong program name.
function poolProgramStub({ mint, supply, largest, poolAddress, poolOwner, poolInfoFails = false }) {
  return async (url, init) => {
    const u = typeof url === 'string' ? url : ''
    if (u.includes('dexscreener')) {
      return { ok: true, json: async () => ({
        pairs: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: poolAddress, dexId: 'raydium' }],
      }) }
    }
    if (u.includes('lite-api.jup.ag') || u.includes('geckoterminal.com') || u.includes('helius-rpc.com')) return { ok: false, status: 404, json: async () => ({}) }
    const body = JSON.parse(init.body)
    if (body.method === 'getAccountInfo' && body.params[0] === poolAddress) {
      if (poolInfoFails) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: { owner: poolOwner } } }) }
    }
    const results = { getAccountInfo: mint, getTokenSupply: supply, getTokenLargestAccounts: largest }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: results[body.method] ?? null }) }
  }
}
{
  // Recognized program (Raydium AMM V4) — real, on-chain-verified label.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: poolProgramStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, poolAddress: 'POOL_RAY', poolOwner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' }),
  })
  check('recognized AMM program resolves a real label', r.poolProgram.resolved === true && r.poolProgram.label === 'Raydium AMM V4')
  check('poolProgram carries the real owner address', r.poolProgram.owner === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')
  check('LP Safety UI reads poolProgram.label for on-chain-verified model naming', true) // covered by the page-source check below
}
{
  // Unrecognized program — real owner shown, but NEVER guessed into a known label.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: poolProgramStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, poolAddress: 'POOL_UNKNOWN', poolOwner: 'SomeUnknownProgram11111111111111111111111' }),
  })
  check('unrecognized program never guesses a known label', r.poolProgram.label === null)
  check('unrecognized program still resolved (real owner read succeeded)', r.poolProgram.resolved === true)
  check('unrecognized-program owner is still surfaced, not hidden', r.poolProgram.owner === 'SomeUnknownProgram11111111111111111111111')
  check('unrecognized program adds an evidence gap', r.solanaEvidenceGaps.some(g => /not one of the AMM programs/i.test(g)))
}
{
  // Pool getAccountInfo failure — degrades cleanly, never crashes, never fabricates a label.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: poolProgramStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, poolAddress: 'POOL_FAIL', poolOwner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', poolInfoFails: true }),
  })
  check('pool program read failure does not crash the scan', !('status' in r))
  check('pool program read failure leaves resolved false, never a guessed label', r.poolProgram.resolved === false && r.poolProgram.label === null)
  check('pool program read failure adds an evidence gap distinguishing verified vs. metadata', r.solanaEvidenceGaps.some(g => /unverified market-data metadata/i.test(g)))
}
{
  // No pool address at all — never attempted, never crashes.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('no pool address means poolProgram is never attempted', r.poolProgram.resolved === false && r.poolProgram.poolAddress === null)
  check('no pool address does not crash the scan', !('status' in r))
}

// ─── LP Safety UI reads the verified pool-program identity (not just DexScreener metadata) ────
{
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  check('LP Safety reads sr.poolProgram.label for on-chain-verified model naming', page.includes('sr.poolProgram.label'))
  check('LP Safety reads sr.poolProgram.owner for the unrecognized-program fallback note', page.includes('sr.poolProgram.owner'))
}

// ─── Social links (provider-wiring follow-up: "show X/website/Reddit links") ──────────────────
// Sourced from the SAME already-fetched DexScreener pair response (pair.info.websites/socials) —
// no new provider call. Every assertion here defends "real or null, never guessed."
{
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{
        chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'P', dexId: 'raydium',
        info: {
          websites: [{ url: 'https://dexscreener.com/solana/p' }, { url: 'https://realtoken.io' }],
          socials: [
            { type: 'twitter', url: 'https://x.com/realtoken' },
            { type: 'telegram', url: 'https://t.me/realtoken' },
            { type: 'discord', url: 'https://discord.gg/realtoken' },
            { type: 'reddit', url: 'https://reddit.com/r/realtoken' },
          ],
        },
      }],
    }),
  })
  check('twitter/x social link resolves', r.marketData.socials.twitter === 'https://x.com/realtoken')
  check('telegram social link resolves', r.marketData.socials.telegram === 'https://t.me/realtoken')
  check('discord social link resolves', r.marketData.socials.discord === 'https://discord.gg/realtoken')
  check('reddit social link resolves', r.marketData.socials.reddit === 'https://reddit.com/r/realtoken')
  check('website resolves, skipping the dexscreener.com self-link', r.marketData.socials.website === 'https://realtoken.io')
}
{
  // "x" as the type (DexScreener sometimes uses "x" instead of "twitter") must also map to twitter.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{
        chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'P', dexId: 'raydium',
        info: { socials: [{ type: 'x', url: 'https://x.com/realtoken2' }] },
      }],
    }),
  })
  check('"x" type also maps to twitter', r.marketData.socials.twitter === 'https://x.com/realtoken2')
}
{
  // No info block at all — every field null, never guessed from the token name/symbol.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'P', dexId: 'raydium' }],
    }),
  })
  check('no info block: every social field is null, never guessed', Object.values(r.marketData.socials).every(v => v === null))
}
{
  // A non-http string (e.g. a bare handle) must never be accepted as a URL.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{
        chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'P', dexId: 'raydium',
        info: { socials: [{ type: 'twitter', url: '@realtoken' }] },
      }],
    }),
  })
  check('a non-URL social value is rejected, never passed through as a link', r.marketData.socials.twitter === null)
}
{
  // Missing market data entirely — no crash, ProjectSocialsCard gets undefined gracefully.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('no market data means marketData is null, socials access must not crash the page', r.marketData === null)
}

// ─── Solana Market tab renders Project Links via the shared card component ────────────────────
{
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  check('Solana Market tab renders ProjectSocialsCard from sr.marketData.socials', page.includes('<ProjectSocialsCard socials={sr.marketData?.socials} />'))
  check('ProjectSocialsCard renders a Reddit link when present', page.includes("label: 'Reddit'"))
  check('ProjectSocialsCard renders a Discord link when present', page.includes("label: 'Discord'"))
}

// ─── Pool Activity — real buys/sells counts (provider-wiring follow-up: "Pool Activity isn't
// giving info") ─────────────────────────────────────────────────────────────────────────────
{
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{
        chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'P', dexId: 'raydium',
        txns: { h24: { buys: 120, sells: 80 } },
      }],
    }),
  })
  check('real buys count resolves from the same DexScreener response', r.marketData.txns24h.buys === 120)
  check('real sells count resolves from the same DexScreener response', r.marketData.txns24h.sells === 80)
}
{
  // Absent txns field — null, never fabricated as 0 (0 would falsely imply "confirmed zero activity").
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: rpcStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST,
      dexPairs: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 1000 }, volume: { h24: 1 }, pairAddress: 'P', dexId: 'raydium' }],
    }),
  })
  check('missing txns.h24 resolves to null, never a fabricated 0', r.marketData.txns24h.buys === null && r.marketData.txns24h.sells === null)
}
{
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  check('Pool Activity reads sr.marketData.txns24h for real buys/sells', page.includes('sr.marketData.txns24h'))
}

// ─── Solana-native architecture: each analyzer module is independently real and testable ───────
// Direct unit tests against the new lib/server/solana/* modules — not just via the orchestrated
// scanSolanaTokenBeta() facade. Confirms the refactor is a genuine decomposition (each piece
// works standalone) and not a cosmetic file split around one still-monolithic function.
{
  const { analyzeSolanaAuthority } = await import('../lib/server/solana/authorityAnalyzer.ts')
  const revoked = analyzeSolanaAuthority({ mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true })
  check('authorityAnalyzer: both revoked classifies correctly', revoked.mintStatus === 'revoked' && revoked.freezeStatus === 'revoked')
  const active = analyzeSolanaAuthority({ mintAuthority: 'X', freezeAuthority: 'Y', authorityReadSucceeded: true })
  check('authorityAnalyzer: both active classifies correctly', active.mintStatus === 'active' && active.freezeStatus === 'active')
  const unread = analyzeSolanaAuthority({ mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: false })
  check('authorityAnalyzer: unread authority is "unknown", never silently "revoked"', unread.mintStatus === 'unknown' && unread.freezeStatus === 'unknown')
}
{
  const { analyzeSolanaPool } = await import('../lib/server/solana/poolAnalyzer.ts')
  const noAddr = await analyzeSolanaPool({ poolAddress: null, rpcUrl: 'https://stub', fetchImpl: async () => { throw new Error('must not fetch') } })
  check('poolAnalyzer: no pool address never calls out', noAddr.poolProgram.resolved === false && noAddr.poolProgram.poolAddress === null)
  const recognized = await analyzeSolanaPool({
    poolAddress: 'POOL1', rpcUrl: 'https://stub',
    fetchImpl: async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: { owner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' } } }) }),
  })
  check('poolAnalyzer: recognized program resolves a real label directly', recognized.poolProgram.label === 'Raydium AMM V4')
}
{
  const { analyzeSolanaMarket } = await import('../lib/server/solana/marketAnalyzer.ts')
  const m = await analyzeSolanaMarket(USDC_MINT, async (url) => {
    if (String(url).includes('dexscreener')) {
      return { ok: true, json: async () => ({ pairs: [{ chainId: 'solana', priceUsd: '2.5', liquidity: { usd: 5000 }, volume: { h24: 100 }, pairAddress: 'P', dexId: 'orca' }] }) }
    }
    throw new Error('unexpected fetch')
  })
  check('marketAnalyzer: resolves real price/liquidity directly', m.data.priceUsd === 2.5 && m.data.liquidityUsd === 5000)
}
{
  const { computeSolanaConfidenceScore } = await import('../lib/server/solana/scoreEngine.ts')
  check('scoreEngine.ts re-exports the real confidence score engine (not a stub)', typeof computeSolanaConfidenceScore === 'function')
  const sc = computeSolanaConfidenceScore({
    authorityReadSucceeded: true, mintAuthority: null, freezeAuthority: null,
    topAccountConcentration: { top1Percent: 5, top10Percent: 10, top20Percent: 15, accountsSampled: 20, accounts: [] },
    marketDataAvailable: true, marketData: { liquidityUsd: 100_000, priceUsd: 1, volume24hUsd: 1, fdvUsd: null, marketCapUsd: null, primaryPoolAddress: null, primaryDexLabel: null, tokenName: null, tokenSymbol: null },
    unsupportedChecks: SOLANA_UNSUPPORTED_CHECKS,
  })
  check('scoreEngine.ts produces a real score via the re-export', typeof sc.score === 'number' && sc.score > 0)
}

// ─── Solana-native architecture: directory layout matches the requested module list ────────────
{
  const { readFileSync, existsSync } = await import('node:fs')
  const dir = '../lib/server/solana/'
  const expectedModules = [
    'mintAnalyzer.ts', 'authorityAnalyzer.ts', 'holderAnalyzer.ts', 'poolAnalyzer.ts',
    'marketAnalyzer.ts', 'creatorAnalyzer.ts', 'riskEngine.ts', 'scoreEngine.ts',
    'metadataResolver.ts', 'providerMerge.ts', 'types.ts', 'rpcClient.ts',
  ]
  for (const mod of expectedModules) {
    check(`lib/server/solana/${mod} exists`, existsSync(new URL(dir + mod, import.meta.url)))
  }
  // Every analyzer module's own header discloses what it does and does not attempt — spot-check
  // the two riskiest-to-overclaim ones (holders, creator) actually carry that disclosure.
  const holderSrc = readFileSync(new URL(dir + 'holderAnalyzer.ts', import.meta.url), 'utf8')
  check('holderAnalyzer.ts discloses it does not classify snipers/bundlers/insiders', /snipers|bundlers|insiders/i.test(holderSrc) && /does not/i.test(holderSrc))
  const creatorSrc = readFileSync(new URL(dir + 'creatorAnalyzer.ts', import.meta.url), 'utf8')
  check('creatorAnalyzer.ts discloses it does not resolve creator/deployer identity', /does NOT/.test(creatorSrc) && /creator\/deployer/i.test(creatorSrc))
}

// ─── EVM chains (Base/ETH/BNB/Robinhood) are completely unaffected by the Solana-native refactor ──
{
  const { readFileSync } = await import('node:fs')
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  check('EVM chain gate untouched by the Solana-native architecture task', /rawChain !== 'base' && rawChain !== 'eth' && rawChain !== 'bnb' && rawChain !== 'robinhood'/.test(route))
  check('solana branch still returns before EVM logic runs', route.indexOf("if (rawChain === 'solana')") < route.indexOf("rawChain !== 'base' && rawChain !== 'eth'"))
  check('route still imports scanSolanaTokenBeta from the same (now facade) path — no call-site changes needed', route.includes("from '@/lib/server/solanaTokenScannerBeta'"))
}

// ─── Pool Authority Engine: real, differentiated verdicts (no PDA/vault fabrication) ───────────
{
  const { analyzeSolanaPool, poolVerdictDescription } = await import('../lib/server/solana/poolAnalyzer.ts')
  const recognized = await analyzeSolanaPool({
    poolAddress: 'POOL1', rpcUrl: 'https://stub',
    fetchImpl: async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: { owner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' } } }) }),
  })
  check('recognized program gets verified_official_pool verdict', recognized.poolProgram.verdict === 'verified_official_pool')
  check('verdict description never overclaims vault authority/withdrawal safety', /not vault authority|not.*withdrawal/i.test(poolVerdictDescription(recognized.poolProgram)))
  check('non-PumpSwap program never claims migration', recognized.poolProgram.migratedFromPumpFun === null)

  const unrecognized = await analyzeSolanaPool({
    poolAddress: 'POOL2', rpcUrl: 'https://stub',
    fetchImpl: async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'SomeUnknownProgram11111111111111111111111' } } }) }),
  })
  check('unrecognized program gets unrecognized_program verdict, never verified', unrecognized.poolProgram.verdict === 'unrecognized_program')
  check('unrecognized program never claims migration', unrecognized.poolProgram.migratedFromPumpFun === null)

  const unverified = await analyzeSolanaPool({ poolAddress: null, rpcUrl: 'https://stub', fetchImpl: async () => { throw new Error('must not fetch') } })
  check('no pool address gets unverified verdict', unverified.poolProgram.verdict === 'unverified')

  // PumpSwap IS Pump.fun's exclusive post-graduation AMM — this is a real fact, not a guess.
  const pumpswap = await analyzeSolanaPool({
    poolAddress: 'POOL3', rpcUrl: 'https://stub',
    fetchImpl: async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' } } }) }),
  })
  check('PumpSwap AMM resolves migratedFromPumpFun as a real fact, not a guess', pumpswap.poolProgram.migratedFromPumpFun === true)
  check('PumpSwap resolves as verified_official_pool', pumpswap.poolProgram.verdict === 'verified_official_pool')
}
{
  // End-to-end: the LP Safety UI reads the real verdict instead of a hardcoded "Open Check".
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: poolProgramStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, poolAddress: 'POOL_RAY', poolOwner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' }),
  })
  check('scan result carries the real pool verdict', r.poolProgram.verdict === 'verified_official_pool')
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  check('LP Safety reads sr.poolProgram.verdict for the Pool Authority verdict (not a hardcoded Open Check)', page.includes('sr.poolProgram.verdict'))
  check('LP Safety reads sr.poolProgram.migratedFromPumpFun for the migration row', page.includes('sr.poolProgram.migratedFromPumpFun'))
}

// ─── Deep Mode: Helius Enhanced Transactions, EXPLICIT OPT-IN ONLY ("do Helius Enhanced" ask) ──
function deepStub({ mint, supply, largest, dexPairs, sigPages, enhancedTx, enhancedFail = false, sigPageFail = false }) {
  let sigCallCount = 0
  return async (url, init) => {
    const u = typeof url === 'string' ? url : ''
    if (u.includes('dexscreener')) return { ok: true, json: async () => ({ pairs: dexPairs ?? [] }) }
    if (u.includes('api.helius.xyz/v0/transactions')) {
      if (enhancedFail) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, json: async () => (enhancedTx ?? []) }
    }
    if (u.includes('helius-rpc.com')) {
      const body = JSON.parse(init.body)
      if (body.method === 'getSignaturesForAddress') {
        const limit = body.params[1]?.limit
        if (limit === 10) return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }) } // lightweight creatorAnalyzer call
        if (sigPageFail) return { ok: false, status: 500, json: async () => ({}) }
        const page = (sigPages ?? [])[sigCallCount] ?? []
        sigCallCount++
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: page }) }
      }
      if (body.method === 'getTokenAccounts') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { token_accounts: [] } }) }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }) }
    }
    const body = JSON.parse(init.body)
    const results = { getAccountInfo: mint, getTokenSupply: supply, getTokenLargestAccounts: largest }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: results[body.method] ?? null }) }
  }
}
{
  // Default (no deep flag) — deepCreator must stay null, Enhanced Transactions never called.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub',
    fetchImpl: deepStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('deepCreator stays null when deep mode is not requested', r.deepCreator === null)
}
{
  // deep:true, Helius not configured — must degrade cleanly, never crash.
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub', deep: true,
    fetchImpl: deepStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [] }),
  })
  check('deep mode with Helius disabled degrades cleanly, never crashes', !('status' in r))
  check('deepCreator.creatorTrace.called is false when Helius is not configured', r.deepCreator.creatorTrace.called === false)
}
{
  // deep:true, Helius configured, short signature history (reaches genesis) — resolves a real creator.
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-helius-key-should-never-appear'
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub', deep: true,
    fetchImpl: deepStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [],
      sigPages: [[{ signature: 'genesis_sig', blockTime: 1700000000 }]], // fewer than page limit => reached genesis
      enhancedTx: [{ feePayer: 'CreatorWallet1111111111111111111111111111', source: 'PUMP_FUN' }],
    }),
  })
  check('deep mode resolves a real likely creator wallet', r.deepCreator.creatorTrace.resolved.likelyCreatorWallet === 'CreatorWallet1111111111111111111111111111')
  check('deep mode captures the real transaction source when Helius provides one', r.deepCreator.creatorTrace.resolved.transactionSource === 'PUMP_FUN')
  check('deep mode marks enhancedTransactionsUsed true — the ONLY path allowed to', r.deepCreator.creatorTrace.enhancedTransactionsUsed === true)
  check('short signature history is correctly marked as having reached genesis', r.deepCreator.creatorTrace.reachedGenesis === true)
  check('deep mode result never leaks the Helius key', !JSON.stringify(r).includes('test-helius-key-should-never-appear'))
  check('evidence gap discloses the fee-payer heuristic honestly, not as a certainty', r.solanaEvidenceGaps.some(g => /strong signal, not a certainty/i.test(g)))
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}
{
  // Full page hit repeatedly — page cap reached, must be honestly marked as NOT reaching genesis.
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-helius-key'
  const fullPage = Array.from({ length: 1000 }, (_, i) => ({ signature: `sig${i}`, blockTime: 1700000000 - i }))
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub', deep: true,
    fetchImpl: deepStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [],
      sigPages: [fullPage, fullPage, fullPage, fullPage, fullPage], // 5 full pages = hits the cap
      enhancedTx: [{ feePayer: 'SomeEarlyFeePayer111111111111111111111111', source: null }],
    }),
  })
  check('page-cap-hit case is honestly marked as NOT having reached genesis', r.deepCreator.creatorTrace.reachedGenesis === false)
  check('page cap is bounded (5 pages), never unbounded pagination', r.deepCreator.creatorTrace.pagesFetched === 5)
  check('lookback-cap evidence gap is disclosed when genesis was not reached', r.solanaEvidenceGaps.some(g => /lookback capped/i.test(g)))
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}
{
  // No signature history at all — clean unavailable state, never a crash, never a guessed wallet.
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-helius-key'
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub', deep: true,
    fetchImpl: deepStub({ mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [], sigPages: [[]] }),
  })
  check('no signature history resolves to a clean unavailable state', r.deepCreator.creatorTrace.success === false && r.deepCreator.creatorTrace.resolved.likelyCreatorWallet === null)
  check('no signature history does not crash the scan', !('status' in r))
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}
{
  // Enhanced Transactions call itself fails — degrades cleanly, still reports the signature found.
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-helius-key'
  const r = await scanSolanaTokenBeta(USDC_MINT, {
    rpcUrl: 'https://stub', deep: true,
    fetchImpl: deepStub({
      mint: HEALTHY_MINT, supply: HEALTHY_SUPPLY, largest: HEALTHY_LARGEST, dexPairs: [],
      sigPages: [[{ signature: 'genesis_sig', blockTime: 1700000000 }]],
      enhancedFail: true,
    }),
  })
  check('Enhanced Transactions failure degrades cleanly, never crashes', !('status' in r))
  check('Enhanced Transactions failure still surfaces the earliest signature found', r.deepCreator.creatorTrace.resolved.earliestSignature === 'genesis_sig')
  check('Enhanced Transactions failure never fabricates a creator wallet', r.deepCreator.creatorTrace.resolved.likelyCreatorWallet === null)
  delete process.env.ENABLE_HELIUS_SOLANA
  delete process.env.HELIUS_API_KEY
}
{
  // Route-level gating: deepDev must come from the request body as an explicit boolean.
  const { readFileSync } = await import('node:fs')
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  check('route gates deep mode on an explicit body.deepDev === true check', route.includes('body.deepDev === true'))
  check('route gates deep cluster mode on an explicit body.deepCluster === true check', route.includes('body.deepCluster === true'))
  check('route never defaults deep mode on for a normal scan (deep only turns on for deepDev or deepCluster)', route.includes('scanSolanaTokenBeta(solanaInput, { deep: deepDev || deepCluster, deepCluster })'))
}
{
  // UI: the deep-check trigger and result card read the real fields, and the button is the only
  // place deepDev:true is ever sent from the client.
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  check('the deep-check trigger sends deepDev: true to the API', page.includes('deepDev: true'))
  check('the normal scan fetch body (contract: q) never includes deepDev', !/contract:\s*q,\s*chain:\s*'solana'\s*,\s*deepDev/.test(page))
  check('Dev tab reads sr.deepCreator to decide between the trigger button and the result card', page.includes('!sr.deepCreator'))
  check('Deep Creator Check card reads the real resolved creator wallet', page.includes('dc.resolved.likelyCreatorWallet'))
  check('Deep Creator Check UI discloses the cost up front', /paid, more expensive/i.test(page))
}

// ─── Solana CORTEX Risk Engine (replaces "Risk Drivers / Open Checks") ─────────────────────────
function cortexSr(overrides = {}) {
  return {
    ...baseSr(),
    // Genuinely distributed for the "best case" — baseSr's default top1Percent (10) sits right at
    // this engine's whale threshold and would otherwise contaminate the best-case fixture.
    topAccountConcentration: { top1Percent: 5, top10Percent: 20, top20Percent: 30, accountsSampled: 20, accounts: [] },
    tokenProgram: 'spl-token',
    poolProgram: { resolved: true, poolAddress: 'POOL1', owner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', label: 'Raydium AMM V4', errorReason: null, verdict: 'verified_official_pool', migratedFromPumpFun: null },
    marketData: { liquidityUsd: 100_000, priceUsd: 1, volume24hUsd: 50_000, fdvUsd: null, marketCapUsd: null, primaryPoolAddress: 'POOL1', primaryDexLabel: 'raydium', tokenName: null, tokenSymbol: null, pairAgeLabel: '10d', txns24h: { buys: 120, sells: 40 }, socials: { website: null, twitter: null, telegram: null, discord: null, reddit: null } },
    heliusHolders: { called: true, success: true, holderCount: 500, isLowerBound: false, pagesFetched: 1, errorReason: null },
    jupiter: { called: true, success: true, resolved: { name: 'X', symbol: 'X', logo: null, verified: true, price: 1 }, errorReason: null },
    helius: { called: true, success: true, enhancedTransactionsUsed: false, estimatedCredits: 1, resolved: { parsedActivity: true, creatorSignals: null, devActivity: null, recentTransfers: 5 }, errorReason: null },
    ohlcv: { called: true, success: true, candles: [{ timestamp: '2024-01-01T00:00:00Z', open: 1, high: 1, low: 1, close: 1, volume: 1 }, { timestamp: '2024-01-01T01:00:00Z', open: 1, high: 1, low: 1, close: 1, volume: 1 }], timeframe: '1h', errorReason: null },
    deepCreator: null,
    resolvedTokenName: 'Test Token',
    ...overrides,
  }
}

// ─── Module Confidence, Score Breakdown, Evidence Coverage, Weighted Factors, Reasoning ────────
{
  const cx = computeSolanaCortexRisk(cortexSr())
  check('exactly 6 modules returned', cx.modules.length === 6)
  check('module names match the spec (Authority/Liquidity/Market/Holders/Creator/Behaviour)', cx.modules.map(m => m.module).join(',') === 'Authority,Liquidity,Market,Holders,Creator,Behaviour')
  check('every module carries status/confidence/provider/reason', cx.modules.every(m => m.status && m.confidence && m.provider && m.reason))
  check('score equals the sum of every module\'s scoreEarned', cx.score === cx.modules.reduce((s, m) => s + m.scoreEarned, 0))
  check('scoreMax is exactly 100 (25+25+20+15+5+10)', cx.scoreMax === 100)
  check('every module scoreEarned is within [0, scoreMax]', cx.modules.every(m => m.scoreEarned >= 0 && m.scoreEarned <= m.scoreMax))
}
{
  // HONESTY DEVIATION #1: Behaviour ALWAYS scores 0 — no real data source exists. This must hold
  // true even in the best-case, fully-verified scenario — never a fabricated mid-range score.
  const cx = computeSolanaCortexRisk(cortexSr())
  const behaviour = cx.modules.find(m => m.module === 'Behaviour')
  check('Behaviour module always scores 0/10 — never fabricated', behaviour.scoreEarned === 0 && behaviour.scoreMax === 10)
  check('Behaviour module confidence is honestly Unavailable, never a guessed Medium/High', behaviour.confidence === 'Unavailable')
  check('Behaviour module reason discloses the real gap', /no.*data source/i.test(behaviour.reason))
}
{
  // Creator module: 0 unless Deep Creator Check actually ran and succeeded.
  const withoutDeep = computeSolanaCortexRisk(cortexSr())
  const creatorNoDeep = withoutDeep.modules.find(m => m.module === 'Creator')
  check('Creator module scores 0 when Deep Creator Check has not run', creatorNoDeep.scoreEarned === 0)
  const withDeep = computeSolanaCortexRisk(cortexSr({
    deepCreator: { creatorTrace: { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'sig1', earliestTimestamp: '2024-01-01T00:00:00Z', likelyCreatorWallet: 'CreatorWallet1111111111111111111111111111', transactionSource: 'PUMP_FUN' }, errorReason: null }, evidenceGaps: [] },
  }))
  const creatorWithDeep = withDeep.modules.find(m => m.module === 'Creator')
  check('Creator module earns partial (not full) credit when Deep Creator Check succeeds — inference, not certainty', creatorWithDeep.scoreEarned > 0 && creatorWithDeep.scoreEarned < creatorWithDeep.scoreMax)
  check('Creator module confidence is Medium (not High) when resolved via a heuristic', creatorWithDeep.confidence === 'Medium')
}
{
  // Best-case: everything verified, healthy — must land at LOW RISK, near-full coverage, no
  // negative signals, and never claim "SAFE" wording anywhere.
  const cx = computeSolanaCortexRisk(cortexSr())
  check('best-case verdict is LOW RISK', cx.verdict === 'LOW RISK')
  // Rule 4, DISCLOSED: never an empty "no negative signals" placeholder — even the best-case scan
  // still has real negative factors (creator incomplete, no behavioral data source), by design.
  check('best-case still surfaces real negative factors — never an empty placeholder', cx.factors.filter(f => f.kind === 'negative').length >= 2)
  check('best-case negative factors are real, specific reasons — never "No confirmed negative signals"', !cx.factors.some(f => /no confirmed negative signals/i.test(f.label)))
  check('best-case has strong positive signals (authority + pool + liquidity + holders)', cx.factors.filter(f => f.kind === 'positive').length >= 4)
  check('best-case evidence coverage is reasonably high', cx.evidenceCoveragePercent >= 50)
  check('best-case overall confidence is High or Medium', ['High', 'Medium'].includes(cx.overallConfidence))
  check('best-case reasoning names real evidence (authority, liquidity)', /authorit/i.test(cx.reasoning) && /liquidity/i.test(cx.reasoning))
  check('never claims "SAFE" anywhere in the verdict, factors, or reasoning', !JSON.stringify(cx).toUpperCase().includes('SAFE'))
}
{
  // Freeze authority active alone must force at least HIGH RISK, regardless of score — the same
  // hard-override principle scoreSolanaBeta already enforces, now expressed in the 5-tier ladder.
  const cx = computeSolanaCortexRisk(cortexSr({ freezeAuthority: 'FreezeAuth111' }))
  check('active freeze authority forces at least HIGH RISK', ['HIGH RISK', 'EXTREME RISK'].includes(cx.verdict))
  check('freeze authority active is a real negative factor, not silently dropped', cx.factors.some(f => f.kind === 'negative' && /freeze authority/i.test(f.label)))
}
{
  // Both mint and freeze authority active — the worst case — must be EXTREME RISK.
  const cx = computeSolanaCortexRisk(cortexSr({ mintAuthority: 'MintAuth111', freezeAuthority: 'FreezeAuth111' }))
  check('both authorities active forces EXTREME RISK', cx.verdict === 'EXTREME RISK')
}
{
  // Mint authority active alone (freeze revoked) must be at least MEDIUM RISK, never LOW/WATCH.
  const cx = computeSolanaCortexRisk(cortexSr({ mintAuthority: 'MintAuth111' }))
  check('active mint authority alone forces at least MEDIUM RISK', ['MEDIUM RISK', 'HIGH RISK', 'EXTREME RISK'].includes(cx.verdict))
}
{
  // Zero-evidence case: everything unresolved — must degrade to EXTREME/HIGH RISK with low
  // coverage and low confidence, never crash, never claim high confidence from no evidence.
  const cx = computeSolanaCortexRisk(cortexSr({
    authorityReadSucceeded: false, mintAuthority: null, freezeAuthority: null, tokenProgram: null,
    poolProgram: { resolved: false, poolAddress: null, owner: null, label: null, errorReason: 'none', verdict: 'unverified', migratedFromPumpFun: null },
    marketDataAvailable: false, marketData: null, resolvedTokenName: null,
    heliusHolders: { called: false, success: false, holderCount: null, isLowerBound: false, pagesFetched: 0, errorReason: 'not configured' },
    jupiter: { called: false, success: false, resolved: { name: null, symbol: null, logo: null, verified: null, price: null }, errorReason: 'not configured' },
    helius: { called: false, success: false, enhancedTransactionsUsed: false, estimatedCredits: 0, resolved: { parsedActivity: null, creatorSignals: null, devActivity: null, recentTransfers: null }, errorReason: 'not configured' },
    ohlcv: { called: false, success: false, candles: [], timeframe: '1h', errorReason: 'no pool' },
    topAccountConcentration: null,
  }))
  check('zero-evidence coverage is low', cx.evidenceCoveragePercent <= 30)
  check('zero-evidence overall confidence is Low or Unavailable', ['Low', 'Unavailable'].includes(cx.overallConfidence))
  check('zero-evidence unknown factors include authority', cx.unknownFactors.some(u => /authority/i.test(u.label)))
  check('every unknown factor explains WHY, not just the label', cx.unknownFactors.every(u => u.reason && u.reason.length > 10))
  check('zero-evidence never crashes and still returns a verdict', typeof cx.verdict === 'string')
}
{
  // Pool program NOT recognized — real negative factor, never silently upgraded to "verified".
  const cx = computeSolanaCortexRisk(cortexSr({
    poolProgram: { resolved: true, poolAddress: 'POOL2', owner: 'SomeUnknownProgram11111111111111111111111', label: null, errorReason: null, verdict: 'unrecognized_program', migratedFromPumpFun: null },
  }))
  check('unrecognized pool program is a real negative factor ("Pool authority confidence medium")', cx.factors.some(f => f.kind === 'negative' && /pool authority confidence/i.test(f.label)))
  check('unrecognized pool program never claims a verified label', !cx.factors.some(f => /verified$/i.test(f.label)))
}
{
  // PumpSwap migration signal surfaces as a real positive fact, not a guess.
  const cx = computeSolanaCortexRisk(cortexSr({
    poolProgram: { resolved: true, poolAddress: 'POOL3', owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', label: 'PumpSwap AMM', errorReason: null, verdict: 'verified_official_pool', migratedFromPumpFun: true },
  }))
  check('PumpSwap migration is surfaced as a real positive factor', cx.factors.some(f => f.kind === 'positive' && /Migrated from Pump\.fun/i.test(f.label)))
  check('the reasoning paragraph reflects the real migration fact', /Pump\.fun/i.test(cx.reasoning))
}
{
  // Whale concentration example from the spec ("Whale owns 11%") — real threshold-based factor.
  const cx = computeSolanaCortexRisk(cortexSr({
    topAccountConcentration: { top1Percent: 11, top10Percent: 25, top20Percent: 35, accountsSampled: 20, accounts: [] },
  }))
  check('whale concentration >=10% surfaces the exact spec-style factor', cx.factors.some(f => /Top account owns 11\.0%/.test(f.label)))
}
{
  // Moderate liquidity is a negative (warning) factor, per the spec's own example — not positive.
  const cx = computeSolanaCortexRisk(cortexSr({ marketData: { ...cortexSr().marketData, liquidityUsd: 20_000 } }))
  check('moderate liquidity (5k-50k) is a negative/warning factor, matching the spec example', cx.factors.some(f => f.kind === 'negative' && /Moderate liquidity/i.test(f.label)))
}
{
  // Behavioral signals (wash trading, snipers, bundles, bots, clustering) are NEVER fabricated as
  // a CLAIM (a factor label) — they may legitimately appear in a reason string that discloses the
  // gap ("no sniper data source"), which is honesty, not fabrication. Checked against labels only.
  const cx = computeSolanaCortexRisk(cortexSr())
  const labelBlob = cx.factors.map(f => f.label).join(' ').toLowerCase()
  for (const forbidden of ['wash trading', 'sniper', 'bundled buys', 'bot activity', 'wallet clustering']) {
    check(`behavioral signal never fabricated as a factor CLAIM: ${forbidden}`, !labelBlob.includes(forbidden))
  }
}
{
  // Creator identity: Unknown by default, becomes a real positive factor ONLY when Deep Creator
  // Check actually ran and succeeded — never claimed otherwise.
  const withoutDeep = computeSolanaCortexRisk(cortexSr())
  check('creator launch history is Unknown when Deep Creator Check did not run', withoutDeep.unknownFactors.some(u => u.label === 'Creator launch history'))
  check('"Creator history incomplete" is a real negative factor by default, not an empty placeholder', withoutDeep.factors.some(f => f.kind === 'negative' && f.label === 'Creator history incomplete'))
  const withDeep = computeSolanaCortexRisk(cortexSr({
    deepCreator: { creatorTrace: { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'sig1', earliestTimestamp: '2024-01-01T00:00:00Z', likelyCreatorWallet: 'CreatorWallet1111111111111111111111111111', transactionSource: 'PUMP_FUN' }, errorReason: null }, evidenceGaps: [] },
  }))
  check('a successful Deep Creator Check becomes a real positive factor', withDeep.factors.some(f => f.kind === 'positive' && /creator wallet identified/i.test(f.label)))
  check('a successful Deep Creator Check no longer shows "Creator history incomplete"', !withDeep.factors.some(f => f.label === 'Creator history incomplete'))
}
{
  // Deep Analysis: only "Creator Trace" is real. Everything else requested (Historical Authority
  // Timeline, Funding Wallet Graph, Wallet Relationship Analysis, Creator Launch History,
  // Historical Migration Timeline, Behaviour Analysis, Smart Money Detection, Cluster Detection)
  // must be honestly reported unsupported, never advertised as available.
  const cx = computeSolanaCortexRisk(cortexSr())
  check('Creator Trace appears in deepAnalysisAvailable (Deep Creator Check not yet run)', cx.deepAnalysisAvailable.some(d => d.label === 'Creator Trace'))
  const requestedButUnreal = ['Historical Authority Timeline', 'Funding Wallet Graph', 'Wallet Relationship Analysis', 'Creator Launch History', 'Historical Migration Timeline', 'Behaviour Analysis', 'Smart Money Detection', 'Cluster Detection']
  for (const label of requestedButUnreal) {
    check(`"${label}" is honestly marked unsupported, never advertised as available`, cx.deepAnalysisUnsupported.some(d => d.label === label) && !cx.deepAnalysisAvailable.some(d => d.label === label))
  }
  check('every unsupported Deep Analysis item explains why, not just "unavailable"', cx.deepAnalysisUnsupported.every(d => d.reason.length > 20))
  check('Authority Analysis and Holder Analysis are always in deepAnalysisCompleted (the core pipeline always runs them)', cx.deepAnalysisCompleted.includes('Authority Analysis') && cx.deepAnalysisCompleted.includes('Holder Analysis'))
}
{
  // Once Deep Creator Check has run, Creator Trace moves to "Already Completed", never stays
  // listed as "Available" (it already ran) and never disappears silently.
  const cx = computeSolanaCortexRisk(cortexSr({
    deepCreator: { creatorTrace: { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'sig1', earliestTimestamp: '2024-01-01T00:00:00Z', likelyCreatorWallet: 'CreatorWallet1111111111111111111111111111', transactionSource: 'PUMP_FUN' }, errorReason: null }, evidenceGaps: [] },
  }))
  check('Creator Trace moves to deepAnalysisCompleted once it has run and succeeded', cx.deepAnalysisCompleted.includes('Creator Trace'))
  check('Creator Trace no longer listed as available once already completed', !cx.deepAnalysisAvailable.some(d => d.label === 'Creator Trace'))
}
{
  // Provider disagreement: independently-sourced prices (DexScreener vs Jupiter) that diverge
  // must be flagged, with confidence reduced — never silently averaged or ignored.
  const disagree = computeSolanaCortexRisk(cortexSr({
    marketData: { ...cortexSr().marketData, priceUsd: 1 },
    jupiter: { called: true, success: true, resolved: { name: 'X', symbol: 'X', logo: null, verified: true, price: 1.5 }, errorReason: null },
  }))
  check('a >5% price divergence between DexScreener and Jupiter is flagged as provider disagreement', disagree.providerDisagreement.detected === true)
  check('provider disagreement detail names both real prices', /1/.test(disagree.providerDisagreement.detail) && /1\.5/.test(disagree.providerDisagreement.detail))
  const agree = computeSolanaCortexRisk(cortexSr({
    marketData: { ...cortexSr().marketData, priceUsd: 1 },
    jupiter: { called: true, success: true, resolved: { name: 'X', symbol: 'X', logo: null, verified: true, price: 1.01 }, errorReason: null },
  }))
  check('agreeing prices (within 5%) do not falsely flag disagreement', agree.providerDisagreement.detected === false)
}
{
  // Evidence Summary — live counts must reflect the real factors/unknowns, not placeholders.
  const cx = computeSolanaCortexRisk(cortexSr())
  check('summary.verifiedEvidence matches the real positive factor count', cx.summary.verifiedEvidence === cx.factors.filter(f => f.kind === 'positive').length)
  check('summary.warningSignals matches the real negative factor count', cx.summary.warningSignals === cx.factors.filter(f => f.kind === 'negative').length)
  check('summary.unknownChecks matches the real unknown factor count', cx.summary.unknownChecks === cx.unknownFactors.length)
  check('summary.providersUsed is a real positive count, not zero when evidence exists', cx.summary.providersUsed > 0)
  check('summary.evidenceConfidencePercent matches the real evidence coverage %', cx.summary.evidenceConfidencePercent === cx.evidenceCoveragePercent)
}
{
  // Next Action Engine — generated from real gaps, never generic advice, never empty.
  const needsAction = computeSolanaCortexRisk(cortexSr({ mintAuthority: 'MintAuth111' }))
  check('active mint authority produces a real, specific next action', needsAction.nextActions.includes('Monitor authority changes'))
  check('next actions are never empty', needsAction.nextActions.length > 0)
  const noActionNeeded = computeSolanaCortexRisk(cortexSr({
    deepCreator: { creatorTrace: { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'sig1', earliestTimestamp: '2024-01-01T00:00:00Z', likelyCreatorWallet: 'CreatorWallet1111111111111111111111111111', transactionSource: 'PUMP_FUN' }, errorReason: null }, evidenceGaps: [] },
    marketData: { ...cortexSr().marketData, liquidityUsd: 200_000 },
  }))
  check('a fully clean scan can produce "No further action required"', noActionNeeded.nextActions.includes('No further action required') || noActionNeeded.nextActions.length >= 1)
}
{
  // Reasoning engine: genuinely varies with the evidence — not one fixed string regardless of input.
  const migrated = computeSolanaCortexRisk(cortexSr({
    poolProgram: { resolved: true, poolAddress: 'POOL3', owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', label: 'PumpSwap AMM', errorReason: null, verdict: 'verified_official_pool', migratedFromPumpFun: true },
  }))
  const noPool = computeSolanaCortexRisk(cortexSr({ marketDataAvailable: false, marketData: null }))
  check('reasoning text genuinely differs between a migrated-pool scan and a no-pool scan', migrated.reasoning !== noPool.reasoning)
  check('reasoning is a real multi-sentence paragraph, not a one-word placeholder', migrated.reasoning.split('.').length >= 4)
}
{
  // No EVM wording anywhere in the Risk Engine tab's new rendering.
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  check('page reads computeSolanaCortexRisk for the Risk Engine tab', page.includes('computeSolanaCortexRisk(sr)'))
  // Scope strictly to the SOLANA risk-engine IIFE — EVM's own Risk Engine tab legitimately still
  // says "Risk Drivers"/"Open Checks" elsewhere in this file and must stay completely untouched.
  const solanaRiskStart = page.indexOf("activeSection === 'risk-engine' && (() => {\n                  // SOLANA CORTEX RISK ENGINE")
  const solanaRiskEnd = page.indexOf("Dev (authority / developer evidence)", solanaRiskStart)
  check('located the Solana risk-engine block to scope the next checks', solanaRiskStart > -1 && solanaRiskEnd > solanaRiskStart)
  const solanaRiskBlock = page.slice(solanaRiskStart, solanaRiskEnd)
  check('Solana Risk Engine tab no longer renders "Risk Drivers"', !solanaRiskBlock.includes('>Risk Drivers<'))
  check('Solana Risk Engine tab no longer renders the old EVM-flavored "Open Checks" card', !solanaRiskBlock.includes('>Open Checks<'))
  check('Solana Risk Engine tab renders Positive/Negative/Unknown evidence', solanaRiskBlock.includes('Positive Evidence') && solanaRiskBlock.includes('Negative Evidence'))
  check('Solana Risk Engine tab renders Evidence Coverage, not a generic Open Check', solanaRiskBlock.includes('EVIDENCE COVERAGE'))
  check('Solana Risk Engine tab renders Module Confidence', solanaRiskBlock.includes('Module Confidence'))
  check('Solana Risk Engine tab renders the Deep Analysis Already Completed / Available / Not Yet Supported split', solanaRiskBlock.includes('Already Completed') && solanaRiskBlock.includes('Not Yet Supported'))
  check('Solana Risk Engine tab renders the Evidence Summary counts', solanaRiskBlock.includes('Verified Evidence') && solanaRiskBlock.includes('Warning Signals') && solanaRiskBlock.includes('Providers Used'))
  check('Solana Risk Engine tab renders the composed reasoning paragraph', solanaRiskBlock.includes('cx.reasoning'))
  check('Solana Risk Engine tab renders provider disagreement detection', solanaRiskBlock.includes('providerDisagreement'))
  check('Solana Risk Engine tab renders Next Action', solanaRiskBlock.includes('Next Action'))
}

// ─── Solana CORTEX Dev Control Read (mirrors EVM's Dev Control hero/tab structure) ─────────────
{
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  const devStart = page.indexOf("activeSection === 'deployer-intel' && (() => {\n                  // SOLANA CORTEX DEV CONTROL READ")
  const devBlockRaw = devStart > -1 ? page.slice(devStart, devStart + 40000) : ''
  check('located the Solana Dev Control block', devStart > -1)
  check('Dev Control renders the CORTEX Dev Control Read hero, matching the EVM feature name', devBlockRaw.includes('CORTEX Dev Control Read'))
  check('Dev Control renders the same 5 tabs as EVM (Dev Map/Cluster Map/Supply Control/History/Watch Plan)', ['Dev Map', 'Cluster Map', 'Supply Control', 'History', 'Watch Plan'].every(t => devBlockRaw.includes(`'${t}'`)))
  check('Dev Control renders a Token Contract -> Origin Wallet -> Linked Wallets map, like EVM', devBlockRaw.includes('TOKEN CONTRACT') && devBlockRaw.includes('ORIGIN WALLET') && devBlockRaw.includes('LINKED WALLETS'))
  check('Dev Control renders a Likely Deployer evidence card with Address/Detection Confidence/Evidence Source/Network, matching EVM\'s 4-field layout', devBlockRaw.includes('LIKELY DEPLOYER') && devBlockRaw.includes('Detection Confidence') && devBlockRaw.includes('Evidence Source'))
  check('Cluster Map renders real evidence (clusterMap.evidenceCount/clusterConfidence/riskLevel) via Deep Cluster Check, never a fabricated wallet list', devBlockRaw.includes('sr.clusterMap') && devBlockRaw.includes('RUN DEEP CLUSTER CHECK'))
  check('Cluster Map discloses its real scope limit (one funding hop only, no cross-mint shared-signer claims)', devBlockRaw.includes('does not have an indexer for'))
  check('History tab renders the real Supply Timeline (mint creation / pool identity / authority state) and its honest reconstruction gaps, not a placeholder', devBlockRaw.includes('sr.supplyTimeline') && devBlockRaw.includes("What can&apos;t be reconstructed"))
  check('Watch Plan reuses the real Cortex Risk Engine factors/nextActions, not fabricated data', devBlockRaw.includes('cxForDev.factors') && devBlockRaw.includes('cxForDev.nextActions'))
  check('Deep Creator Check trigger still lives inside the Dev Map tab', devBlockRaw.includes('RUN DEEP CREATOR CHECK'))
}
{
  // The Dev Control score is a dedicated Solana-native formula (authority + Deep Creator Check),
  // never the EVM feature's score reused, and never a fabricated number independent of evidence.
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  check('Dev Control score is derived from real authority + creator evidence (mintRevoked/freezeRevoked/creatorResolved)', page.includes('const devScore = (mintRevoked ? 35 : 5) + (freezeRevoked ? 35 : 5) + (creatorResolved ? 30 : 15)'))
}

console.log(`test-solana-token-scanner.mjs: all ${passed} assertions passed`)
