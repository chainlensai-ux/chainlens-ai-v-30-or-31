// MODULE — sellTimeline
//
// Reconstructs sell events across every chain chainSelection admits to active intelligence
// (Architecture-style rule carried over from timelineBuilder: distributionTimeline/dust chains
// never feed this module — only active_intelligence chains do, enforced by activeChainSet below).
// Pure — no provider calls of its own; consumes already-fetched/normalized data from
// normalization, chainSelection, bridgeDetection, and recoveryPolicy.
//
// STANDALONE BY DESIGN: this does NOT replace timelineBuilder's existing `timelines.sellTimeline`
// (already consumed by fifoEngine, behaviorIntel, and the wallet-scanner UI). It is offered as a
// separate, richer read model — wiring it into the pipeline as either an additive new report field
// or a replacement is an explicit integration decision for a follow-up task, not made here.
//
// FOUR MECHANISMS, WHAT'S REAL VS. TODO:
//   1. Swap-based sells        — REAL: same-tx pairing heuristic over normalizedEvents (identical
//                                 evidence timelineBuilder already uses for buys/sells).
//   2. Transfer-out sells      — REAL, but only for the "router known" branch: an outbound event to
//                                 an address in the caller-supplied `knownDexRouterAddresses` set.
//                                 The "low = unknown contract" branch from the spec is NOT
//                                 implemented — classifying an arbitrary address as "a contract
//                                 with a swap signature" requires an RPC getCode/ABI check, which
//                                 is out of scope for this pure module (same limitation
//                                 timelineBuilder's classifyRecipientType already documents).
//   3. Bridge-exit sells       — REAL: consumes bridgeDetection's actual BridgeCandidateEvent[],
//                                 cross-referenced against normalizedEvents to recover the real
//                                 contract address. Always "high" confidence because a candidate
//                                 only exists when both legs were matched — bridgeDetection has no
//                                 code path for a one-sided ("medium") bridge exit today.
//   4. Recovery-reconstructed  — REAL: applies the same mechanism-1/2 heuristic to
//                                 recoveryPolicy.evaluation[].recoveredEvents (actual historical
//                                 events recoveryPolicy fetched), forced to "low" confidence. The
//                                 spec's balance-gap-inference variant (buy exists, holdings
//                                 reduced, zero transfer evidence at all) is NOT implemented —
//                                 asserting a sell transaction with a guessed timestamp/txHash from
//                                 a balance delta alone would be fabrication, not reconstruction.

import type { ChainSelectionResult } from '../chainSelection/types'
import type { NormalizedEvent } from '../normalization/types'
import { normalizeEvents } from '../normalization/index'
import type { BridgeCandidateEvent } from '../bridgeDetection/types'
import type { RecoveryPolicyResult } from '../recoveryPolicy/types'
import type { SellTimelineEntry, SellTimelineResult } from './types'
import {
  activeChainSet,
  buildSellChainContext,
  dedupeKey,
  groupEventsByTx,
  isSellShaped,
  outboundConfidence,
  resolveBridgeExitContract,
  sellChainSelectionRefFor,
} from './utils'

export type { SellChainContext, SellChainSelectionRef, SellChainSelectionStatus, SellConfidence, SellTimelineEntry, SellTimelineResult } from './types'

export type BuildSellTimelineParams = {
  normalizedEvents: NormalizedEvent[]
  chainSelection: ChainSelectionResult
  bridgeTimeline: BridgeCandidateEvent[]
  recoveryPolicy: RecoveryPolicyResult
  walletAddress: string
  // Optional, caller-supplied known-DEX-router addresses (lowercased). Empty by default — no
  // router registry exists anywhere in this codebase for any chain (see TODOs below), so mechanism
  // 2 and the "router verified" upgrade to mechanism 1 both honestly produce nothing until a real
  // registry is supplied.
  knownDexRouterAddresses?: ReadonlySet<string>
}

// TODO: HyperEVM DEX router registry required for real swap detection
// TODO: HyperEVM LP/staking/yield detection requires verified contract registry
// TODO: Plasma chain support requires verified RPC + router registry

