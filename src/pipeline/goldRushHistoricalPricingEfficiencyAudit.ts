// GOLDRUSH-HISTORICAL-PRICING-EFFICIENCY-AUDIT, DISCLOSED, ADDITIVE (Wallet Scanner weak-spot
// pass — requested as `goldRushHistoricalPricingEfficiencyAudit`). Answers, from already-measured
// counters, whether historical GoldRush spend actually moved realized PnL.
//
// CHEAPER STRATEGY, SHADOW-THEN-APPLY: `planUnheldOpenBuySkip` is a PURE planner. An unmatched
// inbound is never a closed-lot side (structural FIFO already ran) and a token with no canonical
// holding is excluded from official unrealized as missing_canonical_balance. Skipping those buys
// therefore cannot change realized PnL, closed-lot count, publicPnlStatus, or lane.

export type GoldRushCheaperStrategyShadow = {
  strategy: 'skip_unheld_open_buys'
  realizedPnlIdentity: 'structurally_identical'
  closedLotSidesRetained: number
  heldOpenBuysRetained: number
  unheldOpenBuysWouldSkip: number
  enabled: boolean
  applied: boolean
}

export type GoldRushHistoricalPricingEfficiencyAudit = {
  liveHistoricalGoldrushCalls: number
  liveCurrentPriceGoldrushCalls: number
  uniqueTokenTimestampRequests: number
  duplicateRequestsEliminated: number
  negativeCacheHitsAvoided: number
  acceptedEvidenceSidesSkipped: number
  cheaperStrategy: GoldRushCheaperStrategyShadow
  liveCallsThatCouldAffectRealized: number
  liveCallsForUnheldOpenBuys: number
}

export type UnheldOpenBuyLike = {
  chain: string
  txHash: string
  contract: string
}

export function planUnheldOpenBuySkip(params: {
  buys: UnheldOpenBuyLike[]
  sells: UnheldOpenBuyLike[]
  matchedLotSideKeys: ReadonlySet<string>
  canonicalHoldingKeys?: ReadonlySet<string>
  skipUnheldOpenBuys?: boolean
}): { cheaperStrategy: GoldRushCheaperStrategyShadow; buyIndexesToRemove: number[] } {
  const cheaperStrategyEnabled = params.canonicalHoldingKeys != null && params.skipUnheldOpenBuys !== false
  let unheldOpenBuysWouldSkip = 0
  let heldOpenBuysRetained = 0
  let closedLotSidesRetained = 0
  const buyIndexesToRemove: number[] = []
  for (let i = 0; i < params.buys.length; i += 1) {
    const b = params.buys[i]
    const isClosedLotEntry = params.matchedLotSideKeys.has(`${b.chain}:${b.txHash.toLowerCase()}:entry`)
    if (isClosedLotEntry) {
      closedLotSidesRetained += 1
      continue
    }
    const held = params.canonicalHoldingKeys?.has(`${b.chain}:${b.contract.toLowerCase()}`) === true
    if (held) heldOpenBuysRetained += 1
    else {
      unheldOpenBuysWouldSkip += 1
      if (cheaperStrategyEnabled) buyIndexesToRemove.push(i)
    }
  }
  for (const s of params.sells) {
    if (params.matchedLotSideKeys.has(`${s.chain}:${s.txHash.toLowerCase()}:exit`)) closedLotSidesRetained += 1
  }
  return {
    cheaperStrategy: {
      strategy: 'skip_unheld_open_buys',
      realizedPnlIdentity: 'structurally_identical',
      closedLotSidesRetained,
      heldOpenBuysRetained,
      unheldOpenBuysWouldSkip,
      enabled: cheaperStrategyEnabled,
      applied: cheaperStrategyEnabled && buyIndexesToRemove.length > 0,
    },
    buyIndexesToRemove,
  }
}

export function buildGoldRushHistoricalPricingEfficiencyAudit(params: {
  liveHistoricalGoldrushCalls: number
  liveCurrentPriceGoldrushCalls: number
  uniqueTokenTimestampRequests: number
  duplicateRequestsEliminated: number
  negativeCacheHitsAvoided: number
  acceptedEvidenceSidesSkipped: number
  cheaperStrategy: GoldRushCheaperStrategyShadow
}): GoldRushHistoricalPricingEfficiencyAudit {
  const liveHistorical = Math.max(0, params.liveHistoricalGoldrushCalls)
  const unheldWouldSkip = Math.max(0, params.cheaperStrategy.unheldOpenBuysWouldSkip)
  const appliedUnheldSkips = params.cheaperStrategy.applied ? unheldWouldSkip : 0
  return {
    liveHistoricalGoldrushCalls: liveHistorical,
    liveCurrentPriceGoldrushCalls: Math.max(0, params.liveCurrentPriceGoldrushCalls),
    uniqueTokenTimestampRequests: Math.max(0, params.uniqueTokenTimestampRequests),
    duplicateRequestsEliminated: Math.max(0, params.duplicateRequestsEliminated),
    negativeCacheHitsAvoided: Math.max(0, params.negativeCacheHitsAvoided),
    acceptedEvidenceSidesSkipped: Math.max(0, params.acceptedEvidenceSidesSkipped),
    cheaperStrategy: params.cheaperStrategy,
    liveCallsThatCouldAffectRealized: liveHistorical,
    liveCallsForUnheldOpenBuys: appliedUnheldSkips > 0 ? 0 : unheldWouldSkip,
  }
}
