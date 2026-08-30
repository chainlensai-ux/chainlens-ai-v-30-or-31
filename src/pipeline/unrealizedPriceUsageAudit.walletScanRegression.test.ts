// TESTS — Wallet Scanner live-regression audit follow-up. Covers the acceptance items this task's
// spec lists that are provable without a full network-backed scan:
//   - unrealizedPriceUsageAudit builds correctly and is wired to survive to logs/output
//   - the legacy misleading counter is gone/renamed everywhere it's produced
//   - current-price lookups can never cross chains (same address, two chains, two distinct prices)
//   - the new debug-only fields never leak into the calm public wallet-scanner UI
// Realized PnL/FIFO correctness itself is proven by the pre-existing fifoEngine/computePnl test
// suites (untouched by this task — this file adds no logic to that path, only additive diagnostics
// downstream of an already-computed report).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUnrealizedPriceUsageAudit } from './unrealizedPriceUsageAudit'
import { nativeAliasKeys, buildCanonicalCurrentPriceLookup } from './runWalletScanV2'
import type { UnrealizedReconciliationSummary } from '../modules/fifoEngine/types'
import type { PricingResolutionAudit } from '../modules/pricing/types'
import type { TokenHolding } from '../modules/holdings/types'
import type { TokenPrice } from '../modules/pricing/types'

function emptyReconciliation(overrides: Partial<UnrealizedReconciliationSummary> = {}): UnrealizedReconciliationSummary {
  return {
    totalOpenPositions: 0,
    reconciledOpenPositions: 0,
    excludedPositions: [],
    reconciledPositionsByPriceSource: {},
    deadOrSpamPositionsCount: 0,
    openPositionCoveragePercent: 0,
    ...overrides,
  } as UnrealizedReconciliationSummary
}

// ─── unrealizedPriceUsageAudit builds a real, non-empty, informative object ─────────────────────
test('buildUnrealizedPriceUsageAudit answers "why were current-price calls made but not used" from real reconciliation data', () => {
  const reconciliation = emptyReconciliation({
    totalOpenPositions: 70,
    reconciledPositionsByPriceSource: { dexscreener_fallback: 8, geckoterminal_fallback: 3, provider_supplied: 0 },
    excludedPositions: [
      { chainId: 'base', tokenAddress: '0xabc', symbol: 'FOO', exclusionReason: 'missing_canonical_balance', currentPriceUsd: null } as UnrealizedReconciliationSummary['excludedPositions'][number],
      { chainId: 'base', tokenAddress: '0xdef', symbol: 'BAR', exclusionReason: 'open_quantity_exceeds_balance', currentPriceUsd: 1.23 } as UnrealizedReconciliationSummary['excludedPositions'][number],
    ],
  })
  const pricingAudit = { dexscreenerCalls: 13, geckoTerminalCalls: 2 } as PricingResolutionAudit

  const audit = buildUnrealizedPriceUsageAudit({ unrealizedReconciliation: reconciliation, pricingAudit })

  assert.equal(audit.openPositions, 70)
  assert.equal(audit.currentPriceCallsMade, 15, 'real dexscreener + geckoTerminal call counts, not a guess')
  assert.equal(audit.currentPriceCallsUsed, 11, 'fallback-backed reconciled positions only')
  assert.equal(audit.pricesRejected, 1, 'only the excluded position that HAD a resolved price counts as rejected')
  assert.deepEqual(audit.rejectionReasons, { open_quantity_exceeds_balance: 1 })
  assert.equal(audit.examples.length, 1)
  assert.equal(audit.examples[0].tokenAddress, '0xdef')
})

test('a scan with zero current-price calls reports zero, never a fabricated non-zero', () => {
  const audit = buildUnrealizedPriceUsageAudit({ unrealizedReconciliation: emptyReconciliation(), pricingAudit: null })
  assert.equal(audit.currentPriceCallsMade, 0)
  assert.equal(audit.currentPriceCallsUsed, 0)
  assert.equal(audit.pricesRejected, 0)
  assert.deepEqual(audit.examples, [])
})

