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
import type { AlchemyTokenHistoryStrictResult, StrictHistoryDirectionStatus, StrictTransferEvent } from '../recoveryPolicy/utils'
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
  // A pre-window inbound exists but outbound history before the window start was not fully read
  // (capped, failed, budget, unsupported or not requested), so the inventory net is unproven.
  | 'outbound_history_incomplete'

// `earlier_buy_in_window` sells are shortfalls: an in-window buy covered part of the sell and only
// the unmatched remainder (`unmatchedRaw`) needs pre-window inventory.
export type PreResolverBucket = 'history_truncated_at_provider' | 'window_boundary_unproven' | 'earlier_buy_in_window'

// AMOUNT CHECK: pre-window inbound raw (local + provider, de-duplicated by txHash and amount) minus
// visible pre-window outbounds, against the cumulative unmatched raw of this and every earlier
// unmatched sell of the same chain and token. Unknown amounts never prove anything.
export type PreWindowAmountCheck = 'covered' | 'insufficient' | 'unknown' | 'not_applicable'

// Why an amount check could not reach `covered` when it is `unknown`.
export type PreWindowAmountBlocker = 'unknown_amount' | 'outbound_history_incomplete' | 'ledger_inconsistent'

// As-of-sell consistency check: with COMPLETE inbound and outbound history and the sell located by
// block/log, the wallet's balance just before the sell must be at least the sell's raw amount.
export type InventoryLedgerCheck = 'passed' | 'inconsistent' | 'not_checked'

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
  preWindowAmountBlocker: PreWindowAmountBlocker | null
  inboundHistoryStatus: StrictHistoryDirectionStatus | null
  outboundHistoryStatus: StrictHistoryDirectionStatus | null
  // Every outbound before the window start has been read (exhausted, or oldest-first pages reached it).
  outboundCoversPreWindow: boolean
  ledgerCheck: InventoryLedgerCheck
  // (tx, amount) groups whose sources disagreed on how many transfers there were and that had no
  // provider log identity to settle it; resolved conservatively (fewer inbounds, more outbounds).
  ambiguousDuplicateGroups: number
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
  // Oldest-first paging may stop once this timestamp (the window start) has been reached.
  options?: { coverUntilTimestamp?: number },
) => Promise<AlchemyTokenHistoryStrictResult>

