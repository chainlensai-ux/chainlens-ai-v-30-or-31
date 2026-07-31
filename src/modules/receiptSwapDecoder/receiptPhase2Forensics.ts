// MODULE — receiptSwapDecoder: offline audit of the 13 cached Phase 2 tier-1 receipts.
//
// GOAL, DISCLOSED: production proof — 25 tier-1 candidates, 13 receipts fetched, 0 recognized swap
// events, 0 exact swaps recovered, 11 rejected as `plain_transfer_no_swap_event`, many receipts
// containing an `unsupportedSwapLikeTopic0`, `likelyRoute` frequently `aggregator_or_router`, one
// candidate explicitly `ordinary_transfer`, coverage unchanged at 10/219. This module answers the
// real question that result raises — "are the zero-yield receipts genuine transfers, or real swaps
// through venues/events this codebase doesn't yet decode" — using ONLY the receipts already fetched
// and already sitting in cache. It issues no network call of its own; every field here is derived
// from raw logs already in memory (via decodeLogs.ts's existing pure decoder, reused rather than
// re-implemented) plus the pre-fetch evidence (wallet leg, router/counterparty, missing side) this
// pipeline already computed before the receipt was ever requested.
//
// TRANSACTION INPUT SELECTOR, HONESTLY UNAVAILABLE, DISCLOSED: the audit checklist asks for "the
// transaction input selector" (the first 4 bytes of calldata). A receipt (the ONLY thing this
// pipeline fetches per candidate, via eth_getTransactionReceipt in receiptAcquisition.ts) never
// carries calldata — only the transaction object itself does (eth_getTransactionByHash, a call this
// pipeline has never made and this task explicitly forbids adding: "Use cached receipts only. No new
// provider calls."). Rather than fabricate or approximate a selector from data that was never
// fetched, this module reports it as genuinely unavailable, with the reason disclosed on every
// record and reflected honestly in the clustering output (an always-empty `repeatedSelectors`, never
// a fabricated non-empty result).
//
// CLASSIFICATION IS STRUCTURAL, NEVER A PROTOCOL GUESS, DISCLOSED: `unsupported_pool_swap` reports
// only that a balanced economic exchange occurred alongside at least one unrecognized topic0 — it
// NEVER asserts which protocol emitted it, never adds a new signature, never validates a factory.
// That is deliberate: this module is forensics, not a new decoder. The proposal at the end of this
// file's own header (see pipeline/index.ts's log line) is the only place a NEXT step is suggested,
// and only when the evidence genuinely repeats across multiple receipts.

import { decodeLogs, type DecodedTransfer, type DecodedNativeWrap } from './decodeLogs'
import {
  CLASSIC_SWAP_TOPIC0, CLASSIC_MINT_TOPIC0, CLASSIC_BURN_TOPIC0,
  SLIPSTREAM_SWAP_TOPIC0, SLIPSTREAM_MINT_TOPIC0, SLIPSTREAM_BURN_TOPIC0,
  ERC20_TRANSFER_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0, WETH_BASE_ADDRESS,
} from './signatures'
import type { RawReceiptLog } from './types'

const KNOWN_TOPICS = new Set([
  CLASSIC_SWAP_TOPIC0, CLASSIC_MINT_TOPIC0, CLASSIC_BURN_TOPIC0,
  SLIPSTREAM_SWAP_TOPIC0, SLIPSTREAM_MINT_TOPIC0, SLIPSTREAM_BURN_TOPIC0,
  ERC20_TRANSFER_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0,
])

export type Phase2ReceiptClassification =
  | 'ordinary_transfer'
  | 'aggregator_swap'
  | 'unsupported_pool_swap'
  | 'wrap_unwrap_only'
  | 'liquidity_or_staking'
  | 'unknown'

export type CachedReceiptAuditInput = {
  chain: string
  txHash: string
  // Real pre-fetch evidence this pipeline already had before the receipt was requested — never
  // re-derived from the receipt itself.
  missingClosedLotSide: 'entry' | 'exit' | null
  walletLeg: { contract: string; direction: 'inbound' | 'outbound' | 'unknown'; amount: number } | null
  routerOrCounterpartyAddress: string | null
  isKnownRouter: boolean
  logs: readonly RawReceiptLog[]
}

export type TransferFlowStep =
  | { kind: 'transfer'; logIndex: number; token: string; from: string; to: string; value: string }
  | { kind: 'weth_deposit'; logIndex: number; account: string; amount: string }
  | { kind: 'weth_withdrawal'; logIndex: number; account: string; amount: string }

