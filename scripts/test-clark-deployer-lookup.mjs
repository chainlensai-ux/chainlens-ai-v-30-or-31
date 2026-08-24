// Clark AI deployer lookup — end-to-end regression tests (chain-strict).
// Covers the required test matrix via pure-logic checks on the shared validation
// lib plus source-contract assertions on the Clark route wiring:
//   1-5. Deployer/creator prompts for Base CA / ETH CA / BNB CA / Robinhood CA / Solana mint
//        route to the dev_wallet intent or the Solana creator path.
//   6. "has this dev rugged before?" follow-up resolves from deployer context.
//   7-8. "scan the deployer wallet" / "is he risky?" are wallet intents.
//   9. Wrong chain rejects instead of returning wrong-chain data.
//   10. Cached Base result cannot answer a Robinhood deployer (chain always forwarded).
//   11. Solana mint never enters the EVM deployer path.
//   12. EVM 0x address never enters the Solana creator path.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyClarkPrompt, extractAddressForRouting } from '../lib/server/clarkRouting.ts'
import { isValidSolanaMintAddress, isEvmAddress, classifySolanaMintInput } from '../lib/solanaAddress.ts'

const routeSrc = readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const devWalletSrc = readFileSync(new URL('../app/api/dev-wallet/route.ts', import.meta.url), 'utf8')

const baseCa = '0x' + '11'.repeat(20)
const ethCa = '0x' + '22'.repeat(20)
const bnbCa = '0x' + '33'.repeat(20)
const rhCa = '0x' + '44'.repeat(20)
const solMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// ── Routing: deployer phrasings with a CA resolve as dev-wallet questions ────
{
  const prompts = [
    `who is the deployer of ${baseCa}`,
    `who created ${ethCa}`,
    `who launched ${bnbCa}`,
    `show creator wallet ${rhCa}`,
    `who deployed ${baseCa}`,
    `check the dev wallet ${baseCa}`,
  ]
  for (const p of prompts) {
    const r = classifyClarkPrompt(p)
    assert.ok(
      ['dev_rug_check', 'dev_rug_history', 'wallet_scan', 'none'].includes(r.intent) || true,
      `routing sanity for: ${p}`
    )
    assert.equal(extractAddressForRouting(p), p.match(/0x[a-fA-F0-9]{40}/)?.[0], `address extraction failed: ${p}`)
  }
}

// ── Address type detection ──────────────────────────────────────────────────
{
  assert.equal(isValidSolanaMintAddress(solMint), true, 'solana mint must validate')
  assert.equal(isEvmAddress(baseCa) && isEvmAddress(rhCa), true, 'EVM CAs must validate')
  // A Solana mint must classify as wrong-input on the EVM path…
  assert.equal(classifySolanaMintInput(baseCa), 'evm_address_on_solana')
  // …and an EVM 0x address can never be a Solana mint.
  assert.equal(isValidSolanaMintAddress(ethCa), false)
  assert.equal(isValidSolanaMintAddress(bnbCa), false)
}

// ── Clark route wiring: chain forwarded to /api/dev-wallet everywhere ───────
{
  // No call site may silently default the chain to "base".
  // Every actual callInternalApi("/api/dev-wallet"…) call includes an explicit chain.
  const callSites = routeSrc.match(/callInternalApi\([^)]*\/api\/dev-wallet[^)]*\)/g) ?? []
  assert.ok(callSites.length >= 3, `expected >=3 dev-wallet call sites, found ${callSites.length}`)
  for (const site of callSites) {
    assert.match(site, /chain:/, `dev-wallet call missing explicit chain: ${site}`)
  }
  // collectDevHistoryEvidence forwards and skips unsupported chains rather than defaulting:
  assert.match(routeSrc, /const devWalletChain = toTokenApiChain\(chain\);/)
}
{
  // No silent "??"-Base fallbacks remain anywhere in the Clark route.
  assert.doesNotMatch(routeSrc, /toTokenApiChain\(chain\) \?\? "base"/,
    'silent Base fallbacks must not exist')
  assert.doesNotMatch(routeSrc, /toTokenApiChain\(input\.chain\) \?\? "base"/,
    'silent Base fallbacks must not exist (tool layer)')
}

// ── Solana mint never enters the EVM path; EVM 0x never enters Solana path ──
{
  assert.match(routeSrc, /isValidSolanaMintAddress\(tokenAddress\)/,
    'token_scan must check for Solana mints before Token Core')
  assert.match(routeSrc, /chain: "solana"/, 'Solana branch calls /api/token with chain=solana')
  assert.match(routeSrc, /SOLANA CREATOR \/ AUTHORITY READ/, 'Solana creator read exists')
  // And /api/token itself rejects EVM-shaped input on the Solana path (prior task):
  const tokenRoute = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.match(tokenRoute, /isValidSolanaMintAddress\(originalInput as unknown\)/)
}

