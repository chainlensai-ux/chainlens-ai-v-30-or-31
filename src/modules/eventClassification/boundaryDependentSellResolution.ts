// BOUNDARY-DEPENDENT SELL RESOLUTION, DISCLOSED (5 unmatched sells blocked solely by an unproven
// window boundary). GoldRush failure / Alchemy continuation-not-followed makes chain coverage
// `partial`, which currently reclassifies EVERY trade-eligible unmatched sell with no earlier
// in-window buy as `unknown` + `sellsBlockedSolelyByUnprovenBoundary`. This module resolves those
// sells INDIVIDUALLY. It never:
//   - invents a prior buy for FIFO
//   - treats a provider timeout as proof of no history
//   - marks a sell non-trade merely because no buy exists
//   - flips the global windowBoundaryProven / historyCoverageStatus flags
// Proven pre-window exits and proven non-trade transfers are the ONLY dispositions that drop a
// sell from the blocking denominator. Everything else stays blocking.

import type { UnmatchedEventIdentity } from '../fifoEngine/types'
import type { RawProviderEvent, SupportedChain } from '../providerFetchWindow/types'
import type { AlchemyTokenHistoryStrictResult } from '../recoveryPolicy/utils'
import type { ClassifiedEvent, EventClassification } from './index'

export type BoundaryDependentSellDisposition =
  | 'pre_window_inventory_exit_proven'
  | 'non_trade_transfer_proven'
  | 'supported_swap_with_missing_pre_window_buy'
  | 'genuine_unmatched_sell'
  | 'still_unresolved_boundary'

export type BoundaryDependentSellResolutionRow = {
  identity: string
  txHash: string
  token: string
  amount: number
  currentClassification: EventClassification | null
  receiptProof: string | null
  earlierBuyProof: boolean
  preWindowRecoveryAttempted: boolean
  preWindowEvidenceFound: boolean
  disposition: BoundaryDependentSellDisposition
  gateImpact: 'non_blocking' | 'blocking'
  chain: string
  timestamp: number
  rawAmount: string | null
  normalizedAmount: number
  from: string
  to: string
  classification: EventClassification | null
  receiptClassification: string | null
  earlierBuyInCurrentWindow: boolean
  acceptedPreWindowInventoryEvidence: boolean
  recoveryHistoryFound: boolean
  earliestRecoveredBuy: { txHash: string; timestamp: number; source: string } | null
  providerSource: string | null
  providerBoundaryDependency: boolean
  finalDisposition: BoundaryDependentSellDisposition
  inboundTx: string | null
  inboundTimestamp: number | null
  inboundSource: string | null
  side: 'sell'
}

export type BoundaryDependentSellResolutionAudit = {
  sellsConsidered: number
  uniqueTokensFetched: number
  providerCalls: number
  rows: BoundaryDependentSellResolutionRow[]
  provenPreWindowInventoryExits: string[]
  provenNonTradeTransfers: string[]
  provenGenuineUnmatchedSells: string[]
  remainingBlockers: number
}

export type TokenHistoryFetcher = (
  chain: SupportedChain,
  walletAddress: string,
  token: string,
) => Promise<AlchemyTokenHistoryStrictResult>

const NON_TRADE_RECEIPT_REASONS = new Set([
  'plain_transfer_no_swap_event',
  'lp_add_or_remove_detected',
  'ordinary_transfer',
])

const NON_TRADE_CLASSIFICATIONS = new Set<EventClassification>([
  'ordinary_transfer',
  'distribution_airdrop',
  'router_intermediary',
  'bridge',
  'lp_staking',
])

const MAX_BOUNDARY_DEPENDENT_TOKEN_FETCHES = 8

export function unmatchedSellProofKey(identity: { chain: string; txHash: string; token: string }): string {
  return `${identity.chain}:${identity.txHash.toLowerCase()}:${identity.token.toLowerCase()}`
}

function parseTs(value: string | null | undefined): number | null {
  if (value == null || value === '') return null
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : null
}

type InboundHit = {
  txHash: string
  timestamp: number
  source: string
}

