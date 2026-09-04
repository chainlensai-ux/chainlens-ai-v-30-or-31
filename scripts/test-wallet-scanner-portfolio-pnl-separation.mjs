// Wallet Scanner portfolio-value vs PnL-evidence separation.
// Confirmed live bug: canonicalTotalValueUsd = 8669.94, Base 8664.03, ETH 5.91,
// pricedHoldingsCount = 24, but the PnL panel painted green Base $0.00 because
// closedLots=0 / realizedPnlUsd=null and pnlV2.chainBreakdown defaults to 0.
import assert from 'node:assert/strict'
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`  FAIL: ${label}`) }
}

const {
  buildWalletPnlViewModel,
  displayChainPnlValue,
  shouldSuppressUnverifiedZeroPnl,
  CHAIN_PNL_PARTIAL_REASON,
} = await import('../app/frontend/lib/buildWalletPnlViewModel.ts')
const {
  buildWalletScannerViewModel,
  buildPortfolioValueView,
} = await import('../app/frontend/lib/buildWalletScannerViewModel.ts')
const { PNL_UNAVAILABLE_MESSAGE: CARD_UNAVAILABLE } = await import('../app/frontend/components/PnlStatusCard.tsx')

const pnlVmSrc = fs.readFileSync(new URL('../app/frontend/lib/buildWalletPnlViewModel.ts', import.meta.url), 'utf8')
const scannerVmSrc = fs.readFileSync(new URL('../app/frontend/lib/buildWalletScannerViewModel.ts', import.meta.url), 'utf8')
const summarySrc = fs.readFileSync(new URL('../app/frontend/components/WalletScannerSummaryRowV3.tsx', import.meta.url), 'utf8')
const pageSrc = fs.readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')
const pnlCardSrc = fs.readFileSync(new URL('../app/frontend/components/PnlStatusCard.tsx', import.meta.url), 'utf8')

function holding(chainId, symbol, valueUsd) {
  return {
    chainId, tokenAddress: `0x${symbol.toLowerCase()}`, symbol, decimals: 18,
    quantity: '1', priceUsd: valueUsd, valueUsd, classification: 'other',
  }
}

function prodReport() {
  const pricedHoldings = [
    holding(8453, 'BASE1', 4000),
    ...Array.from({ length: 22 }, (_, i) => holding(8453, `B${i}`, 4664.03 / 22)),
    holding(1, 'ETH1', 5.91),
  ]
  return {
    walletAddress: '0x1111111111111111111111111111111111111111',
    portfolio: { totalValueUsd: 300, tokens: [], chainValueBreakdown: [] },
    portfolioV2: {
      totalValueUsd: 8669.94, categories: [], chains: [],
      topHoldings: [{ symbol: 'BASE1', percentage: 0.46, tokenAddress: '0xbase1', valueUsd: 4000, chainId: 8453 }],
      stablecoinRatio: 0, concentrationIndex: 0,
    },
    chainValueUsd: { 8453: 8664.03, 1: 5.91 },
    pricedHoldings,
    canonicalTotalValueUsd: 8669.94,
    finalCanonicalMergeAudit: { robinhoodMerged: false },
    pnlV2: {
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      costBasis: [],
      realized: [],
      unrealized: [],
      chainBreakdown: [
        { chainId: 8453, realizedPnlUsd: 0, unrealizedPnlUsd: 0 },
        { chainId: 1, realizedPnlUsd: 0, unrealizedPnlUsd: 0 },
      ],
    },
    publicPnlStatus: 'unavailable',
    chainsScanned: ['base', 'eth'],
    robinhoodResult: {
      ok: true,
      pnl: { status: 'disabled', realizedPnlUsd: null, verifiedSwapCount: 0, matchedLotsCount: 0, message: '', reason: 'not verified' },
      holdings: {
        status: 'unavailable',
        portfolioTotalUsd: null,
        unpricedTokenCount: 0,
        reason: null,
        native: null,
        holdings: [],
      },
    },
  }
}