// `plain_transfer_no_swap_event` is deliberately absent: it only means no Swap topic the decoder
// recognises (V4, other forks and RFQ fills look the same), so on its own it never proves non-trade.
// `one_way_transfer_only` is the receipt-level proof that the wallet only sent tokens.
const NON_TRADE_RECEIPT_REASONS = new Set([
  'one_way_transfer_only',
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
  // On-chain position when the provider returns it (Alchemy blockNum / uniqueId log index).
  blockNumber: number | null
  logIndex: number | null
  uniqueId: string | null
}

const PROVIDER_SOURCE_PREFIX = 'alchemy_'

function compareHits(a: TransferHit, b: TransferHit): number {
  return a.timestamp - b.timestamp
    || (a.blockNumber ?? Number.MAX_SAFE_INTEGER) - (b.blockNumber ?? Number.MAX_SAFE_INTEGER)
    || (a.logIndex ?? Number.MAX_SAFE_INTEGER) - (b.logIndex ?? Number.MAX_SAFE_INTEGER)
    || a.txHash.toLowerCase().localeCompare(b.txHash.toLowerCase())
    || a.source.localeCompare(b.source)
}

function providerIdentity(hit: TransferHit): string | null {
  if (!hit.source.startsWith(PROVIDER_SOURCE_PREFIX)) return null
  if (hit.logIndex != null) return `${hit.txHash.toLowerCase()}:log:${hit.logIndex}`
  return hit.uniqueId ? hit.uniqueId.toLowerCase() : null
}

// IDENTITY-AWARE MERGE. Transfers are grouped by (tx, amount). Provider transfers with a log
// position are distinct events and are de-duplicated only by that position, so two equal transfers
// in one tx both count. Sources without positions (local window events, recovered events) are
// matched against them by multiplicity: the same transfer seen by several sources counts once. When
// sources disagree and no provider identity settles it, the group is ambiguous and is resolved
// conservatively — fewer inbounds, more outbounds — and counted.
function mergeTransferSources(hits: readonly TransferHit[], direction: 'inbound' | 'outbound'): { hits: TransferHit[]; ambiguousGroups: number } {
  const groups = new Map<string, TransferHit[]>()
  for (const hit of hits) {
    const key = `${hit.txHash.toLowerCase()}:${hit.amountRaw == null ? '?' : hit.amountRaw.toString()}`
    const list = groups.get(key) ?? []
    list.push(hit)
    groups.set(key, list)
  }
  const out: TransferHit[] = []
  let ambiguousGroups = 0
  for (const list of groups.values()) {
    const identified = new Map<string, TransferHit>()
    const bySource = new Map<string, TransferHit[]>()
    for (const hit of [...list].sort(compareHits)) {
      const id = providerIdentity(hit)
      if (id != null) { if (!identified.has(id)) identified.set(id, hit); continue }
      const sourceHits = bySource.get(hit.source) ?? []
      sourceHits.push(hit)
      bySource.set(hit.source, sourceHits)
    }
    const counts = [...bySource.values()].map((h) => h.length)
    const maxLocal = counts.length > 0 ? Math.max(...counts) : 0
    const minLocal = counts.length > 0 ? Math.min(...counts) : 0
    if (identified.size > 0) {
      out.push(...identified.values())
      if (maxLocal > identified.size) {
        ambiguousGroups += 1
        if (direction === 'outbound') {
          const widest = [...bySource.values()].sort((a, b) => b.length - a.length || a[0]!.source.localeCompare(b[0]!.source))[0]!
          out.push(...widest.slice(identified.size))
        }
      }
      continue
    }
    if (counts.length === 0) continue
    const disagree = maxLocal !== minLocal
    if (disagree) ambiguousGroups += 1
    const n = disagree && direction === 'inbound' ? minLocal : maxLocal
    const widest = [...bySource.values()].sort((a, b) => b.length - a.length || a[0]!.source.localeCompare(b[0]!.source))[0]!
    out.push(...widest.slice(0, n))
  }
  return { hits: out.sort(compareHits), ambiguousGroups }
}

function hitFromEvent(event: RawProviderEvent | StrictTransferEvent, source: string, ts: number): TransferHit {
  const strict = event as StrictTransferEvent
  return {
    txHash: event.txHash ?? '0x', timestamp: ts, source, amountRaw: parseRaw(event.amountRaw),
    blockNumber: strict.blockNumber ?? null, logIndex: strict.logIndex ?? null, uniqueId: strict.uniqueId ?? null,
  }
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
      const hit: TransferHit = {
        txHash: c.event.txHash, timestamp: ts, source, amountRaw: parseRaw(c.event.amountRaw),
        blockNumber: null, logIndex: null, uniqueId: null,
      }
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
    const hit = hitFromEvent(event, 'recovered_raw', ts)
    const to = (event.toAddress ?? '').toLowerCase()
    const from = (event.fromAddress ?? '').toLowerCase()
    if (to === wallet && from !== wallet) inbounds.push(hit)
    else if (from === wallet && to !== wallet) outbounds.push(hit)
  }
  return { inbounds: inbounds.sort(compareHits), outbounds: outbounds.sort(compareHits) }
}

function collectProviderTransfers(
  events: readonly StrictTransferEvent[] | undefined,
  sell: UnmatchedEventIdentity,
  walletAddress: string,
  direction: 'inbound' | 'outbound',
): TransferHit[] {
  const wallet = walletAddress.toLowerCase()
  const hits: TransferHit[] = []
  for (const event of events ?? []) {
    if (event.chain != null && event.chain !== sell.chain) continue
    if ((event.contract ?? '').toLowerCase() !== sell.token.toLowerCase()) continue
    const to = (event.toAddress ?? '').toLowerCase()
    const from = (event.fromAddress ?? '').toLowerCase()
    if (direction === 'inbound' ? to !== wallet || from === wallet : from !== wallet || to === wallet) continue
    if ((event.txHash ?? '').toLowerCase() === sell.txHash.toLowerCase()) continue
    const ts = parseTs(event.timestamp)
    if (ts == null) continue
    hits.push(hitFromEvent(event, direction === 'inbound' ? 'alchemy_inbound' : 'alchemy_outbound', ts))
  }
  return hits
}

type AmountEvaluation = {
  check: PreWindowAmountCheck
  blocker: PreWindowAmountBlocker | null
  preWindowHits: TransferHit[]
  inboundRaw: bigint | null
  outboundRaw: bigint | null
  ambiguousGroups: number
}

