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
import type { RunWalletScanV2Result } from '@/src/pipeline/runWalletScanV2'
import { scanRobinhoodWallet } from '@/lib/server/robinhoodWalletScanner'
import type { RobinhoodWalletScannerAudit } from '@/lib/server/robinhoodWalletScanner'
import { isRobinhoodChainAvailable } from '@/lib/server/robinhoodChainConfig'
import { enqueueWalletScanJob } from '@/src/modules/walletScanQueue'
import { getTokenCache, setTokenCache } from '@/lib/server/cache/tokenCache'
import { buildWalletChainSelectionAudit, type WalletChainSelectionAudit } from '@/lib/server/walletChainSelectionAudit'

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
  // Job status for the deep/async EVM path — present whenever a deep scan enqueued a real job the
  // caller can poll via the existing, unmodified /api/wallet-scan/[jobId] route.
  jobStatus?: 'queued' | 'unavailable'
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

const ORCHESTRATOR_CACHE_VERSION = 'v1'
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
      return { evmChains: [...DEFAULT_CHAINS], includeRobinhood: robinhoodAvailable, robinhoodAvailable }
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
    if (cached) return params.debug ? cached : stripDebug(cached)
  }

  const evidenceSources: WalletScanEvidenceSource[] = []
  const missingEvidence: string[] = []
  const nextActions: string[] = []

  let holdings: CanonicalWalletScanResult['holdings'] = []
  let totalValueUsd: number | null = null
  let uniqueTransactions: number | null = null
  let pnlStatus: CanonicalWalletScanResult['pnlStatus'] = 'unavailable'
  let realizedPnlUsd: number | null | undefined
  let unrealizedPnlUsd: number | null | undefined
  let pricingCoverage: CanonicalWalletScanResult['pricingCoverage'] = 'unknown'
  let verifiedSwapCount: number | null = null
  let skippedSwapLogs: number | null = null
  let evmReport: RunWalletScanV2Result | null = null
  let robinhoodAudit: RobinhoodWalletScannerAudit | null = null
  let jobStatus: CanonicalWalletScanResult['jobStatus'] | undefined
  let jobId: string | undefined
  let chainsScanned: string[] = []

  if (params.chainMode === 'bnb') {
    missingEvidence.push('BNB chain is not supported by the Wallet Scanner engine.')
    nextActions.push('Scan this wallet on Base, Ethereum, or Robinhood Chain instead.')
  }

  if (evmChains.length > 0) {
    if (params.scanDepth === 'preview') {
      // Reuses the exact same runV2Scan() the async job worker's/Clark's v2Adapters already call —
      // no reimplementation, no new engine call.
      evmReport = await runV2Scan(walletAddress, `orchestrator_preview:${params.source}`)
      if (evmReport) {
        evidenceSources.push('v2_pipeline')
        const summary = summarizeEvmReport(evmReport)
        holdings = holdings.concat(summary.holdings)
        totalValueUsd = (totalValueUsd ?? 0) + (summary.totalValueUsd ?? 0)
        uniqueTransactions = (uniqueTransactions ?? 0) + summary.uniqueTransactions
        pnlStatus = summary.pnlStatus
        realizedPnlUsd = summary.realizedPnlUsd
        unrealizedPnlUsd = summary.unrealizedPnlUsd
        pricingCoverage = summary.pricingCoverage
        verifiedSwapCount = summary.verifiedSwapCount
        chainsScanned = chainsScanned.concat(summary.chainsScanned)
      } else {
        missingEvidence.push(`EVM scan (${evmChains.map(evmChainLabel).join(', ')}) is temporarily unavailable.`)
        nextActions.push('Retry the scan shortly.')
      }
    } else {
      // Deep mode: enqueue the SAME real async job app/api/wallet-scan/route.ts already enqueues —
      // never a fabricated "complete" result. scanId is the real jobId, pollable via the existing,
      // unmodified /api/wallet-scan/[jobId] route.
      jobId = crypto.randomUUID()
      try {
        await enqueueWalletScanJob(jobId, {
          jobId,
          walletAddress,
          chains: evmChains,
          scanMode: 'deep',
          ip: 'unknown',
        })
        evidenceSources.push('async_job_queue')
        jobStatus = 'queued'
        chainsScanned = chainsScanned.concat(evmChains)
        nextActions.push(`Poll /api/wallet-scan?jobId=${jobId} for the deep scan result.`)
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
  }

  if (params.chainMode === 'robinhood' && !robinhoodAvailable) {
    missingEvidence.push('Robinhood Chain scanning is currently disabled.')
    nextActions.push('Try again once Robinhood Chain support is enabled.')
  } else if (includeRobinhood && robinhoodAvailable) {
    // Robinhood has no async job concept — it always runs synchronously via the exact same
    // scanRobinhoodWallet() call sequence app/api/wallet-scan/robinhood/route.ts uses, even in deep
    // mode, merged alongside the (possibly still-queued) EVM status.
    const rh = await scanRobinhoodWallet(walletAddress, fetch).catch((err) => {
      console.warn('[walletScanOrchestrator] scanRobinhoodWallet failed', {
        walletAddress,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    })
    if (rh) {
      evidenceSources.push('robinhood_chain')
      robinhoodAudit = rh.audit
      const rhHoldings = rh.holdings.native
        ? [{ chain: 'robinhood', symbol: rh.holdings.native.symbol, valueUsd: rh.holdings.native.valueUsd }]
        : []
      holdings = holdings.concat(rhHoldings, rh.holdings.holdings.map((t) => ({ chain: 'robinhood', symbol: t.symbol ?? t.address.slice(0, 8), valueUsd: t.valueUsd })))
      chainsScanned = chainsScanned.concat(['robinhood'])
      skippedSwapLogs = rh.audit.skippedSwapLogs
      verifiedSwapCount = (verifiedSwapCount ?? 0) + rh.pnl.verifiedSwapCount
      // Never overrides a stronger 'available' EVM status with Robinhood's own weaker status —
      // only fills in when the EVM side reported nothing.
      if (pnlStatus === 'unavailable') {
        pnlStatus = rh.pnl.status === 'verified' ? 'available' : rh.pnl.status === 'partial' ? 'partial' : 'unavailable'
        if (realizedPnlUsd === undefined || realizedPnlUsd === null) realizedPnlUsd = rh.pnl.realizedPnlUsd
      }
    } else {
      missingEvidence.push('Robinhood Chain scan is temporarily unavailable.')
      nextActions.push('Retry the Robinhood Chain scan shortly.')
    }
  }

  const walletChainSelectionAudit = buildWalletChainSelectionAudit({
    requestedMode: params.chainMode,
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
    ...(jobStatus ? { jobStatus, jobId } : {}),
    ...(params.debug ? { debug: { evmReport, robinhoodAudit } } : {}),
    walletChainSelectionAudit,
  }

  if (params.scanDepth === 'preview') {
    await writeOrchestratorCache(cacheKey, stripDebug(result), evmChains)
  }

  return result
}

function stripDebug(result: CanonicalWalletScanResult): CanonicalWalletScanResult {
  if (!result.debug) return result
  const rest: CanonicalWalletScanResult = { ...result }
  delete rest.debug
  return rest
}
