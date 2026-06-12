export type LpHistoryTimelineStatus = 'ok' | 'partial' | 'unknown'
export type LpHistoryMigrationRisk = 'low' | 'watch' | 'high' | 'open_check' | 'unknown'
export type LpHistoryFragmentation = 'single_pool' | 'concentrated' | 'distributed' | 'fragmented' | 'unknown'

export interface LpHistoryTimelineInput {
  chain?: string | null
  poolModel?: string | null
  marketDataSource?: 'primary' | 'fallback' | 'none' | null
  selectedPool?: {
    address?: string | null
    pair?: string | null
    dex?: string | null
    liquidityUsd?: number | null
    createdAt?: string | null
  } | null
  primaryPoolAgeLabel?: string | null
  poolCount?: number | null
  observedPoolCount?: number | null
  liquidityUsd?: number | null
  lpMigrationProof?: {
    status?: string | null
    confidence?: string | null
    liquidityDistribution?: string | null
    dexsUsed?: string[] | null
    signals?: string[] | null
    missingEvidence?: string[] | null
  } | null
}

export interface LpHistoryTimeline {
  status: LpHistoryTimelineStatus
  migrationRisk: LpHistoryMigrationRisk
  confidence: string
  chain: string | null
  poolModel: string | null
  primaryPool: string | null
  primaryPair: string | null
  primaryDex: string | null
  primaryPoolCreatedAt: string | null
  primaryPoolAgeLabel: string | null
  poolCount: number | null
  observedPoolCount: number | null
  liquidityUsd: number | null
  liquidityDistribution: string
  fragmentation: LpHistoryFragmentation
  events: string[]
  summary: string
  signals: string[]
  evidenceGaps: string[]
  nextActions: string[]
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function mapMigrationRisk(status: string | null): LpHistoryMigrationRisk {
  if (status === 'low') return 'low'
  if (status === 'watch') return 'watch'
  if (status === 'flagged') return 'high'
  return 'unknown'
}

function deriveFragmentation(liquidityDistribution: string | null, poolCount: number | null): LpHistoryFragmentation {
  if (poolCount != null && poolCount <= 1) return 'single_pool'
  if (liquidityDistribution === 'concentrated in primary pool') return 'concentrated'
  if (liquidityDistribution === 'moderately distributed') return 'distributed'
  if (liquidityDistribution === 'spread thinly across pools') return 'fragmented'
  return 'unknown'
}

// Builds a pool-history/migration timeline from already-resolved pool/LP evidence
// (selectedPool, observed pool counts, lpMigrationProof) — no new scans or fabricated events.
export function buildLpHistoryTimeline(input: LpHistoryTimelineInput): LpHistoryTimeline {
  const chain = asString(input.chain)
  const poolModel = asString(input.poolModel)
  const selectedPool = input.selectedPool ?? {}
  const primaryPool = asString(selectedPool.address)
  const primaryPair = asString(selectedPool.pair)
  const primaryDex = asString(selectedPool.dex)
  const primaryPoolCreatedAt = asString(selectedPool.createdAt)
  const primaryPoolAgeLabel = asString(input.primaryPoolAgeLabel)
  const poolCount = typeof input.poolCount === 'number' ? input.poolCount : null
  const observedPoolCount = typeof input.observedPoolCount === 'number' ? input.observedPoolCount : null
  const liquidityUsd = typeof input.liquidityUsd === 'number' ? input.liquidityUsd : (typeof selectedPool.liquidityUsd === 'number' ? selectedPool.liquidityUsd : null)
  const migrationProof = input.lpMigrationProof ?? {}
  const liquidityDistribution = asString(migrationProof.liquidityDistribution) ?? 'unknown'
  const effectivePoolCount = poolCount ?? observedPoolCount
  const confidence = asString(migrationProof.confidence) ?? 'low'

  const events: string[] = []
  const signals: string[] = [...(Array.isArray(migrationProof.signals) ? migrationProof.signals : [])]
  const evidenceGaps: string[] = [...(Array.isArray(migrationProof.missingEvidence) ? migrationProof.missingEvidence.map((gap) =>
    gap === 'pool_creation_date_unavailable' ? 'pool creation date not available'
    : gap === 'historical_liquidity_movement_unavailable' ? 'historical liquidity movement not available'
    : gap
  ) : [])]
  const nextActions: string[] = ['verify pool history on a block explorer', 'rescan after liquidity changes']

  if (!primaryPool) {
    return {
      status: 'unknown', migrationRisk: 'unknown', confidence, chain, poolModel,
      primaryPool: null, primaryPair, primaryDex, primaryPoolCreatedAt: null, primaryPoolAgeLabel: null,
      poolCount, observedPoolCount, liquidityUsd: null,
      liquidityDistribution: 'unknown', fragmentation: 'unknown',
      events: ['no selected LP pool — pool history is not available'],
      summary: 'No selected LP pool was available, so LP history/migration timeline could not be built.',
      signals, evidenceGaps: [...evidenceGaps, 'no selected LP pool available'], nextActions,
    }
  }

  events.push(`primary pool detected${primaryDex ? ` on ${primaryDex}` : ''}`)
  if (primaryPoolCreatedAt) events.push(`primary pool created ${primaryPoolCreatedAt}`)
  if (liquidityUsd != null) events.push(`liquidity observed in primary pool (~$${Math.round(liquidityUsd).toLocaleString()})`)
  if (effectivePoolCount != null && effectivePoolCount > 1) events.push(`multi-pool liquidity observed across ${effectivePoolCount} pools`)

  const fragmentation = deriveFragmentation(liquidityDistribution, effectivePoolCount)
  const isSinglePoolOnly = effectivePoolCount == null || effectivePoolCount <= 1
  const isFallbackOnly = input.marketDataSource === 'fallback'
  const status: LpHistoryTimelineStatus = (isSinglePoolOnly || isFallbackOnly) ? 'partial' : 'ok'

  const baseMigrationRisk = mapMigrationRisk(asString(migrationProof.status))
  const migrationRisk: LpHistoryMigrationRisk = (status === 'partial')
    ? (baseMigrationRisk === 'unknown' ? 'unknown' : 'open_check')
    : baseMigrationRisk

  if (isSinglePoolOnly) {
    evidenceGaps.push('only a single selected pool is known — multi-pool migration history not available')
  }
  if (isFallbackOnly && !evidenceGaps.includes('primary on-chain pool discovery unavailable — used fallback market evidence')) {
    evidenceGaps.push('primary on-chain pool discovery unavailable — used fallback market evidence')
  }

  const poolModelLabel = poolModel === 'concentrated' ? 'concentrated-liquidity'
    : poolModel === 'stableswap' ? 'stableswap'
    : poolModel === 'unknown' ? null
    : 'constant-product'

  const summary = status === 'partial'
    ? `${poolModelLabel ? `A ${poolModelLabel} ` : 'A '}primary LP pool was detected${primaryDex ? ` on ${primaryDex}` : ''}${liquidityUsd != null ? ` with observed liquidity of approximately $${Math.round(liquidityUsd).toLocaleString()}` : ''}, but only this single pool is confirmed — broader pool history/migration evidence is an open check.`
    : `${poolModelLabel ? `The primary ${poolModelLabel} pool` : 'The primary pool'}${primaryDex ? ` on ${primaryDex}` : ''} is the dominant liquidity venue${effectivePoolCount != null ? ` among ${effectivePoolCount} observed pools` : ''}; ${liquidityDistribution === 'unknown' ? 'liquidity distribution across pools could not be confirmed' : `liquidity is ${liquidityDistribution}`}. ${baseMigrationRisk === 'low' ? 'No migration signal was observed from current pool evidence.' : baseMigrationRisk === 'watch' ? 'Some liquidity-distribution signals warrant monitoring.' : baseMigrationRisk === 'high' ? 'Liquidity-distribution signals suggest elevated migration risk.' : 'Migration risk could not be confirmed from current pool evidence.'}`

  return {
    status, migrationRisk, confidence, chain, poolModel,
    primaryPool, primaryPair, primaryDex, primaryPoolCreatedAt, primaryPoolAgeLabel,
    poolCount, observedPoolCount, liquidityUsd,
    liquidityDistribution, fragmentation,
    events, summary, signals, evidenceGaps, nextActions,
  }
}
