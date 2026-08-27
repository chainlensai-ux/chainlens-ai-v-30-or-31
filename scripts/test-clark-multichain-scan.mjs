import assert from 'node:assert/strict'
import fs from 'node:fs'

// MULTI-CHAIN TOKEN SCAN FIX, DISCLOSED.
//
// Requested: "make sure it can see all tokens on sol robinhood eth and base and bnb."
//
// Findings from the audit:
//  1. The token_scan tool (Clark's core "safety/holders/LP/market cap" evidence source) never
//     passed the actual requested chain to /api/token OR fetchHoneypotSecurity — both were
//     hardcoded to Base, so every non-Base token question silently scanned the wrong network.
//  2. getRpcUrlForClarkCodeCheck (feeds the entity-resolution gate's eth_getCode wallet-vs-
//     contract check) collapsed every chain that wasn't literally "ethereum"/"eth" into Base too
//     — a BNB or Robinhood address got its contract check run against the wrong RPC.
//  3. Solana had a real, already-built handling path deeper in this file (mint/freeze authority,
//     Deep Creator trace via /api/token's existing Solana Beta scanner) that was DEAD CODE — the
//     address extractor feeding it (extractAddressForRouting) only ever recognized 0x-prefixed
//     EVM addresses, so a pasted Solana mint could never reach it. Fixed at the extractor, not by
//     building a second Solana pipeline.
//  4. Robinhood chain was never part of SupportedChain — extending that base type would have
//     forced fake entries into GOLDRUSH_CHAIN/GOPLUS_CHAIN_ID (providers that don't support it).
//     Handled as a narrow, separate detection instead, gated on isRobinhoodChainAvailable() the
//     same way Base Radar's own Robinhood support already is.
//
// Static source assertions, matching this repo's established convention for this route file.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const clarkRoutingSrc = fs.readFileSync(new URL('../lib/server/clarkRouting.ts', import.meta.url), 'utf8')

// ─── token_scan must pass the real chain, never hardcode Base ──────────────────────────────────
assert.match(routeCode, /const _scanChain = toTokenApiChain\(input\.chain\);/, 'token_scan must resolve the real requested chain via toTokenApiChain')
assert.match(routeCode, /callInternalApi\(input\.origin, "\/api\/token", \{ contract: addr, chain: _scanChain \}/, 'token_scan must pass the resolved chain to /api/token, never omit it (which silently defaults to Base)')
assert.match(routeCode, /fetchHoneypotSecurity\(addr, _scanChainId\)/, 'token_scan must pass the resolved chain ID to the honeypot/tax simulation, not the hardcoded literal "base"')
assert.doesNotMatch(routeCode, /fetchHoneypotSecurity\(addr, "base"\)/, 'fetchHoneypotSecurity must never be hardcoded to "base" again')

// ─── No silent Base fallback (established codebase convention) — an unsupported chain (polygon) ──
// must be reported honestly, never silently scanned as if it were Base.
assert.doesNotMatch(routeCode, /toTokenApiChain\(input\.chain\) \?\? "base"/, 'must not silently coalesce an unsupported chain to Base')
assert.match(routeCode, /const _scannableAddr = _validAddr && _scanChain != null;/, 'an unsupported chain must gate the scan off entirely, not proceed against the wrong network')
assert.match(routeCode, /if \(_validAddr && _scanChain == null\) warnings\.push\(/, 'an unsupported chain must produce a real, specific warning explaining why, not a generic failure')

// ─── Entity-resolution gate's eth_getCode check must use the real chain's RPC ───────────────────
assert.match(routeCode, /const c = chain === "ethereum" \? "eth" : chain === "eth" \|\| chain === "base" \|\| chain === "bnb" \|\| chain === "polygon" \|\| chain === "robinhood" \? chain : "base";/, 'getRpcUrlForClarkCodeCheck must resolve every real chain, not collapse everything non-ETH into Base')
assert.match(routeCode, /if \(c === "robinhood"\) return isRobinhoodChainAvailable\(\) \? getRobinhoodRpcUrl\(\) : null;/, 'Robinhood RPC must be gated the same way Base Radar\'s own Robinhood support already is — never silently claim support without the flag/RPC configured')
assert.match(routeCode, /if \(c === "eth" \|\| c === "bnb" \|\| c === "polygon"\) return RPC\[c\] \|\| null;/, 'BNB/ETH/Polygon must resolve their own real RPC from the shared lib/rpc.ts map, not fall through to Base')

// ─── Robinhood chain detection is narrow, additive, and fails closed ───────────────────────────
assert.match(routeCode, /const chainForClarkTools: SupportedChain \| "robinhood" =\s*\n\s*\/\\brobinhood\\b\/i\.test\(prompt\) && isRobinhoodChainAvailable\(\) \? "robinhood" : chain;/, 'Robinhood detection must fail closed to the normal chain when the feature/RPC isn\'t configured')
// SupportedChain itself (and its two exhaustive provider maps) must be untouched — extending it
// would have forced fake Robinhood entries into providers that don't actually support it.
assert.match(routeCode, /type SupportedChain = "base" \| "ethereum" \| "polygon" \| "bnb";/, 'SupportedChain must stay exactly as-is — Robinhood is handled as a separate, narrow union, not by widening every provider-indexed map in this file')

// ─── Solana: fixed at the real root cause (the address extractor), not a duplicate pipeline ────
assert.match(clarkRoutingSrc, /const SOLANA_MINT_CANDIDATE_RE = \/\\b\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\\b\/g;/, 'a Solana mint candidate pattern must exist in the shared routing helpers')
assert.match(clarkRoutingSrc, /if \(candidates\) \{\s*\n\s*for \(const c of candidates\) if \(isValidSolanaMintAddress\(c\)\) return c;\s*\n\s*\}/, 'extractAddressForRouting must fall back to real Solana mint validation, never just pattern-match')
assert.doesNotMatch(routeCode, /solana_token_scan/, 'must not have built a second, duplicate Solana pipeline in app/api/clark/route.ts — the existing mint/freeze-authority handler already there is the one true path')
// The existing (previously unreachable) rich Solana handler must still be present and untouched —
// this fix makes it reachable, it does not replace it.
assert.match(routeCode, /if \(tokenAddress && isValidSolanaMintAddress\(tokenAddress\)\) \{/, 'the existing Solana mint/freeze-authority/Deep-Creator handler must still be in place')

// ─── Deployer questions must not default to a wallet scan on ANY chain (needed for the Solana
// fix above to actually reach the right intent, and fixes the same gap for every chain) ─────────
assert.match(clarkRoutingSrc, /who\\s\+deployed\|deployer\|deployed\\s\+this/, 'a bare "who deployed <address>" must not fall through to the wallet-scan default')

console.log('test-clark-multichain-scan.mjs: all assertions passed')
