export type CortexCategoryKey =
  | 'liquidityScore'
  | 'holderScore'
  | 'securityScore'
  | 'marketHealthScore'
  | 'volatilityPenalty'
  | 'devScore'

export type CortexWeightedCategoryKey =
  | 'marketLiquidity'
  | 'holderDistribution'
  | 'lpControl'
  | 'securityRiskChecks'
  | 'devControl'

export type CortexVerdict = 'Strong' | 'Watch' | 'Caution' | 'High Risk' | 'Open Check'
export type CortexConfidence = 'high' | 'medium' | 'low' | 'insufficient'

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
  cortexScore: number | null
  cortexVerdict: CortexVerdict
  cortexConfidence: CortexConfidence
  scoreReasons: string[]
  missingScoreInputs: string[]
  scoreCoveragePercent: number
  cortexScoreDebug: {
    categoryInputs: Record<CortexWeightedCategoryKey, unknown>
    categoryStatuses: Record<CortexWeightedCategoryKey, string>
    categoryWeights: Record<CortexWeightedCategoryKey, number>
    scoreCoveragePercent: number
    missingInputs: string[]
    capsApplied: string[]
    finalScore: number | null
    finalVerdict: CortexVerdict
    confidence: CortexConfidence
  }
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

const CORTEX_WEIGHTED_WEIGHTS = {
  marketLiquidity: 0.25,
  holderDistribution: 0.25,
  lpControl: 0.25,
  securityRiskChecks: 0.15,
  devControl: 0.10,
} satisfies Record<CortexWeightedCategoryKey, number>

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

// Mirrors the top_share/owner_lp_share/locker_share/burn_share evidence
// convention used in lib/baseRadarSeverity.ts and lib/server/secondaryLpExposure.ts.
function extractLpControllerSharePercent(evidence: string[] | null): number | null {
  if (!Array.isArray(evidence)) return null
  for (const key of ['owner_lp_share', 'top_share', 'locker_share', 'burn_share']) {
    const line = evidence.find((item) => item.toLowerCase().startsWith(`${key}=`))
    if (line) {
      const value = Number(line.split('=').slice(1).join('=').replace('%', ''))
      if (Number.isFinite(value)) return Math.round(value * 100) / 100
    }
  }
  return null
}


