// MODULE — sellTimeline: pure helper functions. No provider calls anywhere in this file.

import type { ChainSelectionResult } from '../chainSelection/types'
import type { NormalizedEvent } from '../normalization/types'
import type { BridgeCandidateEvent } from '../bridgeDetection/types'
import type { SellChainContext, SellChainSelectionRef, SellConfidence } from './types'
import { mapChainGateStatus } from './types'

export function groupEventsByTx(normalizedEvents: NormalizedEvent[]): Map<string, NormalizedEvent[]> {
  const byTx = new Map<string, NormalizedEvent[]>()
  for (const event of normalizedEvents) {
    const group = byTx.get(event.txHash) ?? []
    group.push(event)
    byTx.set(event.txHash, group)
  }
  return byTx
}

export function activeChainSet(chainSelection: ChainSelectionResult): Set<string> {
  return new Set(chainSelection.chains.filter((c) => c.status === 'active_intelligence').map((c) => c.chain))
}

// Mirrors timelineBuilder's chainSelectionRefFor exactly, re-typed to this module's requested
// {status, gatesPassed} shape — same source data (chainSelection.chains[].gates/status), no new
// judgment introduced.
export function sellChainSelectionRefFor(chain: string, chainSelection: ChainSelectionResult): SellChainSelectionRef {
  const entry = chainSelection.chains.find((c) => c.chain === chain)
  if (!entry) return { status: 'excluded', gatesPassed: [] }
  const gatesPassed: string[] = []
  if (entry.gates.valueGate) gatesPassed.push('valueGate')
  if (entry.gates.activityGate) gatesPassed.push('activityGate')
  if (entry.gates.swapGate) gatesPassed.push('swapGate')
  return { status: mapChainGateStatus(entry.status), gatesPassed }
}

export function buildSellChainContext(chainSelection: ChainSelectionResult): SellChainContext {
  return {
    includedChains: chainSelection.chains.filter((c) => c.status === 'active_intelligence').map((c) => c.chain),
    excludedChains: chainSelection.chains.filter((c) => c.status === 'dust_low_signal').map((c) => c.chain),
  }
}

// An outbound event is "sell-shaped" (same-tx pairing, mechanism 1) only when the same tx has a
// paired wallet-side inbound leg of a DIFFERENT token — identical heuristic to timelineBuilder's
// isSellShaped, kept independent here per this project's "no runtime coupling between modules"
// convention for detection logic (as opposed to plain type re-use, which is fine and done above).
export function isSellShaped(event: NormalizedEvent, sameTxEvents: NormalizedEvent[]): boolean {
  return sameTxEvents.some((e) => e.direction === 'inbound' && e.contract.toLowerCase() !== event.contract.toLowerCase())
}

// Mechanism 1 (same-tx swap) / mechanism 2 (transfer-out to a known router) confidence, given only
// real signals: whether the tx was same-tx-paired, and whether the counterparty address is in a
// caller-supplied known-router set (empty by default — see index.ts's TODO on why no registry
// exists yet). Never invents a "router verified" signal beyond what the caller can actually supply.
export function outboundConfidence(sameTxPaired: boolean, counterpartyIsKnownRouter: boolean): SellConfidence | null {
  if (sameTxPaired) return counterpartyIsKnownRouter ? 'high' : 'medium'
  if (counterpartyIsKnownRouter) return 'medium' // mechanism 2: transfer-out to a known router
  return null // neither same-tx-shaped nor a known router — no real evidence this was a sell
}

export function dedupeKey(chain: string, txHash: string, contract: string, amount: string, counterparty: string | null): string {
  return `${chain}|${txHash}|${contract.toLowerCase()}|${amount}|${counterparty ?? ''}`
}

// Recovers the real contract address for a bridge-exit's chainFrom leg by matching the candidate's
// txHashFrom against the wallet's own normalized events on that chain. BridgeCandidateEvent only
// carries `token` as a symbol (see bridgeDetection/utils.ts), not a contract address — this join is
// how this module gets a real address instead of leaving `token` as a symbol duplicate or, worse,
// guessing one. Returns null (never a fabricated address) if no matching normalized event exists.
export function resolveBridgeExitContract(candidate: BridgeCandidateEvent, normalizedEvents: NormalizedEvent[]): string | null {
  const match = normalizedEvents.find(
    (e) => e.chain === candidate.chainFrom && e.txHash === candidate.txHashFrom && e.direction === 'outbound',
  )
  return match ? match.contract : null
}
