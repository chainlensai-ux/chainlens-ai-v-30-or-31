// CANONICAL WALLET SCAN ORCHESTRATOR, DISCLOSED (Wallet Scanner unification task).
//
// This is the ONE place every UI entry point (Wallet Scanner page scan/deep scan, Clark `/wallet`
// command, Clark "deep scan it", dashboard prompt chips, watchlist wallet scan, sidebar/right-panel
// wallet actions) should call to run a wallet scan and get back one canonical result shape.
//
// It does NOT reimplement any scan logic. It is a plain in-process TS function (never a new
// `app/api/...` route) that:
//   - resolves a caller-facing `chainMode` into a real EVM chain list + a real Robinhood
//     include/exclude decision,
//   - calls the SAME existing engine entry points every other caller already uses:
//       * EVM preview: `runV2Scan()` from lib/server/v2Adapters.ts (the exact function the async
//         job worker and Clark's v2Adapters already call — itself a thin wrapper over the real
//         engine, src/pipeline/runWalletScanV2.ts's `runWalletScanV2()`),
//       * EVM deep: `enqueueWalletScanJob()` from src/modules/walletScanQueue.ts (the exact queue
//         app/api/wallet-scan/route.ts already uses — a real async job, polled via the existing,
//         unmodified `/api/wallet-scan/[jobId]` route),
//       * Robinhood: `scanRobinhoodWallet()` from lib/server/robinhoodWalletScanner.ts (the exact
//         call sequence app/api/wallet-scan/robinhood/route.ts already runs), gated on the same
//         `isRobinhoodChainAvailable()` env-gate every other Robinhood call site already uses.
//   - never fakes a faster result: deep mode always reports an honest queued/processing status for
//     the EVM side (there is no synchronous "deep" engine call to make), never a fabricated
//     "complete" result.
//   - never fabricates BNB: `chainMode: 'bnb'` resolves to zero EVM chains (V2's SupportedChain type
//     has no 'bnb' member anywhere in the pipeline — confirmed before writing this file) and is
//     reported as unsupported via `missingEvidence`/`nextActions`, never silently substituted.
//   - never leaks raw internal fields unless the caller explicitly passes `debug: true`.
//
// Callers are assumed to have already authorized the request (plan gate + rate limit) — exactly
// like `runV2Scan()`/`projectWalletV2ForClark()` themselves carry no auth logic. This file adds
// none either.

import { DEFAULT_CHAINS, runV2Scan } from '@/lib/server/v2Adapters'
export { DEFAULT_CHAINS }
import type { RunWalletScanV2Result } from '@/src/pipeline/runWalletScanV2'
import { scanRobinhoodWallet, formatRobinhoodPnlMessage } from '@/lib/server/robinhoodWalletScanner'
import type { RobinhoodWalletScannerAudit } from '@/lib/server/robinhoodWalletScanner'
import { isRobinhoodChainAvailable } from '@/lib/server/robinhoodChainConfig'
import { enqueueWalletScanJob, readWalletScanJob, readWalletScanResult } from '@/src/modules/walletScanQueue'
import { getTokenCache, setTokenCache } from '@/lib/server/cache/tokenCache'
import { buildWalletChainSelectionAudit, type WalletChainSelectionAudit } from '@/lib/server/walletChainSelectionAudit'
import { computeMergedTotalValueUsd, deriveCanonicalMergeOverride } from '@/app/frontend/lib/mergedWalletView'
import {
  WALLET_SCANNER_EVM_CHAINS,
  selectEvmPnlLaneStatus,
  selectRobinhoodPnlLaneStatus,
  robinhoodCompactProof,
  toRobinhoodWalletScanResponse,
  type EvmPnlLaneStatus,
  type RobinhoodPnlLaneStatus,
  type RobinhoodPnlCompactProof,
  type RobinhoodWalletScanResponse,
} from '@/lib/walletScan/canonicalWalletSelectors'

export type ChainMode = 'auto' | 'all_supported' | 'base' | 'ethereum' | 'bnb' | 'robinhood'
export type ScanDepth = 'preview' | 'deep'

export type WalletScanEvidenceSource = 'v2_pipeline' | 'robinhood_chain' | 'async_job_queue'

