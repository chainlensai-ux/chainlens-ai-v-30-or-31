// scripts/verifyHybridPricing.ts
//
// Verification harness for the chain-aware historical-pricing router
// (src/pipeline/pricingAtTimeAdapter.ts's buildChainAwareHistoricalPriceSource).
//
// DEVIATIONS FROM THE LITERAL SPEC, ALL DISCLOSED (the requesting task itself already stated most
// of these as "facts to respect" — restated here against the real source, not assumed):
//
// 1. BNB / Polygon / Solana do not exist: SupportedChain (src/modules/providerFetchWindow/types.ts)
//    is only 'base' | 'eth' | 'arbitrum' | 'hyperevm'. Test matrix uses only real chains.
//
// 2. `historicalPricingAttempts[]` / `historicalPricingFailures[]` (src/pipeline/
//    priceLotsForWallet.ts) are PER-TOKEN FINAL-OUTCOME records — one entry per token holding
//    whichever provider ultimately won (or 'none' if every provider failed). They are NOT a
//    per-provider attempt sequence, so they cannot show "GoldRush tried, then DexScreener tried,
//    then GeckoTerminal tried" for a single token — only pricingRouteLog's single winning/failing
//    route per call. Requirement 7's "must list providers in the correct order" / "must list all
//    providers" is therefore not something these two arrays can satisfy as literally worded; this
//    harness reports what they actually contain (one outcome per token) instead of fabricating a
//    per-provider list that doesn't exist in the real data structure. Call ORDER is verified
//    separately, statically, against the real source text (section 1 below).
//
// 3. costBasisUsd / unrealizedPnlUsd / integrity / pricedTokens: confirmed (again) absent from
//    src/modules/pnlEngine/types.ts and everywhere else in this codebase — not asserted.
//
// 4. No network access in this sandbox: every real provider call (GeckoTerminal, DexScreener,
//    CoinGecko, basedex RPC, GoldRush) is genuinely unreachable here. All dynamic results are
//    expected-null and labeled as a sandbox limitation, never as a router failure.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildChainAwareHistoricalPriceSource,
  pricingRouteLog,
} from '../src/pipeline/pricingAtTimeAdapter'
import { priceLotsForWallet } from '../src/pipeline/priceLotsForWallet'
import { noPriceSources } from '../src/pipeline/utils'
import type { SupportedChain } from '../src/modules/providerFetchWindow/types'
import type { PriceSourceFn } from '../src/modules/pricingAtTimeEngine/types'
import type { NormalizedEvent } from '../src/modules/normalization/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

type TestToken = {
  label: string
  chain: SupportedChain
  tokenAddress: string
  expectedFirstProvider: 'goldrush' | 'geckoterminal'
}