// ─── Wiring: the audit reaches production-surviving log lines at both real call sites ───────────
test('unrealizedPriceUsageAudit is logged via console.warn (survives next.config removeConsole) at both its build site and the worker\'s final summary', async () => {
  const fs = await import('node:fs')
  const runWalletScanV2Src = fs.readFileSync(new URL('./runWalletScanV2.ts', import.meta.url), 'utf8')
  assert.match(runWalletScanV2Src, /console\.warn\('\[unrealized-price-usage-audit\]', unrealizedPriceUsageAudit\)/, 'built-and-logged at the scan-pipeline level')

  const workerSrc = fs.readFileSync(new URL('../modules/walletScanWorker.ts', import.meta.url), 'utf8')
  assert.match(workerSrc, /console\.warn\('\[wallet-worker-unrealized-price-usage-audit\]'/, 're-surfaced at the job-level final summary, next to the cost and timing audits')
})

// ─── The legacy misleading counter is gone / clearly relabeled everywhere it's produced ─────────
test('currentPriceCallsUsedForUnrealized no longer exists as a bare, unlabeled field name in the cost ledger', async () => {
  const fs = await import('node:fs')
  const ledgerSrc = fs.readFileSync(new URL('../modules/providerCost/walletProviderCostLedger.ts', import.meta.url), 'utf8')
  // Matches the field as an actual TS identifier usage (type member or object-literal key/value) —
  // deliberately does NOT flag a disclosure comment's own backticked mention of the old name for
  // historical context (see this file's own established convention of naming what a field used to
  // be called before renaming it).
  assert.doesNotMatch(ledgerSrc, /^\s*currentPriceCallsUsedForUnrealized[,:]/m, 'the old field name must not remain as a real identifier (type member or object key) anywhere in the ledger module')
  assert.match(ledgerSrc, /^\s*legacyMisleadingCurrentPriceCallsUsedForUnrealized[,:]/m, 'replaced by a clearly-legacy-labeled field carrying the exact same honest computation')
})

// ─── Cross-chain safety: the same token address on two different chains never shares a price ────
test('buildCanonicalCurrentPriceLookup never returns one chain\'s price for another chain\'s lookup', () => {
  const ADDR = '0x1111111111111111111111111111111111abcd'
  const holdings: TokenHolding[] = []
  const prices: TokenPrice[] = [
    { chain: 'base', contract: ADDR, priceUsd: 1.5, source: 'dexscreener_fallback' } as TokenPrice,
    { chain: 'eth', contract: ADDR, priceUsd: 42.0, source: 'geckoterminal_fallback' } as TokenPrice,
  ]
  const lookup = buildCanonicalCurrentPriceLookup(holdings, prices)
  assert.equal(lookup(ADDR, 'base')?.priceUsd, 1.5)
  assert.equal(lookup(ADDR, 'eth')?.priceUsd, 42.0)
  assert.notEqual(lookup(ADDR, 'base')?.priceUsd, lookup(ADDR, 'eth')?.priceUsd)
})

test('nativeAliasKeys keeps the chain in every key it produces, including the native-asset alias', () => {
  const baseKeys = nativeAliasKeys('base', '0x0000000000000000000000000000000000000000')
  const ethKeys = nativeAliasKeys('eth', '0x0000000000000000000000000000000000000000')
  for (const k of baseKeys) assert.ok(k.startsWith('base:'), `expected a base-prefixed key, got ${k}`)
  for (const k of ethKeys) assert.ok(k.startsWith('eth:'), `expected an eth-prefixed key, got ${k}`)
  assert.notDeepEqual(new Set(baseKeys), new Set(ethKeys))
})

// ─── The calm public UI never surfaces these debug-only fields ──────────────────────────────────
test('walletWorkerTimingAudit and the legacy-labeled ledger field never reach the public wallet-scanner UI component', async () => {
  const fs = await import('node:fs')
  const uiSrc = fs.readFileSync(new URL('../../app/frontend/components/PnlStatusCard.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(uiSrc, /walletWorkerTimingAudit/, 'server-log-only diagnostic must not appear in the calm public PnL card')
  assert.doesNotMatch(uiSrc, /legacyMisleadingCurrentPriceCallsUsedForUnrealized/, 'legacy debug counter must not appear in the calm public PnL card')
  assert.doesNotMatch(uiSrc, /goldRushHistoricalPricingEfficiencyAudit/, 'GoldRush efficiency audit must not leak into the public PnL card')
  assert.doesNotMatch(uiSrc, /openPositionExclusionAudit/, 'exclusion audit object must not leak into the public PnL card')
  assert.doesNotMatch(uiSrc, /walletProviderCostAudit/, 'provider-cost audit must not leak into the public PnL card')
  assert.match(uiSrc, /Technical details/, 'raw exclusion counts must sit behind a Technical details control')
})
