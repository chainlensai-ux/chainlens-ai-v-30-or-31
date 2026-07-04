// src/modules/reasonEngine/index.ts — Reason Engine implementation.
//
// INPUT-SHAPE DISCLOSURE: the task described the engine as receiving "swapNormalizer output" /
// "fifoEngine output" directly, but this codebase has TWO separate, coexisting FIFO/PnL
// implementations (src/modules/fifoEngine, used by the Path A Deep Scan pipeline, vs.
// src/modules/lotOpener+lotCloser, this session's separate Path B chain — see
// docs/wallet-scanner-safety-audit.md's risk #6 for the full disclosure on why these two exist
// side by side). Binding this new engine's input type tightly to either one's raw output shape
// would silently make it usable from only one of the two paths. Instead, this file accepts the
// smaller set of ALREADY-DERIVED values every condition in requirement #4 actually needs (counts,
// token lists, the two real PnL summary types, and plain diagnostic-status strings) — a caller from
// EITHER path can compute these from its own real data without this engine needing to know which
// path produced them. `RealizedPnlSummary` (src/modules/realizedPnl) and `UnrealizedPnlResult`
// (lib/engines/unrealizedPnlEngine) are imported directly since the task named those two summary
// types specifically and they're real, unambiguous, single implementations.
//
// CONDITION/THRESHOLD DISCLOSURE: the task lists condition names ("dust-only activity", "dormant
// wallet", etc.) and example strings, but does not define the exact boundary for "dust" or
// "dormant," and does not define how `confidence` should count "signals." Both are implemented here
// as documented, honest heuristics (see comments at each), not fabricated as if they were precise
// external rules — worth tuning once real wallet data is available to validate against.

import type { RealizedPnlSummary } from '../realizedPnl'
import type { UnrealizedPnlResult } from '@/lib/engines/unrealizedPnlEngine'
import type { ReasonEngineOutput } from './types'

export type ReasonEngineInputs = {
  swapCount: number
  closedLotsCount: number
  transferCount: number
  lpActionCount: number
  contractCallCount: number
  bridgeActionCount: number
  realizedPnl: RealizedPnlSummary | null
  unrealizedPnl: UnrealizedPnlResult | null
  tradedTokens: string[]
  heldTokens: string[]
  pricedTokens: string[]
  unpricedTokens: string[]
  metadataStatus?: string
  pricingStatus?: string
  swapNormalizerStatus?: string
  fifoStatus?: string
}

type Classification = {
  reason: string
  behavior: string
  evidence: string[]
  guidance: string
  /** How many of the boolean condition checks below agree with this classification — the
   *  numerator of the confidence = matchedSignals / totalSignals rule (requirement #8). */
  matchedSignals: number
}

const UNKNOWN_STATUS = 'unknown'

function safeArray(value: string[] | undefined | null): string[] {
  return Array.isArray(value) ? value : []
}

// Every boolean check this engine evaluates, in priority order — used both to pick the
// classification (first match wins) and, independently, to score confidence (how many of ALL of
// these checks hold true for this wallet, not just the one that was picked — a wallet that matches
// several checks at once, e.g. "no swaps" AND "dormant," is a MORE confidently-classified case than
// one where only a single check happens to be true).
function evaluateSignals(inputs: ReasonEngineInputs) {
  const hasNoActivityAtAll =
    inputs.swapCount === 0 &&
    inputs.transferCount === 0 &&
    inputs.lpActionCount === 0 &&
    inputs.contractCallCount === 0 &&
    inputs.bridgeActionCount === 0

  const onlyTransfers =
    inputs.transferCount > 0 && inputs.swapCount === 0 && inputs.lpActionCount === 0 &&
    inputs.contractCallCount === 0 && inputs.bridgeActionCount === 0

  const onlyLpActions =
    inputs.lpActionCount > 0 && inputs.swapCount === 0 && inputs.transferCount === 0 &&
    inputs.contractCallCount === 0 && inputs.bridgeActionCount === 0

  const onlyContractCalls =
    inputs.contractCallCount > 0 && inputs.swapCount === 0 && inputs.transferCount === 0 &&
    inputs.lpActionCount === 0 && inputs.bridgeActionCount === 0

  const onlyBridgeActions =
    inputs.bridgeActionCount > 0 && inputs.swapCount === 0 && inputs.transferCount === 0 &&
    inputs.lpActionCount === 0 && inputs.contractCallCount === 0

  // DUST-ONLY HEURISTIC, DISCLOSED: no precise "dust" threshold was specified. Defined here as
  // "some activity happened, but not a single traded/held token ever resolved a real price" — i.e.
  // there is no evidence any of this wallet's activity ever touched anything of ascertainable
  // value. Requires at least one traded or held token to exist (otherwise it's dormant, not dust).
  const totalTokensSeen = new Set([...safeArray(inputs.tradedTokens), ...safeArray(inputs.heldTokens)]).size
  const isDustOnly =
    !hasNoActivityAtAll &&
    totalTokensSeen > 0 &&
    safeArray(inputs.pricedTokens).length === 0

  const hasSwapsNoCloses = inputs.swapCount > 0 && inputs.closedLotsCount === 0

  const hasClosesZeroPnl =
    inputs.closedLotsCount > 0 &&
    inputs.realizedPnl !== null &&
    inputs.realizedPnl.totalRealizedPnl === 0

  const isNormalTrading =
    inputs.closedLotsCount > 0 &&
    inputs.realizedPnl !== null &&
    inputs.realizedPnl.totalRealizedPnl !== 0

  return {
    hasNoActivityAtAll,
    onlyTransfers,
    onlyLpActions,
    onlyContractCalls,
    onlyBridgeActions,
    isDustOnly,
    hasSwapsNoCloses,
    hasClosesZeroPnl,
    isNormalTrading,
  }
}

