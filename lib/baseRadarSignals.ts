// Base Radar signal intelligence — derives lightweight, deterministic signals,
// "why it matters" copy, a momentum timeline, and a short-horizon read from the
// same evidence already surfaced by lib/baseRadarEvidence.ts and the radar feed
// item / drawer enrichment payload. No new provider calls, no randomness.

import {
  getRadarAgeEvidence,
  getRadarLpPositionEvidence,
  getRadarOwnershipEvidence,
  getRadarPastLaunchesEvidence,
  getRadarRugHistoryEvidence,
  getRadarSimulationEvidence,
} from './baseRadarEvidence.ts'

export type RadarSignalSeverity = 'positive' | 'neutral' | 'watch' | 'risk' | 'critical'

export interface RadarSignal {
  label: string
  severity: RadarSignalSeverity
  reason: string
}

export interface RadarTimelinePoint {
  label: string
  value: number
}

export interface RadarTimeline {
  points: RadarTimelinePoint[]
  trend: 'up' | 'flat' | 'down' | 'unknown'
  label: string
}

export type RadarPredictionCategory =
  | 'Momentum likely to continue'
  | 'Momentum slowing'
  | 'Momentum reversing'
  | 'No clear short-term signal'

export interface RadarPrediction {
  category: RadarPredictionCategory
  explanation: string
}

/**
 * Shape of the data available to the four builder functions: the radar feed
 * item (token) plus the optional drawer enrichment payload. Fields mirror
 * RadarDrawerToken / DrawerEnrichmentPayload in ProjectOverviewDrawer.tsx and
 * RadarToken in app/api/radar/route.ts — only fields actually present in those
 * shapes are used.
 */
export interface RadarSignalsToken {
  contract?: string | null
  ageMinutes?: number | null
  liquidityUsd?: number | null
  volume24h?: number | null
  radarScore?: number | null
  momentum?: string | null
  flags?: string[] | null
  simulationStatus?: 'passed' | 'open_check' | null
  simulationReason?: string | null
}

export interface RadarSignalsEnrichment {
  market?: {
    liquidityUsd?: number | null
    volume24hUsd?: number | null
    marketCapUsd?: number | null
    fdvUsd?: number | null
    poolActivity?: { pairCreatedAt?: string | number | null } | null
  } | null
  lp?: {
    lpLockStatus?: string | null
    lpControl?: { status?: string | null } | null
    displayLpModel?: string | null
    lpProofApplicability?: string | null
    primaryMarketPool?: string | null
    lpModelProof?: { dexName?: string | null } | null
  } | null
  holders?: {
    top10?: number | null
    top20?: number | null
    holderCount?: number | null
    creatorInTopHolders?: boolean | null
    creatorHolderPercent?: number | null
    topHolders?: { rank?: number | null; address?: string | null; percent?: number | null; pctOfSupply?: number | null; isContract?: boolean | null; walletType?: string | null }[] | null
  } | null
  deployer?: {
    deployerAddress?: string | null
    pastLaunches?: { status?: string | null; count?: number | null; sample?: string[] | null; reason?: string | null } | null
    rugHistory?: { verified?: boolean | null; count?: number | null; reason?: string | null } | null
    clusterEvidence?: {
      confirmed?: boolean | null
      devClusterSupplyPercent?: number | null
      linkedWalletSupplyPercent?: number | null
      edgeCount?: number | null
      nodeCount?: number | null
      matchedLinkedWallets?: number | null
    } | null
  } | null
  security?: {
    devOwnership?: {
      ownerAddress?: string | null
      adminAddress?: string | null
      isRenounced?: boolean | null
      ownershipVerified?: boolean | null
      ownershipStatus?: string | null
    } | null
  } | null
  priceChart?: { points?: { timestamp: number | string; price?: number | null; close?: number | null; value?: number | null }[]; timeframe?: string | null } | null
}

const HIGH_VOLUME_TO_LIQUIDITY_RATIO = 5
const ELEVATED_VOLUME_TO_LIQUIDITY_RATIO = 2
const HIGH_CONCENTRATION_TOP10 = 60
const EXTREME_CONCENTRATION_TOP10 = 80

const FALLBACK_SIGNAL: RadarSignal = {
  label: 'Evidence gap',
  severity: 'neutral',
  reason: 'Limited evidence available — rescan soon.',
}

