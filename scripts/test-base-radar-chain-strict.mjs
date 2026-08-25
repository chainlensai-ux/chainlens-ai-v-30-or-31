import assert from 'node:assert/strict'
import fs from 'node:fs'

// BASE RADAR CHAIN STRICTNESS, DISCLOSED (full Radar/Pump audit).
//
// The audit found Base Radar's chain handling already CORRECT — unlike Pump Alerts, which had gone
// multi-chain without carrying chain provenance. These are regression locks on the properties that
// make it correct, so a future multi-chain change to Radar can't repeat the Pump Alerts mistakes:
// a single hard-whitelisted chain per request that fails closed, threaded into every provider URL,
// and carried through both the Token Scanner and Clark handoffs.
//
// Static source assertions: /api/radar's GET is a 2200-line handler with a deep provider/Supabase
// dependency graph, matching the convention already used by this repo's other route-level static
// checks (src/pipeline/*.staticCheck.test.ts, scripts/test-clark-analyst-e2e-routing.mjs).

const routeSrc = fs.readFileSync(new URL('../app/api/radar/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ── 1. Chain is a hard whitelist that fails closed ──────────────────────────
// Anything other than an explicitly-enabled 'robinhood' resolves to 'base'. An attacker-supplied
// or typo'd ?chain= can never reach a provider URL verbatim.
assert.match(
  routeCode,
  /searchParams\.get\('chain'\) === 'robinhood' && isRobinhoodChainAvailable\(\) \? 'robinhood' : 'base'/,
  'radar chain must be a hard whitelist that falls back to base and gates Robinhood on the feature flag',
)

// ── 2. Every GeckoTerminal discovery URL is built from that validated chain ──
// A hardcoded network slug here is exactly the bug class that broke Pump Alerts' 7d fetch.
const gtUrls = [...routeCode.matchAll(/https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/([^/]+)\//g)]
assert.ok(gtUrls.length >= 3, 'expected the radar discovery sources to build GeckoTerminal URLs')
for (const m of gtUrls) {
  assert.equal(
    m[1], '${requestedChain}',
    `every radar GeckoTerminal URL must use the validated requestedChain, found hardcoded network "${m[1]}"`,
  )
}

// ── 3. Robinhood is gated server-side, not only in the UI ───────────────────
assert.match(routeCode, /isRobinhoodChainAvailable\(\)/, 'Robinhood must be gated server-side (fails closed without flag + RPC)')

// ── 4. Handoffs carry the chain ─────────────────────────────────────────────
const pageSrc = fs.readFileSync(new URL('../app/terminal/base-radar/page.tsx', import.meta.url), 'utf8')
const pageCode = pageSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// Scan handoff: chain param present for non-Base, omitted for Base so existing links are unchanged.
assert.match(
  pageCode,
  /const chainQuery = chain === 'base' \? '' : `&chain=\$\{chain\}`/,
  'the radar Scan handoff must pass the real chain to Token Scanner',
)
assert.match(pageCode, /token-scanner\?contract=\$\{contract\}\$\{chainQuery\}/, 'the scan URL must include the chain query')

// Clark handoff: the prompt must state the chain, or the model reasons on the wrong network.
assert.match(pageCode, /`Chain: \$\{chainName\}`/, 'the radar Clark prompt must state the real chain')

// ── 5. Token Scanner accepts every chain Radar/Pump can hand it ─────────────
// A chain that Radar can send but Token Scanner silently downgrades to Base is a wrong-chain scan.
const scannerSrc = fs.readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const scannerCode = scannerSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
assert.match(
  scannerCode,
  /chainParam === 'eth' \|\| chainParam === 'bnb' \|\| chainParam === 'robinhood' \? chainParam : 'base'/,
  'Token Scanner URL autodetect must accept every chain the Radar/Pump handoffs can send',
)
// A new scan must clear the previous token's result so a stale one can't flash or persist.
assert.match(scannerCode, /setResult\(null\)/, 'a new scan must reset the previous token result')

// ─── URGENT loading audit (route-level static assertions) ───────────────────
// Locks the fix for "Base Radar stays on loading/checking state and no tokens render": a
// baseRadarLoadAudit in the exact requested shape, a truthful finalState distinguishing a real
// provider outage from an honest empty-after-filtering result, and confirmation the existing
// stale-empty-cache defenses (dead-feed skip, short TTL for a 0-token gate result) are still live.
{
  assert.match(routeCode, /baseRadarLoadAudit = \{/, 'a baseRadarLoadAudit object must be built for every request')
  for (const field of [
    'requestId', 'route', 'status', 'totalDurationMs', 'cacheHit', 'providersAttempted', 'providersSucceeded',
    'providersFailed', 'candidatesRaw', 'candidatesAfterDedupe', 'candidatesAfterChainFilter',
    'candidatesAfterQualityFilter', 'candidatesRendered', 'rejectedReasons', 'finalState', 'errorShownToUser',
  ]) {
    assert.ok(routeCode.includes(field), `baseRadarLoadAudit must include ${field}`)
  }
  assert.match(
    routeCode,
    /sourcesSucceeded === 0 \? 'providerUnavailable'\s*\n\s*: rawTotalBeforeDedupe === 0 \? 'noRawCandidates'\s*\n\s*: tokens\.length === 0 \? 'allFilteredOut'/,
    'finalState must distinguish a real provider outage from zero raw candidates from an honest post-filter empty result',
  )
  // Pre-existing defenses this incident depends on staying intact. Checked against the raw source
  // (not comment-stripped routeCode) since the first assertion targets disclosure-comment text.
  assert.match(routeSrc, /DON'T-CACHE-A-DEAD-FEED FIX/, 'a fully failed discovery cycle must not be cached like a real result')
  assert.match(routeCode, /EMPTY_RESULT_CACHE_TTL_MS = 5 \* 1000/, 'a 0-token gate result must use a short cache TTL, not the full one')
}

// ─── Frontend finalState wiring (reported: "base radar isn't loading tokens" — same class as the
// Pump Alerts empty-state fix). The backend already computes baseRadarFinalState (added in the
// prior load-audit commit), but nothing in the frontend ever read it, so a real provider outage
// that didn't cross discoveryDegradedSignificant's ≥50%-of-sources-failed threshold rendered the
// exact same "No candidates passed the $50K+ valuation gate" copy as an honest quiet market —
// indistinguishable from the user's side, reading as "stuck"/"not loading" rather than an outage. ──
{
  const pageSrc = fs.readFileSync(new URL('../app/terminal/base-radar/page.tsx', import.meta.url), 'utf8')
  const pageCode = pageSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(pageCode, /finalState\?: 'ok' \| 'providerUnavailable' \| 'allFilteredOut' \| 'noRawCandidates'/, 'RadarData must declare the server-computed finalState field')
  assert.match(pageCode, /finalState === 'providerUnavailable'/, 'EmptyFeed must render a distinct message for a real provider outage')
  assert.match(pageCode, /finalState === 'noRawCandidates'/, 'EmptyFeed must render a distinct message for zero raw candidates')
  assert.match(pageCode, /finalState=\{data\?\.finalState\}/, 'the EmptyFeed call site must actually pass finalState through from the API response')
}

console.log('test-base-radar-chain-strict.mjs: all assertions passed')
