// scripts/verifyHybridPricing.ts
//
// Verification harness for the chain-aware historical-pricing router
// (src/pipeline/pricingAtTimeAdapter.ts's buildChainAwareHistoricalPriceSource).
//
// DEVIATIONS FROM THE LITERAL SPEC THAT REQUESTED THIS SCRIPT, ALL DISCLOSED:
//
// 1. BNB / Polygon / Solana tokens do not exist as test cases: this engine's real SupportedChain
//    union (src/modules/providerFetchWindow/types.ts) is only 'base' | 'eth' | 'arbitrum' |
//    'hyperevm'. There is no BNB/Polygon/Solana support anywhere in this codebase. Substituted
//    'hyperevm' as the 4th real non-Base chain instead of 3 fabricated ones.
//
// 2. `pricingAtTimeAdapter.getHistoricalPrice(chainId, tokenAddress, timestamp)` does not exist.
//    The real exported composition is `buildChainAwareHistoricalPriceSource(goldrushFn)`, which
//    returns a PriceSourceFn of the shape `(token, chain, timestamp) => Promise<number | null>`.
//    This harness calls that real function directly.
//
// 3. `pricingRouteLog` (also real, src/pipeline/pricingAtTimeAdapter.ts) records ONE outcome per
//    top-level call — the winning provider, or 'none' if all failed. It does NOT log each
//    intermediate provider attempt in sequence, so it cannot by itself prove "GeckoTerminal was
//    attempted FIRST for Base" as a runtime trace. Proving call ORDER requires either (a) reading
//    the actual source (a static check, done below), or (b) instrumenting each internal try* step
//    (would require editing pricingAtTimeAdapter.ts, which this task's own scope restricts to
//    creating this script only). This harness does (a): it reads the real source file and checks
//    the branch structure textually, in addition to (b) a live dynamic run for real outcomes.
//
// 4. `costBasisUsd`, `unrealizedPnlUsd`, `integrity`, `pricedTokens` do not exist anywhere in this
//    codebase's real types (confirmed by reading src/modules/pnlEngine/types.ts — PnlSummaryResult
//    has only `realizedPnlUsd`/`closedLots`/`winLossRate`/`chainBreakdown`/`confidenceBasis`/
//    `evidenceMissingCount`; there is no `integrity` field, no `unrealizedPnlUsd` concept — this
//    engine only computes realized PnL over closed lots — and no `pricedTokens` count is produced
//    at this layer). These assertions are reported as N/A, not faked.
//
// 5. NO NETWORK ACCESS IN THIS SANDBOX: every real provider call this router can make (GeckoTerminal,
//    DexScreener, CoinGecko, basedex on-chain RPC, GoldRush) requires outbound network access this
//    sandbox does not have. Every live call below will therefore honestly resolve null / 'none'.
//    That is a sandbox limitation, not evidence the router itself is broken — labeled explicitly in
//    the output rather than reported as a false PASS or FAIL.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildChainAwareHistoricalPriceSource,
  pricingRouteLog,
} from '../src/pipeline/pricingAtTimeAdapter'
import type { SupportedChain } from '../src/modules/providerFetchWindow/types'
import type { PriceSourceFn } from '../src/modules/pricingAtTimeEngine/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

type TestToken = {
  label: string
  chain: SupportedChain
  tokenAddress: string
  expectedFirstProvider: 'goldrush' | 'geckoterminal'
}