const FALLBACK_WHY_IT_MATTERS = ['Limited evidence available — rescan soon.']

const FALLBACK_TIMELINE: RadarTimeline = {
  points: [],
  trend: 'unknown',
  label: 'Limited timeline data — pool is still forming.',
}

const FALLBACK_PREDICTION: RadarPrediction = {
  category: 'No clear short-term signal',
  explanation: 'Not enough evidence for a short-term read.',
}

function fmtUSD(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'N/A'
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

function liquidityUsdOf(token?: RadarSignalsToken | null, enrichment?: RadarSignalsEnrichment | null): number | null {
  const value = enrichment?.market?.liquidityUsd ?? token?.liquidityUsd ?? null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function volume24hOf(token?: RadarSignalsToken | null, enrichment?: RadarSignalsEnrichment | null): number | null {
  const value = enrichment?.market?.volume24hUsd ?? token?.volume24h ?? null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function ageMinutesOf(token?: RadarSignalsToken | null, enrichment?: RadarSignalsEnrichment | null): number | null {
  const pairCreatedAt = enrichment?.market?.poolActivity?.pairCreatedAt
  if (pairCreatedAt != null) {
    const millis = typeof pairCreatedAt === 'number'
      ? (pairCreatedAt > 10_000_000_000 ? pairCreatedAt : pairCreatedAt * 1000)
      : Date.parse(pairCreatedAt)
    if (Number.isFinite(millis)) {
      return Math.max(0, Math.floor((Date.now() - millis) / 60_000))
    }
  }
  const value = token?.ageMinutes
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function hasVerifiedLock(status: string | null | undefined): boolean {
  return status === 'locked' || status === 'burned'
}

/**
 * Builds the list of RadarSignal entries from the same evidence surfaced by
 * lib/baseRadarEvidence.ts plus radar-feed fields. Falls back to a single
 * "Evidence gap" signal when nothing is derivable.
 */
export function buildRadarSignals(token?: RadarSignalsToken | null, enrichment?: RadarSignalsEnrichment | null): RadarSignal[] {
  const signals: RadarSignal[] = []

  const liquidityUsd = liquidityUsdOf(token, enrichment)
  const volume24h = volume24hOf(token, enrichment)
  const ageMinutes = ageMinutesOf(token, enrichment)

  // Volume / liquidity ratio
  if (liquidityUsd != null && liquidityUsd > 0 && volume24h != null) {
    const ratio = volume24h / liquidityUsd
    if (ratio >= HIGH_VOLUME_TO_LIQUIDITY_RATIO) {
      signals.push({
        label: 'Volume spike',
        severity: 'watch',
        reason: `24h volume (${fmtUSD(volume24h)}) is ${ratio.toFixed(1)}x current liquidity (${fmtUSD(liquidityUsd)}), which is unusually aggressive turnover.`,
      })
    } else if (ratio >= ELEVATED_VOLUME_TO_LIQUIDITY_RATIO) {
      signals.push({
        label: 'Volume spike',
        severity: 'neutral',
        reason: `24h volume (${fmtUSD(volume24h)}) is ${ratio.toFixed(1)}x current liquidity (${fmtUSD(liquidityUsd)}), an elevated turnover ratio.`,
      })
    }
  }

  // Age / new pool
  const ageEvidence = getRadarAgeEvidence({ ageMinutes })
  if (ageEvidence) {
    signals.push({
      label: 'New pool',
      severity: 'watch',
      reason: ageEvidence.label,
    })
  }

  // Simulation
  const simulationEvidence = getRadarSimulationEvidence({
    status: token?.simulationStatus ?? null,
    reason: token?.simulationReason ?? null,
  })
  if (simulationEvidence) {
    signals.push({
      label: 'Simulation pending',
      severity: 'watch',
      reason: simulationEvidence.label,
    })
  } else if (token?.simulationStatus === 'passed') {
    signals.push({
      label: 'Simulation clear',
      severity: 'positive',
      reason: 'Buy/sell simulation passed, so tax and honeypot status are confirmed from current evidence.',
    })
  }

  // LP position / lock status
  const lp = enrichment?.lp
  const lpPositionEvidence = getRadarLpPositionEvidence({
    isConcentrated: lp?.displayLpModel === 'concentrated_liquidity',
    poolId: lp?.primaryMarketPool ?? null,
    dex: lp?.lpModelProof?.dexName ?? null,
    liquidityUsd,
    fmtUSD,
  })
  if (lpPositionEvidence) {
    signals.push({
      label: 'Evidence gap',
      severity: 'watch',
      reason: lpPositionEvidence.label,
    })
  } else if (lp?.lpLockStatus === 'burned') {
    signals.push({
      label: 'LP burned',
      severity: 'positive',
      reason: 'LP tokens for the primary pool are burned, removing a single-wallet LP-pull risk.',
    })
  } else if (hasVerifiedLock(lp?.lpLockStatus)) {
    signals.push({
      label: 'LP locked',
      severity: 'positive',
      reason: 'LP tokens for the primary pool are locked with verified proof, reducing exit-liquidity risk.',
    })
  } else if (lp?.lpControl?.status === 'team_controlled' || lp?.lpLockStatus === 'unlocked' || lp?.lpLockStatus === 'unverified') {
    signals.push({
      label: 'LP unlocked',
      severity: 'risk',
      reason: 'No verified lock or burn proof was found for the primary LP position — liquidity could be pulled by the controlling wallet.',
    })
  }

  // Ownership / deployer
  const ownershipEvidence = getRadarOwnershipEvidence(enrichment?.security?.devOwnership ?? null)
  if (ownershipEvidence) {
    signals.push({
      label: 'Deployer suspicious',
      severity: 'risk',
      reason: ownershipEvidence.label,
    })
  } else if (enrichment?.security?.devOwnership?.ownershipStatus === 'renounced') {
    signals.push({
      label: 'Deployer clean',
      severity: 'positive',
      reason: 'Contract ownership is renounced, so the deployer no longer holds privileged admin control.',
    })
  }

  // Rug history / cluster
  const rugHistoryEvidence = getRadarRugHistoryEvidence({
    deployerAddress: enrichment?.deployer?.deployerAddress ?? null,
    rugHistory: enrichment?.deployer?.rugHistory ?? null,
  })
  if (rugHistoryEvidence.status === 'risk_fact') {
    signals.push({
      label: 'Cluster entry',
      severity: 'critical',
      reason: rugHistoryEvidence.label,
    })
  } else if (rugHistoryEvidence.status === 'checked_not_found') {
    signals.push({
      label: 'Deployer clean',
      severity: 'positive',
      reason: rugHistoryEvidence.label,
    })
  }

  // Past launches
  const pastLaunchesEvidence = getRadarPastLaunchesEvidence({
    deployerAddress: enrichment?.deployer?.deployerAddress ?? null,
    pastLaunches: enrichment?.deployer?.pastLaunches ?? null,
  })
  if (pastLaunchesEvidence.status === 'verified') {
    signals.push({
      label: 'Cluster entry',
      severity: 'watch',
      reason: pastLaunchesEvidence.label,
    })
  }

  // Cluster supply concentration from deployer evidence
  const clusterEvidence = enrichment?.deployer?.clusterEvidence
  if (clusterEvidence?.confirmed && typeof clusterEvidence.devClusterSupplyPercent === 'number' && clusterEvidence.devClusterSupplyPercent > 0) {
    signals.push({
      label: 'High concentration',
      severity: 'risk',
      reason: `Confirmed deployer-linked cluster evidence shows about ${clusterEvidence.devClusterSupplyPercent.toFixed(1)}% of supply held across linked wallets.`,
    })
  }

  // Holder concentration
  const holders = enrichment?.holders
  if (typeof holders?.top10 === 'number' && Number.isFinite(holders.top10)) {
    if (holders.top10 >= EXTREME_CONCENTRATION_TOP10) {
      signals.push({
        label: 'High concentration',
        severity: 'critical',
        reason: `Top 10 holders control about ${holders.top10.toFixed(1)}% of supply — extreme concentration.`,
      })
    } else if (holders.top10 >= HIGH_CONCENTRATION_TOP10) {
      signals.push({
        label: 'High concentration',
        severity: 'risk',
        reason: `Top 10 holders control about ${holders.top10.toFixed(1)}% of supply — high concentration.`,
      })
    }
  }

  // Holder spike (only when holder count evidence exists alongside a very new pool)
  if (ageEvidence && typeof holders?.holderCount === 'number' && Number.isFinite(holders.holderCount) && holders.holderCount > 0) {
    signals.push({
      label: 'Holder spike',
      severity: 'neutral',
      reason: `${holders.holderCount} holders were already recorded for a pool that is under ${Math.floor(ageMinutes ?? 0)} minutes old.`,
    })
  }

  // Evidence gaps from open checks not already captured above
  if (!enrichment?.deployer?.deployerAddress) {
    signals.push({
      label: 'Evidence gap',
      severity: 'neutral',
      reason: 'Deployer identity is not resolved, so deployer-linked checks remain open.',
    })
  }

  if (signals.length === 0) {
    return [FALLBACK_SIGNAL]
  }

  return signals
}

/**
 * Builds 3-5 "why it matters" sentences from the same evidence used in
 * buildRadarSignals. Falls back to a single-sentence array when nothing is
 * derivable.
 */
export function buildWhyItMatters(token?: RadarSignalsToken | null, enrichment?: RadarSignalsEnrichment | null): string[] {
  const sentences: string[] = []

  const liquidityUsd = liquidityUsdOf(token, enrichment)
  const volume24h = volume24hOf(token, enrichment)
  const ageMinutes = ageMinutesOf(token, enrichment)

  const ageEvidence = getRadarAgeEvidence({ ageMinutes })
  if (ageEvidence) {
    sentences.push(`This pool is very new (${ageEvidence.known[0]?.replace('ageMinutes=', '') ?? 'under 15'} minutes old), so early activity carries more uncertainty than an established pool.`)
  }

  if (liquidityUsd != null && liquidityUsd > 0 && volume24h != null) {
    const ratio = volume24h / liquidityUsd
    if (ratio >= ELEVATED_VOLUME_TO_LIQUIDITY_RATIO) {
      sentences.push(`Volume is high relative to liquidity (about ${ratio.toFixed(1)}x), which can mean fast price moves in either direction.`)
    }
  }

  const holders = enrichment?.holders
  if (typeof holders?.top10 === 'number' && Number.isFinite(holders.top10) && holders.top10 >= HIGH_CONCENTRATION_TOP10) {
    sentences.push(`Holder concentration is elevated — the top 10 wallets hold about ${holders.top10.toFixed(1)}% of supply, so a small number of wallets can move the price.`)
  }

  const lp = enrichment?.lp
  const lpPositionEvidence = getRadarLpPositionEvidence({
    isConcentrated: lp?.displayLpModel === 'concentrated_liquidity',
    poolId: lp?.primaryMarketPool ?? null,
    dex: lp?.lpModelProof?.dexName ?? null,
    liquidityUsd,
    fmtUSD,
  })
  if (lpPositionEvidence) {
    sentences.push('LP control evidence needs review — standard lock/burn proof has not been independently verified for this pool position.')
  } else if (hasVerifiedLock(lp?.lpLockStatus)) {
    sentences.push('Liquidity is backed by a verified lock or burn, which lowers the risk of liquidity being pulled.')
  } else if (lp?.lpControl?.status === 'team_controlled' || lp?.lpLockStatus === 'unlocked' || lp?.lpLockStatus === 'unverified') {
    sentences.push('LP control evidence needs review — no verified lock or burn proof was found, so liquidity could be pulled by the controlling wallet.')
  }

  const simulationEvidence = getRadarSimulationEvidence({
    status: token?.simulationStatus ?? null,
    reason: token?.simulationReason ?? null,
  })
  if (simulationEvidence) {
    sentences.push('Simulation is still pending, so buy/sell tax and honeypot status are not yet confirmed.')
  }

  const rugHistoryEvidence = getRadarRugHistoryEvidence({
    deployerAddress: enrichment?.deployer?.deployerAddress ?? null,
    rugHistory: enrichment?.deployer?.rugHistory ?? null,
  })
  const pastLaunchesEvidence = getRadarPastLaunchesEvidence({
    deployerAddress: enrichment?.deployer?.deployerAddress ?? null,
    pastLaunches: enrichment?.deployer?.pastLaunches ?? null,
  })
  if (rugHistoryEvidence.status === 'risk_fact') {
    sentences.push('Cluster or wallet rotation is visible — deployer-linked wallets show a prior rug-pattern match in current evidence.')
  } else if (pastLaunchesEvidence.status === 'verified') {
    sentences.push('Cluster or wallet rotation is visible — the deployer has linked wallets/contracts from prior launches in current evidence.')
  } else if (rugHistoryEvidence.status === 'checked_not_found') {
    sentences.push('Deployer cluster looks clean — no confirmed prior rug pattern was found for this deployer in current evidence.')
  }

  if (sentences.length === 0) {
    return FALLBACK_WHY_IT_MATTERS
  }

  return sentences.slice(0, 5)
}

/**
 * Builds a momentum timeline from whatever momentum-ish fields exist in the
 * input (price chart points). Falls back to the documented empty-timeline
 * shape when fewer than 2 points are available.
 */
export function buildRadarTimeline(token?: RadarSignalsToken | null, enrichment?: RadarSignalsEnrichment | null): RadarTimeline {
  const chartPoints = enrichment?.priceChart?.points ?? []
  const values = chartPoints
    .map((p) => {
      const raw = p.close ?? p.price ?? p.value
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    })
    .filter((v): v is number => v !== null)

  if (values.length < 2) {
    return FALLBACK_TIMELINE
  }

  const points: RadarTimelinePoint[] = values.map((value, idx) => ({
    label: `t${idx + 1}`,
    value,
  }))

  const first = values[0]
  const last = values[values.length - 1]
  let trend: RadarTimeline['trend'] = 'flat'
  if (first !== 0) {
    const change = (last - first) / Math.abs(first)
    if (change > 0.01) trend = 'up'
    else if (change < -0.01) trend = 'down'
    else trend = 'flat'
  } else {
    trend = last > 0 ? 'up' : last < 0 ? 'down' : 'flat'
  }

  return {
    points,
    trend,
    label: 'Short-term price momentum from recent chart data.',
  }
}

/**
 * Builds a deterministic short-horizon "read" from buy velocity, LP movement,
 * deployer behavior, simulation status, and evidence-gap count. Falls back to
 * "No clear short-term signal" when there isn't enough evidence.
 */
export function buildNextFiveMinuteRead(token?: RadarSignalsToken | null, enrichment?: RadarSignalsEnrichment | null): RadarPrediction {
  const signals = buildRadarSignals(token, enrichment)

  // If the only signal is the generic fallback, there's nothing to read.
  if (signals.length === 1 && signals[0].label === 'Evidence gap' && signals[0] === FALLBACK_SIGNAL) {
    return FALLBACK_PREDICTION
  }

  const evidenceGapCount = signals.filter((s) => s.label === 'Evidence gap').length
  const criticalCount = signals.filter((s) => s.severity === 'critical').length
  const riskCount = signals.filter((s) => s.severity === 'risk').length
  const positiveCount = signals.filter((s) => s.severity === 'positive').length
  const watchCount = signals.filter((s) => s.severity === 'watch').length

  const liquidityUsd = liquidityUsdOf(token, enrichment)
  const volume24h = volume24hOf(token, enrichment)
  const aggressiveVolume = liquidityUsd != null && liquidityUsd > 0 && volume24h != null && (volume24h / liquidityUsd) >= HIGH_VOLUME_TO_LIQUIDITY_RATIO

  // Too little to go on: only evidence gaps / neutral signals, no momentum fields.
  if (evidenceGapCount >= signals.length - 0 && criticalCount === 0 && riskCount === 0 && positiveCount === 0 && !aggressiveVolume) {
    return FALLBACK_PREDICTION
  }

  if (criticalCount > 0 || riskCount >= 2) {
    return {
      category: 'Momentum reversing',
      explanation: 'Multiple risk signals (concentration, LP control, or cluster activity) point toward elevated reversal risk in the near term. This is not a price prediction or financial advice.',
    }
  }

  if (aggressiveVolume && riskCount === 0 && positiveCount > 0) {
    return {
      category: 'Momentum likely to continue',
      explanation: 'Volume is running well above current liquidity alongside clean deployer/LP signals, consistent with continued near-term activity. This is not a price prediction or financial advice.',
    }
  }

  if (riskCount > 0 || watchCount > positiveCount) {
    return {
      category: 'Momentum slowing',
      explanation: 'Watch-level signals (new pool, pending simulation, or unresolved LP/deployer checks) outweigh confirmed positive signals, suggesting momentum may cool until more evidence resolves. This is not a price prediction or financial advice.',
    }
  }

  if (positiveCount > 0) {
    return {
      category: 'Momentum likely to continue',
      explanation: 'Verified LP and deployer signals are clean with no outstanding risk flags, consistent with continued near-term stability. This is not a price prediction or financial advice.',
    }
  }

  return FALLBACK_PREDICTION
}

const FALLBACK_SMART_MONEY_LABEL = 'No Smart Money detected.'

export interface SmartMoneyClusterIntel {
  smartMoney: {
    count: number | null
    score: number | null
    label: string
  }
  cluster: {
    clusterId: string | null
    reputation: string
    detail: string
  }
}

/**
 * Builds a Smart Money + Cluster Intelligence summary from the existing
 * deployer.clusterEvidence and holders evidence already present in the
 * drawer enrichment payload. There is currently no smart-money wallet feed
 * wired into the radar enrichment payload, so the smartMoney portion falls
 * back to `count: null, score: null` with a fixed "No Smart Money detected."
 * label unless future evidence is added.
 */
export function buildSmartMoneyClusterIntel(token?: RadarSignalsToken | null, enrichment?: RadarSignalsEnrichment | null): SmartMoneyClusterIntel {
  // Smart money: no wallet-tagging feed is wired into the enrichment payload
  // today, so this is always the documented fallback. Holder/creator fields
  // describe supply concentration, not "smart money" wallet reputation, so
  // they are not repurposed here.
  const smartMoney: SmartMoneyClusterIntel['smartMoney'] = {
    count: null,
    score: null,
    label: FALLBACK_SMART_MONEY_LABEL,
  }

  const clusterEvidence = enrichment?.deployer?.clusterEvidence
  const devClusterSupplyPercent = typeof clusterEvidence?.devClusterSupplyPercent === 'number' && Number.isFinite(clusterEvidence.devClusterSupplyPercent)
    ? clusterEvidence.devClusterSupplyPercent
    : null
  const linkedWalletSupplyPercent = typeof clusterEvidence?.linkedWalletSupplyPercent === 'number' && Number.isFinite(clusterEvidence.linkedWalletSupplyPercent)
    ? clusterEvidence.linkedWalletSupplyPercent
    : null
  const edgeCount = typeof clusterEvidence?.edgeCount === 'number' && Number.isFinite(clusterEvidence.edgeCount) ? clusterEvidence.edgeCount : null
  const nodeCount = typeof clusterEvidence?.nodeCount === 'number' && Number.isFinite(clusterEvidence.nodeCount) ? clusterEvidence.nodeCount : null
  const matchedLinkedWallets = typeof clusterEvidence?.matchedLinkedWallets === 'number' && Number.isFinite(clusterEvidence.matchedLinkedWallets) ? clusterEvidence.matchedLinkedWallets : null

  const supplyPercent = devClusterSupplyPercent ?? linkedWalletSupplyPercent

  let reputation: string
  if (clusterEvidence?.confirmed && supplyPercent != null && supplyPercent >= HIGH_CONCENTRATION_TOP10) {
    reputation = 'High concentration risk'
  } else if (clusterEvidence?.confirmed || (nodeCount != null && nodeCount > 0) || (matchedLinkedWallets != null && matchedLinkedWallets > 0)) {
    reputation = 'Moderate'
  } else {
    reputation = 'Low / no linked wallets'
  }

  const clusterId = enrichment?.deployer?.deployerAddress ?? null

  let detail: string
  if (clusterEvidence?.confirmed) {
    const parts: string[] = ['Confirmed deployer-linked cluster evidence.']
    if (nodeCount != null) parts.push(`${nodeCount} linked node${nodeCount === 1 ? '' : 's'}`)
    if (edgeCount != null) parts.push(`${edgeCount} edge${edgeCount === 1 ? '' : 's'}`)
    if (matchedLinkedWallets != null) parts.push(`${matchedLinkedWallets} matched linked wallet${matchedLinkedWallets === 1 ? '' : 's'}`)
    if (supplyPercent != null) parts.push(`about ${supplyPercent.toFixed(1)}% of supply across linked wallets`)
    detail = parts.join(' · ')
  } else if (nodeCount != null || edgeCount != null || matchedLinkedWallets != null) {
    const parts: string[] = ['Cluster evidence not yet confirmed.']
    if (nodeCount != null) parts.push(`${nodeCount} node${nodeCount === 1 ? '' : 's'} observed`)
    if (edgeCount != null) parts.push(`${edgeCount} edge${edgeCount === 1 ? '' : 's'} observed`)
    if (matchedLinkedWallets != null) parts.push(`${matchedLinkedWallets} matched linked wallet${matchedLinkedWallets === 1 ? '' : 's'}`)
    detail = parts.join(' · ')
  } else {
    detail = 'No deployer-linked cluster evidence available — rescan soon.'
  }

  return {
    smartMoney,
    cluster: {
      clusterId,
      reputation,
      detail,
    },
  }
}

export interface RadarContextLabels {
  liquidity: 'shallow' | 'medium' | 'deep' | null
  volume: 'low' | 'medium' | 'high' | null
  marketCap: 'low' | 'medium' | 'high' | null
  age: 'early' | 'mid' | 'late' | null
}

const SHALLOW_LIQUIDITY_USD = 10_000
const DEEP_LIQUIDITY_USD = 100_000
const LOW_VOLUME_USD = 5_000
const HIGH_VOLUME_USD = 50_000
const LOW_MARKET_CAP_USD = 100_000
const HIGH_MARKET_CAP_USD = 1_000_000
const EARLY_AGE_MINUTES = 60
const LATE_AGE_MINUTES = 24 * 60

/**
 * Builds simple threshold-based context tags for liquidity, 24h volume,
 * market cap, and pool age/momentum. Each metric falls back to `null` (shown
 * as "N/A" in the UI) when the underlying value is unavailable.
 */
export function buildRadarContextLabels(token?: RadarSignalsToken | null, enrichment?: RadarSignalsEnrichment | null): RadarContextLabels {
  const liquidityUsd = liquidityUsdOf(token, enrichment)
  const volume24h = volume24hOf(token, enrichment)
  const ageMinutes = ageMinutesOf(token, enrichment)
  const marketCapUsd = enrichment?.market?.marketCapUsd ?? enrichment?.market?.fdvUsd ?? null

  const liquidity: RadarContextLabels['liquidity'] = liquidityUsd == null
    ? null
    : liquidityUsd < SHALLOW_LIQUIDITY_USD ? 'shallow' : liquidityUsd < DEEP_LIQUIDITY_USD ? 'medium' : 'deep'

  const volume: RadarContextLabels['volume'] = volume24h == null
    ? null
    : volume24h < LOW_VOLUME_USD ? 'low' : volume24h < HIGH_VOLUME_USD ? 'medium' : 'high'

  const marketCap: RadarContextLabels['marketCap'] = typeof marketCapUsd === 'number' && Number.isFinite(marketCapUsd)
    ? (marketCapUsd < LOW_MARKET_CAP_USD ? 'low' : marketCapUsd < HIGH_MARKET_CAP_USD ? 'medium' : 'high')
    : null

  const age: RadarContextLabels['age'] = ageMinutes == null
    ? null
    : ageMinutes < EARLY_AGE_MINUTES ? 'early' : ageMinutes < LATE_AGE_MINUTES ? 'mid' : 'late'

  return { liquidity, volume, marketCap, age }
}

export interface RadarRiskEntry {
  label: string
  severity: RadarSignalSeverity
  detail: string
}

const FALLBACK_RISK_SUMMARY: RadarRiskEntry[] = [{
  label: 'No major risks detected',
  severity: 'positive',
  detail: 'No risk signal rose above a routine watch level in current evidence.',
}]

const SEVERITY_RANK: Record<RadarSignalSeverity, number> = {
  critical: 4,
  risk: 3,
  watch: 2,
  neutral: 1,
  positive: 0,
}

/**
 * Builds a short, severity-ordered summary of the top 2-3 risks from the
 * same evidence used by buildRadarSignals (LP lock status, liquidity depth,
 * pool age, holder concentration, deployer/cluster history, and simulation
 * status). Falls back to a single "No major risks detected" entry when
 * nothing rises above 'watch' severity or evidence is too sparse.
 */
export function buildRadarRiskSummary(token?: RadarSignalsToken | null, enrichment?: RadarSignalsEnrichment | null): RadarRiskEntry[] {
  const risks: RadarRiskEntry[] = []

  const liquidityUsd = liquidityUsdOf(token, enrichment)
  const ageMinutes = ageMinutesOf(token, enrichment)

  // LP unlocked / not locked
  const lp = enrichment?.lp
  const lpPositionEvidence = getRadarLpPositionEvidence({
    isConcentrated: lp?.displayLpModel === 'concentrated_liquidity',
    poolId: lp?.primaryMarketPool ?? null,
    dex: lp?.lpModelProof?.dexName ?? null,
    liquidityUsd,
    fmtUSD,
  })
  if (!lpPositionEvidence && !hasVerifiedLock(lp?.lpLockStatus) && (lp?.lpControl?.status === 'team_controlled' || lp?.lpLockStatus === 'unlocked' || lp?.lpLockStatus === 'unverified')) {
    risks.push({
      label: 'LP unlocked',
      severity: 'risk',
      detail: 'No verified lock or burn proof was found for the primary LP position — liquidity could be pulled by the controlling wallet.',
    })
  }

  // Low liquidity (shallow tier)
  if (liquidityUsd != null && liquidityUsd < SHALLOW_LIQUIDITY_USD) {
    risks.push({
      label: 'Low liquidity',
      severity: 'risk',
      detail: `Current liquidity is about ${fmtUSD(liquidityUsd)}, which is in the shallow tier and prone to high slippage.`,
    })
  }

  // Early pool (<60min)
  const ageEvidence = getRadarAgeEvidence({ ageMinutes })
  if (ageEvidence) {
    risks.push({
      label: 'Early pool',
      severity: 'watch',
      detail: ageEvidence.label,
    })
  }

  // High holder concentration (top10 > 60%)
  const holders = enrichment?.holders
  if (typeof holders?.top10 === 'number' && Number.isFinite(holders.top10) && holders.top10 > HIGH_CONCENTRATION_TOP10) {
    risks.push({
      label: 'High holder concentration',
      severity: holders.top10 >= EXTREME_CONCENTRATION_TOP10 ? 'critical' : 'risk',
      detail: `Top 10 holders control about ${holders.top10.toFixed(1)}% of supply.`,
    })
  }

  // Deployer/cluster risk (rug history or confirmed cluster with high supply %)
  const rugHistoryEvidence = getRadarRugHistoryEvidence({
    deployerAddress: enrichment?.deployer?.deployerAddress ?? null,
    rugHistory: enrichment?.deployer?.rugHistory ?? null,
  })
  const clusterEvidence = enrichment?.deployer?.clusterEvidence
  const clusterSupplyPercent = clusterEvidence?.devClusterSupplyPercent ?? clusterEvidence?.linkedWalletSupplyPercent ?? null
  if (rugHistoryEvidence.status === 'risk_fact') {
    risks.push({
      label: 'Deployer/cluster risk',
      severity: 'critical',
      detail: rugHistoryEvidence.label,
    })
  } else if (clusterEvidence?.confirmed && typeof clusterSupplyPercent === 'number' && clusterSupplyPercent >= HIGH_CONCENTRATION_TOP10) {
    risks.push({
      label: 'Deployer/cluster risk',
      severity: 'risk',
      detail: `Confirmed deployer-linked cluster evidence shows about ${clusterSupplyPercent.toFixed(1)}% of supply held across linked wallets.`,
    })
  }

  // Simulation pending
  const simulationEvidence = getRadarSimulationEvidence({
    status: token?.simulationStatus ?? null,
    reason: token?.simulationReason ?? null,
  })
  if (simulationEvidence) {
    risks.push({
      label: 'Simulation pending',
      severity: 'watch',
      detail: simulationEvidence.label,
    })
  }

  const ranked = risks
    .filter((r) => SEVERITY_RANK[r.severity] >= SEVERITY_RANK.watch)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])

  if (ranked.length === 0) {
    return FALLBACK_RISK_SUMMARY
  }

  return ranked.slice(0, 3)
}