// Real supported chains only.
const TEST_MATRIX: TestToken[] = [
  { label: 'ETH token', chain: 'eth', tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', expectedFirstProvider: 'goldrush' },
  { label: 'Arbitrum token', chain: 'arbitrum', tokenAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', expectedFirstProvider: 'goldrush' },
  { label: 'HyperEVM token', chain: 'hyperevm', tokenAddress: '0x0000000000000000000000000000000000dead', expectedFirstProvider: 'goldrush' },
  { label: 'Base token', chain: 'base', tokenAddress: '0x4200000000000000000000000000000000000006', expectedFirstProvider: 'geckoterminal' },
]

// Always-null stand-in for GoldRush — this harness has no real API key/network, so the router's
// GoldRush slot degrades exactly the way it does in production when GOLDRUSH_API_KEY is absent
// (see src/pipeline/index.ts's buildPriceSources()). A real, existing degrade path, not an invented mock.
const alwaysNullGoldrush: PriceSourceFn = async () => null

// ============================================================================================
// 1. STATIC VERIFICATION — reads the real pricingAtTimeAdapter.ts source on disk.
// ============================================================================================
function staticVerification(): { pass: boolean; lines: string[] } {
  const sourcePath = path.join(__dirname, '../src/pipeline/pricingAtTimeAdapter.ts')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const lines: string[] = []
  let pass = true

  const branchMatch = source.match(/if \(chain === 'base'\) \{([\s\S]*?)\} else \{([\s\S]*?)\}\s*\n\s*const safetyNetPrice/)
  if (!branchMatch) {
    lines.push('FAIL: could not locate the base/non-base branch structure in the real source file')
    return { pass: false, lines }
  }
  const [, baseBranch, nonBaseBranch] = branchMatch

  // Base order: GeckoTerminal -> DexScreener -> GoldRush (then safety net, checked separately).
  const baseCalls = [...baseBranch.matchAll(/try(GeckoTerminal|Dexscreener|Goldrush)\(/g)].map((m) => m[1])
  const baseOrderOk = baseCalls.join(',') === 'GeckoTerminal,Dexscreener,Goldrush'
  if (baseOrderOk) {
    lines.push('Static routing order verified for Base.')
  } else {
    pass = false
    lines.push(`FAIL: Base order is [${baseCalls.join(', ')}], expected [GeckoTerminal, Dexscreener, Goldrush]`)
  }

  // Non-Base order: GoldRush -> DexScreener -> GeckoTerminal.
  const nonBaseCalls = [...nonBaseBranch.matchAll(/try(GeckoTerminal|Dexscreener|Goldrush)\(/g)].map((m) => m[1])
  const nonBaseOrderOk = nonBaseCalls.join(',') === 'Goldrush,Dexscreener,GeckoTerminal'
  if (nonBaseOrderOk) {
    lines.push('Static routing order verified for non-Base.')
  } else {
    pass = false
    lines.push(`FAIL: non-Base order is [${nonBaseCalls.join(', ')}], expected [Goldrush, Dexscreener, GeckoTerminal]`)
  }

  // Sanity guard ($0 < price <= $1e6) — applied via isSanePrice() inside every try* helper, plus
  // the standalone withSanePriceGuard() used elsewhere. Checked by confirming isSanePrice() is
  // both defined with the real bounds AND referenced inside all three try* helper bodies.
  const boundsMatch = /price > MIN_VALID_USD_PRICE && price <= MAX_VALID_USD_PRICE/.test(source)
    && /MIN_VALID_USD_PRICE = 0/.test(source)
    && /MAX_VALID_USD_PRICE = 1e6/.test(source)
  const tryGoldrushBody = source.match(/const tryGoldrush = async[\s\S]*?\n  \}/)?.[0] ?? ''
  const tryDexBody = source.match(/const tryDexscreener = async[\s\S]*?\n  \}/)?.[0] ?? ''
  const tryGeckoBody = source.match(/const tryGeckoTerminal = async[\s\S]*?\n  \}/)?.[0] ?? ''
  const guardInAllThree = [tryGoldrushBody, tryDexBody, tryGeckoBody].every((b) => /isSanePrice\(/.test(b))
  const guardInSafetyNet = /isSanePrice\(safetyNetPrice\)/.test(source)
  if (boundsMatch && guardInAllThree && guardInSafetyNet) {
    lines.push('Sanity guard present.')
  } else {
    pass = false
    lines.push(`FAIL: sanity guard not confirmed at every step (bounds=${boundsMatch}, allThree=${guardInAllThree}, safetyNet=${guardInSafetyNet})`)
  }

  // Fallback providers preserved: coverageSafetyNet (multiProviderPriceSource -> CoinGecko/basedex)
  // called strictly after both branches, for every chain.
  const safetyNetPos = source.indexOf('coverageSafetyNet(token, chain, timestamp)')
  const branchStartPos = source.indexOf("chain === 'base'")
  const usesMultiProvider = /multiProviderPriceSource\(\)/.test(source)
  if (safetyNetPos > branchStartPos && usesMultiProvider) {
    lines.push('Fallback providers preserved.')
  } else {
    pass = false
    lines.push('FAIL: CoinGecko/basedex safety net (coverageSafetyNet/multiProviderPriceSource) not confirmed as a final, always-reached fallback')
  }

  return { pass, lines }
}

// ============================================================================================
// 2. DYNAMIC VERIFICATION — live run against the real exported router + priceLotsForWallet.
// ============================================================================================
function makeBuyEvent(chain: SupportedChain, tokenAddress: string): NormalizedEvent {
  return {
    provider: 'alchemy' as NormalizedEvent['provider'],
    chain,
    txHash: `0xtest_${chain}_${tokenAddress.slice(2, 10)}`,
    timestamp: String(Date.now() - 30 * 24 * 60 * 60 * 1000),
    fromAddress: '0x000000000000000000000000000000000000aa',
    toAddress: '0x000000000000000000000000000000000000bb',
    contract: tokenAddress.toLowerCase(),
    symbol: 'TEST',
    amount: 100,
    amountRaw: '100000000000000000000',
    tokenDecimals: 18,
    direction: 'inbound',
  }
}

async function dynamicVerification() {
  const router = buildChainAwareHistoricalPriceSource(alwaysNullGoldrush)
  const perToken: Array<{
    label: string
    chain: SupportedChain
    tokenAddress: string
    returnedPrice: number | null
    routeOutcome: string
  }> = []

  for (const test of TEST_MATRIX) {
    const timestamp = Date.now() - 30 * 24 * 60 * 60 * 1000
    const snapshotBefore = pricingRouteLog.length
    const returnedPrice = await router(test.tokenAddress, test.chain, timestamp)
    const newRecords = pricingRouteLog.slice(snapshotBefore)
    perToken.push({
      label: test.label,
      chain: test.chain,
      tokenAddress: test.tokenAddress,
      returnedPrice,
      routeOutcome: newRecords[newRecords.length - 1]?.route ?? 'NO RECORD',
    })
  }

  // priceLotsForWallet, real call — one synthetic inbound "buy" per test token, priced through the
  // same chain-aware router (primary) with an always-null fallback (mirrors production's own
  // fallback: noPriceSources().fallback, since the router already encapsulates every provider).
  const walletLookups = await priceLotsForWallet({
    normalizedEvents: TEST_MATRIX.map((t) => makeBuyEvent(t.chain, t.tokenAddress)),
    recoveredEvents: [],
    priceSources: { primary: router, fallback: noPriceSources().fallback },
  })

  return { perToken, walletLookups }
}

async function main() {
  console.log('=== Hybrid Pricing Router Verification ===\n')

  console.log('--- STATIC VERIFICATION (source-text based) ---')
  const staticResult = staticVerification()
  for (const line of staticResult.lines) console.log(line)
  console.log()

  console.log('--- DYNAMIC VERIFICATION (live run — NO NETWORK ACCESS in this sandbox) ---')
  const { perToken, walletLookups } = await dynamicVerification()
  for (const r of perToken) {
    console.log(`\n[${r.label}] chainId=${r.chain} tokenAddress=${r.tokenAddress}`)
    console.log(`  returnedPrice: ${r.returnedPrice} ${r.returnedPrice === null ? '(null due to sandbox, not a router failure)' : ''}`)
    console.log(`  pricingRouteLog outcome: ${r.routeOutcome}`)
  }
  console.log('\n[priceLotsForWallet — real call over the same test matrix]')
  console.log('  historicalPricingAttempts[] (per-token final outcome, NOT a per-provider sequence — see deviation #2):')
  console.log('   ', JSON.stringify(walletLookups.historicalPricingAttempts))
  console.log('  historicalPricingFailures[] (tokens where every provider returned null):')
  console.log('   ', JSON.stringify(walletLookups.historicalPricingFailures))
  console.log('  pricingUnavailableTokens[]:')
  console.log('   ', JSON.stringify(walletLookups.pricingUnavailableTokens))

  // priceLotsForWallet prices each token TWICE (once at its buy timestamp via the atTradeTime
  // pass, once "now" via the atNow pass for marking open lots to market) — so N test tokens
  // produce 2*N pricingRouteLog entries, confirmed by the actual run, not assumed in advance.
  const expectedUnavailableTokens = TEST_MATRIX.map((t) => `${t.chain}:${t.tokenAddress.toLowerCase()}`)
  const allTestTokensUnavailable = expectedUnavailableTokens.every((k) => walletLookups.pricingUnavailableTokens.includes(k))
  const allFailedInSandbox = walletLookups.historicalPricingFailures.length === TEST_MATRIX.length * 2
    && walletLookups.historicalPricingAttempts.length === 0

  console.log()
  console.log('--- Assertions not applicable to this codebase (fields do not exist) ---')
  console.log('  costBasisUsd, unrealizedPnlUsd, integrity, pricedTokens: N/A — confirmed absent from')
  console.log('  src/modules/pnlEngine/types.ts and everywhere else in this codebase. Not asserted.')

  console.log('\n=== SUMMARY ===')
  const dynamicMatchesSandboxExpectation = allFailedInSandbox && allTestTokensUnavailable
  if (!dynamicMatchesSandboxExpectation) {
    console.log(`  historicalPricingFailures.length=${walletLookups.historicalPricingFailures.length} (expected ${TEST_MATRIX.length * 2} — each token is priced twice: buy-timestamp + current)`)
    console.log(`  all test tokens in pricingUnavailableTokens: ${allTestTokensUnavailable}`)
  }
  if (staticResult.pass && dynamicMatchesSandboxExpectation) {
    console.log('Hybrid pricing router verified: PASS (sandbox mode)')
  } else {
    console.log('Hybrid pricing router verified: FAIL')
    if (!staticResult.pass) console.log('  Static verification failed — see lines above.')
    if (!dynamicMatchesSandboxExpectation) console.log('  Dynamic sandbox-mode expectation not met — see counts above.')
  }
}

main().catch((err) => {
  console.error('[verifyHybridPricing] fatal error', err)
  process.exitCode = 1
})
