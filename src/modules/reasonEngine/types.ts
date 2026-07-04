// src/modules/reasonEngine/types.ts — Reason Engine output schema.
//
// Blueprint only, per request: no logic, no functions, no behavior detection. Defines the exact
// shape the (not-yet-built) Reason Engine will return.

export interface ReasonEngineOutput {
  reason: string
  behavior: string
  evidence: string[]
  guidance: string
  confidence: number

  missingSignals?: string[]

  tokenContext?: {
    tradedTokens: string[]
    heldTokens: string[]
    pricedTokens: string[]
    unpricedTokens: string[]
  }

  pnlContext?: {
    hasRealized: boolean
    hasUnrealized: boolean
    realizedPnl?: number
    unrealizedPnl?: number
  }

  activityContext?: {
    swapCount: number
    transferCount: number
    lpActions: number
    contractCalls: number
    bridgeActions: number
    uniqueTokens: number
  }

  diagnostics?: {
    metadataStatus: string
    pricingStatus: string
    swapNormalizerStatus: string
    fifoStatus: string
  }
}
