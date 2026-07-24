// Direct test for app/terminal/wallet-scanner/page.tsx's resolvePreservedResultOnScanStart() —
// the confirmed "refresh keeps previous total until canonical portfolio stage resolves" fix.
// Uses node:test, same convention as this codebase's other module test files. Run with:
//   npx tsx --test app/terminal/wallet-scanner/page.resolvePreservedResult.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePreservedResultOnScanStart } from './page'
import type { WalletV2Report } from './page'

function report(walletAddress: string, totalValueUsd: number): WalletV2Report {
  return {
    scanMetadata: { walletAddress },
    portfolioV2: { totalValueUsd, categories: [], chains: [], topHoldings: [], stablecoinRatio: 0, concentrationIndex: 0 },
    // Everything else on WalletV2Report is optional/absent for this test's purposes — the function
    // under test only ever reads scanMetadata.walletAddress.
  } as unknown as WalletV2Report
}

describe('resolvePreservedResultOnScanStart — staged-refresh fix (confirmed regression)', () => {
  it('a refresh of the SAME wallet keeps the prior COMPLETE result — never replaced by a partial/null subtotal mid-scan', () => {
    const prior = report('0xSameWallet', 13531.40)
    const preserved = resolvePreservedResultOnScanStart(prior, '0xSameWallet')
    assert.equal(preserved, prior, 'the exact same, already-complete report object must be kept — never a partial reconstruction')
    assert.equal(preserved?.portfolioV2?.totalValueUsd, 13531.40, 'the previous total must remain visible, not blanked to null or a partial subtotal')
  })

  it('is case-insensitive on the wallet address', () => {
    const prior = report('0xAbCdEf', 500)
    assert.equal(resolvePreservedResultOnScanStart(prior, '0xabcdef'), prior)
  })

  it('scanning a genuinely DIFFERENT wallet clears the prior result — never shows wallet A\'s total while scanning wallet B', () => {
    const prior = report('0xWalletA', 13531.40)
    const cleared = resolvePreservedResultOnScanStart(prior, '0xWalletB')
    assert.equal(cleared, null, 'a different wallet must start from a clean slate, never carry over an unrelated wallet\'s total')
  })

  it('no prior result at all resolves to null (first scan, nothing to preserve)', () => {
    assert.equal(resolvePreservedResultOnScanStart(null, '0xNewWallet'), null)
  })
})