// Pre-window = strictly before the window start (and so strictly before the in-window sell).
// `outboundComplete` says whether every outbound before the window start has been read; without it
// a pre-window inbound can never prove coverage, because the tokens may have left before the window.
function evaluatePreWindowAmount(
  inbounds: readonly TransferHit[],
  outbounds: readonly TransferHit[],
  windowStart: number,
  sellTimestamp: number,
  required: bigint | null,
  outboundComplete: boolean,
): AmountEvaluation {
  const bound = Math.min(windowStart, sellTimestamp)
  const mergedIn = mergeTransferSources(inbounds, 'inbound')
  const mergedOut = mergeTransferSources(outbounds, 'outbound')
  const ambiguousGroups = mergedIn.ambiguousGroups + mergedOut.ambiguousGroups
  const preIn = mergedIn.hits.filter((h) => h.timestamp < bound)
  const preOut = mergedOut.hits.filter((h) => h.timestamp < bound)
  if (preIn.length === 0) return { check: 'not_applicable', blocker: null, preWindowHits: [], inboundRaw: null, outboundRaw: null, ambiguousGroups }
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
  const result = (check: PreWindowAmountCheck, blocker: PreWindowAmountBlocker | null): AmountEvaluation =>
    ({ check, blocker, preWindowHits: preIn, inboundRaw, outboundRaw, ambiguousGroups })
  // Known inbounds are a lower bound; an unknown outbound or required amount proves nothing.
  if (outboundRaw == null || required == null) return result('unknown', 'unknown_amount')
  // More outbounds can only lower the net, so a shortfall on visible evidence stays a shortfall.
  if (inboundRaw - outboundRaw < required) return anyInboundUnknown ? result('unknown', 'unknown_amount') : result('insufficient', null)
  if (!outboundComplete) return result('unknown', 'outbound_history_incomplete')
  return result('covered', null)
}

const EXHAUSTED_STATUSES = new Set<StrictHistoryDirectionStatus>(['complete', 'empty'])

// Every outbound strictly before `bound` has been read: the query was exhausted, or (oldest-first,
// read contiguously from block 0) the last event read is at or after the bound. Hand-built results
// without an outbound status are never complete.
function outboundCoversBefore(history: AlchemyTokenHistoryStrictResult, bound: number): boolean {
  const status = history.outboundStatus
  if (status == null || status === 'not_requested' || status === 'unsupported') return false
  if (EXHAUSTED_STATUSES.has(status)) return true
  return history.order === 'asc' && history.outboundCoveredUntil != null && history.outboundCoveredUntil >= bound
}

