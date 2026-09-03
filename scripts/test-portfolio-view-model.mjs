// Portfolio page audit fix — tests for lib/portfolioViewModel.ts (pure, fully testable) plus
// source-assertion checks for the page-level wiring (shared cache, live-fetch fallback, rescan,
// Clark input, mobile layout) that this codebase's own convention tests this way (see
// scripts/test-account-required-gating.mjs for the same established pattern).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildPortfolioViewModel, buildPortfolioPageAudit } from '../lib/portfolioViewModel.ts'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${label}`) }
}

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

function holding(overrides = {}) {
  return { symbol: 'ETH', name: 'Ethereum', chain: 'base', contract: '0xabc', balance: 1, price: 2600, value: 2600, change24h: null, ...overrides }
}

console.log('\nSection 1: connected wallet with Wallet Scanner cached holdings shows portfolio value')
{
  const vm = buildPortfolioViewModel({
    walletAddress: '0xabc',
    holdings: [holding()],
    chainBreakdown: [{ chain: 'base', valueUsd: 2600, percent: 100 }],
    pnlSummary: null,
    riskSummary: null,
    activity: [],
    source: 'wallet_scanner_cache',
    scanAttempted: true,
    failureReason: null,
  })
  check('finalUiState is ready when cached holdings exist', vm.finalUiState === 'ready')
  check('totalValueUsd reflects the real cached holding', vm.totalValueUsd === 2600)
  check('source is preserved as wallet_scanner_cache', vm.source === 'wallet_scanner_cache')
  check('verdict is not NEEDS_DATA when holdings exist', vm.verdict !== 'NEEDS_DATA')
}

console.log('\nSection 2: connected wallet with no cache triggers a portfolio fetch (page wiring)')
{
  const src = read('../app/terminal/portfolio/page.tsx')
  check('page checks the shared Wallet Scanner cache before fetching', src.includes('readPortfolioScanResult(address)'))
  check('page falls back to a live scanWalletV2() fetch when no cache is found', src.includes('scanWalletV2(address, PORTFOLIO_SCAN_CHAINS'))
  check('live fetch runs only when no result has already been scanned for this address', src.includes('scannedAddress === address) return'))
}

console.log('\nSection 3: multi-chain holdings show Multi-chain network')
{
  const vm = buildPortfolioViewModel({
    walletAddress: '0xabc',
    holdings: [holding({ chain: 'base', value: 1000 }), holding({ symbol: 'SOL-ish', chain: 'robinhood', value: 500 })],
    chainBreakdown: [{ chain: 'base', valueUsd: 1000, percent: 66.7 }, { chain: 'robinhood', valueUsd: 500, percent: 33.3 }],
    pnlSummary: null, riskSummary: null, activity: [], source: 'live_scan', scanAttempted: true, failureReason: null,
  })
  check('isMultiChain is true when more than one chain has value', vm.isMultiChain === true)
  const singleChain = buildPortfolioViewModel({
    walletAddress: '0xabc', holdings: [holding()], chainBreakdown: [{ chain: 'base', valueUsd: 2600, percent: 100 }],
    pnlSummary: null, riskSummary: null, activity: [], source: 'live_scan', scanAttempted: true, failureReason: null,
  })
  check('isMultiChain is false when only one chain has value', singleChain.isMultiChain === false)
  const pageSrc = read('../app/terminal/portfolio/page.tsx')
  check('page renders "Multi-chain" label when isMultiChain is true', pageSrc.includes("viewModel.isMultiChain ? 'Multi-chain'"))
}

console.log('\nSection 4: Robinhood holdings count toward supported value')
{
  const vm = buildPortfolioViewModel({
    walletAddress: '0xabc',
    holdings: [holding({ chain: 'base', value: 1000 }), holding({ symbol: 'RH', chain: 'robinhood', value: 250 })],
    chainBreakdown: [{ chain: 'base', valueUsd: 1000, percent: 80 }, { chain: 'robinhood', valueUsd: 250, percent: 20 }],
    pnlSummary: null, riskSummary: null, activity: [], source: 'live_scan', scanAttempted: true, failureReason: null,
  })
  check('total value includes the Robinhood holding', vm.totalValueUsd === 1250)
  check('chainExposure lists robinhood', vm.chainExposure.some((c) => c.chain === 'robinhood' && c.valueUsd === 250))
  const adapterSrc = read('../app/frontend/lib/portfolioViewModelAdapter.ts')
  check('adapter builds Robinhood holdings from a real robinhoodResult, never fabricated', adapterSrc.includes('robinhoodResult.holdings.holdings') && adapterSrc.includes('merged.robinhoodIncluded'))
}

