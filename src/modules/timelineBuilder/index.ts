// MODULE 4 — timelineBuilder
//
// Builds buyTimeline / sellTimeline / distributionTimeline as pure read models over already-
// normalized events, scoped to chainSelection-approved ("active_intelligence") chains only.
// No provider calls anywhere in this module (Architecture Step 3 §1, Step 8 §4).
//
// Classification honesty note (see types.ts "NOTE ON SCOPE"): without a swap-detection/router
// module, sell-vs-distribution and sourceType classification here are same-tx-pairing heuristics
// only. `confidence` on a sell entry never reaches "high" at this stage, and `usdValueEstimate` /
// `proceedsUsdEstimate` / `matchedBuyLotId` stay null placeholders — populating them for real is a
// future module's job, not this one's, per Architecture Step 9 §4 ("fifoEngine must never guess
// cost basis" applies equally to guessing evidence this module was never given).
//
// This same-tx heuristic is chain-agnostic and already applies to HyperEVM exactly as it does to
// base/eth/arbitrum — no chain-specific branch exists or is needed here.
// TODO: HyperEVM DEX router registry required for real swap detection (router-contract-address
// matching, not just same-tx pairing) — no verified HyperEVM DEX router addresses exist in this
// codebase or environment; do not fabricate one.

import type { ChainSelectionResult } from '../chainSelection/types'
import type { NormalizedEvent } from '../normalization/types'
import type {
  BuyTimeline,
  BuyTimelineEntry,
  DistributionTimeline,
  DistributionTimelineEntry,
  RecipientType,
  SellConfidence,
  SellTimeline,
  SellTimelineEntry,
  SourceType,
  TimelineBuilderResult,
} from './types'
import { ZERO_ADDRESS } from './types'
import { KNOWN_LABELS, activeChainSet, buildChainContext, chainSelectionRefFor, groupEventsByTx } from './utils'

export type {
  BuyTimeline,
  BuyTimelineEntry,
  ChainContext,
  ChainSelectionRef,
  DistributionTimeline,
  DistributionTimelineEntry,
  RecipientType,
  SellConfidence,
  SellTimeline,
  SellTimelineEntry,
  SourceType,
  TimelineBuilderResult,
} from './types'

// PURE. Classifies an inbound event's acquisition source.
//   - mint:     sender is the zero address
//   - swap:     same-tx wallet-side outbound leg of a DIFFERENT token exists (paired swap shape)
//   - airdrop:  inbound-only in this tx (no other wallet-side leg at all)
//   - transfer: fallback — inbound with other wallet-side activity in the same tx that isn't a
//               paired swap outbound (e.g. multiple inbound legs, no outbound)
export function classifySourceType(event: NormalizedEvent, sameTxEvents: NormalizedEvent[]): SourceType {
  if (event.fromAddress === ZERO_ADDRESS) return 'mint'

  const hasPairedOutbound = sameTxEvents.some(
    (e) => e.direction === 'outbound' && e.contract.toLowerCase() !== event.contract.toLowerCase(),
  )
  if (hasPairedOutbound) return 'swap'

  const hasOtherWalletSideLeg = sameTxEvents.some((e) => e !== event && e.direction !== 'unknown')
  if (!hasOtherWalletSideLeg) return 'airdrop'

  return 'transfer'
}

// PURE. Best-effort recipient labeling WITHOUT an RPC bytecode check (no provider calls are
// permitted in this module) — true EOA/contract detection requires an onchain getCode call, which
// is out of scope here. `knownContractAddresses` is an optional, caller-supplied hint set (e.g.
// from a future address-labeling module); when absent, every non-known-label address defaults to
// 'EOA' rather than guessing 'contract' without evidence.
export function classifyRecipientType(
  event: NormalizedEvent,
  knownContractAddresses?: ReadonlySet<string>,
): RecipientType {
  const recipient = event.toAddress.toLowerCase()
  if (KNOWN_LABELS[recipient]) return KNOWN_LABELS[recipient]
  if (knownContractAddresses?.has(recipient)) return 'contract'
  return 'EOA'
}

// PURE. An outbound event is classified as a sell only when the same tx has a paired wallet-side
// inbound leg of a DIFFERENT token (the same swap-shape signal classifySourceType uses for buys).
// This is the single decision point that also enforces mutual exclusivity with distributions —
// every outbound event passes through this exact check exactly once.
function isSellShaped(event: NormalizedEvent, sameTxEvents: NormalizedEvent[]): boolean {
  return sameTxEvents.some(
    (e) => e.direction === 'inbound' && e.contract.toLowerCase() !== event.contract.toLowerCase(),
  )
}