console.log('Section 1: priced holdings still show when PnL unavailable')
{
  const input = prodReport()
  const vm = buildWalletScannerViewModel(input)
  check('portfolio total is the canonical $8669.94', vm.portfolioValueView.totalValueUsd === 8669.94)
  check('priced holdings count is 24, not gated on PnL', vm.portfolioValueView.pricedHoldingsCount === 24)
  check('portfolio valueStatus is ready', vm.portfolioValueView.valueStatus === 'ready')
  check('combined PnL is unavailable', vm.pnlEvidenceView.combinedStatus === 'unavailable')
  check('portfolio ready + PnL unavailable is a valid combined UI state', vm.audit.finalUiState === 'portfolio_ready_pnl_unavailable')
}

console.log('\nSection 2: PnL unavailable never displays $0.00')
{
  const input = prodReport()
  const vm = buildWalletScannerViewModel(input)
  const base = vm.pnlEvidenceView.chainPnlRows.find((r) => r.chain === 'base')
  const eth = vm.pnlEvidenceView.chainPnlRows.find((r) => r.chain === 'eth')
  check('Base status is Partial (scan ran, evidence incomplete)', base?.status === 'Partial')
  check('ETH status is Partial', eth?.status === 'Partial')
  check('Base value is null, not $0.00', base?.value === null)
  check('ETH value is null, not $0.00', eth?.value === null)
  check('combined realized box is null, not $0.00', vm.pnlViewModel.combinedRealizedBox.value === null)
  check('displayed PnL values never contain $0.00', Object.values(vm.audit.displayedPnlValues).every((v) => v !== '$0.00' && v !== '+$0.00'))
  check('zeroValuesSuppressed includes base and eth', vm.audit.zeroValuesSuppressed.includes('base') && vm.audit.zeroValuesSuppressed.includes('eth'))
  check('displayChainPnlValue(Partial, 0) returns null', displayChainPnlValue('Partial', 0) === null)
  check('displayChainPnlValue(Unavailable, 0) returns null', displayChainPnlValue('Unavailable', 0) === null)
  check('displayChainPnlValue(Verified, 0) still shows $0.00', displayChainPnlValue('Verified', 0) === '$0.00')
  check('shouldSuppressUnverifiedZeroPnl is true for Partial 0', shouldSuppressUnverifiedZeroPnl('Partial', 0) === true)
  check('shouldSuppressUnverifiedZeroPnl is false for Verified 0', shouldSuppressUnverifiedZeroPnl('Verified', 0) === false)
}

console.log('\nSection 3: portfolio total does not depend on realized PnL')
{
  const input = prodReport()
  const a = buildPortfolioValueView(input)
  const b = buildPortfolioValueView({ ...input, pnlV2: { ...input.pnlV2, realizedPnlUsd: 999999, chainBreakdown: [{ chainId: 8453, realizedPnlUsd: 999999, unrealizedPnlUsd: 0 }] } })
  check('portfolio total is identical when realized PnL is swapped for a huge number', a.totalValueUsd === b.totalValueUsd)
  check('portfolio total equals canonicalTotalValueUsd, not realized PnL', a.totalValueUsd === input.canonicalTotalValueUsd)
  check('assembler never reads realizedPnlUsd for portfolio value', !/realizedPnlUsd/.test(scannerVmSrc.split('export function buildPortfolioValueView')[1].split('export function buildPnlEvidenceView')[0]))
}

console.log('\nSection 4: Base/ETH holdings values remain visible')
{
  const vm = buildWalletScannerViewModel(prodReport())
  check('Base portfolio value is $8664.03', vm.portfolioValueView.valueByChain.base === 8664.03)
  check('ETH portfolio value is $5.91', vm.portfolioValueView.valueByChain.eth === 5.91)
  check('displayed portfolio value is the full USD figure', vm.audit.displayedPortfolioValue === '$8,669.94')
}