export type CanonicalWalletScanResult = {
  wallet: string
  chainsScanned: string[]
  totalValueUsd: number | null
  holdings: Array<{ chain: string; symbol: string; valueUsd: number | null }>
  activitySummary: { uniqueTransactions: number | null; note: string | null }
  pnlStatus: 'available' | 'partial' | 'unavailable' | 'unsupported'
  realizedPnlUsd?: number | null
  unrealizedPnlUsd?: number | null
  pricingCoverage: 'ok' | 'partial' | 'unknown'
  verifiedSwapCount: number | null
  skippedSwapLogs: number | null
  evidenceSources: WalletScanEvidenceSource[]
  missingEvidence: string[]
  nextActions: string[]
  scanMode: ScanDepth
  scanId: string
  // Lane statuses — the SAME selectors the Wallet Scanner page / CORTEX use. Never a blended
  // Base/ETH+Robinhood PnL label.
  evmPnlLaneStatus: EvmPnlLaneStatus
  robinhoodPnlLaneStatus: RobinhoodPnlLaneStatus
  robinhoodPnlProof: RobinhoodPnlCompactProof | null
  robinhoodIncluded: boolean
  pricedHoldingsCount: number
  unpricedHoldingsCount: number
  scannedAt: number
  usedMergedTotalSelector: boolean
  usedPnlLaneSelectors: boolean
  usedCanonicalWalletScan: boolean
  usedCachedCanonicalResult: boolean
  lastActive: string | null
  verifiedCoveragePercent: number | null
  openPositionCoveragePercent: number | null
  // Job status for the deep/async EVM path — present whenever a deep scan enqueued a real job the
  // caller can poll via the existing, unmodified /api/wallet-scan/[jobId] route.
  jobStatus?: 'queued' | 'unavailable' | 'done'
  jobId?: string
  // Only populated when the caller explicitly passed debug: true — never a spread of the raw
  // FinalReport (src/modules/finalReportAssembler/types.ts), which carries internal provider
  // diagnostics dumps this canonical shape must never leak by default.
  debug?: {
    evmReport: RunWalletScanV2Result | null
    robinhoodAudit: RobinhoodWalletScannerAudit | null
  }
  // NEW, additive, DISCLOSED: the canonical chain-selection audit — requested/allowed/omitted
  // chains (including Robinhood's numeric chain id, 4663) plus the real env flags this decision
  // was made from. Always present (same tier as evidenceSources/missingEvidence above), never
  // gated behind debug.
  walletChainSelectionAudit: WalletChainSelectionAudit
}

export type RunWalletScanParams = {
  walletAddress: string
  chainMode: ChainMode
  scanDepth: ScanDepth
  source: string
  debug?: boolean
}

const ORCHESTRATOR_CACHE_VERSION = 'v2'
const ORCHESTRATOR_PREVIEW_CACHE_TTL_SECONDS = 45

function orchestratorCacheKey(walletAddress: string, chainMode: ChainMode, scanDepth: ScanDepth): string {
  return `wsorch:${ORCHESTRATOR_CACHE_VERSION}:${walletAddress.toLowerCase()}:${chainMode}:${scanDepth}`
}

type ResolvedChains = { evmChains: string[]; includeRobinhood: boolean; robinhoodAvailable: boolean }

// Chain resolution, DISCLOSED: this is the single place chainMode → real chain list is decided.
// 'bnb' always resolves to zero EVM chains — there is no real BNB support anywhere in the V2
// pipeline (SupportedChain = 'base' | 'eth' | 'arbitrum' | 'hyperevm', confirmed before writing this
// file) — never silently substituted for another chain.
function resolveChains(chainMode: ChainMode): ResolvedChains {
  const robinhoodAvailable = isRobinhoodChainAvailable()
  switch (chainMode) {
    case 'base':
      return { evmChains: ['base'], includeRobinhood: false, robinhoodAvailable }
    case 'ethereum':
      return { evmChains: ['eth'], includeRobinhood: false, robinhoodAvailable }
    case 'bnb':
      return { evmChains: [], includeRobinhood: false, robinhoodAvailable }
    case 'robinhood':
      // Robinhood is REQUESTED regardless of the gate's result — if the gate is off, that is
      // reported honestly via missingEvidence/nextActions below, never silently dropped.
      return { evmChains: [], includeRobinhood: true, robinhoodAvailable }
    case 'auto':
    case 'all_supported':
    default:
      // WALLET SCANNER PAGE PARITY, DISCLOSED: Clark /wallet and the Wallet Scanner page must
      // request the same EVM set (Base + ETH). DEFAULT_CHAINS still includes arbitrum for
      // /api/portfolio via v2Adapters — Clark must not list Arbitrum unless it was actually
      // scanned, and the page never requests it.
      return { evmChains: [...WALLET_SCANNER_EVM_CHAINS], includeRobinhood: robinhoodAvailable, robinhoodAvailable }
  }
}

