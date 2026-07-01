// MODULE — bridgeDetection: type definitions.
//
// NOTE ON SCOPE (mirrors timelineBuilder's own documented approach to swap detection): this module
// detects bridge CANDIDATES via a same-wallet, cross-chain, same-token, amount-and-time-proximity
// heuristic over already-normalized events. It does NOT integrate a bridge-contract registry (no
// verified LayerZero/Across/Stargate/native-bridge contract address list exists anywhere in this
// codebase, and inventing one here would be fabricating data this project's own conventions
// forbid). A detected pair is always labeled a "candidate" with a confidence basis, never asserted
// as a confirmed bridge transaction.
//
// Chain-agnostic by construction — chainFrom/chainTo are just whichever two distinct
// SupportedChain values the matched legs happen to carry, so Base <-> Arbitrum <-> HyperEVM (and
// any other pair among base/eth/arbitrum/hyperevm) are all already in scope with no code change.
// In practice a HyperEVM leg only appears once real HyperEVM events exist to feed this module (see
// providerFetchWindow's HyperEVM provider-support gap) — this module itself has no chain allowlist.

import type { NormalizedEvent } from '../normalization/types'
import type { SupportedChain } from '../providerFetchWindow/types'

export type BridgeConfidence = 'high' | 'medium' | 'low'

export type BridgeCandidateEvent = {
  type: 'bridge'
  chainFrom: SupportedChain
  chainTo: SupportedChain
  token: string
  amount: number
  timestamp: string
  txHashFrom: string
  txHashTo: string
  confidence: BridgeConfidence
  // Human-readable justification for `confidence` — e.g. "same symbol, amount within 0.5%, 4m
  // apart" — so a caller never has to reverse-engineer why a pair was matched.
  basis: string
}

export type BridgeDetectionResult = {
  bridgeTimeline: BridgeCandidateEvent[]
}

// Matching tolerances. Deliberately conservative — a wider window/tolerance increases false
// positives (two unrelated transfers coincidentally lining up), which is worse than under-detecting
// here since every candidate is presented to the caller as fact-shaped data.
export const BRIDGE_MATCH_WINDOW_MS = 60 * 60 * 1000 // 60 minutes between legs
export const BRIDGE_AMOUNT_TOLERANCE_PCT = 0.03 // up to 3% difference tolerated (bridge/gas fees)
