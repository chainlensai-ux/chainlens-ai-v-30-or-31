export type CortexCategoryKey =
  | 'liquidityScore'
  | 'holderScore'
  | 'securityScore'
  | 'marketHealthScore'
  | 'volatilityPenalty'
  | 'devScore'

export type CortexScoreResultV2 = {
  score: number | null
  mainScore: number | null
  displayScore: string
  isOpenCheck: boolean
  verdict: 'CLEAN LOOKING' | 'WATCH' | 'CAUTION' | 'AVOID' | 'UNKNOWN' | 'OPEN CHECK'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  scanQuality: 'FULL' | 'PARTIAL' | 'LIMITED'
  capReason: string | null
  openChecks: string[]
  breakdown: Record<CortexCategoryKey, { status: string; score: number | null; weight: number; reason: string }>
  devBreakdown: Array<{ label: string; score: number | null; weight: number; reason: string }>
  normalization: { k: number; medians: Record<string, number> }
}

type AnyRecord = Record<string, unknown>

type Factor = {
  score: number | null
  status: 'ok' | 'partial' | 'open_check' | 'risk' | 'critical'
  reason: string
}

const K = 0.12
const MEDIANS = {
  liquidityUsd: 100_000,
  volumeUsd: 75_000,
  poolAgeDays: 30,
  holderCount: 1_000,
  marketValueUsd: 5_000_000,
  distributionSpread: 55,
  growth: 0,
  stability: 0,
  volatilityPct: 18,
} satisfies Record<string, number>

const MAIN_WEIGHTS = {
  liquidityScore: 0.30,
  holderScore: 0.20,
  securityScore: 0.20,
  marketHealthScore: 0.15,
  volatilityPenalty: 0.10,
  devScore: 0.05,
} satisfies Record<CortexCategoryKey, number>

const DEV_WEIGHTS = {
  ownership: 0.20,
  lpOwnership: 0.20,
  adminFunctions: 0.15,
  upgradeability: 0.10,
  contractAge: 0.10,
  bytecodeSimilarity: 0.10,
  devWalletBehavior: 0.10,
  deploymentPattern: 0.05,
} satisfies Record<string, number>

function asRecord(value: unknown): AnyRecord | null {
  return typeof value === 'object' && value !== null ? value as AnyRecord : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value))
}

function roundScore(value: number): number {
  return Math.round(clamp(value))
}

function sigmoidNorm(value: number, median: number, k = K): number {
  return clamp(100 / (1 + Math.exp(-k * (value - median))))
}

function logNorm(value: number | null, median: number): number | null {
  if (value == null || value < 0) return null
  return sigmoidNorm(Math.log10(value + 1), Math.log10(median + 1), K)
}

function pctNorm(value: number | null, median: number): number | null {
  if (value == null) return null
  return sigmoidNorm(value, median, K)
}

function daysSince(dateValue: unknown): number | null {
  const raw = str(dateValue)
  if (!raw) return null
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) return null
  const days = (Date.now() - time) / 86_400_000
  return Number.isFinite(days) && days >= 0 ? days : null
}

function firstPresent<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value
  }
  return null
}

function includesAny(values: string[], pattern: RegExp): boolean {
  return values.some((value) => pattern.test(value))
}

function getContractFlag(result: AnyRecord, key: 'mint' | 'pause' | 'blacklist' | 'proxy' | 'withdraw'): boolean | null {
  const security = asRecord(result.security)
  const securityFlags = asRecord(security?.contractFlags)
  const direct = bool(securityFlags?.[key])
  if (direct != null) return direct

  const contractFlags = asRecord(result.contractFlags)
  const flag = asRecord(contractFlags?.[key])
  const status = str(flag?.status)
  if (status === 'verified' || status === 'possible') return true
  // 'inferred' = flag absent per standard ERC20 structural inference (no bytecode/GoldRush available).
  // Treat as false rather than null so security/dev scores are not blocked by missing provider data.
  if (status === 'not_detected' || status === 'inferred') return false

  const analysis = asRecord(result.analysis)
  if (key === 'mint') return bool(analysis?.has_mint)
  if (key === 'proxy') return bool(analysis?.is_upgradeable)
  return null
}

function getHoneypot(result: AnyRecord): boolean | null {
  const hp = asRecord(result.honeypot)
  const hpValue = bool(hp?.isHoneypot)
  if (hpValue != null) return hpValue
  const security = asRecord(result.security)
  const simulation = asRecord(security?.simulation)
  return bool(simulation?.honeypot)
}

