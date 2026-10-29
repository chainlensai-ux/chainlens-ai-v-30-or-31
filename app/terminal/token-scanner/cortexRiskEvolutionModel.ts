// CORTEX Risk Evolution — pure view model for the Token Scanner history panel.
//
// Works only on observations the history API returned (GET /api/cortex/history). It never creates,
// interpolates or back-fills an observation: a value missing from a stored observation stays missing and the
// comparison that needs it reports "not comparable". Only observations recorded with the SAME scanner version and
// risk methodology as the latest one are compared; older-methodology rows are counted and excluded, never mixed in.
// Risk scores are the stored values as recorded (higher is riskier, lib/riskScoreDirection.ts) — nothing is
// recalculated here.

export type CortexObservation = {
  observedAt: string
  riskScore: number
  riskLabel: string | null
  coverage: string
  coverageReason?: string | null
  liquidityUsd: number | string | null
  marketCapUsd: number | string | null
  holderPoints: number | null
  holderBasis: string | null
  scannerVersion: string
  riskMethodologyVersion: string
}

export type ValueComparison =
  | { comparable: true; from: number; to: number; change: number }
  | { comparable: false; reason: string }

export type ChartPoint = {
  observation: CortexObservation
  observedAtMs: number
  /** 0..100, left to right, proportional to the real observation time. */
  xPct: number
  /** 0..100, top to bottom: 0 = risk score 100, 100 = risk score 0. */
  yPct: number
}

export type RiskEvolutionModel =
  | { state: 'empty' }
  | {
      state: 'building'
      latest: CortexObservation
      validCount: number
      /** Valid observations left out because their scanner/methodology differs from the latest one. */
      excludedForMethodology: number
    }
  | {
      state: 'trend'
      first: CortexObservation
      latest: CortexObservation
      comparable: CortexObservation[]
      points: ChartPoint[]
      validCount: number
      excludedForMethodology: number
      riskDelta: number
      spanMs: number
      /** Comparable observations whose evidence coverage was not complete. */
      partialEvidenceCount: number
      liquidity: ValueComparison
      marketCap: ValueComparison
      /** Top-10 holder share of supply, in percentage points (higher = more concentrated). */
      topHolders: ValueComparison
    }

const timeOf = (o: CortexObservation) => Date.parse(o.observedAt)

function isValidObservation(o: unknown): o is CortexObservation {
  if (!o || typeof o !== 'object') return false
  const r = o as Partial<CortexObservation>
  return typeof r.riskScore === 'number' && Number.isInteger(r.riskScore) && r.riskScore >= 0 && r.riskScore <= 100
    && typeof r.observedAt === 'string' && Number.isFinite(Date.parse(r.observedAt))
    && typeof r.scannerVersion === 'string' && r.scannerVersion !== ''
    && typeof r.riskMethodologyVersion === 'string' && r.riskMethodologyVersion !== ''
}

/** A stored USD amount, or null when it is absent, unparseable or not positive. Never estimated. */
export function storedUsd(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function compareUsd(first: CortexObservation, latest: CortexObservation, key: 'liquidityUsd' | 'marketCapUsd'): ValueComparison {
  const from = storedUsd(first[key])
  const to = storedUsd(latest[key])
  if (from == null && to == null) return { comparable: false, reason: 'Not recorded in either observation' }
  if (from == null) return { comparable: false, reason: 'Not recorded in the first observation' }
  if (to == null) return { comparable: false, reason: 'Not recorded in the latest observation' }
  return { comparable: true, from, to, change: ((to - from) / from) * 100 }
}

function compareHolders(first: CortexObservation, latest: CortexObservation): ValueComparison {
  if (first.holderPoints == null || latest.holderPoints == null) {
    return { comparable: false, reason: first.holderPoints == null ? 'Not recorded in the first observation' : 'Not recorded in the latest observation' }
  }
  if (!first.holderBasis || first.holderBasis !== latest.holderBasis) {
    return { comparable: false, reason: 'Measured against a different supply basis' }
  }
  return { comparable: true, from: first.holderPoints, to: latest.holderPoints, change: latest.holderPoints - first.holderPoints }
}

export function buildRiskEvolution(raw: unknown): RiskEvolutionModel {
  const history = (Array.isArray(raw) ? raw : []).filter(isValidObservation).sort((a, b) => timeOf(a) - timeOf(b))
  const latest = history.at(-1)
  if (!latest) return { state: 'empty' }

  const comparable = history.filter((o) => o.scannerVersion === latest.scannerVersion && o.riskMethodologyVersion === latest.riskMethodologyVersion)
  const excludedForMethodology = history.length - comparable.length
  if (comparable.length < 2) return { state: 'building', latest, validCount: history.length, excludedForMethodology }

  const first = comparable[0]
  const t0 = timeOf(first)
  const spanMs = timeOf(latest) - t0
  const points: ChartPoint[] = comparable.map((observation, i) => ({
    observation,
    observedAtMs: timeOf(observation),
    // Same-instant observations (span 0) fall back to even spacing so they stay distinguishable.
    xPct: spanMs > 0 ? ((timeOf(observation) - t0) / spanMs) * 100 : (i / (comparable.length - 1)) * 100,
    yPct: 100 - observation.riskScore,
  }))

  return {
    state: 'trend',
    first,
    latest,
    comparable,
    points,
    validCount: history.length,
    excludedForMethodology,
    riskDelta: latest.riskScore - first.riskScore,
    spanMs,
    partialEvidenceCount: comparable.filter((o) => o.coverage !== 'complete').length,
    liquidity: compareUsd(first, latest, 'liquidityUsd'),
    marketCap: compareUsd(first, latest, 'marketCapUsd'),
    topHolders: compareHolders(first, latest),
  }
}

/**
 * Which chart points get a score label: the latest always, then earlier ones from the right while they are not
 * crowded against a label already shown (closer than `minGapPct` across and `minRiseGap` up/down). Every point is
 * still drawn; only its text label is skipped.
 */
export function labelledPointIndexes(points: Pick<ChartPoint, 'xPct' | 'yPct'>[], minGapPct = 9, minRiseGap = 14): Set<number> {
  const shown: number[] = []
  for (let i = points.length - 1; i >= 0; i--) {
    const crowded = shown.some((j) => Math.abs(points[j].xPct - points[i].xPct) < minGapPct && Math.abs(points[j].yPct - points[i].yPct) < minRiseGap)
    if (!crowded) shown.push(i)
  }
  return new Set(shown)
}

export type HistoryLoadOutcome =
  | { kind: 'disabled' }
  | { kind: 'ok'; observations: unknown[] }
  | { kind: 'error' }

/**
 * One history request. 404 means CORTEX history is not available in this environment (Production, or memory
 * disabled): the panel must stay hidden. Any other failure is shown as "unavailable", never as empty history.
 */
export async function loadCortexHistory(
  chain: string,
  contract: string,
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<HistoryLoadOutcome> {
  try {
    const query = new URLSearchParams({ chain, contract })
    const response = await fetchImpl(`/api/cortex/history?${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
    })
    if (response.status === 404) return { kind: 'disabled' }
    if (!response.ok) return { kind: 'error' }
    const json = await response.json() as { observations?: unknown }
    return { kind: 'ok', observations: Array.isArray(json?.observations) ? json.observations : [] }
  } catch {
    return { kind: 'error' }
  }
}

export function formatSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} days`
}