function collectLocalInbounds(params: {
  walletAddress: string
  chain: string
  token: string
  sellTxHash: string
  classified: readonly ClassifiedEvent[]
  recoveredClassified: readonly ClassifiedEvent[]
  recoveredRawEvents: readonly RawProviderEvent[]
}): InboundHit[] {
  const wallet = params.walletAddress.toLowerCase()
  const token = params.token.toLowerCase()
  const sellTx = params.sellTxHash.toLowerCase()
  const hits: InboundHit[] = []

  const considerClassified = (events: readonly ClassifiedEvent[], source: string) => {
    for (const c of events) {
      if (c.event.chain !== params.chain) continue
      if (c.event.direction !== 'inbound') continue
      if (c.event.contract.toLowerCase() !== token) continue
      if (c.event.txHash.toLowerCase() === sellTx) continue
      const to = (c.event.toAddress ?? '').toLowerCase()
      if (to !== '' && to !== wallet) continue
      const ts = parseTs(c.event.timestamp)
      if (ts == null) continue
      hits.push({ txHash: c.event.txHash, timestamp: ts, source })
    }
  }
  considerClassified(params.classified, 'classified_canonical')
  considerClassified(params.recoveredClassified, 'recovered_classified')

  for (const event of params.recoveredRawEvents) {
    if (event.chain !== params.chain) continue
    if ((event.contract ?? '').toLowerCase() !== token) continue
    if ((event.txHash ?? '').toLowerCase() === sellTx) continue
    if ((event.toAddress ?? '').toLowerCase() !== wallet) continue
    const ts = parseTs(event.timestamp)
    if (ts == null) continue
    hits.push({ txHash: event.txHash ?? '0x', timestamp: ts, source: 'recovered_raw' })
  }
  hits.sort((a, b) => a.timestamp - b.timestamp)
  return hits
}

function earliestBefore(hits: readonly InboundHit[], boundExclusive: number): InboundHit | null {
  for (const hit of hits) {
    if (hit.timestamp < boundExclusive) return hit
  }
  return null
}

function gateImpactFor(disposition: BoundaryDependentSellDisposition): 'non_blocking' | 'blocking' {
  return disposition === 'pre_window_inventory_exit_proven' || disposition === 'non_trade_transfer_proven'
    ? 'non_blocking'
    : 'blocking'
}

function emptyFailedHistory(): AlchemyTokenHistoryStrictResult {
  return {
    ok: false, inboundQueryOk: false, outboundQueryOk: false, events: [],
    inboundPageCapped: false, inboundPageExhausted: false, providerCalls: 0,
  }
}

