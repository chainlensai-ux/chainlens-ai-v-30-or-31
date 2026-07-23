import type { MatchedLot } from '../modules/fifoEngine/types'
import type { SourceBreakdown } from '../modules/pricingAtTimeEngine/types'
import type { PnlReconciliationSummary } from './pnlReconciliation'
import type { RouterInferenceResult } from './routerInference'
import type { SyntheticPnlSummary } from '../modules/syntheticPnl/types'
import type { PricingRouteRecord } from '../pipeline/pricingAtTimeAdapter'

export type AyriAttributionSource = 'primaryPrice' | 'fallbackPrice' | 'ratioPrice' | 'syntheticPrice' | 'recoveredPrice'
export type AyriRouterInvolvement = 'routerCorrected' | 'routerAligned' | 'routerIndependent'
export type AyriSyntheticInvolvement = 'syntheticAligned' | 'syntheticOnly' | 'none'
export type AyriYieldClassification = 'realized' | 'unrealized'
export type AyriIntegrityTier = 'high' | 'medium' | 'low'

export type AyriAttributionRecord = {
  token: string
  chain: string
  routerAddress?: string
  attributionSource: AyriAttributionSource
  routerInvolvement: AyriRouterInvolvement
  syntheticInvolvement: AyriSyntheticInvolvement
  yieldClassification: AyriYieldClassification
  realizedUsd?: number
  unrealizedUsd?: number
  syntheticAligned: boolean
  priceRecovered: boolean
  routerCorrected: boolean
}

export type AyriAttributionSummary = {
  totalLots: number
  attributedLots: number
  // coveragePercent = attributedLots / totalLots: this measures ATTRIBUTION coverage — how many
  // lots got any attribution record at all (a lot can be attributed via routerCorrected/
  // syntheticAligned/priceRecovered bookkeeping without ever having a real priced realizedUsd).
  // COVERAGE-SEPARATION FIX, DISCLOSED (confirmed, real production evidence: coveragePercent: 1,
  // integrityTier: 'high' shown alongside realizedPnlUsd: 0 with zero fully priced lots — a
  // misleading "100% coverage" claim when historical pricing coverage was actually poor).
  // fullyPricedLots/historicalPricingCoveragePercent below are the separate, explicit PRICING
  // coverage this summary was previously conflating with attribution coverage. coveragePercent and
  // attributedLots are kept as-is (unrenamed) for existing consumers — only additive fields below.
  coveragePercent: number
  integrityTier: AyriIntegrityTier
  primaryCount: number
  fallbackCount: number
  ratioCount: number
  syntheticCount: number
  recoveredCount: number
  routerCorrectedCount: number
  syntheticAlignedCount: number
  // Count of records with a REAL priced realizedUsd (i.e. lot.realizedPnlUsd !== null at the source)
  // — distinct from attributedLots, which counts any attribution record regardless of pricing.
  fullyPricedLots: number
  // fullyPricedLots / totalLots — the real historical-pricing completeness, never to be confused
  // with coveragePercent (attribution coverage) above.
  historicalPricingCoveragePercent: number
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
}

export type AyriAttributionOutput = AyriAttributionSummary & {
  records: AyriAttributionRecord[]
  criticalMismatches: string[]
}

type PriceRecoveryMapLike = ReadonlyMap<string, unknown> | ReadonlySet<string> | Readonly<Record<string, unknown>> | null | undefined

type Config = { logger?: Pick<Console, 'warn'> }

type BuildInput = {
  reconciledPnL: PnlReconciliationSummary
  reconciledLots: readonly MatchedLot[]
  routerInferenceOutput?: RouterInferenceResult | null
  syntheticPnlAssemblyOutput?: SyntheticPnlSummary | null
  priceRecoveryMap?: PriceRecoveryMapLike
  pricingSourceBreakdown?: Partial<SourceBreakdown & { ratio: number; synthetic: number; recovered: number }>
  pricingRoutes?: readonly PricingRouteRecord[]
}