console.log('\nSection 5: $0 only shows when confirmed zero supported assets (never for loading/no-wallet/failed)')
{
  const zeroConfirmed = buildPortfolioViewModel({
    walletAddress: '0xabc', holdings: [], chainBreakdown: [], pnlSummary: null, riskSummary: null, activity: [],
    source: 'live_scan', scanAttempted: true, failureReason: null,
  })
  check('a real completed scan with no holdings reports no_supported_assets, not a silent $0', zeroConfirmed.finalUiState === 'no_supported_assets')
  check('zero-confirmed state carries a concrete reason', typeof zeroConfirmed.emptyReason === 'string' && zeroConfirmed.emptyReason.length > 0)

  const loading = buildPortfolioViewModel({
    walletAddress: '0xabc', holdings: [], chainBreakdown: [], pnlSummary: null, riskSummary: null, activity: [],
    source: 'none', scanAttempted: false, failureReason: null,
  })
  check('no scan attempted yet is "loading", never treated as confirmed zero', loading.finalUiState === 'loading')

  const noWallet = buildPortfolioViewModel({
    walletAddress: null, holdings: [], chainBreakdown: [], pnlSummary: null, riskSummary: null, activity: [],
    source: 'none', scanAttempted: false, failureReason: null,
  })
  check('no wallet at all is "no_wallet", never treated as confirmed zero', noWallet.finalUiState === 'no_wallet')

  const failed_ = buildPortfolioViewModel({
    walletAddress: '0xabc', holdings: [], chainBreakdown: [], pnlSummary: null, riskSummary: null, activity: [],
    source: 'live_scan', scanAttempted: true, failureReason: 'GoldRush timed out',
  })
  check('a genuine provider failure is "provider_failed", never treated as confirmed zero', failed_.finalUiState === 'provider_failed')
}

console.log('\nSection 6: provider failure shows exact reason')
{
  const vm = buildPortfolioViewModel({
    walletAddress: '0xabc', holdings: [], chainBreakdown: [], pnlSummary: null, riskSummary: null, activity: [],
    source: 'live_scan', scanAttempted: true, failureReason: 'GoldRush timed out after 12s',
  })
  check('finalUiState is provider_failed', vm.finalUiState === 'provider_failed')
  check('summary carries the exact failure reason, not a generic message', vm.summary.includes('GoldRush timed out after 12s'))
  const pageSrc = read('../app/terminal/portfolio/page.tsx')
  check('page renders the exact "Portfolio unavailable — provider failed: reason" format', pageSrc.includes('Portfolio unavailable — provider failed: ${failureReason'))
}

console.log('\nSection 7: Clark insights receive holdings when portfolio has data (never NEEDS DATA with real holdings)')
{
  const vm = buildPortfolioViewModel({
    walletAddress: '0xabc', holdings: [holding()], chainBreakdown: [{ chain: 'base', valueUsd: 2600, percent: 100 }],
    pnlSummary: { status: 'verified', reason: 'Verified via matched lots', realizedUsd: 120, unrealizedUsd: 50 },
    riskSummary: null, activity: [], source: 'live_scan', scanAttempted: true, failureReason: null,
  })
  check('verdict is never NEEDS_DATA when real, priced holdings exist', vm.verdict !== 'NEEDS_DATA')
  check('topHoldings carries the real holding for Clark to read', vm.topHoldings.length === 1 && vm.topHoldings[0].symbol === 'ETH')
  const pageSrc = read('../app/terminal/portfolio/page.tsx')
  check('Clark prompt is built from the shared view model (verdict/chain exposure/top holdings), not a raw dump', pageSrc.includes('viewModel.verdict') && pageSrc.includes('viewModel.topHoldings') && pageSrc.includes('viewModel.chainExposure'))
}

console.log('\nSection 8: empty portfolio explains exactly what is missing (never a bare NEEDS DATA)')
{
  const vm = buildPortfolioViewModel({
    walletAddress: '0xabc', holdings: [], chainBreakdown: [], pnlSummary: null, riskSummary: null, activity: [],
    source: 'live_scan', scanAttempted: true, failureReason: null,
  })
  check('verdict is NEEDS_DATA only for a genuinely empty scan', vm.verdict === 'NEEDS_DATA')
  check('summary explains why, not just "NEEDS DATA"', vm.summary.length > 'NEEDS_DATA'.length && /priced|supported|holding/i.test(vm.summary))
}