function getContractFlagStatus(result: AnyRecord, key: 'mint' | 'pause' | 'blacklist' | 'proxy' | 'withdraw'): string | null {
  const contractFlags = asRecord(result.contractFlags)
  const flag = asRecord(contractFlags?.[key])
  return str(flag?.status)
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
  const liquidity = firstPresent(num(result.liquidity), num(result.liquidityUsd))
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
  const liquidity = firstPresent(num(result.liquidity), num(result.liquidityUsd))
  const volume = firstPresent(num(result.volume24h), num(result.volume24hUsd))
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

function weightedCategoryLabel(key: CortexWeightedCategoryKey): string {
  switch (key) {
    case 'marketLiquidity': return 'Market / Liquidity'
    case 'holderDistribution': return 'Holder Distribution'
    case 'lpControl': return 'LP Control / LP Proof'
    case 'securityRiskChecks': return 'Security / Risk Checks'
    case 'devControl': return 'Dev Control'
  }
}

type WeightedCategory = Factor & { coverage: 0 | 0.5 | 1; input: unknown }

function coverageForStatus(status: Factor['status'], score: number | null): 0 | 0.5 | 1 {
  if (score == null) return 0
  if (status === 'open_check' || status === 'partial') return 0.5
  return 1
}

function calculateMarketLiquidityCategory(result: AnyRecord, liquidity: Factor, marketHealth: Factor, volatility: Factor): WeightedCategory {
  const price = firstPresent(num(result.price), num(result.priceUsd))
  const liquidityUsd = firstPresent(num(result.liquidity), num(result.liquidityUsd))
  const volume24h = firstPresent(num(result.volume24h), num(result.volume24hUsd))
  const marketCap = firstPresent(num(result.marketCapUsd), num(result.marketCap), num(result.market_cap), num(result.fdvUsd), num(result.fdv))
  const hasUsableMarket = price != null || liquidityUsd != null || volume24h != null || marketCap != null
  if (!hasUsableMarket) return { score: null, status: 'open_check', coverage: 0, input: { price, liquidityUsd, volume24h, marketCap }, reason: 'Market and liquidity fields are missing.' }

  const parts = [liquidity.score, marketHealth.score, volatility.score].filter((value): value is number => value != null)
  const fallbackParts = [
    liquidityUsd != null ? logNorm(liquidityUsd, MEDIANS.liquidityUsd) : null,
    volume24h != null ? logNorm(volume24h, MEDIANS.volumeUsd) : null,
    marketCap != null ? logNorm(marketCap, MEDIANS.marketValueUsd) : null,
    price != null ? 55 : null,
  ].filter((value): value is number => value != null)
  const allParts = parts.length > 0 ? parts : fallbackParts
  const score = allParts.length > 0 ? roundScore(allParts.reduce((sum, value) => sum + value, 0) / allParts.length) : null
  const partial = [price, liquidityUsd, volume24h, marketCap].filter((value) => value != null).length < 3 || marketHealth.score == null
  const noActivePools = bool(result.noActivePools) === true
  const status: Factor['status'] = noActivePools || (liquidityUsd != null && liquidityUsd <= 0) || (score != null && score < 35) ? 'risk' : partial ? 'partial' : 'ok'
  return {
    score,
    status,
    coverage: coverageForStatus(status, score),
    input: { price, liquidityUsd, volume24h, marketCap, noActivePools },
    reason: partial ? 'Score calculated from available market evidence; missing market fields reduce confidence.' : 'Market/liquidity evidence includes price, liquidity, volume, valuation, and volatility context.',
  }
}

function calculateLpControlCategory(result: AnyRecord): WeightedCategory {
  const lpStatus = getLpStatus(result)
  const lp = asRecord(result.lpControl)
  const proofStatus = str(lp?.proofStatus)
  const lockStatus = str(lp?.lockStatus)
  const burnStatus = str(lp?.burnStatus)
  const poolPresent = bool(lp?.poolAddressPresent) === true || firstPresent(num(result.liquidity), num(result.liquidityUsd)) != null || (Array.isArray(result.pools) && result.pools.length > 0)
  if (!lpStatus && !poolPresent) return { score: null, status: 'open_check', coverage: 0, input: { lpStatus, proofStatus, lockStatus, burnStatus, poolPresent }, reason: 'LP pool/control evidence is missing.' }

  let score: number | null = 45
  let status: Factor['status'] = 'partial'
  let reason = 'LP pool exists, but lock/burn/controller proof is partial.'
  if (lpStatus === 'burned') { score = 100; status = 'ok'; reason = 'LP burn proof is available.' }
  else if (lpStatus === 'locked') { score = 88; status = 'ok'; reason = 'LP lock proof is available.' }
  else if (lpStatus === 'protocol' || lpStatus === 'concentrated_liquidity') { score = 70; status = 'partial'; reason = 'Protocol/concentrated liquidity model detected; lock/burn proof is not the applicable certainty model.' }
  else if (lpStatus === 'team_controlled' || lpStatus === 'risky') { score = 15; status = 'critical'; reason = 'LP appears removable or team-controlled.' }
  else if (lpStatus === 'partial' || lpStatus === 'unavailable_with_reason' || lpStatus === 'insufficient_data' || lpStatus === 'error' || lpStatus === 'no_pool') { score = poolPresent ? 35 : null; status = poolPresent ? 'partial' : 'open_check'; reason = poolPresent ? 'Pool detected, but LP proof is incomplete.' : 'No usable LP control evidence.' }

  return { score, status, coverage: coverageForStatus(status, score), input: { lpStatus, proofStatus, lockStatus, burnStatus, poolPresent }, reason }
}

function hasUsableDevEvidence(result: AnyRecord, dev: Factor & { devBreakdown: CortexScoreResultV2['devBreakdown'] }): boolean {
  const security = asRecord(result.security)
  const devOwnership = asRecord(security?.devOwnership)
  const rugRisk = asRecord(result.rugRisk)
  const deployerReputation = asRecord(rugRisk?.deployer_reputation)
  const devIntel = asRecord(result.devIntel)
  const lpStatus = getLpStatus(result)
  const hasConcreteFlag = (['mint', 'pause', 'blacklist', 'proxy', 'withdraw'] as const).some((key) => {
    const status = getContractFlagStatus(result, key)
    return status === 'verified' || status === 'possible' || status === 'not_detected'
  })
  return bool(devOwnership?.isRenounced) != null || deployerReputation != null || devIntel != null || hasConcreteFlag || (lpStatus != null && !['no_pool', 'partial', 'unavailable_with_reason', 'insufficient_data', 'error'].includes(lpStatus)) || dev.devBreakdown.some((item) => item.score != null && item.score !== 55 && !/unavailable|missing|neutral assumed/i.test(item.reason))
}

// Verdict bands: 0-24 Extreme Watch, 25-39 High Watch, 40-59 Caution,
// 60-74 Moderate Watch, 75+ Stronger Profile — mapped onto the existing
// CortexVerdict labels. A numeric score never maps to 'Open Check'; that
// label is reserved for "no usable evidence across core categories".
function verdictForScore(score: number | null): CortexVerdict {
  if (score == null) return 'Open Check'
  if (score >= 75) return 'Strong'
  if (score >= 60) return 'Watch'
  if (score >= 40) return 'Caution'
  return 'High Risk'
}

export function calculateCortexScoreV2(rawResult: unknown): CortexScoreResultV2 {
  const result = asRecord(rawResult) ?? {}
  const liquidity = calculateLiquidityScore(result)
  const holders = calculateHolderScore(result)
  const security = calculateSecurityScore(result)
  const volatility = calculateVolatilityPenalty(result)
  const marketHealth = calculateMarketHealthScore(result, volatility.score)
  const dev = calculateDevScore(result)
  const lpControl = calculateLpControlCategory(result)
  const marketLiquidity = calculateMarketLiquidityCategory(result, liquidity, marketHealth, volatility)

  const holderStatus = asRecord(result.holderDistributionStatus)
  const holderHasRows = str(holderStatus?.status) === 'partial'
  const holderCategory: WeightedCategory = holders.score != null
    ? { ...holders, coverage: coverageForStatus(holders.status, holders.score), input: { top1: num(getHolderDistribution(result)?.top1), top10: num(getHolderDistribution(result)?.top10), top20: num(getHolderDistribution(result)?.top20), holderCount: num(getHolderDistribution(result)?.holderCount) } }
    : holderHasRows
      ? { score: 45, status: 'partial', coverage: 0.5, input: { status: holderStatus?.status, itemCount: holderStatus?.itemCount }, reason: 'Holder rows are available, but concentration percentages are incomplete.' }
      : { ...holders, coverage: 0, input: { status: holderStatus?.status ?? null } }

  const securityKnown = getHoneypot(result) != null || getTax(result, 'buyTax') != null || getTax(result, 'sellTax') != null || (['mint', 'pause', 'blacklist', 'proxy', 'withdraw'] as const).some((key) => {
    const status = getContractFlagStatus(result, key)
    return status === 'verified' || status === 'possible' || status === 'not_detected'
  })
  const securityCategory: WeightedCategory = security.score != null
    ? { ...security, coverage: coverageForStatus(security.status, security.score), input: { honeypot: getHoneypot(result), buyTax: getTax(result, 'buyTax'), sellTax: getTax(result, 'sellTax'), mint: getContractFlag(result, 'mint'), proxy: getContractFlag(result, 'proxy') } }
    : securityKnown
      ? { score: 50, status: 'partial', coverage: 0.5, input: { honeypot: getHoneypot(result), buyTax: getTax(result, 'buyTax'), sellTax: getTax(result, 'sellTax') }, reason: 'Partial risk-check evidence available; missing security flags reduce confidence.' }
      : { ...security, coverage: 0, input: { honeypot: null } }

  const devCategory: WeightedCategory = dev.score != null
    ? { score: dev.score, status: dev.status, coverage: coverageForStatus(dev.status, dev.score), input: dev.devBreakdown.map((item) => ({ label: item.label, score: item.score })) , reason: dev.reason }
    : hasUsableDevEvidence(result, dev)
      ? { score: 50, status: 'partial', coverage: 0.5, input: dev.devBreakdown.map((item) => ({ label: item.label, score: item.score })), reason: 'Partial dev-control evidence available; missing ownership/admin inputs reduce confidence.' }
      : { score: null, status: 'open_check', coverage: 0, input: dev.devBreakdown.map((item) => ({ label: item.label, score: item.score })), reason: dev.reason }

  const weightedCategories: Record<CortexWeightedCategoryKey, WeightedCategory> = {
    marketLiquidity,
    holderDistribution: holderCategory,
    lpControl,
    securityRiskChecks: securityCategory,
    devControl: devCategory,
  }

  const usableKeys = (Object.entries(weightedCategories) as Array<[CortexWeightedCategoryKey, WeightedCategory]>).filter(([, category]) => category.coverage > 0).map(([key]) => key)
  const scoreCoveragePercent = Math.round((Object.entries(weightedCategories) as Array<[CortexWeightedCategoryKey, WeightedCategory]>).reduce((sum, [key, category]) => sum + (CORTEX_WEIGHTED_WEIGHTS[key] * category.coverage), 0) * 100)
  const missingScoreInputs = (Object.entries(weightedCategories) as Array<[CortexWeightedCategoryKey, WeightedCategory]>).filter(([, category]) => category.coverage === 0).map(([key]) => weightedCategoryLabel(key))
  const scoreReasons = (Object.entries(weightedCategories) as Array<[CortexWeightedCategoryKey, WeightedCategory]>).filter(([, category]) => category.coverage > 0).map(([key, category]) => `${weightedCategoryLabel(key)}: ${category.reason}`)

  // Open Check is reserved for "genuinely no usable evidence across core
  // categories" — any category with coverage > 0 is enough to calculate a
  // real score. Missing categories only reduce coverage/confidence below;
  // the score itself is the coverage-weighted average of the categories
  // that DO have evidence (it is not dragged toward 0 by missing ones).
  const totalCoveredWeight = (Object.entries(weightedCategories) as Array<[CortexWeightedCategoryKey, WeightedCategory]>).reduce((sum, [key, category]) => sum + (CORTEX_WEIGHTED_WEIGHTS[key] * category.coverage), 0)
  const hasAnyEvidence = totalCoveredWeight > 0

  let score: number | null = hasAnyEvidence
    ? roundScore((Object.entries(weightedCategories) as Array<[CortexWeightedCategoryKey, WeightedCategory]>).reduce((sum, [key, category]) => sum + ((category.score ?? 0) * CORTEX_WEIGHTED_WEIGHTS[key] * category.coverage), 0) / totalCoveredWeight)
    : null

  const capsApplied: string[] = []
  const applyCap = (cap: number, reason: string) => {
    if (score != null && score > cap) {
      score = cap
      capsApplied.push(reason)
    }
  }

  const honeypot = getHoneypot(result)
  const maxTax = Math.max(getTax(result, 'buyTax') ?? 0, getTax(result, 'sellTax') ?? 0)
  const top1 = num(getHolderDistribution(result)?.top1)
  const top10 = num(getHolderDistribution(result)?.top10)
  const holderCount = num(getHolderDistribution(result)?.holderCount)
  const mint = getContractFlag(result, 'mint')
  const proxy = getContractFlag(result, 'proxy')
  const lpStatus = getLpStatus(result)
  if (honeypot === true) applyCap(24, 'Honeypot-like sell-path flag capped score below High Risk threshold.')
  if (maxTax >= 20) applyCap(35, 'Very high tax flag capped score.')
  if (mint === true || proxy === true) applyCap(69, 'Critical mint/admin capability capped score at Caution.')
  if (lpStatus === 'team_controlled' || lpStatus === 'risky') applyCap(49, 'LP confirmed removable/team-controlled capped score at High Risk.')
  if ((top1 != null && top1 >= 25) || (top10 != null && top10 >= 65)) applyCap(49, 'Extreme holder concentration capped score at High Risk.')

  // ── Severe-risk caps ─────────────────────────────────────────────────
  // Mirrors the Base Radar severe-risk caps (lib/baseRadarSeverity.ts):
  // a token with extreme holder concentration and/or wallet/team-controlled
  // LP and an active owner must never display as Open Check or a healthy
  // verdict, even if the weighted average above is high.
  const lpEvidence = Array.isArray(asRecord(result.lpControl)?.evidence) ? asRecord(result.lpControl)!.evidence as string[] : null
  const lpControllerSharePercent = extractLpControllerSharePercent(lpEvidence)
  const lockBurnConfirmed = lpStatus === 'burned' || lpStatus === 'locked'
  const isWalletTeamControlled = lpStatus === 'team_controlled' || lpStatus === 'risky'
  const isRenouncedOwner = bool(asRecord(asRecord(result.security)?.devOwnership)?.isRenounced)
  const activeOwner = isRenouncedOwner === false

  const severeCaps: Array<{ flag: string; matched: boolean; cap: number }> = [
    { flag: 'Top 10 holders control at least 90% of supply', matched: top10 != null && top10 >= 90, cap: 35 },
    { flag: 'Top 10 holders control at least 99% of supply', matched: top10 != null && top10 >= 99, cap: 25 },
    { flag: 'Top holder controls at least 50% of supply', matched: top1 != null && top1 >= 50, cap: 40 },
    { flag: 'Top holder controls at least 90% of supply', matched: top1 != null && top1 >= 90, cap: 25 },
    { flag: 'Holder count is under 25', matched: holderCount != null && holderCount < 25, cap: 35 },
    { flag: 'LP wallet/team controlled with no verified lock or burn proof', matched: isWalletTeamControlled && !lockBurnConfirmed, cap: 35 },
    { flag: 'LP controller share is at least 90% with lock/burn proof open', matched: lpControllerSharePercent != null && lpControllerSharePercent >= 90 && !lockBurnConfirmed, cap: 30 },
    { flag: 'Active owner/admin alongside wallet/team LP control', matched: activeOwner && isWalletTeamControlled, cap: 35 },
  ]
  const severeFlags = severeCaps.filter((c) => c.matched)
  for (const c of severeFlags) applyCap(c.cap, `Severe risk flag: ${c.flag}.`)
  if (severeFlags.length >= 3) applyCap(30, 'Multiple severe risk flags (3 or more) capped score.')
  if (severeFlags.length >= 5) applyCap(25, 'Multiple severe risk flags (5 or more) capped score.')

  const confidence: CortexConfidence = !hasAnyEvidence
    ? 'insufficient'
    : scoreCoveragePercent >= 85 ? 'high'
      : scoreCoveragePercent >= 55 ? 'medium'
        : 'low'
  const cortexVerdict = verdictForScore(score)

  const legacyVerdict: CortexScoreResultV2['verdict'] = cortexVerdict === 'Open Check'
    ? 'OPEN CHECK'
    : cortexVerdict === 'Strong'
      ? 'CLEAN LOOKING'
      : cortexVerdict === 'High Risk'
        ? 'AVOID'
        : cortexVerdict.toUpperCase() as CortexScoreResultV2['verdict']

  const categories: Record<CortexCategoryKey, Factor> = {
    liquidityScore: liquidity,
    holderScore: holders,
    securityScore: security,
    marketHealthScore: marketHealth,
    volatilityPenalty: volatility,
    devScore: dev,
  }

  const openChecks = missingScoreInputs.map((label) => `${label}: evidence unavailable for this scan.`)
  const presentCount = usableKeys.length
  const scanQuality: CortexScoreResultV2['scanQuality'] = confidence === 'high' ? 'FULL' : presentCount >= 2 ? 'PARTIAL' : 'LIMITED'
  const legacyConfidence: CortexScoreResultV2['confidence'] = confidence === 'high' ? 'HIGH' : confidence === 'medium' ? 'MEDIUM' : 'LOW'

  const breakdown = (Object.entries(categories) as Array<[CortexCategoryKey, Factor]>).reduce((acc, [key, value]) => {
    acc[key] = { status: value.status, score: value.score, weight: MAIN_WEIGHTS[key], reason: value.reason }
    return acc
  }, {} as CortexScoreResultV2['breakdown'])

  const categoryInputs = (Object.entries(weightedCategories) as Array<[CortexWeightedCategoryKey, WeightedCategory]>).reduce((acc, [key, category]) => {
    acc[key] = category.input
    return acc
  }, {} as Record<CortexWeightedCategoryKey, unknown>)
  const categoryStatuses = (Object.entries(weightedCategories) as Array<[CortexWeightedCategoryKey, WeightedCategory]>).reduce((acc, [key, category]) => {
    acc[key] = category.status
    return acc
  }, {} as Record<CortexWeightedCategoryKey, string>)

  return {
    score,
    mainScore: score,
    displayScore: score == null ? 'Open Check' : String(score),
    isOpenCheck: score == null,
    verdict: legacyVerdict,
    confidence: legacyConfidence,
    scanQuality,
    capReason: capsApplied.length > 0 ? capsApplied[0] : score == null ? 'Insufficient evidence across core CORTEX categories.' : null,
    openChecks,
    breakdown,
    devBreakdown: dev.devBreakdown,
    normalization: { k: K, medians: MEDIANS },
    cortexScore: score,
    cortexVerdict,
    cortexConfidence: confidence,
    scoreReasons,
    missingScoreInputs,
    scoreCoveragePercent,
    cortexScoreDebug: {
      categoryInputs,
      categoryStatuses,
      categoryWeights: CORTEX_WEIGHTED_WEIGHTS,
      scoreCoveragePercent,
      missingInputs: missingScoreInputs,
      capsApplied,
      finalScore: score,
      finalVerdict: cortexVerdict,
      confidence,
    },
  }
}
