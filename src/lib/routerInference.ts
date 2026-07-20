import type { NormalizedEvent } from '../modules/normalization/types'

export type RouterConfidenceTier = 'high' | 'medium' | 'low'

export type RouterEvidenceSummary = {
  address: string
  score: number
  reasons: string[]
  confidenceTier: RouterConfidenceTier
  heuristics: string[]
  tokens: string[]
  repeatedPatternCount: number
  inboundCount: number
  outboundCount: number
  counterpartyRecurrence: number
  temporalClusterCount: number
  knownRouterProximity: number
  ambiguous: boolean
  competingAddresses: string[]
}

export type RouterFlowCluster = {
  clusterId: string
  routerAddress: string
  tokens: string[]
  eventCount: number
  timeWindowMs: number
}

export type RouterInferenceResult = {
  acceptedRouters: Set<string>
  highConfidenceRouters: Set<string>
  evidenceByAddress: Map<string, RouterEvidenceSummary>
  tokenFlowClustersByAddress: Map<string, RouterFlowCluster[]>
  ambiguousRouters: Set<string>
  rejectedRouters: Set<string>
  candidates: RouterEvidenceSummary[]
  outboundEvents: NormalizedEvent[]
  inboundEvents: NormalizedEvent[]
}

export type RouterInferenceConfig = {
  knownRouterAddresses?: ReadonlySet<string>
  ambiguityThreshold?: number
  highConfidenceThreshold?: number
  mediumConfidenceThreshold?: number
  temporalWindowMs?: number
  logger?: Pick<Console, 'warn'>
}

type MutableEvidence = {
  address: string
  outboundEvents: NormalizedEvent[]
  inboundEvents: NormalizedEvent[]
  tokens: Set<string>
  counterparties: Set<string>
}

const DEFAULT_AMBIGUITY_THRESHOLD = 8
const DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 62
const DEFAULT_MEDIUM_CONFIDENCE_THRESHOLD = 40
const DEFAULT_TEMPORAL_WINDOW_MS = 5 * 60 * 1000

function timeOf(event: NormalizedEvent): number {
  const value = Date.parse(event.timestamp)
  return Number.isFinite(value) ? value : 0
}

function orderedEvents(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((a, b) => {
    const byTime = timeOf(a) - timeOf(b)
    if (byTime !== 0) return byTime
    const byTx = a.txHash.localeCompare(b.txHash)
    if (byTx !== 0) return byTx
    return `${a.direction}:${a.contract}:${a.fromAddress}:${a.toAddress}`.localeCompare(`${b.direction}:${b.contract}:${b.fromAddress}:${b.toAddress}`)
  })
}

function proximityToKnownRouter(address: string, knownRouters: readonly string[]): number {
  if (knownRouters.includes(address)) return 1
  let best = 0
  for (const known of knownRouters) {
    let prefix = 0
    for (let i = 0; i < Math.min(address.length, known.length); i += 1) {
      if (address[i] !== known[i]) break
      prefix += 1
    }
    let suffix = 0
    for (let i = 1; i <= Math.min(address.length, known.length); i += 1) {
      if (address[address.length - i] !== known[known.length - i]) break
      suffix += 1
    }
    best = Math.max(best, (prefix + suffix) / Math.max(address.length, known.length))
  }
  return best
}

function countTemporalClusters(events: readonly NormalizedEvent[], windowMs: number): number {
  if (events.length === 0) return 0
  const sorted = orderedEvents(events)
  let clusters = 1
  let previous = timeOf(sorted[0])
  for (const event of sorted.slice(1)) {
    const current = timeOf(event)
    if (current - previous > windowMs) clusters += 1
    previous = current
  }
  return clusters
}

function confidenceTier(score: number, high: number, medium: number): RouterConfidenceTier {
  if (score >= high) return 'high'
  if (score >= medium) return 'medium'
  return 'low'
}

function buildClusters(address: string, events: readonly NormalizedEvent[], windowMs: number): RouterFlowCluster[] {
  const groups = new Map<string, NormalizedEvent[]>()
  for (const event of events) {
    const key = `${event.contract.toLowerCase()}`
    const list = groups.get(key) ?? []
    list.push(event)
    groups.set(key, list)
  }

  const clusters: RouterFlowCluster[] = []
  for (const [token, tokenEvents] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let current: NormalizedEvent[] = []
    const flush = () => {
      if (current.length === 0) return
      const times = current.map(timeOf)
      const index = clusters.length + 1
      clusters.push({
        clusterId: `${address}:${token}:${index}`,
        routerAddress: address,
        tokens: [token],
        eventCount: current.length,
        timeWindowMs: Math.max(...times) - Math.min(...times),
      })
      current = []
    }
    for (const event of orderedEvents(tokenEvents)) {
      if (current.length > 0 && timeOf(event) - timeOf(current[current.length - 1]) > windowMs) flush()
      current.push(event)
    }
    flush()
  }
  return clusters
}

