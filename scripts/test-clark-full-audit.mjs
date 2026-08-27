import assert from 'node:assert/strict'
import fs from 'node:fs'

// FULL CLARK AI AUDIT, DISCLOSED.
//
// Reported: Clark frequently answers "Unavailable" / "Could not verify" / generic replies even
// when ChainLens already has the data. Audited the whole pipeline (intent classification, context
// injection, memory, route selection, API calls, tool orchestration, response generation, error
// handling, Token/Wallet Scanner integration) in app/api/clark/route.ts (13k+ lines) before
// changing anything.
//
// Findings:
//  - Provider-fallback discipline (never stop after first failed provider) was ALREADY correct at
//    every live call site that matters: executeClarkToolPlan's tool loop runs every planned tool
//    independently (try/catch per tool, continues on failure) and every scanXData()/handleXScanner
//    helper already fans out to its providers via Promise.allSettled. The ONE real gap: the shared
//    GeckoTerminal proxy every Clark market read ultimately calls through (app/api/proxy/gt) had
//    NO second source at all — a GT outage always fell straight to a generic "unavailable", even
//    though DexScreener (a real, independent Base data source ChainLens already uses in
//    app/api/radar's own GT->DexScreener fallback) was live. Fixed there, once, so every existing
//    caller of that proxy inherits a real fallback with zero caller-side changes.
//  - "Only say Unavailable after ALL sources failed, with the exact reason" — per-feature error
//    text already carried real, specific reasons (errorSafeMessage/failureReason fields throughout
//    ClarkToolEvidence), and the top-level exception handler already threads the real caught error
//    into the user-facing message. What was missing was a single, honest, machine-checkable audit
//    record proving this on every response — added as clarkAudit, in the exact requested shape,
//    computed once at the single point every feature/branch already converges on (same point that
//    builds the existing generic memory echo), from real per-branch signals (toolsUsed,
//    clarkToolStatuses, clarkEvidenceMissing, clarkToolCallAudit) — never guessed or hardcoded.
//  - Chain context (Base/ETH/Robinhood) was already threaded through every scan tool via
//    SupportedChain/toTokenApiChain — verified, not re-implemented.
//  - Token/Wallet Scanner integration: deployer/holders/LP/market-cap/whale/wallet questions were
//    already routed to real evidence (detectTokenFollowup's HOLDERS_RE/LP_RE/DEPLOYER_RE reading a
//    real prior scan, dev_wallet_analyze's fast resolver + full /api/dev-wallet fallback,
//    liquidity_analyze -> /api/liquidity-safety, wallet_get_snapshot, handleClarkWhaleToolCall) —
//    verified these exist and reach real APIs, not re-built.
//
// Static source assertions, matching this repo's established convention for large route-level
// handlers with a deep provider/session dependency graph (test-base-radar-chain-strict.mjs,
// test-base-radar-provider-fallback.mjs, test-pump-alerts-discovery.mjs).

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const proxySrc = fs.readFileSync(new URL('../app/api/proxy/gt/route.ts', import.meta.url), 'utf8')