function evmChainLabel(chain: string): string {
  if (chain === 'eth') return 'ethereum'
  return chain
}

// Real derivation of a canonical pnlStatus/realized/unrealized/coverage view from the same
// RunWalletScanV2Result fields projectWalletV2ForClark() (lib/server/v2Adapters.ts) already reads —
// no new PnL/FIFO computation, purely a read of already-computed report fields.
function summarizeEvmReport(report: RunWalletScanV2Result): {
  holdings: CanonicalWalletScanResult['holdings']
  totalValueUsd: number | null
  uniqueTransactions: number
  pnlStatus: CanonicalWalletScanResult['pnlStatus']
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  pricingCoverage: CanonicalWalletScanResult['pricingCoverage']
  verifiedSwapCount: number
  chainsScanned: string[]
} {
  const reconciliation = report.reconciliationSummary
  const publishedLots = reconciliation?.publishedMatchedLots ?? report.canonicalPricedFifo.matchedLots
  const pnlStatus: CanonicalWalletScanResult['pnlStatus'] =
    (reconciliation?.publicPnlStatus ?? (report.canonicalPricedFifo.publicPnlStatus === 'ok' ? 'available' : report.canonicalPricedFifo.publicPnlStatus === 'limited_verified_sample' ? 'partial' : 'unavailable'))
  const realizedPnlUsd = reconciliation?.realizedPnlUsd ?? report.canonicalPricedFifo.realizedPnlUsd
  const buys = report.timelines.buyTimeline.entries
  const sells = report.timelines.sellTimelineV2.entries
  const uniqueTransactions = new Set([...buys.map((row) => row.txHash), ...sells.map((row) => row.txHash)]).size
  const verifiedSwapCount = publishedLots.length
  const pricingCoverage: CanonicalWalletScanResult['pricingCoverage'] =
    report.portfolio.tokens.length === 0 ? 'unknown' : report.portfolio.tokens.every((t) => t.valueUsd != null) ? 'ok' : 'partial'
  return {
    holdings: report.portfolio.tokens.map((t) => ({ chain: t.chain, symbol: t.symbol, valueUsd: t.valueUsd })),
    totalValueUsd: report.portfolio.totalValueUsd,
    uniqueTransactions,
    pnlStatus,
    realizedPnlUsd: pnlStatus === 'available' ? realizedPnlUsd : null,
    unrealizedPnlUsd: report.canonicalPricedFifo.unrealizedPnlUsd ?? null,
    pricingCoverage,
    verifiedSwapCount,
    chainsScanned: report.scanMetadata.chainsScanned,
  }
}

async function readOrchestratorCache(cacheKey: string, expectedChains: string[]): Promise<CanonicalWalletScanResult | null> {
  const cached = await getTokenCache<{ result: CanonicalWalletScanResult; resolvedChains: string[] }>(cacheKey).catch(() => null)
  if (!cached) return null
  // WRONG-CHAIN CACHE REJECTION, DISCLOSED: mirrors robinhoodWalletScanner.ts's own
  // rejectWrongChainRobinhoodCache philosophy — if the chains this chainMode resolves to right now
  // don't match what's recorded in the cached entry, the cache is rejected rather than serving
  // stale/wrong-chain data.
  const sameChains =
    cached.resolvedChains.length === expectedChains.length &&
    cached.resolvedChains.every((c, i) => c === expectedChains[i])
  if (!sameChains) return null
  return cached.result
}

async function writeOrchestratorCache(cacheKey: string, result: CanonicalWalletScanResult, resolvedChains: string[]): Promise<void> {
  await setTokenCache(cacheKey, { result, resolvedChains }, ORCHESTRATOR_PREVIEW_CACHE_TTL_SECONDS).catch(() => {})
}

