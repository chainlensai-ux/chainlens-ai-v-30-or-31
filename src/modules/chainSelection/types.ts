// MODULE 3 — chainSelection: type definitions.
// Decides which chains get deep intelligence (Architecture Step 1 §2 / Step 6 §2).

import type { ProviderStatus, SupportedChain } from '../providerFetchWindow/types'

export type ChainGateStatus = 'active_intelligence' | 'dust_low_signal'

export type ChainGates = {
  valueGate: boolean
  activityGate: boolean
  swapGate: boolean
}

// Inputs to gate evaluation for a single chain. `visible_value_usd` and `swapCandidateEvents`
// are NOT computed by any module in this foundation delivery (holdings pricing and swap
// detection are future modules, explicitly out of scope here — see index.ts) — they are accepted
// as caller-supplied inputs, defaulting to 0 (the conservative/fails-the-gate default, per
// Architecture Step 7 §3) when not supplied.
export type ChainMetrics = {
  chain: SupportedChain
  visible_value_usd: number
  wallet_side_transactions: number
  swapCandidateEvents: number
}

export type ChainSelectionEntry = ChainMetrics & {
  gates: ChainGates
  status: ChainGateStatus
}

export type ChainSelectionResult = {
  chains: ChainSelectionEntry[]
  activeChainCount: number
  dustChainCount: number
}

export type ChainMetricsInput = {
  chain: SupportedChain
  providerStatus: ProviderStatus
  visibleValueUsd?: number
  swapCandidateEvents?: number
}

export const VALUE_GATE_THRESHOLD_USD = 5
