// MODULE 4 — timelineBuilder: pure helper functions.

import type { ChainSelectionResult } from '../chainSelection/types'
import type { NormalizedEvent } from '../normalization/types'
import type { ChainContext, ChainSelectionRef } from './types'

// A small, explicit, non-exhaustive label map — this is NOT address-book/identity intelligence,
// just a handful of universally-recognized addresses that let distributionTimeline surface a
// friendlier label than a bare "EOA"/"contract" guess. Never used for anything beyond display.
export const KNOWN_LABELS: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'Burn',
  '0x000000000000000000000000000000000000dead': 'Burn',
}

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

export function chainSelectionRefFor(chain: string, chainSelection: ChainSelectionResult): ChainSelectionRef {
  const entry = chainSelection.chains.find((c) => c.chain === chain)
  if (!entry) return { status: 'dust_low_signal', gatesPassed: [] }
  const gatesPassed: string[] = []
  if (entry.gates.valueGate) gatesPassed.push('valueGate')
  if (entry.gates.activityGate) gatesPassed.push('activityGate')
  if (entry.gates.swapGate) gatesPassed.push('swapGate')
  return { status: entry.status, gatesPassed }
}

// Shared chainContext block (Architecture Step 3 §1) — computed once per timeline, not per entry.
export function buildChainContext(chainSelection: ChainSelectionResult): ChainContext {
  const includedChains = chainSelection.chains
    .filter((c) => c.status === 'active_intelligence')
    .map((c) => c.chain)
  const excludedChains = chainSelection.chains
    .filter((c) => c.status === 'dust_low_signal')
    .map((c) => ({
      chain: c.chain,
      status: c.status,
      reason: c.gates.valueGate || c.gates.activityGate || c.gates.swapGate
        ? 'provider_unavailable'
        : 'failed_all_gates',
    }))
  return { includedChains, excludedChains }
}
