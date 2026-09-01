// Clark /wallet must use the same canonical Wallet Scanner result as the Wallet Scanner page.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  formatCanonicalWalletRead,
  parseClarkSlashCommand,
  isDeepScanItFollowup,
} from '../lib/server/clarkRouting.ts'
import { computeMergedTotalValueUsd } from '../app/frontend/lib/mergedWalletView.ts'
import {
  selectEvmPnlLaneStatus,
  selectRobinhoodPnlLaneStatus,
  ROBINHOOD_PNL_NOT_VERIFIED_REASON,
  WALLET_SCANNER_EVM_CHAINS,
} from '../lib/walletScan/canonicalWalletSelectors.ts'
import { selectEvmPnlLaneStatus as selectEvmPnlLaneStatusFromCard, selectRobinhoodPnlLaneStatus as selectRobinhoodPnlLaneStatusFromCard } from '../app/frontend/components/PnlStatusCard.tsx'

const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const orchestratorSrc = readFileSync(new URL('../lib/server/walletScanOrchestrator.ts', import.meta.url), 'utf8')
const clarkSrc = readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routingSrc = readFileSync(new URL('../lib/server/clarkRouting.ts', import.meta.url), 'utf8')
const pageSrc = readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')
const walletScanRouteSrc = readFileSync(new URL('../app/api/wallet-scan/route.ts', import.meta.url), 'utf8')
const selectorsSrc = readFileSync(new URL('../lib/walletScan/canonicalWalletSelectors.ts', import.meta.url), 'utf8')
const v2AdaptersSrc = readFileSync(new URL('../lib/server/v2Adapters.ts', import.meta.url), 'utf8')

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const phase3Audit = {
  wallet: WALLET,
  chainId: 4663,
  source: 'robinhood_sidecar_phase3',
  status: 'verified',
  realizedPnlUsd: 27542.22,
  verifiedSwapCount: 4,
  decodedSwapCount: 4,
  swapsFedToFifo: 4,
  fifoClosedLots: 3,
  priceEvidenceBothLegsCount: 4,
  missingPriceEvidenceCount: 0,
  blockscoutFallbackUsed: false,
  goldrushUsed: true,
  alchemyRpcUsed: false,
  pnlEnabledReason: 'ok',
  pnlDisabledReason: null,
  rejectedReasonIfNotVerified: null,
}

const rhVerified = {
  ok: true,
  wallet: WALLET,
  chainSlug: 'robinhood',
  chainId: 4663,
  holdings: {
    status: 'ok',
    native: { symbol: 'ETH', uiBalance: 1, priceUsd: 3000, valueUsd: 3000 },
    holdings: [{ address: '0xabc', symbol: 'USDC', name: 'USD Coin', uiBalance: 11940, priceUsd: 1, valueUsd: 11940, priceSource: 'goldrush' }],
    portfolioTotalUsd: 14940,
    unpricedTokenCount: 0,
    reason: null,
  },
  activity: {
    status: 'ok',
    items: [],
    skippedSwapLogs: 0,
    verifiedSwapCount: 4,
    blockscoutEvidence: { blockscoutAttempted: false, blockscoutSucceeded: false, blockscoutFallbackUsed: false, blockscoutStatus: 'not_attempted', blockscoutError: null, blockscoutVerifiedSwap: false },
    reason: null,
  },
  pnl: { status: 'verified', message: 'Verified Robinhood PnL', realizedPnlUsd: 27542.22, matchedLotsCount: 3, verifiedSwapCount: 4, reason: null },
  robinhoodWalletScannerAudit: {},
  robinhoodPnlVerificationAudit: phase3Audit,
}