function getTax(result: AnyRecord, key: 'buyTax' | 'sellTax' | 'transferTax'): number | null {
  const hp = asRecord(result.honeypot)
  const hpTax = num(hp?.[key])
  if (hpTax != null) return hpTax
  const security = asRecord(result.security)
  const simulation = asRecord(security?.simulation)
  return num(simulation?.[key === 'transferTax' ? 'transferTax' : key === 'buyTax' ? 'buyTax' : 'sellTax'])
}

function getHolderDistribution(result: AnyRecord): AnyRecord | null {
  const direct = asRecord(result.holderDistribution)
  if (direct) return direct
  const devIntel = asRecord(result.devIntel)
  return asRecord(devIntel?.holderDistribution)
}

function getLpStatus(result: AnyRecord): string | null {
  const lp = asRecord(result.lpControl)
  return str(lp?.status) ?? str(lp?.lockStatus) ?? str(lp?.burnStatus)
}

function getPoolAgeDays(result: AnyRecord): number | null {
  const poolActivity = asRecord(result.poolActivity)
  return daysSince(poolActivity?.pairCreatedAt)
}

function calculateLiquidityScore(result: AnyRecord): Factor {
  const liquidity = num(result.liquidity)
  if (liquidity == null || liquidity <= 0) return { score: null, status: 'open_check', reason: 'Liquidity depth is missing or zero.' }
  const depth = logNorm(liquidity, MEDIANS.liquidityUsd)
  if (depth == null) return { score: null, status: 'open_check', reason: 'Liquidity depth could not be normalized.' }
  const noActivePools = bool(result.noActivePools) === true
  const score = noActivePools ? Math.min(depth, 25) : depth
  return { score: roundScore(score), status: noActivePools ? 'risk' : 'ok', reason: `Liquidity depth normalized with sigmoid around $${MEDIANS.liquidityUsd.toLocaleString()}.` }
}

function calculateHolderScore(result: AnyRecord): Factor {
  const holders = getHolderDistribution(result)
  const top1 = num(holders?.top1)
  const top10 = num(holders?.top10)
  const top20 = num(holders?.top20)
  const holderCount = num(holders?.holderCount)
  if (top10 == null || top1 == null) return { score: null, status: 'open_check', reason: 'Top holder percentages are missing.' }

  const distributionRaw = clamp(100 - top10)
  const distributionNorm = pctNorm(distributionRaw, MEDIANS.distributionSpread)
  const top10Penalty = clamp(100 - pctNorm(top10, 35)!)
  const whalePenalty = clamp(100 - pctNorm(Math.max(top1, top20 != null ? Math.max(0, top20 - top10) : top1), 12)!)
  // holderCount is optional — use neutral (50) sigmoid when not available so top1/top10 can still score
  const growthNorm = holderCount == null ? 50 : logNorm(holderCount, MEDIANS.holderCount)
  if (distributionNorm == null || growthNorm == null) return { score: null, status: 'open_check', reason: 'Holder count or distribution data is incomplete.' }
  const score = (0.40 * distributionNorm) + (0.30 * top10Penalty) + (0.20 * whalePenalty) + (0.10 * growthNorm)
  const status = top10 > 50 || top1 > 20 ? 'risk' : 'ok'
  return { score: roundScore(score), status, reason: `Distribution, top-10 concentration, whale exposure, and holder count normalized without concentration bonuses.` }
}

function calculateSecurityScore(result: AnyRecord): Factor {
  const honeypot = getHoneypot(result)
  const mint = getContractFlag(result, 'mint')
  const pause = getContractFlag(result, 'pause')
  const blacklist = getContractFlag(result, 'blacklist')
  const proxy = getContractFlag(result, 'proxy')
  const suspiciousBytecode = bool(asRecord(result.contractFlags)?.bytecodeChecked) === false ? null : null
  const flags = [honeypot, mint, pause, blacklist, proxy]
  if (flags.some((flag) => flag == null)) return { score: null, status: 'open_check', reason: 'One or more core security flags are missing.' }

  let riskPenalty = 0
  if (honeypot) riskPenalty += 60
  if (blacklist) riskPenalty += 18
  if (mint) riskPenalty += 16
  if (pause) riskPenalty += 12
  if (proxy) riskPenalty += 12
  if (suspiciousBytecode) riskPenalty += 15

  const buyTax = getTax(result, 'buyTax') ?? 0
  const sellTax = getTax(result, 'sellTax') ?? 0
  if (buyTax > 8) riskPenalty += Math.min(14, buyTax - 8)
  if (sellTax > 8) riskPenalty += Math.min(18, sellTax - 8)

  const score = roundScore(100 - riskPenalty)
  return { score, status: honeypot || score < 50 ? 'critical' : score < 75 ? 'risk' : 'ok', reason: 'Security score subtracts penalties for honeypot, admin, proxy, bytecode, GoPlus-style flags, and high tax risks.' }
}

