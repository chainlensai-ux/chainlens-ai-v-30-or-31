import assert from 'node:assert/strict'
import fs from 'node:fs'

// Clark/CORTEX audit Item 16: keep whale/FOMO architecture; fix Clark-side
// identity, USD honesty, stale ranks, pipe dumps, and symbol-guessed scans.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const scopeSrc = fs.readFileSync(new URL('../lib/server/whaleAlertScope.ts', import.meta.url), 'utf8')
const whaleRouteSrc = fs.readFileSync(new URL('../app/api/whale-alerts/route.ts', import.meta.url), 'utf8')

assert.match(scopeSrc, /userOrSystemScope/, 'FOMO-added wallets stay user-scoped via whaleAlertScope')
assert.match(whaleRouteSrc, /userOrSystemScope/, 'whale-alerts feed uses the concurrent user/system scope helper')
assert.match(routeCode, /verifiedPlan !== "elite"/, 'live Whale/FOMO answers stay Elite-gated')
assert.match(routeCode, /headers: authHeader \? \{ Authorization: authHeader \}/, 'Clark whale fetches pass the signed-in user')

assert.match(routeCode, /function clarkWhaleScanTokenAction/, 'Scan Token must use the contract when a CA exists')
assert.match(routeCode, /prompt: `scan \$\{addr\} on base`/, 'whale Scan Token CTA scans the contract on Base, never a ticker guess')
assert.doesNotMatch(routeCode, /prompt: `scan \$\{a\.tokenSymbol\}`/, 'explain-signal must not scan by ticker when a CA exists')
assert.doesNotMatch(routeCode, /prompt: `scan \$\{top\.tokenSymbol\}`/, 'ranked whale summary must not scan by ticker when a CA exists')

assert.match(routeCode, /failureReason: "stale_or_missing_whale_memory"/, 'stale whale rank follow-ups must not reuse an expired list')
assert.match(routeCode, /failureReason: "stale_whale_rank"/, 'a missing rank must not fall through to alert #1')
assert.doesNotMatch(routeCode, /lastWhaleAlerts\.find\(\(x\) => x\.rank === rank\) \?\? sessionMem\.lastWhaleAlerts\[0\]/, 'unknown ranks must not silently become the first alert')

assert.match(routeCode, /clarkWhaleTokenIdentity/, 'whale flow grouping must key off CA identity when present')
assert.match(routeCode, /audit\?\.finalUsdStatus === "verified"/, 'canonical USD totals must not mix unverified amount_usd into verified sums')
assert.match(routeCode, /usdStatus: audit\?\.finalUsdStatus \?\? 'unavailable'/, 'flow rows must not claim verified USD without a pricing audit')

assert.doesNotMatch(routeCode, /join\(' \| '\)/, 'whale behavior signals must not pipe-dump into the user answer')
assert.doesNotMatch(routeCode, /join\(" \| "\);\s*\n\s*const ctx = a\.walletContext/, 'whale alert formatter must not pipe-dump extra fields')

console.log('test-clark-whale-fomo-audit.mjs: all assertions passed')