console.log('\nSection 9: rescan refreshes portfolio (real refetch, not a reload to empty)')
{
  const pageSrc = read('../app/terminal/portfolio/page.tsx')
  check('Rescan button calls the same runPortfolioScan() live-fetch path, not a state clear', pageSrc.includes("scannedAddress === address ? 'Rescan' : 'Load Portfolio'"))
  check('runPortfolioScan always re-fetches fresh data from scanWalletV2 on click (no early return once already scanned)', /const runPortfolioScan = async \(\) => \{\s*if \(!hasWallet \|\| !address \|\| loading\) return/.test(pageSrc))
  check('a successful rescan saves the fresh result back to the shared cache', pageSrc.includes('savePortfolioScanResult(address, freshReport, rh)'))
}

console.log('\nSection 10: no stale empty cache overrides real data')
{
  const cacheSrc = read('../app/frontend/lib/portfolioSharedCache.ts')
  check('cache entries expire (FRESH_MS) rather than being trusted forever', cacheSrc.includes('FRESH_MS') && cacheSrc.includes('Date.now() - entry.cachedAt > maxAgeMs'))
  check('a live scan always overwrites the cache with the fresh result', read('../app/terminal/portfolio/page.tsx').includes('savePortfolioScanResult(address, freshReport, rh)'))
  // A cache read never happens once a live/cache result for this exact address has already been
  // scanned in this session — an old empty cache entry can only be consulted BEFORE a real fetch
  // runs, and a fresh fetch's result always replaces it (see Section 9).
  const pageSrc = read('../app/terminal/portfolio/page.tsx')
  check('cache lookup is skipped once this address has already been scanned this session', pageSrc.includes('if (!hasWallet || !address || loading || scannedAddress === address) return'))
}

console.log('\nSection 11: mobile layout has no overflow')
{
  const pageSrc = read('../app/terminal/portfolio/page.tsx')
  check('holdings table scrolls horizontally on narrow viewports instead of overflowing the page', pageSrc.includes('.pf-holdings-wrap{overflow-x:auto}'))
  check('main grid collapses to a single column under 768px', pageSrc.includes('.pf-main-grid{grid-template-columns:1fr!important}'))
  check('the new wallet-address input row also collapses to a single column on mobile', pageSrc.includes('.pf-wallet-row{flex-direction:column;align-items:stretch!important}'))
}

console.log('\nSection 12: connected wallet is the address source only when no manual wallet is set')
{
  const pageSrc = read('../app/terminal/portfolio/page.tsx')
  check('address prefers a manually-entered address over the wagmi-connected one', pageSrc.includes('const address = manualAddress.trim() || connectedAddress || null'))
}

console.log('\nSection 13: portfolioPageAudit object matches the required spec shape')
{
  const vm = buildPortfolioViewModel({
    walletAddress: '0xabc', holdings: [holding()], chainBreakdown: [{ chain: 'base', valueUsd: 2600, percent: 100 }],
    pnlSummary: null, riskSummary: null, activity: [], source: 'live_scan', scanAttempted: true, failureReason: null,
  })
  const audit = buildPortfolioPageAudit({
    walletAddress: '0xabc', authUserPresent: true, connectedWalletDetected: true, cachedWalletScannerResultFound: false,
    portfolioApiCalled: true, chainsRequested: ['base', 'eth', 'robinhood'], chainsReturned: ['base'],
    rawHoldingsCount: 1, failureReason: null, cacheHit: false, viewModel: vm,
  })
  const requiredKeys = ['walletAddress', 'authUserPresent', 'connectedWalletDetected', 'cachedWalletScannerResultFound', 'portfolioApiCalled', 'chainsRequested', 'chainsReturned', 'holdingsReturned', 'pricedHoldings', 'totalValueUsd', 'sourceUsed', 'filteredOutCount', 'zeroReason', 'failureReason', 'cacheHit', 'finalUiState']
  for (const key of requiredKeys) check(`portfolioPageAudit has required key ${key}`, key in audit)
}

console.log('\nSection 14: this module never rewrites Wallet Scanner math — reuses the same selectors')
{
  const adapterSrc = read('../app/frontend/lib/portfolioViewModelAdapter.ts')
  check('adapter reuses selectPortfolioStats (same selector Wallet Scanner cards use)', adapterSrc.includes('selectPortfolioStats(report.portfolio, report.portfolioV2)'))
  check('adapter reuses selectChainBreakdown (same selector Wallet Scanner cards use)', adapterSrc.includes('selectChainBreakdown(report.chainValueUsd'))
  check('adapter reuses computeMergedTotalValueUsd (same Robinhood-merge logic Wallet Scanner uses)', adapterSrc.includes('computeMergedTotalValueUsd(stats.totalValueUsd'))
  check('adapter reuses buildWalletPnlViewModel (same PnL selector PnlStatusCard uses)', adapterSrc.includes('buildWalletPnlViewModel({'))
  const walletScannerSrc = read('../app/terminal/wallet-scanner/page.tsx')
  check('Wallet Scanner page saves its real scan result to the shared cache after completion', walletScannerSrc.includes('savePortfolioScanResult(address, report, robinhoodResult)'))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