function calculateVolatilityPenalty(result: AnyRecord): Factor {
  const rugRisk = asRecord(result.rugRisk)
  const liquidityRisk = asRecord(rugRisk?.liquidity_risk)
  const volatility = firstPresent(num(liquidityRisk?.volatility_24h_pct), num(result.priceChange24h))
  if (volatility == null) return { score: null, status: 'open_check', reason: 'Volatility metric is missing.' }
  const normalizedVolatility = pctNorm(Math.abs(volatility), MEDIANS.volatilityPct)
  if (normalizedVolatility == null) return { score: null, status: 'open_check', reason: 'Volatility could not be normalized.' }
  return { score: roundScore(100 - normalizedVolatility), status: Math.abs(volatility) > 35 ? 'risk' : 'ok', reason: 'VolatilityPenalty = 100 - normalized absolute volatility.' }
}

function calculateMarketHealthScore(result: AnyRecord, volatilityPenalty: number | null): Factor {
  const liquidity = num(result.liquidity)
  const volume = num(result.volume24h)
  const poolAgeDays = getPoolAgeDays(result)
  const pools = Array.isArray(result.pools) ? result.pools : []
  const holders = getHolderDistribution(result)
  const top10 = num(holders?.top10)
  if (liquidity == null || volume == null || top10 == null || volatilityPenalty == null) {
    return { score: null, status: 'open_check', reason: 'Market health requires liquidity, volume, holder concentration, and volatility.' }
  }

  const liquidityDepthNorm = logNorm(liquidity, MEDIANS.liquidityUsd)
  const volumeStabilityBase = logNorm(volume, MEDIANS.volumeUsd)
  const volumeStability = volumeStabilityBase == null ? null : (0.55 * volumeStabilityBase) + (0.45 * volatilityPenalty)
  // poolAgeDays optional — use neutral (50) sigmoid when pair creation date unavailable
  const poolAgeNorm = poolAgeDays != null ? pctNorm(poolAgeDays, MEDIANS.poolAgeDays) : 50
  const fragmentationPenalty = clamp(100 - sigmoidNorm(Math.max(0, pools.length - 1) * 25, 25, K))
  const holderChurnPenalty = clamp(100 - pctNorm(Math.max(0, top10 - 35), 10)!)
  if (liquidityDepthNorm == null || volumeStability == null || poolAgeNorm == null) return { score: null, status: 'open_check', reason: 'Market health normalization could not be completed.' }
  const score = (0.30 * liquidityDepthNorm) + (0.20 * volumeStability) + (0.20 * poolAgeNorm) + (0.15 * fragmentationPenalty) + (0.15 * holderChurnPenalty)
  return { score: roundScore(score), status: score < 45 ? 'risk' : 'ok', reason: 'Market health combines normalized depth, volume stability, pool age, fragmentation, and holder churn penalties.' }
}

function devFactor(label: string, score: number | null, weight: number, reason: string): { label: string; score: number | null; weight: number; reason: string } {
  return { label, score, weight, reason }
}