console.log('\nSection 5: Robinhood not verified does not block Base/ETH portfolio value')
{
  const vm = buildWalletScannerViewModel(prodReport())
  const rh = vm.pnlEvidenceView.chainPnlRows.find((r) => r.chain === 'robinhood')
  check('Robinhood row is Not verified', rh?.status === 'Not verified')
  check('Robinhood PnL value is —', rh?.value === null)
  check('Base/ETH portfolio value still ready', vm.portfolioValueView.valueStatus === 'ready' && vm.portfolioValueView.totalValueUsd === 8669.94)
  check('audit robinhoodPnlStatus is Not verified', vm.audit.robinhoodPnlStatus === 'Not verified')
}

console.log('\nSection 6: Combined unavailable shows exact missing-evidence reason')
{
  const vm = buildWalletScannerViewModel(prodReport())
  check('combined reason is the canonical unavailable message', vm.pnlEvidenceView.combinedReason === CARD_UNAVAILABLE)
  check('message mentions missing evidence', /missing evidence/i.test(vm.pnlEvidenceView.combinedReason))
  check('PnlStatusCard badge label is Combined Unavailable', pnlCardSrc.includes("unavailable: 'Combined Unavailable'"))
  check('chain Partial reason is the exact required copy', vm.pnlEvidenceView.chainPnlRows.find((r) => r.chain === 'base')?.reason === CHAIN_PNL_PARTIAL_REASON)
}

console.log('\nSection 7: Holdings tab and summary total match the same portfolio value model')
{
  check('summary row builds the shared scanner view model', summarySrc.includes('buildWalletScannerViewModel('))
  check('summary row logs walletScannerViewAudit', summarySrc.includes("console.log('[wallet-scanner] walletScannerViewAudit'"))
  check('holdings tab still reads merged pricedHoldings/chainValueUsd', fs.readFileSync(new URL('../app/frontend/components/WalletScannerTabsV3.tsx', import.meta.url), 'utf8').includes('pricedHoldings={merged.pricedHoldings}'))
  check('watchlist save still posts merged portfolio USD, not PnL', pageSrc.includes('portfolio_value: watchlistPortfolioValueUsd(result, robinhoodResult)'))
  check('watchlist sidebar labels the figure as Portfolio, not PnL', pageSrc.includes('Portfolio ${fmtUSD(wallet.portfolio_value)}') || pageSrc.includes('`Portfolio ${fmtUSD(wallet.portfolio_value)}`'))
  check('green trending icon is gated on combined verified, never on a raw 0', pnlCardSrc.includes("pnlViewModel.combinedStatus === 'verified' && displayed.realizedPnlUsd != null"))
}

console.log('\nSection 8: verified realized 0 is still allowed to display')
{
  const vm = buildWalletPnlViewModel({
    pnlV2: {
      realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [{ totalCostUsd: 100 }],
      chainBreakdown: [{ chainId: 8453, realizedPnlUsd: 0, unrealizedPnlUsd: 0 }],
    },
    publicPnlStatus: 'ok',
    unrealizedReconciliation: {
      officialUnrealizedPnlUsd: 0, reconciliationStatus: 'ok', unrealizedCoveragePercent: 100,
      totalOpenPositions: 0, reconciledOpenPositions: 0, excludedOpenPositions: 0,
      deadOrSpamPositionsCount: 0, excludedCandidateMarketValueUsd: 0, excludedClassificationCounts: {},
      openPositionCoveragePercent: 100,
    },
    chainsScanned: ['base'],
  })
  const base = vm.chainRows.find((r) => r.chain === 'base')
  check('verified combined 0 shows $0.00', vm.combinedRealizedBox.status === 'Verified' && vm.combinedRealizedBox.value === '$0.00')
  check('verified Base 0 shows $0.00', base?.status === 'Verified' && base?.value === '$0.00')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
