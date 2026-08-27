import assert from 'node:assert/strict'
import fs from 'node:fs'

// SKIPPED-CHAIN HONESTY FIX, DISCLOSED.
//
// Reported live, next round after auto-chain-detection shipped: a real BNB token, and separately a
// real Robinhood token, both asked with no chain named, still came back labeled "Base" in the
// response. Best-effort fix made WITHOUT live production diagnostic confirmation — the user was
// asked whether they could pull the Network-tab clarkEntityRoutingAudit JSON to pin down whether
// (a) detection found the right chain and only the display label was wrong, or (b) detection never
// found BNB/Robinhood at all; the user explicitly said "just make your best guess and fix it."
//
// Working hypothesis: getRpcUrlForClarkCodeCheck always has a guaranteed hardcoded public fallback
// for Base (mainnet.base.org), but returns null immediately — no RPC call ever attempted — for
// ETH/BNB/Robinhood when their API keys/URLs aren't configured on the deployment. That means
// detectChainForAddress's parallel probe could have BNB/Robinhood silently never checked at all,
// letting Base "win" the probes.find() race purely by being the only chain that could answer,
// never because it was verified correct — and the old code had no way to tell the two cases apart.
//
// Fix: detectChainForAddress now splits the chain list into candidateChains (real RPC configured,
// actually probed) and skippedChains (no RPC configured, never probed), and returns skippedChains
// to the caller. The entity gate uses that to build checkedChainLabels — the real, possibly-partial
// list of chains verified — and the "wallet, not a token contract" message now names exactly which
// chains were checked and discloses any that couldn't be checked at all, instead of always claiming
// a fixed universal "Base, Ethereum, and BNB" list regardless of what was actually configured.
//
// This does not, by itself, prove the reported "Base" mislabel was caused by missing RPC config —
// only that the message can no longer overstate what was actually verified. See ClarkEntityRouting-
// Audit.chainsSkipped, exposed for exactly this diagnosis on the next report.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ─── skippedChains must be threaded end-to-end: probe -> gate -> audit type -> message ─────────
assert.match(routeCode, /const rpcAvailability = allChains\.map\(\(c\) => \(\{ chain: c, rpcUrl: getRpcUrlForClarkCodeCheck\(c\) \}\)\);/, 'each chain\'s real RPC availability must be checked before deciding whether to probe it')
assert.match(routeCode, /const candidateChains = rpcAvailability\.filter\(\(c\) => c\.rpcUrl != null\)\.map\(\(c\) => c\.chain\);/, 'only chains with a real configured RPC URL may be probed')
assert.match(routeCode, /const skippedChains = rpcAvailability\.filter\(\(c\) => c\.rpcUrl == null\)\.map\(\(c\) => c\.chain\);/, 'chains with no RPC configured must be recorded as skipped, never silently treated as "checked, found nothing"')

// The gate must actually capture skippedChains from the detection call (not just discard it).
assert.match(routeCode, /skippedChains = detected\.skippedChains;/, 'the entity gate must capture skippedChains from detectChainForAddress')

// The ClarkEntityRoutingAudit type must expose which chains were skipped, for live diagnosis.
assert.match(routeCode, /chainsSkipped: string\[\];/, 'ClarkEntityRoutingAudit must expose chainsSkipped so a future report can show exactly what was (not) checked')
assert.match(routeCode, /chainsSkipped: skippedChains\.map\(\(c\) => chainDisplayLabel\(c\)\),/, 'the audit object populated at runtime must actually set chainsSkipped from the real probe result')

// checkedChainLabels must be the real chain list MINUS whatever was skipped — never a hardcoded
// universal list independent of what was actually configured.
assert.match(routeCode, /const checkedChainLabels = \(\["base", "ethereum", "bnb", \.\.\.\(isRobinhoodChainAvailable\(\) \? \["robinhood"\] as const : \[\]\)\] as \(SupportedChain \| "robinhood"\)\[\]\)\s*\n\s*\.filter\(\(c\) => !skippedChains\.includes\(c\)\)\.map\(\(c\) => chainDisplayLabel\(c\)\);/, 'checkedChainLabels must exclude genuinely skipped chains from the real chain list')

// The no-chain-named mismatch message must use checkedChainLabels (dynamic) and disclose skipped
// chains when any exist — never claim a fixed "Base, Ethereum, and BNB" list unconditionally.
assert.ok(routeCode.includes('checked across ${checkedChainLabels.join(", ")}, no contract code found on any of them.${skippedChains.length > 0 ? ` (${skippedChains.map((c) => chainDisplayLabel(c)).join(" and ")} couldn\'t be checked — not configured on this deployment.)` : ""}'), 'the message must name exactly which chains were checked and disclose any that could not be, rather than an unconditional fixed chain list')
assert.doesNotMatch(routeCode, /checked across Base, Ethereum, and BNB\$\{isRobinhoodChainAvailable\(\)/, 'the old hardcoded universal chain list message must no longer be present — it overstated what was actually checked when a chain\'s RPC was not configured')

console.log('test-clark-skipped-chain-honesty.mjs: all assertions passed')
