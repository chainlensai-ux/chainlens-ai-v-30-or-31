import assert from 'node:assert/strict'
import fs from 'node:fs'

// SAME-ADDRESS-MULTI-CHAIN DISCLOSURE, DISCLOSED.
//
// Reported live: after the skipped-chain-honesty fix, the user tested a real BNB token with no
// chain named and it still showed "Base." Followed up per the diagnostic suggestion by explicitly
// asking "is 0x... safe on bnb" — and got REAL but DIFFERENT evidence back (proxy/mint/ownership
// reported as unverified, vs the no-chain-named default's confirmed values with similar market
// numbers). That proved both reads were genuine, not a routing bug: the exact same contract address
// has real, verifiable code deployed on more than one chain (a "vanity"/CREATE2 cross-chain
// deployment, which is common for multi-chain meme/token launches). The previous auto-detection
// logic picked whichever chain it happened to probe first (Base, first in the candidate list) with
// no indication a second real match existed on another chain — presenting an ambiguous result with
// the same confidence as an unambiguous one.
//
// Fix: detectChainForAddress now collects every chain where a real contract was found (not just the
// winner) as multiChainContracts. When more than one exists, the caller prepends a short disclosure
// to the rendered scan naming every chain where a match was found and how to ask for the other
// chain's read specifically — instead of silently presenting one chain's data as if it were the only
// candidate.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ─── The probe must collect every contract hit, not just the first ─────────────────────────────
assert.match(routeCode, /const contractHits = probes\.filter\(\(p\) => p\.result\.resolvedEntityType === 'contract'\);/, 'every chain with real contract code must be collected, not just the winning one')
assert.match(routeCode, /const multiChainContracts = contractHits\.map\(\(p\) => p\.probeChain\);/, 'multiChainContracts must list every chain a real contract was found on')
assert.match(routeCode, /const contractHit = contractHits\[0\];/, 'the first real contract hit still wins as the primary detected chain (existing tie-break preserved)')

// ─── multiChainContracts must be threaded through every return path of the probe ───────────────
for (const returnPattern of [
  /if \(contractHit\) return \{ chain: contractHit\.probeChain, resolvedEntityType: 'contract', skippedChains, multiChainContracts \};/,
  /if \(walletHit\) return \{ chain: walletHit\.probeChain, resolvedEntityType: 'wallet', skippedChains, multiChainContracts \};/,
  /return \{ chain: "base", resolvedEntityType: 'unknown', skippedChains, multiChainContracts \};/,
]) {
  assert.match(routeCode, returnPattern, `every detectChainForAddress return path must include multiChainContracts: ${returnPattern}`)
}

// ─── The gate must capture it, and a dedicated disclosure builder must exist ───────────────────
assert.match(routeCode, /let multiChainContractsForClarkTools: \(SupportedChain \| "robinhood"\)\[\] = \[\];/, 'multiChainContracts must be hoisted to function scope so later scan renders can use it')
assert.match(routeCode, /multiChainContractsForClarkTools = detected\.multiChainContracts;/, 'the gate must capture multiChainContracts from the probe result')
assert.match(routeCode, /function buildMultiChainDisclosure\(scannedChainLabel: string, otherChainLabels: string\[\]\): string \{/, 'a dedicated disclosure builder must exist')
assert.match(routeCode, /this exact contract address has real code on more than one chain/, 'the disclosure must plainly state the real reason — a genuine multi-chain match, not a routing failure')

// ─── Both scan-rendering call sites must actually prepend the disclosure when ambiguous ────────
assert.match(routeCode, /if \(multiChainContractsForClarkTools\.length > 1\) \{\s*\n\s*const otherChains = multiChainContractsForClarkTools\.filter\(\(c\) => c !== chainForClarkTools\)\.map\(\(c\) => chainDisplayLabel\(c\)\);\s*\n\s*if \(otherChains\.length > 0\) fbScanText = buildMultiChainDisclosure\(chainDisplayLabel\(chainForClarkTools\), otherChains\) \+ fbScanText;\s*\n\s*\}/, 'the legacy-cascade fallback scan must prepend the disclosure when the same address matched on more than one chain')
assert.match(routeCode, /const otherChains = multiChainContractsForClarkTools\.filter\(\(c\) => c !== chainForClarkTools\)\.map\(\(c\) => chainDisplayLabel\(c\)\);\s*\n\s*return otherChains\.length > 0 \? buildMultiChainDisclosure\(chainDisplayLabel\(chainForClarkTools\), otherChains\) \+ scanText : scanText;/, 'the main token-question scan must also prepend the disclosure when ambiguous')

console.log('test-clark-multichain-disclosure.mjs: all assertions passed')