export async function runWalletScan(params: RunWalletScanParams): Promise<CanonicalWalletScanResult> {
  const walletAddress = params.walletAddress
  const { evmChains, includeRobinhood, robinhoodAvailable } = resolveChains(params.chainMode)
  const cacheKey = orchestratorCacheKey(walletAddress, params.chainMode, params.scanDepth)

  if (params.scanDepth === 'preview') {
    const cached = await readOrchestratorCache(cacheKey, evmChains).catch(() => null)
    if (cached) {
      const hit: CanonicalWalletScanResult = { ...cached, usedCachedCanonicalResult: true }
      return params.debug ? hit : stripDebug(hit)
    }
  }

  const evidenceSources: WalletScanEvidenceSource[] = []
  const missingEvidence: string[] = []
  const nextActions: string[] = []

  let holdings: CanonicalWalletScanResult['holdings'] = []
  let evmTotalValueUsd: number | null = null
  let uniqueTransactions: number | null = null
  let pnlStatus: CanonicalWalletScanResult['pnlStatus'] = 'unavailable'
  let realizedPnlUsd: number | null | undefined
  let unrealizedPnlUsd: number | null | undefined
  let pricingCoverage: CanonicalWalletScanResult['pricingCoverage'] = 'unknown'
  let verifiedSwapCount: number | null = null
  let skippedSwapLogs: number | null = null
  let evmReport: RunWalletScanV2Result | null = null
  let robinhoodAudit: RobinhoodWalletScannerAudit | null = null
  let robinhoodResponse: RobinhoodWalletScanResponse | null = null
  let jobStatus: CanonicalWalletScanResult['jobStatus'] | undefined
  let jobId: string | undefined
  let lastActive: string | null = null
  let verifiedCoveragePercent: number | null = null
  let openPositionCoveragePercent: number | null = null
  let canonicalOverride: ReturnType<typeof deriveCanonicalMergeOverride> = null

  if (params.chainMode === 'bnb') {
    missingEvidence.push('BNB chain is not supported by the Wallet Scanner engine.')
    nextActions.push('Scan this wallet on Base, Ethereum, or Robinhood Chain instead.')
  }

  const rhPromise = (includeRobinhood && robinhoodAvailable)
    ? scanRobinhoodWallet(walletAddress, fetch).catch((err) => {
        console.warn('[walletScanOrchestrator] scanRobinhoodWallet failed', {
          walletAddress,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      })
    : Promise.resolve(null)

  // Preview EVM always runs for holdings/total — same runV2Scan the Wallet Scanner's fast path
  // uses, with the SAME chain list the Wallet Scanner page requests (Base + ETH). Deep mode
  // ALSO enqueues the page's Deep Scan job (includeRobinhoodRequested) and overlays EVM PnL
  // if the job finishes before the Clark timeout window.
  if (evmChains.length > 0) {
    evmReport = await runV2Scan(walletAddress, `orchestrator_${params.scanDepth}:${params.source}`, evmChains)
    if (evmReport) {
      evidenceSources.push('v2_pipeline')
      const summary = summarizeEvmReport(evmReport)
      holdings = holdings.concat(filterHoldingsToRequestedChains(summary.holdings, evmChains))
      evmTotalValueUsd = summary.totalValueUsd
      uniqueTransactions = (uniqueTransactions ?? 0) + summary.uniqueTransactions
      pnlStatus = summary.pnlStatus
      realizedPnlUsd = summary.realizedPnlUsd
      unrealizedPnlUsd = summary.unrealizedPnlUsd
      pricingCoverage = summary.pricingCoverage
      verifiedSwapCount = summary.verifiedSwapCount
    } else {
      missingEvidence.push(`EVM scan (${evmChains.map(evmChainLabel).join(', ')}) is temporarily unavailable.`)
      nextActions.push('Retry the scan shortly.')
    }
  }

  if (params.scanDepth === 'deep' && evmChains.length > 0) {
    jobId = crypto.randomUUID()
    try {
      await enqueueWalletScanJob(jobId, {
        jobId,
        walletAddress,
        chains: evmChains,
        scanMode: 'deep',
        ip: 'unknown',
        includeRobinhoodRequested: includeRobinhood,
      })
      evidenceSources.push('async_job_queue')
      jobStatus = 'queued'
      const worker = await pollDeepWalletScanJob(jobId, DEEP_POLL_TIMEOUT_MS)
      if (worker) {
        jobStatus = 'done'
        overlayWorkerEvmPnl(worker, {
          setPnlStatus: (s) => { pnlStatus = s },
          setRealized: (v) => { realizedPnlUsd = v },
          setUnrealized: (v) => { unrealizedPnlUsd = v },
          setVerified: (v) => { verifiedSwapCount = v },
          setCoverage: (v) => { verifiedCoveragePercent = v },
          setOpenCoverage: (v) => { openPositionCoveragePercent = v },
          setOverride: (v) => { canonicalOverride = v },
          setEvmReport: (r) => { if (r) evmReport = r },
        })
      } else {
        nextActions.push('Open Wallet Scanner to wait for the full Deep Scan PnL result.')
      }
    } catch (err) {
      jobStatus = 'unavailable'
      missingEvidence.push('Deep scan queue is temporarily unavailable.')
      nextActions.push('Retry the deep scan shortly.')
      console.warn('[walletScanOrchestrator] enqueueWalletScanJob failed', {
        walletAddress,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (params.chainMode === 'robinhood' && !robinhoodAvailable) {
    missingEvidence.push('Robinhood Chain scanning is currently disabled.')
    nextActions.push('Try again once Robinhood Chain support is enabled.')
  } else if (includeRobinhood && robinhoodAvailable) {
    const rh = await rhPromise
    if (rh) {
      evidenceSources.push('robinhood_chain')
      robinhoodAudit = rh.audit
      robinhoodResponse = toRobinhoodWalletScanResponse(walletAddress, {
        holdings: {
          status: rh.holdings.status,
          native: rh.holdings.native
            ? { symbol: rh.holdings.native.symbol, uiBalance: rh.holdings.native.uiBalance, priceUsd: rh.holdings.native.priceUsd, valueUsd: rh.holdings.native.valueUsd }
            : null,
          holdings: rh.holdings.holdings.map((t) => ({
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            uiBalance: t.uiBalance,
            priceUsd: t.priceUsd,
            valueUsd: t.valueUsd,
            priceSource: t.priceSource,
          })),
          portfolioTotalUsd: rh.holdings.portfolioTotalUsd,
          unpricedTokenCount: rh.holdings.unpricedTokenCount,
          reason: rh.holdings.reason,
        },
        activity: {
          status: rh.activity.status,
          items: rh.activity.items.map((i) => ({
            txHash: i.txHash,
            blockTimestamp: i.blockTimestamp,
            kind: i.kind,
            direction: i.direction,
            counterparty: i.counterparty,
            tokenSymbol: i.tokenSymbol,
          })),
          skippedSwapLogs: rh.activity.skippedSwapLogs,
          verifiedSwapCount: rh.activity.verifiedSwapCount,
          blockscoutEvidence: rh.activity.blockscoutEvidence,
          reason: rh.activity.reason,
        },
        pnl: {
          status: rh.pnl.status,
          realizedPnlUsd: rh.pnl.realizedPnlUsd,
          matchedLotsCount: rh.pnl.matchedLotsCount,
          verifiedSwapCount: rh.pnl.verifiedSwapCount,
          reason: rh.pnl.reason,
        },
        audit: rh.audit as unknown as Record<string, unknown> & { chainId?: number },
        pnlVerificationAudit: rh.pnlVerificationAudit,
      })
      if (robinhoodResponse.pnl.message === robinhoodResponse.pnl.reason || !robinhoodResponse.pnl.message) {
        robinhoodResponse.pnl.message = formatRobinhoodPnlMessage(rh.pnl.status)
      }
      const rhHoldings = rh.holdings.native
        ? [{ chain: 'robinhood', symbol: rh.holdings.native.symbol, valueUsd: rh.holdings.native.valueUsd }]
        : []
      holdings = holdings.concat(rhHoldings, rh.holdings.holdings.map((t) => ({ chain: 'robinhood', symbol: t.symbol ?? t.address.slice(0, 8), valueUsd: t.valueUsd })))
      skippedSwapLogs = rh.audit.skippedSwapLogs
      verifiedSwapCount = (verifiedSwapCount ?? 0) + rh.pnl.verifiedSwapCount
      lastActive = lastActiveFromRobinhood(rh.activity.items)
      // HARD RULE: never promote Robinhood PnL into the EVM canonical pnlStatus. Lanes stay split.
    } else {
      missingEvidence.push('Robinhood Chain scan is temporarily unavailable.')
      nextActions.push('Retry the Robinhood Chain scan shortly.')
    }
  } else if (includeRobinhood && !robinhoodAvailable) {
    missingEvidence.push('Robinhood Chain scanning is currently disabled.')
  }

  const merged = computeMergedTotalValueUsd(evmTotalValueUsd, robinhoodResponse, canonicalOverride)
  const totalValueUsd = merged.totalValueUsd
  const pricedHoldingsCount = holdings.filter((h) => h.valueUsd != null).length
  const unpricedHoldingsCount = holdings.length - pricedHoldingsCount

  const evmPnlLaneStatus = selectEvmPnlLaneStatus({
    pnlV2: evmReport ? ((evmReport as unknown as { pnlV2?: Parameters<typeof selectEvmPnlLaneStatus>[0]['pnlV2'] }).pnlV2 ?? null) : null,
    publicPnlStatus: evmReport?.reconciliationSummary?.publicPnlStatus === 'available'
      ? 'ok'
      : evmReport?.reconciliationSummary?.publicPnlStatus === 'partial'
        ? 'limited_verified_sample'
        : evmReport?.canonicalPricedFifo?.publicPnlStatus === 'ok'
          ? 'ok'
          : evmReport?.canonicalPricedFifo?.publicPnlStatus === 'limited_verified_sample'
            ? 'limited_verified_sample'
            : evmReport ? 'unavailable' : null,
    unrealizedReconciliation: (evmReport as unknown as { fifoAndPnl?: { unrealizedReconciliation?: Parameters<typeof selectEvmPnlLaneStatus>[0]['unrealizedReconciliation'] } } | null)?.fifoAndPnl?.unrealizedReconciliation ?? null,
    reconciliationSummary: evmReport?.reconciliationSummary as Parameters<typeof selectEvmPnlLaneStatus>[0]['reconciliationSummary'],
    canonicalSampleManifestAudit: (evmReport as unknown as { canonicalSampleManifestAudit?: Parameters<typeof selectEvmPnlLaneStatus>[0]['canonicalSampleManifestAudit'] } | null)?.canonicalSampleManifestAudit ?? null,
  })
  const robinhoodPnlLaneStatus = selectRobinhoodPnlLaneStatus(robinhoodResponse)
  const robinhoodPnlProof = robinhoodCompactProof(robinhoodResponse)

  if (params.scanDepth === 'preview') {
    nextActions.push('Run Deep Scan Wallet')
  }
  nextActions.push('Explain PnL')
  nextActions.push('Open Wallet Scanner')

  // Requested chains only — never list Arbitrum (or any other chain) unless this scan asked for it.
  const chainsScanned = [
    ...evmChains,
    ...(robinhoodResponse ? ['robinhood'] : []),
  ]

  const walletChainSelectionAudit = buildWalletChainSelectionAudit({
    requestedMode: params.scanDepth,
    chainMode: params.chainMode,
    evmChainSlugs: evmChains,
    includeRobinhoodRequested: includeRobinhood,
    finalChainsScanned: chainsScanned,
  })
  console.log('[walletScanOrchestrator] walletChainSelectionAudit', walletChainSelectionAudit)

  const result: CanonicalWalletScanResult = {
    wallet: walletAddress,
    chainsScanned,
    totalValueUsd,
    holdings,
    activitySummary: {
      uniqueTransactions,
      note: evidenceSources.length === 0 ? 'No evidence sources returned data for this scan.' : null,
    },
    pnlStatus: evidenceSources.length === 0 ? 'unsupported' : pnlStatus,
    realizedPnlUsd,
    unrealizedPnlUsd,
    pricingCoverage,
    verifiedSwapCount,
    skippedSwapLogs,
    evidenceSources,
    missingEvidence,
    nextActions,
    scanMode: params.scanDepth,
    scanId: jobId ?? crypto.randomUUID(),
    evmPnlLaneStatus,
    robinhoodPnlLaneStatus,
    robinhoodPnlProof,
    robinhoodIncluded: merged.robinhoodIncluded,
    pricedHoldingsCount,
    unpricedHoldingsCount,
    scannedAt: Date.now(),
    usedMergedTotalSelector: true,
    usedPnlLaneSelectors: true,
    usedCanonicalWalletScan: true,
    usedCachedCanonicalResult: false,
    lastActive,
    verifiedCoveragePercent,
    openPositionCoveragePercent,
    ...(jobStatus ? { jobStatus, jobId } : {}),
    ...(params.debug ? { debug: { evmReport, robinhoodAudit } } : {}),
    walletChainSelectionAudit,
  }

  if (params.scanDepth === 'preview') {
    await writeOrchestratorCache(cacheKey, stripDebug(result), evmChains)
  }

  return result
}

const DEEP_POLL_INTERVAL_MS = 2_500
const DEEP_POLL_TIMEOUT_MS = 12_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollDeepWalletScanJob(jobId: string, timeoutMs: number): Promise<unknown | null> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await sleep(DEEP_POLL_INTERVAL_MS)
    const job = await readWalletScanJob(jobId).catch(() => null)
    if (!job) continue
    if (job.status === 'done') {
      return await readWalletScanResult(jobId).catch(() => null)
    }
    if (job.status === 'failed') return null
  }
  return null
}

function filterHoldingsToRequestedChains(
  rows: CanonicalWalletScanResult['holdings'],
  evmChains: string[],
): CanonicalWalletScanResult['holdings'] {
  const allowed = new Set(evmChains.map((c) => c === 'ethereum' ? 'eth' : c))
  return rows.filter((row) => allowed.has(row.chain === 'ethereum' ? 'eth' : row.chain))
}

function lastActiveFromRobinhood(items: Array<{ blockTimestamp: string | null }>): string | null {
  const timestamps = items.map((i) => i.blockTimestamp).filter((t): t is string => t != null)
  if (timestamps.length === 0) return null
  return timestamps.reduce((latest, t) => (new Date(t).getTime() > new Date(latest).getTime() ? t : latest))
}

function overlayWorkerEvmPnl(
  raw: unknown,
  setters: {
    setPnlStatus: (s: CanonicalWalletScanResult['pnlStatus']) => void
    setRealized: (v: number | null) => void
    setUnrealized: (v: number | null) => void
    setVerified: (v: number | null) => void
    setCoverage: (v: number | null) => void
    setOpenCoverage: (v: number | null) => void
    setOverride: (v: ReturnType<typeof deriveCanonicalMergeOverride>) => void
    setEvmReport: (r: RunWalletScanV2Result | null) => void
  },
): void {
  const envelope = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  const report = (envelope && (envelope.data && typeof envelope.data === 'object' ? envelope.data : envelope.result && typeof envelope.result === 'object' ? envelope.result : envelope)) as Record<string, unknown> | null
  if (!report) return
  if (report.canonicalTotalValueUsd !== undefined) {
    setters.setOverride(deriveCanonicalMergeOverride({
      canonicalTotalValueUsd: report.canonicalTotalValueUsd as number | null,
      finalCanonicalMergeAudit: (report.finalCanonicalMergeAudit as { robinhoodMerged: boolean } | null) ?? null,
    }))
  }
  const recon = report.reconciliationSummary as RunWalletScanV2Result['reconciliationSummary'] | undefined
  const fifo = report.canonicalPricedFifo as RunWalletScanV2Result['canonicalPricedFifo'] | undefined
  const publicStatus = recon?.publicPnlStatus ?? (fifo?.publicPnlStatus === 'ok' ? 'available' : fifo?.publicPnlStatus === 'limited_verified_sample' ? 'partial' : 'unavailable')
  if (publicStatus) setters.setPnlStatus(publicStatus)
  const realized = recon?.realizedPnlUsd ?? fifo?.realizedPnlUsd ?? null
  if (realized != null) setters.setRealized(realized)
  const unrealized = fifo?.unrealizedPnlUsd ?? null
  if (unrealized != null) setters.setUnrealized(unrealized)
  const lots = recon?.publishedMatchedLots ?? fifo?.matchedLots
  if (Array.isArray(lots)) setters.setVerified(lots.length)
  const openCov = (report.fifoAndPnl as { unrealizedReconciliation?: { openPositionCoveragePercent?: number | null } } | undefined)?.unrealizedReconciliation?.openPositionCoveragePercent
  if (typeof openCov === 'number') setters.setOpenCoverage(openCov)
  if (report.pnlV2 || report.canonicalPricedFifo) {
    setters.setEvmReport(report as unknown as RunWalletScanV2Result)
  }
}

function stripDebug(result: CanonicalWalletScanResult): CanonicalWalletScanResult {
  if (!result.debug) return result
  const rest: CanonicalWalletScanResult = { ...result }
  delete rest.debug
  return rest
}
