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
  | 'pre_window_inventory_insufficient'
  | 'non_trade_transfer_proven'
  | 'supported_swap_with_missing_pre_window_buy'
  | 'genuine_unmatched_sell'
  | 'still_unresolved_boundary'

export type TargetedRecoveryOutcome =
  | 'not_attempted'
  | 'inbound_found'
  | 'timeout_or_failed'
  | 'page_capped'
  | 'empty_exhausted'

// `earlier_buy_in_window` sells are shortfalls: an in-window buy covered part of the sell and only
// the unmatched remainder (`unmatchedRaw`) needs pre-window inventory.
export type PreResolverBucket = 'history_truncated_at_provider' | 'window_boundary_unproven' | 'earlier_buy_in_window'

// AMOUNT CHECK: pre-window inbound raw (local + provider, de-duplicated by txHash and amount) minus
// visible pre-window outbounds, against the cumulative unmatched raw of this and every earlier
// unmatched sell of the same chain and token. Unknown amounts never prove anything.
export type PreWindowAmountCheck = 'covered' | 'insufficient' | 'unknown' | 'not_applicable'

export type BoundaryDependentSellResolutionRow = {
  identity: string
  txHash: string
  token: string
  amount: number
  currentClassification: EventClassification | null
  originalClassification: EventClassification | null
  receiptProof: string | null
  earlierBuyProof: boolean
  earlierInboundProof: boolean
  preWindowRecoveryAttempted: boolean
  targetedRecoveryAttempted: boolean
  targetedRecoveryOutcome: TargetedRecoveryOutcome
  preWindowEvidenceFound: boolean
  preResolverBucket: PreResolverBucket | null
  disposition: BoundaryDependentSellDisposition
  finalDisposition: BoundaryDependentSellDisposition
  gateImpact: 'non_blocking' | 'blocking'
  blockingAfterResolution: boolean
  chain: string
  timestamp: number
  rawAmount: string | null
  normalizedAmount: number
  unmatchedRaw: string | null
  sellRaw: string | null
  preWindowAmountCheck: PreWindowAmountCheck
  preWindowInboundRaw: string | null
  preWindowOutboundRaw: string | null
  requiredRaw: string | null
  tokenSkippedByFetchCap: boolean
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
  // Shortfall sells (preResolverBucket `earlier_buy_in_window`) whose unmatched remainder is covered.
  provenPreWindowShortfalls: string[]
  provenNonTradeTransfers: string[]
  provenGenuineUnmatchedSells: string[]
  // `${chain}:${token}` keys that needed a provider fetch but fell outside the per-scan cap.
  tokensSkippedByFetchCap: string[]
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

export const MAX_BOUNDARY_DEPENDENT_TOKEN_FETCHES = 8

export function unmatchedSellProofKey(identity: { chain: string; txHash: string; token: string }): string {
  return `${identity.chain}:${identity.txHash.toLowerCase()}:${identity.token.toLowerCase()}`
}

function tokenKeyOf(identity: { chain: string; token: string }): string {
  return `${identity.chain}:${identity.token.toLowerCase()}`
}

function parseTs(value: string | null | undefined): number | null {
  if (value == null || value === '') return null
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : null
}

function parseRaw(value: string | null | undefined): bigint | null {
  if (value == null || !/^\d+$/.test(value.trim())) return null
  return BigInt(value.trim())
}

/** The raw amount the sell still needs covered: its unmatched remainder, else (conservatively) the full sell. */
function requiredRawOf(sell: UnmatchedEventIdentity): bigint | null {
  return parseRaw(sell.unmatchedRaw ?? sell.sellRaw ?? sell.amountRaw)
}

type TransferHit = {
  txHash: string
  timestamp: number
  source: string
  amountRaw: bigint | null
}

function compareHits(a: TransferHit, b: TransferHit): number {
  return a.timestamp - b.timestamp || a.txHash.toLowerCase().localeCompare(b.txHash.toLowerCase())
}

function dedupeHits(hits: readonly TransferHit[]): TransferHit[] {
  const seen = new Set<string>()
  const out: TransferHit[] = []
  for (const hit of [...hits].sort(compareHits)) {
    const key = `${hit.txHash.toLowerCase()}:${hit.amountRaw == null ? '?' : hit.amountRaw.toString()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

function collectLocalTransfers(params: {
  walletAddress: string
  chain: string
  token: string
  sellTxHash: string
  classified: readonly ClassifiedEvent[]
  recoveredClassified: readonly ClassifiedEvent[]
  recoveredRawEvents: readonly RawProviderEvent[]
}): { inbounds: TransferHit[]; outbounds: TransferHit[] } {
  const wallet = params.walletAddress.toLowerCase()
  const token = params.token.toLowerCase()
  const sellTx = params.sellTxHash.toLowerCase()
  const inbounds: TransferHit[] = []
  const outbounds: TransferHit[] = []

  const considerClassified = (events: readonly ClassifiedEvent[], source: string) => {
    for (const c of events) {
      if (c.event.chain !== params.chain) continue
      if (c.event.contract.toLowerCase() !== token) continue
      if (c.event.txHash.toLowerCase() === sellTx) continue
      const ts = parseTs(c.event.timestamp)
      if (ts == null) continue
      const hit = { txHash: c.event.txHash, timestamp: ts, source, amountRaw: parseRaw(c.event.amountRaw) }
      // The wallet must be the named counterparty; an empty address proves nothing.
      if (c.event.direction === 'inbound' && (c.event.toAddress ?? '').toLowerCase() === wallet) inbounds.push(hit)
      else if (c.event.direction === 'outbound' && (c.event.fromAddress ?? '').toLowerCase() === wallet) outbounds.push(hit)
    }
  }
  considerClassified(params.classified, 'classified_canonical')
  considerClassified(params.recoveredClassified, 'recovered_classified')

  for (const event of params.recoveredRawEvents) {
    if (event.chain !== params.chain) continue
    if ((event.contract ?? '').toLowerCase() !== token) continue
    if ((event.txHash ?? '').toLowerCase() === sellTx) continue
    const ts = parseTs(event.timestamp)
    if (ts == null) continue
    const hit = { txHash: event.txHash ?? '0x', timestamp: ts, source: 'recovered_raw', amountRaw: parseRaw(event.amountRaw) }
    const to = (event.toAddress ?? '').toLowerCase()
    const from = (event.fromAddress ?? '').toLowerCase()
    if (to === wallet && from !== wallet) inbounds.push(hit)
    else if (from === wallet && to !== wallet) outbounds.push(hit)
  }
  return { inbounds: inbounds.sort(compareHits), outbounds: outbounds.sort(compareHits) }
}

type AmountEvaluation = {
  check: PreWindowAmountCheck
  preWindowHits: TransferHit[]
  inboundRaw: bigint | null
  outboundRaw: bigint | null
}

// Pre-window = strictly before the window start (and so strictly before the in-window sell).
function evaluatePreWindowAmount(
  inbounds: readonly TransferHit[],
  outbounds: readonly TransferHit[],
  windowStart: number,
  sellTimestamp: number,
  required: bigint | null,
): AmountEvaluation {
  const bound = Math.min(windowStart, sellTimestamp)
  const preIn = dedupeHits(inbounds).filter((h) => h.timestamp < bound)
  const preOut = dedupeHits(outbounds).filter((h) => h.timestamp < bound)
  if (preIn.length === 0) return { check: 'not_applicable', preWindowHits: [], inboundRaw: null, outboundRaw: null }
  let inboundRaw = BigInt(0)
  let anyInboundUnknown = false
  for (const h of preIn) {
    if (h.amountRaw == null) anyInboundUnknown = true
    else inboundRaw += h.amountRaw
  }
  let outboundRaw: bigint | null = BigInt(0)
  for (const h of preOut) {
    if (h.amountRaw == null) { outboundRaw = null; break }
    outboundRaw += h.amountRaw
  }
  // Known inbounds are a lower bound; an unknown outbound or required amount proves nothing.
  if (outboundRaw == null || required == null) return { check: 'unknown', preWindowHits: preIn, inboundRaw, outboundRaw }
  if (inboundRaw - outboundRaw >= required) return { check: 'covered', preWindowHits: preIn, inboundRaw, outboundRaw }
  return { check: anyInboundUnknown ? 'unknown' : 'insufficient', preWindowHits: preIn, inboundRaw, outboundRaw }
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

function compareSells(a: UnmatchedEventIdentity, b: UnmatchedEventIdentity): number {
  return a.timestamp - b.timestamp
    || a.txHash.toLowerCase().localeCompare(b.txHash.toLowerCase())
    || a.token.toLowerCase().localeCompare(b.token.toLowerCase())
}

// Cumulative raw each sell needs from pre-window inventory: its own unmatched remainder plus that of
// every earlier unmatched sell of the same chain and token (they drained the same inventory first).
function cumulativeRequiredBySell(drainSells: readonly UnmatchedEventIdentity[]): Map<string, bigint | null> {
  const out = new Map<string, bigint | null>()
  const runningByToken = new Map<string, bigint | null>()
  for (const sell of [...drainSells].sort(compareSells)) {
    const tokenKey = tokenKeyOf(sell)
    const prior = runningByToken.has(tokenKey) ? runningByToken.get(tokenKey)! : BigInt(0)
    const own = requiredRawOf(sell)
    const next = prior == null || own == null ? null : prior + own
    runningByToken.set(tokenKey, next)
    out.set(unmatchedSellProofKey(sell), next)
  }
  return out
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
  preResolverBuckets?: ReadonlyMap<string, PreResolverBucket>
  // Every unmatched sell of the scan (defaults to `sells`); used only to charge earlier sells of the
  // same token against the shared pre-window inventory before this one.
  allUnmatchedSells?: readonly UnmatchedEventIdentity[]
}): Promise<BoundaryDependentSellResolutionAudit> {
  const recoveredClassified = params.recoveredClassified ?? []
  const recoveredRawEvents = params.recoveredRawEvents ?? []
  const receiptProofByTx = params.receiptProofByTx ?? new Map<string, string>()
  const preResolverBuckets = params.preResolverBuckets ?? new Map<string, PreResolverBucket>()
  const sells = [...params.sells].sort(compareSells)
  const drainSells = [...(params.allUnmatchedSells ?? []), ...params.sells]
  const seenDrain = new Set<string>()
  const cumulativeRequired = cumulativeRequiredBySell(drainSells.filter((s) => {
    const key = unmatchedSellProofKey(s)
    if (seenDrain.has(key)) return false
    seenDrain.add(key)
    return true
  }))
  const rowsByKey = new Map<string, BoundaryDependentSellResolutionRow>()
  const provenPreWindowInventoryExits: string[] = []
  const provenPreWindowShortfalls: string[] = []
  const provenNonTradeTransfers: string[] = []
  const provenGenuineUnmatchedSells: string[] = []
  const allClassified = [...params.classified, ...recoveredClassified]

  const localBySell = new Map<string, { inbounds: TransferHit[]; outbounds: TransferHit[] }>()
  const classificationBySell = new Map<string, EventClassification | null>()
  for (const sell of sells) {
    const key = unmatchedSellProofKey(sell)
    localBySell.set(key, collectLocalTransfers({
      walletAddress: params.walletAddress,
      chain: sell.chain,
      token: sell.token,
      sellTxHash: sell.txHash,
      classified: params.classified,
      recoveredClassified,
      recoveredRawEvents,
    }))
    const classifiedMatch = allClassified.find((c) =>
      c.event.chain === sell.chain
      && c.event.txHash.toLowerCase() === sell.txHash.toLowerCase()
      && c.event.contract.toLowerCase() === sell.token.toLowerCase()
      && c.event.direction === 'outbound',
    )
    classificationBySell.set(key, classifiedMatch?.classification ?? null)
  }

  const isShortfall = (key: string) => preResolverBuckets.get(key) === 'earlier_buy_in_window'
  const recordProven = (key: string) => {
    if (isShortfall(key)) provenPreWindowShortfalls.push(key)
    else provenPreWindowInventoryExits.push(key)
  }
  const inWindowHitOf = (inbounds: readonly TransferHit[], sell: UnmatchedEventIdentity) =>
    inbounds.find((hit) => hit.timestamp >= params.windowStartTimestamp && hit.timestamp < sell.timestamp) ?? null

  // First pass: dispositions that need no provider call.
  const pendingProvider: UnmatchedEventIdentity[] = []
  for (const sell of sells) {
    const key = unmatchedSellProofKey(sell)
    const classification = classificationBySell.get(key) ?? null
    const receiptProof = receiptProofByTx.get(sell.txHash.toLowerCase()) ?? null
    const local = localBySell.get(key)!
    const inWindowHit = inWindowHitOf(local.inbounds, sell)
    const required = cumulativeRequired.get(key) ?? null
    const base = {
      sell, classification, receiptProof, hits: local.inbounds, inWindowHit, required,
      preResolverBucket: preResolverBuckets.get(key) ?? null, tokenSkippedByFetchCap: false,
    }

    if (classification != null && NON_TRADE_CLASSIFICATIONS.has(classification)) {
      rowsByKey.set(key, buildRow({
        ...base, preWindowHit: null, amount: null,
        disposition: 'non_trade_transfer_proven',
        preWindowRecoveryAttempted: false, providerSource: null, providerBoundaryDependency: false,
        targetedRecoveryOutcome: 'not_attempted',
      }))
      provenNonTradeTransfers.push(key)
      continue
    }
    if (receiptProof != null && NON_TRADE_RECEIPT_REASONS.has(receiptProof)) {
      rowsByKey.set(key, buildRow({
        ...base, preWindowHit: null, amount: null,
        disposition: 'non_trade_transfer_proven',
        preWindowRecoveryAttempted: false, providerSource: 'receipt', providerBoundaryDependency: false,
        targetedRecoveryOutcome: 'not_attempted',
      }))
      provenNonTradeTransfers.push(key)
      continue
    }
    const amount = evaluatePreWindowAmount(local.inbounds, local.outbounds, params.windowStartTimestamp, sell.timestamp, required)
    if (amount.check === 'covered') {
      rowsByKey.set(key, buildRow({
        ...base, preWindowHit: amount.preWindowHits[0] ?? null, amount,
        disposition: 'pre_window_inventory_exit_proven',
        preWindowRecoveryAttempted: false, providerSource: amount.preWindowHits[0]?.source ?? null, providerBoundaryDependency: false,
        targetedRecoveryOutcome: 'not_attempted',
      }))
      recordProven(key)
      continue
    }
    pendingProvider.push(sell)
  }

  // Prioritised cap: most blocking sells first, then largest unmatched raw, then token address.
  const pendingByToken = new Map<string, { chain: SupportedChain; token: string; count: number; raw: bigint }>()
  for (const sell of pendingProvider) {
    const tokenKey = tokenKeyOf(sell)
    const entry = pendingByToken.get(tokenKey) ?? { chain: sell.chain, token: sell.token, count: 0, raw: BigInt(0) }
    entry.count += 1
    entry.raw += requiredRawOf(sell) ?? BigInt(0)
    pendingByToken.set(tokenKey, entry)
  }
  const rankedTokens = [...pendingByToken.entries()].sort(([ak, a], [bk, b]) =>
    b.count - a.count || (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0) || ak.localeCompare(bk))
  const tokensNeedingFetch = rankedTokens.slice(0, MAX_BOUNDARY_DEPENDENT_TOKEN_FETCHES)
  const tokensSkippedByFetchCap = rankedTokens.slice(MAX_BOUNDARY_DEPENDENT_TOKEN_FETCHES).map(([k]) => k)
  const skippedSet = new Set(tokensSkippedByFetchCap)

  const historyByToken = new Map<string, AlchemyTokenHistoryStrictResult>()
  let providerCalls = 0
  for (const [tokenKey, { chain, token }] of tokensNeedingFetch) {
    if (params.fetchTokenHistory) {
      const result = await params.fetchTokenHistory(chain, params.walletAddress, token)
      historyByToken.set(tokenKey, result)
      providerCalls += result.providerCalls
    } else {
      historyByToken.set(tokenKey, emptyFailedHistory())
    }
  }

  for (const sell of pendingProvider) {
    const key = unmatchedSellProofKey(sell)
    const tokenKey = tokenKeyOf(sell)
    const classification = classificationBySell.get(key) ?? null
    const receiptProof = receiptProofByTx.get(sell.txHash.toLowerCase()) ?? null
    const local = localBySell.get(key)!
    const inWindowHit = inWindowHitOf(local.inbounds, sell)
    const required = cumulativeRequired.get(key) ?? null
    const history = historyByToken.get(tokenKey)
    const fetchAttempted = history != null
    const base = {
      sell, classification, receiptProof, inWindowHit, required,
      preResolverBucket: preResolverBuckets.get(key) ?? null, tokenSkippedByFetchCap: skippedSet.has(tokenKey),
    }

    if (history == null || history.ok !== true || history.inboundQueryOk !== true) {
      // Local pre-window evidence alone was not enough by amount; without a completed provider
      // query that stays an insufficient (blocking) proof, never a resolution.
      const localAmount = evaluatePreWindowAmount(local.inbounds, local.outbounds, params.windowStartTimestamp, sell.timestamp, required)
      const localEvidence = localAmount.check !== 'not_applicable'
      rowsByKey.set(key, buildRow({
        ...base, hits: local.inbounds, preWindowHit: localAmount.preWindowHits[0] ?? null, amount: localEvidence ? localAmount : null,
        disposition: localEvidence ? 'pre_window_inventory_insufficient' : 'still_unresolved_boundary',
        preWindowRecoveryAttempted: fetchAttempted, providerSource: fetchAttempted ? 'alchemy' : null,
        providerBoundaryDependency: true,
        targetedRecoveryOutcome: fetchAttempted ? 'timeout_or_failed' : 'not_attempted',
      }))
      continue
    }

    const providerInbounds: TransferHit[] = []
    for (const event of history.events) {
      if (event.chain != null && event.chain !== sell.chain) continue
      if ((event.contract ?? '').toLowerCase() !== sell.token.toLowerCase()) continue
      if ((event.toAddress ?? '').toLowerCase() !== params.walletAddress.toLowerCase()) continue
      if ((event.txHash ?? '').toLowerCase() === sell.txHash.toLowerCase()) continue
      const ts = parseTs(event.timestamp)
      if (ts == null) continue
      providerInbounds.push({ txHash: event.txHash ?? '0x', timestamp: ts, source: 'alchemy_inbound', amountRaw: parseRaw(event.amountRaw) })
    }
    const allInbounds = dedupeHits([...local.inbounds, ...providerInbounds])
    const amount = evaluatePreWindowAmount(allInbounds, local.outbounds, params.windowStartTimestamp, sell.timestamp, required)
    if (amount.check !== 'not_applicable') {
      // A pre-window inbound exists. An oldest-first page holds the earliest inbounds even when
      // capped, so the existence proof is conclusive; the amount check decides the disposition.
      const covered = amount.check === 'covered'
      rowsByKey.set(key, buildRow({
        ...base, hits: allInbounds, preWindowHit: amount.preWindowHits[0] ?? null, amount,
        disposition: covered ? 'pre_window_inventory_exit_proven' : 'pre_window_inventory_insufficient',
        preWindowRecoveryAttempted: true, providerSource: amount.preWindowHits[0]?.source ?? 'alchemy', providerBoundaryDependency: true,
        targetedRecoveryOutcome: !covered && history.inboundPageCapped ? 'page_capped' : 'inbound_found',
      }))
      if (covered) recordProven(key)
      continue
    }

    // Completed inbound query found no pre-window inbound. A capped page cannot prove that older
    // history does not exist — timeout-equivalent for "no history", fail closed.
    if (history.inboundPageCapped) {
      rowsByKey.set(key, buildRow({
        ...base, hits: allInbounds, preWindowHit: null, amount: null,
        disposition: 'still_unresolved_boundary',
        preWindowRecoveryAttempted: true, providerSource: 'alchemy', providerBoundaryDependency: true,
        targetedRecoveryOutcome: 'page_capped',
      }))
      continue
    }

    const swapProven = receiptProof === 'exact_swap'
    const disposition: BoundaryDependentSellDisposition = swapProven
      ? 'supported_swap_with_missing_pre_window_buy'
      : 'genuine_unmatched_sell'
    rowsByKey.set(key, buildRow({
      ...base, hits: allInbounds, preWindowHit: null, amount: null,
      disposition,
      preWindowRecoveryAttempted: true, providerSource: 'alchemy', providerBoundaryDependency: true,
      targetedRecoveryOutcome: 'empty_exhausted',
    }))
    if (!isShortfall(key)) provenGenuineUnmatchedSells.push(key)
  }

  // Rows keep the caller's sell order.
  const rows = params.sells.map((sell) => rowsByKey.get(unmatchedSellProofKey(sell))!).filter((row) => row != null)
  const remainingBlockers = rows.filter((row) => row.gateImpact === 'blocking').length
  return {
    sellsConsidered: params.sells.length,
    uniqueTokensFetched: historyByToken.size,
    providerCalls,
    rows,
    provenPreWindowInventoryExits,
    provenPreWindowShortfalls,
    provenNonTradeTransfers,
    provenGenuineUnmatchedSells,
    tokensSkippedByFetchCap,
    remainingBlockers,
  }
}

function buildRow(params: {
  sell: UnmatchedEventIdentity
  classification: EventClassification | null
  receiptProof: string | null
  hits: readonly TransferHit[]
  preWindowHit: TransferHit | null
  inWindowHit: TransferHit | null
  amount: AmountEvaluation | null
  required: bigint | null
  disposition: BoundaryDependentSellDisposition
  preWindowRecoveryAttempted: boolean
  providerSource: string | null
  providerBoundaryDependency: boolean
  targetedRecoveryOutcome: TargetedRecoveryOutcome
  preResolverBucket: PreResolverBucket | null
  tokenSkippedByFetchCap: boolean
}): BoundaryDependentSellResolutionRow {
  const { sell, classification, receiptProof, hits, preWindowHit, inWindowHit, disposition, amount } = params
  const earliest = hits[0] ?? null
  const gateImpact = gateImpactFor(disposition)
  return {
    identity: unmatchedSellProofKey(sell),
    txHash: sell.txHash,
    token: sell.token,
    amount: sell.amount,
    currentClassification: classification,
    originalClassification: classification,
    receiptProof,
    earlierBuyProof: preWindowHit != null || inWindowHit != null,
    earlierInboundProof: preWindowHit != null || inWindowHit != null,
    preWindowRecoveryAttempted: params.preWindowRecoveryAttempted,
    targetedRecoveryAttempted: params.preWindowRecoveryAttempted,
    targetedRecoveryOutcome: params.targetedRecoveryOutcome,
    preWindowEvidenceFound: preWindowHit != null,
    preResolverBucket: params.preResolverBucket,
    disposition,
    finalDisposition: disposition,
    gateImpact,
    blockingAfterResolution: gateImpact === 'blocking',
    chain: sell.chain,
    timestamp: sell.timestamp,
    rawAmount: sell.amountRaw,
    normalizedAmount: sell.amount,
    unmatchedRaw: sell.unmatchedRaw ?? null,
    sellRaw: sell.sellRaw ?? sell.amountRaw ?? null,
    preWindowAmountCheck: amount?.check ?? 'not_applicable',
    preWindowInboundRaw: amount?.inboundRaw?.toString() ?? null,
    preWindowOutboundRaw: amount?.outboundRaw?.toString() ?? null,
    requiredRaw: params.required?.toString() ?? null,
    tokenSkippedByFetchCap: params.tokenSkippedByFetchCap,
    from: sell.fromAddress,
    to: sell.toAddress,
    classification,
    receiptClassification: receiptProof,
    earlierBuyInCurrentWindow: inWindowHit != null,
    acceptedPreWindowInventoryEvidence: disposition === 'pre_window_inventory_exit_proven',
    recoveryHistoryFound: hits.length > 0,
    earliestRecoveredBuy: earliest == null ? null : { txHash: earliest.txHash, timestamp: earliest.timestamp, source: earliest.source },
    providerSource: params.providerSource,
    providerBoundaryDependency: params.providerBoundaryDependency,
    inboundTx: preWindowHit?.txHash ?? earliest?.txHash ?? null,
    inboundTimestamp: preWindowHit?.timestamp ?? earliest?.timestamp ?? null,
    inboundSource: preWindowHit?.source ?? earliest?.source ?? null,
    side: 'sell',
  }
}