// AS-OF-SELL LEDGER CHECK. Only with both directions exhausted and the sell located on chain by
// block/log: balance just before the sell = inbounds before it − outbounds before it, and it must be
// at least the sell's raw amount. A transfer whose position relative to the sell is unknown is
// treated conservatively (inbound left out, outbound counted). Anything less is `not_checked`.
function ledgerCheckBeforeSell(params: {
  history: AlchemyTokenHistoryStrictResult
  sell: UnmatchedEventIdentity
  walletAddress: string
  inbounds: readonly TransferHit[]
  outbounds: readonly TransferHit[]
}): InventoryLedgerCheck {
  const { history, sell } = params
  if (!EXHAUSTED_STATUSES.has(history.inboundStatus ?? 'not_requested')) return 'not_checked'
  if (!EXHAUSTED_STATUSES.has(history.outboundStatus ?? 'not_requested')) return 'not_checked'
  const sellRaw = parseRaw(sell.sellRaw ?? sell.amountRaw)
  if (sellRaw == null) return 'not_checked'
  const wallet = params.walletAddress.toLowerCase()
  const sellEvents = (history.outboundEvents ?? []).filter((e) =>
    (e.txHash ?? '').toLowerCase() === sell.txHash.toLowerCase()
    && (e.contract ?? '').toLowerCase() === sell.token.toLowerCase()
    && (e.fromAddress ?? '').toLowerCase() === wallet
    && e.blockNumber != null && e.logIndex != null)
  if (sellEvents.length === 0) return 'not_checked'
  const sellBlock = Math.min(...sellEvents.map((e) => e.blockNumber!))
  const sellLog = Math.min(...sellEvents.filter((e) => e.blockNumber === sellBlock).map((e) => e.logIndex!))
  // -1 before, 1 at/after, 0 unknown.
  const position = (hit: TransferHit): -1 | 0 | 1 => {
    if (hit.blockNumber != null) {
      if (hit.blockNumber !== sellBlock) return hit.blockNumber < sellBlock ? -1 : 1
      if (hit.logIndex != null) return hit.logIndex < sellLog ? -1 : 1
      return 0
    }
    if (hit.timestamp !== sell.timestamp) return hit.timestamp < sell.timestamp ? -1 : 1
    return 0
  }
  let balance = BigInt(0)
  for (const hit of mergeTransferSources(params.inbounds, 'inbound').hits) {
    if (position(hit) !== -1) continue
    if (hit.amountRaw == null) return 'not_checked'
    balance += hit.amountRaw
  }
  for (const hit of mergeTransferSources(params.outbounds, 'outbound').hits) {
    if (position(hit) === 1) continue
    if (hit.amountRaw == null) return 'not_checked'
    balance -= hit.amountRaw
  }
  return balance >= sellRaw ? 'passed' : 'inconsistent'
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
    // Local (in-window / recovered) data never holds the complete outbound history before the window
    // start, so pre-window inventory can only be proven after the provider history pass.
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
      const result = await params.fetchTokenHistory(chain, params.walletAddress, token, { coverUntilTimestamp: params.windowStartTimestamp })
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
      // No completed provider history: local evidence can show a shortfall, never coverage.
      const localAmount = evaluatePreWindowAmount(local.inbounds, local.outbounds, params.windowStartTimestamp, sell.timestamp, required, false)
      const localEvidence = localAmount.check !== 'not_applicable'
      rowsByKey.set(key, buildRow({
        ...base, hits: local.inbounds, preWindowHit: localAmount.preWindowHits[0] ?? null, amount: localEvidence ? localAmount : null,
        disposition: localAmount.check === 'insufficient' ? 'pre_window_inventory_insufficient' : 'still_unresolved_boundary',
        preWindowRecoveryAttempted: fetchAttempted, providerSource: fetchAttempted ? 'alchemy' : null,
        providerBoundaryDependency: true,
        targetedRecoveryOutcome: fetchAttempted ? 'timeout_or_failed' : 'not_attempted',
        history: history ?? null, outboundCoversPreWindow: false, ledgerCheck: 'not_checked',
      }))
      continue
    }

    const allInbounds = [...local.inbounds, ...collectProviderTransfers(history.events, sell, params.walletAddress, 'inbound')].sort(compareHits)
    const allOutbounds = [...local.outbounds, ...collectProviderTransfers(history.outboundEvents, sell, params.walletAddress, 'outbound')].sort(compareHits)
    const outboundCoversPreWindow = outboundCoversBefore(history, params.windowStartTimestamp)
    let amount = evaluatePreWindowAmount(allInbounds, allOutbounds, params.windowStartTimestamp, sell.timestamp, required, outboundCoversPreWindow)
    const ledgerCheck = amount.check === 'covered'
      ? ledgerCheckBeforeSell({ history, sell, walletAddress: params.walletAddress, inbounds: allInbounds, outbounds: allOutbounds })
      : 'not_checked'
    if (ledgerCheck === 'inconsistent') amount = { ...amount, check: 'unknown', blocker: 'ledger_inconsistent' }
    if (amount.check !== 'not_applicable') {
      // A pre-window inbound exists. An oldest-first page holds the earliest inbounds even when
      // capped, so the existence proof is conclusive; the amount check (inbounds minus outbounds
      // before the window start) decides the disposition.
      const covered = amount.check === 'covered'
      const outboundIncomplete = amount.blocker === 'outbound_history_incomplete'
      rowsByKey.set(key, buildRow({
        ...base, hits: allInbounds, preWindowHit: amount.preWindowHits[0] ?? null, amount,
        disposition: covered
          ? 'pre_window_inventory_exit_proven'
          : outboundIncomplete ? 'still_unresolved_boundary' : 'pre_window_inventory_insufficient',
        preWindowRecoveryAttempted: true, providerSource: amount.preWindowHits[0]?.source ?? 'alchemy', providerBoundaryDependency: true,
        targetedRecoveryOutcome: covered
          ? 'inbound_found'
          : outboundIncomplete ? 'outbound_history_incomplete' : history.inboundPageCapped ? 'page_capped' : 'inbound_found',
        history, outboundCoversPreWindow, ledgerCheck,
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
        history, outboundCoversPreWindow, ledgerCheck: 'not_checked',
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
      history, outboundCoversPreWindow, ledgerCheck: 'not_checked',
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
  history?: AlchemyTokenHistoryStrictResult | null
  outboundCoversPreWindow?: boolean
  ledgerCheck?: InventoryLedgerCheck
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
    preWindowAmountBlocker: amount?.blocker ?? null,
    inboundHistoryStatus: params.history ? params.history.inboundStatus ?? (params.history.inboundQueryOk ? 'complete' : 'failed') : null,
    outboundHistoryStatus: params.history ? params.history.outboundStatus ?? 'not_requested' : null,
    outboundCoversPreWindow: params.outboundCoversPreWindow ?? false,
    ledgerCheck: params.ledgerCheck ?? 'not_checked',
    ambiguousDuplicateGroups: amount?.ambiguousGroups ?? 0,
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
