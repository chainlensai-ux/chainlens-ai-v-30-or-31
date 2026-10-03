import assert from 'node:assert/strict'
import fs from 'node:fs'

// BASE RADAR NOT-LOADING AUDIT/FIX, DISCLOSED.
//
// Reported: Base Radar showed 0 tokens and "Providers failed — could not reach discovery source."
// Diagnosis first (per the task's own instruction): traced the exact failure path in
// app/api/radar/route.ts before touching any filter. Root cause was NOT the discovery/filter logic
// itself (already heavily audited across prior sessions) — it was that GeckoTerminal was the ONLY
// real discovery source with no independent fallback, so a GeckoTerminal-only outage produced a
// hard "0 tokens" with a vague generic message, even when a perfectly good stale cache or a working
// DexScreener-only path existed.
//
// /api/radar's GET is a 2400+-line handler with a deep provider/Redis/Supabase dependency graph —
// matching this repo's established convention (test-base-radar-chain-strict.mjs and every other
// route-level static check in this codebase), these are static source assertions against the real
// route/page files, not mocked network tests.

const routeSrc = fs.readFileSync(new URL('../app/api/radar/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const pageSrc = fs.readFileSync(new URL('../app/terminal/base-radar/page.tsx', import.meta.url), 'utf8')
const pageCode = pageSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ─── Required fix 1: GeckoTerminal fail -> DexScreener fallback ────────────────────────────────
assert.match(routeCode, /async function fetchDexScreenerBaseFallbackDiscovery/, 'a genuinely independent DexScreener discovery fallback must exist')
assert.match(
  routeCode,
  /if \(sourcesSucceeded === 0 && requestedChain === 'base'\) \{/,
  'the DexScreener fallback must only fire when GeckoTerminal discovery genuinely returned zero successful sources this cycle — never routine extra load',
)
assert.match(routeCode, /fetch\('https:\/\/api\.dexscreener\.com\/token-profiles\/latest\/v1'/, 'the fallback must use DexScreener\'s real token-profiles list')
assert.match(routeCode, /fetch\('https:\/\/api\.dexscreener\.com\/token-boosts\/latest\/v1'/, 'the fallback must use DexScreener\'s real token-boosts list')
assert.match(
  routeCode,
  /fetch\(`https:\/\/api\.dexscreener\.com\/latest\/dex\/tokens\/\$\{\[\.\.\.addresses\]\.join\(','\)\}`/,
  'the fallback must resolve real pair data (price/liquidity/volume/change) from DexScreener\'s own multi-token endpoint, never GeckoTerminal',
)
// Reshaped into GT's own shape so it flows through the SAME downstream pipeline — never a parallel
// pipeline (hard rule: don't break Pump Alerts/Token Scanner/Clark/Wallet Scanner by duplicating logic).
// The reshaping now lives in lib/radarDiscoveryResilience.ts (shared with the Robinhood fallback).
const resilienceCode = fs.readFileSync(new URL('../lib/radarDiscoveryResilience.ts', import.meta.url), 'utf8')
assert.match(resilienceCode, /relationships: \{ base_token: \{ data: \{ id: tokenId \} \}, dex: \{ data: \{ id: typeof pair\.dexId/, 'DexScreener fallback candidates must be reshaped into GeckoTerminal\'s own pool/token JSON:API-ish shape so they reuse the existing pipeline unchanged')
assert.match(routeCode, /dexPairsToRadarPools\(pairs, 'base', addresses\)/, 'the Base fallback must map only pairs whose base token is one of the exact addresses it queried')

// ─── Required fix: no wrong-chain data (hard rule) ─────────────────────────────────────────────
assert.match(resilienceCode, /if \(pair\.chainId !== chain\) \{ audit\.rejected\.wrongChain\+\+; continue \}/, 'a DexScreener pair from another chain must never be accepted into a discovery fallback')
assert.match(routeCode, /if \(chainId === 'base' && tokenAddress\) addresses\.add\(tokenAddress\)/, 'only chainId===base entries from DexScreener\'s boost/profile lists may seed the fallback address set')
// Robinhood never uses the Base discovery fallback. It has its own seed-bound fallback (last verified
// tokens / DexScreener Robinhood listings / V4 Initialize tokens) that keeps only exact-seed, chainId
// 'robinhood' pairs — see tests/radar-discovery-resilience.test.ts.
assert.doesNotMatch(routeCode, /requestedChain === 'robinhood'.{0,40}fetchDexScreenerBaseFallbackDiscovery/s, 'the DexScreener discovery fallback must never run for Robinhood')

// ─── Required fix 2: last-good cache renders during failure ────────────────────────────────────
// Robinhood outage fix: the stale decision moved into decideRadarDelivery (lib/radarDiscoveryResilience.ts,
// unit-tested there and end-to-end in tests/radar-discovery-resilience.test.ts). A total live-source
// failure with a usable same-query cached payload still serves it, now also flagged liveDiscovery 'delayed'.
assert.match(routeCode, /const stalePayload = cachedPayload && cachedPayload\.payload\.tokens\.length > 0/, 'a total live-source failure must still serve the last-good cached payload when one exists')
assert.match(routeCode, /if \(delivery\.kind === 'stale' && stalePayload\) \{/, 'the stale payload is served only on the decideRadarDelivery stale decision')
assert.match(routeCode, /servedFromStaleCache: true/, 'a stale-served response must carry a plain, non-debug-gated signal so the frontend can show it was cached data')
assert.match(pageCode, /servedFromStaleCache\?: boolean/, 'RadarData must declare servedFromStaleCache')

// ─── Required fix 3 + 4: exact provider error, not vague "Open check" / generic text ───────────
// Public list = source/status/failureClass; the raw messages live in providerErrorsDetail (debug only).
assert.match(routeCode, /const providerErrorsDetail = \[/, 'the real per-provider error list must still be built (exposed in full under debug)')
assert.match(routeCode, /const providerErrors = providerErrorsDetail\.map\(/, 'baseRadarLoadAudit must expose the per-provider error list (public shape)')
assert.match(routeCode, /const userVisibleError = baseRadarFinalState === 'providerUnavailable'/, 'a literal user-facing error string must be computed server-side from the real failure, not left for the frontend to guess')
assert.match(pageCode, /const headline = finalState === 'providerUnavailable'\s*\n\s*\? \(userVisibleError \?\? /, 'EmptyFeed must render the real userVisibleError string when a provider outage occurred, not a hardcoded generic sentence')
assert.match(pageCode, /userVisibleError\?: string \| null/, 'EmptyFeed must accept userVisibleError as a prop')
assert.match(pageCode, /userVisibleError=\{data\?\.baseRadarLoadAudit\?\.userVisibleError\}/, 'the EmptyFeed call site must actually pass the real backend error through')

// Header stat strip: "Unavailable" for a failed strongest mover/newest pool, not "Open check" —
// "Open check" is reserved for an honest "we checked, found nothing" result.
assert.match(pageCode, /function getOverviewTokenTitle\(token: TokenIntel \| undefined, providersFailed = false\): string \{/, 'the header stat helper must know whether providers failed this cycle')
assert.match(pageCode, /if \(!token\) return providersFailed \? 'Unavailable' : 'Open check'/, 'a failed strongest-mover/newest-pool header stat must read Unavailable, never Open check, when providers failed')
assert.match(pageCode, /const providersFailed = data\?\.finalState === 'providerUnavailable'/, 'providersFailed must be derived from the same authoritative finalState the rest of the empty-state logic already uses')

// ─── Required fix 5 + 6: normalized candidate shape, DexScreener mapping fields ────────────────
for (const field of [
  'chainSlug', 'chainId', 'tokenAddress', 'priceUsd', 'priceChange24hPct', 'priceChange6hPct', 'priceChange1hPct', 'pairCreatedAt',
]) {
  assert.ok(routeCode.includes(`${field}:`) || routeCode.includes(`${field}?:`), `RadarToken/candidate must expose ${field}`)
}
// DexScreener mapping must include marketCap, fdv, liquidity.usd, volume.h24, priceChange.h24/h6/h1, pairCreatedAt.
assert.match(resilienceCode, /market_cap_usd: pair\.marketCap \?\? null/, 'DexScreener fallback mapping must read marketCap')
assert.match(resilienceCode, /fdv_usd: pair\.fdv \?\? null/, 'DexScreener fallback mapping must read fdv')
assert.match(resilienceCode, /reserve_in_usd: liquidity\?\.usd \?\? null/, 'DexScreener fallback mapping must read liquidity.usd')
assert.match(resilienceCode, /volume_usd: \{ h24: volume\?\.h24 \?\? null \}/, 'DexScreener fallback mapping must read volume.h24')
assert.match(resilienceCode, /price_change_percentage: \{ h24: priceChange\?\.h24 \?\? null, h6: priceChange\?\.h6 \?\? null, h1: priceChange\?\.h1 \?\? null \}/, 'DexScreener fallback mapping must read priceChange.h24/h6/h1')
assert.match(resilienceCode, /pool_created_at: pairCreatedAtMs != null \? new Date\(pairCreatedAtMs\)\.toISOString\(\) : null/, 'DexScreener fallback mapping must read pairCreatedAt')

// ─── Required fix 7: missing holder/risk must not block card render ────────────────────────────
// The frontend maps every returned token into display intel — it never filters candidates out for
// missing holderEvidence/simulation data (that would be a rendering-layer block, distinct from the
// backend's own deliberate holder-count/valuation gates on which candidates are DISCOVERED at all —
// this task's own instruction is "do not tune filters yet", so those gates are untouched here).
assert.match(pageCode, /const intelTokens = useMemo\(\(\) => tokens\.map\(t => enrichToken\(t, effectiveRadarChain\)\), \[tokens, effectiveRadarChain\]\)/, 'every returned token must be mapped to display intel, never filtered out for missing evidence at the rendering layer')

// ─── Required fix 8: Scan/Clark handoff passes Base chain + token address ──────────────────────
// (Already locked by test-base-radar-chain-strict.mjs — re-asserted here as part of this task's own
// required test list so this file alone proves the full acceptance criteria.)
assert.match(pageCode, /function openToken\(contract: string, chain: RadarChain = effectiveRadarChainRef\.current\) \{/, 'the Scan handoff must default to the row\'s own chain')
assert.match(pageCode, /const href = `\/terminal\/token-scanner\?contract=\$\{contract\}\$\{chainQuery\}`[\s\S]{0,200}router\.push\(href\)/, 'the Scan handoff must pass the token address and chain to Token Scanner')
assert.match(pageCode, /`Chain: \$\{chainName\}`/, 'the Clark handoff prompt must state the real chain')
assert.match(pageCode, /`Contract: \$\{token\.contract\}`/, 'the Clark handoff prompt must state the token address')

console.log('test-base-radar-provider-fallback.mjs: all assertions passed')
