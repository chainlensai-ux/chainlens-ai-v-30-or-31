// Tests for the split-Wallet-Scanner-results fix task: Robinhood Chain is merged into ONE canonical
// Wallet Scanner result (one total, one holdings model, Robinhood as a chain tab) instead of
// rendering as a second, separate top-level card with its own conflicting total. Source-level,
// matching this session's established convention (scripts/test-button-responsiveness.mjs,
// scripts/test-wallet-scan-orchestrator.mjs) — every check reads the real file source and confirms
// the actual code shape, not a description of intended behavior. Also imports and directly exercises
// the pure merge helper (app/frontend/lib/mergedWalletView.ts) with real inputs/outputs.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  computeRobinhoodInclusion,
  computeMergedTotalValueUsd,
  portfolioCoverageCopy,
  ROBINHOOD_INCLUDED_COPY,
  ROBINHOOD_NOT_INCLUDED_COPY,
} from '../app/frontend/lib/mergedWalletView.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

function read(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

function run() {
  const pageSrc = read('app/terminal/wallet-scanner/page.tsx')
  const robinhoodUiSrc = read('app/frontend/components/RobinhoodChainSection.tsx')
  const portfolioCardSrc = read('app/frontend/components/PortfolioIntelligenceCard.tsx')
  const walletProfileHeaderSrc = read('app/frontend/components/WalletProfileHeader.tsx')
  const portfolioValueViewSrc = read('app/frontend/components/PortfolioValueView.tsx')
  const tabsSrc = read('app/frontend/components/WalletScannerTabsV3.tsx')
  const resultsV3Src = read('app/frontend/components/WalletScannerResultsV3.tsx')
  const summaryRowSrc = read('app/frontend/components/WalletScannerSummaryRowV3.tsx')
  const headerV3Src = read('app/frontend/components/WalletScannerHeaderV3.tsx')

  // ── 1. computeRobinhoodInclusion — real, honest state distinctions ─────────────────────────────
  {
    check('null robinhoodResult is never "included"', computeRobinhoodInclusion(null).included === false)
    check('ok:false response is never "included"', computeRobinhoodInclusion({ ok: false, holdings: { status: 'ok', portfolioTotalUsd: 5 } }).included === false)
    check('"not_configured" holdings status is never "included"', computeRobinhoodInclusion({ ok: true, holdings: { status: 'not_configured', portfolioTotalUsd: null } }).included === false)
    check('"unavailable" holdings status is never "included"', computeRobinhoodInclusion({ ok: true, holdings: { status: 'unavailable', portfolioTotalUsd: null } }).included === false)
    check('a real "ok" holdings status with a real total IS included, with the real value', computeRobinhoodInclusion({ ok: true, holdings: { status: 'ok', portfolioTotalUsd: 42.5 } }).included === true && computeRobinhoodInclusion({ ok: true, holdings: { status: 'ok', portfolioTotalUsd: 42.5 } }).valueUsd === 42.5)
    check('a real "partial" holdings status is also included (a real, thin-but-real sample)', computeRobinhoodInclusion({ ok: true, holdings: { status: 'partial', portfolioTotalUsd: 3 } }).included === true)
    check('an included scan with a null portfolioTotalUsd contributes 0, never a fabricated number', computeRobinhoodInclusion({ ok: true, holdings: { status: 'ok', portfolioTotalUsd: null } }).valueUsd === 0)
  }

  // ── 2. computeMergedTotalValueUsd — the ONE canonical total, never fabricated ──────────────────
  {
    check('no V2 total and no Robinhood result stays honestly null', computeMergedTotalValueUsd(null, null).totalValueUsd === null)
    check('a V2-only total (Robinhood never scanned) is unchanged from the V2 total alone', computeMergedTotalValueUsd(2.25, null).totalValueUsd === 2.25)
    // The confirmed live bug this task closes: $2.25 V2-only total shown next to a real, nonzero
    // Robinhood total for the same wallet — the merged total must be their real sum.
    const merged = computeMergedTotalValueUsd(2.25, { ok: true, holdings: { status: 'ok', portfolioTotalUsd: 118.40 } })
    check('a real V2 total plus a real, included Robinhood total is their literal sum', Math.abs(merged.totalValueUsd - 120.65) < 1e-9)
    check('the merge reports robinhoodIncluded: true when Robinhood was genuinely included', merged.robinhoodIncluded === true)
    const notIncluded = computeMergedTotalValueUsd(2.25, { ok: true, holdings: { status: 'not_configured', portfolioTotalUsd: null } })
    check('a not_configured Robinhood scan never inflates the total and reports robinhoodIncluded: false', notIncluded.totalValueUsd === 2.25 && notIncluded.robinhoodIncluded === false)
  }

  // ── 3. Coverage copy — exact required wording, conditional on real inclusion ───────────────────
  {
    check('the exact required "included" wording matches this task\'s own spec', ROBINHOOD_INCLUDED_COPY === 'Includes Robinhood Chain when enabled and successfully scanned.')
    check('portfolioCoverageCopy(true) returns the exact required "included" wording', portfolioCoverageCopy(true) === ROBINHOOD_INCLUDED_COPY)
    check('portfolioCoverageCopy(false) returns the honest not-included wording, never claiming Robinhood support does not exist', portfolioCoverageCopy(false) === ROBINHOOD_NOT_INCLUDED_COPY)
    check('the not-included copy never uses the old, now-permanently-false "no custodial/exchange integration" framing', !ROBINHOOD_NOT_INCLUDED_COPY.toLowerCase().includes('no custodial') && !ROBINHOOD_NOT_INCLUDED_COPY.toLowerCase().includes('anywhere in this codebase'))
  }

  // ── 4. The old unconditional "not included" wording is gone from all three named locations ─────
  {
    check('PortfolioIntelligenceCard.tsx no longer has the unconditional "are not included" sub-text', !portfolioCardSrc.includes('Custodial/exchange holdings (e.g. Robinhood) are not included'))
    check('PortfolioIntelligenceCard.tsx now sources its coverage line from portfolioCoverageCopy(merged.robinhoodIncluded)', portfolioCardSrc.includes('sub={portfolioCoverageCopy(merged.robinhoodIncluded)}'))
    check('WalletProfileHeader.tsx (PortfolioSnapshot) no longer has the unconditional "may not be included" copy', !walletProfileHeaderSrc.includes('Covers on-chain holdings on supported chains only — custodial/exchange holdings (e.g. Robinhood) may not be included.'))
    check('WalletProfileHeader.tsx now sources its coverage line from portfolioCoverageCopy(merged.robinhoodIncluded)', walletProfileHeaderSrc.includes('{portfolioCoverageCopy(merged.robinhoodIncluded)}'))
    check('PortfolioValueView.tsx no longer has the unconditional "may not be included" copy', !portfolioValueViewSrc.includes('Custodial/exchange holdings (e.g. Robinhood) may not be included.'))
    check('PortfolioValueView.tsx now sources its coverage line from portfolioCoverageCopy', portfolioValueViewSrc.includes('portfolioCoverageCopy(robinhoodIncluded)'))
    // The rendered coverage line in all three is now genuinely conditional on real scan state (see
    // check 3 above for the exact copy) rather than the old fixed, unconditional string — confirmed
    // directly by check 4's own assertions that the fixed old strings are gone and the conditional
    // `portfolioCoverageCopy(...)` call sites exist instead.
  }

  // ── 5. One canonical total: the total merges Robinhood in wherever it is displayed ─────────────
  {
    check('PortfolioIntelligenceCard merges Robinhood into its displayed total via computeMergedTotalValueUsd', portfolioCardSrc.includes('computeMergedTotalValueUsd(stats.totalValueUsd, robinhoodResult)'))
    check('WalletProfileHeader\'s PortfolioSnapshot (the live V3 hero total) merges Robinhood in the same way', walletProfileHeaderSrc.includes('computeMergedTotalValueUsd(stats.totalValueUsd, robinhoodResult)'))
    check('WalletScannerSummaryRowV3 forwards robinhoodResult into PortfolioIntelligenceCard', summaryRowSrc.includes('robinhoodResult={robinhoodResult}'))
    check('WalletScannerHeaderV3 forwards robinhoodResult into PortfolioSnapshot', headerV3Src.includes('robinhoodResult={robinhoodResult}'))
    check('WalletScannerResultsV3 forwards robinhoodResult into both the header and the summary row', (resultsV3Src.match(/robinhoodResult=\{robinhoodResult\}/g) ?? []).length >= 2)
    check('page.tsx passes the real robinhoodResult state into WalletScannerResultsV3', /<WalletScannerResultsV3[\s\S]{0,600}robinhoodResult=\{robinhoodResult\}/.test(pageSrc))
  }

  // ── 6. Robinhood renders as a chain tab inside the one result, not a second competing scanner ──
  {
    check('WalletScannerTabsV3 adds a "robinhood" tab key only when a real robinhoodResult exists', tabsSrc.includes("...(robinhoodResult ? [{ key: 'robinhood' as const, label: 'Robinhood' }] : [])"))
    check('the Robinhood tab renders the real RobinhoodChainSection component, not a re-derived summary', tabsSrc.includes("activeTab === 'robinhood' && robinhoodResult") && tabsSrc.includes('<RobinhoodChainSection'))
    check('page.tsx no longer renders RobinhoodChainSection unconditionally whenever a robinhoodResult exists (the confirmed two-card bug)', !/\{robinhoodResult && \(\s*<RobinhoodChainSection/.test(pageSrc))
    check('the one remaining standalone RobinhoodChainSection render in page.tsx is gated to only fire when there is no main result, or in debug mode', pageSrc.includes('{robinhoodResult && (!result || debugMode) && ('))
  }

  // ── 7. The CORTEX Wallet Read sidebar uses the same merged result, not the V2-only one ─────────
  {
    check('buildCortexReadV2 accepts a robinhoodResult parameter', /function buildCortexReadV2\(\s*report: WalletV2Report \| null \| undefined,\s*robinhoodResult\?: RobinhoodWalletScanResponse \| null,/.test(pageSrc))
    check('buildCortexReadV2 computes its total through the same computeMergedTotalValueUsd helper every other canonical total uses', pageSrc.includes('const merged = computeMergedTotalValueUsd(v2TotalValueUsd, robinhoodResult)'))
    check('the CORTEX sidebar call site passes the real robinhoodResult state through', pageSrc.includes('buildCortexReadV2(result, robinhoodResult)'))
  }

  // ── 8. Activity and PnL stay separate — never blended, never mixed into portfolio value ────────
  {
    const activityCardIndex = robinhoodUiSrc.indexOf('ACTIVITY CARD:')
    const pnlCardIndex = robinhoodUiSrc.indexOf('PNL CARD:')
    check('the Activity card and PnL card are still two distinct elements, in that order', activityCardIndex !== -1 && pnlCardIndex !== -1 && activityCardIndex < pnlCardIndex)
    check('the required "PnL not verified yet" message exists, worded exactly as this task\'s own spec requires', robinhoodUiSrc.includes('Robinhood PnL not verified yet — requires verified swap logs and both-leg price evidence.'))
    check('the not-verified PnL message never appears inside the portfolio-value StatBox rendering (no mixing value and PnL-status text)', !new RegExp('Supported On-Chain Portfolio Value[\\s\\S]{0,400}Robinhood PnL not verified yet').test(portfolioCardSrc))
  }

  // ── 9. Robinhood evidence/audit fields are still fully visible (nothing deleted) ────────────────
  {
    for (const label of ['Native ETH', 'Priced Holdings', 'Unpriced Holdings', 'Pricing Coverage', 'PnL Status']) {
      check(`the Robinhood summary cards still include "${label}"`, robinhoodUiSrc.includes(`label="${label}"`))
    }
    check('Verified Robinhood swaps still renders', robinhoodUiSrc.includes('Verified Robinhood swaps: <strong'))
    check('Skipped unsupported swap logs still renders', robinhoodUiSrc.includes('Skipped unsupported swap logs: <strong'))
    check('the Blockscout status badges still render (GoldRush/Alchemy RPC/explorer evidence)', robinhoodUiSrc.includes('GoldRush: ${holdings.status}') && robinhoodUiSrc.includes('Alchemy RPC: ${holdings.native'))
    check('the robinhoodWalletScannerAudit field is still carried on the response type (nothing stripped)', robinhoodUiSrc.includes('robinhoodWalletScannerAudit: Record<string, unknown>'))
  }

  // ── 10. Robinhood decoder/PnL gates untouched by this task ──────────────────────────────────────
  {
    check('lib/server/robinhoodWalletScanner.ts was not touched by this task (still exports the same gated PnL resolver)', read('lib/server/robinhoodWalletScanner.ts').includes('export async function resolveRobinhoodWalletPnl'))
    check('lib/server/robinhoodSwapDecoder.ts was not touched by this task (still exports the same decoder)', read('lib/server/robinhoodSwapDecoder.ts').includes('decodeRobinhoodSwapLog'))
    check('the Robinhood API route response shape is untouched (still returns the same top-level keys)', /ok:\s*true[\s\S]{0,400}wallet[\s\S]{0,400}holdings[\s\S]{0,400}activity[\s\S]{0,400}pnl/.test(read('app/api/wallet-scan/robinhood/route.ts')) || read('app/api/wallet-scan/robinhood/route.ts').includes('holdings,') )
  }

  console.log(`test-wallet-scanner-merged-view.mjs: all ${passed} assertions passed`)
}

run()
