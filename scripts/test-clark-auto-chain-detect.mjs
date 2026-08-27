import assert from 'node:assert/strict'
import fs from 'node:fs'

// AUTO-CHAIN-DETECTION, DISCLOSED.
//
// Requested: "when I put the contact adress a system where it khows what chain is it" — a bare
// address pasted with no chain named in the prompt should be auto-detected, not silently assumed
// to be on Base (the prior fix made the "wrong chain" failure honest, but still required the user
// to manually retry with "on eth" — this closes that gap by actually probing).
//
// Design: probes Base/Ethereum/BNB(/Robinhood when configured) in PARALLEL via the same
// eth_getCode-based resolveClarkEntity every other entity check in this file already uses — never
// a second implementation. A contract found on any chain wins (that IS the real chain); a wallet
// verdict from any single chain is sufficient (an EOA has no code on any EVM chain, so it doesn't
// need to check every one to know that). Only runs when the prompt did NOT name a chain explicitly
// — an explicit "on eth" always wins outright and is never second-guessed.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ─── The probe function itself ──────────────────────────────────────────────────────────────
// SKIPPED-CHAIN HONESTY FIX, DISCLOSED (superseding round, same detectChainForAddress): reported
// live that BNB/Robinhood tokens still showed "Base" even with auto-detection wired up. Best-effort
// fix (made without live production diagnostic confirmation — user chose to skip pulling the
// Network-tab audit payload and said to just make a best guess). Hypothesis: Base always has a
// guaranteed hardcoded public RPC fallback, while ETH/BNB/Robinhood require a real configured key
// and return null with NO probe attempted when unset — so an unconfigured chain looked identical to
// "checked, nothing found," letting Base win the race by elimination, not verification.
// detectChainForAddress now splits allChains into candidateChains (real RPC available, actually
// probed) and skippedChains (no RPC configured, never probed at all) and returns skippedChains too.
assert.match(routeCode, /async function detectChainForAddress\(address: string\): Promise<\{ chain: SupportedChain \| "robinhood"; resolvedEntityType: 'contract' \| 'wallet' \| 'unknown'; skippedChains: \(SupportedChain \| "robinhood"\)\[\] \}> \{/, 'detectChainForAddress must exist with the right shape and report skipped (unconfigured RPC) chains')
assert.match(routeCode, /const probes = await Promise\.all\(candidateChains\.map\(async \(probeChain\) => \(\{/, 'every chain must be probed in PARALLEL, not sequentially — sequential probing would multiply the RPC round-trip cost by the number of chains for every single scan')
assert.match(routeCode, /result: await resolveClarkEntity\(\{ address, requestedChain: probeChain, userIntent: 'ambiguous' \}\),/, 'the probe must reuse resolveClarkEntity (the same eth_getCode check), never a second implementation')

// A contract on ANY chain must win the probe.
assert.match(routeCode, /const contractHit = probes\.find\(\(p\) => p\.result\.resolvedEntityType === 'contract'\);\s*\n\s*if \(contractHit\) return \{ chain: contractHit\.probeChain, resolvedEntityType: 'contract', skippedChains \};/, 'a contract found on any probed chain must be returned as the detected chain, along with the skipped-chain list')
// A wallet verdict from any one probe is sufficient (no code on ANY EVM chain for a real EOA).
assert.match(routeCode, /const walletHit = probes\.find\(\(p\) => p\.result\.resolvedEntityType === 'wallet'\);\s*\n\s*if \(walletHit\) return \{ chain: walletHit\.probeChain, resolvedEntityType: 'wallet', skippedChains \};/, 'a wallet verdict from any probe must be accepted — an EOA has no code on any chain, so this is not a shortcut, it is correct')
// All probes failing (RPC errors) must fail open, never claim a chain it didn't actually verify.
assert.match(routeCode, /return \{ chain: "base", resolvedEntityType: 'unknown', skippedChains \};/, 'when every probe genuinely fails, the result must be honestly "unknown", not a guessed chain')

// ─── Robinhood only probed when actually configured (fail closed, no fake support) ─────────────
assert.match(routeCode, /const allChains: \(SupportedChain \| "robinhood"\)\[\] = \["base", "ethereum", "bnb"\];\s*\n\s*if \(isRobinhoodChainAvailable\(\)\) allChains\.push\("robinhood"\);/, 'Robinhood must only be added to the chain list when isRobinhoodChainAvailable() — never probed (or claimed) when the flag/RPC is not configured')
// Only chains with a real, configured RPC URL are actually probed — the rest are tracked as skipped.
assert.match(routeCode, /const candidateChains = rpcAvailability\.filter\(\(c\) => c\.rpcUrl != null\)\.map\(\(c\) => c\.chain\);/, 'candidateChains must be restricted to chains with a real configured RPC URL')
assert.match(routeCode, /const skippedChains = rpcAvailability\.filter\(\(c\) => c\.rpcUrl == null\)\.map\(\(c\) => c\.chain\);/, 'skippedChains must track chains with no RPC configured — never silently conflated with a genuine "checked, found nothing"')

// ─── Wired into the entity gate: explicit chain skips the probe; unnamed chain uses it ─────────
assert.match(routeCode, /if \(explicitChainNamed\) \{/, 'the gate must branch on whether the prompt explicitly named a chain')
assert.match(routeCode, /const detected = await detectChainForAddress\(inlineAddress\);/, 'when no chain was named, the gate must call the probe')
assert.match(routeCode, /if \(resolvedEntityType !== 'unknown'\) chainForClarkTools = detected\.chain;/, 'a successful detection must update chainForClarkTools so every downstream tool call (token_scan, honeypot check) uses the REAL detected chain, not just inform the message text')
// chainForClarkTools must be reassignable (let, not const) for the above to even compile.
assert.match(routeCode, /let chainForClarkTools: SupportedChain \| "robinhood" =/, 'chainForClarkTools must be declared with let — auto-detection needs to reassign it')

console.log('test-clark-auto-chain-detect.mjs: all assertions passed')
