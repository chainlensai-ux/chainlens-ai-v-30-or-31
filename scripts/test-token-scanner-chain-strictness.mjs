// TESTS — Token Scanner chain strictness fix (lib/tokenScannerChainStrictness.ts). Pure/synchronous
// decision core, no network. Covers the required scenarios: same-chain scans pass, cross-chain
// scans block, separate cache keys per chain, cross-chain cache rejection, and that the decision
// never mutates/returns a different chain than requested (no auto-switch).

import assert from 'node:assert/strict'
import {
  resolveTokenScanChainDecision,
  buildTokenScanCacheKey,
  isCacheHitValid,
  CHAIN_ID_BY_SLUG,
} from '../lib/tokenScannerChainStrictness.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const ADDR = '0xabc0000000000000000000000000000000dead'

function probe(chain, poolCount, bytecode) { return { chain, poolCount, bytecode } }

// ─── Base token + Base selected scans (bytecode found -> never blocked) ────────────────────────
{
  const { blocked, audit } = resolveTokenScanChainDecision({
    userSelectedChain: 'base',
    requestedChainSlug: 'base',
    inputAddress: ADDR,
    normalizedAddress: ADDR,
    selectedProbe: probe('base', 3, '0x6080604052'),
  })
  check('Base token + Base selected: not blocked', blocked === false)
  check('Base token + Base selected: tokenExistsOnSelectedChain true', audit.tokenExistsOnSelectedChain === true)
  check('Base token + Base selected: finalChainSlug stays base (no switch)', audit.finalChainSlug === 'base')
  check('Base token + Base selected: autoSwitchedChain always false', audit.autoSwitchedChain === false)
}

// ─── Base token + Ethereum selected blocks (confirmed absent on eth, found on base) ─────────────
{
  const { blocked, errorMessage, audit } = resolveTokenScanChainDecision({
    userSelectedChain: 'eth',
    requestedChainSlug: 'eth',
    inputAddress: ADDR,
    normalizedAddress: ADDR,
    selectedProbe: probe('eth', 0, '0x'),
    candidateProbes: [probe('base', 3, '0x6080604052'), probe('bnb', 0, '0x'), probe('robinhood', 0, '0x')],
  })
  check('Base token + Ethereum selected: blocked', blocked === true)
  check('Base token + Ethereum selected: exact required error copy', errorMessage === 'Token not found on Ethereum. This contract may exist on Base. Switch to Base to scan it.')
  check('Base token + Ethereum selected: crossChainCandidateChain = base', audit.crossChainCandidateChain === 'base')
  check('Base token + Ethereum selected: never auto-switched', audit.autoSwitchedChain === false && audit.finalChainSlug === 'eth')
}

// ─── Base token + BNB selected blocks ───────────────────────────────────────────────────────────
{
  const { blocked, audit } = resolveTokenScanChainDecision({
    userSelectedChain: 'bnb',
    requestedChainSlug: 'bnb',
    inputAddress: ADDR,
    normalizedAddress: ADDR,
    selectedProbe: probe('bnb', 0, '0x'),
    candidateProbes: [probe('base', 5, '0x6080604052'), probe('eth', 0, '0x'), probe('robinhood', 0, '0x')],
  })
  check('Base token + BNB selected: blocked', blocked === true)
  check('Base token + BNB selected: candidate chain is base', audit.crossChainCandidateChain === 'base')
}

// ─── Ethereum token + Ethereum selected scans ───────────────────────────────────────────────────
{
  const { blocked } = resolveTokenScanChainDecision({
    userSelectedChain: 'eth',
    requestedChainSlug: 'eth',
    inputAddress: ADDR,
    normalizedAddress: ADDR,
    selectedProbe: probe('eth', 2, '0x6080604052'),
  })
  check('Ethereum token + Ethereum selected: not blocked', blocked === false)
}

// ─── Ethereum token + Base selected blocks ──────────────────────────────────────────────────────
{
  const { blocked, errorMessage } = resolveTokenScanChainDecision({
    userSelectedChain: 'base',
    requestedChainSlug: 'base',
    inputAddress: ADDR,
    normalizedAddress: ADDR,
    selectedProbe: probe('base', 0, '0x'),
    candidateProbes: [probe('eth', 4, '0x6080604052'), probe('bnb', 0, '0x'), probe('robinhood', 0, '0x')],
  })
  check('Ethereum token + Base selected: blocked', blocked === true)
  check('Ethereum token + Base selected: exact required error copy', errorMessage === 'Token not found on Base. This contract may exist on Ethereum. Switch to Ethereum to scan it.')
}

// ─── Robinhood token + Robinhood selected scans ─────────────────────────────────────────────────
{
  const { blocked, audit } = resolveTokenScanChainDecision({
    userSelectedChain: 'robinhood',
    requestedChainSlug: 'robinhood',
    inputAddress: ADDR,
    normalizedAddress: ADDR,
    selectedProbe: probe('robinhood', 1, '0x6080604052'),
  })
  check('Robinhood token + Robinhood selected: not blocked', blocked === false)
  check('Robinhood token + Robinhood selected: requestedChainId = 4663', audit.requestedChainId === 4663)
}