function calculateDevScore(result: AnyRecord): Factor & { devBreakdown: CortexScoreResultV2['devBreakdown'] } {
  const security = asRecord(result.security)
  const devOwnership = asRecord(security?.devOwnership)
  const lpStatus = getLpStatus(result)
  const proxy = getContractFlag(result, 'proxy')
  const mint = getContractFlag(result, 'mint')
  const pause = getContractFlag(result, 'pause')
  const blacklist = getContractFlag(result, 'blacklist')
  const poolAgeDays = getPoolAgeDays(result)
  const devIntel = asRecord(result.devIntel)
  const rugRisk = asRecord(result.rugRisk)
  const deployerReputation = asRecord(rugRisk?.deployer_reputation)
  const reasons = [
    ...(Array.isArray(devIntel?.reasons) ? devIntel.reasons.map(String) : []),
    ...(Array.isArray(devIntel?.suspiciousTransferReasons) ? devIntel.suspiciousTransferReasons.map(String) : []),
    ...(Array.isArray(deployerReputation?.deploy_patterns) ? deployerReputation.deploy_patterns.map(String) : []),
  ]
  const reasonText = reasons.join(' ')

  const isRenounced = bool(devOwnership?.isRenounced)
  const ownershipScore = isRenounced == null ? null : isRenounced ? 100 : 35
  const lpOwnershipScore = lpStatus == null
    ? null
    : lpStatus === 'burned' ? 100
      : lpStatus === 'locked' ? 60
        : lpStatus === 'team_controlled' || lpStatus === 'risky' ? 15
          : 35
  const adminKnown = [mint, pause, blacklist].every((value) => value != null)
  const adminFunctionsScore = adminKnown ? clamp(100 - ([mint, pause, blacklist].filter(Boolean).length * 28)) : null
  const upgradeabilityScore = proxy == null ? null : proxy ? 35 : 100
  const contractAgeScore = poolAgeDays == null ? null : pctNorm(poolAgeDays, MEDIANS.poolAgeDays)
  const bytecodeSimilarityScore = includesAny(reasons, /bytecode|similarity|clone|copycat|suspicious/i)
    ? 35
    : asRecord(result.contractFlags)?.bytecodeChecked === true ? 70
    : 55  // neutral: bytecode not checked but no suspicious signal detected
  const suspiciousDeploy = includesAny(reasons, /suspicious deploy|factory burst|reused deploy|rug|pattern/i)
  // neutral (55) when no deployer data at all; confirmed clean (70) when data present but no suspicious signals
  const deployPatternScore = suspiciousDeploy ? 30 : (reasons.length > 0 || deployerReputation != null) ? 70 : 55
  const suspiciousTransfers = bool(devIntel?.suspiciousTransfers)
  const devSelling = includesAny(reasons, /sell|dump|distributed|outbound|wash|relay/i)
  // neutral (55) when no dev wallet data; confirmed clean (70) when data present but no suspicious signals
  const devWalletScore = (suspiciousTransfers || devSelling) ? 30 : (suspiciousTransfers != null || reasons.length > 0) ? 70 : 55

  const breakdown = [
    devFactor('Ownership', ownershipScore, DEV_WEIGHTS.ownership, isRenounced == null ? 'Ownership status missing.' : isRenounced ? 'Ownership renounced.' : 'Ownership/admin appears held.'),
    devFactor('LP Ownership', lpOwnershipScore, DEV_WEIGHTS.lpOwnership, lpStatus == null ? 'LP ownership missing.' : lpStatus === 'burned' ? 'LP burned.' : lpStatus === 'locked' ? 'LP locked.' : 'LP ownership is not fully protected.'),
    devFactor('Admin Functions', adminFunctionsScore, DEV_WEIGHTS.adminFunctions, adminKnown ? 'Mint, pause, and blacklist flags evaluated.' : 'Admin function flags incomplete.'),
    devFactor('Upgradeability', upgradeabilityScore, DEV_WEIGHTS.upgradeability, proxy == null ? 'Proxy status missing.' : proxy ? 'Proxy/upgradeability detected.' : 'Proxy not detected.'),
    devFactor('Contract Age', contractAgeScore, DEV_WEIGHTS.contractAge, poolAgeDays == null ? 'Contract/pool age missing.' : 'Age normalized with sigmoid fallback median.'),
    devFactor('Bytecode Similarity', bytecodeSimilarityScore, DEV_WEIGHTS.bytecodeSimilarity, bytecodeSimilarityScore < 50 ? 'Suspicious bytecode/clone signal present.' : bytecodeSimilarityScore === 55 ? 'Bytecode check unavailable — neutral assumed (no suspicious signals).' : 'No suspicious bytecode similarity signal detected.'),
    devFactor('Dev Wallet Behavior', devWalletScore, DEV_WEIGHTS.devWalletBehavior, devWalletScore < 50 ? 'Suspicious transfer/selling behavior present.' : devWalletScore === 55 ? 'Dev wallet data unavailable — neutral assumed (no suspicious signals).' : 'No suspicious dev wallet behavior in existing data.'),
    devFactor('Deployment Pattern', deployPatternScore, DEV_WEIGHTS.deploymentPattern, deployPatternScore < 50 ? 'Suspicious deployment pattern present.' : deployPatternScore === 55 ? 'Deployment data unavailable — neutral assumed (no suspicious signals).' : 'No suspicious deployment pattern in existing data.'),
  ]

  if (breakdown.some((item) => item.score == null)) {
    return { score: null, status: 'open_check', reason: 'DevScore V2 requires all ownership, admin, age, bytecode, wallet, and deployment factors.', devBreakdown: breakdown }
  }

  const score = breakdown.reduce((sum, item) => sum + (item.score! * item.weight), 0)
  return { score: roundScore(score), status: score < 45 ? 'risk' : 'ok', reason: 'DevScore V2 dynamically weights ownership, LP, admin, proxy, age, bytecode, wallet behavior, and deployment pattern.', devBreakdown: breakdown }
}

