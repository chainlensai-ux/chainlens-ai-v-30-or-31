import { applyBaseRadarScoreCaps, getRadarFeedRiskLabel } from './baseRadarFeedScoring.ts'
import { getRadarValuationBasis, type RadarValuationBasis } from './baseRadarValuation.ts'
import { getRadarSimulationReasonLabel, type RadarSimulationStatus } from './baseRadarSimulation.ts'

export type BaseRadarValuationStatus = 'verified' | 'fdv_fallback' | 'open_check'

export interface BaseRadarDisplayValuation {
  label: 'Market Cap' | 'FDV' | 'Valuation'
  valueUsd: number | null
  status: BaseRadarValuationStatus
  sublabel: string | null
  warning: string | null
}

export interface BaseRadarDisplaySimulation {
  status: RadarSimulationStatus
  reason: string | null
  label: string
  cortexLine: string
  buyTax: number | null
  sellTax: number | null
}

export interface BaseRadarDisplayMarketSnapshot {
  liquidityUsd: number | null
  volume24hUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  marketCapStatus: 'verified' | 'unavailable' | null
  valuationBasis: RadarValuationBasis
}

export interface BaseRadarDisplayModel {
  score: number
  riskLabel: ReturnType<typeof getRadarFeedRiskLabel>
  whyOnRadar: string
  valuation: BaseRadarDisplayValuation
  simulation: BaseRadarDisplaySimulation
  evidenceGaps: string[]
  signalChips: string[]
  marketSnapshot: BaseRadarDisplayMarketSnapshot
}

type AnyRecord = Record<string, any>

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function positive(value: unknown): number | null {
  const n = num(value)
  return n != null && n > 0 ? n : null
}

function bool(value: unknown): boolean { return value === true }

function hasSuspiciousBranding(name: unknown, symbol: unknown): boolean {
  const text = `${typeof name === 'string' ? name : ''} ${typeof symbol === 'string' ? symbol : ''}`.toLowerCase()
  return ['inu', 'elon', 'musk', 'ai', '1000x', 'moon', 'doge', 'pepe', 'pump', 'safe'].some(word => text.includes(word))
}

function baseScore(raw: AnyRecord, simulation: BaseRadarDisplaySimulation): number {
  const liquidityUsd = num(raw.liquidityUsd) ?? 0
  const volume24hUsd = num(raw.volume24h ?? raw.volume24hUsd) ?? 0
  const poolAgeMinutes = num(raw.ageMinutes) ?? 0
  // UNKNOWN-TAX FIX, DISCLOSED (all-radar-scores-stuck-at-49 bug): previously
  // `simulation.buyTax ?? raw.honeypot?.buyTax ?? 0` treated a PENDING/unconfirmed simulation
  // (buyTax/sellTax both null) identically to a CONFIRMED 0% tax — awarding the same +10 "clean
  // tax" bonus to a token nobody has actually checked yet as to one that's genuinely verified
  // clean. Since almost every brand-new pool has a pending simulation, this handed out the same
  // free +10 to nearly the entire "new pool" segment of the feed, saturating baseScore near/at 100
  // for most of them regardless of real differences in liquidity/volume/age — which then got
  // compressed away entirely once applyBaseRadarScoreCaps's cap: 49 (both LP-burn-proof and
  // simulation missing, also true for nearly every brand-new pool) became the binding constraint.
  // Net effect: nearly every fresh token landed on the exact same score (49), regardless of how
  // different their real underlying evidence was. Only awards the clean-tax bonus (and only
  // evaluates a tax penalty at all) when the simulation actually confirmed a real value —
  // "unknown" now stays neutral, the same "unknown ≠ safe" principle already used everywhere else
  // in this codebase's risk scoring.
  const taxConfirmed = simulation.status === 'passed'
  const buyTax = taxConfirmed ? (simulation.buyTax ?? 0) : null
  const sellTax = taxConfirmed ? (simulation.sellTax ?? 0) : null
  let score = 50
  if (liquidityUsd >= 10_000) score += 20
  if (liquidityUsd >= 30_000) score += 10
  if (liquidityUsd < 2_000) score -= 20
  if (volume24hUsd >= 5_000) score += 15
  if (volume24hUsd >= 20_000) score += 10
  if (volume24hUsd <= 0) score -= 15
  if (poolAgeMinutes <= 120) score += 10
  if (poolAgeMinutes <= 5 && volume24hUsd <= 0) score -= 10
  if (buyTax === 0 && sellTax === 0) score += 10
  if (buyTax != null && sellTax != null && (buyTax > 5 || sellTax > 5)) score -= 15
  if (buyTax != null && sellTax != null && (buyTax > 15 || sellTax > 15)) score -= 25
  if (hasSuspiciousBranding(raw.name, raw.symbol)) score -= 10
  return Math.max(0, Math.min(100, Math.round(score)))
}