export async function resolveBoundaryDependentSells(params: {
  sells: readonly UnmatchedEventIdentity[]
  classified: readonly ClassifiedEvent[]
  recoveredClassified?: readonly ClassifiedEvent[]
  recoveredRawEvents?: readonly RawProviderEvent[]
  windowStartTimestamp: number
  walletAddress: string
  receiptProofByTx?: ReadonlyMap<string, string>
  fetchTokenHistory?: TokenHistoryFetcher
}): Promise<BoundaryDependentSellResolutionAudit> {
  const recoveredClassified = params.recoveredClassified ?? []
  const recoveredRawEvents = params.recoveredRawEvents ?? []
  const receiptProofByTx = params.receiptProofByTx ?? new Map<string, string>()
  const rows: BoundaryDependentSellResolutionRow[] = []
  const provenPreWindowInventoryExits: string[] = []
  const provenNonTradeTransfers: string[] = []
  const provenGenuineUnmatchedSells: string[] = []

  const tokensNeedingFetch = new Map<string, { chain: SupportedChain; token: string }>()
  const localInboundBySell = new Map<string, InboundHit[]>()

  for (const sell of params.sells) {
    const key = unmatchedSellProofKey(sell)
    localInboundBySell.set(key, collectLocalInbounds({
      walletAddress: params.walletAddress,
      chain: sell.chain,
      token: sell.token,
      sellTxHash: sell.txHash,
      classified: params.classified,
      recoveredClassified,
      recoveredRawEvents,
    }))
  }

  // First pass: dispositions that need no provider call.
  const pendingProvider: UnmatchedEventIdentity[] = []
  for (const sell of params.sells) {
    const key = unmatchedSellProofKey(sell)
    const classifiedMatch = [...params.classified, ...recoveredClassified].find((c) =>
      c.event.chain === sell.chain
      && c.event.txHash.toLowerCase() === sell.txHash.toLowerCase()
      && c.event.contract.toLowerCase() === sell.token.toLowerCase()
      && c.event.direction === 'outbound',
    )
    const classification = classifiedMatch?.classification ?? null
    const receiptProof = receiptProofByTx.get(sell.txHash.toLowerCase()) ?? null
    const localHits = localInboundBySell.get(key) ?? []
    const preWindowHit = earliestBefore(localHits, params.windowStartTimestamp)
    const inWindowHit = localHits.find((hit) => hit.timestamp >= params.windowStartTimestamp && hit.timestamp < sell.timestamp) ?? null

    if (classification != null && NON_TRADE_CLASSIFICATIONS.has(classification)) {
      rows.push(buildRow({
        sell, classification, receiptProof, hits: localHits, preWindowHit, inWindowHit,
        disposition: 'non_trade_transfer_proven',
        preWindowRecoveryAttempted: false, providerSource: null, providerBoundaryDependency: false,
      }))
      provenNonTradeTransfers.push(key)
      continue
    }
    if (receiptProof != null && NON_TRADE_RECEIPT_REASONS.has(receiptProof)) {
      rows.push(buildRow({
        sell, classification, receiptProof, hits: localHits, preWindowHit, inWindowHit,
        disposition: 'non_trade_transfer_proven',
        preWindowRecoveryAttempted: false, providerSource: 'receipt', providerBoundaryDependency: false,
      }))
      provenNonTradeTransfers.push(key)
      continue
    }
    if (preWindowHit != null) {
      rows.push(buildRow({
        sell, classification, receiptProof, hits: localHits, preWindowHit, inWindowHit,
        disposition: 'pre_window_inventory_exit_proven',
        preWindowRecoveryAttempted: false, providerSource: preWindowHit.source, providerBoundaryDependency: false,
      }))
      provenPreWindowInventoryExits.push(key)
      continue
    }
    pendingProvider.push(sell)
    if (tokensNeedingFetch.size < MAX_BOUNDARY_DEPENDENT_TOKEN_FETCHES) {
      const tokenKey = `${sell.chain}:${sell.token.toLowerCase()}`
      if (!tokensNeedingFetch.has(tokenKey)) {
        tokensNeedingFetch.set(tokenKey, { chain: sell.chain, token: sell.token })
      }
    }
  }

  const historyByToken = new Map<string, AlchemyTokenHistoryStrictResult>()
  let providerCalls = 0
  if (params.fetchTokenHistory) {
    for (const { chain, token } of tokensNeedingFetch.values()) {
      const result = await params.fetchTokenHistory(chain, params.walletAddress, token)
      historyByToken.set(`${chain}:${token.toLowerCase()}`, result)
      providerCalls += result.providerCalls
    }
  } else {
    for (const { chain, token } of tokensNeedingFetch.values()) {
      historyByToken.set(`${chain}:${token.toLowerCase()}`, emptyFailedHistory())
    }
  }

  for (const sell of pendingProvider) {
    const key = unmatchedSellProofKey(sell)
    const classifiedMatch = [...params.classified, ...recoveredClassified].find((c) =>
      c.event.chain === sell.chain
      && c.event.txHash.toLowerCase() === sell.txHash.toLowerCase()
      && c.event.contract.toLowerCase() === sell.token.toLowerCase()
      && c.event.direction === 'outbound',
    )
    const classification = classifiedMatch?.classification ?? null
    const receiptProof = receiptProofByTx.get(sell.txHash.toLowerCase()) ?? null
    const localHits = localInboundBySell.get(key) ?? []
    const inWindowHit = localHits.find((hit) => hit.timestamp >= params.windowStartTimestamp && hit.timestamp < sell.timestamp) ?? null
    const history = historyByToken.get(`${sell.chain}:${sell.token.toLowerCase()}`)
    const fetchAttempted = history != null

    if (history == null || history.ok !== true || history.inboundQueryOk !== true) {
      rows.push(buildRow({
        sell, classification, receiptProof, hits: localHits, preWindowHit: null, inWindowHit,
        disposition: 'still_unresolved_boundary',
        preWindowRecoveryAttempted: fetchAttempted, providerSource: fetchAttempted ? 'alchemy' : null,
        providerBoundaryDependency: true,
      }))
      continue
    }

    const providerHits: InboundHit[] = []
    for (const event of history.events) {
      if ((event.contract ?? '').toLowerCase() !== sell.token.toLowerCase()) continue
      if ((event.toAddress ?? '').toLowerCase() !== params.walletAddress.toLowerCase()) continue
      if ((event.txHash ?? '').toLowerCase() === sell.txHash.toLowerCase()) continue
      const ts = parseTs(event.timestamp)
      if (ts == null) continue
      providerHits.push({ txHash: event.txHash ?? '0x', timestamp: ts, source: 'alchemy_inbound' })
    }
    const allHits = [...localHits, ...providerHits].sort((a, b) => a.timestamp - b.timestamp)
    const preWindowHit = earliestBefore(allHits, params.windowStartTimestamp)
    if (preWindowHit != null) {
      rows.push(buildRow({
        sell, classification, receiptProof, hits: allHits, preWindowHit, inWindowHit,
        disposition: 'pre_window_inventory_exit_proven',
        preWindowRecoveryAttempted: true, providerSource: preWindowHit.source, providerBoundaryDependency: true,
      }))
      provenPreWindowInventoryExits.push(key)
      continue
    }

    // Completed inbound query found no pre-window inbound. A capped page cannot prove that older
    // history does not exist — timeout-equivalent for "no history", fail closed.
    if (history.inboundPageCapped) {
      rows.push(buildRow({
        sell, classification, receiptProof, hits: allHits, preWindowHit: null, inWindowHit,
        disposition: 'still_unresolved_boundary',
        preWindowRecoveryAttempted: true, providerSource: 'alchemy', providerBoundaryDependency: true,
      }))
      continue
    }

    const swapProven = receiptProof === 'exact_swap'
    const disposition: BoundaryDependentSellDisposition = swapProven
      ? 'supported_swap_with_missing_pre_window_buy'
      : 'genuine_unmatched_sell'
    rows.push(buildRow({
      sell, classification, receiptProof, hits: allHits, preWindowHit: null, inWindowHit,
      disposition,
      preWindowRecoveryAttempted: true, providerSource: 'alchemy', providerBoundaryDependency: true,
    }))
    provenGenuineUnmatchedSells.push(key)
  }

  const remainingBlockers = rows.filter((row) => row.gateImpact === 'blocking').length
  return {
    sellsConsidered: params.sells.length,
    uniqueTokensFetched: historyByToken.size,
    providerCalls,
    rows,
    provenPreWindowInventoryExits,
    provenNonTradeTransfers,
    provenGenuineUnmatchedSells,
    remainingBlockers,
  }
}

