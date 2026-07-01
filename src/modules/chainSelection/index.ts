// MODULE 3 — chainSelection
//
// Decides which chains earn deep intelligence processing vs. get parked as dust/low-signal
// (Architecture Step 1 §2, Step 6 §2, Step 8 §2). Pure — no provider calls.
//
// NOTE ON SCOPE: this delivery does not include holdings-pricing or swap-detection modules, so
// `visible_value_usd` and `swapCandidateEvents` cannot be computed from normalizedEvents alone —
// they are accepted as optional caller-supplied inputs (via ChainMetricsInput), defaulting to 0
// per Architecture Step 7 §3's "uncomputable defaults to the conservative (fails-the-gate) value"
// rule. `wallet_side_transactions` IS computable from normalized events alone and is derived here.

import type { NormalizedEvent } from '../normalization/types'
import type { ProviderStatus, SupportedChain } from '../providerFetchWindow/types'
import type {
  ChainGates,
  ChainMetrics,
  ChainMetricsInput,
  ChainSelectionEntry,
  ChainSelectionResult,
} from './types'
import { VALUE_GATE_THRESHOLD_USD } from './types'
import { countWalletSideTransactions } from './utils'

export type {
  ChainGates,
  ChainGateStatus,
  ChainMetrics,
  ChainMetricsInput,
  ChainSelectionEntry,
  ChainSelectionResult,
} from './types'
export { VALUE_GATE_THRESHOLD_USD } from './types'

// PURE. Computes the three raw gate metrics for a single chain.
export function computeChainMetrics(
  normalizedEvents: NormalizedEvent[],
  input: ChainMetricsInput,
): ChainMetrics {
  return {
    chain: input.chain,
    visible_value_usd: typeof input.visibleValueUsd === 'number' && Number.isFinite(input.visibleValueUsd)
      ? input.visibleValueUsd
      : 0,
    wallet_side_transactions: countWalletSideTransactions(normalizedEvents, input.chain),
    swapCandidateEvents: typeof input.swapCandidateEvents === 'number' && Number.isFinite(input.swapCandidateEvents)
      ? input.swapCandidateEvents
      : 0,
  }
}

// PURE. Evaluates the three gates against fixed thresholds (Architecture Step 1 §2):
//   valueGate:    visible_value_usd >= 5
//   activityGate: wallet_side_transactions > 0
//   swapGate:     swapCandidateEvents > 0
export function evaluateGates(metrics: ChainMetrics): ChainGates {
  return {
    valueGate: metrics.visible_value_usd >= VALUE_GATE_THRESHOLD_USD,
    activityGate: metrics.wallet_side_transactions > 0,
    swapGate: metrics.swapCandidateEvents > 0,
  }
}

// PURE. Builds the full chainSelection object across all requested chains.
//   - passing ANY gate -> active_intelligence
//   - passing NONE     -> dust_low_signal
//   - provider_unavailable -> dust_low_signal, unconditionally (overrides gate results)
export function buildChainSelectionObject(
  normalizedEvents: NormalizedEvent[],
  chainInputs: Array<ChainMetricsInput & { providerStatus: ProviderStatus }>,
): ChainSelectionResult {
  const chains: ChainSelectionEntry[] = chainInputs.map((input) => {
    const metrics = computeChainMetrics(normalizedEvents, input)
    const gates = evaluateGates(metrics)
    const passesAnyGate = gates.valueGate || gates.activityGate || gates.swapGate
    const status = input.providerStatus === 'provider_unavailable'
      ? 'dust_low_signal'
      : passesAnyGate
        ? 'active_intelligence'
        : 'dust_low_signal'
    return { ...metrics, gates, status }
  })

  const activeChainCount = chains.filter((c) => c.status === 'active_intelligence').length
  const dustChainCount = chains.filter((c) => c.status === 'dust_low_signal').length

  return { chains, activeChainCount, dustChainCount }
}

export type { SupportedChain }