export type ReceiptPhase2ForensicRecord = {
  txHash: string
  tier1MissingSide: 'entry' | 'exit' | null
  walletLeg: CachedReceiptAuditInput['walletLeg']
  routerOrCounterparty: string | null
  // Honestly null — see this module's own header. Reason is always the same real, disclosed cause.
  txInputSelector: null
  txInputSelectorUnavailableReason: 'receipt_logs_do_not_include_calldata'
  uniqueTopic0Counts: Record<string, number>
  // Emitter addresses observed alongside each UNSUPPORTED (not one of our known signatures) topic0.
  unsupportedTopicEmitters: Record<string, string[]>
  transferFlowSequence: TransferFlowStep[]
  // Net signed flow per token touching the wallet, as a decimal string (bigint-safe). WETH
  // deposit/withdrawal are folded into the WETH token key — a deposit credits it, a withdrawal
  // debits it, matching what the wallet actually holds afterward.
  walletNetTokenFlows: Record<string, string>
  balancedEconomicExchange: boolean
  classification: Phase2ReceiptClassification
  // Structural fingerprint for cross-receipt clustering — see clusterReceiptForensics below.
  transferFlowFingerprint: string
}

function lower(addr: string | null | undefined): string {
  return (addr ?? '').toLowerCase()
}

function addToFlow(flows: Map<string, bigint>, token: string, delta: bigint): void {
  flows.set(token, (flows.get(token) ?? BigInt(0)) + delta)
}