function buildSimulation(raw: AnyRecord, enrichment?: AnyRecord | null): BaseRadarDisplaySimulation {
  const hp = enrichment?.security?.honeypot ?? raw.honeypot ?? null
  const enrichedSuccess = enrichment?.security?.honeypot?.simulationSuccess
  const tokenStatus = raw.simulationStatus
  if ((enrichedSuccess === true) || (enrichedSuccess == null && tokenStatus === 'passed')) {
    const buyTax = num(hp?.buyTax) ?? 0
    const sellTax = num(hp?.sellTax) ?? 0
    return { status: 'passed', reason: null, label: raw.simulationLabel ?? `B ${buyTax.toFixed(1)}% / S ${sellTax.toFixed(1)}%`, cortexLine: raw.simulationCortexLine ?? 'Buy/sell simulation passed — values reflect the latest simulation result.', buyTax, sellTax }
  }
  const reason = enrichment?.security?.honeypot?.failureReason ?? raw.simulationReason ?? null
  const label = raw.simulationLabel ?? getRadarSimulationReasonLabel(reason)
  return { status: 'open_check', reason, label, cortexLine: raw.simulationCortexLine ?? (reason ? `${label}; tax and honeypot status are not confirmed yet.` : 'Simulation pending; tax and honeypot status are not confirmed yet.'), buyTax: null, sellTax: null }
}

function buildValuation(raw: AnyRecord, enrichment?: AnyRecord | null): { valuation: BaseRadarDisplayValuation; snapshot: BaseRadarDisplayMarketSnapshot } {
  const market = enrichment?.market ?? {}
  const feedMc = raw.marketCapStatus === 'verified' || raw.valuationBasis === 'verified_market_cap' || raw.valuationVerified === true ? positive(raw.marketCapUsd ?? raw.valuationUsd) : null
  const enrichedMc = market.marketCapStatus === 'verified' ? positive(market.marketCapUsd) : null
  const marketCapUsd = enrichedMc ?? feedMc
  const marketCapStatus = marketCapUsd != null ? 'verified' : (market.marketCapStatus === 'unavailable' || raw.marketCapStatus === 'unavailable' ? 'unavailable' : null)
  const fdvUsd = positive(market.fdvUsd) ?? positive(raw.fdvUsd) ?? null
  const liquidityUsd = num(market.liquidityUsd) ?? num(raw.liquidityUsd)
  const basis = getRadarValuationBasis({ marketCapUsd, marketCapStatus, fdvUsd, liquidityUsd })
  // getRadarValuationBasis now reports basis: 'verified_market_cap' for both a real market cap and
  // an FDV-derived confirmed value (see that function's own header, and
  // lib/baseRadarValuation.ts's) — always shown as a single confirmed "Market Cap", no separate
  // FDV/fallback branch anymore.
  const valuation: BaseRadarDisplayValuation = basis.basis === 'verified_market_cap'
    ? { label: 'Market Cap', valueUsd: basis.valueUsd, status: 'verified', sublabel: 'Confirmed', warning: null }
    : { label: 'Valuation', valueUsd: null, status: 'open_check', sublabel: 'Open check', warning: null }
  return { valuation, snapshot: { liquidityUsd: liquidityUsd ?? null, volume24hUsd: num(market.volume24hUsd) ?? num(raw.volume24h) ?? null, fdvUsd, marketCapUsd, marketCapStatus, valuationBasis: basis.basis } }
}