const round = (value: number) => Math.round(value * 10000) / 10000
const lotKey = (lot: Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt'>) => [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt].join(':')
const tokenKey = (chain: string, token: string) => `${chain}:${token.toLowerCase()}`

function recoveryHas(map: PriceRecoveryMapLike, lot: MatchedLot): boolean {
  if (!map) return false
  const keys = [lotKey(lot), tokenKey(lot.chain, lot.token), lot.openedTxHash, lot.closedTxHash]
  if (map instanceof Set) return keys.some((k) => map.has(k))
  if (map instanceof Map) return keys.some((k) => map.has(k))
  return keys.some((k) => Object.prototype.hasOwnProperty.call(map, k))
}

// PERFORMANCE FIX, DISCLOSED (confirmed bug — a real production run's job-finished log reported
// durationMs almost exactly equal to WORKER_GLOBAL_TIMEOUT_MS, with the entire ~245s unaccounted
// gap bounded to this file's build() call): routeForLot previously did `[...routes].sort(...)` —
// a FULL sort of the entire pricingRoutes array, using localeCompare on freshly-templated strings
// (locale-aware comparison is dramatically more expensive than ordinal comparison in V8) — and it
// was called ONCE PER LOT inside build()'s main loop (up to ~200 lots for a real wallet), each
// call re-sorting the SAME, unchanged array from scratch. That's O(lots × routes × log(routes))
// work that should have been O(routes × log(routes)) once, total. Removing the log-volume issue
// this session already fixed elsewhere did not close this gap, which is the direct evidence this —
// not the logging — is the real cost.
//
// FIX: group `routes` by (chain, token) ONCE (buildRouteIndex, called once per build()), then this
// function does a map lookup into that (typically small) per-token bucket instead of re-sorting
// the whole array. Each bucket is still sorted with the exact same tie-break key/order as before —
// selection behavior for a lot with multiple candidate routes is byte-identical to the old code,
// just computed once instead of `lots.length` times.
function buildRouteIndex(routes: readonly PricingRouteRecord[] | undefined): Map<string, PricingRouteRecord[]> {
  const index = new Map<string, PricingRouteRecord[]>()
  for (const route of routes ?? []) {
    const key = `${route.chain}:${route.token.toLowerCase()}`
    const bucket = index.get(key)
    if (bucket) bucket.push(route)
    else index.set(key, [route])
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => `${a.chain}:${a.token}:${a.timestamp}:${a.route}`.localeCompare(`${b.chain}:${b.token}:${b.timestamp}:${b.route}`))
  }
  return index
}

function routeForLot(routeIndex: Map<string, PricingRouteRecord[]>, lot: MatchedLot): PricingRouteRecord | undefined {
  const bucket = routeIndex.get(`${lot.chain}:${lot.token.toLowerCase()}`)
  return bucket?.find((r) => r.timestamp === lot.openedAt || r.timestamp === lot.closedAt)
}

function routerForLot(routerInferenceOutput: RouterInferenceResult | null | undefined, lot: MatchedLot): string | undefined {
  const token = lot.token.toLowerCase()
  const candidates = [...(routerInferenceOutput?.highConfidenceRouters ?? routerInferenceOutput?.acceptedRouters ?? new Set<string>())].sort()
  for (const address of candidates) {
    const clusters = routerInferenceOutput?.tokenFlowClustersByAddress?.get(address) ?? routerInferenceOutput?.tokenFlowClustersByAddress?.get(address.toLowerCase()) ?? []
    if (clusters.some((cluster) => cluster.tokens.map((t) => t.toLowerCase()).includes(token))) return address
  }
  return candidates[0]
}