// ─── Robinhood token + Base selected blocks ─────────────────────────────────────────────────────
{
  const { blocked, audit } = resolveTokenScanChainDecision({
    userSelectedChain: 'base',
    requestedChainSlug: 'base',
    inputAddress: ADDR,
    normalizedAddress: ADDR,
    selectedProbe: probe('base', 0, '0x'),
    candidateProbes: [probe('eth', 0, '0x'), probe('bnb', 0, '0x'), probe('robinhood', 1, '0x6080604052')],
  })
  check('Robinhood token + Base selected: blocked', blocked === true)
  check('Robinhood token + Base selected: candidate chain is robinhood', audit.crossChainCandidateChain === 'robinhood')
}

// ─── Same 0x address on different chains uses separate cache keys ──────────────────────────────
{
  const keyBase = buildTokenScanCacheKey('base', CHAIN_ID_BY_SLUG.base, ADDR)
  const keyEth = buildTokenScanCacheKey('eth', CHAIN_ID_BY_SLUG.eth, ADDR)
  const keyBnb = buildTokenScanCacheKey('bnb', CHAIN_ID_BY_SLUG.bnb, ADDR)
  const keyRh = buildTokenScanCacheKey('robinhood', CHAIN_ID_BY_SLUG.robinhood, ADDR)
  check('cache keys use the exact required format', keyBase === `tokenScan:base:8453:${ADDR}`)
  check('same address on different chains -> all four cache keys distinct', new Set([keyBase, keyEth, keyBnb, keyRh]).size === 4)
}

// ─── Cross-chain cached result is rejected ──────────────────────────────────────────────────────
{
  const cachedFromBase = { chainSlug: 'base', chainId: 8453, tokenAddress: ADDR }
  const requestedEth = { chainSlug: 'eth', chainId: 1, tokenAddress: ADDR }
  check('a Base-produced cache entry is rejected for an Ethereum request', isCacheHitValid(cachedFromBase, requestedEth) === false)
  const requestedBaseSameAddr = { chainSlug: 'base', chainId: 8453, tokenAddress: ADDR }
  check('a Base-produced cache entry is accepted for the same Base request', isCacheHitValid(cachedFromBase, requestedBaseSameAddr) === true)
  const requestedBaseDifferentAddr = { chainSlug: 'base', chainId: 8453, tokenAddress: '0xdifferent00000000000000000000000000001' }
  check('same chain but different address is rejected', isCacheHitValid(cachedFromBase, requestedBaseDifferentAddr) === false)
}

// ─── An inconclusive (RPC-failed) bytecode result never blocks — fail open ──────────────────────
{
  const { blocked, audit } = resolveTokenScanChainDecision({
    userSelectedChain: 'eth',
    requestedChainSlug: 'eth',
    inputAddress: ADDR,
    normalizedAddress: ADDR,
    selectedProbe: probe('eth', 0, null),
  })
  check('inconclusive bytecode (RPC failure) never blocks the scan', blocked === false)
  check('inconclusive bytecode -> tokenExistsOnSelectedChain is null, not false', audit.tokenExistsOnSelectedChain === null)
}

// ─── No candidate found anywhere -> honest "not found", no fabricated candidate ─────────────────
{
  const { blocked, errorMessage, audit } = resolveTokenScanChainDecision({
    userSelectedChain: 'eth',
    requestedChainSlug: 'eth',
    inputAddress: ADDR,
    normalizedAddress: ADDR,
    selectedProbe: probe('eth', 0, '0x'),
    candidateProbes: [probe('base', 0, '0x'), probe('bnb', 0, '0x'), probe('robinhood', 0, '0x')],
  })
  check('confirmed absent everywhere -> blocked', blocked === true)
  check('confirmed absent everywhere -> no fabricated candidate', audit.crossChainCandidateFound === false && audit.crossChainCandidateChain === null)
  check('confirmed absent everywhere -> exact no-candidate copy', errorMessage === 'Token not found on Ethereum.')
}

// ─── Structural guards on the route + UI source (no reassignment, click-gated CTA) ──────────────
{
  const fs = await import('node:fs')
  const routeSrc = fs.readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(routeSrc, /^\s*chain\s*=\s*altChain\s*$/m, 'the old silent chain-reassignment line of code is gone for good (a disclosure comment may still name the old pattern)')
  assert.match(routeSrc, /const chain: ChainKey = rawChain as ChainKey/, 'chain is declared const — TypeScript itself now forbids reassigning it')
  assert.match(routeSrc, /resolveTokenScanChainDecision\(/, 'route uses the pure chain-strictness decision core')
  passed += 3

  const uiSrc = fs.readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  assert.match(uiSrc, /Switch to \{chainDisplayName\(crossChainSwitchCandidate\.chain\)\} and scan/, 'the optional switch CTA copy is present')
  // The CTA's handleScan call must live inside an onClick handler, not fire on mount/render.
  assert.match(uiSrc, /onClick=\{\(\) => \{[\s\S]{0,400}?void handleScan\(candidate\.address, candidate\.chain\)/, 'switch-and-scan only fires from an onClick — never automatically')
  assert.doesNotMatch(uiSrc, /useEffect\(\(\) => \{[\s\S]{0,200}?handleScan\(candidate\.address/, 'switch-and-scan is never wired into a useEffect')
  passed += 2
}

console.log(`test-token-scanner-chain-strictness: ${passed} checks passed`)