// Mechanisms 1 + 2 share one per-event decision: is this outbound event same-tx-swap-shaped
// (mechanism 1) or a transfer-out to a known router (mechanism 2)? Both share the same output
// shape, so they're evaluated together per event rather than as two separate passes.
function buildEntriesFromOutboundEvents(
  events: NormalizedEvent[],
  chainSelection: ChainSelectionResult,
  knownDexRouterAddresses: ReadonlySet<string>,
  confidenceOverride?: 'low',
): SellTimelineEntry[] {
  const activeChains = activeChainSet(chainSelection)
  const byTx = groupEventsByTx(events)
  const entries: SellTimelineEntry[] = []

  for (const event of events) {
    if (event.direction !== 'outbound') continue
    if (!activeChains.has(event.chain)) continue // respects chainSelection gating

    const sameTxEvents = byTx.get(event.txHash) ?? [event]
    const sameTxPaired = isSellShaped(event, sameTxEvents)
    const counterpartyIsKnownRouter = knownDexRouterAddresses.has(event.toAddress.toLowerCase())

    const confidence = outboundConfidence(sameTxPaired, counterpartyIsKnownRouter)
    if (!confidence) continue // no real evidence this outbound transfer was a sell — never guessed

    entries.push({
      timestamp: Date.parse(event.timestamp),
      chain: event.chain,
      token: event.contract,
      symbol: event.symbol ?? null,
      amount: String(event.amount),
      proceedsUsdEstimate: null, // no pricing-at-time module exists yet — never guessed
      matchedBuyLotId: null, // lot matching is fifoEngine's job, never guessed here
      confidence: confidenceOverride ?? confidence,
      txHash: event.txHash,
      chainSelectionRef: sellChainSelectionRefFor(event.chain, chainSelection),
      counterparty: event.toAddress.toLowerCase(),
    })
  }

  return entries
}

// Mechanism 3: bridge-exit sells, from bridgeDetection's real candidates.
function buildBridgeExitEntries(
  bridgeTimeline: BridgeCandidateEvent[],
  normalizedEvents: NormalizedEvent[],
  chainSelection: ChainSelectionResult,
): SellTimelineEntry[] {
  const activeChains = activeChainSet(chainSelection)
  const entries: SellTimelineEntry[] = []

  for (const candidate of bridgeTimeline) {
    if (!activeChains.has(candidate.chainFrom)) continue // respects chainSelection gating

    const contract = resolveBridgeExitContract(candidate, normalizedEvents)
    if (!contract) continue // no matching normalized event on this chain — no fabricated address

    entries.push({
      timestamp: Date.parse(candidate.timestamp),
      chain: candidate.chainFrom,
      token: contract,
      symbol: candidate.token, // bridgeDetection's `token` field is the symbol, not a contract
      amount: String(candidate.amount),
      proceedsUsdEstimate: null,
      matchedBuyLotId: null,
      // Always "high": a BridgeCandidateEvent only exists once both legs are matched (see module
      // header) — there is no "one leg detected" code path today to justify "medium" honestly.
      confidence: 'high',
      txHash: candidate.txHashFrom,
      chainSelectionRef: sellChainSelectionRefFor(candidate.chainFrom, chainSelection),
      counterparty: null,
    })
  }

  return entries
}

// Mechanism 4: recovery-reconstructed sells. Normalizes recoveryPolicy's real recoveredEvents (only
// present for tokens where recovery actually triggered) and applies the same mechanism-1/2
// heuristic to them, forced to "low" confidence per the spec.
function buildRecoveryReconstructedEntries(
  recoveryPolicy: RecoveryPolicyResult,
  chainSelection: ChainSelectionResult,
  walletAddress: string,
  knownDexRouterAddresses: ReadonlySet<string>,
): SellTimelineEntry[] {
  const recoveredRawEvents = recoveryPolicy.evaluation
    .filter((e) => e.recoveryTriggered)
    .flatMap((e) => e.recoveredEvents)

  if (recoveredRawEvents.length === 0) return []

  const { normalizedEvents: recoveredNormalized } = normalizeEvents(recoveredRawEvents, walletAddress)
  return buildEntriesFromOutboundEvents(recoveredNormalized, chainSelection, knownDexRouterAddresses, 'low')
}

// PURE. Assembles the full sellTimeline, deduping across mechanisms so a single real transfer
// never produces more than one entry — priority order: bridge-exit (cross-chain corroborated) >
// same-tx/transfer-out (base window) > recovery-reconstructed (historical, lowest confidence).
export function buildSellTimeline(params: BuildSellTimelineParams): SellTimelineResult {
  const knownDexRouterAddresses = params.knownDexRouterAddresses ?? new Set<string>()

  const bridgeExitEntries = buildBridgeExitEntries(params.bridgeTimeline, params.normalizedEvents, params.chainSelection)
  const baseWindowEntries = buildEntriesFromOutboundEvents(params.normalizedEvents, params.chainSelection, knownDexRouterAddresses)
  const recoveryEntries = buildRecoveryReconstructedEntries(params.recoveryPolicy, params.chainSelection, params.walletAddress, knownDexRouterAddresses)

  const seen = new Set<string>()
  const entries: SellTimelineEntry[] = []
  for (const candidateEntries of [bridgeExitEntries, baseWindowEntries, recoveryEntries]) {
    for (const entry of candidateEntries) {
      const key = dedupeKey(entry.chain, entry.txHash, entry.token, entry.amount, entry.counterparty)
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
  }

  entries.sort((a, b) => a.timestamp - b.timestamp)

  return {
    totalSells: entries.length,
    chainContext: buildSellChainContext(params.chainSelection),
    entries,
  }
}