function sourceForLot(params: { lot: MatchedLot; recovered: boolean; synthetic: boolean; route?: PricingRouteRecord; breakdown?: BuildInput['pricingSourceBreakdown'] }): AyriAttributionSource | null {
  if (params.recovered) return 'recoveredPrice'
  if (params.synthetic || params.route?.route === 'coingecko_or_basedex' && (params.breakdown?.synthetic ?? 0) > 0) return 'syntheticPrice'
  if ((params.breakdown?.ratio ?? 0) > 0 || params.route?.route === 'dexscreener') return 'ratioPrice'
  if (params.route && params.route.route !== 'none') return 'primaryPrice'
  if ((params.breakdown?.fallback ?? 0) > 0) return 'fallbackPrice'
  if ((params.breakdown?.primary ?? 0) > 0 || params.lot.costBasisUsd !== null || params.lot.proceedsUsd !== null) return 'primaryPrice'
  return null
}

export function createAyriAttribution(config: Config = {}) {
  const logger = config.logger ?? console
  let state: BuildInput | null = null

  return {
    getState: () => state,
    build(input: BuildInput): AyriAttributionOutput {
      state = input
      const lots = [...input.reconciledLots].sort((a, b) => lotKey(a).localeCompare(lotKey(b)))
      const routeIndex = buildRouteIndex(input.pricingRoutes)
      const mismatchClasses = new Map(input.reconciledPnL.mismatches.map((m) => [m.key, m.classification]))
      let syntheticBudget = input.reconciledPnL.syntheticAlignedCount
      let routerBudget = input.reconciledPnL.routerCorrectedCount
      const records: AyriAttributionRecord[] = []
      const criticalMismatches: string[] = []

      // LOG-VOLUME FIX, DISCLOSED (confirmed bug — same class of issue basedex.ts/
      // goldrushPriceSource.ts/routerInference.ts/pipeline/index.ts's dust-suppression logging
      // already independently fixed for themselves this session): this loop previously logged one
      // full "[ayri] attributionRecord" object per matched lot via logger.warn — up to ~200 lot
      // records for a real wallet (see fifoEngine's own matchedLots/pnlSummaryV2's own closedLots
      // counts). A real production run confirmed the entire pipeline call hung for the full 270s
      // worker-global timeout with ZERO console output between this build() call's caller logging
      // "[pnl-reconciliation] routerCorrected" and the very next line after this function returns
      // ("[pipeline] providerFetchWindowDiagnostics") — i.e. everything between those two lines,
      // including this loop, is exactly where the unaccounted time went. High-volume synchronous
      // console writes to a piped stdout (which is what serverless log capture is) can genuinely
      // block on backpressure, not merely get dropped from a dashboard view. The aggregate summary
      // logged right after this loop ([ayri] coverage / [ayri] summary, already present below)
      // already reports every meaningful category count (primaryCount/fallbackCount/
      // routerCorrectedCount/etc.) — the per-lot dump added no signal that summary doesn't cover.
      for (const lot of lots) {
        const key = lotKey(lot)
        const priceRecovered = recoveryHas(input.priceRecoveryMap, lot) || mismatchClasses.get(key) === 'priceRecovered'
        const syntheticAligned = syntheticBudget > 0 || mismatchClasses.get(key) === 'syntheticOnlyToken'
        const syntheticOnly = syntheticAligned && (lot.costBasisUsd === null || lot.proceedsUsd === null)
        const routerCorrected = routerBudget > 0
        const routerAddress = routerForLot(input.routerInferenceOutput, lot)
        const route = routeForLot(routeIndex, lot)
        const attributionSource = sourceForLot({ lot, recovered: priceRecovered, synthetic: syntheticAligned, route, breakdown: input.pricingSourceBreakdown })

        if (!attributionSource) {
          if (syntheticOnly) criticalMismatches.push(`${key}:syntheticOnlyMissingAttribution`)
          if (routerCorrected) criticalMismatches.push(`${key}:routerCorrectedMissingAttribution`)
          if (priceRecovered) criticalMismatches.push(`${key}:priceRecoveredMissingAttribution`)
          continue
        }

        const record: AyriAttributionRecord = {
          token: lot.token,
          chain: lot.chain,
          ...(routerAddress ? { routerAddress } : {}),
          attributionSource,
          routerInvolvement: routerCorrected ? 'routerCorrected' : routerAddress ? 'routerAligned' : 'routerIndependent',
          syntheticInvolvement: syntheticOnly ? 'syntheticOnly' : syntheticAligned ? 'syntheticAligned' : 'none',
          yieldClassification: 'realized',
          ...(lot.realizedPnlUsd !== null ? { realizedUsd: lot.realizedPnlUsd } : {}),
          syntheticAligned,
          priceRecovered,
          routerCorrected,
        }
        records.push(record)
        if (syntheticBudget > 0) syntheticBudget -= 1
        if (routerBudget > 0) routerBudget -= 1
      }

      const totalLots = Math.max(input.reconciledPnL.closedLots, lots.length)
      const attributedLots = records.length
      const coveragePercent = totalLots === 0 ? 1 : round(attributedLots / totalLots)
      const integrityTier: AyriIntegrityTier = coveragePercent >= 0.95 && criticalMismatches.length === 0 ? 'high' : coveragePercent >= 0.75 ? 'medium' : 'low'
      // FALSE-ZERO FIX, DISCLOSED (confirmed bug, real production evidence: realizedPnlUsd: 0 shown
      // with totalLots: 290, attributedLots: 290, but zero lots actually fully priced). The previous
      // `records.length ? records.reduce((sum, r) => sum + (r.realizedUsd ?? 0), 0) : null` only
      // guarded against an EMPTY records array — but every record whose lot has no priced
      // realizedPnlUsd simply omits the `realizedUsd` field (see the record construction above),
      // making it `undefined`, and `(r.realizedUsd ?? 0)` silently coalesced that to 0 for the sum.
      // So 290 attributed-but-unpriced records summed to 0 + 0 + ... + 0 = 0 — a fabricated "$0
      // realized PnL" that looked identical to a real, legitimately-zero result. Fixed by filtering
      // to only records with a REAL priced realizedUsd first: zero such records -> null (honest
      // "nothing priced"); one or more -> the real sum, which may legitimately equal 0.
      const pricedRecords = records.filter((r) => r.realizedUsd !== undefined)
      const fullyPricedLots = pricedRecords.length
      const historicalPricingCoveragePercent = totalLots === 0 ? 1 : round(fullyPricedLots / totalLots)
      const realizedPnlUsd = input.reconciledPnL.realizedPnlUsd ?? (fullyPricedLots > 0 ? pricedRecords.reduce((sum, r) => sum + (r.realizedUsd as number), 0) : null)
      const unrealizedPnlUsd = input.reconciledPnL.unrealizedPnlUsd
      const summary: AyriAttributionSummary = {
        totalLots,
        attributedLots,
        coveragePercent,
        integrityTier,
        primaryCount: records.filter((r) => r.attributionSource === 'primaryPrice').length,
        fallbackCount: records.filter((r) => r.attributionSource === 'fallbackPrice').length,
        ratioCount: records.filter((r) => r.attributionSource === 'ratioPrice').length,
        syntheticCount: records.filter((r) => r.attributionSource === 'syntheticPrice').length,
        recoveredCount: records.filter((r) => r.attributionSource === 'recoveredPrice').length,
        routerCorrectedCount: records.filter((r) => r.routerCorrected).length,
        syntheticAlignedCount: records.filter((r) => r.syntheticAligned).length,
        fullyPricedLots,
        historicalPricingCoveragePercent,
        realizedPnlUsd,
        unrealizedPnlUsd,
      }
      logger.warn('[ayri] coverage', { coveragePercent, integrityTier })
      logger.warn('[ayri] summary', summary)
      return { ...summary, records, criticalMismatches }
    },
  }
}
