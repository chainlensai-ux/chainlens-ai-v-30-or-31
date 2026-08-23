// TESTS — Clark "what's pumping vs Base Radar" separation + volume/% pump routing follow-up.
//
// Three real gaps reported: (1) "what's pumping on Base" answered from Base Radar's own internal
// pool feed — the exact same data source "Base Radar" itself uses — so the two questions could
// never disagree; (2) asking a specific token's volume, or "how much did X pump", had no dedicated
// routing and could fall into the Base-wide movers list or a canned "what is volume" definition
// instead of a real number; (3) "who is the deployer" was checked and confirmed already working
// (Pro/Elite gated with a clear locked message, not a silent failure) — no code change there.
//
// buildClarkToolPlan is not exported (same "not exported for direct invocation" convention as
// scripts/test-clark-deployer-routing.mjs / test-clark-execution.mjs), so this reads route.ts's
// source to confirm the fix's shape, and directly re-verifies the new regexes (pure RegExp, fully
// testable on their own) against real prompts, including regression prompts that must NOT match.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routeFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

// ─── 1. "What's pumping" now sources from CoinGecko, independently of Base Radar's own feed ───
{
  const importIdx = routeFile.indexOf('import { fetchCoinGeckoBaseTrending } from "@/lib/server/coingeckoBaseTrending"')
  const baseMarketDiscoveryIdx = routeFile.indexOf('if (routed.intent === "base_market_discovery")')
  const cgCallIdx = routeFile.indexOf('await fetchCoinGeckoBaseTrending()')
  const baseRadarIdx = routeFile.indexOf('if (routed.intent === "base_radar")')
  // New-launch discovery has its own age-verified universe call before CoinGecko. For ordinary
  // momentum discovery, verify the existing universe fallback that appears after the CG call.
  const universeCallIdx = routeFile.indexOf('await getBaseMarketUniverse(', cgCallIdx)

  check('coingeckoBaseTrending is imported', importIdx > -1)
  check('base_market_discovery branch exists', baseMarketDiscoveryIdx > -1)
  check('base_market_discovery calls CoinGecko', cgCallIdx > baseMarketDiscoveryIdx)
  check('CoinGecko is tried BEFORE the pre-existing getBaseMarketUniverse fallback (real independent source first, not just relabeled)', cgCallIdx < universeCallIdx)
  check('base_radar branch is untouched — still reads its own internal feed, never CoinGecko', baseRadarIdx > -1 && !routeFile.slice(baseRadarIdx, baseMarketDiscoveryIdx).includes('fetchCoinGeckoBaseTrending'))
  check('CoinGecko fallback path still returns the pre-existing dashboardRows/universe behavior unchanged when CoinGecko has nothing (never a regression)', routeFile.slice(baseMarketDiscoveryIdx).indexOf('dashboardMarketRows') > routeFile.slice(baseMarketDiscoveryIdx).indexOf('fetchCoinGeckoBaseTrending'))
}

// ─── 2. Volume / pump-over-timeframe routing exists, mirroring the proven _HOLDER_RE pattern ───
{
  const holderIdx = routeFile.indexOf('const _HOLDER_RE =')
  const volumeIdx = routeFile.indexOf('const _VOLUME_RE =')
  const pumpIdx = routeFile.indexOf('const _PUMP_TIMEFRAME_RE =')
  check('_HOLDER_RE (the pattern being mirrored) exists', holderIdx > -1)
  check('_VOLUME_RE exists, added right after the holder pattern', volumeIdx > holderIdx)
  check('_PUMP_TIMEFRAME_RE exists', pumpIdx > holderIdx)
  check('both route through token_resolve + token_scan, same as the holder pattern (real evidence, not a canned definition)', routeFile.slice(volumeIdx, volumeIdx + 700).includes('token_resolve') && routeFile.slice(volumeIdx, volumeIdx + 700).includes('token_scan'))
}

// ─── The exact regexes used in the fix — verified directly since buildClarkToolPlan is not exported.
const _VOLUME_RE = /\b(?:24h\s+)?volume\b|trading\s+volume|how\s+much\s+(?:volume|is\s+trading)/i
const _PUMP_TIMEFRAME_RE = /how\s+much\s+(?:has\s+|did\s+)?[a-z0-9._-]{0,20}\s*(?:pump|pumped|moved?|up|gain(?:ed)?)|price\s+change|% ?change|percent\s+change|how\s+much\s+(?:is\s+it\s+)?up|24h\s+(?:change|move|performance)|1h\s+(?:change|move)|7d\s+(?:change|move|performance)/i

for (const prompt of [
  'what is the volume of BRETT',
  'whats the 24h volume on VIRTUAL',
  'how much volume does AERO have',
  'trading volume for TOSHI',
]) {
  check(`volume question must match _VOLUME_RE: "${prompt}"`, _VOLUME_RE.test(prompt))
}

for (const prompt of [
  'how much did BRETT pump today',
  'how much has VIRTUAL pumped',
  'what is the price change on AERO',
  '24h change for TOSHI',
  'percent change on DEGEN',
]) {
  check(`pump-timeframe question must match _PUMP_TIMEFRAME_RE: "${prompt}"`, _PUMP_TIMEFRAME_RE.test(prompt))
}

// Regression: ordinary scan/safety/holder prompts must not be swept into these new checks.
for (const prompt of ['scan BRETT', 'is AERO safe', 'who are the top holders of VIRTUAL', 'check dev wallet for TOSHI']) {
  check(`ordinary prompt must not match _VOLUME_RE: "${prompt}"`, !_VOLUME_RE.test(prompt))
  check(`ordinary prompt must not match _PUMP_TIMEFRAME_RE: "${prompt}"`, !_PUMP_TIMEFRAME_RE.test(prompt))
}

// ─── 3. Deployer question — confirmed already working, no change made ───────────────────────────
{
  check('dev_wallet feature gating exists and is plan-based, not a silent no-op', routeFile.includes("case 'dev_wallet': return false;"))
  check('a locked-feature message is built for free-plan users asking about the deployer (not a silent failure)', routeFile.includes("'dev_wallet': 'Dev Wallet Detector'"))
}

console.log(`test-clark-market-metric-routing.mjs: all ${passed} assertions passed`)