// Same-tx pairing without router/price confirmation is never "high" confidence at this stage —
// see the module-level scope note.
function sellConfidenceFor(): SellConfidence {
  return 'medium'
}

export function buildBuyTimeline(normalizedEvents: NormalizedEvent[], chainSelection: ChainSelectionResult): BuyTimeline {
  const activeChains = activeChainSet(chainSelection)
  const byTx = groupEventsByTx(normalizedEvents)
  const entries: BuyTimelineEntry[] = []

  for (const event of normalizedEvents) {
    if (event.direction !== 'inbound') continue
    if (!activeChains.has(event.chain)) continue

    const sameTxEvents = byTx.get(event.txHash) ?? [event]
    entries.push({
      timestamp: Date.parse(event.timestamp),
      chain: event.chain,
      token: event.contract,
      symbol: event.symbol,
      amount: String(event.amount),
      usdValueEstimate: null,
      sourceType: classifySourceType(event, sameTxEvents),
      txHash: event.txHash,
      chainSelectionRef: chainSelectionRefFor(event.chain, chainSelection),
    })
  }

  entries.sort((a, b) => a.timestamp - b.timestamp)
  return { totalBuys: entries.length, chainContext: buildChainContext(chainSelection), entries }
}

export function buildSellTimeline(normalizedEvents: NormalizedEvent[], chainSelection: ChainSelectionResult): SellTimeline {
  const activeChains = activeChainSet(chainSelection)
  const byTx = groupEventsByTx(normalizedEvents)
  const entries: SellTimelineEntry[] = []

  for (const event of normalizedEvents) {
    if (event.direction !== 'outbound') continue
    if (!activeChains.has(event.chain)) continue

    const sameTxEvents = byTx.get(event.txHash) ?? [event]
    if (!isSellShaped(event, sameTxEvents)) continue

    entries.push({
      timestamp: Date.parse(event.timestamp),
      chain: event.chain,
      token: event.contract,
      symbol: event.symbol,
      amount: String(event.amount),
      proceedsUsdEstimate: null,
      matchedBuyLotId: null,
      confidence: sellConfidenceFor(),
      txHash: event.txHash,
      chainSelectionRef: chainSelectionRefFor(event.chain, chainSelection),
    })
  }

  entries.sort((a, b) => a.timestamp - b.timestamp)
  return { totalSells: entries.length, chainContext: buildChainContext(chainSelection), entries }
}

export function buildDistributionTimeline(
  normalizedEvents: NormalizedEvent[],
  chainSelection: ChainSelectionResult,
  knownContractAddresses?: ReadonlySet<string>,
): DistributionTimeline {
  const activeChains = activeChainSet(chainSelection)
  const byTx = groupEventsByTx(normalizedEvents)
  const entries: DistributionTimelineEntry[] = []

  for (const event of normalizedEvents) {
    if (event.direction !== 'outbound') continue
    if (!activeChains.has(event.chain)) continue

    const sameTxEvents = byTx.get(event.txHash) ?? [event]
    if (isSellShaped(event, sameTxEvents)) continue // mutual exclusivity: never both sell AND distribution

    entries.push({
      timestamp: Date.parse(event.timestamp),
      chain: event.chain,
      token: event.contract,
      symbol: event.symbol,
      amount: String(event.amount),
      recipientAddress: event.toAddress,
      recipientType: classifyRecipientType(event, knownContractAddresses),
      txHash: event.txHash,
      chainSelectionRef: chainSelectionRefFor(event.chain, chainSelection),
    })
  }

  entries.sort((a, b) => a.timestamp - b.timestamp)
  return { totalDistributions: entries.length, chainContext: buildChainContext(chainSelection), entries }
}

export function buildTimelines(
  normalizedEvents: NormalizedEvent[],
  chainSelection: ChainSelectionResult,
  knownContractAddresses?: ReadonlySet<string>,
): TimelineBuilderResult {
  return {
    buyTimeline: buildBuyTimeline(normalizedEvents, chainSelection),
    sellTimeline: buildSellTimeline(normalizedEvents, chainSelection),
    distributionTimeline: buildDistributionTimeline(normalizedEvents, chainSelection, knownContractAddresses),
  }
}