export function createRouterInference(config: RouterInferenceConfig = {}) {
  const knownRouters = [...(config.knownRouterAddresses ?? new Set<string>())].map((a) => a.toLowerCase()).sort()
  const ambiguityThreshold = config.ambiguityThreshold ?? DEFAULT_AMBIGUITY_THRESHOLD
  const highThreshold = config.highConfidenceThreshold ?? DEFAULT_HIGH_CONFIDENCE_THRESHOLD
  const mediumThreshold = config.mediumConfidenceThreshold ?? DEFAULT_MEDIUM_CONFIDENCE_THRESHOLD
  const temporalWindowMs = config.temporalWindowMs ?? DEFAULT_TEMPORAL_WINDOW_MS
  const logger = config.logger ?? console

  return {
    build(normalizedEvents: readonly NormalizedEvent[]): RouterInferenceResult {
      const outboundEvents = normalizedEvents.filter((e) => e.direction === 'outbound')
      const inboundEvents = normalizedEvents.filter((e) => e.direction === 'inbound')
      const evidence = new Map<string, MutableEvidence>()
      const ensure = (address: string): MutableEvidence => {
        const key = address.toLowerCase()
        const existing = evidence.get(key)
        if (existing) return existing
        const created: MutableEvidence = { address: key, outboundEvents: [], inboundEvents: [], tokens: new Set(), counterparties: new Set() }
        evidence.set(key, created)
        return created
      }

      for (const event of outboundEvents) {
        const item = ensure(event.toAddress)
        item.outboundEvents.push(event)
        item.tokens.add(event.contract.toLowerCase())
        item.counterparties.add(event.fromAddress.toLowerCase())
      }
      for (const event of inboundEvents) {
        const item = ensure(event.fromAddress)
        item.inboundEvents.push(event)
        item.tokens.add(event.contract.toLowerCase())
        item.counterparties.add(event.toAddress.toLowerCase())
      }

      const candidates = [...evidence.values()].map((item): RouterEvidenceSummary => {
        const repeatedPatternCount = item.outboundEvents.length
        const tokenDiversity = item.tokens.size
        const inboundCount = item.inboundEvents.length
        const outboundCount = item.outboundEvents.length
        const symmetryRatio = Math.min(inboundCount, outboundCount) / Math.max(1, Math.max(inboundCount, outboundCount))
        const temporalClusterCount = countTemporalClusters(item.outboundEvents, temporalWindowMs)
        const recurrence = item.counterparties.size
        const knownRouterProximity = proximityToKnownRouter(item.address, knownRouters)
        const score = Math.round(
          Math.min(repeatedPatternCount, 8) * 5 +
          Math.min(tokenDiversity, 6) * 7 +
          symmetryRatio * 18 +
          Math.min(temporalClusterCount, 5) * 4 +
          Math.min(recurrence, 4) * 3 +
          knownRouterProximity * 18,
        )
        const reasons: string[] = []
        const heuristics: string[] = []
        if (repeatedPatternCount >= 3) { reasons.push(`repeated-pattern:${repeatedPatternCount}`); heuristics.push('repeated-pattern') }
        if (tokenDiversity >= 2) { reasons.push(`token-diversity:${tokenDiversity}`); heuristics.push('token-diversity') }
        if (symmetryRatio >= 0.5) { reasons.push(`inbound-outbound-symmetry:${symmetryRatio.toFixed(2)}`); heuristics.push('inbound-outbound-symmetry') }
        if (temporalClusterCount >= 2) { reasons.push(`temporal-clustering:${temporalClusterCount}`); heuristics.push('temporal-clustering') }
        if (recurrence >= 1) { reasons.push(`counterparty-recurrence:${recurrence}`); heuristics.push('counterparty-recurrence') }
        if (knownRouterProximity > 0) { reasons.push(`known-router-proximity:${knownRouterProximity.toFixed(2)}`); heuristics.push('known-router-proximity') }
        return {
          address: item.address,
          score,
          reasons,
          confidenceTier: confidenceTier(score, highThreshold, mediumThreshold),
          heuristics,
          tokens: [...item.tokens].sort(),
          repeatedPatternCount,
          inboundCount,
          outboundCount,
          counterpartyRecurrence: recurrence,
          temporalClusterCount,
          knownRouterProximity,
          ambiguous: false,
          competingAddresses: [],
        }
      }).sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))

      for (const candidate of candidates) {
        logger.warn('[router-inference] candidate', { address: candidate.address, score: candidate.score, reasons: candidate.reasons, confidenceTier: candidate.confidenceTier })
      }

      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i]
        const competing = candidates.filter((other, index) => index !== i && Math.abs(other.score - candidate.score) <= ambiguityThreshold).map((other) => other.address)
        if (competing.length > 0 && candidate.confidenceTier !== 'low') {
          candidate.ambiguous = true
          candidate.competingAddresses = competing
          logger.warn('[router-inference] ambiguous', { address: candidate.address, competingAddresses: competing })
        }
      }

      const acceptedRouters = new Set<string>()
      const highConfidenceRouters = new Set<string>()
      const ambiguousRouters = new Set<string>()
      const rejectedRouters = new Set<string>()
      const evidenceByAddress = new Map<string, RouterEvidenceSummary>()
      const tokenFlowClustersByAddress = new Map<string, RouterFlowCluster[]>()

      for (const candidate of candidates) {
        evidenceByAddress.set(candidate.address, candidate)
        if (candidate.ambiguous) ambiguousRouters.add(candidate.address)
        if (!candidate.ambiguous && candidate.confidenceTier === 'high') {
          acceptedRouters.add(candidate.address)
          highConfidenceRouters.add(candidate.address)
          tokenFlowClustersByAddress.set(candidate.address, buildClusters(candidate.address, evidence.get(candidate.address)?.outboundEvents ?? [], temporalWindowMs))
          logger.warn('[router-inference] accepted', { address: candidate.address, score: candidate.score, confidenceTier: candidate.confidenceTier })
        } else {
          rejectedRouters.add(candidate.address)
        }
      }
      logger.warn('[router-inference] summary', { acceptedCount: acceptedRouters.size, rejectedCount: rejectedRouters.size, ambiguousCount: ambiguousRouters.size })

      return { acceptedRouters, highConfidenceRouters, evidenceByAddress, tokenFlowClustersByAddress, ambiguousRouters, rejectedRouters, candidates, outboundEvents, inboundEvents }
    },
  }
}
