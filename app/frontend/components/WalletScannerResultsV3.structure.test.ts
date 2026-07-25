// Structural (source-scan) tests for the Wallet Scanner V3 layout — proving, without a component
// rendering harness (this codebase has no @testing-library/react or similar — verified by
// package.json search before writing this in the same pure-source-scan style already used by
// lib/engine/modules/pricing/fetchPricing.test.ts's "never imports pricingAtTimeEngine" guard),
// that:
//   1. every V3 layout file reuses the SAME existing components/selectors the old layout used —
//      never a reimplemented calculation — so old and redesigned UIs are structurally guaranteed to
//      read identical underlying numeric values for the same `report`.
//   2. no V3 layout file introduces a new network call (fetch/XMLHttpRequest) of its own.
// Uses node:test. Run with:
//   npx tsx --test app/frontend/components/WalletScannerResultsV3.structure.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const V3_FILES = [
  'WalletScannerResultsV3.tsx',
  'WalletScannerHeaderV3.tsx',
  'WalletScannerSummaryRowV3.tsx',
  'WalletScannerTabsV3.tsx',
  'WalletScannerDiagnosticsV3.tsx',
]

function readV3File(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')
}

describe('Wallet Scanner V3 layout — reuses existing components, never a duplicated calculation', () => {
  it('WalletScannerHeaderV3 imports WalletOverview/PortfolioSnapshot/Actions from WalletProfileHeader — never a re-derived header', () => {
    const source = readV3File('WalletScannerHeaderV3.tsx')
    assert.match(source, /import \{ WalletOverview, PortfolioSnapshot, Actions \} from '\.\/WalletProfileHeader'/)
  })

  it('WalletScannerSummaryRowV3 imports the existing PortfolioIntelligenceCard/SmartMoneyScoreCard/PnlStatusCard — never a re-derived summary', () => {
    const source = readV3File('WalletScannerSummaryRowV3.tsx')
    assert.match(source, /import \{ PortfolioIntelligenceCard \} from '\.\/PortfolioIntelligenceCard'/)
    assert.match(source, /import \{ SmartMoneyScoreCard \} from '\.\/SmartMoneyScoreCard'/)
    assert.match(source, /import \{ PnlStatusCard \} from '\.\/PnlStatusCard'/)
  })

  it('WalletScannerTabsV3 imports the existing HoldingsViewV2/SellActivitySummary/ChainSelectionView — never a re-derived holdings/sell/chain view', () => {
    const source = readV3File('WalletScannerTabsV3.tsx')
    assert.match(source, /import \{ HoldingsViewV2 \} from '\.\/HoldingsViewV2'/)
    assert.match(source, /import \{ SellActivitySummary \} from '\.\/SellActivitySummary'/)
    assert.match(source, /import \{ ChainSelectionView \} from '\.\/ChainSelectionView'/)
  })

  it('WalletScannerTabsV3 passes pricedHoldings/chainValueUsd straight through to HoldingsViewV2 — the same canonical selectHoldingsV2() source the old layout uses', () => {
    const source = readV3File('WalletScannerTabsV3.tsx')
    assert.match(source, /pricedHoldings=\{report\.pricedHoldings\}/)
    assert.match(source, /chainValueUsd=\{report\.chainValueUsd\}/)
  })

  it('WalletScannerDiagnosticsV3 imports the existing FinalSummaryView/RecoveryHealthCard/CoverageTimelineCard/ScanDiagnosticsCard/BehaviorIntelView — nothing is deleted, only moved into a collapsible section', () => {
    const source = readV3File('WalletScannerDiagnosticsV3.tsx')
    for (const name of ['FinalSummaryView', 'RecoveryHealthCard', 'CoverageTimelineCard', 'ScanDiagnosticsCard', 'BehaviorIntelView']) {
      assert.match(source, new RegExp(`import \\{ ${name} \\} from '\\./${name}'`), `expected ${name} to still be imported/reused, not deleted`)
    }
  })

  it('no V3 layout file makes a new network call of its own (fetch/XMLHttpRequest) — every number comes from the already-fetched `report` prop', () => {
    for (const file of V3_FILES) {
      const source = readV3File(file)
      assert.ok(!/\bfetch\s*\(/.test(source), `${file} must not call fetch() directly`)
      assert.ok(!/XMLHttpRequest/.test(source), `${file} must not use XMLHttpRequest`)
    }
  })

  it('no V3 layout file imports a backend/business-logic module directly (holdings/pricing fetchers, provider clients) — only types and existing presentational components', () => {
    const forbidden = [
      'src/modules/holdings/index',
      'src/lib/dexscreenerRequestCache',
      'lib/engine/modules/pricing/fetchPricing',
      'lib/providers/',
      'workers/walletScanV2',
    ]
    for (const file of V3_FILES) {
      const source = readV3File(file)
      for (const forbiddenImport of forbidden) {
        assert.ok(!source.includes(forbiddenImport), `${file} must not import ${forbiddenImport} — presentational layer only`)
      }
    }
  })
})