// Classification rules, in priority order — the first one whose condition is true wins. Order
// matters: e.g. a fully-inactive wallet must be classified "dormant" before "no closable trades"
// (which would otherwise also technically be true — 0 swaps implies 0 closes).
function classify(inputs: ReasonEngineInputs): Classification {
  const signals = evaluateSignals(inputs)
  const totalTrue = Object.values(signals).filter(Boolean).length

  if (signals.hasNoActivityAtAll) {
    return {
      reason: 'Dormant wallet',
      behavior: 'dormant',
      evidence: ['0 swaps detected', '0 transfers detected', '0 contract calls detected', '0 bridge actions detected'],
      guidance: 'This wallet is dormant and has no recent activity.',
      matchedSignals: totalTrue,
    }
  }

  if (signals.isDustOnly) {
    return {
      reason: 'Dust-only wallet',
      behavior: 'dust-only',
      evidence: [`${safeArray(inputs.tradedTokens).length + safeArray(inputs.heldTokens).length} token(s) seen, 0 priced`],
      guidance: 'This wallet only shows dust-level activity with no ascertainable token value.',
      matchedSignals: totalTrue,
    }
  }

  if (signals.onlyTransfers) {
    return {
      reason: 'Only transfers detected',
      behavior: 'transfers-only',
      evidence: ['All actions are transfers', `${inputs.transferCount} transfer(s) detected`],
      guidance: 'This wallet does not trade, so PnL cannot be computed.',
      matchedSignals: totalTrue,
    }
  }

  if (signals.onlyLpActions) {
    return {
      reason: 'Only LP actions detected',
      behavior: 'lp-only',
      evidence: ['Only LP deposit/withdraw actions', `${inputs.lpActionCount} LP action(s) detected`],
      guidance: 'This wallet performs LP actions, which do not create buy→sell cycles.',
      matchedSignals: totalTrue,
    }
  }

  if (signals.onlyContractCalls) {
    return {
      reason: 'Only contract calls detected',
      behavior: 'contract-calls-only',
      evidence: ['Only contract calls detected', `${inputs.contractCallCount} contract call(s) detected`],
      guidance: 'This wallet only interacts with contracts in ways that do not produce trades.',
      matchedSignals: totalTrue,
    }
  }

  if (signals.onlyBridgeActions) {
    return {
      reason: 'Only bridge actions detected',
      behavior: 'bridge-only',
      evidence: ['Only bridge actions detected', `${inputs.bridgeActionCount} bridge action(s) detected`],
      guidance: 'This wallet only bridges assets between chains; no trades occurred here.',
      matchedSignals: totalTrue,
    }
  }

  if (signals.hasSwapsNoCloses) {
    return {
      reason: 'No closable trades detected',
      behavior: 'swaps-no-closes',
      evidence: [`${inputs.swapCount} swap(s) detected`, '0 closed lots'],
      guidance: 'This wallet has open positions but no completed (buy→sell) trade cycles yet.',
      matchedSignals: totalTrue,
    }
  }

  if (signals.hasClosesZeroPnl) {
    return {
      reason: 'Closed trades detected with zero realized PnL',
      behavior: 'closes-zero-pnl',
      evidence: [`${inputs.closedLotsCount} closed lot(s)`, 'Realized PnL is exactly 0'],
      guidance: 'This wallet completed trades, but they neither gained nor lost value.',
      matchedSignals: totalTrue,
    }
  }

  if (signals.isNormalTrading) {
    return {
      reason: 'Realized PnL detected',
      behavior: 'normal-trading',
      evidence: [`${inputs.closedLotsCount} closed lot(s)`, `Realized PnL = ${inputs.realizedPnl?.totalRealizedPnl}`],
      guidance: 'This wallet trades normally; PnL is available.',
      matchedSignals: totalTrue,
    }
  }

  // Fallback classification — no rule above matched (e.g. 0 swaps but also not cleanly "only" any
  // single other action type, such as a mix of transfers + contract calls together). Never a crash,
  // just an honestly generic result with 0 matched signals.
  return {
    reason: 'No closable trades detected',
    behavior: 'unclassified',
    evidence: ['0 swaps detected', '0 closed lots'],
    guidance: 'This wallet does not trade, so PnL cannot be computed.',
    matchedSignals: 0,
  }
}