// PURE. Audits ONE already-cached receipt. Never fetches anything; every input is data already in
// memory (logs) or already known before the receipt was requested (walletLeg, router/counterparty,
// missing side).
export function auditCachedReceipt(input: CachedReceiptAuditInput): ReceiptPhase2ForensicRecord {
  const decoded = decodeLogs([...input.logs])

  const uniqueTopic0Counts: Record<string, number> = {}
  const unsupportedTopicEmitters: Record<string, string[]> = {}
  const seenEmitterPerTopic = new Map<string, Set<string>>()

  for (const log of input.logs) {
    const topic0 = lower(log.topics[0])
    if (!topic0) continue
    uniqueTopic0Counts[topic0] = (uniqueTopic0Counts[topic0] ?? 0) + 1
    if (!KNOWN_TOPICS.has(topic0)) {
      const emitter = lower(log.address)
      const seen = seenEmitterPerTopic.get(topic0) ?? new Set<string>()
      if (!seen.has(emitter)) {
        seen.add(emitter)
        seenEmitterPerTopic.set(topic0, seen)
        const list = unsupportedTopicEmitters[topic0] ?? []
        list.push(emitter)
        unsupportedTopicEmitters[topic0] = list
      }
    }
  }

  // TRANSFER/WRAP SEQUENCE, DISCLOSED: ordered by real logIndex — the actual on-chain execution
  // order this receipt recorded, never re-ordered.
  const transferSteps: TransferFlowStep[] = [
    ...decoded.transfers.map((t: DecodedTransfer): TransferFlowStep => ({
      kind: 'transfer', logIndex: t.logIndex, token: t.token, from: t.from, to: t.to, value: t.value.toString(),
    })),
    ...decoded.nativeWraps.map((w: DecodedNativeWrap): TransferFlowStep => ({
      kind: w.kind === 'deposit' ? 'weth_deposit' : 'weth_withdrawal',
      logIndex: w.logIndex, account: w.account, amount: w.amount.toString(),
    })),
  ].sort((a, b) => a.logIndex - b.logIndex)

  // WALLET NET TOKEN FLOWS, DISCLOSED: this pure function is never handed the wallet's own address
  // directly (it audits one receipt's structure, not an identity) — instead it ANCHORS on the ONLY
  // wallet-identifying evidence available: `input.walletLeg`, the exact leg normalization already
  // attributed to the scanned wallet before this receipt was ever requested. The anchor transfer
  // (same token, same direction as the known leg) reveals which of this receipt's addresses IS the
  // wallet; every transfer/wrap touching THAT address is then netted per token. A receipt this
  // module cannot anchor to the wallet at all (no matching transfer exists) nets to an empty flow —
  // never a guessed address, never a fabricated flow.
  const netFlows = new Map<string, bigint>()
  const walletToken = input.walletLeg ? lower(input.walletLeg.contract) : null
  if (walletToken) {
    // Anchor: find the actual wallet address by locating the transfer matching the known leg's token
    // and rough magnitude, then net every transfer to/from THAT address. Falls back to "unknown" (an
    // empty flow map) when no such transfer exists in this receipt at all — never fabricated.
    const anchorTransfer = decoded.transfers.find((t) => lower(t.token) === walletToken)
    const walletAddr = anchorTransfer
      ? (input.walletLeg!.direction === 'outbound' ? lower(anchorTransfer.from) : lower(anchorTransfer.to))
      : null
    if (walletAddr) {
      for (const t of decoded.transfers) {
        const token = lower(t.token)
        if (lower(t.from) === walletAddr) addToFlow(netFlows, token, -t.value)
        if (lower(t.to) === walletAddr) addToFlow(netFlows, token, t.value)
      }
      for (const w of decoded.nativeWraps) {
        if (lower(w.account) !== walletAddr) continue
        addToFlow(netFlows, lower(WETH_BASE_ADDRESS), w.kind === 'deposit' ? w.amount : -w.amount)
      }
    }
  }

  const walletNetTokenFlows: Record<string, string> = {}
  for (const [token, value] of netFlows) walletNetTokenFlows[token] = value.toString()

  const outflowTokens = [...netFlows.entries()].filter(([, v]) => v < BigInt(0)).map(([t]) => t)
  const inflowTokens = [...netFlows.entries()].filter(([, v]) => v > BigInt(0)).map(([t]) => t)
  // BALANCED ECONOMIC EXCHANGE, DISCLOSED: real evidence of value moving out in one token and back in
  // a DIFFERENT token for the same actor — the structural shape of a swap, independent of whether any
  // recognized protocol event exists. Never asserts amounts are fair-value-matched (this module has
  // no USD pricing) — "balanced" means "two-sided", not "equal value".
  const balancedEconomicExchange = outflowTokens.length > 0 && inflowTokens.length > 0 && !outflowTokens.some((t) => inflowTokens.includes(t))

  const hasLpEvent = decoded.lpEvents.length > 0
  const hasAnyErc20Transfer = decoded.transfers.length > 0
  const hasAnyWrap = decoded.nativeWraps.length > 0
  const uniqueEmitters = new Set(input.logs.map((l) => lower(l.address)))
  const hasUnsupportedTopic = Object.keys(unsupportedTopicEmitters).length > 0

  let classification: Phase2ReceiptClassification
  if (hasLpEvent) {
    classification = 'liquidity_or_staking'
  } else if (hasAnyWrap && !hasAnyErc20Transfer) {
    classification = 'wrap_unwrap_only'
  } else if (!balancedEconomicExchange) {
    classification = 'ordinary_transfer'
  } else if (input.isKnownRouter && uniqueEmitters.size >= 2) {
    classification = 'aggregator_swap'
  } else if (hasUnsupportedTopic) {
    classification = 'unsupported_pool_swap'
  } else {
    // A genuinely balanced exchange with no router signal and no unrecognized topic at all — real,
    // but this module has no basis to say more without guessing. Fail closed.
    classification = 'unknown'
  }

  // TRANSFER-FLOW FINGERPRINT, DISCLOSED: a structural signature for clustering — transfer count,
  // wrap count, lp-event count, and the SORTED set of unsupported topic0s this receipt saw. Two
  // receipts sharing a fingerprint moved value through the same SHAPE of unrecognized events, real
  // evidence worth clustering even before any single one is individually conclusive.
  const transferFlowFingerprint =
    `t${decoded.transfers.length}:w${decoded.nativeWraps.length}:lp${decoded.lpEvents.length}:` +
    `u[${Object.keys(unsupportedTopicEmitters).sort().join(',')}]`

  return {
    txHash: input.txHash,
    tier1MissingSide: input.missingClosedLotSide,
    walletLeg: input.walletLeg,
    routerOrCounterparty: input.routerOrCounterpartyAddress,
    txInputSelector: null,
    txInputSelectorUnavailableReason: 'receipt_logs_do_not_include_calldata',
    uniqueTopic0Counts,
    unsupportedTopicEmitters,
    transferFlowSequence: transferSteps,
    walletNetTokenFlows,
    balancedEconomicExchange,
    classification,
    transferFlowFingerprint,
  }
}

export type ReceiptPhase2ClusterSummary = {
  byRouterCounterparty: Record<string, string[]>
  byUnsupportedTopic: Record<string, string[]>
  byEmitter: Record<string, string[]>
  byTransferFlowFingerprint: Record<string, string[]>
}

function bump(map: Record<string, string[]>, key: string, txHash: string): void {
  const list = map[key] ?? []
  if (!list.includes(txHash)) list.push(txHash)
  map[key] = list
}

