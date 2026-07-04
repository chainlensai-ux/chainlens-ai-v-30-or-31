// lib/engine/modules/personality/computePersonality.ts — new wallet personality module.
//
// PURE, DISCLOSED: everything below is arithmetic/classification over already-computed
// portfolio/pnl/chainActivity/risk/pricing/holdings data — no new network calls. Declared `async`
// only to match the spec's own Promise-returning signature.
//
// "chainPreference = Base", DISCLOSED: step I's archetype rule compares `chainPreference` to the
// literal word "Base," but `chainPreference` is typed (per this task's own step D and the
// PersonalityV2 shape) as `number | null` — a chainId, not a chain name string. Interpreted as
// `chainPreference === 8453` (Base's real chainId, the same value every other module in this task
// chain uses) — the only sensible reading given the type actually specified, not a fabricated
// reinterpretation.
//
// ARCHETYPE PRIORITY, DISCLOSED: step I is written as an if/elseif/elseif/elseif/else chain — that
// literal order (Degen Trader > Stable Farmer > Diversified Holder > Base Native Trader > General
// User) is followed exactly; a wallet matching multiple conditions gets the first one listed, not a
// combined or fabricated label.

import type { Portfolio } from '../portfolio/types'
import type { PnlV2 } from '../pnl/types'
import type { ChainActivityRecord } from '../activity/types'
import type { RiskV2 } from '../risk/types'
import type { PricedHolding } from '../pricing/types'
import type { ChainHolding } from '../holdings/types'
import type { PersonalityEngineOutput, PersonalityV2 } from './types'

const BASE_CHAIN_ID = 8453

const EMPTY_PERSONALITY: PersonalityV2 = {
  archetype: 'Unknown',
  riskAppetite: 'low',
  tradingStyle: 'passive',
  chainPreference: null,
  volatilityTolerance: 0,
  stabilityPreference: 0,
  pnlBehavior: 'neutral',
  activityConsistency: 'dormant',
  summary: 'Insufficient data to classify wallet personality.',
}

function tradingStyleFor(chainActivityV2: ChainActivityRecord[]): PersonalityV2['tradingStyle'] {
  if (chainActivityV2.some((c) => c.txCount30d >= 30)) return 'active'
  if (chainActivityV2.some((c) => c.txCount30d >= 5)) return 'occasional'
  return 'passive'
}

function chainPreferenceFor(chainActivityV2: ChainActivityRecord[]): number | null {
  if (chainActivityV2.length === 0) return null
  const sorted = [...chainActivityV2].sort((a, b) => {
    if (b.valueHeldUsd !== a.valueHeldUsd) return b.valueHeldUsd - a.valueHeldUsd
    return b.txCount30d - a.txCount30d // tie-break, per step D
  })
  return sorted[0].chainId
}

function pnlBehaviorFor(pnlV2: PnlV2): PersonalityV2['pnlBehavior'] {
  if (pnlV2.realizedPnlUsd > 0) return 'profit-seeking'
  if (pnlV2.unrealizedPnlUsd < 0) return 'loss-averse'
  return 'neutral'
}

function activityConsistencyFor(chainActivityV2: ChainActivityRecord[]): PersonalityV2['activityConsistency'] {
  if (chainActivityV2.some((c) => c.activityLevel === 'high')) return 'consistent'
  if (chainActivityV2.some((c) => c.activityLevel === 'medium')) return 'sporadic'
  return 'dormant'
}

function archetypeFor(params: {
  volatilityTolerance: number
  tradingStyle: PersonalityV2['tradingStyle']
  stabilityPreference: number
  riskAppetite: PersonalityV2['riskAppetite']
  concentrationRisk: number
  stablecoinRatio: number
  chainPreference: number | null
  pnlBehavior: PersonalityV2['pnlBehavior']
}): string {
  const { volatilityTolerance, tradingStyle, stabilityPreference, riskAppetite, concentrationRisk, stablecoinRatio, chainPreference, pnlBehavior } = params

  if (volatilityTolerance > 0.6 && tradingStyle === 'active') return 'Degen Trader'
  if (stabilityPreference > 0.6 && riskAppetite === 'low') return 'Stable Farmer'
  if (concentrationRisk < 0.3 && stablecoinRatio < 0.3) return 'Diversified Holder'
  if (chainPreference === BASE_CHAIN_ID && pnlBehavior === 'profit-seeking') return 'Base Native Trader'
  return 'General User'
}

function buildSummary(p: PersonalityV2): string {
  const chainText = p.chainPreference != null ? `chain ${p.chainPreference}` : 'no single preferred chain'
  return (
    `This wallet shows ${p.riskAppetite} risk appetite with a ${p.tradingStyle} trading style, favoring ${chainText}. ` +
    `PnL behavior reads as ${p.pnlBehavior}, with volatility tolerance ${p.volatilityTolerance.toFixed(2)} and ` +
    `stability preference ${p.stabilityPreference.toFixed(2)}.`
  )
}

export async function computePersonality(
  portfolioV2: Portfolio,
  pnlV2: PnlV2,
  chainActivityV2: ChainActivityRecord[],
  riskV2: RiskV2,
  pricedHoldings: PricedHolding[],
  _chainHoldings: ChainHolding[],
): Promise<PersonalityEngineOutput> {
  // A. Empty case — exactly as specified.
  if (portfolioV2.totalValueUsd === 0) {
    return { personalityV2: EMPTY_PERSONALITY, personalityStatus: 'empty' }
  }

  const riskAppetite = riskV2.level // B.
  const tradingStyle = tradingStyleFor(chainActivityV2) // C.
  const chainPreference = chainPreferenceFor(chainActivityV2) // D.
  const volatilityTolerance = riskV2.volatileExposure // E.
  const stabilityPreference = portfolioV2.stablecoinRatio // F.
  const pnlBehavior = pnlBehaviorFor(pnlV2) // G.
  const activityConsistency = activityConsistencyFor(chainActivityV2) // H.

  const archetype = archetypeFor({
    volatilityTolerance,
    tradingStyle,
    stabilityPreference,
    riskAppetite,
    concentrationRisk: riskV2.concentrationRisk,
    stablecoinRatio: portfolioV2.stablecoinRatio,
    chainPreference,
    pnlBehavior,
  }) // I.

  const personalityV2: PersonalityV2 = {
    archetype,
    riskAppetite,
    tradingStyle,
    chainPreference,
    volatilityTolerance,
    stabilityPreference,
    pnlBehavior,
    activityConsistency,
    summary: '', // filled below, needs the fields above
  }
  personalityV2.summary = buildSummary(personalityV2) // J.

  // K. personalityStatus — same "unpriced holding -> partial" convention as risk/pnl modules.
  const hasUnpriced = pricedHoldings.some((h) => h.valueUsd == null)
  const personalityStatus: PersonalityEngineOutput['personalityStatus'] = hasUnpriced ? 'partial' : 'ok'

  return { personalityV2, personalityStatus }
}