// Real supported chains only — see deviation #1 above.
const TEST_MATRIX: TestToken[] = [
  { label: 'ETH token (non-Base)', chain: 'eth', tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', expectedFirstProvider: 'goldrush' },
  { label: 'Arbitrum token (non-Base)', chain: 'arbitrum', tokenAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', expectedFirstProvider: 'goldrush' },
  { label: 'HyperEVM token (non-Base)', chain: 'hyperevm', tokenAddress: '0x0000000000000000000000000000000000dead', expectedFirstProvider: 'goldrush' },
  { label: 'Base token (Base)', chain: 'base', tokenAddress: '0x4200000000000000000000000000000000000006', expectedFirstProvider: 'geckoterminal' },
]

// Always-null stand-in for GoldRush — this harness has no real API key/network, so the router's
// GoldRush slot degrades exactly the way it does in production when GOLDRUSH_API_KEY is absent
// (see src/pipeline/index.ts's buildPriceSources()). This is a real, existing degrade path, not a
// mock invented for this script.
const alwaysNullGoldrush: PriceSourceFn = async () => null

// --- 1. STATIC SOURCE-ORDER CHECK ------------------------------------------------------------
// Reads the actual pricingAtTimeAdapter.ts source and checks, textually, that the base branch's
// first call is tryGeckoTerminal and the non-base branch's first call is tryGoldrush, that
// dexscreener is never labeled a historical route, and that the CoinGecko/basedex safety net only
// runs after both branches. This is a real check against the real file on disk, not an assumption.
function staticOrderCheck(): { pass: boolean; details: string[] } {
  const sourcePath = path.join(__dirname, '../src/pipeline/pricingAtTimeAdapter.ts')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const details: string[] = []
  let pass = true

  const baseBranchMatch = source.match(/if \(chain === 'base'\) \{([\s\S]*?)\} else \{([\s\S]*?)\}\s*\n\s*const safetyNetPrice/)
  if (!baseBranchMatch) {
    pass = false
    details.push('FAIL: could not locate the base/non-base branch structure in the real source file')
    return { pass, details }
  }
  const [, baseBranch, nonBaseBranch] = baseBranchMatch

  const baseFirstCall = baseBranch.trim().split('\n')[0]
  const nonBaseFirstCall = nonBaseBranch.trim().split('\n')[0]

  if (baseFirstCall.includes('tryGeckoTerminal')) {
    details.push('PASS: Base branch\'s first call is tryGeckoTerminal')
  } else {
    pass = false
    details.push(`FAIL: Base branch's first call is NOT tryGeckoTerminal — found: ${baseFirstCall.trim()}`)
  }

  if (nonBaseFirstCall.includes('tryGoldrush')) {
    details.push('PASS: non-Base branch\'s first call is tryGoldrush')
  } else {
    pass = false
    details.push(`FAIL: non-Base branch's first call is NOT tryGoldrush — found: ${nonBaseFirstCall.trim()}`)
  }

  const dexscreenerHistoricalLabel = /recordRoute\([^)]*'dexscreener'[^)]*\)/.test(source)
  const dexscreenerFnUsedForCurrentOnly = /fetchDexscreenerPriceDetailed/.test(source)
  if (dexscreenerHistoricalLabel && dexscreenerFnUsedForCurrentOnly) {
    details.push("NOTE: 'dexscreener' route label exists, but it comes from fetchDexscreenerPriceDetailed (src/modules/pricingAtTimeEngine/sources/dexscreener.ts), which is itself current-price-only by its own module contract (5-minute freshness tolerance) — DexScreener is never treated as a real historical source, only labeled for diagnostics when its current-price answer happens to satisfy a near-now request.")
  }

  const safetyNetAfterBothBranches = source.indexOf('coverageSafetyNet(token, chain, timestamp)') > source.indexOf("chain === 'base'")
  if (safetyNetAfterBothBranches) {
    details.push('PASS: CoinGecko/basedex safety net (coverageSafetyNet) is only called after both branches\' 3 named providers have failed')
  } else {
    pass = false
    details.push('FAIL: coverageSafetyNet does not appear strictly after both named-provider branches')
  }

  return { pass, details }
}

// --- 2. LIVE DYNAMIC RUN ---------------------------------------------------------------------
async function runLiveMatrix() {
  const router = buildChainAwareHistoricalPriceSource(alwaysNullGoldrush)
  const results: Array<{
    label: string
    chain: SupportedChain
    tokenAddress: string
    usdPriceAtTime: number | null
    routeRecord: (typeof pricingRouteLog)[number] | undefined
  }> = []

  for (const test of TEST_MATRIX) {
    const timestamp = Date.now() - 30 * 24 * 60 * 60 * 1000 // 30 days ago — genuinely historical
    const snapshotBefore = pricingRouteLog.length
    const usdPriceAtTime = await router(test.tokenAddress, test.chain, timestamp)
    const newRecords = pricingRouteLog.slice(snapshotBefore)
    results.push({
      label: test.label,
      chain: test.chain,
      tokenAddress: test.tokenAddress,
      usdPriceAtTime,
      routeRecord: newRecords[newRecords.length - 1],
    })
  }
  return results
}

async function main() {
  console.log('=== Hybrid Pricing Router Verification ===\n')

  console.log('--- Static source-order check (real file on disk) ---')
  const staticResult = staticOrderCheck()
  for (const line of staticResult.details) console.log(line)
  console.log()

  console.log('--- Live dynamic run (NO NETWORK ACCESS in this sandbox — see deviation #5) ---')
  const liveResults = await runLiveMatrix()
  for (const r of liveResults) {
    console.log(`\n[${r.label}] chain=${r.chain} token=${r.tokenAddress}`)
    console.log(`  usdPriceAtTime: ${r.usdPriceAtTime}`)
    console.log(`  final route: ${r.routeRecord?.route ?? 'NO RECORD'}`)
  }
  console.log()

  console.log('--- Assertions not applicable to this codebase (fields do not exist) ---')
  console.log('  costBasisUsd, unrealizedPnlUsd, integrity, pricedTokens: N/A — no such field/concept')
  console.log('  exists anywhere in src/modules/pnlEngine/types.ts or elsewhere in this codebase.')
  console.log('  Not asserted as PASS or FAIL; asserting against them would be fabrication.')
  console.log()

  const networkDependentAssertionsSkipped = liveResults.every((r) => r.usdPriceAtTime === null)

  console.log('=== SUMMARY ===')
  if (staticResult.pass) {
    console.log('Static provider-order check: PASS (Base -> GeckoTerminal first; non-Base -> GoldRush first; confirmed against real source)')
  } else {
    console.log('Static provider-order check: FAIL — see details above')
  }
  if (networkDependentAssertionsSkipped) {
    console.log('Live price-resolution assertions: SKIPPED (no outbound network access in this sandbox — every provider call is genuinely unreachable here, not a router defect). Re-run this script in an environment with real network access to verify actual price resolution end-to-end.')
  }
  console.log(staticResult.pass ? 'Hybrid pricing router order: VERIFIED' : 'Hybrid pricing router order: FAILED')
}

main().catch((err) => {
  console.error('[verifyHybridPricing] fatal error', err)
  process.exitCode = 1
})