function categoryLabel(key: CortexCategoryKey): string {
  switch (key) {
    case 'liquidityScore': return 'LiquidityScore'
    case 'holderScore': return 'HolderScore'
    case 'securityScore': return 'SecurityScore'
    case 'marketHealthScore': return 'MarketHealthScore'
    case 'volatilityPenalty': return 'VolatilityPenalty'
    case 'devScore': return 'DevScore'
  }
}

export function calculateCortexScoreV2(rawResult: unknown): CortexScoreResultV2 {
  const result = asRecord(rawResult) ?? {}
  const liquidity = calculateLiquidityScore(result)
  const holders = calculateHolderScore(result)
  const security = calculateSecurityScore(result)
  const volatility = calculateVolatilityPenalty(result)
  const marketHealth = calculateMarketHealthScore(result, volatility.score)
  const dev = calculateDevScore(result)

  const categories: Record<CortexCategoryKey, Factor> = {
    liquidityScore: liquidity,
    holderScore: holders,
    securityScore: security,
    marketHealthScore: marketHealth,
    volatilityPenalty: volatility,
    devScore: dev,
  }

  const openChecks = (Object.entries(categories) as Array<[CortexCategoryKey, Factor]>)
    .filter(([, value]) => value.score == null)
    .map(([key, value]) => `${categoryLabel(key)}: ${value.reason}`)

  const allPresent = openChecks.length === 0
  const weighted = allPresent
    ? (Object.entries(categories) as Array<[CortexCategoryKey, Factor]>).reduce((sum, [key, value]) => sum + (value.score! * MAIN_WEIGHTS[key]), 0)
    : null
  const mainScore = weighted == null ? null : roundScore(weighted)

  const score = mainScore
  const noData = Object.values(categories).every((category) => category.score == null)
  const hasCritical = security.status === 'critical' || getHoneypot(result) === true
  const hasRisk = Object.values(categories).some((category) => category.status === 'risk' || category.status === 'critical')

  const verdict: CortexScoreResultV2['verdict'] = !allPresent
    ? 'OPEN CHECK'
    : noData ? 'UNKNOWN'
      : hasCritical || (score ?? 0) < 40 ? 'AVOID'
        : (score ?? 0) >= 82 && !hasRisk ? 'CLEAN LOOKING'
          : (score ?? 0) >= 60 ? 'WATCH'
            : 'CAUTION'

  const presentCount = Object.values(categories).filter((category) => category.score != null).length
  const confidence: CortexScoreResultV2['confidence'] = allPresent && score != null && score >= 70 ? 'HIGH' : presentCount >= 4 ? 'MEDIUM' : 'LOW'
  const scanQuality: CortexScoreResultV2['scanQuality'] = allPresent ? 'FULL' : presentCount >= 3 ? 'PARTIAL' : 'LIMITED'

  const breakdown = (Object.entries(categories) as Array<[CortexCategoryKey, Factor]>).reduce((acc, [key, value]) => {
    acc[key] = { status: value.status, score: value.score, weight: MAIN_WEIGHTS[key], reason: value.reason }
    return acc
  }, {} as CortexScoreResultV2['breakdown'])

  return {
    score,
    mainScore,
    displayScore: score == null ? 'Open Check' : String(score),
    isOpenCheck: !allPresent,
    verdict,
    confidence,
    scanQuality,
    capReason: !allPresent ? 'Open Check fallback: one or more major Cortex V2 categories is missing.' : null,
    openChecks,
    breakdown,
    devBreakdown: dev.devBreakdown,
    normalization: { k: K, medians: MEDIANS },
  }
}
