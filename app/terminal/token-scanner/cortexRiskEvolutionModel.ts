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
  /** Recorded risk checks for this observation (history API `factors`); absent on older responses. */
  factors?: ObservationFactors | null
}

/** The recorded check outcomes stored with an observation, exactly as the scan saved them. */
export type ObservationFactors = {
  honeypot: boolean | null
  mint: string | null
  blacklist: string | null
  pause: string | null
  lpStatus: string | null
  devStatus: string | null
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
      /** Recorded risk checks, first vs latest comparable observation. */
      factors: FactorChange[]
      /** A full chart needs at least this many comparable observations; fewer get a before/after comparison. */
      chartReady: boolean
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
    factors: compareFactors(first, latest),
    chartReady: comparable.length >= CHART_MIN_OBSERVATIONS,
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

// ─── Recorded risk checks ─────────────────────────────────────────────────────────────────────────────────────
// A check is ranked only when both recorded values sit on a known severity scale. Statuses whose direction the
// scanner does not define (inferred, partial, unavailable, open checks, deployer identity) are reported as changed
// or unchanged, never as better or worse.

export const CHART_MIN_OBSERVATIONS = 3

export type FactorDirection = 'improved' | 'worsened' | 'unchanged' | 'changed' | 'not_comparable'
export type FactorChange = { key: keyof ObservationFactors; label: string; from: string; to: string; direction: FactorDirection }

const FLAG_SEVERITY: Record<string, number> = { not_detected: 0, possible: 1, verified: 2 }
const LP_SEVERITY: Record<string, number> = { burned: 0, locked: 0, protocol: 0, unlocked: 1, team_controlled: 1, wallet_controlled: 1 }
const UNKNOWN = new Set(['unavailable', 'open_check', 'insufficient_data', 'error'])

const FACTOR_DEFS: Array<{ key: keyof ObservationFactors; label: string; severity: ((v: string) => number | undefined) | null }> = [
  { key: 'honeypot', label: 'Honeypot simulation', severity: (v) => (v === 'sell blocked' ? 1 : v === 'sellable' ? 0 : undefined) },
  { key: 'mint', label: 'Mint capability', severity: (v) => FLAG_SEVERITY[v] },
  { key: 'blacklist', label: 'Blacklist capability', severity: (v) => FLAG_SEVERITY[v] },
  { key: 'pause', label: 'Pause capability', severity: (v) => FLAG_SEVERITY[v] },
  { key: 'lpStatus', label: 'Liquidity control', severity: (v) => LP_SEVERITY[v] },
  { key: 'devStatus', label: 'Deployer identity', severity: null },
]

function factorText(key: keyof ObservationFactors, factors: ObservationFactors | null | undefined): string | null {
  if (!factors) return null
  const value = factors[key]
  if (key === 'honeypot') return value === true ? 'sell blocked' : value === false ? 'sellable' : null
  return typeof value === 'string' && value !== '' ? value : null
}

export const humanizeStatus = (v: string) => v.replace(/_/g, ' ')

export function compareFactors(first: CortexObservation, latest: CortexObservation): FactorChange[] {
  if (!first.factors || !latest.factors) return []
  return FACTOR_DEFS.map(({ key, label, severity }) => {
    const from = factorText(key, first.factors)
    const to = factorText(key, latest.factors)
    const fromText = from ?? 'not recorded'
    const toText = to ?? 'not recorded'
    if (from == null || to == null || UNKNOWN.has(from) || UNKNOWN.has(to)) {
      return { key, label, from: fromText, to: toText, direction: from != null && from === to ? 'unchanged' : 'not_comparable' }
    }
    if (from === to) return { key, label, from, to, direction: 'unchanged' }
    const a = severity?.(from)
    const b = severity?.(to)
    if (a == null || b == null) return { key, label, from, to, direction: 'changed' }
    // Different values at the same severity (e.g. locked → burned) changed, but not in risk direction.
    return { key, label, from, to, direction: b > a ? 'worsened' : b < a ? 'improved' : 'changed' }
  })
}

// ─── "What changed" ───────────────────────────────────────────────────────────────────────────────────────────

export type ChangeNote = { tone: 'worse' | 'better' | 'neutral' | 'caution'; text: string; group: 'risk' | 'market' | 'evidence' }

const COVERAGE_REASON_TEXT: Record<string, string> = {
  market: 'market data', simulation: 'trading simulation', holders: 'holder distribution', lp: 'liquidity control', partial_section: 'one or more sections',
}

export function coverageReasonText(reason: string | null | undefined): string | null {
  return reason ? COVERAGE_REASON_TEXT[reason] ?? humanizeStatus(reason) : null
}

/** Plain-language summary of the comparison. Every sentence is derived from two stored observations; nothing is inferred between them. */
export function buildWhatChanged(model: Extract<RiskEvolutionModel, { state: 'trend' }>): ChangeNote[] {
  const notes: ChangeNote[] = []
  const d = model.riskDelta
  notes.push(d === 0
    ? { group: 'risk', tone: 'neutral', text: `CORTEX risk score unchanged at ${model.latest.riskScore}/100 across ${model.comparable.length} recorded scans.` }
    : { group: 'risk', tone: d > 0 ? 'worse' : 'better', text: `CORTEX risk score ${d > 0 ? 'rose' : 'fell'} ${Math.abs(d)} point${Math.abs(d) === 1 ? '' : 's'}, from ${model.first.riskScore} to ${model.latest.riskScore}.` })
  for (const f of model.factors) {
    if (f.direction === 'worsened' || f.direction === 'improved') {
      notes.push({ group: 'risk', tone: f.direction === 'worsened' ? 'worse' : 'better', text: `${f.label}: ${humanizeStatus(f.from)} → ${humanizeStatus(f.to)}.` })
    } else if (f.direction === 'changed') {
      notes.push({ group: 'risk', tone: 'neutral', text: `${f.label} changed: ${humanizeStatus(f.from)} → ${humanizeStatus(f.to)}.` })
    }
  }
  if (model.liquidity.comparable && Math.abs(model.liquidity.change) >= 1) {
    notes.push({ group: 'market', tone: model.liquidity.change < 0 ? 'caution' : 'neutral', text: `Recorded liquidity ${model.liquidity.change < 0 ? 'down' : 'up'} ${Math.abs(model.liquidity.change).toFixed(1)}%.` })
  }
  if (model.marketCap.comparable && Math.abs(model.marketCap.change) >= 1) {
    notes.push({ group: 'market', tone: 'neutral', text: `Recorded market cap ${model.marketCap.change < 0 ? 'down' : 'up'} ${Math.abs(model.marketCap.change).toFixed(1)}%.` })
  }
  if (model.topHolders.comparable && model.topHolders.change !== 0) {
    notes.push({ group: 'market', tone: model.topHolders.change > 0 ? 'caution' : 'neutral', text: `Top-10 holder share ${model.topHolders.change > 0 ? 'up' : 'down'} ${Math.abs(model.topHolders.change)} pts of supply.` })
  }
  if (model.partialEvidenceCount > 0) {
    const reason = coverageReasonText(model.latest.coverage !== 'complete' ? model.latest.coverageReason : null)
    notes.push({ group: 'evidence', tone: 'caution', text: `${model.partialEvidenceCount} of ${model.comparable.length} scans had partial evidence${reason ? ` (latest missing: ${reason})` : ''}; those scores rest on fewer checks.` })
  }
  return notes
}

// ─── Loading: one shared, bounded history store ──────────────────────────────────────────────────────────────

/** True when the stored history contains the observation the just-finished scan was recorded at. */
export function containsObservation(observations: unknown[], observedAt: string | null | undefined): boolean {
  if (!observedAt) return false
  const target = Date.parse(observedAt)
  if (!Number.isFinite(target)) return false
  return observations.some((o) => !!o && typeof o === 'object' && Date.parse((o as { observedAt?: string }).observedAt ?? '') === target)
}

/** Waits between re-reads while the scan's post-response write settles: 3 re-reads, ~5.6 s worst case, then stop. */
export const RECORD_RETRY_DELAYS_MS = [800, 1600, 3200] as const
const CACHE_TTL_MS = 60_000

export type HistorySnapshot = {
  outcome: HistoryLoadOutcome
  /** null: no current-scan write was expected; true/false: whether it was found within the retry budget. */
  currentScanRecorded: boolean | null
  attempts: number
  latencyMs: number
}

type StoreDeps = {
  fetchImpl?: typeof fetch
  getSession?: () => Promise<{ token: string | null; userId: string | null }>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  retryDelaysMs?: readonly number[]
}

/**
 * Shared per-user/chain/token cache with in-flight de-duplication. A 404 (history not available in this environment)
 * is remembered for the session so no further requests are made. Results are never shared across users.
 */
export function createCortexHistoryStore(deps: StoreDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? (() => Date.now())
  const delays = deps.retryDelaysMs ?? RECORD_RETRY_DELAYS_MS
  const getSession = deps.getSession ?? (async () => ({ token: null, userId: null }))
  const cache = new Map<string, { outcome: HistoryLoadOutcome; at: number }>()
  const inflight = new Map<string, Promise<HistoryLoadOutcome>>()
  let disabled = false

  const keyOf = (userId: string | null, chain: string, contract: string) => `${userId ?? 'anon'}:${chain}:${contract.toLowerCase()}`

  async function fetchOnce(key: string, chain: string, contract: string, token: string | null): Promise<HistoryLoadOutcome> {
    const pending = inflight.get(key)
    if (pending) return pending
    const request = loadCortexHistory(chain, contract, token, fetchImpl).then((outcome) => {
      if (outcome.kind === 'disabled') disabled = true
      if (outcome.kind === 'ok') cache.set(key, { outcome, at: now() })
      return outcome
    }).finally(() => inflight.delete(key))
    inflight.set(key, request)
    return request
  }

  return {
    isDisabled: () => disabled,
    /** Cached outcome for this user/token if still fresh, without any request. */
    async peek(chain: string, contract: string): Promise<HistoryLoadOutcome | null> {
      if (disabled) return { kind: 'disabled' }
      const { userId } = await getSession()
      const hit = cache.get(keyOf(userId, chain, contract))
      return hit && now() - hit.at < CACHE_TTL_MS ? hit.outcome : null
    },
    /**
     * Loads history. With `expectedObservedAt` (the just-finished scan's recorded time) it re-reads with bounded
     * backoff until that observation appears, then stops either way. `isCurrent` lets a caller abandon the wait.
     */
    async load(chain: string, contract: string, opts: { expectedObservedAt?: string | null; force?: boolean; isCurrent?: () => boolean } = {}): Promise<HistorySnapshot> {
      const started = now()
      if (disabled) return { outcome: { kind: 'disabled' }, currentScanRecorded: null, attempts: 0, latencyMs: 0 }
      const { token, userId } = await getSession()
      const key = keyOf(userId, chain, contract)
      const expected = opts.expectedObservedAt ?? null
      const hit = cache.get(key)
      if (hit && !opts.force && now() - hit.at < CACHE_TTL_MS && (!expected || (hit.outcome.kind === 'ok' && containsObservation(hit.outcome.observations, expected)))) {
        return { outcome: hit.outcome, currentScanRecorded: expected ? true : null, attempts: 0, latencyMs: now() - started }
      }
      let attempts = 0
      let outcome: HistoryLoadOutcome = { kind: 'error' }
      let lastOk: HistoryLoadOutcome | null = null
      for (let i = 0; i <= (expected ? delays.length : 0); i++) {
        if (i > 0) {
          await sleep(delays[i - 1])
          if (opts.isCurrent && !opts.isCurrent()) break
        }
        attempts += 1
        outcome = await fetchOnce(key, chain, contract, token)
        if (outcome.kind === 'disabled') return { outcome, currentScanRecorded: null, attempts, latencyMs: now() - started }
        if (outcome.kind === 'ok') {
          lastOk = outcome
          if (!expected || containsObservation(outcome.observations, expected)) {
            return { outcome, currentScanRecorded: expected ? true : null, attempts, latencyMs: now() - started }
          }
        }
      }
      // Retry budget spent: keep the last good history (the write may have been deduplicated or skipped).
      return { outcome: lastOk ?? outcome, currentScanRecorded: expected ? false : null, attempts, latencyMs: now() - started }
    },
  }
}