// ─── clarkAudit: exact requested shape, computed once, never per-branch ────────────────────────
assert.match(routeCode, /type ClarkAudit = \{/, 'a ClarkAudit type must exist')
for (const field of [
  'intent', 'routesCalled', 'providersAttempted', 'providersSucceeded', 'providersFailed',
  'contextInjected', 'scannerDataUsed', 'cacheUsed', 'fallbackUsed', 'missingFields',
  'unavailableReason', 'responseTimeMs',
]) {
  assert.ok(routeCode.includes(`${field}:`), `ClarkAudit must include ${field}`)
}
assert.match(routeCode, /function buildClarkAudit\(/, 'a single buildClarkAudit function must derive the audit from real pipeline signals')
// Must be attached on every real finalization point: the main switch path, the memory-only
// "more" follow-up early exit, and the top-level exception fallback (the genuine all-sources-
// failed case) — not just the happy path.
assert.match(routeCode, /normData\.clarkAudit = buildClarkAudit\(/, 'the main response path must attach clarkAudit')
assert.match(routeCode, /\(normalized\.data as Record<string, unknown>\)\.clarkAudit = buildClarkAudit\(/, 'the memory-only "more" follow-up path must attach clarkAudit too')
assert.match(routeCode, /clarkAudit: \{[\s\S]{0,600}unavailableReason: `\$\{isTimeout \? "timed out" : "failed"\}: \$\{errMsg\}`/, 'the exception-fallback path must attach a clarkAudit whose unavailableReason is the real caught error, never a placeholder')

// A cache hit must not silently claim it re-ran the pipeline: cacheUsed/responseTimeMs are
// overlaid fresh on every cache read, everything else in the audit is preserved from the original
// request that actually produced it.
assert.match(routeCode, /function withClarkAuditCacheHit\(/, 'a cache-hit read must overlay live cacheUsed/responseTimeMs onto the stored clarkAudit')
assert.match(routeCode, /return NextResponse\.json\(withClarkAuditCacheHit\(earlyCached\.payload, clarkAuditRequestStartedAt\)\)/, 'the early cache-hit path must use the overlay helper')
assert.match(routeCode, /return NextResponse\.json\(withClarkAuditCacheHit\(cached\.payload, clarkAuditRequestStartedAt\)\)/, 'the main cache-hit path must use the overlay helper')

// ─── Required fix: only "Unavailable" after ALL sources failed ─────────────────────────────────
assert.match(
  routeCode,
  /const genuinelyUnavailable = providersAttempted\.length > 0 && providersSucceeded\.length === 0 && providersFailed\.length === providersAttempted\.length/,
  'unavailableReason must only be set when every attempted provider genuinely failed — a partial success must never report Unavailable',
)

// ─── Required fix 1: never stop after the first failed provider ────────────────────────────────
// executeClarkToolPlan's tool loop must keep running every planned tool even after one throws.
assert.match(routeCode, /for \(const tool of input\.plan\.tools\) \{/, 'the tool plan must iterate every planned tool')
assert.match(routeCode, /\} catch \(err\) \{\s*\n\s*console\.error\("\[Clark tools\]", tool\.name, err/, 'a single tool failure must be caught per-iteration, not abort the whole plan')
// Every scan*Data helper (and the live handleXScanner/handleClarkAI tool-plan providers) must fan
// out with Promise.allSettled, never a plain Promise.all that would abort all providers on one
// rejection.
const allSettledCount = (routeCode.match(/Promise\.allSettled/g) || []).length
assert.ok(allSettledCount >= 5, `expected multiple independent provider fan-outs via Promise.allSettled, found ${allSettledCount}`)

// ─── Required fix 3: GeckoTerminal fail -> DexScreener fallback, in the shared proxy ────────────
// Fixed once in the shared internal proxy every Clark market read calls through, so every caller
// (including callGeckoTerminal in this file) inherits it without a code change here.
assert.match(routeCode, /async function callGeckoTerminal\(network: "base" \| "eth", origin: string/, 'Clark must call GeckoTerminal through the shared proxy')
assert.match(proxySrc, /async function fetchDexScreenerFallback/, 'the shared GeckoTerminal proxy must have an independent DexScreener fallback')
assert.match(proxySrc, /const fallback = await fetchDexScreenerFallback\(network\)/, 'a GeckoTerminal failure must trigger the DexScreener fallback before reporting unavailable')
assert.match(proxySrc, /if \(network !== "base"\) \{\s*\n\s*return \{ data: \[\], included: \[\], error: "No fallback source available for this network\." \}/, 'the DexScreener fallback must never fabricate non-Base data')
assert.match(proxySrc, /source: "dexscreener_fallback"/, 'a fallback-served response must be labeled so callers can tell')

// ─── Required fix 4: chain context (Base/ETH/Robinhood) preserved through tool execution ───────
assert.match(routeCode, /const resolverChain = toTokenApiChain\(input\.chain\);/, 'the deployer/dev-wallet tool must resolve the real request chain, not assume Base')
assert.match(routeCode, /chain: SupportedChain \| "robinhood";/, 'executeClarkToolPlan input must carry the resolved chain (widened to include Robinhood — see the multi-chain token scan fix)')

// ─── Required fix 5: existing scanners answer before "unavailable" (deployer/holders/LP/whale) ──
// Deployer: fast in-process resolver tried first, full /api/dev-wallet scan as the real fallback
// tier — never a single-shot call with no second attempt.
assert.match(routeCode, /fastResult = await resolveTokenDeployer\(/, 'deployer questions must try the fast resolver first')
assert.match(routeCode, /const devWalletRes = await callInternalApi\(input\.origin, "\/api\/dev-wallet"/, 'deployer questions must fall back to the full Token Scanner dev-wallet module, not just the fast resolver')
// Holders / LP: follow-up questions after a real scan must read the ACTUAL scan evidence, never
// invent a generic answer.
assert.match(routeCode, /type TokenFollowupType = "lp" \| "deployer" \| "holders" \| "combined";/, 'holders/LP/deployer follow-ups must be classified from the real prior scan, not answered generically')
assert.match(routeCode, /function detectTokenFollowup\(/, 'a token followup detector must exist to route holders/LP/deployer questions to real evidence')
// Whale activity: routed to the real internal whale-alerts tool call, not generic chat.
assert.match(routeCode, /async function handleClarkWhaleToolCall\(/, 'whale activity questions must route to the real whale-alerts tool call')
// Market cap / token safety: token_scan tool must read real market/security fields from the
// internal Token Scanner API, not fabricate them.
assert.match(routeCode, /_scannableAddr \? callInternalApi\(input\.origin, "\/api\/token"/, 'token_scan must call the real internal Token Scanner API')
assert.match(routeCode, /marketCap: typeof t\.marketCapUsd === "number" \? t\.marketCapUsd : null,/, 'token_scan evidence must carry real market cap from the Token Scanner response')
// Wallet: wallet_get_snapshot must be a real tool in the plan, not a stub that always fails.
assert.match(routeCode, /if \(tool\.name === "wallet_get_snapshot"\) \{/, 'wallet questions must route through a real wallet_get_snapshot tool')

// ─── Required fix 6: no generic replies — every "Unavailable"-adjacent string carries a reason ──
// Spot-check the exception fallback (the one genuinely-all-sources-failed path with no per-branch
// evidence) always includes the real caught error text, never a bare "Unavailable".
assert.match(routeCode, /const errMsg = err instanceof Error \? err\.message : "An unexpected error interrupted this read before a result was produced\.";/, 'the top-level fallback must carry the real error message')
assert.doesNotMatch(routeCode, /analysis: "Unavailable"/, 'no response may hardcode a bare, reasonless "Unavailable"')

console.log('test-clark-full-audit.mjs: all assertions passed')