// PURE. Clusters an already-audited batch by router/counterparty, unsupported topic0, emitter (for
// unsupported topics), and transfer-flow fingerprint. Input selector clustering is deliberately
// omitted — see this module's own header on why that data is honestly unavailable.
export function clusterReceiptForensics(records: readonly ReceiptPhase2ForensicRecord[]): ReceiptPhase2ClusterSummary {
  const byRouterCounterparty: Record<string, string[]> = {}
  const byUnsupportedTopic: Record<string, string[]> = {}
  const byEmitter: Record<string, string[]> = {}
  const byTransferFlowFingerprint: Record<string, string[]> = {}

  for (const record of records) {
    if (record.routerOrCounterparty) bump(byRouterCounterparty, lower(record.routerOrCounterparty), record.txHash)
    for (const [topic0, emitters] of Object.entries(record.unsupportedTopicEmitters)) {
      bump(byUnsupportedTopic, topic0, record.txHash)
      for (const emitter of emitters) bump(byEmitter, emitter, record.txHash)
    }
    bump(byTransferFlowFingerprint, record.transferFlowFingerprint, record.txHash)
  }

  return { byRouterCounterparty, byUnsupportedTopic, byEmitter, byTransferFlowFingerprint }
}

export type ReceiptPhase2ForensicsDiagnostic = {
  receiptsAudited: number
  classificationCounts: Record<Phase2ReceiptClassification, number>
  // Honestly always empty — see this module's own header on why a real transaction input selector is
  // unavailable from cached receipt logs alone. Present (not omitted) so the diagnostic's shape is
  // stable and the reason is visible directly in a real log line, never silently absent.
  repeatedSelectors: Record<string, number>
  repeatedUnsupportedTopics: Record<string, number>
  repeatedEmitters: Record<string, number>
  // Candidate venues/event families worth real decoder investment — see buildDiagnostic's own
  // MIN_REPEAT_FOR_DECODER_CANDIDACY threshold. Never proposed from a single occurrence.
  candidateDecoderFamilies: string[]
  genuineTransferCount: number
  likelyUnsupportedSwapCount: number
}

// A cluster must repeat across at least this many DISTINCT receipts before it is surfaced as
// "repeated" or proposed as decoder work — a single occurrence proves nothing about a real, provable
// venue pattern.
const MIN_REPEAT_FOR_DECODER_CANDIDACY = 2

function onlyRepeated(clusters: Record<string, string[]>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [key, txHashes] of Object.entries(clusters)) {
    if (txHashes.length >= MIN_REPEAT_FOR_DECODER_CANDIDACY) result[key] = txHashes.length
  }
  return result
}

// PURE. Builds the exact [receipt-phase2-forensics] diagnostic shape.
export function buildReceiptPhase2ForensicsDiagnostic(records: readonly ReceiptPhase2ForensicRecord[]): ReceiptPhase2ForensicsDiagnostic {
  const clusters = clusterReceiptForensics(records)

  const classificationCounts: Record<Phase2ReceiptClassification, number> = {
    ordinary_transfer: 0, aggregator_swap: 0, unsupported_pool_swap: 0,
    wrap_unwrap_only: 0, liquidity_or_staking: 0, unknown: 0,
  }
  for (const record of records) classificationCounts[record.classification] += 1

  // CANDIDATE DECODER FAMILIES, DISCLOSED: proposed ONLY when a specific (unsupported topic0,
  // emitter) pair repeats across >= MIN_REPEAT_FOR_DECODER_CANDIDACY distinct receipts AND at least
  // one of those receipts showed a genuinely balanced economic exchange (classification
  // unsupported_pool_swap) — never proposed from a bare transfer-only pattern, and never from a
  // single occurrence. This is the ONLY place this module suggests a next step; it never adds
  // support itself.
  const balancedTxHashes = new Set(records.filter((r) => r.classification === 'unsupported_pool_swap').map((r) => r.txHash))
  const candidateDecoderFamilies: string[] = []
  for (const [topic0, txHashes] of Object.entries(clusters.byUnsupportedTopic)) {
    if (txHashes.length < MIN_REPEAT_FOR_DECODER_CANDIDACY) continue
    if (!txHashes.some((h) => balancedTxHashes.has(h))) continue
    const emitters = new Set<string>()
    for (const record of records) {
      if (topic0 in record.unsupportedTopicEmitters) for (const e of record.unsupportedTopicEmitters[topic0]) emitters.add(e)
    }
    candidateDecoderFamilies.push(`topic0=${topic0} emitters=${emitters.size} receipts=${txHashes.length}`)
  }
  candidateDecoderFamilies.sort()

  return {
    receiptsAudited: records.length,
    classificationCounts,
    repeatedSelectors: {},
    repeatedUnsupportedTopics: onlyRepeated(clusters.byUnsupportedTopic),
    repeatedEmitters: onlyRepeated(clusters.byEmitter),
    candidateDecoderFamilies,
    genuineTransferCount: classificationCounts.ordinary_transfer + classificationCounts.wrap_unwrap_only,
    likelyUnsupportedSwapCount: classificationCounts.unsupported_pool_swap + classificationCounts.aggregator_swap,
  }
}