function why(raw: AnyRecord, score: number, valuation: BaseRadarDisplayValuation, simulation: BaseRadarDisplaySimulation): string {
  const liquidity = num(raw.liquidityUsd) ?? 0
  const volume = num(raw.volume24h ?? raw.volume24hUsd) ?? 0
  const ratio = liquidity > 0 ? volume / liquidity : 0
  if (score >= 75) return 'Highest current CORTEX radar score.'
  if (ratio >= 0.5) return 'Volume spike relative to liquidity.'
  if (volume >= 20_000) return 'Leading current radar volume.'
  if ((num(raw.ageMinutes) ?? 9999) <= 30 && valuation.status === 'verified') return 'New verified-valuation pool with early activity.'
  if (simulation.status === 'open_check') return 'Early pool with unresolved simulation evidence.'
  if (liquidity >= 30_000) return 'Liquidity is active but control evidence needs review.'
  if (score < 40) return 'Control/holder evidence requires review.'
  if (liquidity > 0 && liquidity < 5_000) return 'Thin liquidity makes price movement fragile.'
  if ((num(raw.ageMinutes) ?? 9999) <= 30 && volume > 0) return 'Fresh pool with early activity visible.'
  return 'Radar placement comes from current liquidity, volume, and evidence signals.'
}

export function buildBaseRadarDisplayModel(rawToken: AnyRecord, enrichment?: AnyRecord | null): BaseRadarDisplayModel {
  const simulation = buildSimulation(rawToken, enrichment)
  const { valuation, snapshot } = buildValuation(rawToken, enrichment)
  const lpLockBurnConfirmed = bool(
    enrichment?.lp?.lpLockStatus === 'locked'
    || enrichment?.lp?.lpProofApplicability === 'not_applicable'
    || rawToken.lpLocked === true
    || rawToken.lpBurned === true,
  )
  const lpModel = enrichment?.lp?.displayLpModel ?? rawToken.lpModel ?? 'open_check'
  // TOKEN-SAVER: log what evidence scoring actually received so a stuck/fallback score is
  // traceable to a missing-evidence cause instead of a silent default.
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[baseRadarDisplayModel] scoring evidence', {
      contract: rawToken.contract ?? rawToken.address ?? null,
      simulationStatus: simulation.status,
      hasEnrichment: enrichment != null,
      lpLockBurnConfirmed,
      lpModel,
    })
  }
  const scoreResult = applyBaseRadarScoreCaps({
    baseScore: baseScore(rawToken, simulation),
    liquidityUsd: snapshot.liquidityUsd,
    volume24h: snapshot.volume24hUsd,
    ageMinutes: num(rawToken.ageMinutes),
    simulationStatus: simulation.status,
    simulationReason: simulation.reason,
    buyTax: simulation.buyTax,
    sellTax: simulation.sellTax,
    honeypotPresent: Boolean(rawToken.honeypot || enrichment?.security?.honeypot),
    valuationVerified: valuation.status === 'verified',
    valuationUsd: valuation.valueUsd,
    lpLockBurnConfirmed,
    lpModel,
    strongProtection: false,
    majorControlOrHolderOrLpRedFlag: false,
  })
  const evidenceGaps = Array.from(new Set([...(Array.isArray(rawToken.evidenceGaps) ? rawToken.evidenceGaps : []), simulation.status === 'open_check' ? simulation.label : null, valuation.warning].filter(Boolean) as string[]))
  const signalChips = Array.from(new Set([valuation.status === 'verified' ? 'Market Cap Verified' : valuation.status === 'fdv_fallback' ? 'FDV Fallback' : 'Valuation Open Check', simulation.status === 'passed' ? 'Simulation Clear' : 'Simulation Pending', scoreResult.riskLabel].filter(Boolean)))
  return { score: scoreResult.score, riskLabel: scoreResult.riskLabel, whyOnRadar: why(rawToken, scoreResult.score, valuation, simulation), valuation, simulation, evidenceGaps, signalChips, marketSnapshot: snapshot }
}