function buildMissingSignals(inputs: ReasonEngineInputs): string[] {
  const missing: string[] = []
  if (inputs.realizedPnl === null) missing.push('realizedPnl')
  if (inputs.unrealizedPnl === null) missing.push('unrealizedPnl')
  if (!inputs.metadataStatus) missing.push('metadataStatus')
  if (!inputs.pricingStatus) missing.push('pricingStatus')
  if (!inputs.swapNormalizerStatus) missing.push('swapNormalizerStatus')
  if (!inputs.fifoStatus) missing.push('fifoStatus')
  if (safeArray(inputs.pricedTokens).length === 0 && safeArray(inputs.unpricedTokens).length === 0) {
    missing.push('pricedTokens/unpricedTokens')
  }
  return missing
}

// TOTAL SIGNALS, DISCLOSED: the denominator of requirement #8's confidence formula. This engine
// evaluates exactly 9 boolean condition checks (evaluateSignals above) — that fixed count is the
// denominator, regardless of which single one was chosen as the classification.
const TOTAL_SIGNALS = 9

// Public entry point. NEVER throws (requirement #3) — the outer try/catch is a final backstop; the
// classify()/buildMissingSignals() logic above is itself pure and defensive (safeArray guards every
// array read), so it should never need to fall through to the catch block in practice.
export function generateReasonEngineOutput(inputs: ReasonEngineInputs): ReasonEngineOutput {
  try {
    const classification = classify(inputs)
    const confidence = TOTAL_SIGNALS > 0 ? classification.matchedSignals / TOTAL_SIGNALS : 0

    const uniqueTokens = new Set([...safeArray(inputs.tradedTokens), ...safeArray(inputs.heldTokens)]).size

    const output: ReasonEngineOutput = {
      reason: classification.reason,
      behavior: classification.behavior,
      evidence: classification.evidence,
      guidance: classification.guidance,
      confidence,
      missingSignals: buildMissingSignals(inputs),
      tokenContext: {
        tradedTokens: safeArray(inputs.tradedTokens),
        heldTokens: safeArray(inputs.heldTokens),
        pricedTokens: safeArray(inputs.pricedTokens),
        unpricedTokens: safeArray(inputs.unpricedTokens),
      },
      pnlContext: {
        hasRealized: inputs.realizedPnl !== null && inputs.realizedPnl.totalRealizedPnl !== 0,
        hasUnrealized: inputs.unrealizedPnl !== null && inputs.unrealizedPnl.totalUnrealizedPnlUsd !== 0,
        realizedPnl: inputs.realizedPnl?.totalRealizedPnl,
        unrealizedPnl: inputs.unrealizedPnl?.totalUnrealizedPnlUsd,
      },
      activityContext: {
        swapCount: inputs.swapCount,
        transferCount: inputs.transferCount,
        lpActions: inputs.lpActionCount,
        contractCalls: inputs.contractCallCount,
        bridgeActions: inputs.bridgeActionCount,
        uniqueTokens,
      },
      diagnostics: {
        metadataStatus: inputs.metadataStatus ?? UNKNOWN_STATUS,
        pricingStatus: inputs.pricingStatus ?? UNKNOWN_STATUS,
        swapNormalizerStatus: inputs.swapNormalizerStatus ?? UNKNOWN_STATUS,
        fifoStatus: inputs.fifoStatus ?? UNKNOWN_STATUS,
      },
    }

    return output
  } catch {
    // Final backstop (requirement #3) — a fully-valid, minimal, honest ReasonEngineOutput even if
    // something above throws unexpectedly (e.g. a caller passing malformed inputs).
    return {
      reason: 'Unable to determine reason',
      behavior: 'error',
      evidence: [],
      guidance: 'An internal error prevented reason detection; treat this result as inconclusive.',
      confidence: 0,
      missingSignals: ['all'],
    }
  }
}

export type { ReasonEngineOutput } from './types'