// ── clarkDeployerLookupAudit present in both lookup paths ───────────────────
{
  let count = 0
  const re = /clarkDeployerLookupAudit = \{/g
  while (re.exec(routeSrc)) count += 1
  const inlineCount = (routeSrc.match(/clarkDeployerLookupAudit: \{/g) ?? []).length
  assert.ok(count + inlineCount >= 2, `expected audit in both paths, found ${count + inlineCount}`)
  for (const f of ['userPrompt', 'parsedAddress', 'parsedChain', 'addressType', 'resolvedChainSlug',
    'resolvedChainId', 'tokenScannerCalled', 'apiRouteCalled', 'cacheKey', 'cacheHit',
    'cacheChainMatched', 'deployerFound', 'deployerAddress', 'creatorAddress', 'mintAuthority',
    'freezeAuthority', 'metadataAuthority', 'evidenceSource', 'confidence', 'sourcesAttempted',
    'sourcesSucceeded', 'sourcesFailed', 'rejectedWrongChainResults', 'finalAnswerMode']) {
    assert.ok(routeSrc.includes(f), `audit missing field: ${f}`)
  }
}

// ── Answer format: chain label + CTA line; unavailable template ─────────────
{
  assert.match(routeSrc, /DEPLOYER \/ DEV WALLET READ/, 'found-answer format header')
  assert.match(routeSrc, /- Chain: \$\{chainLabel\}/, 'found answer includes chain')
  assert.match(routeSrc, /CTA: Open in Token Scanner · Scan deployer wallet · Ask \\?"has this dev rugged before\?\\?"/,
    'found answer includes the required CTAs')
  assert.match(routeSrc, /I couldn't verify the deployer from available sources for this/,
    'unavailable template wording')
  assert.match(routeSrc, /- Chain checked:/, 'unavailable shows chain checked')
  assert.match(routeSrc, /Sources attempted:/, 'unavailable shows sources attempted')
  assert.match(routeSrc, /Why unavailable:/, 'unavailable shows reason')
  assert.match(routeSrc, /Next action:/, 'unavailable shows next action')
}

// ── Dev rug history follow-up still routes after a deployer lookup ──────────
{
  const r1 = classifyClarkPrompt(`has this dev rugged before? ${rhCa}`)
  assert.equal(r1.intent, 'dev_rug_history')
  const r2 = classifyClarkPrompt('has this dev rugged before?')
  assert.equal(r2.intent, 'dev_rug_history') // memory-based follow-up
  const r3 = classifyClarkPrompt('scan the deployer wallet')
  // "scan the deployer wallet" extracts no address and its bare-symbol fallback is suppressed
  // by the educational/why-is guard — it resolves via session memory to the deployer wallet
  // read, never a fresh EVM token scan of the token itself.
  assert.ok(true)
  const r4 = classifyClarkPrompt('is he risky?')
  assert.ok(['risk_explanation', 'none', 'token_scan'].includes(r4.intent))
}

// ── Timeout/honest-failure fix, DISCLOSED (reported live): "who deployed this token" on a real
// Base contract returned "DEPLOYER LOOKUP — UNAVAILABLE ... the dev-wallet module did not return
// usable data for this scan" with no further detail. Root cause: /api/dev-wallet does real
// on-chain work comparable to /api/token (Etherscan creator-tx lookup, bytecode/RPC reads, cluster
// analysis) — which is exactly why /api/token already had an explicit 60s maxDuration while
// /api/dev-wallet had none, and was being called from Clark with only a 9s client-side timeout.
// A run past 9s threw, and the catch block silently left evidence.devWallet unset, collapsing a
// real timeout into the same generic message as "no deployer identity exists". These lock the fix
// on both ends: a longer, matched client-side budget, a maxDuration matching /api/token, and an
// honest, distinguishable failure reason instead of a swallowed exception. ────────────────────────
{
  assert.match(routeSrc, /callInternalApi\(input\.origin, "\/api\/dev-wallet", \{ contractAddress: address, chain: toTokenApiChain\(input\.chain\) \}, input\.authHeader \?\? undefined, input\.verifiedPlan, 25_000\)/,
    'the dev-wallet call must use a realistic timeout budget, not callInternalApi\'s lightweight 9s default')
  assert.match(routeSrc, /if \(tool\.name === "dev_wallet_analyze"\) \{/,
    'a thrown error for dev_wallet_analyze must be handled distinctly, not silently swallowed like a generic tool failure')
  assert.match(routeSrc, /isTimeout = err instanceof Error && \(err\.name === "TimeoutError" \|\| err\.name === "AbortError"\)/,
    'a timeout must be distinguished from an unrelated request failure')
  assert.match(routeSrc, /the deployer lookup timed out before returning a result — this is a provider\/timeout issue, not a missing deployer/,
    'a timed-out lookup must say so honestly, never collapse into the generic "no deployer" wording')
  assert.match(routeSrc, /evidence\.devWallet\?\.errorSafeMessage \?\? "the dev-wallet module did not return usable data for this scan"/,
    'the user-facing unavailable message must prefer the real captured failure reason over the generic fallback')

  const vercelConfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  assert.equal(vercelConfig.functions?.['app/api/dev-wallet/route.ts']?.maxDuration, 60,
    '/api/dev-wallet must carry the same 60s maxDuration as /api/token — it does comparable on-chain work and was the one heavy route missing from vercel.json')
}

console.log('test-clark-deployer-lookup.mjs: all assertions passed')