{
  check('/wallet slash is preview (not deep)', parseClarkSlashCommand(`/wallet ${WALLET}`)?.deep !== true)
  check('/wallet deep is deep', parseClarkSlashCommand(`/wallet deep ${WALLET}`)?.deep === true)
  check('/wallet 0x deep is deep', parseClarkSlashCommand(`/wallet ${WALLET} deep`)?.deep === true)
  check('/deep wallet is wallet_scan + deep', parseClarkSlashCommand(`/deep wallet ${WALLET}`)?.intent === 'wallet_scan' && parseClarkSlashCommand(`/deep wallet ${WALLET}`)?.deep === true)
  check('deep scan it is a wallet deep follow-up', isDeepScanItFollowup('deep scan it') === true)
  check('explain pnl is NOT a deep rescan', isDeepScanItFollowup('explain pnl') === false)
  check('wantsWalletDeepScan no longer treats bare pnl as deep', /function wantsWalletDeepScan\(prompt: string\): boolean \{[\s\S]{0,500}deep\\s\*scan/.test(clarkSrc) && !/function wantsWalletDeepScan\(prompt: string\): boolean \{\s*return \/\\b\(deep\\s\*scan\|full\\s\*\(\?:wallet\\s\*\)\?scan\|scan\\s\+all\\s\+chains\|deep\\b\|historical\|pnl/.test(clarkSrc))
}

{
  check('Wallet Scanner page Deep Scan requests base/eth/robinhood', pageSrc.includes("scanWalletV2(address, ['base', 'eth', 'robinhood'], mode"))
  check('orchestrator auto/all_supported uses WALLET_SCANNER_EVM_CHAINS (base+eth), not DEFAULT_CHAINS arbitrum', orchestratorSrc.includes('evmChains: [...WALLET_SCANNER_EVM_CHAINS]') && WALLET_SCANNER_EVM_CHAINS.join(',') === 'base,eth')
  check('v2Adapters DEFAULT_CHAINS still includes arbitrum for /api/portfolio', /export const DEFAULT_CHAINS = \['base', 'eth', 'arbitrum'\]/.test(v2AdaptersSrc))
  check('runV2Scan accepts an optional chain list so Clark can pass base+eth without changing the portfolio default', /export async function runV2Scan\(address: string, route: string, chains: string\[] = DEFAULT_CHAINS\)/.test(v2AdaptersSrc))
  check('orchestrator preview/deep EVM scan passes the resolved evmChains into runV2Scan', /runV2Scan\(walletAddress, `orchestrator_\$\{params\.scanDepth\}:\$\{params\.source\}`, evmChains\)/.test(orchestratorSrc))
  check('deep scan enqueues the SAME job as Wallet Scanner Deep Scan (scanMode deep + includeRobinhoodRequested)', /enqueueWalletScanJob\(jobId, \{[\s\S]*?scanMode: 'deep'[\s\S]*?includeRobinhoodRequested: includeRobinhood/.test(orchestratorSrc))
  check('wallet-scan route still enqueues includeRobinhoodRequested the same way', walletScanRouteSrc.includes('includeRobinhoodRequested'))
  check('deep scan it after /wallet still hits buildClarkWalletReadResponse with routed.deep', /deepScan: Boolean\(routed\.deep\)/.test(clarkSrc) && /if \(deepScanItOnWallet\) routed\.deep = true/.test(clarkSrc))
}

{
  const evmDust = 0.03
  const merged = computeMergedTotalValueUsd(evmDust, rhVerified)
  check('merged total includes priced Robinhood (the $0.03 vs $14.94K bug)', Math.abs(merged.totalValueUsd - 14940.03) < 0.001)
  check('orchestrator calls computeMergedTotalValueUsd — not EVM-only totalValueUsd', orchestratorSrc.includes('computeMergedTotalValueUsd(evmTotalValueUsd, robinhoodResponse'))
  check('orchestrator never promotes Robinhood PnL into canonical pnlStatus', !/pnlStatus = rh\.pnl\.status === 'verified' \? 'available'/.test(orchestratorSrc))
}

{
  const preview = formatCanonicalWalletRead(WALLET, {
    chainsScanned: ['base', 'eth', 'robinhood'],
    totalValueUsd: 14940.03,
    holdings: [
      { chain: 'robinhood', symbol: 'USDC', valueUsd: 11940 },
      { chain: 'base', symbol: 'AERO', valueUsd: 0.03 },
    ],
    activitySummary: { uniqueTransactions: 2, note: null },
    pnlStatus: 'unavailable',
    realizedPnlUsd: 27542.22,
    pricingCoverage: 'partial',
    evidenceSources: ['v2_pipeline', 'robinhood_chain'],
    missingEvidence: [],
    scanMode: 'preview',
    evmPnlLaneStatus: 'unavailable',
    robinhoodPnlLaneStatus: 'verified',
    robinhoodPnlProof: { source: 'Robinhood Phase 3 sidecar', verifiedSwapCount: 4, fifoClosedLots: 3, priceEvidenceBothLegs: true },
    pricedHoldingsCount: 2,
  })
  check('WALLET READ header', /^WALLET READ — 0xd8dA/.test(preview))
  check('Overview total uses merged value', preview.includes('Total supported value: $14,940.03'))
  check('chain list is Base, ETH, Robinhood — not raw slugs + arbitrum', preview.includes('Chains scanned: Base, ETH, Robinhood') && !/arbitrum/i.test(preview))
  check('priced/unpriced and activity in Overview', preview.includes('Priced tokens: 2') && preview.includes('Unpriced tokens: 0') && preview.includes('Unique transactions: 2'))
  check('Behavior label is present', preview.includes('Behavior') && preview.includes('Label:'))
  check('PnL Evidence section exists', preview.includes('PnL Evidence'))
  check('Base/ETH lane shown', preview.includes('Base/ETH: unavailable'))
  check('Robinhood verified compact proof', preview.includes('Robinhood PnL: Verified') && preview.includes('Source: Robinhood Phase 3 sidecar') && preview.includes('Verified swaps: 4') && preview.includes('Closed lots: 3') && preview.includes('Price evidence: both legs verified'))
  check('Next includes Deep Scan / Explain PnL / Open Wallet Scanner', preview.includes('Run Deep Scan Wallet') && preview.includes('Explain PnL') && preview.includes('Open Wallet Scanner'))
  check('does not list Arbitrum unless scanned', !/Arbitrum/i.test(preview))

  const notVerified = formatCanonicalWalletRead(WALLET, {
    chainsScanned: ['base', 'eth', 'robinhood'],
    totalValueUsd: 100,
    holdings: [{ chain: 'base', symbol: 'ETH', valueUsd: 100 }],
    activitySummary: { uniqueTransactions: 0, note: null },
    pnlStatus: 'unavailable',
    pricingCoverage: 'ok',
    evidenceSources: ['v2_pipeline', 'robinhood_chain'],
    missingEvidence: [],
    scanMode: 'preview',
    evmPnlLaneStatus: 'unavailable',
    robinhoodPnlLaneStatus: 'not_verified',
  })
  check('Robinhood not verified copy', notVerified.includes('Robinhood PnL: Not verified') && notVerified.includes(ROBINHOOD_PNL_NOT_VERIFIED_REASON))

  const deep = formatCanonicalWalletRead(WALLET, {
    chainsScanned: ['base', 'eth', 'robinhood'],
    totalValueUsd: 14940.03,
    holdings: [{ chain: 'robinhood', symbol: 'USDC', valueUsd: 11940 }],
    activitySummary: { uniqueTransactions: 8, note: null },
    pnlStatus: 'partial',
    realizedPnlUsd: 500,
    pricingCoverage: 'ok',
    evidenceSources: ['v2_pipeline', 'robinhood_chain', 'async_job_queue'],
    missingEvidence: [],
    scanMode: 'deep',
    jobStatus: 'queued',
    jobId: 'job-123',
    evmPnlLaneStatus: 'partial',
    robinhoodPnlLaneStatus: 'verified',
    robinhoodPnlProof: { source: 'Robinhood Phase 3 sidecar', verifiedSwapCount: 4, fifoClosedLots: 3, priceEvidenceBothLegs: true },
    verifiedSwapCount: 12,
    verifiedCoveragePercent: 40,
  })
  check('deep scan returns PnL Evidence section', deep.includes('PnL Evidence') && deep.includes('Base/ETH: partial'))
  check('deep scan does not claim a fake finished scan', !/is complete\b|scan finished|100%|fully scanned/i.test(deep))
}

{
  check('Clark and Wallet Scanner UI share selectEvmPnlLaneStatus', selectEvmPnlLaneStatus({ pnlV2: null }) === 'unavailable' && selectEvmPnlLaneStatusFromCard({ pnlV2: null }) === 'unavailable')
  check('Clark and Wallet Scanner UI share selectRobinhoodPnlLaneStatus', selectRobinhoodPnlLaneStatus(null) === 'unavailable' && selectRobinhoodPnlLaneStatusFromCard(null) === 'unavailable')
  check('Robinhood stays not verified without Phase 3 audit', selectRobinhoodPnlLaneStatus({ ok: true, pnl: { status: 'verified', realizedPnlUsd: 27542.22, verifiedSwapCount: 4 } }) === 'not_verified')
  check('Robinhood verified only with Phase 3 proof', selectRobinhoodPnlLaneStatus(rhVerified) === 'verified')
  check('PnlStatusCard EVM selector is a wrapper around the shared module', /export function selectEvmPnlLaneStatus\([\s\S]{0,400}return selectEvmPnlLaneStatusShared\(params\)/.test(readFileSync(new URL('../app/frontend/components/PnlStatusCard.tsx', import.meta.url), 'utf8')))
  check('RobinhoodChainSection selector is a wrapper around the shared module', /export function selectRobinhoodPnlLaneStatus\([\s\S]{0,250}return selectRobinhoodPnlLaneStatusShared\(/.test(readFileSync(new URL('../app/frontend/components/RobinhoodChainSection.tsx', import.meta.url), 'utf8')))
  check('CORTEX still calls the same lane selectors', pageSrc.includes('selectEvmPnlLaneStatus') && pageSrc.includes('selectRobinhoodPnlLaneStatus'))
}

{
  check('buildClarkWalletReadResponse is still the only /wallet engine', /const result = await runWalletScan\(\{/.test(clarkSrc))
  check('PnL follow-up refresh no longer calls getWalletFromV2/getWalletLite', !/await getWalletFromV2\(targetAddr\) \?\? await getWalletLite\(targetAddr\)/.test(clarkSrc))
  check('PnL follow-up refresh delegates to buildClarkWalletReadResponse', clarkSrc.includes('sourceRoute: "wallet_pnl_followup_refresh"'))
  check('clarkWalletReadAudit is logged and attached', clarkSrc.includes('clarkWalletReadAudit') && clarkSrc.includes('totalsMatch') && clarkSrc.includes('staleResultRejected') && clarkSrc.includes('canonicalTotalUsd'))
  check('stale lastWalletSubject cannot overwrite a newer scan', /existing\.timestamp > startedAt/.test(clarkSrc) && /staleResultRejected/.test(clarkSrc))
  check('explain pnl still does not trigger isDeepScanItFollowup', isDeepScanItFollowup('explain pnl') === false)
  check('deep scan it is not a token follow-up', clarkSrc.includes('Deep Scan only applies to wallets, not tokens') && clarkSrc.includes('lastSubjectIsToken'))
  check('deep scan it after a token asks instead of guessing the last wallet', /lastSubjectIsToken && lastWalletAddr/.test(clarkSrc))
}

console.log(`test-clark-canonical-wallet-read.mjs: all ${passed} assertions passed`)