function buildRow(params: {
  sell: UnmatchedEventIdentity
  classification: EventClassification | null
  receiptProof: string | null
  hits: readonly InboundHit[]
  preWindowHit: InboundHit | null
  inWindowHit: InboundHit | null
  disposition: BoundaryDependentSellDisposition
  preWindowRecoveryAttempted: boolean
  providerSource: string | null
  providerBoundaryDependency: boolean
}): BoundaryDependentSellResolutionRow {
  const { sell, classification, receiptProof, hits, preWindowHit, inWindowHit, disposition } = params
  const earliest = hits[0] ?? null
  return {
    identity: unmatchedSellProofKey(sell),
    txHash: sell.txHash,
    token: sell.token,
    amount: sell.amount,
    currentClassification: classification,
    receiptProof,
    earlierBuyProof: preWindowHit != null || inWindowHit != null,
    preWindowRecoveryAttempted: params.preWindowRecoveryAttempted,
    preWindowEvidenceFound: preWindowHit != null,
    disposition,
    gateImpact: gateImpactFor(disposition),
    chain: sell.chain,
    timestamp: sell.timestamp,
    rawAmount: sell.amountRaw,
    normalizedAmount: sell.amount,
    from: sell.fromAddress,
    to: sell.toAddress,
    classification,
    receiptClassification: receiptProof,
    earlierBuyInCurrentWindow: inWindowHit != null,
    acceptedPreWindowInventoryEvidence: preWindowHit != null,
    recoveryHistoryFound: hits.length > 0,
    earliestRecoveredBuy: earliest == null ? null : { txHash: earliest.txHash, timestamp: earliest.timestamp, source: earliest.source },
    providerSource: params.providerSource,
    providerBoundaryDependency: params.providerBoundaryDependency,
    finalDisposition: disposition,
    inboundTx: preWindowHit?.txHash ?? earliest?.txHash ?? null,
    inboundTimestamp: preWindowHit?.timestamp ?? earliest?.timestamp ?? null,
    inboundSource: preWindowHit?.source ?? earliest?.source ?? null,
    side: 'sell',
  }
}
